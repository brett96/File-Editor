/**
 * HTML (editor contract, see ../types.ts) → DOCX.
 *
 * The DOM is walked once and mapped onto the `docx` library's object model. Everything
 * here runs in the browser, the Electron renderer and under jsdom/Node (no Buffer use).
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  InternalHyperlink,
  LevelFormat,
  Packer,
  PageBreak,
  PageOrientation,
  Paragraph,
  ShadingType,
  Tab,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  VerticalMergeType,
  WidthType,
  type ILevelsOptions,
  type IParagraphOptions,
  type IRunOptions,
  type ITableCellOptions,
  type NumberingDefinition,
  type ParagraphChild,
} from 'docx';
import { cssColorToHex, cssLengthToPt, imageSize, parseDataUrl, parseHtml, parseStyle, primaryFontFamily } from '../dom';
import { DEFAULT_PAGE_SETUP, PAGE_SIZES, type Exporter, type PageSetup } from '../types';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Align = (typeof AlignmentType)[keyof typeof AlignmentType];
type Block = Paragraph | Table;

const MONO_FONT = 'Consolas';
const BODY_FONT = 'Calibri';
const BODY_SIZE = 22; // half-points
const QUOTE_STYLE = 'Quote';
const CODE_BLOCK_STYLE = 'CodeBlock';
const INLINE_CODE_STYLE = 'InlineCode';
const INDENT_STEP = 720; // twips per list / quote level
const CELL_PADDING = 230; // twips taken by the default left+right cell margins (+ borders)
const MAX_LEVEL = 8;

// ── inline formatting ────────────────────────────────────────────────────────

interface RunFmt {
  bold?: boolean;
  italics?: boolean;
  underline?: boolean;
  strike?: boolean;
  sub?: boolean;
  sup?: boolean;
  code?: boolean;
  link?: boolean;
  /** "RRGGBB" */
  color?: string;
  font?: string;
  /** half-points */
  size?: number;
  /** "RRGGBB" */
  highlight?: string;
}

function runProps(fmt: RunFmt): Mutable<IRunOptions> {
  const o: Mutable<IRunOptions> = {};
  if (fmt.bold) o.bold = true;
  if (fmt.italics) o.italics = true;
  if (fmt.underline) o.underline = { type: UnderlineType.SINGLE };
  if (fmt.strike) o.strike = true;
  if (fmt.sub) o.subScript = true;
  else if (fmt.sup) o.superScript = true;
  if (fmt.color) o.color = fmt.color;
  if (fmt.font) o.font = fmt.font;
  if (fmt.size) o.size = fmt.size;
  // Run shading rather than w:highlight: highlight only knows 16 named colours.
  if (fmt.highlight) o.shading = { type: ShadingType.CLEAR, color: 'auto', fill: fmt.highlight };
  if (fmt.link) {
    o.style = 'Hyperlink';
    if (fmt.code && !o.font) o.font = MONO_FONT;
  } else if (fmt.code) {
    o.style = INLINE_CODE_STYLE;
  }
  return o;
}

