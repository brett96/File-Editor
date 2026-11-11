/**
 * RTF (Rich Text Format 1.9) import / export.
 *
 * Export walks the contract HTML (see ../types.ts) and writes RTF that Microsoft Word opens
 * cleanly: font / colour / style / list tables are built from what the document uses.
 * Import is a real tokenizer + interpreter (group state stack, destinations, code pages,
 * \uN with \ucN skipping, \bin) that emits contract HTML.
 *
 * Runs in the browser and in Node: no Buffer, no fs.
 */
import {
  cssColorToHex,
  cssLengthToPt,
  escapeHtml,
  imageSize,
  parseDataUrl,
  parseHtml,
  parseStyle,
  primaryFontFamily,
  toDataUrl,
  utf8Encode,
} from '../dom';
import {
  DEFAULT_HF_DISTANCE,
  DEFAULT_PAGE_SETUP,
  PAGE_SIZES,
  pageDimensions,
  type Exporter,
  type Importer,
  type PageSetup,
  type PageSize,
  type RichDocument,
} from '../types';

/* ════════════════════════════════════════════════════════════════════════════
 * Helpers shared with the other legacy-format modules (odt.ts, doc-legacy.ts)
 * ════════════════════════════════════════════════════════════════════════════ */

/** Resolved inline formatting of a run of text, ready to be written as contract HTML. */
export interface InlineFmt {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  vert?: 'sub' | 'super' | '';
  /** "rrggbb" */
  color?: string | null;
  /** "rrggbb" */
  highlight?: string | null;
  font?: string | null;
  /** points */
  size?: number | null;
  code?: boolean;
}

export type InlineRun =
  | { text: string; fmt: InlineFmt; link?: string | null }
  | { html: string; link?: string | null };

/** Colours that word processors apply to hyperlinks by default; dropped inside <a>. */
const LINK_COLORS = new Set(['0000ff', '0563c1', '0000ee', '000080', '1a56db', '467886']);

function fmtKey(f: InlineFmt): string {
  return [
    f.bold ? 1 : 0,
    f.italic ? 1 : 0,
    f.underline ? 1 : 0,
    f.strike ? 1 : 0,
    f.vert || '',
    f.color || '',
    f.highlight || '',
    f.font || '',
    f.size || '',
    f.code ? 1 : 0,
  ].join('|');
}

function cssFontName(name: string): string {
  return /^[A-Za-z][A-Za-z0-9 _-]*$/.test(name) ? name : `'${name.replace(/['"\\<>]/g, '')}'`;
}

function wrapText(text: string, f: InlineFmt): string {
  let html = escapeHtml(text);
  if (f.code) html = `<code>${html}</code>`;
  const css: string[] = [];
  if (f.color) css.push(`color: #${f.color}`);
  if (f.font && !f.code) css.push(`font-family: ${cssFontName(f.font)}`);
  if (f.size && !f.code) css.push(`font-size: ${+f.size.toFixed(2)}pt`);
  if (css.length) html = `<span style="${css.join('; ')}">${html}</span>`;
  if (f.highlight) html = `<mark data-color="#${f.highlight}" style="background-color: #${f.highlight}">${html}</mark>`;
  if (f.vert === 'sub') html = `<sub>${html}</sub>`;
  else if (f.vert === 'super') html = `<sup>${html}</sup>`;
  if (f.strike) html = `<s>${html}</s>`;
  if (f.underline) html = `<u>${html}</u>`;
  if (f.italic) html = `<em>${html}</em>`;
  if (f.bold) html = `<strong>${html}</strong>`;
  return html;
}

/** Writes runs as contract HTML, merging neighbours with identical formatting and grouping links. */
export function renderInlineRuns(runs: InlineRun[]): string {
  // 1. normalise + merge adjacent text runs with equal formatting
  const merged: InlineRun[] = [];
  for (const r of runs) {
    if ('text' in r) {
      if (!r.text) continue;
      let fmt = r.fmt;
      if (r.link) {
        // links are underlined/blue by convention; keep the HTML clean
        fmt = { ...fmt, underline: false, color: fmt.color && LINK_COLORS.has(fmt.color) ? null : fmt.color };
      }
      const last = merged[merged.length - 1];
      if (last && 'text' in last && (last.link ?? null) === (r.link ?? null) && fmtKey(last.fmt) === fmtKey(fmt)) {
        last.text += r.text;
      } else {
        merged.push({ text: r.text, fmt, link: r.link ?? null });
      }
    } else {
      merged.push({ html: r.html, link: r.link ?? null });
    }
  }
  // 2. emit, grouping consecutive runs that share a link target
  let out = '';
  let i = 0;
  while (i < merged.length) {
    const link = merged[i].link ?? null;
    let chunk = '';
    let j = i;
    for (; j < merged.length && (merged[j].link ?? null) === link; j++) {
      const r = merged[j];
      chunk += 'text' in r ? wrapText(r.text, r.fmt) : r.html;
    }
    out += link ? `<a href="${escapeHtml(link)}">${chunk}</a>` : chunk;
    i = j;
  }
  return out;
}

/** Maps page dimensions (points) to the closest supported page setup. */
export function nearestPageSetup(
  widthPt: number,
  heightPt: number,
  margins: Partial<PageSetup['margins']>,
  forceLandscape = false,
): PageSetup {
  const landscape = forceLandscape || widthPt > heightPt;
  const w = Math.min(widthPt, heightPt);
  const h = Math.max(widthPt, heightPt);
  let size: PageSize = 'letter';
  let best = Infinity;
  for (const key of Object.keys(PAGE_SIZES) as PageSize[]) {
    const d = Math.abs(PAGE_SIZES[key].width - w) + Math.abs(PAGE_SIZES[key].height - h);
    if (d < best) {
      best = d;
      size = key;
    }
  }
  const round = (n: number | undefined, fallback: number) =>
    n === undefined || !isFinite(n) || n < 0 ? fallback : Math.round(n * 100) / 100;
  const d = DEFAULT_PAGE_SETUP.margins;
  return {
    size,
    orientation: landscape ? 'landscape' : 'portrait',
    margins: {
      top: round(margins.top, d.top),
      right: round(margins.right, d.right),
      bottom: round(margins.bottom, d.bottom),
      left: round(margins.left, d.left),
    },
  };
}

export const PAGE_BREAK_HTML = '<div data-page-break="true"></div>';

/* ════════════════════════════════════════════════════════════════════════════
 * EXPORT
 * ════════════════════════════════════════════════════════════════════════════ */

const DEFAULT_FONT = 'Calibri';
const MONO_FONT = 'Courier New';
/** Default body size in half-points (11pt, matching the editor page). */
const DEFAULT_HP = 22;
const PRE_HP = 20;
/** Heading sizes h1…h6 in half-points (matches the editor: 20/16/13/11/11/11pt). */
const HEADING_HP = [40, 32, 26, 22, 22, 22];
const HEADING_SPACE: Array<[number, number]> = [
  [360, 120],
  [280, 100],
  [240, 80],
  [200, 80],
  [200, 80],
  [200, 80],
];

// Stylesheet numbers
const S_QUOTE = 15;
const S_PRE = 16;
const CS_CODE = 18;

/** The 16 colours Word supports for \highlightN. */
const WORD_HIGHLIGHTS = new Set([
  '000000', '0000ff', '00ffff', '00ff00', 'ff00ff', 'ff0000', 'ffff00', 'ffffff',
  '000080', '008080', '008000', '800080', '800000', '808000', '808080', 'c0c0c0',
]);

const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'hr', 'ul', 'ol', 'li', 'table', 'div',
  'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure', 'figcaption', 'dl', 'dt', 'dd',
  'address', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'center', 'details', 'summary', 'fieldset', 'form',
]);
const SKIP_TAGS = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'template', 'colgroup', 'col', 'caption']);

interface CharFmt {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  vert: '' | 'sub' | 'super';
  color: string | null;
  highlight: string | null;
  /** font table index */
  font: number;
  /** half-points */
  size: number;
  code: boolean;
}

type ParaKind = { k: 'p' } | { k: 'h'; level: number } | { k: 'pre' } | { k: 'hr' };

interface ItemMarker {
  ls: number;
  ilvl: number;
  text: string;
  /** font index for the marker glyph */
  font: number;
  used: boolean;
}

interface BlockCtx {
  /** left / right indent in twips */
  li: number;
  ri: number;
  inTable: boolean;
  quote: boolean;
  bold: boolean;
  listDepth: number;
  item: ItemMarker | null;
}

interface PState {
  /** true when the previous emitted character was a (collapsible) space or we are at paragraph start */
  sp: boolean;
}

interface ListDef {
  ordered: boolean;
  nfc: number;
  start: number;
}

interface PreparedImage {
  blip: 'pngblip' | 'jpegblip';
  bytes: Uint8Array;
  width: number;
  height: number;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function bytesToHex(bytes: Uint8Array): string {
  const lines: string[] = [];
  const per = 64;
  for (let i = 0; i < bytes.length; i += per) {
    let s = '';
    const end = Math.min(bytes.length, i + per);
    for (let j = i; j < end; j++) s += HEX[bytes[j]];
    lines.push(s);
  }
  return lines.join('\n');
}

/** Escapes text for RTF: specials, and non-ASCII as \uN? (signed 16-bit, surrogates as two \u). */
function rtfEscape(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x5c) out += '\\\\';
    else if (c === 0x7b) out += '\\{';
    else if (c === 0x7d) out += '\\}';
    else if (c === 0x09) out += '\\tab ';
    else if (c === 0x0a) out += '\\line ';
    else if (c < 0x20) continue;
    else if (c < 0x80) out += text[i];
    else if (c === 0xa0) out += '\\~';
    else out += `\\u${c > 32767 ? c - 65536 : c}?`;
  }
  return out;
}

function fontFamilyClass(name: string): string {
  const n = name.toLowerCase();
  if (/courier|consolas|mono|menlo|lucida console/.test(n)) return 'fmodern';
  if (/times|georgia|cambria|garamond|palatino|book antiqua|serif$/.test(n) && !/sans/.test(n)) return 'froman';
  if (/arial|calibri|helvetica|verdana|tahoma|segoe|trebuchet|aptos|sans/.test(n)) return 'fswiss';
  if (/comic|script|brush/.test(n)) return 'fscript';
  return 'fnil';
}

const GENERIC_FONTS: Record<string, string> = {
  monospace: MONO_FONT,
  serif: 'Times New Roman',
  'sans-serif': 'Arial',
  'system-ui': DEFAULT_FONT,
  cursive: 'Comic Sans MS',
  fantasy: 'Impact',
};

function toRoman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  const map: Array<[number, string]> = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let out = '';
  for (const [v, s] of map) {
    while (n >= v) {
      out += s;
      n -= v;
    }
  }
  return out;
}

