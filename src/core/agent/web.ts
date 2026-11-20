/**
 * Pure helpers for the agent's web and command tools: web pages as text, search results from
 * DuckDuckGo's HTML page, which addresses are private (refused), and long output cut to size.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', bull: '•' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/** Results of https://html.duckduckgo.com/html/?q=… (ads left out). */
export function parseDuckDuckGo(html: string, max = 8): SearchResult[] {
  const out: SearchResult[] = [];
  const anchors = [...html.matchAll(/<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)];
  for (let i = 0; i < anchors.length && out.length < max; i++) {
    const a = anchors[i];
    const href = /href="([^"]*)"/i.exec(a[0])?.[1];
    if (!href) continue;
    let url = decodeEntities(href);
    if (url.startsWith('//')) url = `https:${url}`;
    try {
      const u = new URL(url);
      // results link through duckduckgo.com/l/?uddg=<the real address>; ads through /y.js
      if (/duckduckgo\.com$/.test(u.hostname)) {
        const real = u.searchParams.get('uddg');
        if (!real) continue;
        url = real;
      }
      if (!/^https?:$/.test(new URL(url).protocol)) continue;
    } catch {
      continue;
    }
    const rest = html.slice((a.index ?? 0) + a[0].length, anchors[i + 1]?.index ?? html.length);
    const snippet = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(a|div|td)>/i.exec(rest)?.[1] ?? '';
    if (out.some((r) => r.url === url)) continue;
    out.push({ title: stripTags(a[1]) || url, url, snippet: stripTags(snippet) });
  }
  return out;
}

const BLOCK = /^(p|div|section|article|header|footer|main|nav|aside|ul|ol|li|tr|table|h[1-6]|pre|blockquote|figure|figcaption|dl|dt|dd|form|hr|br)$/i;

/** A web page as plain text: its title, the readable text, and the links in it. */
export function htmlToText(html: string, base?: string): { title: string; text: string; links: { text: string; url: string }[] } {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|object|canvas|head)\b[\s\S]*?<\/\1>/gi, '');
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(s);
  if (body) s = body[1];
  const links: { text: string; url: string }[] = [];
  // keep preformatted text as it is
  const pres: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    pres.push(decodeEntities(inner.replace(/<[^>]*>/g, '')));
    return `\n\u0000${pres.length - 1}\u0000\n`;
  });
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs: string, inner: string) => {
    const text = stripTags(inner);
    const href = /href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i.exec(attrs);
    const raw = href ? decodeEntities(href[1] ?? href[2] ?? '') : '';
    if (text && raw && !raw.startsWith('#') && !/^javascript:/i.test(raw) && links.length < 60) {
      try {
        const url = new URL(raw, base).href;
        if (/^https?:/.test(url) && !links.some((l) => l.url === url)) links.push({ text: text.slice(0, 80), url });
      } catch {
        /* not an address */
      }
    }
    return text;
  });
  s = s
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/li\s*>/gi, '')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<\/?([a-z0-9]+)\b[^>]*>/gi, (_m, tag: string) => (BLOCK.test(tag) ? '\n' : ''));
  s = decodeEntities(s)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => pres[Number(i)] ?? '')
    .trim();
  return { title, text: s, links };
}

/** Addresses on this computer, the local network, or otherwise not on the public internet. */
export function isPrivateAddress(ip: string): boolean {
  let a = ip.trim().toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (v4) {
    const [p, q] = [Number(v4[1]), Number(v4[2])];
    return (
      p === 0 || p === 10 || p === 127 || p >= 224 ||
      (p === 100 && q >= 64 && q <= 127) ||
      (p === 169 && q === 254) ||
      (p === 172 && q >= 16 && q <= 31) ||
      (p === 192 && q === 168) ||
      (p === 192 && q === 0 && (Number(v4[3]) === 0 || Number(v4[3]) === 2)) ||
      (p === 198 && (q === 18 || q === 19))
    );
  }
  if (a.includes(':')) {
    if (a === '::' || a === '::1') return true;
    const first = parseInt(a.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (/^64:ff9b::/.test(a) || /^::(\d+\.){3}\d+$/.test(a)) return true;
    return false;
  }
  return true; // not an address we understand: refuse
}

/** Hosts refused before looking them up. */
export function isLocalHostName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa');
}

/** Long output, cut to `max` characters: the start and (mostly) the end, where errors and results are. */
export function capOutput(text: string, max: number): { text: string; cut: number } {
  if (text.length <= max) return { text, cut: 0 };
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  const cut = text.length - head - tail;
  return { text: `${text.slice(0, head)}\n\n[… ${cut.toLocaleString('en-US')} characters left out …]\n\n${text.slice(text.length - tail)}`, cut };
}

/** Terminal colour and cursor codes, which mean nothing to the model. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)|\u001b[@-Z\\-_]/g, '').replace(/\r(?!\n)/g, '\n');
}