/** Applies the formatting an inline element contributes on top of the inherited one. */
function inlineFmt(el: Element, tag: string, base: RunFmt): RunFmt {
  const fmt: RunFmt = { ...base };
  switch (tag) {
    case 'strong':
    case 'b':
      fmt.bold = true;
      break;
    case 'em':
    case 'i':
      fmt.italics = true;
      break;
    case 'u':
    case 'ins':
      fmt.underline = true;
      break;
    case 's':
    case 'strike':
    case 'del':
      fmt.strike = true;
      break;
    case 'sub':
      fmt.sub = true;
      fmt.sup = false;
      break;
    case 'sup':
      fmt.sup = true;
      fmt.sub = false;
      break;
    case 'code':
    case 'kbd':
    case 'samp':
    case 'tt':
      fmt.code = true;
      break;
    case 'mark':
      fmt.highlight = (
        cssColorToHex(el.getAttribute('data-color')) ??
        cssColorToHex(parseStyle(el)['background-color']) ??
        'ffff00'
      ).toUpperCase();
      break;
    default:
      break;
  }
  const style = parseStyle(el);
  if (Object.keys(style).length) {
    const color = cssColorToHex(style['color']);
    if (color) fmt.color = color.toUpperCase();
    const font = primaryFontFamily(style['font-family']);
    if (font) fmt.font = font;
    const pt = cssLengthToPt(style['font-size']);
    if (pt && pt > 0) fmt.size = Math.max(2, Math.min(3276, Math.round(pt * 2)));
    if (tag !== 'mark') {
      const bg = cssColorToHex(style['background-color'] ?? style['background']);
      if (bg) fmt.highlight = bg.toUpperCase();
    }
    const weight = style['font-weight'];
    if (weight) {
      if (/^(bold|bolder|[6-9]00)$/i.test(weight)) fmt.bold = true;
      else if (/^(normal|lighter|[1-4]00)$/i.test(weight)) fmt.bold = false;
    }
    const fs = style['font-style'];
    if (fs) fmt.italics = /italic|oblique/i.test(fs);
    const deco = style['text-decoration'] ?? style['text-decoration-line'];
    if (deco) {
      if (/underline/i.test(deco)) fmt.underline = true;
      if (/line-through/i.test(deco)) fmt.strike = true;
    }
    const va = style['vertical-align'];
    if (va === 'sub') fmt.sub = true;
    else if (va === 'super') fmt.sup = true;
  }
  return fmt;
}

// ── export state ─────────────────────────────────────────────────────────────

type LevelKind = 'b' | '1' | 'a' | 'A' | 'i' | 'I';

interface ListPlan {
  kinds: (LevelKind | undefined)[];
  starts: number[];
  instance: number;
  reference: string;
}

interface Marker {
  numbering: { reference: string; level: number; instance: number };
  consumed: boolean;
}

interface BlockCtx {
  align?: Align;
  quoteDepth: number;
  /** Extra left indent (twips) for continuation paragraphs inside list items. */
  indent: number;
  /** Pending list marker: the next paragraph created becomes the numbered/bulleted one. */
  marker?: Marker;
  /** Base run formatting (e.g. bold in header cells). */
  fmt: RunFmt;
  /** Available text width in twips. */
  width: number;
  inCell: boolean;
}

interface State {
  numbering: Map<string, NumberingDefinition>;
  listPlans: Map<Element, { plan: ListPlan; depth: number }>;
  nextInstance: number;
  pendingPageBreak: boolean;
  /** Text-area height in twips (images are scaled to fit). */
  textHeight: number;
  imageCount: number;
}

// ── inline content ───────────────────────────────────────────────────────────

class InlineBuilder {
  readonly children: ParagraphChild[] = [];
  private target: ParagraphChild[] = this.children;
  /** True while the last emitted character is collapsible white space (or nothing was emitted yet). */
  private trailingSpace = true;

  constructor(
    private readonly bc: BlockCtx,
    private readonly st: State,
  ) {}

  text(raw: string, fmt: RunFmt): void {
    let text = raw.replace(/[ \t\r\n\f]+/g, ' ');
    if (this.trailingSpace && text.startsWith(' ')) text = text.slice(1);
    if (!text) return;
    this.trailingSpace = text.endsWith(' ');
    this.target.push(new TextRun({ ...runProps(fmt), text }));
  }

  lineBreak(fmt: RunFmt): void {
    this.target.push(new TextRun({ ...runProps(fmt), break: 1 }));
    this.trailingSpace = true;
  }

  node(node: Node, fmt: RunFmt): void {
    if (node.nodeType === 3) {
      this.text(node.nodeValue ?? '', fmt);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'br':
        this.lineBreak(fmt);
        return;
      case 'img':
        this.image(el, fmt);
        return;
      case 'a':
        this.link(el, fmt);
        return;
      case 'script':
      case 'style':
      case 'template':
      case 'noscript':
        return;
      default:
        this.nodes(el.childNodes, inlineFmt(el, tag, fmt));
    }
  }