function toAlpha(n: number): string {
  if (n <= 0) return String(n);
  let out = '';
  while (n > 0) {
    n--;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

/** RTF \levelnfc → marker text for item number n. */
function numberText(nfc: number, n: number): string {
  switch (nfc) {
    case 1:
      return toRoman(n).toUpperCase();
    case 2:
      return toRoman(n);
    case 3:
      return toAlpha(n).toUpperCase();
    case 4:
      return toAlpha(n);
    default:
      return String(n);
  }
}

async function rasterToPng(mime: string, bytes: Uint8Array): Promise<Uint8Array | null> {
  // Only possible where a canvas is available (browser / Electron renderer); not under Node.
  try {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
    const bmp = await createImageBitmap(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }));
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const g = canvas.getContext('2d');
    if (!g) return null;
    g.drawImage(bmp, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

async function prepareImages(root: HTMLElement): Promise<Map<string, PreparedImage>> {
  const out = new Map<string, PreparedImage>();
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    if (!src || out.has(src)) continue;
    const data = parseDataUrl(src);
    if (!data) continue;
    let bytes = data.bytes;
    let blip: PreparedImage['blip'] | null = null;
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) blip = 'pngblip';
    else if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) blip = 'jpegblip';
    else {
      const png = await rasterToPng(data.mime, bytes);
      if (png) {
        bytes = png;
        blip = 'pngblip';
      }
    }
    if (!blip) continue;
    const size = imageSize(bytes);
    if (!size || !size.width || !size.height) continue;
    out.set(src, { blip, bytes, width: size.width, height: size.height });
  }
  return out;
}

class RtfWriter {
  private fonts: string[] = [DEFAULT_FONT, MONO_FONT];
  private colors: string[] = [];
  private lists: ListDef[] = [];
  private items: Array<{ t: 'p' | 'raw'; s: string }> = [];
  private pendingBreak = false;
  private readonly contentWidth: number;

  constructor(
    private readonly setup: PageSetup,
    private readonly images: Map<string, PreparedImage>,
  ) {
    const dims = pageDimensions(setup);
    this.contentWidth = Math.max(1440, Math.round((dims.width - setup.margins.left - setup.margins.right) * 20));
  }

  /* ── tables of fonts / colours ── */

  private font(name: string): number {
    const generic = GENERIC_FONTS[name.toLowerCase()];
    const n = generic ?? name;
    let i = this.fonts.findIndex((f) => f.toLowerCase() === n.toLowerCase());
    if (i < 0) {
      this.fonts.push(n);
      i = this.fonts.length - 1;
    }
    return i;
  }

  private color(hex: string): number {
    let i = this.colors.indexOf(hex);
    if (i < 0) {
      this.colors.push(hex);
      i = this.colors.length - 1;
    }
    return i + 1; // index 0 is "auto"
  }

  /* ── inline ── */

  private baseFmt(kind: ParaKind, ctx: BlockCtx): CharFmt {
    const f: CharFmt = {
      bold: ctx.bold,
      italic: false,
      underline: false,
      strike: false,
      vert: '',
      color: null,
      highlight: null,
      font: 0,
      size: DEFAULT_HP,
      code: false,
    };
    if (kind.k === 'h') {
      f.bold = true;
      f.size = HEADING_HP[kind.level - 1];
    } else if (kind.k === 'pre') {
      f.font = 1;
      f.size = PRE_HP;
    }
    return f;
  }

  private charCodes(f: CharFmt, base: CharFmt): string {
    let s = '';
    if (f.code) s += `\\cs${CS_CODE}`;
    if (f.bold !== base.bold) s += f.bold ? '\\b' : '\\b0';
    if (f.italic !== base.italic) s += f.italic ? '\\i' : '\\i0';
    if (f.underline) s += '\\ul';
    if (f.strike) s += '\\strike';
    if (f.vert) s += f.vert === 'sub' ? '\\sub' : '\\super';
    if (f.font !== base.font) s += `\\f${f.font}`;
    if (f.size !== base.size) s += `\\fs${f.size}`;
    if (f.color) s += `\\cf${this.color(f.color)}`;
    if (f.highlight) {
      const n = this.color(f.highlight);
      s += WORD_HIGHLIGHTS.has(f.highlight) ? `\\highlight${n}` : `\\chshdng0\\chcbpat${n}\\cb${n}`;
    }
    return s;
  }

  private run(text: string, f: CharFmt, base: CharFmt): string {
    if (!text) return '';
    const codes = this.charCodes(f, base);
    const body = rtfEscape(text);
    return codes ? `{${codes} ${body}}` : body;
  }

  private styleFmt(el: Element, f: CharFmt): CharFmt {
    const st = parseStyle(el);
    const color = cssColorToHex(st['color']);
    if (color) f.color = color;
    const bg = cssColorToHex(st['background-color'] ?? st['background']);
    if (bg) f.highlight = bg;
    const fam = primaryFontFamily(st['font-family']);
    if (fam) f.font = this.font(fam);
    const size = cssLengthToPt(st['font-size']);
    if (size && size > 0) f.size = Math.max(2, Math.round(size * 2));
    const weight = st['font-weight'];
    if (weight) f.bold = /^(bold|bolder)$/i.test(weight) || parseInt(weight, 10) >= 600;
    if (st['font-style']) f.italic = /italic|oblique/i.test(st['font-style']);
    const deco = `${st['text-decoration'] ?? ''} ${st['text-decoration-line'] ?? ''}`;
    if (/underline/i.test(deco)) f.underline = true;
    if (/line-through/i.test(deco)) f.strike = true;
    const va = st['vertical-align'];
    if (va === 'sub') f.vert = 'sub';
    else if (va === 'super') f.vert = 'super';
    return f;
  }

  private collapse(s: string, ps: PState): string {
    s = s.replace(/[ \n\r\f]+/g, ' ');
    if (ps.sp && s.startsWith(' ')) s = s.slice(1);
    if (s) ps.sp = s.endsWith(' ');
    return s;
  }

  private inline(node: Node, fmt: CharFmt, base: CharFmt, ps: PState): string {
    if (node.nodeType === 3) {
      return this.run(this.collapse(node.nodeValue ?? '', ps), fmt, base);
    }
    if (node.nodeType !== 1) return '';
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return '';
    if (tag === 'br') {
      ps.sp = true;
      return '\\line ';
    }
    if (tag === 'img') return this.pict(el, ps);

    const f = this.styleFmt(el, { ...fmt });
    let href: string | null = null;
    switch (tag) {
      case 'strong':
      case 'b':
        f.bold = true;
        break;
      case 'em':
      case 'i':
        f.italic = true;
        break;
      case 'u':
      case 'ins':
        f.underline = true;
        break;
      case 's':
      case 'strike':
      case 'del':
        f.strike = true;
        break;
      case 'sub':
        f.vert = 'sub';
        break;
      case 'sup':
        f.vert = 'super';
        break;
      case 'code':
      case 'kbd':
      case 'samp':
      case 'tt':
        f.code = true;
        f.font = 1;
        break;
      case 'mark':
        f.highlight = cssColorToHex(el.getAttribute('data-color')) ?? f.highlight ?? 'ffff00';
        break;
      case 'a':
        href = el.getAttribute('href');
        if (href) {
          f.underline = true;
          if (!f.color) f.color = '0563c1';
        }
        break;
    }
    let inner = '';
    for (const child of Array.from(el.childNodes)) inner += this.inline(child, f, base, ps);
    if (href && inner) {
      const url = rtfEscape(href.replace(/\\/g, '\\\\').replace(/"/g, '%22'));
      return `{\\field{\\*\\fldinst{HYPERLINK "${url}"}}{\\fldrslt{${inner}}}}`;
    }
    return inner;
  }

  private pict(el: Element, ps: PState): string {
    const img = this.images.get(el.getAttribute('src') ?? '');
    if (!img) {
      const alt = el.getAttribute('alt');
      ps.sp = false;
      return rtfEscape(alt ? `[image: ${alt}]` : '[image]');
    }
    const st = parseStyle(el);
    const px = (attr: string) => {
      const a = el.getAttribute(attr);
      if (a && /^\d+(\.\d+)?$/.test(a.trim())) return parseFloat(a);
      const pt = cssLengthToPt(st[attr]);
      return pt && pt > 0 && !/%$/.test(st[attr]) ? pt / 0.75 : null;
    };
    let w = px('width');
    let h = px('height');
    if (w && !h) h = (w * img.height) / img.width;
    else if (h && !w) w = (h * img.width) / img.height;
    else if (!w || !h) {
      w = img.width;
      h = img.height;
    }
    let tw = w! * 15;
    let th = h! * 15;
    if (tw > this.contentWidth) {
      th = (th * this.contentWidth) / tw;
      tw = this.contentWidth;
    }
    ps.sp = false;
    return (
      `{\\pict\\${img.blip}\\picw${img.width}\\pich${img.height}` +
      `\\picwgoal${Math.max(1, Math.round(tw))}\\pichgoal${Math.max(1, Math.round(th))}\n${bytesToHex(img.bytes)}}`
    );
  }

  /* ── paragraphs ── */

  private alignOf(el: Element | null): string {
    if (!el) return '';
    const a = (parseStyle(el)['text-align'] ?? el.getAttribute('align') ?? '').toLowerCase();
    if (a === 'center') return '\\qc';
    if (a === 'right' || a === 'end') return '\\qr';
    if (a === 'justify') return '\\qj';
    return '';
  }

  /** Emits one paragraph. `body` receives the paragraph's base character format. */
  private para(kind: ParaKind, ctx: BlockCtx, el: Element | null, body: (base: CharFmt) => string): void {
    const base = this.baseFmt(kind, ctx);
    let head = '\\pard\\plain';
    let li = ctx.li;
    let fi = 0;
    let marker = '';

    if (kind.k === 'h') head += `\\s${kind.level}`;
    else if (kind.k === 'pre') head += `\\s${S_PRE}`;
    else if (ctx.quote && kind.k === 'p' && !ctx.item) head += `\\s${S_QUOTE}`;
    if (ctx.inTable) head += '\\intbl';
    if (this.pendingBreak && !ctx.inTable) {
      head += '\\pagebb';
      this.pendingBreak = false;
    }
    if (kind.k === 'h') head += '\\keepn';
    head += this.alignOf(el);

    if (ctx.item && !ctx.item.used && kind.k !== 'hr') {
      const it = ctx.item;
      it.used = true;
      fi = -360;
      head += `\\ls${it.ls}\\ilvl${it.ilvl}`;
      marker = `{\\listtext\\pard\\plain\\f${it.font}\\fs${DEFAULT_HP} ${rtfEscape(it.text)}\\tab}`;
    }
    if (fi) head += `\\fi${fi}`;
    if (li) head += `\\li${li}\\lin${li}`;
    if (ctx.ri) head += `\\ri${ctx.ri}\\rin${ctx.ri}`;

    if (kind.k === 'h') {
      const [sb, sa] = HEADING_SPACE[kind.level - 1];
      head += `\\sb${sb}\\sa${sa}\\outlinelevel${kind.level - 1}`;
    } else if (kind.k === 'pre') head += '\\sa0';
    else if (kind.k === 'hr') head += '\\brdrb\\brdrs\\brdrw10\\brsp20\\sa160';
    else if (ctx.inTable) head += '\\sb40\\sa40';
    else if (ctx.listDepth > 0) head += '\\sa60\\sl276\\slmult1';
    else head += '\\sa160\\sl276\\slmult1';

    head += `\\f${base.font}\\fs${base.size}`;
    if (base.bold) head += '\\b';
    this.items.push({ t: 'p', s: `${head} ${marker}${kind.k === 'hr' ? '' : body(base)}` });
  }

  private inlinePara(nodes: Node[], kind: ParaKind, ctx: BlockCtx, el: Element | null): void {
    this.para(kind, ctx, el, (base) => {
      const ps: PState = { sp: true };
      let s = '';
      for (const n of nodes) s += this.inline(n, base, base, ps);
      return s;
    });
  }

  /** Explicit page break paragraph, used when the break cannot ride on the next paragraph. */
  private flushBreak(): void {
    if (!this.pendingBreak) return;
    this.pendingBreak = false;
    this.items.push({ t: 'p', s: `\\pard\\plain\\sa0\\f0\\fs${DEFAULT_HP} \\page` });
  }

  /* ── blocks ── */

  blocks(parent: Node, ctx: BlockCtx): void {
    let buffer: Node[] = [];
    const flush = () => {
      if (!buffer.length) return;
      const hasContent = buffer.some((n) => n.nodeType === 1 || (n.nodeValue ?? '').trim() !== '');
      if (hasContent) this.inlinePara(buffer, { k: 'p' }, ctx, null);
      buffer = [];
    };
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === 3) {
        if (buffer.length || (node.nodeValue ?? '').trim() !== '') buffer.push(node);
        continue;
      }
      if (node.nodeType !== 1) continue;
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (!BLOCK_TAGS.has(tag)) {
        buffer.push(node);
        continue;
      }
      flush();
      this.block(el, tag, ctx);
    }
    flush();
  }

