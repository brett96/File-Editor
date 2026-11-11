/**
 * OpenDocument Text (.odt) import / export.
 *
 * Export writes a minimal but complete ODF 1.2 package (mimetype stored first, manifest,
 * content/styles/meta, Pictures/*) with automatic styles generated for every paragraph /
 * text formatting combination the document uses. LibreOffice and Microsoft Word open it.
 *
 * Import reads content.xml + styles.xml (+ meta.xml), resolves automatic and named style
 * inheritance and emits contract HTML (see ../types.ts).
 *
 * Runs in the browser and in Node: no Buffer, no fs.
 */
import JSZip from 'jszip';
import {
  cssColorToHex,
  cssLengthToPt,
  escapeXml,
  imageSize,
  parseDataUrl,
  parseHtml,
  parseStyle,
  parseXml,
  primaryFontFamily,
  toDataUrl,
} from '../dom';
import { DEFAULT_PAGE_SETUP, pageDimensions, UnsupportedError, type Exporter, type Importer, type PageSetup } from '../types';
import { nearestPageSetup, PAGE_BREAK_HTML, renderInlineRuns, type InlineFmt, type InlineRun } from './rtf';

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  dc: 'http://purl.org/dc/elements/1.1/',
  meta: 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
} as const;

const ODT_MIME = 'application/vnd.oasis.opendocument.text';

const NS_DECLS =
  `xmlns:office="${NS.office}" xmlns:style="${NS.style}" xmlns:text="${NS.text}" xmlns:table="${NS.table}" ` +
  `xmlns:draw="${NS.draw}" xmlns:fo="${NS.fo}" xmlns:xlink="${NS.xlink}" xmlns:dc="${NS.dc}" ` +
  `xmlns:meta="${NS.meta}" xmlns:svg="${NS.svg}"`;

/* ════════════════════════════════════════════════════════════════════════════
 * EXPORT
 * ════════════════════════════════════════════════════════════════════════════ */

const DEFAULT_FONT = 'Calibri';
const MONO_FONT = 'Courier New';
const DEFAULT_PT = 11;
const HEADING_PT = [20, 16, 13, 11, 11, 11];

const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'hr', 'ul', 'ol', 'li', 'table', 'div',
  'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure', 'figcaption', 'dl', 'dt', 'dd',
  'address', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'center', 'details', 'summary', 'fieldset', 'form',
]);
const SKIP_TAGS = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'template', 'colgroup', 'col', 'caption']);

const GENERIC_FONTS: Record<string, string> = {
  monospace: MONO_FONT,
  serif: 'Times New Roman',
  'sans-serif': 'Arial',
  'system-ui': DEFAULT_FONT,
  cursive: 'Comic Sans MS',
  fantasy: 'Impact',
};

interface OFmt {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  vert: '' | 'sub' | 'super';
  color: string | null;
  bg: string | null;
  font: string | null;
  size: number | null;
  code: boolean;
}

const EMPTY_FMT: OFmt = {
  bold: false, italic: false, underline: false, strike: false, vert: '', color: null, bg: null, font: null, size: null, code: false,
};

type ORun = { t: 'text'; text: string; fmt: OFmt; link: string | null } | { t: 'xml'; xml: string; link: string | null };

interface OCtx {
  inTable: boolean;
  quote: number;
  /** paragraph style used for plain paragraphs in this context */
  base: string;
  /** set while inside a <li>: lists cannot contain tables */
  inList: boolean;
}

interface OImage {
  path: string;
  mime: string;
  width: number;
  height: number;
}

interface ListPlan {
  levels: Array<{ ordered: boolean; format: string; start: number }>;
}

const inch = (v: number) => `${+v.toFixed(4)}in`;

function fontFamilyGeneric(name: string): string {
  const n = name.toLowerCase();
  if (/courier|consolas|mono|menlo|lucida console/.test(n)) return 'modern';
  if (/times|georgia|cambria|garamond|palatino|book antiqua/.test(n)) return 'roman';
  if (/comic|script|brush/.test(n)) return 'script';
  if (/arial|calibri|helvetica|verdana|tahoma|segoe|trebuchet|aptos|sans/.test(n)) return 'swiss';
  return 'system';
}

function quoteFamily(name: string): string {
  return /\s/.test(name) ? `'${name}'` : name;
}

class OdtWriter {
  private paraStyles = new Map<string, string>();
  private paraXml: string[] = [];
  private textStyles = new Map<string, string>();
  private textXml: string[] = [];
  private tableXml: string[] = [];
  private listXml: string[] = [];
  private fonts = new Set<string>([DEFAULT_FONT, MONO_FONT]);
  readonly files: Array<{ path: string; mime: string; bytes: Uint8Array }> = [];
  private imagesBySrc = new Map<string, OImage | null>();
  private pendingBreak = false;
  private tableCount = 0;
  private frameCount = 0;
  private readonly contentWidthIn: number;

  constructor(readonly setup: PageSetup) {
    const dims = pageDimensions(setup);
    this.contentWidthIn = Math.max(1, (dims.width - setup.margins.left - setup.margins.right) / 72);
  }

  /* ── styles ── */