  nodes(nodes: Iterable<Node>, fmt: RunFmt): void {
    for (const n of Array.from(nodes)) this.node(n, fmt);
  }

  private link(el: Element, fmt: RunFmt): void {
    const href = (el.getAttribute('href') ?? '').trim();
    const inner = inlineFmt(el, 'a', fmt);
    if (fmt.link || !href || href === '#' || /^\s*(javascript|vbscript):/i.test(href)) {
      this.nodes(el.childNodes, inner);
      return;
    }
    const saved = this.target;
    const runs: ParagraphChild[] = [];
    this.target = runs;
    this.nodes(el.childNodes, { ...inner, link: true });
    this.target = saved;
    if (!runs.length) return;
    saved.push(
      href.startsWith('#')
        ? new InternalHyperlink({ anchor: href.slice(1), children: runs })
        : new ExternalHyperlink({ link: href, children: runs }),
    );
  }

  private image(el: Element, fmt: RunFmt): void {
    const data = parseDataUrl(el.getAttribute('src') ?? '');
    if (!data || !data.bytes.length) return;
    const type = sniffImageType(data.bytes);
    if (!type) return;
    let intrinsic: { width: number; height: number } | null = null;
    try {
      intrinsic = imageSize(data.bytes);
    } catch {
      intrinsic = null;
    }
    if (intrinsic && !(intrinsic.width > 0 && intrinsic.height > 0)) intrinsic = null;
    const style = parseStyle(el);
    let w = pxLength(el.getAttribute('width')) ?? pxLength(style['width']);
    let h = pxLength(el.getAttribute('height')) ?? pxLength(style['height']);
    if (w && !h) h = intrinsic ? (w * intrinsic.height) / intrinsic.width : null;
    else if (h && !w) w = intrinsic ? (h * intrinsic.width) / intrinsic.height : null;
    else if (!w && !h && intrinsic) {
      w = intrinsic.width;
      h = intrinsic.height;
    }
    if (!w || !h) return; // size unknown → cannot be placed
    // 1 px = 15 twips. Scale down (never up) to fit the available text area.
    const maxW = Math.max(16, this.bc.width / 15);
    const maxH = Math.max(16, this.st.textHeight / 15);
    const scale = Math.min(1, maxW / w, maxH / h);
    const width = Math.max(1, Math.round(w * scale));
    const height = Math.max(1, Math.round(h * scale));
    const alt = el.getAttribute('alt') ?? '';
    const n = ++this.st.imageCount;
    try {
      this.target.push(
        new ImageRun({
          type,
          data: data.bytes,
          transformation: { width, height },
          altText: { name: `Picture ${n}`, description: alt, title: el.getAttribute('title') ?? '' },
        }),
      );
      this.trailingSpace = false;
    } catch {
      /* undecodable image → skipped */
    }
    void fmt;
  }
}

function sniffImageType(b: Uint8Array): 'png' | 'jpg' | 'gif' | 'bmp' | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  return null;
}

/** Parses an absolute length ("120", "120px", "2in") to px; percentages / auto → null. */
function pxLength(value: string | null | undefined): number | null {
  if (!value || /%|em$/i.test(value.trim())) return null;
  const pt = cssLengthToPt(value);
  return pt && pt > 0 ? pt / 0.75 : null;
}

// ── blocks ───────────────────────────────────────────────────────────────────

const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'hr', 'ul', 'ol', 'li', 'table', 'thead', 'tbody',
  'tfoot', 'tr', 'td', 'th', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure',
  'figcaption', 'address', 'details', 'summary', 'dl', 'dt', 'dd', 'form', 'fieldset', 'center', 'caption',
]);
const SKIP_TAGS = new Set(['script', 'style', 'template', 'noscript', 'head', 'title', 'meta', 'link', 'colgroup', 'col']);