  private block(el: Element, tag: string, ctx: BlockCtx): void {
    switch (tag) {
      case 'p':
        this.inlinePara(Array.from(el.childNodes), { k: 'p' }, ctx, el);
        return;
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        this.inlinePara(Array.from(el.childNodes), { k: 'h', level: +tag[1] }, ctx, el);
        return;
      case 'blockquote':
        this.blocks(el, { ...ctx, li: ctx.li + 720, ri: ctx.ri + (ctx.quote ? 0 : 720), quote: true });
        return;
      case 'pre': {
        let text = (el.textContent ?? '').replace(/\r\n?/g, '\n');
        if (text.endsWith('\n')) text = text.slice(0, -1);
        for (const line of text.split('\n')) {
          this.para({ k: 'pre' }, ctx, null, () => rtfEscape(line));
        }
        return;
      }
      case 'hr':
        if (ctx.inTable) return;
        this.flushBreak();
        this.para({ k: 'hr' }, ctx, null, () => '');
        return;
      case 'ul':
      case 'ol':
        this.list(el, tag === 'ol', ctx);
        return;
      case 'table':
        this.table(el, ctx);
        return;
      case 'div':
        if (el.getAttribute('data-page-break') === 'true') {
          if (!ctx.inTable) {
            this.flushBreak(); // two breaks in a row
            this.pendingBreak = true;
          }
          return;
        }
        this.blocks(el, ctx);
        return;
      default:
        this.blocks(el, ctx);
    }
  }

  private list(el: Element, ordered: boolean, ctx: BlockCtx): void {
    if (ctx.item && !ctx.item.used) {
      // <li><ul>…</ul></li> without own text: the parent marker still needs its paragraph
      this.para({ k: 'p' }, ctx, null, () => '');
    }
    const depth = Math.min(ctx.listDepth, 8);
    let nfc = 23;
    let start = 1;
    if (ordered) {
      const type = el.getAttribute('type') ?? '';
      nfc = type === 'a' ? 4 : type === 'A' ? 3 : type === 'i' ? 2 : type === 'I' ? 1 : 0;
      const s = parseInt(el.getAttribute('start') ?? '', 10);
      if (isFinite(s)) start = s;
    }
    this.lists.push({ ordered, nfc, start });
    const ls = this.lists.length;
    const bullets = ['\u2022', 'o', '\u25aa'];
    const li = ctx.li + 720 * (ctx.listDepth > 0 ? 1 : 1);
    let n = start;
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag !== 'li') {
        if (tag === 'ul' || tag === 'ol') this.list(child, tag === 'ol', { ...ctx, li, listDepth: ctx.listDepth + 1, item: null });
        continue;
      }
      const item: ItemMarker = {
        ls,
        ilvl: depth,
        text: ordered ? `${numberText(nfc, n)}.` : bullets[depth % 3],
        font: !ordered && depth % 3 === 1 ? 1 : 0,
        used: false,
      };
      const ictx: BlockCtx = { ...ctx, li, listDepth: ctx.listDepth + 1, item, quote: false };
      this.blocks(child, ictx);
      if (!item.used) this.para({ k: 'p' }, ictx, null, () => '');
      n++;
    }
  }

  private table(el: Element, ctx: BlockCtx): void {
    interface CellRef {
      el: Element;
      r: number;
      c: number;
      rs: number;
      cs: number;
    }
    const rowEls: Element[] = [];
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'tr') rowEls.push(child);
      else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
        for (const tr of Array.from(child.children)) if (tr.tagName.toLowerCase() === 'tr') rowEls.push(tr);
      }
    }
    if (!rowEls.length) return;

    if (ctx.inTable) {
      // RTF nested tables are fragile; flatten the inner table into the outer cell
      for (const tr of rowEls) for (const cell of Array.from(tr.children)) this.blocks(cell, ctx);
      return;
    }

    const grid: Array<Array<CellRef | undefined>> = rowEls.map(() => []);
    let ncols = 0;
    rowEls.forEach((tr, r) => {
      let c = 0;
      for (const cell of Array.from(tr.children)) {
        const tag = cell.tagName.toLowerCase();
        if (tag !== 'td' && tag !== 'th') continue;
        while (grid[r][c]) c++;
        const cs = Math.max(1, Math.min(63, parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1));
        const rs = Math.max(1, Math.min(rowEls.length - r, parseInt(cell.getAttribute('rowspan') ?? '1', 10) || 1));
        const ref: CellRef = { el: cell, r, c, rs, cs };
        for (let rr = r; rr < r + rs; rr++) for (let cc = c; cc < c + cs; cc++) grid[rr][cc] = ref;
        c += cs;
        ncols = Math.max(ncols, c);
      }
    });
    if (!ncols) return;

    this.flushBreak();
    const width = Math.max(720, this.contentWidth - ctx.li - ctx.ri);
    const colW = width / ncols;
    const border = '\\brdrs\\brdrw10';
    const borders = `\\clbrdrt${border}\\clbrdrl${border}\\clbrdrb${border}\\clbrdrr${border}`;
    let out = '';
    rowEls.forEach((tr, r) => {
      const cells = Array.from(tr.children).filter((c) => /^t[dh]$/i.test(c.tagName));
      const header = cells.length > 0 && cells.every((c) => c.tagName.toLowerCase() === 'th');
      let defs = `\\trowd\\trgaph108\\trleft${ctx.li}${header ? '\\trhdr' : ''}`;
      let content = '';
      for (let c = 0; c < ncols; ) {
        const ref = grid[r][c];
        const span = ref ? ref.c + ref.cs - c : 1;
        const edge = ctx.li + Math.round(colW * (c + span));
        let merge = '';
        if (ref && ref.rs > 1) merge = ref.r === r ? '\\clvmgf' : '\\clvmrg';
        defs += `${merge}${borders}\\cellx${edge}`;
        const cctx: BlockCtx = {
          li: 0,
          ri: 0,
          inTable: true,
          quote: false,
          bold: !!ref && ref.el.tagName.toLowerCase() === 'th',
          listDepth: 0,
          item: null,
        };
        const saved = this.items;
        this.items = [];
        if (ref && ref.r === r) this.blocks(ref.el, cctx);
        const paras = this.items.filter((i) => i.t === 'p').map((i) => i.s);
        this.items = saved;
        if (!paras.length) paras.push(`\\pard\\plain\\intbl\\f0\\fs${DEFAULT_HP} `);
        content += `${paras.join('\\par\n')}\\cell\n`;
        c += span;
      }
      out += `${defs}\n${content}\\row\n`;
    });
    this.items.push({ t: 'raw', s: out });
  }

  /** Converts an HTML fragment to an RTF body snippet without touching the document items. */
  fragment(root: HTMLElement): string {
    const savedItems = this.items;
    const savedBreak = this.pendingBreak;
    this.items = [];
    this.pendingBreak = false;
    try {
      this.blocks(root, { li: 0, ri: 0, inTable: false, quote: false, bold: false, listDepth: 0, item: null });
      this.flushBreak();
      return this.items.map((i) => (i.t === 'p' ? `${i.s}\\par\n` : i.s)).join('');
    } finally {
      this.items = savedItems;
      this.pendingBreak = savedBreak;
    }
  }

  /* ── document ── */

  finish(title: string | undefined, headers: RtfHeaderFooterParts = {}): string {
    this.flushBreak();
    const body = this.items.map((i) => (i.t === 'p' ? `${i.s}\\par\n` : i.s)).join('');

    const fonttbl = this.fonts
      .map((name, i) => `{\\f${i}\\${fontFamilyClass(name)}\\fcharset0 ${rtfEscape(name.replace(/[;{}\\]/g, ''))};}`)
      .join('');
    const colortbl = this.colors
      .map((hex) => `\\red${parseInt(hex.slice(0, 2), 16)}\\green${parseInt(hex.slice(2, 4), 16)}\\blue${parseInt(hex.slice(4, 6), 16)};`)
      .join('');

    let styles = `{\\s0\\sa160\\sl276\\slmult1\\f0\\fs${DEFAULT_HP} \\snext0 Normal;}`;
    for (let l = 1; l <= 6; l++) {
      const [sb, sa] = HEADING_SPACE[l - 1];
      styles += `{\\s${l}\\keepn\\sb${sb}\\sa${sa}\\outlinelevel${l - 1}\\b\\f0\\fs${HEADING_HP[l - 1]} \\sbasedon0\\snext0 heading ${l};}`;
    }
    styles += `{\\s${S_QUOTE}\\li720\\ri720\\sa160\\sl276\\slmult1\\f0\\fs${DEFAULT_HP} \\sbasedon0\\snext${S_QUOTE} Quote;}`;
    styles += `{\\s${S_PRE}\\sa0\\f1\\fs${PRE_HP} \\sbasedon0\\snext${S_PRE} HTML Preformatted;}`;
    styles += `{\\*\\cs${CS_CODE}\\additive\\f1 HTML Code;}`;

    let listtable = '';
    let overrides = '';
    this.lists.forEach((def, i) => {
      const id = 1000 + i;
      let levels = '';
      for (let k = 0; k < 9; k++) {
        const indent = 720 * (k + 1);
        if (def.ordered) {
          levels +=
            `{\\listlevel\\levelnfc${def.nfc}\\levelnfcn${def.nfc}\\leveljc0\\leveljcn0\\levelfollow0` +
            `\\levelstartat${def.start}\\levelspace0\\levelindent0{\\leveltext\\'02\\'0${k}.;}{\\levelnumbers\\'01;}` +
            `\\fi-360\\li${indent}\\lin${indent}}`;
        } else {
          const glyph = ['\\u8226 ?', 'o', '\\u9642 ?'][k % 3];
          levels +=
            `{\\listlevel\\levelnfc23\\levelnfcn23\\leveljc0\\leveljcn0\\levelfollow0` +
            `\\levelstartat1\\levelspace0\\levelindent0{\\leveltext\\'01${glyph};}{\\levelnumbers;}` +
            `\\f${k % 3 === 1 ? 1 : 0}\\fi-360\\li${indent}\\lin${indent}}`;
        }
      }
      listtable += `{\\list\\listtemplateid${id}\\listhybrid${levels}{\\listname ;}\\listid${id}}\n`;
      overrides += `{\\listoverride\\listid${id}\\listoverridecount0\\ls${i + 1}}`;
    });

    const dims = pageDimensions(this.setup);
    const m = this.setup.margins;
    const tw = (pt: number) => Math.round(pt * 20);
    const landscape = this.setup.orientation === 'landscape';
    const facing = !!(headers.headerEven || headers.footerEven || this.setup.differentOddEven);
    const titlepg = !!(headers.headerFirst || headers.footerFirst || this.setup.differentFirstPage);
    const hasHf = !!(
      headers.header || headers.footer || headers.headerFirst || headers.footerFirst ||
      headers.headerEven || headers.footerEven
    );
    const dest = (name: string, content: string | undefined) =>
      content && content.trim() ? `{\\${name} ${content}}` : '';
    let hf = '';
    if (facing) {
      // even = left, odd/default = right
      hf += dest('headerl', headers.headerEven || headers.header);
      hf += dest('headerr', headers.header);
      hf += dest('footerl', headers.footerEven || headers.footer);
      hf += dest('footerr', headers.footer);
    } else {
      hf += dest('header', headers.header);
      hf += dest('footer', headers.footer);
    }
    if (titlepg) {
      hf += dest('headerf', headers.headerFirst || headers.header);
      hf += dest('footerf', headers.footerFirst || headers.footer);
    }
    const hfDist =
      hasHf || this.setup.headerDistance !== undefined || this.setup.footerDistance !== undefined
        ? `\\headery${tw(this.setup.headerDistance ?? DEFAULT_HF_DISTANCE)}\\footery${tw(this.setup.footerDistance ?? DEFAULT_HF_DISTANCE)}`
        : '';
    const page =
      `\\paperw${tw(dims.width)}\\paperh${tw(dims.height)}` +
      `\\margl${tw(m.left)}\\margr${tw(m.right)}\\margt${tw(m.top)}\\margb${tw(m.bottom)}` +
      hfDist +
      (landscape ? '\\landscape' : '') +
      (facing ? '\\facingp' : '') +
      '\\widowctrl\\ftnbj\\viewkind1' +
      `\\sectd${landscape ? '\\lndscpsxn' : ''}${titlepg ? '\\titlepg' : ''}\\pgwsxn${tw(dims.width)}\\pghsxn${tw(dims.height)}` +
      `\\marglsxn${tw(m.left)}\\margrsxn${tw(m.right)}\\margtsxn${tw(m.top)}\\margbsxn${tw(m.bottom)}`;

    return (
      `{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1\\deflang1033\n` +
      `{\\fonttbl${fonttbl}}\n` +
      `{\\colortbl;${colortbl}}\n` +
      `{\\stylesheet${styles}}\n` +
      (listtable ? `{\\*\\listtable\n${listtable}}\n{\\*\\listoverridetable${overrides}}\n` : '') +
      (title ? `{\\info{\\title ${rtfEscape(title)}}}\n` : '') +
      `${page}\n` +
      (hf ? `${hf}\n` : '') +
      body +
      '}\n'
    );
  }
}