  private fontName(name: string): string {
    const n = (GENERIC_FONTS[name.toLowerCase()] ?? name).replace(/["'<>&]/g, '');
    for (const f of this.fonts) if (f.toLowerCase() === n.toLowerCase()) return f;
    this.fonts.add(n);
    return n;
  }

  /** Paragraph style for `parent` with the given extras; consumes a pending page break. */
  private paraStyle(parent: string, align: string, ctx: OCtx, extra = ''): string {
    let props = '';
    if (align) props += ` fo:text-align="${align}" style:justify-single-word="false"`;
    if (this.pendingBreak && !ctx.inTable) {
      props += ' fo:break-before="page"';
      this.pendingBreak = false;
    }
    props += extra;
    if (!props) return parent;
    const key = `${parent}|${props}`;
    let name = this.paraStyles.get(key);
    if (!name) {
      name = `P${this.paraStyles.size + 1}`;
      this.paraStyles.set(key, name);
      this.paraXml.push(
        `<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="${parent}">` +
          `<style:paragraph-properties${props}/></style:style>`,
      );
    }
    return name;
  }

  private textStyle(f: OFmt): string | null {
    let props = '';
    if (f.bold) props += ' fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"';
    if (f.italic) props += ' fo:font-style="italic" style:font-style-asian="italic" style:font-style-complex="italic"';
    if (f.underline) props += ' style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"';
    if (f.strike) props += ' style:text-line-through-style="solid" style:text-line-through-type="single"';
    if (f.vert) props += ` style:text-position="${f.vert} 58%"`;
    if (f.color) props += ` fo:color="#${f.color}"`;
    if (f.bg) props += ` fo:background-color="#${f.bg}"`;
    if (f.font && !f.code) {
      const n = escapeXml(this.fontName(f.font));
      props += ` style:font-name="${n}" style:font-name-asian="${n}" style:font-name-complex="${n}"`;
    }
    if (f.size && !f.code) {
      const s = `${+f.size.toFixed(2)}pt`;
      props += ` fo:font-size="${s}" style:font-size-asian="${s}" style:font-size-complex="${s}"`;
    }
    if (!props) return f.code ? 'Source_20_Text' : null;
    const parent = f.code ? ' style:parent-style-name="Source_20_Text"' : '';
    const key = parent + props;
    let name = this.textStyles.get(key);
    if (!name) {
      name = `T${this.textStyles.size + 1}`;
      this.textStyles.set(key, name);
      this.textXml.push(
        `<style:style style:name="${name}" style:family="text"${parent}><style:text-properties${props}/></style:style>`,
      );
    }
    return name;
  }

  /* ── images ── */

  private image(el: Element): string {
    const src = el.getAttribute('src') ?? '';
    let img = this.imagesBySrc.get(src);
    if (img === undefined) {
      img = null;
      const data = parseDataUrl(src);
      if (data && /^image\/(png|jpe?g|gif|bmp|webp)$/i.test(data.mime)) {
        const ext = data.mime.split('/')[1].toLowerCase().replace('jpeg', 'jpg');
        const path = `Pictures/image${this.files.length + 1}.${ext}`;
        const size = imageSize(data.bytes);
        this.files.push({ path, mime: data.mime.toLowerCase(), bytes: data.bytes });
        img = { path, mime: data.mime, width: size?.width || 100, height: size?.height || 100 };
      }
      this.imagesBySrc.set(src, img);
    }
    const alt = el.getAttribute('alt') ?? '';
    if (!img) return alt ? escapeXml(`[image: ${alt}]`) : '';
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
    let wi = w! / 96;
    let hi = h! / 96;
    if (wi > this.contentWidthIn) {
      hi = (hi * this.contentWidthIn) / wi;
      wi = this.contentWidthIn;
    }
    this.frameCount++;
    return (
      `<draw:frame draw:style-name="fr1" draw:name="Image${this.frameCount}" text:anchor-type="as-char" ` +
      `svg:width="${inch(wi)}" svg:height="${inch(hi)}" draw:z-index="0">` +
      `<draw:image xlink:href="${img.path}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>` +
      (alt ? `<svg:title>${escapeXml(alt)}</svg:title>` : '') +
      `</draw:frame>`
    );
  }

  /* ── inline ── */

  private styleFmt(el: Element, f: OFmt): OFmt {
    const st = parseStyle(el);
    const color = cssColorToHex(st['color']);
    if (color) f.color = color;
    const bg = cssColorToHex(st['background-color'] ?? st['background']);
    if (bg) f.bg = bg;
    const fam = primaryFontFamily(st['font-family']);
    if (fam) f.font = fam;
    const size = cssLengthToPt(st['font-size']);
    if (size && size > 0) f.size = Math.round(size * 2) / 2;
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

  private collect(node: Node, fmt: OFmt, link: string | null, out: ORun[]): void {
    if (node.nodeType === 3) {
      const text = (node.nodeValue ?? '').replace(/[ \t\n\r\f]+/g, ' ');
      if (text) out.push({ t: 'text', text, fmt, link });
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === 'br') {
      out.push({ t: 'xml', xml: '<text:line-break/>', link });
      return;
    }
    if (tag === 'img') {
      const xml = this.image(el);
      if (xml) out.push({ t: 'xml', xml, link });
      return;
    }
    const f = this.styleFmt(el, { ...fmt });
    let l = link;
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
        break;
      case 'mark':
        f.bg = cssColorToHex(el.getAttribute('data-color')) ?? f.bg ?? 'ffff00';
        break;
      case 'a': {
        const href = el.getAttribute('href');
        if (href) l = href;
        break;
      }
    }
    for (const child of Array.from(el.childNodes)) this.collect(child, f, l, out);
  }

  /** Converts text to ODF character content, encoding significant spaces and tabs. */
  private textXmlOf(text: string, state: { start: boolean }): string {
    let out = '';
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === ' ') {
        let n = 1;
        while (text[i + n] === ' ') n++;
        if (state.start) out += n === 1 ? '<text:s/>' : `<text:s text:c="${n}"/>`;
        else out += ' ' + (n === 1 ? '' : n === 2 ? '<text:s/>' : `<text:s text:c="${n - 1}"/>`);
        i += n;
      } else if (c === '\t') {
        out += '<text:tab/>';
        i++;
      } else if (c === '\n') {
        out += '<text:line-break/>';
        i++;
      } else {
        let j = i;
        while (j < text.length && text[j] !== ' ' && text[j] !== '\t' && text[j] !== '\n') j++;
        out += escapeXml(text.slice(i, j));
        i = j;
      }
      state.start = false;
    }
    return out;
  }

  private runsXml(runs: ORun[]): string {
    // collapse whitespace across run boundaries (HTML semantics) and trim paragraph edges
    let prevSpace = true;
    for (const r of runs) {
      if (r.t !== 'text') {
        prevSpace = r.xml === '<text:line-break/>';
        continue;
      }
      if (prevSpace) r.text = r.text.replace(/^ +/, '');
      if (r.text) prevSpace = r.text.endsWith(' ');
    }
    for (let k = runs.length - 1; k >= 0; k--) {
      const r = runs[k];
      if (r.t !== 'text') break;
      r.text = r.text.replace(/ +$/, '');
      if (r.text) break;
    }
    return this.emitRuns(runs);
  }

  private emitRuns(runs: ORun[]): string {
    const state = { start: true };
    let out = '';
    let i = 0;
    while (i < runs.length) {
      const link = runs[i].link;
      let chunk = '';
      let j = i;
      for (; j < runs.length && runs[j].link === link; j++) {
        const r = runs[j];
        if (r.t === 'xml') {
          chunk += r.xml;
          state.start = false;
          continue;
        }
        if (!r.text) continue;
        const body = this.textXmlOf(r.text, state);
        const style = this.textStyle(r.fmt);
        chunk += style ? `<text:span text:style-name="${style}">${body}</text:span>` : body;
      }
      if (link) {
        chunk = `<text:a xlink:type="simple" xlink:href="${escapeXml(link)}" text:style-name="Internet_20_link" text:visited-style-name="Visited_20_Internet_20_Link">${chunk}</text:a>`;
      }
      out += chunk;
      i = j;
    }
    return out;
  }

  private alignOf(el: Element | null): string {
    if (!el) return '';
    const a = (parseStyle(el)['text-align'] ?? el.getAttribute('align') ?? '').toLowerCase();
    if (a === 'center') return 'center';
    if (a === 'right' || a === 'end') return 'end';
    if (a === 'justify') return 'justify';
    return '';
  }

  private paragraph(nodes: Node[], ctx: OCtx, el: Element | null): string {
    const runs: ORun[] = [];
    for (const n of nodes) this.collect(n, EMPTY_FMT, null, runs);
    const parent = ctx.quote && !ctx.inTable ? 'Quotations' : ctx.base;
    const extra = ctx.quote > 1 && !ctx.inTable ? ` fo:margin-left="${inch(0.5 * ctx.quote)}"` : '';
    const style = this.paraStyle(parent, this.alignOf(el), ctx, extra);
    return `<text:p text:style-name="${style}">${this.runsXml(runs)}</text:p>`;
  }

  private heading(el: Element, level: number, ctx: OCtx): string {
    const runs: ORun[] = [];
    for (const n of Array.from(el.childNodes)) this.collect(n, EMPTY_FMT, null, runs);
    const style = this.paraStyle(`Heading_20_${level}`, this.alignOf(el), ctx);
    return `<text:h text:style-name="${style}" text:outline-level="${level}">${this.runsXml(runs)}</text:h>`;
  }

  /* ── blocks ── */

  blocks(parent: Node, ctx: OCtx): string {
    let out = '';
    let buffer: Node[] = [];
    const flush = () => {
      if (!buffer.length) return;
      if (buffer.some((n) => n.nodeType === 1 || (n.nodeValue ?? '').trim() !== '')) out += this.paragraph(buffer, ctx, null);
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
      out += this.block(el, tag, ctx);
    }
    flush();
    return out;
  }

  private block(el: Element, tag: string, ctx: OCtx): string {
    switch (tag) {
      case 'p':
        return this.paragraph(Array.from(el.childNodes), ctx, el);
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return this.heading(el, +tag[1], ctx);
      case 'blockquote':
        return this.blocks(el, { ...ctx, quote: ctx.quote + 1 });
      case 'pre': {
        let text = (el.textContent ?? '').replace(/\r\n?/g, '\n');
        if (text.endsWith('\n')) text = text.slice(0, -1);
        let out = '';
        for (const line of text.split('\n')) {
          const style = this.paraStyle('Preformatted_20_Text', '', ctx);
          out += `<text:p text:style-name="${style}">${this.textXmlOf(line, { start: true })}</text:p>`;
        }
        return out;
      }
      case 'hr':
        return `<text:p text:style-name="${this.paraStyle('Horizontal_20_Line', '', ctx)}"/>`;
      case 'ul':
      case 'ol':
        return this.list(el, ctx);
      case 'table':
        return ctx.inList ? this.flattenTable(el, ctx) : this.table(el, ctx);
      case 'div':
        if (el.getAttribute('data-page-break') === 'true') {
          if (ctx.inTable) return '';
          let out = '';
          if (this.pendingBreak) {
            // two breaks in a row: materialise the first one
            out = `<text:p text:style-name="${this.paraStyle(ctx.base, '', ctx)}"/>`;
          }
          this.pendingBreak = true;
          return out;
        }
        return this.blocks(el, ctx);
      default:
        return this.blocks(el, ctx);
    }
  }