const HEADINGS = {
  h1: HeadingLevel.HEADING_1,
  h2: HeadingLevel.HEADING_2,
  h3: HeadingLevel.HEADING_3,
  h4: HeadingLevel.HEADING_4,
  h5: HeadingLevel.HEADING_5,
  h6: HeadingLevel.HEADING_6,
} as const;

function alignOf(el: Element): Align | undefined {
  const v = (parseStyle(el)['text-align'] ?? el.getAttribute('align') ?? '').toLowerCase();
  switch (v) {
    case 'left':
    case 'start':
      return AlignmentType.LEFT;
    case 'center':
      return AlignmentType.CENTER;
    case 'right':
    case 'end':
      return AlignmentType.RIGHT;
    case 'justify':
      return AlignmentType.JUSTIFIED;
    default:
      return undefined;
  }
}

/** Paragraph-level options shared by every paragraph created in a block context. */
function paraOptions(bc: BlockCtx, st: State, el: Element | null, kind: 'text' | 'heading' | 'code'): Mutable<IParagraphOptions> {
  const o: Mutable<IParagraphOptions> = {};
  const align = (el && alignOf(el)) ?? bc.align;
  if (align && kind !== 'code') o.alignment = align;
  let left = bc.indent;
  const numbered = bc.marker && !bc.marker.consumed;
  if (bc.marker && numbered) {
    o.numbering = bc.marker.numbering;
    bc.marker.consumed = true;
    left = 0; // the numbering level supplies the indent
  }
  if (bc.quoteDepth > 0 && kind === 'text') {
    if (!numbered) o.style = QUOTE_STYLE;
    // The Quote style itself indents by one step; deeper nesting needs a direct indent.
    if (bc.quoteDepth > 1 || left > 0) left += INDENT_STEP * bc.quoteDepth;
  } else if (bc.quoteDepth > 0) {
    left += INDENT_STEP * bc.quoteDepth;
  }
  if (left > 0 && !numbered) o.indent = { left };
  if (st.pendingPageBreak && !bc.inCell) {
    o.pageBreakBefore = true;
    st.pendingPageBreak = false;
  }
  return o;
}

function buildParagraph(
  nodes: Iterable<Node>,
  bc: BlockCtx,
  st: State,
  el: Element | null,
  kind: 'text' | 'heading',
  skipIfEmpty: boolean,
  extra?: Partial<IParagraphOptions>,
): Paragraph | null {
  const b = new InlineBuilder(bc, st);
  b.nodes(nodes, bc.fmt);
  if (skipIfEmpty && !b.children.length) return null;
  return new Paragraph({ ...paraOptions(bc, st, el, kind), ...extra, children: b.children });
}

function convertChildren(parent: Element, bc: BlockCtx, st: State, out: Block[]): void {
  let pending: Node[] = [];
  const flush = (): void => {
    if (!pending.length) return;
    // Loose inline content (text directly in <li>/<td>/<div>, top-level <img>) → implicit paragraph.
    const p = buildParagraph(pending, bc, st, null, 'text', true);
    if (p) out.push(p);
    pending = [];
  };
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 3) {
      pending.push(node);
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) continue;
    if (BLOCK_TAGS.has(tag)) {
      flush();
      convertBlock(el, tag, bc, st, out);
    } else {
      pending.push(node);
    }
  }
  flush();
}

function flushPageBreak(st: State, out: Block[]): void {
  if (!st.pendingPageBreak) return;
  st.pendingPageBreak = false;
  out.push(new Paragraph({ children: [new PageBreak()] }));
}