interface RtfHeaderFooterParts {
  header?: string;
  footer?: string;
  headerFirst?: string;
  footerFirst?: string;
  headerEven?: string;
  footerEven?: string;
}

export const exportRtf: Exporter = async (doc) => {
  const roots = [doc.html, doc.header, doc.footer, doc.headerFirst, doc.footerFirst, doc.headerEven, doc.footerEven]
    .filter((h): h is string => !!h && !!h.trim())
    .map((h) => parseHtml(h));
  const images = new Map<string, PreparedImage>();
  for (const root of roots) {
    for (const [k, v] of await prepareImages(root)) images.set(k, v);
  }
  const writer = new RtfWriter(doc.pageSetup ?? DEFAULT_PAGE_SETUP, images);
  const frag = (html: string | undefined) => (html && html.trim() ? writer.fragment(parseHtml(html)) : undefined);
  const headers: RtfHeaderFooterParts = {
    header: frag(doc.header),
    footer: frag(doc.footer),
    headerFirst: frag(doc.headerFirst),
    footerFirst: frag(doc.footerFirst),
    headerEven: frag(doc.headerEven),
    footerEven: frag(doc.footerEven),
  };
  writer.blocks(parseHtml(doc.html ?? ''), { li: 0, ri: 0, inTable: false, quote: false, bold: false, listDepth: 0, item: null });
  return utf8Encode(writer.finish(doc.title, headers));
};

/* ════════════════════════════════════════════════════════════════════════════
 * IMPORT — tokenizer
 * ════════════════════════════════════════════════════════════════════════════ */

const enum T {
  Group,
  Ctrl,
  Text,
  Hex,
  Bin,
}

interface GroupNode {
  t: T.Group;
  kids: RtfNode[];
}
interface CtrlNode {
  t: T.Ctrl;
  /** control word, or the single character of a control symbol */
  w: string;
  p: number | null;
}
interface TextNode {
  t: T.Text;
  /** byte range in the source */
  s: number;
  e: number;
}
interface HexNode {
  t: T.Hex;
  b: number;
}
interface BinNode {
  t: T.Bin;
  s: number;
  e: number;
}
type RtfNode = GroupNode | CtrlNode | TextNode | HexNode | BinNode;

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

function isLetter(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a);
}

function tokenize(src: Uint8Array): GroupNode {
  const root: GroupNode = { t: T.Group, kids: [] };
  const stack: GroupNode[] = [root];
  let cur = root;
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === 0x7b /* { */) {
      const g: GroupNode = { t: T.Group, kids: [] };
      cur.kids.push(g);
      stack.push(g);
      cur = g;
      i++;
    } else if (c === 0x7d /* } */) {
      if (stack.length > 1) {
        stack.pop();
        cur = stack[stack.length - 1];
      }
      i++;
    } else if (c === 0x5c /* \ */) {
      i++;
      if (i >= n) break;
      const d = src[i];
      if (isLetter(d)) {
        const ws = i;
        while (i < n && isLetter(src[i])) i++;
        let word = '';
        for (let k = ws; k < i; k++) word += String.fromCharCode(src[k]);
        let param: number | null = null;
        if (i < n && (src[i] === 0x2d || (src[i] >= 0x30 && src[i] <= 0x39))) {
          let neg = false;
          if (src[i] === 0x2d) {
            neg = true;
            i++;
          }
          let v = 0;
          let digits = 0;
          while (i < n && src[i] >= 0x30 && src[i] <= 0x39 && digits < 10) {
            v = v * 10 + (src[i] - 0x30);
            i++;
            digits++;
          }
          param = neg ? -v : v;
        }
        if (i < n && src[i] === 0x20) i++; // delimiter space belongs to the control word
        if (word === 'bin' && param !== null && param > 0) {
          const end = Math.min(n, i + param);
          cur.kids.push({ t: T.Bin, s: i, e: end });
          i = end;
        } else {
          cur.kids.push({ t: T.Ctrl, w: word, p: param });
        }
      } else if (d === 0x27 /* ' */) {
        const h1 = i + 1 < n ? hexVal(src[i + 1]) : -1;
        const h2 = i + 2 < n ? hexVal(src[i + 2]) : -1;
        if (h1 >= 0 && h2 >= 0) {
          cur.kids.push({ t: T.Hex, b: h1 * 16 + h2 });
          i += 3;
        } else {
          i++;
        }
      } else if (d === 0x0d || d === 0x0a) {
        // backslash-newline is a paragraph break
        cur.kids.push({ t: T.Ctrl, w: 'par', p: null });
        i++;
        if (d === 0x0d && i < n && src[i] === 0x0a) i++;
      } else {
        cur.kids.push({ t: T.Ctrl, w: String.fromCharCode(d), p: null });
        i++;
      }
    } else if (c === 0x0d || c === 0x0a || c === 0x00) {
      i++;
    } else {
      const s = i;
      while (i < n) {
        const b = src[i];
        if (b === 0x7b || b === 0x7d || b === 0x5c || b === 0x0d || b === 0x0a || b === 0x00) break;
        i++;
      }
      cur.kids.push({ t: T.Text, s, e: i });
    }
  }
  return root;
}

/* ════════════════════════════════════════════════════════════════════════════
 * IMPORT — interpreter
 * ════════════════════════════════════════════════════════════════════════════ */

interface CharState {
  b: boolean;
  i: boolean;
  ul: boolean;
  strike: boolean;
  vert: '' | 'sub' | 'super';
  cf: number;
  hl: number;
  cb: number;
  f: number;
  fs: number;
  hidden: boolean;
  cs: number;
}

interface ParaState {
  align: '' | 'center' | 'right' | 'justify';
  li: number;
  intbl: boolean;
  outline: number;
  s: number;
  ls: number;
  ilvl: number;
  pagebb: boolean;
  border: boolean;
}

interface State {
  c: CharState;
  p: ParaState;
  uc: number;
  /** set by loch: a following afN names the font for low-ANSI (Latin) text */
  loch: boolean;
}

type RRun =
  | { k: 't'; text: string; c: CharState; link: string | null }
  | { k: 'br'; link: string | null }
  | { k: 'img'; html: string; link: string | null };

interface ParaBlock {
  t: 'p';
  p: ParaState;
  runs: RRun[];
  /** literal list marker text when the paragraph had \listtext / \pntext */
  marker: string | null;
}
interface TableRow {
  cells: Block[][];
  defs: CellDef[];
  header: boolean;
}
interface TableBlock {
  t: 'table';
  rows: TableRow[];
}
type Block = ParaBlock | { t: 'break' } | TableBlock;