  private planList(el: Element): ListPlan {
    const levels: ListPlan['levels'] = [];
    const visit = (list: Element, depth: number) => {
      if (depth >= 10) return;
      if (!levels[depth]) {
        const ordered = list.tagName.toLowerCase() === 'ol';
        const type = list.getAttribute('type') ?? '';
        const format = ordered ? (/^[aAiI]$/.test(type) ? type : '1') : '';
        const start = parseInt(list.getAttribute('start') ?? '', 10);
        levels[depth] = { ordered, format, start: isFinite(start) && start > 0 ? start : 1 };
      }
      for (const nested of Array.from(list.querySelectorAll(':scope > li > ul, :scope > li > ol, :scope > ul, :scope > ol'))) {
        visit(nested, depth + 1);
      }
    };
    visit(el, 0);
    return { levels };
  }

  private listStyle(plan: ListPlan): string {
    const name = `L${this.listXml.length + 1}`;
    const bullets = ['•', '◦', '▪'];
    let xml = `<text:list-style style:name="${name}">`;
    for (let k = 1; k <= 10; k++) {
      const lv = plan.levels[k - 1] ?? plan.levels[plan.levels.length - 1] ?? { ordered: false, format: '', start: 1 };
      const pos = inch(0.5 * k);
      const props =
        `<style:list-level-properties text:list-level-position-and-space-mode="label-alignment">` +
        `<style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${pos}" ` +
        `fo:text-indent="-0.25in" fo:margin-left="${pos}"/></style:list-level-properties>`;
      if (lv.ordered) {
        xml +=
          `<text:list-level-style-number text:level="${k}" style:num-suffix="." style:num-format="${lv.format}"` +
          `${lv.start !== 1 ? ` text:start-value="${lv.start}"` : ''}>${props}</text:list-level-style-number>`;
      } else {
        xml += `<text:list-level-style-bullet text:level="${k}" text:bullet-char="${bullets[(k - 1) % 3]}">${props}</text:list-level-style-bullet>`;
      }
    }
    xml += '</text:list-style>';
    this.listXml.push(xml);
    return name;
  }