function convertBlock(el: Element, tag: string, bc: BlockCtx, st: State, out: Block[]): void {
  switch (tag) {
    case 'p': {
      const p = buildParagraph(el.childNodes, bc, st, el, 'text', false);
      if (p) out.push(p);
      return;
    }
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const p = buildParagraph(el.childNodes, bc, st, el, 'heading', false, { heading: HEADINGS[tag] });
      if (p) out.push(p);
      return;
    }
    case 'blockquote':
      convertChildren(el, { ...bc, quoteDepth: bc.quoteDepth + 1, align: alignOf(el) ?? bc.align }, st, out);
      return;
    case 'pre':
      convertPre(el, bc, st, out);
      return;
    case 'hr':
      out.push(
        new Paragraph({
          ...paraOptions(bc, st, null, 'code'),
          spacing: { before: 120, after: 120 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 1, color: 'A0A0A0' } },
        }),
      );
      return;
    case 'ul':
    case 'ol':
      convertList(el, bc, st, out);
      return;
    case 'table': {
      if (!bc.inCell) flushPageBreak(st, out);
      const t = convertTable(el, bc, st);
      if (t) out.push(t);
      return;
    }
    case 'div':
      if (el.getAttribute('data-page-break') === 'true') {
        if (bc.inCell) return; // page breaks are meaningless inside table cells
        flushPageBreak(st, out); // two breaks in a row → the first one becomes an explicit break
        st.pendingPageBreak = true;
        return;
      }
      convertChildren(el, { ...bc, align: alignOf(el) ?? bc.align }, st, out);
      return;
    default:
      convertChildren(el, { ...bc, align: alignOf(el) ?? bc.align }, st, out);
  }
}

function preText(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? '';
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  if (el.tagName.toLowerCase() === 'br') return '\n';
  let s = '';
  for (const c of Array.from(el.childNodes)) s += preText(c);
  return s;
}

function convertPre(el: Element, bc: BlockCtx, st: State, out: Block[]): void {
  const text = preText(el).replace(/\r\n?/g, '\n').replace(/\n$/, '');
  for (const line of text.split('\n')) {
    const parts = line.split('\t');
    const children: (string | Tab)[] = [];
    parts.forEach((part, i) => {
      if (i > 0) children.push(new Tab());
      if (part) children.push(part);
    });
    const o = paraOptions(bc, st, null, 'code');
    out.push(
      new Paragraph({
        ...o,
        style: CODE_BLOCK_STYLE,
        children: children.length ? [new TextRun({ children })] : [],
      }),
    );
  }
}

// ── lists ────────────────────────────────────────────────────────────────────

function listKind(el: Element): LevelKind {
  if (el.tagName.toLowerCase() !== 'ol') return 'b';
  const t = el.getAttribute('type') ?? '';
  return t === 'a' || t === 'A' || t === 'i' || t === 'I' ? t : '1';
}

function listStart(el: Element): number {
  const n = parseInt(el.getAttribute('start') ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/**
 * Assigns every list of one list tree a numbering "plan" (= one Word list instance). Nested
 * lists share their parent's plan, one level deeper, unless the level is already taken by a
 * different kind of list — then they start a plan of their own.
 */
function planList(el: Element, depth: number, parent: ListPlan | null, st: State, created: ListPlan[]): void {
  const d = Math.min(depth, MAX_LEVEL);
  const kind = listKind(el);
  let plan = parent;
  if (!plan || (plan.kinds[d] !== undefined && plan.kinds[d] !== kind)) {
    plan = {
      kinds: plan ? plan.kinds.slice(0, d) : [],
      starts: plan ? plan.starts.slice(0, d) : [],
      instance: st.nextInstance++,
      reference: '',
    };
    created.push(plan);
  }
  if (plan.kinds[d] === undefined) {
    plan.kinds[d] = kind;
    plan.starts[d] = kind === 'b' ? 1 : listStart(el);
  }
  st.listPlans.set(el, { plan, depth: d });
  const scan = (node: Element): void => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'ul' || tag === 'ol') planList(child, depth + 1, plan, st, created);
      else if (tag !== 'table') scan(child); // lists inside table cells are independent lists
    }
  };
  for (const li of Array.from(el.children)) scan(li);
}

const BULLETS = ['•', '◦', '▪'];