interface CellDef {
  x: number;
  vmgf: boolean;
  vmrg: boolean;
  mgf: boolean;
  mrg: boolean;
}

interface FontDef {
  name: string;
  cp: number | null;
}

interface StyleDef {
  name: string;
  kind: 'heading' | 'quote' | 'pre' | 'code' | '';
  level: number;
  f: number | null;
  fs: number | null;
  b: boolean;
  i: boolean;
  cf: number | null;
}

const DEFAULT_PARA: ParaState = {
  align: '',
  li: 0,
  intbl: false,
  outline: -1,
  s: 0,
  ls: 0,
  ilvl: 0,
  pagebb: false,
  border: false,
};

const CHARSET_CP: Record<number, number> = {
  0: 1252, 1: 0, 77: 10000, 128: 932, 129: 949, 130: 1361, 134: 936, 136: 950, 161: 1253, 162: 1254,
  163: 1258, 177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250, 254: 437, 255: 850,
};

const CP_LABEL: Record<number, string> = {
  437: 'ibm437', 850: 'ibm850', 866: 'ibm866', 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr',
  950: 'big5', 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253',
  1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258',
  10000: 'macintosh', 65001: 'utf-8',
};

/** Windows-1252 bytes 0x80–0x9F (the rest of the code page equals ISO-8859-1). */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

/**
 * Decodes windows-1252 without relying on TextDecoder: some Node releases alias the
 * 'windows-1252' label to ISO-8859-1 and turn smart quotes / dashes into C1 controls.
 */
export function decodeCp1252(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x2000) {
    const end = Math.min(bytes.length, i + 0x2000);
    const codes: number[] = [];
    for (let j = i; j < end; j++) {
      const b = bytes[j];
      codes.push(b >= 0x80 && b < 0xa0 ? CP1252_HIGH[b - 0x80] : b);
    }
    out += String.fromCharCode(...codes);
  }
  return out;
}

interface ByteDecoder {
  decode(bytes: Uint8Array): string;
}

const CP1252_DECODER: ByteDecoder = { decode: decodeCp1252 };
const decoders = new Map<number, ByteDecoder>();
function decoderFor(cp: number): ByteDecoder {
  let d = decoders.get(cp);
  if (!d) {
    const label = CP_LABEL[cp];
    if (!label || cp === 1252) d = CP1252_DECODER;
    else {
      try {
        d = new TextDecoder(label);
      } catch {
        d = CP1252_DECODER;
      }
    }
    decoders.set(cp, d);
  }
  return d;
}

/** Header / footer destinations captured into RichDocument fields. */
const HF_DESTINATIONS = new Set([
  'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf',
]);

/** Destinations whose content is never document text. */
const SKIP_DESTINATIONS = new Set([
  'footnote',
  'pn', 'pnseclvl', 'object', 'shp', 'shpgrp', 'shprslt', 'shpinst', 'do', 'xe', 'tc', 'rxe', 'txe', 'private',
  'generator', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'filetbl', 'revtbl', 'rsidtbl',
  'xmlnstbl', 'listpicture', 'mmathPr', 'template', 'operator', 'author', 'title', 'subject', 'keywords',
  'comment', 'doccomm', 'company', 'manager', 'category', 'creatim', 'revtim', 'printim', 'buptim',
  'userprops', 'fldinst', 'bkmkstart', 'bkmkend', 'atnid', 'atnauthor', 'annotation', 'atrfstart', 'atrfend',
  'atndate', 'atnref', 'atnparent', 'atnicn', 'pgdsctbl', 'pgdsc', 'falt', 'panose', 'fname', 'blipuid',
  'picprop', 'sp', 'sn', 'sv', 'datafield', 'formfield', 'ftnsep', 'ftnsepc', 'ftncn', 'aftnsep', 'aftnsepc',
  'aftncn', 'background', 'nesttableprops', 'nonesttables', 'nonshppict', 'wgrffmtfilter', 'docvar', 'ud',
  'fontemb', 'fontfile', 'ffname', 'ffdeftext', 'ffformat', 'ffhelptext', 'ffstattext', 'ffentrymcr', 'ffexitmcr',
  'ffl', 'defchp', 'defpap', 'pgptbl', 'protusertbl', 'fchars', 'lchars', 'passwordhash', 'writereservhash',
  'oldcprops', 'oldpprops', 'oldsprops', 'oldtprops', 'listname', 'liststylename', 'leveltext', 'levelnumbers',
]);

class RtfReader {
  private st: State;
  private defC: CharState;
  private ansicp = 1252;
  private deff = 0;
  private fonts = new Map<number, FontDef>();
  private colors: Array<string | null> = [];
  private paraStyles = new Map<number, StyleDef>();
  private charStyles = new Map<number, StyleDef>();
  private listDefs = new Map<number, { nfc: number[] }>();
  private listOverrides = new Map<number, number>();

  private blocks: Block[] = [];
  private cellBlocks: Block[] = [];
  private rowCells: Block[][] = [];
  private rowDefs: CellDef[] = [];
  private rowHeader = false;
  private pendDef = { vmgf: false, vmrg: false, mgf: false, mrg: false };
  private lastSect: Block | null = null;

  private runs: RRun[] = [];
  private marker: string | null = null;
  private afterBreak = false;

  private pending: number[] = [];
  private capture: string[] | null = null;
  private link: string | null = null;

  title: string | undefined;
  private paper: {
    w?: number;
    h?: number;
    l?: number;
    r?: number;
    t?: number;
    b?: number;
    landscape?: boolean;
    headery?: number;
    footery?: number;
    facingp?: boolean;
    titlepg?: boolean;
  } = {};
  /** Captured header / footer HTML by destination name. */
  private hfHtml: Partial<Record<string, string>> = {};

  constructor(private readonly src: Uint8Array) {
    this.defC = {
      b: false, i: false, ul: false, strike: false, vert: '', cf: 0, hl: 0, cb: 0, f: 0, fs: 24, hidden: false, cs: 0,
    };
    this.st = { c: this.defC, p: DEFAULT_PARA, uc: 1, loch: false };
  }

  /* ── state helpers ── */

  private setC(patch: Partial<CharState>): void {
    this.st = { ...this.st, c: { ...this.st.c, ...patch } };
  }
  private setP(patch: Partial<ParaState>): void {
    this.st = { ...this.st, p: { ...this.st.p, ...patch } };
  }

  private codePage(): number {
    const font = this.fonts.get(this.st.c.f);
    return font?.cp || this.ansicp;
  }

  private flushBytes(): void {
    if (!this.pending.length) return;
    const bytes = Uint8Array.from(this.pending);
    this.pending = [];
    this.text(decoderFor(this.codePage()).decode(bytes));
  }

  private text(s: string): void {
    if (!s) return;
    if (this.capture) {
      this.capture.push(s);
      return;
    }
    if (this.st.c.hidden) return;
    const last = this.runs[this.runs.length - 1];
    if (last && last.k === 't' && last.c === this.st.c && last.link === this.link) last.text += s;
    else this.runs.push({ k: 't', text: s, c: this.st.c, link: this.link });
  }

  /* ── structure ── */

  private hasContent(): boolean {
    return this.runs.some((r) => r.k !== 't' || r.text.trim() !== '');
  }

  private takePara(): ParaBlock {
    const para: ParaBlock = { t: 'p', p: this.st.p, runs: this.runs, marker: this.marker };
    this.runs = [];
    this.marker = null;
    this.afterBreak = false;
    return para;
  }

  private endPara(): void {
    if (this.afterBreak && !this.runs.length && this.marker === null) {
      // "\page\par": the paragraph only carried the break
      this.afterBreak = false;
      return;
    }
    const para = this.takePara();
    if (para.p.intbl) this.cellBlocks.push(para);
    else this.blocks.push(para);
  }

  private endCell(): void {
    this.cellBlocks.push(this.takePara());
    this.rowCells.push(this.cellBlocks);
    this.cellBlocks = [];
  }

  private endRow(): void {
    if (this.runs.length || this.cellBlocks.length) this.endCell();
    if (!this.rowCells.length) return;
    const row: TableRow = { cells: this.rowCells, defs: this.rowDefs.slice(), header: this.rowHeader };
    this.rowCells = [];
    const last = this.blocks[this.blocks.length - 1];
    if (last && last.t === 'table') last.rows.push(row);
    else this.blocks.push({ t: 'table', rows: [row] });
  }

  private pageBreak(): void {
    if (this.st.p.intbl) return;
    if (this.hasContent() || this.marker !== null) this.blocks.push(this.takePara());
    this.blocks.push({ t: 'break' });
    this.afterBreak = true;
  }

  /* ── groups / destinations ── */

  private group(g: GroupNode): void {
    const saved = this.st;
    try {
      this.dispatch(g);
    } finally {
      this.flushBytes();
      this.st = saved;
    }
  }

  private firstCtrl(g: GroupNode): { word: string; starred: boolean; index: number } | null {
    let i = 0;
    let starred = false;
    const k0 = g.kids[0];
    if (k0 && k0.t === T.Ctrl && k0.w === '*') {
      starred = true;
      i = 1;
    }
    const k = g.kids[i];
    if (k && k.t === T.Ctrl) return { word: k.w, starred, index: i };
    return starred ? { word: '', starred, index: i } : null;
  }

  private dispatch(g: GroupNode): void {
    const first = this.firstCtrl(g);
    if (first) {
      switch (first.word) {
        case 'fonttbl':
          this.parseFontTable(g);
          return;
        case 'colortbl':
          this.parseColorTable(g);
          return;
        case 'stylesheet':
          this.parseStylesheet(g);
          return;
        case 'info':
          this.findTitle(g, 0);
          return;
        case 'listtable':
          this.parseListTable(g);
          return;
        case 'listoverridetable':
          this.parseListOverrides(g);
          return;
        case 'pict':
          this.picture(g);
          return;
        case 'field':
          this.field(g);
          return;
        case 'listtext':
        case 'pntext': {
          if (this.capture) return;
          const text = this.captureText(g);
          this.marker = (this.marker ?? '') + text;
          return;
        }
        case 'upr': {
          // {\upr{ansi}{\*\ud{unicode}}} — prefer the Unicode version
          for (const k of g.kids) {
            if (k.t !== T.Group) continue;
            const f = this.firstCtrl(k);
            if (f && f.starred && f.word === 'ud') {
              this.run(k.kids, f.index + 1);
              return;
            }
          }
          return;
        }
        case 'shppict':
          this.run(g.kids, first.index + 1);
          return;
        default:
          if (HF_DESTINATIONS.has(first.word)) {
            this.captureHeaderFooter(first.word, g, first.index + 1);
            return;
          }
          if (first.starred || SKIP_DESTINATIONS.has(first.word)) return;
      }
    }
    this.run(g.kids, 0);
  }