  private list(el: Element, ctx: OCtx, nested = false): string {
    let attrs = '';
    if (!nested) attrs = ` text:style-name="${this.listStyle(this.planList(el))}"`;
    const ictx: OCtx = { ...ctx, inList: true, quote: 0, base: ctx.inTable ? ctx.base : 'Standard' };
    let out = `<text:list${attrs}>`;
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'ul' || tag === 'ol') {
        out += `<text:list-item>${this.list(child, ictx, true)}</text:list-item>`;
        continue;
      }
      if (tag !== 'li') continue;
      let inner = '';
      let buffer: Node[] = [];
      const flush = () => {
        if (buffer.some((n) => n.nodeType === 1 || (n.nodeValue ?? '').trim() !== '')) inner += this.paragraph(buffer, ictx, null);
        buffer = [];
      };
      for (const node of Array.from(child.childNodes)) {
        if (node.nodeType === 1) {
          const ct = (node as Element).tagName.toLowerCase();
          if (ct === 'ul' || ct === 'ol') {
            flush();
            if (!inner) inner += `<text:p text:style-name="${this.paraStyle(ictx.base, '', ictx)}"/>`;
            inner += this.list(node as Element, ictx, true);
            continue;
          }
          if (BLOCK_TAGS.has(ct)) {
            flush();
            inner += this.block(node as Element, ct, ictx);
            continue;
          }
        }
        buffer.push(node);
      }
      flush();
      if (!inner) inner = `<text:p text:style-name="${this.paraStyle(ictx.base, '', ictx)}"/>`;
      out += `<text:list-item>${inner}</text:list-item>`;
    }
    return `${out}</text:list>`;
  }

  private tableRows(el: Element): Element[] {
    const rows: Element[] = [];
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'tr') rows.push(child);
      else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
        for (const tr of Array.from(child.children)) if (tr.tagName.toLowerCase() === 'tr') rows.push(tr);
      }
    }
    return rows;
  }

  /** Tables are not allowed inside ODF list items: write the cell contents as paragraphs. */
  private flattenTable(el: Element, ctx: OCtx): string {
    let out = '';
    for (const tr of this.tableRows(el)) for (const cell of Array.from(tr.children)) out += this.blocks(cell, ctx);
    return out;
  }

  private table(el: Element, ctx: OCtx): string {
    interface CellRef {
      el: Element;
      r: number;
      c: number;
      rs: number;
      cs: number;
    }
    const rowEls = this.tableRows(el);
    if (!rowEls.length) return '';
    const grid: Array<Array<CellRef | undefined>> = rowEls.map(() => []);
    let ncols = 0;
    rowEls.forEach((tr, r) => {
      let c = 0;
      for (const cell of Array.from(tr.children)) {
        const tag = cell.tagName.toLowerCase();
        if (tag !== 'td' && tag !== 'th') continue;
        while (grid[r][c]) c++;
        const cs = Math.max(1, Math.min(256, parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1));
        const rs = Math.max(1, Math.min(rowEls.length - r, parseInt(cell.getAttribute('rowspan') ?? '1', 10) || 1));
        const ref: CellRef = { el: cell, r, c, rs, cs };
        for (let rr = r; rr < r + rs; rr++) for (let cc = c; cc < c + cs; cc++) grid[rr][cc] = ref;
        c += cs;
        ncols = Math.max(ncols, c);
      }
    });
    if (!ncols) return '';

    const n = ++this.tableCount;
    const name = `Table${n}`;
    const widthIn = this.contentWidthIn;
    let tprops = ` style:width="${inch(widthIn)}" table:align="margins"`;
    if (this.pendingBreak && !ctx.inTable) {
      tprops += ' fo:break-before="page"';
      this.pendingBreak = false;
    }
    this.tableXml.push(
      `<style:style style:name="${name}" style:family="table"><style:table-properties${tprops}/></style:style>` +
        `<style:style style:name="${name}.A" style:family="table-column"><style:table-column-properties style:column-width="${inch(widthIn / ncols)}"/></style:style>`,
    );

    const headerCount = (() => {
      let k = 0;
      for (const tr of rowEls) {
        const cells = Array.from(tr.children).filter((c) => /^t[dh]$/i.test(c.tagName));
        if (cells.length && cells.every((c) => c.tagName.toLowerCase() === 'th') && k < rowEls.length - 1) k++;
        else break;
      }
      return k;
    })();

    let xml = `<table:table table:name="${name}" table:style-name="${name}">`;
    xml += `<table:table-column table:style-name="${name}.A"${ncols > 1 ? ` table:number-columns-repeated="${ncols}"` : ''}/>`;
    const rowXml = (r: number) => {
      let s = '<table:table-row>';
      for (let c = 0; c < ncols; c++) {
        const ref = grid[r][c];
        if (ref && (ref.r !== r || ref.c !== c)) {
          s += '<table:covered-table-cell/>';
          continue;
        }
        let attrs = ' table:style-name="TableCell" office:value-type="string"';
        let content = '';
        if (ref) {
          if (ref.cs > 1) attrs += ` table:number-columns-spanned="${ref.cs}"`;
          if (ref.rs > 1) attrs += ` table:number-rows-spanned="${ref.rs}"`;
          const th = ref.el.tagName.toLowerCase() === 'th';
          content = this.blocks(ref.el, {
            inTable: true,
            quote: 0,
            base: th ? 'Table_20_Heading' : 'Table_20_Contents',
            inList: false,
          });
        }
        if (!content) content = '<text:p text:style-name="Table_20_Contents"/>';
        s += `<table:table-cell${attrs}>${content}</table:table-cell>`;
      }
      return `${s}</table:table-row>`;
    };
    if (headerCount) {
      xml += '<table:table-header-rows>';
      for (let r = 0; r < headerCount; r++) xml += rowXml(r);
      xml += '</table:table-header-rows>';
    }
    for (let r = headerCount; r < rowEls.length; r++) xml += rowXml(r);
    return `${xml}</table:table>`;
  }

  /** Emits a trailing paragraph if the document ends with a page break. */
  finish(ctx: OCtx): string {
    if (!this.pendingBreak) return '';
    return `<text:p text:style-name="${this.paraStyle('Standard', '', ctx)}"/>`;
  }

  /* ── package parts ── */

  private fontDecls(): string {
    let xml = '<office:font-face-decls>';
    for (const f of this.fonts) {
      const e = escapeXml(f);
      xml += `<style:font-face style:name="${e}" svg:font-family="${escapeXml(quoteFamily(f))}" style:font-family-generic="${fontFamilyGeneric(f)}" style:font-pitch="${fontFamilyGeneric(f) === 'modern' ? 'fixed' : 'variable'}"/>`;
    }
    return xml + '</office:font-face-decls>';
  }

  contentXml(body: string): string {
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<office:document-content ${NS_DECLS} office:version="1.2">` +
      `<office:scripts/>${this.fontDecls()}` +
      `<office:automatic-styles>${this.paraXml.join('')}${this.textXml.join('')}${this.tableXml.join('')}` +
      `<style:style style:name="TableCell" style:family="table-cell"><style:table-cell-properties fo:padding="0.0417in" fo:border="0.5pt solid #000000"/></style:style>` +
      `<style:style style:name="fr1" style:family="graphic" style:parent-style-name="Graphics"><style:graphic-properties style:vertical-pos="top" style:vertical-rel="baseline" style:horizontal-pos="center" style:horizontal-rel="paragraph" fo:background-color="transparent" draw:fill="none"/></style:style>` +
      `${this.listXml.join('')}</office:automatic-styles>` +
      `<office:body><office:text>${body || '<text:p text:style-name="Standard"/>'}</office:text></office:body>` +
      `</office:document-content>`
    );
  }

  stylesXml(): string {
    const dims = pageDimensions(this.setup);
    const m = this.setup.margins;
    let headings = '';
    const spacing = [
      [0.25, 0.0833],
      [0.1944, 0.0694],
      [0.1667, 0.0556],
      [0.1389, 0.0556],
      [0.1389, 0.0556],
      [0.1389, 0.0556],
    ];
    for (let l = 1; l <= 6; l++) {
      const s = `${HEADING_PT[l - 1]}pt`;
      headings +=
        `<style:style style:name="Heading_20_${l}" style:display-name="Heading ${l}" style:family="paragraph" ` +
        `style:parent-style-name="Heading" style:next-style-name="Standard" style:default-outline-level="${l}" style:class="text">` +
        `<style:paragraph-properties fo:margin-top="${spacing[l - 1][0]}in" fo:margin-bottom="${spacing[l - 1][1]}in"/>` +
        `<style:text-properties fo:font-size="${s}" fo:font-weight="bold" style:font-size-asian="${s}" style:font-weight-asian="bold" style:font-size-complex="${s}" style:font-weight-complex="bold"/></style:style>`;
    }
    let outline = '<text:outline-style style:name="Outline">';
    for (let l = 1; l <= 10; l++) {
      outline +=
        `<text:outline-level-style text:level="${l}" style:num-format="">` +
        `<style:list-level-properties text:list-level-position-and-space-mode="label-alignment">` +
        `<style:list-level-label-alignment text:label-followed-by="listtab"/></style:list-level-properties></text:outline-level-style>`;
    }
    outline += '</text:outline-style>';
    const mono = escapeXml(MONO_FONT);
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<office:document-styles ${NS_DECLS} office:version="1.2">${this.fontDecls()}` +
      `<office:styles>` +
      `<style:default-style style:family="paragraph"><style:paragraph-properties style:tab-stop-distance="0.5in" style:writing-mode="page"/>` +
      `<style:text-properties style:font-name="${DEFAULT_FONT}" fo:font-size="${DEFAULT_PT}pt" fo:language="en" fo:country="US" ` +
      `style:font-name-asian="${DEFAULT_FONT}" style:font-size-asian="${DEFAULT_PT}pt" style:font-name-complex="${DEFAULT_FONT}" style:font-size-complex="${DEFAULT_PT}pt"/></style:default-style>` +
      `<style:default-style style:family="table"><style:table-properties table:border-model="collapsing"/></style:default-style>` +
      `<style:default-style style:family="graphic"><style:graphic-properties draw:fill="none" draw:stroke="none"/></style:default-style>` +
      `<style:style style:name="Standard" style:family="paragraph" style:class="text"><style:paragraph-properties fo:margin-top="0in" fo:margin-bottom="0.1111in" fo:line-height="115%"/></style:style>` +
      `<style:style style:name="Heading" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Standard" style:class="text"><style:paragraph-properties fo:keep-with-next="always"/></style:style>` +
      headings +
      `<style:style style:name="Quotations" style:family="paragraph" style:parent-style-name="Standard" style:class="html"><style:paragraph-properties fo:margin-left="0.5in" fo:margin-right="0.5in"/></style:style>` +
      `<style:style style:name="Preformatted_20_Text" style:display-name="Preformatted Text" style:family="paragraph" style:parent-style-name="Standard" style:class="html">` +
      `<style:paragraph-properties fo:margin-top="0in" fo:margin-bottom="0in" fo:line-height="100%"/><style:text-properties style:font-name="${mono}" fo:font-size="10pt" style:font-name-asian="${mono}" style:font-size-asian="10pt" style:font-name-complex="${mono}" style:font-size-complex="10pt"/></style:style>` +
      `<style:style style:name="Horizontal_20_Line" style:display-name="Horizontal Line" style:family="paragraph" style:parent-style-name="Standard" style:class="html">` +
      `<style:paragraph-properties fo:margin-top="0in" fo:margin-bottom="0.1965in" fo:border-top="none" fo:border-left="none" fo:border-right="none" fo:border-bottom="0.5pt solid #808080" fo:padding="0in"/><style:text-properties fo:font-size="6pt"/></style:style>` +
      `<style:style style:name="Table_20_Contents" style:display-name="Table Contents" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"><style:paragraph-properties fo:margin-top="0in" fo:margin-bottom="0in"/></style:style>` +
      `<style:style style:name="Table_20_Heading" style:display-name="Table Heading" style:family="paragraph" style:parent-style-name="Table_20_Contents" style:class="extra"><style:text-properties fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"/></style:style>` +
      `<style:style style:name="Source_20_Text" style:display-name="Source Text" style:family="text"><style:text-properties style:font-name="${mono}" style:font-name-asian="${mono}" style:font-name-complex="${mono}"/></style:style>` +
      `<style:style style:name="Internet_20_link" style:display-name="Internet link" style:family="text"><style:text-properties fo:color="#0563c1" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>` +
      `<style:style style:name="Visited_20_Internet_20_Link" style:display-name="Visited Internet Link" style:family="text"><style:text-properties fo:color="#954f72" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>` +
      `<style:style style:name="Graphics" style:family="graphic"><style:graphic-properties text:anchor-type="as-char" svg:y="0in" style:vertical-pos="top" style:vertical-rel="baseline"/></style:style>` +
      outline +
      `</office:styles>` +
      `<office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties ` +
      `fo:page-width="${inch(dims.width / 72)}" fo:page-height="${inch(dims.height / 72)}" style:print-orientation="${this.setup.orientation}" ` +
      `fo:margin-top="${inch(m.top / 72)}" fo:margin-bottom="${inch(m.bottom / 72)}" fo:margin-left="${inch(m.left / 72)}" fo:margin-right="${inch(m.right / 72)}" style:writing-mode="lr-tb"/>` +
      `</style:page-layout></office:automatic-styles>` +
      `<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles>` +
      `</office:document-styles>`
    );
  }
}

function metaXml(title: string | undefined): string {
  const now = new Date().toISOString().replace(/\.\d+Z$/, '');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<office:document-meta xmlns:office="${NS.office}" xmlns:meta="${NS.meta}" xmlns:dc="${NS.dc}" office:version="1.2">` +
    `<office:meta><meta:generator>File Editor</meta:generator>` +
    (title ? `<dc:title>${escapeXml(title)}</dc:title>` : '') +
    `<meta:creation-date>${now}</meta:creation-date><dc:date>${now}</dc:date></office:meta></office:document-meta>`
  );
}

function manifestXml(files: Array<{ path: string; mime: string }>): string {
  let xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<manifest:manifest xmlns:manifest="${NS.manifest}" manifest:version="1.2">` +
    `<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="${ODT_MIME}"/>` +
    `<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>` +
    `<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>` +
    `<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>`;
  for (const f of files) xml += `<manifest:file-entry manifest:full-path="${f.path}" manifest:media-type="${f.mime}"/>`;
  return xml + '</manifest:manifest>';
}