function finalisePlan(plan: ListPlan, st: State): void {
  const fallback = plan.kinds.find((k) => k !== undefined) ?? 'b';
  const kinds: LevelKind[] = [];
  const starts: number[] = [];
  for (let i = 0; i <= MAX_LEVEL; i++) {
    kinds.push(plan.kinds[i] ?? fallback);
    starts.push(plan.kinds[i] !== undefined ? (plan.starts[i] ?? 1) : 1);
  }
  plan.reference = `list-${kinds.join('')}${starts.some((s) => s !== 1) ? '-' + starts.join('.') : ''}`;
  if (st.numbering.has(plan.reference)) return;
  const levels: ILevelsOptions[] = kinds.map((kind, i) => {
    const paragraph = { indent: { left: INDENT_STEP * (i + 1), hanging: 360 } };
    if (kind === 'b') {
      return {
        level: i,
        format: LevelFormat.BULLET,
        text: BULLETS[i % BULLETS.length],
        alignment: AlignmentType.LEFT,
        style: { paragraph },
      };
    }
    const format =
      kind === 'a' ? LevelFormat.LOWER_LETTER
      : kind === 'A' ? LevelFormat.UPPER_LETTER
      : kind === 'i' ? LevelFormat.LOWER_ROMAN
      : kind === 'I' ? LevelFormat.UPPER_ROMAN
      : LevelFormat.DECIMAL;
    return { level: i, format, text: `%${i + 1}.`, start: starts[i], alignment: AlignmentType.LEFT, style: { paragraph } };
  });
  st.numbering.set(plan.reference, { reference: plan.reference, levels });
}

function convertList(el: Element, bc: BlockCtx, st: State, out: Block[]): void {
  let entry = st.listPlans.get(el);
  if (!entry) {
    const created: ListPlan[] = [];
    planList(el, 0, null, st, created);
    for (const plan of created) finalisePlan(plan, st);
    entry = st.listPlans.get(el)!;
  }
  const { plan, depth } = entry;
  // A parent <li> that has no text of its own still needs its (empty) item paragraph,
  // otherwise the nested items would lose their parent level.
  if (bc.marker && !bc.marker.consumed) out.push(new Paragraph(paraOptions(bc, st, null, 'text')));
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag !== 'li') {
      if (BLOCK_TAGS.has(tag)) convertBlock(child, tag, bc, st, out);
      continue;
    }
    const marker: Marker = {
      numbering: { reference: plan.reference, level: depth, instance: plan.instance },
      consumed: false,
    };
    const itemCtx: BlockCtx = {
      ...bc,
      align: alignOf(child) ?? bc.align,
      marker,
      indent: INDENT_STEP * (depth + 1),
    };
    convertChildren(child, itemCtx, st, out);
    if (!marker.consumed) out.push(new Paragraph(paraOptions(itemCtx, st, null, 'text')));
  }
}

// ── tables ───────────────────────────────────────────────────────────────────

interface GridCell {
  el: Element;
  row: number;
  col: number;
  colspan: number;
  rowspan: number;
}

function tableRows(table: Element): Element[] {
  const rows: Element[] = [];
  for (const child of Array.from(table.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === 'tr') rows.push(child);
    else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
      for (const tr of Array.from(child.children)) if (tr.tagName.toLowerCase() === 'tr') rows.push(tr);
    }
  }
  return rows;
}

function spanAttr(el: Element, name: string, max: number): number {
  const n = parseInt(el.getAttribute(name) ?? '', 10);
  return Number.isFinite(n) && n > 1 ? Math.min(n, max) : 1;
}