  /** Parses a header/footer destination into HTML without polluting the body. */
  private captureHeaderFooter(word: string, g: GroupNode, from: number): void {
    const saved = {
      blocks: this.blocks,
      cellBlocks: this.cellBlocks,
      rowCells: this.rowCells,
      rowDefs: this.rowDefs,
      rowHeader: this.rowHeader,
      pendDef: this.pendDef,
      lastSect: this.lastSect,
      runs: this.runs,
      marker: this.marker,
      afterBreak: this.afterBreak,
      link: this.link,
    };
    this.blocks = [];
    this.cellBlocks = [];
    this.rowCells = [];
    this.rowDefs = [];
    this.rowHeader = false;
    this.pendDef = { vmgf: false, vmrg: false, mgf: false, mrg: false };
    this.lastSect = null;
    this.runs = [];
    this.marker = null;
    this.afterBreak = false;
    this.link = null;
    try {
      this.run(g.kids, from);
      if (this.runs.length || this.marker !== null) {
        if (this.rowCells.length || this.cellBlocks.length) this.endCell();
        else this.endPara();
      }
      if (this.rowCells.length || this.cellBlocks.length) this.endRow();
      const html = this.render(this.blocks, false);
      if (html.trim()) this.hfHtml[word] = html;
    } finally {
      this.blocks = saved.blocks;
      this.cellBlocks = saved.cellBlocks;
      this.rowCells = saved.rowCells;
      this.rowDefs = saved.rowDefs;
      this.rowHeader = saved.rowHeader;
      this.pendDef = saved.pendDef;
      this.lastSect = saved.lastSect;
      this.runs = saved.runs;
      this.marker = saved.marker;
      this.afterBreak = saved.afterBreak;
      this.link = saved.link;
    }
  }

  private run(kids: RtfNode[], from: number): void {
    let skip = 0;
    const src = this.src;
    for (let n = from; n < kids.length; n++) {
      const k = kids[n];
      switch (k.t) {
        case T.Group:
          skip = 0;
          this.flushBytes();
          this.group(k);
          break;
        case T.Hex:
          if (skip > 0) skip--;
          else this.pending.push(k.b);
          break;
        case T.Bin:
          skip = 0;
          break;
        case T.Text: {
          let s = k.s;
          if (skip > 0) {
            const take = Math.min(skip, k.e - s);
            s += take;
            skip -= take;
          }
          if (s >= k.e) break;
          let ascii = true;
          for (let j = s; j < k.e; j++) {
            if (src[j] >= 0x80) {
              ascii = false;
              break;
            }
          }
          if (ascii) {
            this.flushBytes();
            this.text(decoderFor(1252).decode(src.subarray(s, k.e)));
          } else {
            // raw 8-bit text: interpret in the current code page
            for (let j = s; j < k.e; j++) this.pending.push(src[j]);
          }
          break;
        }
        case T.Ctrl:
          if (skip > 0 && (k.w === '\\' || k.w === '{' || k.w === '}')) {
            skip--;
            break;
          }
          if (k.w === 'u' && k.p !== null) {
            this.flushBytes();
            this.text(String.fromCharCode(k.p < 0 ? k.p + 65536 : k.p));
            skip = this.st.uc;
            break;
          }
          skip = 0;
          this.flushBytes();
          this.ctrl(k.w, k.p);
          break;
      }
    }
    this.flushBytes();
  }

  private captureText(g: GroupNode): string {
    const saved = this.capture;
    this.capture = [];
    try {
      const st = this.st;
      this.run(g.kids, 0);
      this.st = st;
      return this.capture.join('');
    } finally {
      this.capture = saved;
    }
  }

  /* ── control words ── */

  private ctrl(w: string, p: number | null): void {
    const on = p !== 0;
    // characters
    switch (w) {
      case 'tab':
        this.text('\t');
        return;
      case '~':
        this.text('\u00a0');
        return;
      case '_':
        this.text('\u2011');
        return;
      case '-':
      case '|':
      case ':':
      case '*':
        return;
      case '\\':
      case '{':
      case '}':
        this.text(w);
        return;
      case 'emdash':
        this.text('\u2014');
        return;
      case 'endash':
        this.text('\u2013');
        return;
      case 'emspace':
        this.text('\u2003');
        return;
      case 'enspace':
        this.text('\u2002');
        return;
      case 'qmspace':
        this.text('\u2005');
        return;
      case 'bullet':
        this.text('\u2022');
        return;
      case 'lquote':
        this.text('\u2018');
        return;
      case 'rquote':
        this.text('\u2019');
        return;
      case 'ldblquote':
        this.text('\u201c');
        return;
      case 'rdblquote':
        this.text('\u201d');
        return;
      case 'uc':
        this.st = { ...this.st, uc: p !== null && p >= 0 ? p : 1 };
        return;
      case 'f':
        if (p !== null) this.setC({ f: p });
        return;
      case 'plain':
        this.setC({ ...this.defC });
        return;
    }
    if (this.capture) return; // structural / formatting words are irrelevant while capturing text

    switch (w) {
      /* structure */
      case 'par':
        this.endPara();
        return;
      case 'line':
      case 'lbr':
        this.runs.push({ k: 'br', link: this.link });
        return;
      case 'page':
        this.pageBreak();
        return;
      case 'sect':
        if (this.st.p.intbl) return;
        if (this.hasContent() || this.marker !== null) this.blocks.push(this.takePara());
        this.lastSect = { t: 'break' };
        this.blocks.push(this.lastSect);
        this.afterBreak = true;
        return;
      case 'sbknone':
        if (this.lastSect && this.blocks[this.blocks.length - 1] === this.lastSect) {
          this.blocks.pop();
          this.afterBreak = false;
        }
        this.lastSect = null;
        return;
      case 'cell':
        this.endCell();
        return;
      case 'nestcell':
        this.cellBlocks.push(this.takePara());
        return;
      case 'row':
        this.endRow();
        return;
      case 'trowd':
        this.rowDefs = [];
        this.rowHeader = false;
        this.pendDef = { vmgf: false, vmrg: false, mgf: false, mrg: false };
        return;
      case 'trhdr':
        this.rowHeader = true;
        return;
      case 'clvmgf':
        this.pendDef.vmgf = true;
        return;
      case 'clvmrg':
        this.pendDef.vmrg = true;
        return;
      case 'clmgf':
        this.pendDef.mgf = true;
        return;
      case 'clmrg':
        this.pendDef.mrg = true;
        return;
      case 'cellx':
        this.rowDefs.push({ x: p ?? 0, ...this.pendDef });
        this.pendDef = { vmgf: false, vmrg: false, mgf: false, mrg: false };
        return;

      /* paragraph */
      case 'pard':
        this.st = { ...this.st, p: DEFAULT_PARA };
        return;
      case 'ql':
        this.setP({ align: '' });
        return;
      case 'qc':
        this.setP({ align: 'center' });
        return;
      case 'qr':
        this.setP({ align: 'right' });
        return;
      case 'qj':
      case 'qd':
        this.setP({ align: 'justify' });
        return;
      case 'li':
      case 'lin':
        this.setP({ li: p ?? 0 });
        return;
      case 'intbl':
        this.setP({ intbl: true });
        return;
      case 'itap':
        if (p !== null && p > 0) this.setP({ intbl: true });
        return;
      case 'outlinelevel':
        this.setP({ outline: p ?? 0 });
        return;
      case 's':
        this.setP({ s: p ?? 0 });
        return;
      case 'ls':
        this.setP({ ls: p ?? 0 });
        return;
      case 'ilvl':
        this.setP({ ilvl: p ?? 0 });
        return;
      case 'pagebb':
        this.setP({ pagebb: on });
        return;
      case 'brdrb':
      case 'brdrt':
        this.setP({ border: true });
        return;

      /* character */
      case 'b':
        this.setC({ b: on });
        return;
      case 'i':
        this.setC({ i: on });
        return;
      case 'ul':
      case 'uld':
      case 'uldb':
      case 'ulw':
      case 'uldash':
      case 'uldashd':
      case 'uldashdd':
      case 'ulth':
      case 'ulwave':
        this.setC({ ul: on });
        return;
      case 'ulnone':
        this.setC({ ul: false });
        return;
      case 'strike':
      case 'striked':
        this.setC({ strike: on });
        return;
      case 'sub':
        this.setC({ vert: 'sub' });
        return;
      case 'super':
        this.setC({ vert: 'super' });
        return;
      case 'nosupersub':
        this.setC({ vert: '' });
        return;
      case 'cf':
        this.setC({ cf: p ?? 0 });
        return;
      case 'highlight':
        this.setC({ hl: p ?? 0 });
        return;
      case 'cb':
      case 'chcbpat':
        this.setC({ cb: p ?? 0 });
        return;
      case 'fs':
        if (p !== null && p > 0) this.setC({ fs: p });
        return;
      case 'loch':
        this.st = { ...this.st, loch: true };
        return;
      case 'hich':
      case 'dbch':
      case 'rtlch':
      case 'ltrch':
        if (this.st.loch) this.st = { ...this.st, loch: false };
        return;
      case 'af':
        // Word writes "loch + afN" for the Latin font of a run ("rtlch + afN" is the complex-script font)
        if (this.st.loch && p !== null) this.setC({ f: p });
        return;
      case 'cs':
        this.setC({ cs: p ?? 0 });
        return;
      case 'v':
        this.setC({ hidden: on });
        return;
      case 'deleted':
        this.setC({ hidden: on });
        return;

      /* document */
      case 'ansicpg':
        if (p) this.ansicp = p;
        return;
      case 'mac':
        this.ansicp = 10000;
        return;
      case 'pc':
        this.ansicp = 437;
        return;
      case 'pca':
        this.ansicp = 850;
        return;
      case 'deff':
        this.deff = p ?? 0;
        this.defC = { ...this.defC, f: this.deff };
        this.setC({ f: this.deff });
        return;
      case 'paperw':
        this.paper.w = p ?? undefined;
        return;
      case 'paperh':
        this.paper.h = p ?? undefined;
        return;
      case 'margl':
        this.paper.l = p ?? undefined;
        return;
      case 'margr':
        this.paper.r = p ?? undefined;
        return;
      case 'margt':
        this.paper.t = p ?? undefined;
        return;
      case 'margb':
        this.paper.b = p ?? undefined;
        return;
      case 'landscape':
        this.paper.landscape = true;
        return;
      case 'headery':
        this.paper.headery = p ?? undefined;
        return;
      case 'footery':
        this.paper.footery = p ?? undefined;
        return;
      case 'facingp':
        this.paper.facingp = true;
        return;
      case 'titlepg':
        this.paper.titlepg = true;
        return;
    }
  }

  /* ── tables in the header ── */

