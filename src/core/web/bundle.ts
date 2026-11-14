/**
 * Turns a web page and everything it references in its folder into one self-contained HTML
 * document, for the code editor's preview.
 *
 * The preview frame is sandboxed and offline: it cannot read the folder and it never fetches
 * from the network. So every reference is resolved here instead, through `read`:
 *  - stylesheets are inlined (with their @imports), and url(…) inside CSS becomes a data: URL;
 *  - classic scripts are inlined;
 *  - ES modules (static imports, re-exports and import('literal')) are collected into a graph.
 *    A small bootstrap in the page holds each module's source with placeholder tokens where its
 *    resolvable specifiers were and, in dependency order, turns them into blob: URLs created
 *    inside the frame, then writes the entry <script type="module"> tags;
 *  - images, fonts, media, icons and srcset candidates become data: URLs.
 * What can't be resolved (a missing file, a remote URL, a bare module specifier, a file that
 * needs a build step) is left as written and reported in `warnings`.
 *
 * Needs a DOMParser (the browser, the Electron renderer, jsdom in tests).
 */
import { needsBuildStep } from '../code/languages';
import { dirOf, referenceKind, resolveReference } from './paths';

export type ReadFile = (path: string) => Promise<Uint8Array | string | null>;

export type WarningReason = 'missing' | 'remote' | 'bare' | 'build' | 'cycle' | 'large';

export interface BundleWarning {
  /** the reference as written in the source */
  ref: string;
  /** the file it was found in */
  from: string;
  reason: WarningReason;
}

export interface BundleResult {
  html: string;
  warnings: BundleWarning[];
  /** every folder file that went into the document (the entry first) */
  files: string[];
}

export interface BundleOptions {
  /** Adds the script that reports clicks on links to other pages to the parent window. Default true. */
  interceptLinks?: boolean;
}

/** One asset larger than this is left out (a data: URL of it would make the page unusable). */
const MAX_ASSET_BYTES = 24 * 1024 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const MAX_FRAME_DEPTH = 2;

export const WARNING_TEXT: Record<WarningReason, string> = {
  missing: 'not found in the folder',
  remote: 'online resource (the preview is offline)',
  bare: 'package import (needs a bundler)',
  build: 'needs a build step to run in a browser',
  cycle: 'modules import each other in a circle',
  large: 'too large to preview',
};

const MIME: Record<string, string> = {
  png: 'image/png', apng: 'image/apng', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', cur: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', opus: 'audio/ogg',
  vtt: 'text/vtt', json: 'application/json', txt: 'text/plain', xml: 'application/xml', pdf: 'application/pdf',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', html: 'text/html', htm: 'text/html', wasm: 'application/wasm',
};

function extOf(path: string): string {
  return (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? '').toLowerCase();
}