function convertTable(table: Element, bc: BlockCtx, st: State): Table | null {
  const trs = tableRows(table);
  if (!trs.length) return null;
  const grid: (GridCell | undefined)[][] = trs.map(() => []);
  trs.forEach((tr, r) => {
    let col = 0;
    for (const cell of Array.from(tr.children)) {
      const tag = cell.tagName.toLowerCase();
      if (tag !== 'td' && tag !== 'th') continue;
      while (grid[r][col]) col++;
      let colspan = spanAttr(cell, 'colspan', 63);
      for (let c = 1; c < colspan; c++) {
        if (grid[r][col + c]) {
          colspan = c;
          break;
        }
      }
      const rowspan = spanAttr(cell, 'rowspan', trs.length - r);
      const gc: GridCell = { el: cell, row: r, col, colspan, rowspan };
      for (let dr = 0; dr < rowspan; dr++) for (let dc = 0; dc < colspan; dc++) grid[r + dr][col + dc] = gc;
      col += colspan;
    }
  });
  const numCols = Math.max(...grid.map((row) => row.length));
  if (!numCols) return null;

  const total = Math.max(numCols * 200, bc.width);
  const colWidth = Math.floor(total / numCols);
  let headerRun = true;
  const rows = trs.map((_, r) => {
    const cells: TableCell[] = [];
    let allHeader = true;
    let real = 0;
    for (let c = 0; c < numCols; ) {
      const gc = grid[r][c];
      if (!gc) {
        cells.push(new TableCell({ children: [new Paragraph({})], width: { size: colWidth, type: WidthType.DXA } }));
        allHeader = false;
        c++;
        continue;
      }
      const width = colWidth * gc.colspan;
      const opts: Mutable<ITableCellOptions> = {
        children: [],
        width: { size: width, type: WidthType.DXA },
      };
      if (gc.colspan > 1) opts.columnSpan = gc.colspan;
      if (gc.row === r) {
        const isHeader = gc.el.tagName.toLowerCase() === 'th';
        if (!isHeader) allHeader = false;
        real++;
        if (gc.rowspan > 1) opts.verticalMerge = VerticalMergeType.RESTART;
        const bg = cssColorToHex(parseStyle(gc.el)['background-color']);
        if (bg) opts.shading = { type: ShadingType.CLEAR, color: 'auto', fill: bg.toUpperCase() };
        const content: Block[] = [];
        const cellCtx: BlockCtx = {
          align: alignOf(gc.el),
          quoteDepth: 0,
          indent: 0,
          fmt: isHeader ? { bold: true } : {},
          width: Math.max(300, width - CELL_PADDING),
          inCell: true,
        };
        convertChildren(gc.el, cellCtx, st, content);
        opts.children = finishBlocks(content);
      } else {
        // continuation of a cell merged from a row above
        opts.verticalMerge = VerticalMergeType.CONTINUE;
        opts.children = [new Paragraph({})];
      }
      cells.push(new TableCell(opts));
      c += gc.colspan;
    }
    headerRun = headerRun && allHeader && real > 0;
    return new TableRow({ children: cells, ...(headerRun ? { tableHeader: true } : {}) });
  });

  return new Table({
    rows,
    width: { size: colWidth * numCols, type: WidthType.DXA },
    columnWidths: Array.from({ length: numCols }, () => colWidth),
  });
}

/**
 * Word needs a paragraph between two adjacent tables (else they merge) and after the last
 * table of a container; an empty container needs one paragraph.
 */
function finishBlocks(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b instanceof Table && out.length && out[out.length - 1] instanceof Table) out.push(new Paragraph({}));
    out.push(b);
  }
  if (!out.length || out[out.length - 1] instanceof Table) out.push(new Paragraph({}));
  return out;
}

// ── document ─────────────────────────────────────────────────────────────────

function normalisePageSetup(setup: PageSetup | undefined): PageSetup {
  const s = setup ?? DEFAULT_PAGE_SETUP;
  const size = PAGE_SIZES[s.size] ? s.size : DEFAULT_PAGE_SETUP.size;
  const m = s.margins ?? DEFAULT_PAGE_SETUP.margins;
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  return {
    size,
    orientation: s.orientation === 'landscape' ? 'landscape' : 'portrait',
    margins: {
      top: num(m.top, 72),
      right: num(m.right, 72),
      bottom: num(m.bottom, 72),
      left: num(m.left, 72),
    },
  };
}