  private parseFontTable(g: GroupNode): void {
    let num: number | null = null;
    let cp: number | null = null;
    let name: number[] = [];
    const commit = () => {
      if (num !== null) {
        const text = decoderFor(cp || this.ansicp).decode(Uint8Array.from(name)).trim();
        this.fonts.set(num, { name: text, cp });
      }
      num = null;
      cp = null;
      name = [];
    };
    const walk = (kids: RtfNode[]) => {
      for (const k of kids) {
        if (k.t === T.Group) {
          const f = this.firstCtrl(k);
          if (f && (f.starred || SKIP_DESTINATIONS.has(f.word))) continue;
          walk(k.kids);
          // an entry without a terminating ';' still ends with its group
          if (num !== null && name.length) commit();
        } else if (k.t === T.Ctrl) {
          if (k.w === 'f' && k.p !== null) num = k.p;
          else if (k.w === 'fcharset' && k.p !== null) cp = cp ?? CHARSET_CP[k.p] ?? null;
          else if (k.w === 'cpg' && k.p) cp = k.p;
        } else if (k.t === T.Hex) {
          name.push(k.b);
        } else if (k.t === T.Text) {
          for (let j = k.s; j < k.e; j++) {
            if (this.src[j] === 0x3b /* ; */) commit();
            else name.push(this.src[j]);
          }
        }
      }
    };
    walk(g.kids);
    commit();
  }

  private parseColorTable(g: GroupNode): void {
    let r = -1;
    let gr = -1;
    let b = -1;
    for (const k of g.kids) {
      if (k.t === T.Ctrl) {
        if (k.w === 'red') r = k.p ?? 0;
        else if (k.w === 'green') gr = k.p ?? 0;
        else if (k.w === 'blue') b = k.p ?? 0;
      } else if (k.t === T.Text) {
        for (let j = k.s; j < k.e; j++) {
          if (this.src[j] !== 0x3b) continue;
          if (r < 0 && gr < 0 && b < 0) this.colors.push(null);
          else {
            this.colors.push(
              [r, gr, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join(''),
            );
          }
          r = gr = b = -1;
        }
      }
    }
  }

  private parseStylesheet(g: GroupNode): void {
    for (const k of g.kids) {
      if (k.t !== T.Group) continue;
      let num = 0;
      let type: 's' | 'cs' | 'other' = 's';
      const def: StyleDef = { name: '', kind: '', level: 0, f: null, fs: null, b: false, i: false, cf: null };
      for (const c of k.kids) {
        if (c.t !== T.Ctrl) continue;
        if (c.w === 's') num = c.p ?? 0;
        else if (c.w === 'cs') {
          type = 'cs';
          num = c.p ?? 0;
        } else if (c.w === 'ts' || c.w === 'ds') type = 'other';
        else if (c.w === 'f' && c.p !== null) def.f = c.p;
        else if (c.w === 'fs' && c.p) def.fs = c.p;
        else if (c.w === 'b') def.b = c.p !== 0;
        else if (c.w === 'i') def.i = c.p !== 0;
        else if (c.w === 'cf' && c.p) def.cf = c.p;
      }
      if (type === 'other') continue;
      def.name = this.captureText(k).replace(/;\s*$/, '').trim();
      const n = def.name.toLowerCase();
      const h = /^heading (\d)$/.exec(n);
      if (type === 's') {
        if (h) {
          def.kind = 'heading';
          def.level = Math.min(6, Math.max(1, +h[1]));
        } else if (/^(quote|intense quote|block text|quotations|blockquote)$/.test(n)) def.kind = 'quote';
        else if (/^(html preformatted|preformatted text|source code|code)$/.test(n)) def.kind = 'pre';
        this.paraStyles.set(num, def);
      } else {
        if (/^(html code|source text|source code|code|inline code|verbatim char)$/.test(n)) def.kind = 'code';
        this.charStyles.set(num, def);
      }
    }
  }

  private findTitle(g: GroupNode, depth: number): void {
    if (depth > 4) return;
    for (const k of g.kids) {
      if (k.t !== T.Group) continue;
      const f = this.firstCtrl(k);
      if (!f) continue;
      if (f.word === 'title' && !f.starred) {
        const t = this.captureText(k).trim();
        if (t) this.title = t;
      } else if (f.word === 'upr' || f.word === 'ud') {
        this.findTitle(k, depth + 1);
      }
    }
  }

  private parseListTable(g: GroupNode): void {
    for (const k of g.kids) {
      if (k.t !== T.Group) continue;
      const f = this.firstCtrl(k);
      if (!f || f.word !== 'list') continue;
      let id: number | null = null;
      const nfc: number[] = [];
      for (const c of k.kids) {
        if (c.t === T.Ctrl && c.w === 'listid') id = c.p;
        else if (c.t === T.Group) {
          const lf = this.firstCtrl(c);
          if (lf && lf.word === 'listlevel') {
            let v = 0;
            for (const lc of c.kids) if (lc.t === T.Ctrl && lc.w === 'levelnfc') v = lc.p ?? 0;
            nfc.push(v);
          }
        }
      }
      if (id !== null) this.listDefs.set(id, { nfc });
    }
  }

  private parseListOverrides(g: GroupNode): void {
    for (const k of g.kids) {
      if (k.t !== T.Group) continue;
      let id: number | null = null;
      let ls: number | null = null;
      for (const c of k.kids) {
        if (c.t !== T.Ctrl) continue;
        if (c.w === 'listid') id = c.p;
        else if (c.w === 'ls') ls = c.p;
      }
      if (id !== null && ls !== null) this.listOverrides.set(ls, id);
    }
  }

  /* ── pictures & fields ── */

  private picture(g: GroupNode): void {
    if (this.capture) return;
    let type: 'png' | 'jpeg' | null = null;
    let goalW = 0;
    let goalH = 0;
    let scaleX = 100;
    let scaleY = 100;
    let hexLen = 0;
    let binLen = 0;
    for (const k of g.kids) {
      if (k.t === T.Ctrl) {
        if (k.w === 'pngblip') type = 'png';
        else if (k.w === 'jpegblip') type = 'jpeg';
        else if (k.w === 'picwgoal') goalW = k.p ?? 0;
        else if (k.w === 'pichgoal') goalH = k.p ?? 0;
        else if (k.w === 'picscalex' && k.p) scaleX = k.p;
        else if (k.w === 'picscaley' && k.p) scaleY = k.p;
      } else if (k.t === T.Text) hexLen += k.e - k.s;
      else if (k.t === T.Bin) binLen += k.e - k.s;
    }
    if (!type) return;
    let bytes: Uint8Array;
    if (binLen) {
      bytes = new Uint8Array(binLen);
      let o = 0;
      for (const k of g.kids) {
        if (k.t === T.Bin) {
          bytes.set(this.src.subarray(k.s, k.e), o);
          o += k.e - k.s;
        }
      }
    } else {
      const buf = new Uint8Array(hexLen >> 1);
      let o = 0;
      let hi = -1;
      for (const k of g.kids) {
        if (k.t !== T.Text) continue;
        for (let j = k.s; j < k.e; j++) {
          const v = hexVal(this.src[j]);
          if (v < 0) continue;
          if (hi < 0) hi = v;
          else {
            buf[o++] = hi * 16 + v;
            hi = -1;
          }
        }
      }
      bytes = buf.subarray(0, o);
    }
    if (bytes.length < 8) return;
    const natural = imageSize(bytes);
    let w = goalW ? Math.round((goalW / 15) * (scaleX / 100)) : natural?.width ?? 0;
    let h = goalH ? Math.round((goalH / 15) * (scaleY / 100)) : natural?.height ?? 0;
    if ((!w || !h) && natural) {
      w = natural.width;
      h = natural.height;
    }
    const size = w && h ? ` width="${w}" height="${h}"` : '';
    this.runs.push({
      k: 'img',
      html: `<img src="${toDataUrl(type === 'png' ? 'image/png' : 'image/jpeg', bytes)}"${size} alt="">`,
      link: this.link,
    });
  }

  private field(g: GroupNode): void {
    let inst = '';
    let result: GroupNode | null = null;
    for (const k of g.kids) {
      if (k.t !== T.Group) continue;
      const f = this.firstCtrl(k);
      if (!f) continue;
      if (f.word === 'fldinst') inst += this.captureText(k);
      else if (f.word === 'fldrslt') result = k;
    }
    if (!result) return;
    const url = this.capture ? null : parseHyperlink(inst);
    const saved = this.link;
    if (url) this.link = url;
    try {
      this.group(result);
    } finally {
      this.link = saved;
    }
  }

  /* ── driver ── */

  read(): void {
    const root = tokenize(this.src);
    this.run(root.kids, 0);
    // flush whatever is still open
    if (this.runs.length || this.marker !== null) {
      if (this.rowCells.length || this.cellBlocks.length) this.endCell();
      else this.endPara();
    }
    if (this.rowCells.length || this.cellBlocks.length) this.endRow();
  }

  pageSetup(): PageSetup | undefined {
    const p = this.paper;
    if (p.w === undefined && p.h === undefined && p.l === undefined && p.t === undefined && !p.landscape) return undefined;
    const pt = (v: number | undefined) => (v === undefined ? undefined : v / 20);
    const setup = nearestPageSetup(
      (p.w ?? 12240) / 20,
      (p.h ?? 15840) / 20,
      { top: pt(p.t), right: pt(p.r), bottom: pt(p.b), left: pt(p.l) },
      !!p.landscape && (p.w ?? 0) >= (p.h ?? 0),
    );
    const hd = pt(p.headery);
    const fd = pt(p.footery);
    if (hd !== undefined && Math.round(hd * 100) / 100 !== DEFAULT_HF_DISTANCE) setup.headerDistance = Math.round(hd * 100) / 100;
    if (fd !== undefined && Math.round(fd * 100) / 100 !== DEFAULT_HF_DISTANCE) setup.footerDistance = Math.round(fd * 100) / 100;
    if (p.titlepg) setup.differentFirstPage = true;
    if (p.facingp) setup.differentOddEven = true;
    return setup;
  }

  /** Maps captured RTF header/footer destinations onto RichDocument fields. */
  headerFooterFields(): Pick<RichDocument, 'header' | 'footer' | 'headerFirst' | 'footerFirst' | 'headerEven' | 'footerEven'> {
    const h = this.hfHtml;
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        const v = h[k];
        if (v && v.trim()) return v;
      }
      return undefined;
    };
    return {
      header: pick('header', 'headerr'),
      footer: pick('footer', 'footerr'),
      headerFirst: pick('headerf'),
      footerFirst: pick('footerf'),
      headerEven: pick('headerl'),
      footerEven: pick('footerl'),
    };
  }

  /* ── HTML rendering ── */

  private fontName(index: number): string | null {
    return this.fonts.get(index)?.name || null;
  }

  private docDefaults(): { font: string | null; fs: number } {
    const normal = this.paraStyles.get(0);
    return {
      font: this.fontName(normal?.f ?? this.deff),
      fs: normal?.fs ?? 24,
    };
  }

  private classify(b: ParaBlock): { type: 'h' | 'li' | 'quote' | 'pre' | 'hr' | 'p'; level: number; ordered: boolean } {
    const style = this.paraStyles.get(b.p.s);
    if (b.p.outline >= 0 && b.p.outline <= 8) return { type: 'h', level: Math.min(6, b.p.outline + 1), ordered: false };
    if (style?.kind === 'heading') return { type: 'h', level: style.level, ordered: false };
    const listId = b.p.ls > 0 ? this.listOverrides.get(b.p.ls) : undefined;
    const def = listId !== undefined ? this.listDefs.get(listId) : undefined;
    if (b.marker !== null || def) {
      let ordered: boolean;
      if (def && def.nfc.length) {
        const nfc = def.nfc[Math.min(b.p.ilvl, def.nfc.length - 1)];
        ordered = nfc !== 23 && nfc !== 255;
      } else {
        ordered = /^\s*(\(?\d+|\(?[a-zA-Z]{1,4})[.):]?\s*$/.test(b.marker ?? '');
      }
      const level = b.p.ls > 0 ? b.p.ilvl : Math.round(b.p.li / 720) - 1;
      return { type: 'li', level: Math.max(0, Math.min(8, level)), ordered };
    }
    const empty = !b.runs.some((r) => r.k !== 't' || r.text.trim() !== '');
    if (empty && b.p.border) return { type: 'hr', level: 0, ordered: false };
    if (style?.kind === 'quote') return { type: 'quote', level: 0, ordered: false };
    if (style?.kind === 'pre') return { type: 'pre', level: 0, ordered: false };
    return { type: 'p', level: 0, ordered: false };
  }

  private runsHtml(b: ParaBlock, heading: number): string {
    const defaults = this.docDefaults();
    const style = this.paraStyles.get(b.p.s);
    const out: InlineRun[] = [];
    for (const r of b.runs) {
      if (r.k === 'br') out.push({ html: '<br>', link: r.link });
      else if (r.k === 'img') out.push({ html: r.html, link: r.link });
      else {
        const c = r.c;
        const fmt: InlineFmt = {
          bold: c.b,
          italic: c.i,
          underline: c.ul,
          strike: c.strike,
          vert: c.vert,
          color: this.colors[c.cf] ?? null,
          highlight: this.colors[c.hl] ?? this.colors[c.cb] ?? null,
          font: this.fontName(c.f),
          size: c.fs / 2,
          code: this.charStyles.get(c.cs)?.kind === 'code',
        };
        if (fmt.highlight === 'ffffff' && !c.hl) fmt.highlight = null;
        if (fmt.font && defaults.font && fmt.font.toLowerCase() === defaults.font.toLowerCase()) fmt.font = null;
        if (c.fs === defaults.fs) fmt.size = null;
        if (heading) {
          // headings are bold/large by nature: keep only what deviates from the heading style
          fmt.bold = false;
          if (style?.kind === 'heading') {
            if (style.i) fmt.italic = false;
            if (style.fs && c.fs === style.fs) fmt.size = null;
            if (style.f !== null && c.f === style.f) fmt.font = null;
            if (style.cf && c.cf === style.cf) fmt.color = null;
          }
          if (c.fs === HEADING_HP[heading - 1]) fmt.size = null;
        }
        out.push({ text: r.text, fmt, link: r.link });
      }
    }
    return renderInlineRuns(out);
  }

  private paraHtml(b: ParaBlock, tag: string, heading = 0): string {
    const align = b.p.align ? ` style="text-align: ${b.p.align}"` : '';
    return `<${tag}${align}>${this.runsHtml(b, heading)}</${tag}>`;
  }

  private leadingBreak(b: Block | undefined): boolean {
    if (!b) return false;
    if (b.t === 'p') return b.p.pagebb;
    if (b.t === 'table') return this.leadingBreak(b.rows[0]?.cells[0]?.[0]);
    return false;
  }

  render(blocks: Block[] = this.blocks, top = true): string {
    let html = '';
    let i = 0;
    while (i < blocks.length) {
      const b = blocks[i];
      if (b.t === 'break') {
        if (top) html += PAGE_BREAK_HTML;
        i++;
        continue;
      }
      if (top && html && this.leadingBreak(b)) html += PAGE_BREAK_HTML;
      if (b.t === 'table') {
        html += this.tableHtml(b);
        i++;
        continue;
      }
      const cls = this.classify(b);
      switch (cls.type) {
        case 'h':
          html += this.paraHtml(b, `h${cls.level}`, cls.level);
          i++;
          break;
        case 'hr':
          html += '<hr>';
          i++;
          break;
        case 'li': {
          const items: Array<{ level: number; ordered: boolean; ls: number; html: string; marker: string | null }> = [];
          for (; i < blocks.length; i++) {
            const n = blocks[i];
            if (n.t !== 'p') break;
            const c = this.classify(n);
            if (c.type !== 'li') break;
            items.push({ level: c.level, ordered: c.ordered, ls: n.p.ls, html: this.paraHtml(n, 'p'), marker: n.marker });
          }
          html += listHtml(items);
          break;
        }
        case 'quote': {
          html += '<blockquote>';
          for (; i < blocks.length; i++) {
            const n = blocks[i];
            if (n.t !== 'p' || this.classify(n).type !== 'quote') break;
            html += this.paraHtml(n, 'p');
          }
          html += '</blockquote>';
          break;
        }
        case 'pre': {
          const lines: string[] = [];
          for (; i < blocks.length; i++) {
            const n = blocks[i];
            if (n.t !== 'p' || this.classify(n).type !== 'pre') break;
            lines.push(n.runs.map((r) => (r.k === 't' ? r.text : r.k === 'br' ? '\n' : '')).join(''));
          }
          html += `<pre><code>${escapeHtml(lines.join('\n'))}</code></pre>`;
          break;
        }
        default:
          html += this.paraHtml(b, 'p');
          i++;
      }
    }
    return html;
  }

  private tableHtml(t: TableBlock): string {
    const TOL = 20;
    const edges: number[] = [];
    const all = t.rows.flatMap((r) => r.defs.map((d) => d.x)).sort((a, b) => a - b);
    for (const x of all) if (!edges.length || x - edges[edges.length - 1] > TOL) edges.push(x);
    const colOf = (x: number) => {
      // number of grid edges at or left of x
      let n = 0;
      for (const e of edges) if (e <= x + TOL) n++;
      return n;
    };
    interface Out {
      html: string;
      colspan: number;
      rowspan: number;
      header: boolean;
    }
    const open = new Map<number, Out>();
    const rowsOut: Out[][] = [];
    for (const row of t.rows) {
      const outRow: Out[] = [];
      let prevCol = 0;
      let lastCell: Out | null = null;
      row.cells.forEach((cell, ci) => {
        const def = row.defs[ci];
        const endCol = def ? Math.max(prevCol + 1, colOf(def.x)) : prevCol + 1;
        const startCol = prevCol;
        prevCol = endCol;
        if (def?.mrg && lastCell) {
          lastCell.colspan += endCol - startCol;
          return;
        }
        if (def?.vmrg) {
          const above = open.get(startCol);
          if (above) {
            above.rowspan++;
            return;
          }
        }
        const out: Out = {
          html: this.render(cell, false) || '<p></p>',
          colspan: endCol - startCol,
          rowspan: 1,
          header: row.header,
        };
        if (def?.vmgf) open.set(startCol, out);
        else open.delete(startCol);
        outRow.push(out);
        lastCell = out;
      });
      rowsOut.push(outRow);
    }
    let html = '<table><tbody>';
    for (const row of rowsOut) {
      html += '<tr>';
      for (const c of row) {
        const tag = c.header ? 'th' : 'td';
        html += `<${tag}${c.colspan > 1 ? ` colspan="${c.colspan}"` : ''}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ''}>${c.html}</${tag}>`;
      }
      html += '</tr>';
    }
    return `${html}</tbody></table>`;
  }
}