export const exportOdt: Exporter = async (doc) => {
  const setup = doc.pageSetup ?? DEFAULT_PAGE_SETUP;
  const writer = new OdtWriter(setup);
  const ctx: OCtx = { inTable: false, quote: 0, base: 'Standard', inList: false };
  const body = writer.blocks(parseHtml(doc.html ?? ''), ctx) + writer.finish(ctx);
  const content = writer.contentXml(body);
  const styles = writer.stylesXml();

  const zip = new JSZip();
  // The mimetype entry must come first and be stored uncompressed (ODF 1.2 part 3, §3.3).
  zip.file('mimetype', ODT_MIME, { compression: 'STORE' });
  zip.file('META-INF/manifest.xml', manifestXml(writer.files), { createFolders: false });
  zip.file('content.xml', content);
  zip.file('styles.xml', styles);
  zip.file('meta.xml', metaXml(doc.title));
  for (const f of writer.files) zip.file(f.path, f.bytes, { compression: 'STORE', createFolders: false });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: ODT_MIME });
};

/* ════════════════════════════════════════════════════════════════════════════
 * IMPORT
 * ════════════════════════════════════════════════════════════════════════════ */

/** Text properties; undefined = not set at this level. */
interface TP {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  vert?: '' | 'sub' | 'super';
  color?: string | null;
  bg?: string | null;
  font?: string | null;
  size?: number;
  sizePct?: number;
}

interface PP {
  align?: '' | 'center' | 'right' | 'justify';
  breakBefore?: boolean;
  breakAfter?: boolean;
}

interface StyleRec {
  name: string;
  display: string;
  family: string;
  parent: string | null;
  tp: TP;
  pp: PP;
  outline: number;
}

function attr(el: Element, ns: string, name: string): string | null {
  return el.getAttributeNS(ns, name) ?? (el.getAttribute(`${prefixOf(ns)}:${name}`) || null);
}

function prefixOf(ns: string): string {
  for (const [k, v] of Object.entries(NS)) if (v === ns) return k;
  return '';
}

function is(node: Node, ns: string, local: string): boolean {
  return node.nodeType === 1 && (node as Element).namespaceURI === ns && (node as Element).localName === local;
}

function childrenNS(el: Element, ns: string, local?: string): Element[] {
  const out: Element[] = [];
  for (const c of Array.from(el.children)) if (c.namespaceURI === ns && (!local || c.localName === local)) out.push(c);
  return out;
}

/** ODF length → points. */
function lengthPt(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /^\s*(-?\d*\.?\d+)\s*(in|cm|mm|pt|pc|px)?\s*$/i.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch ((m[2] || 'pt').toLowerCase()) {
    case 'in':
      return n * 72;
    case 'cm':
      return (n * 72) / 2.54;
    case 'mm':
      return (n * 72) / 25.4;
    case 'pc':
      return n * 12;
    case 'px':
      return n * 0.75;
    default:
      return n;
  }
}

function hexColor(v: string | null): string | null | undefined {
  if (v === null) return undefined;
  if (v === 'transparent') return null;
  return cssColorToHex(v);
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
};

function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  return null;
}

interface ListLevelInfo {
  ordered: boolean;
  start: number;
}

class OdtReader {
  private styles = new Map<string, StyleRec>(); // key: family|name
  private defaults = new Map<string, StyleRec>(); // family → default style
  private fontFaces = new Map<string, string>();
  private listStyles = new Map<string, Map<number, ListLevelInfo>>();
  private resolvedTp = new Map<string, TP>();
  private docFont: string | null = null;
  private docSize = 12;

  constructor(private readonly images: Map<string, { url: string; width: number; height: number }>) {}

  /* ── styles ── */

  loadFontFaces(root: Element | null): void {
    if (!root) return;
    for (const decls of Array.from(root.getElementsByTagNameNS(NS.office, 'font-face-decls'))) {
      for (const ff of childrenNS(decls, NS.style, 'font-face')) {
        const name = attr(ff, NS.style, 'name');
        const fam = primaryFontFamily(attr(ff, NS.svg, 'font-family')) ?? name;
        if (name && fam) this.fontFaces.set(name, fam);
      }
    }
  }

  loadStyles(container: Element | null): void {
    if (!container) return;
    for (const el of Array.from(container.children)) {
      if (is(el, NS.style, 'style') || is(el, NS.style, 'default-style')) {
        const rec = this.parseStyle(el);
        if (el.localName === 'default-style') this.defaults.set(rec.family, rec);
        else this.styles.set(`${rec.family}|${rec.name}`, rec);
      } else if (is(el, NS.text, 'list-style')) {
        const name = attr(el, NS.style, 'name');
        if (!name) continue;
        const levels = new Map<number, ListLevelInfo>();
        for (const lv of Array.from(el.children)) {
          const level = parseInt(attr(lv, NS.text, 'level') ?? '1', 10) || 1;
          if (lv.localName === 'list-level-style-number') {
            const fmt = attr(lv, NS.style, 'num-format') ?? '';
            levels.set(level, { ordered: fmt !== '', start: parseInt(attr(lv, NS.text, 'start-value') ?? '1', 10) || 1 });
          } else if (lv.localName === 'list-level-style-bullet' || lv.localName === 'list-level-style-image') {
            levels.set(level, { ordered: false, start: 1 });
          }
        }
        this.listStyles.set(name, levels);
      }
    }
  }

  private parseStyle(el: Element): StyleRec {
    const rec: StyleRec = {
      name: attr(el, NS.style, 'name') ?? '',
      display: attr(el, NS.style, 'display-name') ?? '',
      family: attr(el, NS.style, 'family') ?? '',
      parent: attr(el, NS.style, 'parent-style-name'),
      tp: {},
      pp: {},
      outline: parseInt(attr(el, NS.style, 'default-outline-level') ?? '0', 10) || 0,
    };
    for (const c of Array.from(el.children)) {
      if (is(c, NS.style, 'text-properties')) rec.tp = this.parseTp(c);
      else if (is(c, NS.style, 'paragraph-properties') || is(c, NS.style, 'table-properties')) {
        const a = attr(c, NS.fo, 'text-align');
        if (a) rec.pp.align = a === 'center' ? 'center' : a === 'end' || a === 'right' ? 'right' : a === 'justify' ? 'justify' : '';
        const bb = attr(c, NS.fo, 'break-before');
        if (bb) rec.pp.breakBefore = bb === 'page';
        const ba = attr(c, NS.fo, 'break-after');
        if (ba) rec.pp.breakAfter = ba === 'page';
      }
    }
    return rec;
  }

  private parseTp(el: Element): TP {
    const tp: TP = {};
    const w = attr(el, NS.fo, 'font-weight');
    if (w) tp.bold = w === 'bold' || parseInt(w, 10) >= 600;
    const st = attr(el, NS.fo, 'font-style');
    if (st) tp.italic = st === 'italic' || st === 'oblique';
    const ul = attr(el, NS.style, 'text-underline-style');
    if (ul) tp.underline = ul !== 'none';
    if (attr(el, NS.style, 'text-underline-type') === 'none') tp.underline = false;
    const lt = attr(el, NS.style, 'text-line-through-style');
    if (lt) tp.strike = lt !== 'none';
    if (attr(el, NS.style, 'text-line-through-type') === 'none') tp.strike = false;
    const pos = attr(el, NS.style, 'text-position');
    if (pos) {
      const first = pos.trim().split(/\s+/)[0];
      if (first === 'super') tp.vert = 'super';
      else if (first === 'sub') tp.vert = 'sub';
      else {
        const n = parseFloat(first);
        tp.vert = n > 0 ? 'super' : n < 0 ? 'sub' : '';
      }
    }
    const color = hexColor(attr(el, NS.fo, 'color'));
    if (color !== undefined) tp.color = color;
    const bg = hexColor(attr(el, NS.fo, 'background-color'));
    if (bg !== undefined) tp.bg = bg;
    const fn = attr(el, NS.style, 'font-name');
    if (fn) tp.font = this.fontFaces.get(fn) ?? fn;
    const ff = attr(el, NS.fo, 'font-family');
    if (ff) tp.font = primaryFontFamily(ff);
    const fs = attr(el, NS.fo, 'font-size');
    if (fs) {
      if (/%\s*$/.test(fs)) tp.sizePct = parseFloat(fs);
      else {
        const pt = lengthPt(fs);
        if (pt && pt > 0) tp.size = pt;
      }
    }
    return tp;
  }