export function mimeOf(path: string): string {
  return MIME[extOf(path)] ?? 'application/octet-stream';
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Makes source text safe inside an inline <script>: the parser ends the element at "</script". */
function escapeInlineScript(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

async function replaceAsync(text: string, pattern: RegExp, fn: (m: RegExpExecArray) => Promise<string>): Promise<string> {
  const parts: (string | Promise<string>)[] = [];
  let last = 0;
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    parts.push(text.slice(last, m.index), fn(m));
    last = m.index + m[0].length;
    if (m[0] === '') pattern.lastIndex++;
  }
  parts.push(text.slice(last));
  return (await Promise.all(parts)).join('');
}

interface ModuleImport {
  /** where the specifier's text (between the quotes) sits in the source */
  start: number;
  end: number;
  target: string;
}

interface ModuleRecord {
  id: number;
  path: string;
  code: string;
  imports: ModuleImport[];
}

const STATIC_IMPORT = /(?:^|[;\n\r}])\s*(?:import\s*(?:[\w$*{},\s]+?\s*from\s*)?|export\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*)(["'])([^"'\n]+)\1/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;

/** The entry page's link interceptor: relative links re-bundle the target page in the editor. */
function linkInterceptor(entry: string): string {
  return `(function(){document.addEventListener('click',function(e){var t=e.target;var a=t&&t.closest?t.closest('a[href],area[href]'):null;if(!a)return;var h=a.getAttribute('href')||'';if(!h||h.charAt(0)==='#'||/^(javascript|data|blob|mailto|tel):/i.test(h))return;e.preventDefault();try{parent.postMessage({__fePreview:'navigate',href:h,from:${JSON.stringify(entry)}},'*')}catch(_){}} ,true)})();`;
}

class Bundler {
  readonly warnings: BundleWarning[] = [];
  readonly files = new Set<string>();
  private readonly cache = new Map<string, Promise<Uint8Array | string | null>>();
  private readonly dataUrls = new Map<string, Promise<string | null>>();
  private total = 0;
  private readonly modules = new Map<string, ModuleRecord>();
  private readonly moduleLoads = new Map<string, Promise<ModuleRecord | null>>();
  private pending: Promise<unknown>[] = [];

  /** Waits until every module reached from the entries has been read. */
  async settle(): Promise<void> {
    while (this.pending.length) await Promise.all(this.pending.splice(0));
  }

  constructor(private readonly read: ReadFile) {}

  warn(ref: string, from: string, reason: WarningReason) {
    if (!this.warnings.some((w) => w.ref === ref && w.from === from && w.reason === reason)) this.warnings.push({ ref, from, reason });
  }

  private load(path: string): Promise<Uint8Array | string | null> {
    let p = this.cache.get(path);
    if (!p) {
      p = this.read(path).then(
        (v) => {
          if (v !== null) this.files.add(path);
          return v;
        },
        () => null,
      );
      this.cache.set(path, p);
    }
    return p;
  }

  async text(path: string): Promise<string | null> {
    const v = await this.load(path);
    if (v === null) return null;
    if (typeof v === 'string') return v;
    const text = new TextDecoder('utf-8').decode(v);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  async bytes(path: string): Promise<Uint8Array | null> {
    const v = await this.load(path);
    if (v === null) return null;
    return typeof v === 'string' ? new TextEncoder().encode(v) : v;
  }

  /**
   * Resolves `ref` (found in `from`) to a file in the folder. Returns null — after recording
   * why — when it is remote or leaves the folder, and undefined when it is not a file
   * reference at all (data:, #fragment, mailto:…) and should be left alone.
   */
  resolve(ref: string, from: string): string | null | undefined {
    const kind = referenceKind(ref);
    if (kind === 'inline') return undefined;
    if (kind === 'remote') {
      this.warn(ref, from, 'remote');
      return null;
    }
    const path = resolveReference(from, ref);
    if (!path) this.warn(ref, from, 'missing');
    return path;
  }

  /** A data: URL of a folder file, or null (recorded) when it can't be embedded. */
  async asset(ref: string, from: string): Promise<string | null> {
    const path = this.resolve(ref, from);
    if (!path) return null;
    let p = this.dataUrls.get(path);
    if (!p) {
      p = (async () => {
        if (extOf(path) === 'css') {
          const css = await this.text(path);
          return css === null ? null : `data:text/css;base64,${toBase64(new TextEncoder().encode(await this.css(css, path, new Set([path]))))}`;
        }
        const bytes = await this.bytes(path);
        if (!bytes) return null;
        if (bytes.length > MAX_ASSET_BYTES || this.total + bytes.length > MAX_TOTAL_BYTES) return 'large';
        this.total += bytes.length;
        return `data:${mimeOf(path)};base64,${toBase64(bytes)}`;
      })();
      this.dataUrls.set(path, p);
    }
    const url = await p;
    if (url === null) this.warn(ref, from, 'missing');
    else if (url === 'large') this.warn(ref, from, 'large');
    else return url + (/#/.test(ref) && extOf(path) === 'svg' ? ref.slice(ref.indexOf('#')) : '');
    return null;
  }

  /** Inlines @imports and embeds url(…) references of a stylesheet that lives at `from`. */
  async css(source: string, from: string, seen: Set<string>): Promise<string> {
    const imported = await replaceAsync(
      source,
      /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*([^;]*);?/g,
      async (m) => {
        const ref = (m[2] ?? m[4]).trim();
        const media = m[5].trim();
        const path = this.resolve(ref, from);
        if (!path) return path === undefined ? m[0] : `/* ${ref}: not loaded */`;
        if (seen.has(path)) return '';
        if (needsBuildStep(path)) {
          this.warn(ref, from, 'build');
          return `/* ${ref}: needs a build step */`;
        }
        const text = await this.text(path);
        if (text === null) {
          this.warn(ref, from, 'missing');
          return `/* ${ref}: not found */`;
        }
        const inner = await this.css(text, path, new Set([...seen, path]));
        return media ? `@media ${media} {\n${inner}\n}` : inner;
      },
    );
    return replaceAsync(imported, /url\(\s*(['"]?)([^'")]*)\1\s*\)/g, async (m) => {
      const ref = m[2].trim();
      if (!ref) return m[0];
      const url = await this.asset(ref, from);
      return url ? `url("${url}")` : m[0];
    });
  }

  /** "a.png 1x, b.png 2x" with every candidate embedded. */
  async srcset(value: string, from: string): Promise<string> {
    const out: string[] = [];
    for (const candidate of value.split(',')) {
      const [ref, ...descriptor] = candidate.trim().split(/\s+/);
      if (!ref) continue;
      const url = await this.asset(ref, from);
      out.push([url ?? ref, ...descriptor].join(' '));
    }
    return out.join(', ');
  }

  // ── ES modules ───────────────────────────────────────────────────────────

  /** The file a module specifier names: as written, then with .js / .mjs, then as a folder with an index. */
  private async findModule(spec: string, from: string): Promise<string | null> {
    const base = resolveReference(from, spec);
    if (!base) return null;
    const candidates = extOf(base) ? [base] : [base, `${base}.js`, `${base}.mjs`, `${base}/index.js`, `${base}/index.mjs`];
    for (const c of candidates) if ((await this.load(c)) !== null) return c;
    for (const ext of ['ts', 'tsx', 'jsx']) {
      if (!extOf(base) && (await this.load(`${base}.${ext}`)) !== null) return `${base}.${ext}`;
    }
    return null;
  }

  /** Reads a module and, recursively, what it imports. `code` is given for an inline <script type="module">. */
  module(path: string, code?: string): Promise<ModuleRecord | null> {
    let p = this.moduleLoads.get(path);
    if (!p) {
      p = (async () => {
        const source = code ?? (await this.text(path));
        if (source === null) return null;
        const rec: ModuleRecord = { id: this.modules.size, path, code: source, imports: [] };
        this.modules.set(path, rec);
        const found: { start: number; end: number; spec: string }[] = [];
        for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
          pattern.lastIndex = 0;
          for (let m = pattern.exec(source); m; m = pattern.exec(source)) {
            const spec = m[2];
            const start = m.index + m[0].lastIndexOf(m[1] + spec + m[1]) + 1;
            const end = start + spec.length;
            if (source.slice(start, end) === spec && !found.some((f) => f.start === start)) found.push({ start, end, spec });
          }
        }
        // the file a module lives in, for resolving what it imports (an inline module: the page)
        const from = path.replace(/#inline-\d+$/, '');
        await Promise.all(
          found.map(async ({ start, end, spec }) => {
            const kind = referenceKind(spec);
            if (kind === 'remote') return this.warn(spec, from, 'remote');
            if (kind === 'inline') return;
            if (!/^(\.{1,2})?\//.test(spec)) return this.warn(spec, from, 'bare');
            const target = await this.findModule(spec, from);
            if (!target) return this.warn(spec, from, 'missing');
            if (needsBuildStep(target) || !['js', 'mjs', 'cjs'].includes(extOf(target))) return this.warn(spec, from, 'build');
            rec.imports.push({ start, end, target });
            // not awaited: two modules that import each other would wait on one another for ever
            this.pending.push(this.module(target));
          }),
        );
        rec.imports.sort((a, b) => a.start - b.start);
        return rec;
      })();
      this.moduleLoads.set(path, p);
    }
    return p;
  }

  /**
   * The bootstrap <script> source for the page's entry modules, or null when it has none.
   * Modules are listed dependencies-first; an import that closes a circle is left as written.
   */
  moduleBootstrap(entries: string[]): string | null {
    const ordered: ModuleRecord[] = [];
    const state = new Map<string, 'open' | 'done'>();
    const cut = new Set<string>();
    const visit = (path: string) => {
      const rec = this.modules.get(path);
      if (!rec || state.get(path) === 'done') return;
      state.set(path, 'open');
      for (const imp of rec.imports) {
        if (state.get(imp.target) === 'open') {
          cut.add(`${path}\n${imp.start}`);
          this.warn(rec.code.slice(imp.start, imp.end), path.replace(/#inline-\d+$/, ''), 'cycle');
        } else visit(imp.target);
      }
      state.set(path, 'done');
      ordered.push(rec);
    };
    entries.forEach(visit);
    if (!ordered.length) return null;
    const list = ordered.map((rec) => {
      let code = '';
      let last = 0;
      for (const imp of rec.imports) {
        if (cut.has(`${rec.path}\n${imp.start}`)) continue;
        code += rec.code.slice(last, imp.start) + `__FE_MOD_${this.modules.get(imp.target)!.id}__`;
        last = imp.end;
      }
      return [rec.id, code + rec.code.slice(last)];
    });
    const entryIds = entries.map((e) => this.modules.get(e)?.id).filter((id): id is number => id !== undefined);
    // document.write keeps the entry modules parser-inserted, so they run deferred and in order,
    // before DOMContentLoaded, exactly as <script type="module" src> would
    const js =
      `(function(){var M=${JSON.stringify(list)},E=${JSON.stringify(entryIds)},U={};` +
      `for(var i=0;i<M.length;i++){var c=M[i][1].replace(/__FE_MOD_(\\d+)__/g,function(t,n){return U[n]||t});` +
      `U[M[i][0]]=URL.createObjectURL(new Blob([c],{type:'text/javascript'}))}` +
      `for(var j=0;j<E.length;j++)document.write('<script type="module" src="'+U[E[j]]+'"><\\/script>')})();`;
    // U+2028 / U+2029 end a line in older script parsers: keep them as escapes
    return escapeInlineScript(js.split(String.fromCharCode(0x2028)).join('\u2028').split(String.fromCharCode(0x2029)).join('\u2029'));
  }
}

function isModuleScript(el: Element): boolean {
  return (el.getAttribute('type') ?? '').trim().toLowerCase() === 'module';
}

function isClassicScript(el: Element): boolean {
  const type = (el.getAttribute('type') ?? '').trim().toLowerCase();
  return type === '' || type === 'text/javascript' || type === 'application/javascript' || type === 'text/ecmascript' || type === 'application/ecmascript';
}

async function bundlePage(b: Bundler, entry: string, source: string, options: BundleOptions, depth: number): Promise<string> {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const all = (selector: string): Element[] => {
    try {
      return Array.from(doc.querySelectorAll(selector));
    } catch {
      return []; // a selector this DOM implementation does not know
    }
  };

  // a <base> would change what every relative reference means; a page CSP would block what is inlined here
  for (const el of all('base, meta[http-equiv="Content-Security-Policy" i]')) el.remove();

  // ── stylesheets ──
  await Promise.all(
    all('link[href]').map(async (link) => {
      const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
      const href = link.getAttribute('href') ?? '';
      if (rel.includes('stylesheet')) {
        const path = b.resolve(href, entry);
        if (!path) return;
        if (needsBuildStep(path)) return b.warn(href, entry, 'build');
        const css = await b.text(path);
        if (css === null) return b.warn(href, entry, 'missing');
        const style = doc.createElement('style');
        const media = link.getAttribute('media');
        if (media) style.setAttribute('media', media);
        style.setAttribute('data-href', href);
        style.textContent = await b.css(css, path, new Set([path]));
        link.replaceWith(style);
      } else if (rel.some((r) => r === 'icon' || r === 'apple-touch-icon' || r === 'mask-icon' || r === 'preload' || r === 'modulepreload')) {
        if (rel.includes('modulepreload') || (rel.includes('preload') && link.getAttribute('as') === 'script')) return link.remove();
        const url = await b.asset(href, entry);
        if (url) link.setAttribute('href', url);
      }
    }),
  );
  await Promise.all(
    all('style').map(async (style) => {
      if (style.hasAttribute('data-href')) return;
      style.textContent = await b.css(style.textContent ?? '', entry, new Set());
    }),
  );
  await Promise.all(
    all('[style]')
      .filter((el) => (el.getAttribute('style') ?? '').includes('url('))
      .map(async (el) => {
      el.setAttribute('style', await b.css(el.getAttribute('style') ?? '', entry, new Set()));
    }),
  );

  // ── scripts ──
  const entries: string[] = [];
  let firstModule: Element | null = null;
  let inline = 0;
  for (const script of all('script')) {
    const src = script.getAttribute('src');
    if (isModuleScript(script)) {
      let key: string | null = null;
      if (src !== null) {
        const kind = referenceKind(src);
        if (kind === 'remote') b.warn(src, entry, 'remote');
        else if (kind === 'relative') {
          const path = resolveReference(entry, src);
          if (!path || (await b.text(path)) === null) b.warn(src, entry, 'missing');
          else if (needsBuildStep(path)) b.warn(src, entry, 'build');
          else if (await b.module(path)) key = path;
        }
      } else {
        key = `${entry}#inline-${inline++}`;
        await b.module(key, script.textContent ?? '');
      }
      if (key === null) continue;
      entries.push(key);
      if (firstModule) script.remove();
      else firstModule = script;
      continue;
    }
    if (src === null || !isClassicScript(script)) continue;
    const path = b.resolve(src, entry);
    if (!path) continue;
    if (needsBuildStep(path)) {
      b.warn(src, entry, 'build');
      continue;
    }
    const code = await b.text(path);
    if (code === null) {
      b.warn(src, entry, 'missing');
      continue;
    }
    script.removeAttribute('src');
    script.setAttribute('data-src', src);
    script.textContent = escapeInlineScript(code);
  }
  await b.settle();
  const bootstrap = b.moduleBootstrap(entries);
  if (firstModule && bootstrap) {
    const boot = doc.createElement('script');
    boot.textContent = bootstrap;
    firstModule.replaceWith(boot);
  }

  // ── images, media, icons ──
  const attr = async (selector: string, name: string) => {
    await Promise.all(
      all(selector).map(async (el) => {
        const ref = el.getAttribute(name);
        if (!ref) return;
        const url = await b.asset(ref, entry);
        if (url) el.setAttribute(name, url);
      }),
    );
  };
  await attr('img[src], source[src], video[src], audio[src], track[src], embed[src], input[type="image" i][src]', 'src');
  await attr('video[poster]', 'poster');
  await attr('object[data]', 'data');
  await attr('image[href], feImage[href]', 'href');
  await attr('image[xlink\\:href]', 'xlink:href');
  await Promise.all(
    all('img[srcset], source[srcset]').map(async (el) => {
      el.setAttribute('srcset', await b.srcset(el.getAttribute('srcset') ?? '', entry));
    }),
  );
  // <use href="sprite.svg#icon"> can only point into its own document: report it
  for (const use of all('use')) {
    const ref = use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '';
    if (ref && !ref.startsWith('#') && referenceKind(ref) === 'relative') b.warn(ref, entry, 'missing');
  }

  // ── nested pages ──
  await Promise.all(
    all('iframe[src]').map(async (frame) => {
      const ref = frame.getAttribute('src') ?? '';
      const path = b.resolve(ref, entry);
      if (!path) return;
      const inner = depth < MAX_FRAME_DEPTH ? await b.text(path) : null;
      if (inner === null) return b.warn(ref, entry, 'missing');
      frame.removeAttribute('src');
      frame.setAttribute('srcdoc', await bundlePage(b, path, inner, { interceptLinks: false }, depth + 1));
    }),
  );

  if (options.interceptLinks !== false) {
    const hook = doc.createElement('script');
    hook.textContent = linkInterceptor(entry);
    (doc.head ?? doc.documentElement).prepend(hook);
  }
  const doctype = /^\s*<!doctype/i.test(source) ?'<!DOCTYPE html>\n' : '';
  return doctype + doc.documentElement.outerHTML;
}

/** Bundles the page at `entry` (a folder-relative path) into one HTML document. */
export async function bundleHtml(entry: string, read: ReadFile, options: BundleOptions = {}): Promise<BundleResult> {
  const b = new Bundler(read);
  const source = await b.text(entry);
  if (source === null) throw new Error(`${entry} could not be read.`);
  const html = await bundlePage(b, entry, source, options, 0);
  return { html, warnings: b.warnings, files: [entry, ...[...b.files].filter((f) => f !== entry)] };
}

/**
 * The page a stylesheet or script should be previewed in: the nearest index.html, walking up
 * from the file's own directory to the folder root, else the first page that exists.
 */
export function nearestPage(path: string, pages: string[]): string | null {
  for (let dir = dirOf(path); ; dir = dirOf(dir)) {
    for (const name of ['index.html', 'index.htm']) {
      const candidate = dir ? `${dir}/${name}` : name;
      if (pages.includes(candidate)) return candidate;
    }
    if (!dir) break;
  }
  return pages[0] ?? null;
}