const twips = (pt: number): number => Math.round(pt * 20);

function headingStyle(size: number, before: number) {
  return {
    run: { bold: true, size, color: '000000' },
    paragraph: { spacing: { before, after: 80 }, keepNext: true, keepLines: true },
  };
}

export const exportDocx: Exporter = async (doc) => {
  const setup = normalisePageSetup(doc.pageSetup);
  const portrait = PAGE_SIZES[setup.size];
  const landscape = setup.orientation === 'landscape';
  const pageW = twips(landscape ? portrait.height : portrait.width);
  const pageH = twips(landscape ? portrait.width : portrait.height);
  const margin = {
    top: twips(setup.margins.top),
    right: twips(setup.margins.right),
    bottom: twips(setup.margins.bottom),
    left: twips(setup.margins.left),
  };

  const st: State = {
    numbering: new Map(),
    listPlans: new Map(),
    nextInstance: 1,
    pendingPageBreak: false,
    textHeight: Math.max(1440, pageH - margin.top - margin.bottom),
    imageCount: 0,
  };
  const root: BlockCtx = {
    quoteDepth: 0,
    indent: 0,
    fmt: {},
    width: Math.max(1440, pageW - margin.left - margin.right),
    inCell: false,
  };

  const blocks: Block[] = [];
  convertChildren(parseHtml(doc.html ?? ''), root, st, blocks);
  flushPageBreak(st, blocks);
  const children = blocks.length ? finishBlocksTopLevel(blocks) : [new Paragraph({})];

  const file = new Document({
    title: doc.title || undefined,
    creator: 'File Editor',
    lastModifiedBy: 'File Editor',
    styles: {
      default: {
        document: {
          run: { font: BODY_FONT, size: BODY_SIZE },
          paragraph: { spacing: { after: 160, line: 259 } },
        },
        heading1: headingStyle(40, 360),
        heading2: headingStyle(32, 280),
        heading3: headingStyle(28, 240),
        heading4: headingStyle(24, 200),
        heading5: headingStyle(22, 200),
        heading6: headingStyle(20, 200),
        listParagraph: { paragraph: { contextualSpacing: true } },
      },
      paragraphStyles: [
        {
          id: QUOTE_STYLE,
          name: 'Quote',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { italics: true, color: '404040' },
          paragraph: {
            indent: { left: INDENT_STEP, right: INDENT_STEP },
            border: { left: { style: BorderStyle.SINGLE, size: 18, space: 8, color: 'BFBFBF' } },
          },
        },
        {
          id: CODE_BLOCK_STYLE,
          name: 'Code Block',
          basedOn: 'Normal',
          quickFormat: true,
          run: { font: MONO_FONT, size: 20 },
          paragraph: {
            spacing: { before: 0, after: 0, line: 240 },
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F2F2F2' },
          },
        },
      ],
      characterStyles: [
        {
          id: INLINE_CODE_STYLE,
          name: 'Inline Code',
          basedOn: 'DefaultParagraphFont',
          quickFormat: true,
          run: { font: MONO_FONT },
        },
      ],
    },
    numbering: { config: Array.from(st.numbering.values()) },
    sections: [
      {
        properties: {
          page: {
            size: {
              // docx swaps width/height itself for landscape, so always pass portrait values
              width: twips(portrait.width),
              height: twips(portrait.height),
              orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
            },
            margin: { ...margin, header: 708, footer: 708, gutter: 0 },
          },
        },
        children,
      },
    ],
  });

  return new Uint8Array(await Packer.toArrayBuffer(file));
};

/** Like finishBlocks, but the body may end with a table. */
function finishBlocksTopLevel(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b instanceof Table && out.length && out[out.length - 1] instanceof Table) out.push(new Paragraph({}));
    out.push(b);
  }
  return out;
}