  private style(family: string, name: string | null): StyleRec | undefined {
    return name ? this.styles.get(`${family}|${name}`) : undefined;
  }

  /** Names (and display names) along a style's inheritance chain, nearest first. */
  chain(family: string, name: string | null): StyleRec[] {
    const out: StyleRec[] = [];
    let s = this.style(family, name);
    const seen = new Set<string>();
    while (s && !seen.has(s.name) && out.length < 32) {
      seen.add(s.name);
      out.push(s);
      s = this.style(family, s.parent);
    }
    return out;
  }

  private mergeTp(base: TP, over: TP): TP {
    const out: TP = { ...base };
    for (const [k, v] of Object.entries(over)) {
      if (k === 'sizePct') continue;
      (out as Record<string, unknown>)[k] = v;
    }
    if (over.sizePct !== undefined && over.size === undefined) out.size = ((base.size ?? 12) * over.sizePct) / 100;
    return out;
  }

  /** Fully resolved text properties of a paragraph style (including document defaults). */
  paraTp(name: string | null): TP {
    const key = `p|${name}`;
    let tp = this.resolvedTp.get(key);
    if (!tp) {
      tp = { ...(this.defaults.get('paragraph')?.tp ?? {}) };
      for (const s of this.chain('paragraph', name).reverse()) tp = this.mergeTp(tp, s.tp);
      this.resolvedTp.set(key, tp);
    }
    return tp;
  }

  /** Text properties set by a text style chain (no defaults), applied over `base`. */
  textTp(name: string | null, base: TP): TP {
    let tp = base;
    for (const s of this.chain('text', name).reverse()) tp = this.mergeTp(tp, s.tp);
    return tp;
  }

  paraPp(family: string, name: string | null): PP {
    const pp: PP = {};
    for (const s of this.chain(family, name).reverse()) Object.assign(pp, s.pp);
    return pp;
  }

  private hasNamed(family: string, name: string | null, re: RegExp): boolean {
    return this.chain(family, name).some((s) => re.test(s.name) || re.test(s.display));
  }

  initDefaults(): void {
    // LibreOffice calls the body style 'Standard'; Word's ODT export calls it 'Normal'
    const name = this.styles.has('paragraph|Standard') ? 'Standard' : this.styles.has('paragraph|Normal') ? 'Normal' : null;
    const std = this.paraTp(name);
    this.docFont = std.font ?? null;
    this.docSize = std.size ?? 12;
  }

  /* ── content ── */

  private listLevel(styleName: string | null, depth: number): ListLevelInfo {
    const levels = styleName ? this.listStyles.get(styleName) : undefined;
    return levels?.get(depth + 1) ?? levels?.get(1) ?? { ordered: false, start: 1 };
  }