/** Builds nested <ul>/<ol> markup from a flat list of items with levels. */
function listHtml(
  items: Array<{ level: number; ordered: boolean; ls: number; html: string; marker: string | null }>,
): string {
  let out = '';
  const stack: Array<{ ordered: boolean; ls: number }> = [];
  const openList = (it: (typeof items)[number]) => {
    let attrs = '';
    if (it.ordered) {
      const m = /^\s*\(?(\d+)/.exec(it.marker ?? '');
      if (m && +m[1] > 1) attrs = ` start="${+m[1]}"`;
    }
    out += it.ordered ? `<ol${attrs}>` : '<ul>';
    stack.push({ ordered: it.ordered, ls: it.ls });
  };
  const closeList = () => {
    const top = stack.pop()!;
    out += `</li>${top.ordered ? '</ol>' : '</ul>'}`;
  };
  for (const it of items) {
    const level = Math.min(it.level, stack.length);
    while (stack.length > level + 1) closeList();
    if (stack.length === level + 1) {
      const top = stack[stack.length - 1];
      if (top.ordered !== it.ordered || (it.ordered && top.ls && it.ls && top.ls !== it.ls)) {
        closeList();
        openList(it);
      } else {
        out += '</li>';
      }
    } else {
      openList(it);
    }
    out += `<li>${it.html}`;
  }
  while (stack.length) closeList();
  return out;
}

/** Extracts the target of a HYPERLINK field instruction; null for other fields. */
export function parseHyperlink(instruction: string): string | null {
  const m = /^\s*HYPERLINK\b(.*)$/is.exec(instruction);
  if (!m) return null;
  const args: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let t: RegExpExecArray | null;
  while ((t = re.exec(m[1]))) args.push(t[1] !== undefined ? `"${t[1]}` : t[2]);
  let url = '';
  let anchor = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^\\[lL]$/.test(a)) {
      anchor = (args[++i] ?? '').replace(/^"/, '');
    } else if (/^\\[otmOTM]$/.test(a)) {
      i++;
    } else if (/^\\/.test(a)) {
      continue;
    } else if (!url) {
      url = a.replace(/^"/, '').replace(/\\\\/g, '\\');
    }
  }
  const full = url + (anchor ? `#${anchor}` : '');
  return full || null;
}

export const importRtf: Importer = async (bytes) => {
  let start = 0;
  // tolerate a BOM / leading whitespace before "{\rtf"
  while (start < bytes.length && start < 16 && bytes[start] !== 0x7b) start++;
  const head = String.fromCharCode(...bytes.subarray(start, start + 5));
  if (head !== '{\\rtf') throw new Error('Not an RTF document.');
  const reader = new RtfReader(start ? bytes.subarray(start) : bytes);
  reader.read();
  const html = reader.render();
  const hf = reader.headerFooterFields();
  return {
    html: html || '<p></p>',
    title: reader.title,
    pageSetup: reader.pageSetup(),
    ...hf,
  };
};