  private inlineRuns(
    node: Element,
    tp: TP,
    link: string | null,
    out: InlineRun[],
    ctx: { heading: number; headingTp: TP | null; th: boolean; code: boolean },
  ): void {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const text = (child.nodeValue ?? '').replace(/[ \t\r\n]+/g, ' ');
        if (text) out.push({ text, fmt: this.toFmt(tp, ctx), link });
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      if (el.namespaceURI === NS.text) {
        switch (el.localName) {
          case 'span': {
            const name = attr(el, NS.text, 'style-name');
            const code = ctx.code || this.hasNamed('text', name, /^(Source_20_Text|Source Text)$/);
            this.inlineRuns(el, this.textTp(name, tp), link, out, { ...ctx, code });
            continue;
          }
          case 'a': {
            const href = attr(el, NS.xlink, 'href');
            const name = attr(el, NS.text, 'style-name');
            // the link character style (blue + underline) is implied by <a>
            this.inlineRuns(el, name && /link/i.test(name) ? tp : this.textTp(name, tp), href || link, out, ctx);
            continue;
          }
          case 's': {
            const n = Math.max(1, Math.min(1000, parseInt(attr(el, NS.text, 'c') ?? '1', 10) || 1));
            out.push({ text: SPACE_MARK.repeat(n), fmt: this.toFmt(tp, ctx), link });
            continue;
          }
          case 'tab':
            out.push({ text: '\t', fmt: this.toFmt(tp, ctx), link });
            continue;
          case 'line-break':
            out.push({ html: '<br>', link });
            continue;
          case 'soft-page-break':
          case 'bookmark':
          case 'bookmark-start':
          case 'bookmark-end':
          case 'reference-mark':
          case 'reference-mark-start':
          case 'reference-mark-end':
          case 'note':
          case 'change':
          case 'change-start':
          case 'change-end':
          case 'alphabetical-index-mark':
          case 'toc-mark':
            continue;
          default:
            // fields (date, page-number, sequence, …) and anything else: keep their text
            this.inlineRuns(el, tp, link, out, ctx);
            continue;
        }
      }
      if (is(el, NS.draw, 'frame')) {
        const img = this.frameImage(el);
        if (img) out.push({ html: img, link });
        else {
          // text boxes: keep their text inline
          for (const box of childrenNS(el, NS.draw, 'text-box')) {
            for (const p of Array.from(box.children)) if (p.namespaceURI === NS.text) this.inlineRuns(p, tp, link, out, ctx);
          }
        }
        continue;
      }
      if (is(el, NS.draw, 'a')) {
        this.inlineRuns(el, tp, attr(el, NS.xlink, 'href') || link, out, ctx);
        continue;
      }
      // office:annotation and other foreign elements are skipped
    }
  }

  private toFmt(tp: TP, ctx: { heading: number; headingTp: TP | null; th: boolean; code: boolean }): InlineFmt {
    const f: InlineFmt = {
      bold: !!tp.bold,
      italic: !!tp.italic,
      underline: !!tp.underline,
      strike: !!tp.strike,
      vert: tp.vert ?? '',
      color: tp.color ?? null,
      highlight: tp.bg ?? null,
      font: tp.font ?? null,
      size: tp.size ? Math.round(tp.size * 2) / 2 : null,
      code: ctx.code,
    };
    if (f.font && this.docFont && f.font.toLowerCase() === this.docFont.toLowerCase()) f.font = null;
    if (f.size && Math.abs(f.size - this.docSize) < 0.01) f.size = null;
    if (ctx.heading) {
      f.bold = false;
      const h = ctx.headingTp;
      if (h) {
        if (h.size && f.size && Math.abs(f.size - Math.round(h.size * 2) / 2) < 0.01) f.size = null;
        if (h.italic && f.italic) f.italic = false;
        if (h.font && f.font && h.font.toLowerCase() === f.font.toLowerCase()) f.font = null;
        if (h.color && f.color === h.color) f.color = null;
      }
    }
    if (ctx.th) f.bold = false;
    if (f.highlight === 'ffffff') f.highlight = null;
    return f;
  }

  private frameImage(frame: Element): string | null {
    const imgs = childrenNS(frame, NS.draw, 'image');
    for (const img of imgs) {
      const href = (attr(img, NS.xlink, 'href') ?? '').replace(/^\.\//, '');
      const data = this.images.get(href);
      if (!data) continue;
      const wpt = lengthPt(attr(frame, NS.svg, 'width'));
      const hpt = lengthPt(attr(frame, NS.svg, 'height'));
      const w = wpt ? Math.round(wpt / 0.75) : data.width;
      const h = hpt ? Math.round(hpt / 0.75) : data.height;
      const title = childrenNS(frame, NS.svg, 'title')[0]?.textContent ?? childrenNS(frame, NS.svg, 'desc')[0]?.textContent ?? '';
      const size = w && h ? ` width="${w}" height="${h}"` : '';
      return `<img src="${data.url}"${size} alt="${escapeXml(title).replace(/&apos;/g, "'")}">`;
    }
    return null;
  }

  private paragraphHtml(el: Element, ctx: { th: boolean }): { html: string; kind: 'p' | 'h' | 'quote' | 'pre' | 'hr'; text: string } {
    const name = attr(el, NS.text, 'style-name');
    const tp = this.paraTp(name);
    const pp = this.paraPp('paragraph', name);
    const align = pp.align ? ` style="text-align: ${pp.align}"` : '';
    if (el.localName === 'h') {
      const chain = this.chain('paragraph', name);
      let level = parseInt(attr(el, NS.text, 'outline-level') ?? '', 10);
      if (!level) level = chain.find((s) => s.outline)?.outline ?? 1;
      level = Math.max(1, Math.min(6, level));
      const runs: InlineRun[] = [];
      this.inlineRuns(el, tp, null, runs, { heading: level, headingTp: tp, th: ctx.th, code: false });
      return { html: `<h${level}${align}>${renderInlineRuns(trimRuns(runs))}</h${level}>`, kind: 'h', text: '' };
    }
    if (this.hasNamed('paragraph', name, /^(Preformatted_20_Text|Preformatted Text)$/)) {
      return { html: '', kind: 'pre', text: preText(el) };
    }
    const runs: InlineRun[] = [];
    this.inlineRuns(el, tp, null, runs, { heading: 0, headingTp: null, th: ctx.th, code: false });
    const trimmed = trimRuns(runs);
    if (!trimmed.length && this.hasNamed('paragraph', name, /^(Horizontal_20_Line|Horizontal Line)$/)) {
      return { html: '<hr>', kind: 'hr', text: '' };
    }
    const html = `<p${align}>${renderInlineRuns(trimmed)}</p>`;
    if (this.hasNamed('paragraph', name, /^(Quotations|Quote|Block_20_Quotation)$/)) return { html, kind: 'quote', text: '' };
    return { html, kind: 'p', text: '' };
  }

  /** Whether an element starts with a page break (style break-before). */
  private breakBefore(el: Element): boolean {
    if (is(el, NS.text, 'p') || is(el, NS.text, 'h')) return !!this.paraPp('paragraph', attr(el, NS.text, 'style-name')).breakBefore;
    if (is(el, NS.table, 'table')) return !!this.paraPp('table', attr(el, NS.table, 'style-name')).breakBefore;
    if (is(el, NS.text, 'list')) {
      const first = el.getElementsByTagNameNS(NS.text, 'p')[0] ?? el.getElementsByTagNameNS(NS.text, 'h')[0];
      return first ? this.breakBefore(first) : false;
    }
    return false;
  }

  private breakAfter(el: Element): boolean {
    if (is(el, NS.text, 'p') || is(el, NS.text, 'h')) return !!this.paraPp('paragraph', attr(el, NS.text, 'style-name')).breakAfter;
    if (is(el, NS.table, 'table')) return !!this.paraPp('table', attr(el, NS.table, 'style-name')).breakAfter;
    return false;
  }

  /** Renders a sequence of block-level ODF elements. */
  blocks(parent: Element, opts: { top: boolean; th: boolean }): string {
    const items: Array<{ kind: 'p' | 'h' | 'quote' | 'pre' | 'hr' | 'other' | 'break'; html: string; text: string }> = [];
    const visit = (container: Element) => {
      for (const el of Array.from(container.children)) {
        if (opts.top && this.breakBefore(el) && items.some((i) => i.kind !== 'break')) items.push({ kind: 'break', html: PAGE_BREAK_HTML, text: '' });
        if (is(el, NS.text, 'p') || is(el, NS.text, 'h')) {
          // frames anchored to the page/paragraph come out inline; that is fine for the editor
          const item = this.paragraphHtml(el, opts);
          // an empty paragraph that only exists to carry a page break (Word's ODT export)
          const carrier = item.kind === 'p' && /^<p[^>]*><\/p>$/.test(item.html) && this.breakBefore(el);
          if (!carrier || !opts.top) items.push(item);
        } else if (is(el, NS.text, 'list')) {
          items.push({ kind: 'other', html: this.list(el, attr(el, NS.text, 'style-name'), 0, opts), text: '' });
        } else if (is(el, NS.table, 'table')) {
          items.push({ kind: 'other', html: this.table(el), text: '' });
        } else if (
          is(el, NS.text, 'section') ||
          is(el, NS.text, 'index-body') ||
          is(el, NS.text, 'table-of-content') ||
          is(el, NS.text, 'alphabetical-index') ||
          is(el, NS.text, 'illustration-index') ||
          is(el, NS.text, 'table-index') ||
          is(el, NS.text, 'object-index') ||
          is(el, NS.text, 'user-index') ||
          is(el, NS.text, 'bibliography')
        ) {
          visit(el);
        } else if (is(el, NS.draw, 'frame')) {
          const img = this.frameImage(el);
          if (img) items.push({ kind: 'p', html: `<p>${img}</p>`, text: '' });
        }
        if (opts.top && this.breakAfter(el)) items.push({ kind: 'break', html: PAGE_BREAK_HTML, text: '' });
      }
    };
    visit(parent);
    while (items.length && items[items.length - 1].kind === 'break') items.pop();

    let html = '';
    for (let i = 0; i < items.length; ) {
      const it = items[i];
      if (it.kind === 'quote') {
        html += '<blockquote>';
        while (i < items.length && items[i].kind === 'quote') html += items[i++].html;
        html += '</blockquote>';
      } else if (it.kind === 'pre') {
        const lines: string[] = [];
        while (i < items.length && items[i].kind === 'pre') lines.push(items[i++].text);
        html += `<pre><code>${escapeXml(lines.join('\n')).replace(/&apos;/g, "'")}</code></pre>`;
      } else {
        html += it.html;
        i++;
      }
    }
    return html;
  }

  private list(el: Element, styleName: string | null, depth: number, opts: { top: boolean; th: boolean }): string {
    const style = attr(el, NS.text, 'style-name') ?? styleName;
    const level = this.listLevel(style, depth);
    const tag = level.ordered ? 'ol' : 'ul';
    const start = level.ordered && level.start > 1 ? ` start="${level.start}"` : '';
    let html = `<${tag}${start}>`;
    for (const item of Array.from(el.children)) {
      if (!(is(item, NS.text, 'list-item') || is(item, NS.text, 'list-header'))) continue;
      let inner = '';
      const rest = item.ownerDocument.createElementNS(NS.text, 'text:section');
      for (const c of Array.from(item.children)) {
        if (is(c, NS.text, 'list')) {
          if (rest.children.length) {
            inner += this.blocks(rest, { top: false, th: opts.th });
            while (rest.firstChild) rest.removeChild(rest.firstChild);
          }
          inner += this.list(c, style, depth + 1, opts);
        } else if (!is(c, NS.text, 'number')) {
          rest.appendChild(c.cloneNode(true));
        }
      }
      if (rest.children.length) inner += this.blocks(rest, { top: false, th: opts.th });
      if (!inner) inner = '<p></p>';
      // an item that only wraps a nested list: merge into the previous <li>
      if (/^<[uo]l[ >]/.test(inner) && html.endsWith('</li>')) {
        html = html.slice(0, -5) + inner + '</li>';
      } else {
        html += `<li>${inner}</li>`;
      }
    }
    return `${html}</${tag}>`;
  }

  private table(el: Element): string {
    const rows: Array<{ row: Element; header: boolean }> = [];
    const collect = (container: Element, header: boolean) => {
      for (const c of Array.from(container.children)) {
        if (is(c, NS.table, 'table-row')) {
          const rep = Math.max(1, Math.min(100, parseInt(attr(c, NS.table, 'number-rows-repeated') ?? '1', 10) || 1));
          for (let k = 0; k < rep && rows.length < 2000; k++) rows.push({ row: c, header });
        } else if (is(c, NS.table, 'table-header-rows')) collect(c, true);
        else if (is(c, NS.table, 'table-rows') || is(c, NS.table, 'table-row-group')) collect(c, header);
      }
    };
    collect(el, false);
    if (!rows.length) return '';
    let html = '<table><tbody>';
    for (const { row, header } of rows) {
      html += '<tr>';
      for (const cell of Array.from(row.children)) {
        if (!is(cell, NS.table, 'table-cell')) continue; // covered cells are skipped
        const tag = header ? 'th' : 'td';
        const cs = parseInt(attr(cell, NS.table, 'number-columns-spanned') ?? '1', 10) || 1;
        const rs = parseInt(attr(cell, NS.table, 'number-rows-spanned') ?? '1', 10) || 1;
        const rep = Math.max(1, Math.min(64, parseInt(attr(cell, NS.table, 'number-columns-repeated') ?? '1', 10) || 1));
        const inner = this.blocks(cell, { top: false, th: header }) || '<p></p>';
        const attrs = `${cs > 1 ? ` colspan="${cs}"` : ''}${rs > 1 ? ` rowspan="${rs}"` : ''}`;
        for (let k = 0; k < rep; k++) html += `<${tag}${attrs}>${inner}</${tag}>`;
      }
      html += '</tr>';
    }
    return `${html}</tbody></table>`;
  }
}

function trimRuns(runs: InlineRun[]): InlineRun[] {
  // ODF ignores leading/trailing collapsible whitespace in a paragraph
  const out = runs.slice();
  while (out.length && 'text' in out[0] && !out[0].text.replace(/^ +/, '')) out.shift();
  if (out.length && 'text' in out[0]) out[0] = { ...out[0], text: out[0].text.replace(/^ +/, '') };
  while (out.length && 'text' in out[out.length - 1] && !(out[out.length - 1] as { text: string }).text.replace(/ +$/, '')) out.pop();
  const last = out[out.length - 1];
  if (last && 'text' in last) out[out.length - 1] = { ...last, text: last.text.replace(/ +$/, '') };
  // collapse " " sequences across run boundaries
  let prevSpace = false;
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    if (!('text' in r)) {
      prevSpace = false;
      continue;
    }
    let t = r.text;
    if (prevSpace) t = t.replace(/^ +/, '');
    if (t !== r.text) out[i] = { ...r, text: t };
    if (t) prevSpace = t.endsWith(' ');
  }
  return resolveSpaceMarks(out);
}

/** Placeholder for <text:s/>, resolved once the whole paragraph is known. */
const SPACE_MARK = String.fromCharCode(0xe000);
const NBSP = String.fromCharCode(0xa0);

/**
 * <text:s/> is a literal (non-collapsible) space. A single one between two non-space
 * characters is written as an ordinary space; anything that HTML would collapse becomes
 * non-breaking spaces so the spacing survives in the editor.
 */
function resolveSpaceMarks(runs: InlineRun[]): InlineRun[] {
  const charAt = (ri: number, ci: number, dir: 1 | -1): string => {
    // nearest character before/after position (ri, ci), crossing run boundaries
    let r = ri;
    let c = ci + dir;
    while (r >= 0 && r < runs.length) {
      const run = runs[r];
      if (!('text' in run)) return run.html === '<br>' ? ' ' : 'x';
      if (c >= 0 && c < run.text.length) return run.text[c];
      r += dir;
      if (r >= 0 && r < runs.length) {
        const next = runs[r];
        c = dir === 1 ? 0 : 'text' in next ? next.text.length - 1 : 0;
      }
    }
    return ' '; // paragraph edge
  };
  return runs.map((run, ri) => {
    if (!('text' in run) || !run.text.includes(SPACE_MARK)) return run;
    let text = '';
    const t = run.text;
    for (let i = 0; i < t.length; i++) {
      if (t[i] !== SPACE_MARK) {
        text += t[i];
        continue;
      }
      let j = i;
      while (j + 1 < t.length && t[j + 1] === SPACE_MARK) j++;
      const before = i > 0 ? t[i - 1] : charAt(ri, i, -1);
      const after = j + 1 < t.length ? t[j + 1] : charAt(ri, j, 1);
      const isSpace = (ch: string) => ch === ' ' || ch === SPACE_MARK || ch === '\t' || ch === NBSP;
      const n = j - i + 1;
      text += n === 1 && !isSpace(before) && !isSpace(after) ? ' ' : NBSP.repeat(n);
      i = j;
    }
    return { ...run, text };
  });
}

/** Literal text of a preformatted paragraph (spaces, tabs, line breaks preserved). */
function preText(el: Element): string {
  let out = '';
  const walk = (n: Element) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) out += (c.nodeValue ?? '').replace(/[\r\n]+/g, ' ');
      else if (c.nodeType === 1) {
        const e = c as Element;
        if (is(e, NS.text, 's')) out += ' '.repeat(Math.max(1, Math.min(1000, parseInt(attr(e, NS.text, 'c') ?? '1', 10) || 1)));
        else if (is(e, NS.text, 'tab')) out += '\t';
        else if (is(e, NS.text, 'line-break')) out += '\n';
        else if (is(e, NS.text, 'note') || is(e, NS.office, 'annotation')) continue;
        else walk(e);
      }
    }
  };
  walk(el);
  return out;
}

export const importOdt: Importer = async (bytes) => {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error('This file is not a valid OpenDocument (ZIP) package.');
  }
  const manifest = await zip.file('META-INF/manifest.xml')?.async('string');
  if (manifest && /encryption-data/.test(manifest)) {
    throw new UnsupportedError('Password-protected ODT files are not supported yet.');
  }
  const contentStr = await zip.file('content.xml')?.async('string');
  if (!contentStr) throw new Error('This OpenDocument file has no content.xml.');
  const stylesStr = await zip.file('styles.xml')?.async('string');
  const metaStr = await zip.file('meta.xml')?.async('string');

  const content = parseXml(contentStr);
  let styles: Document | null = null;
  try {
    styles = stylesStr ? parseXml(stylesStr) : null;
  } catch {
    styles = null;
  }

  // load every image referenced by the content
  const images = new Map<string, { url: string; width: number; height: number }>();
  for (const img of Array.from(content.getElementsByTagNameNS(NS.draw, 'image'))) {
    const href = (attr(img, NS.xlink, 'href') ?? '').replace(/^\.\//, '');
    if (!href || images.has(href) || /^[a-z]+:/i.test(href)) continue;
    const file = zip.file(href);
    if (!file) continue;
    const data = await file.async('uint8array');
    const ext = /\.([a-z0-9]+)$/i.exec(href)?.[1]?.toLowerCase() ?? '';
    const mime = sniffImageMime(data) ?? MIME_BY_EXT[ext];
    if (!mime) continue; // svg / wmf / emf etc. are not usable by the editor
    const size = imageSize(data);
    images.set(href, { url: toDataUrl(mime, data), width: size?.width ?? 0, height: size?.height ?? 0 });
  }

  const reader = new OdtReader(images);
  reader.loadFontFaces(styles?.documentElement ?? null);
  reader.loadFontFaces(content.documentElement);
  const stylesRoot = styles?.documentElement ?? null;
  if (stylesRoot) {
    reader.loadStyles(childrenNS(stylesRoot, NS.office, 'styles')[0] ?? null);
    reader.loadStyles(childrenNS(stylesRoot, NS.office, 'automatic-styles')[0] ?? null);
  }
  reader.loadStyles(childrenNS(content.documentElement, NS.office, 'automatic-styles')[0] ?? null);
  reader.initDefaults();

  const body = childrenNS(content.documentElement, NS.office, 'body')[0];
  const textEl = body ? childrenNS(body, NS.office, 'text')[0] : undefined;
  const html = textEl ? reader.blocks(textEl, { top: true, th: false }) : '';

  // title
  let title: string | undefined;
  if (metaStr) {
    try {
      const meta = parseXml(metaStr);
      const t = meta.getElementsByTagNameNS(NS.dc, 'title')[0]?.textContent?.trim();
      if (t) title = t;
    } catch {
      /* ignore malformed meta */
    }
  }

  return { html: html || '<p></p>', title, pageSetup: stylesRoot ? readPageSetup(stylesRoot) : undefined };
};

function readPageSetup(root: Element): PageSetup | undefined {
  const master = root.getElementsByTagNameNS(NS.style, 'master-page');
  let layoutName: string | null = null;
  for (const m of Array.from(master)) {
    if (attr(m, NS.style, 'name') === 'Standard' || !layoutName) layoutName = attr(m, NS.style, 'page-layout-name');
    if (attr(m, NS.style, 'name') === 'Standard') break;
  }
  const layouts = Array.from(root.getElementsByTagNameNS(NS.style, 'page-layout'));
  const layout = layouts.find((l) => attr(l, NS.style, 'name') === layoutName) ?? layouts[0];
  const props = layout ? childrenNS(layout, NS.style, 'page-layout-properties')[0] : undefined;
  if (!props) return undefined;
  const w = lengthPt(attr(props, NS.fo, 'page-width'));
  const h = lengthPt(attr(props, NS.fo, 'page-height'));
  if (!w || !h) return undefined;
  const margin = lengthPt(attr(props, NS.fo, 'margin')) ?? undefined;
  const side = (s: string) => lengthPt(attr(props, NS.fo, `margin-${s}`)) ?? margin;
  return nearestPageSetup(
    w,
    h,
    { top: side('top'), right: side('right'), bottom: side('bottom'), left: side('left') },
    attr(props, NS.style, 'print-orientation') === 'landscape' && w >= h,
  );
}
