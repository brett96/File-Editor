/**
 * DOCX → HTML (editor contract, see ../types.ts).
 *
 * A hand-written WordprocessingML reader: unzip, parse the main document part plus styles,
 * numbering, relationships, theme and core properties, then walk the body and emit HTML.
 * Elements are matched by local name, so both the transitional and the strict OOXML
 * namespaces work. Unknown elements are skipped, never fatal.
 */
import JSZip from 'jszip';
import { cssLengthToPt, decodeText, escapeHtml, parseXml, toDataUrl } from '../dom';
import { packDrawingMl, readThemeColors, renderGraphic, renderGraphicSvg, type RenderEnv, type ThemeColors } from './drawingml-render';
import { CSS_LINE_PER_WORD_LINE, DEFAULT_HF_DISTANCE, DEFAULT_PAGE_SETUP, PAGE_SIZES, type Importer, type PageSetup, type PageSize, type RichDocument } from '../types';

// ── XML helpers ──────────────────────────────────────────────────────────────

function kids(el: Element | null | undefined, name?: string): Element[] {
  if (!el) return [];
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!name || (n as Element).localName === name)) out.push(n as Element);
  }
  return out;
}

function kid(el: Element | null | undefined, name: string): Element | null {
  if (!el) return null;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).localName === name) return n as Element;
  }
  return null;
}

/** Attribute by local name (prefix-agnostic: w:val, w14:val, val …). */
function attr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    if (attrs[i].localName === name) return attrs[i].value;
  }
  return null;
}

/** Attribute in the relationships namespace (r:id, r:embed, …). */
function relAttr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  const attrs = el.attributes;
  let fallback: string | null = null;
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i];
    if (a.localName !== name) continue;
    if ((a.namespaceURI ?? '').includes('relationships') || a.prefix === 'r') return a.value;
    if (!a.prefix) fallback = a.value;
  }
  return fallback;
}

function val(parent: Element | null | undefined, name: string): string | null {
  return attr(kid(parent, name), 'val');
}

function intAttr(el: Element | null | undefined, name: string): number | null {
  const v = attr(el, name);
  if (v === null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** OOXML on/off element: present without value = on. */
function toggle(parent: Element | null | undefined, name: string): boolean | undefined {
  const el = kid(parent, name);
  if (!el) return undefined;
  const v = attr(el, 'val');
  return !(v === '0' || v === 'false' || v === 'off');
}

function descendant(el: Element | null | undefined, name: string): Element | null {
  if (!el) return null;
  for (const c of kids(el)) {
    if (c.localName === name) return c;
    const d = descendant(c, name);
    if (d) return d;
  }
  return null;
}

// Markup-compatibility: namespaces (by conventional prefix) whose content we can read.
const MC_SUPPORTED = new Set([
  'wps', 'wpg', 'wpc', 'wp14', 'w14', 'w15', 'w16', 'w16se', 'w16cid', 'w16cex', 'w16sdtdh', 'w16du', 'a14', 'pic14',
  'v', 'o', 'w10',
]);

/** Picks the branch of an mc:AlternateContent to read (never both → no duplicated text). */
function mcBranch(ac: Element): Element | null {
  for (const c of kids(ac)) {
    if (c.localName === 'Choice') {
      const req = (attr(c, 'Requires') ?? '').split(/\s+/).filter(Boolean);
      if (req.every((p) => MC_SUPPORTED.has(p))) return c;
    } else if (c.localName === 'Fallback') {
      return c;
    }
  }
  return null;
}

/** Collects descendants with one of the given local names; does not look inside matches. */
function collect(el: Element, names: Set<string>, out: Element[] = []): Element[] {
  for (const c of kids(el)) {
    if (c.localName === 'AlternateContent') {
      const b = mcBranch(c);
      if (b) collect(b, names, out);
    } else if (names.has(c.localName)) {
      out.push(c);
    } else {
      collect(c, names, out);
    }
  }
  return out;
}

// ── run / paragraph properties ───────────────────────────────────────────────

interface RunProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  caps?: boolean;
  vanish?: boolean;
  vert?: 'sub' | 'sup' | 'none';
  /** "rrggbb"; null = auto */
  color?: string | null;
  highlight?: string | null;
  shade?: string | null;
  font?: string;
  /** half-points */
  size?: number;
  rStyle?: string;
}

interface ParaProps {
  styleId?: string;
  align?: string;
  numId?: string;
  ilvl?: number;
  outlineLvl?: number;
  indLeft?: number;
  /** First-line indent in twips; negative = hanging. */
  indFirst?: number;
  pageBreakBefore?: boolean;
  border?: boolean;
  /** Space before / after in twips. */
  before?: number;
  after?: number;
  /** Line spacing: 240ths of a line ("auto") or twips ("exact" / "atLeast"). */
  line?: number;
  lineRule?: 'auto' | 'exact' | 'atLeast';
  /** Paragraph shading "rrggbb"; null = none. */
  shade?: string | null;
}

interface ThemeFonts {
  major?: string;
  minor?: string;
}

const HIGHLIGHT_COLORS: Record<string, string> = {
  black: '000000', blue: '0000ff', cyan: '00ffff', green: '00ff00', magenta: 'ff00ff', red: 'ff0000',
  yellow: 'ffff00', white: 'ffffff', darkblue: '000080', darkcyan: '008080', darkgreen: '008000',
  darkmagenta: '800080', darkred: '800000', darkyellow: '808000', darkgray: '808080', lightgray: 'c0c0c0',
};

function hexColor(v: string | null): string | null | undefined {
  if (v === null) return undefined;
  if (/^[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  return /^auto$/i.test(v) ? null : undefined;
}

function parseRPr(rPr: Element | null, theme: ThemeFonts): RunProps {
  const p: RunProps = {};
  if (!rPr) return p;
  for (const el of kids(rPr)) {
    const v = attr(el, 'val');
    const on = !(v === '0' || v === 'false' || v === 'off');
    switch (el.localName) {
      case 'rStyle':
        if (v) p.rStyle = v;
        break;
      case 'b':
        p.bold = on;
        break;
      case 'i':
        p.italic = on;
        break;
      case 'u':
        p.underline = !!v && v !== 'none';
        break;
      case 'strike':
      case 'dstrike':
        p.strike = on || (p.strike ?? false);
        break;
      case 'caps':
        p.caps = on;
        break;
      case 'vanish':
        p.vanish = on;
        break;
      case 'vertAlign':
        p.vert = v === 'superscript' ? 'sup' : v === 'subscript' ? 'sub' : 'none';
        break;
      case 'color': {
        const c = hexColor(v);
        if (c !== undefined) p.color = c;
        break;
      }
      case 'highlight':
        if (v) p.highlight = v === 'none' ? null : (HIGHLIGHT_COLORS[v.toLowerCase()] ?? null);
        break;
      case 'shd': {
        const fill = hexColor(attr(el, 'fill'));
        p.shade = fill ?? null;
        break;
      }
      case 'rFonts': {
        const themed = attr(el, 'asciiTheme') ?? attr(el, 'hAnsiTheme');
        // eastAsia / cs fonts only apply to those scripts, never to Latin text
        const font =
          attr(el, 'ascii') ??
          attr(el, 'hAnsi') ??
          (themed ? (/^major/i.test(themed) ? theme.major : theme.minor) : undefined);
        if (font) p.font = font;
        break;
      }
      case 'sz': {
        const n = v ? parseFloat(v) : NaN;
        if (Number.isFinite(n) && n > 0) p.size = n;
        break;
      }
      default:
        break;
    }
  }
  return p;
}

function parsePPr(pPr: Element | null): ParaProps {
  const p: ParaProps = {};
  if (!pPr) return p;
  for (const el of kids(pPr)) {
    const v = attr(el, 'val');
    switch (el.localName) {
      case 'pStyle':
        if (v) p.styleId = v;
        break;
      case 'jc':
        if (v) p.align = v;
        break;
      case 'numPr': {
        const numId = val(el, 'numId');
        if (numId !== null) p.numId = numId;
        const ilvl = intAttr(kid(el, 'ilvl'), 'val');
        if (ilvl !== null) p.ilvl = ilvl;
        break;
      }
      case 'outlineLvl': {
        const n = v ? parseInt(v, 10) : NaN;
        if (Number.isFinite(n)) p.outlineLvl = n;
        break;
      }
      case 'ind': {
        const left = intAttr(el, 'left') ?? intAttr(el, 'start');
        if (left !== null) p.indLeft = left;
        const hanging = intAttr(el, 'hanging');
        const first = intAttr(el, 'firstLine');
        if (hanging !== null) p.indFirst = -hanging;
        else if (first !== null) p.indFirst = first;
        break;
      }
      case 'spacing': {
        const before = intAttr(el, 'before');
        const after = intAttr(el, 'after');
        const line = intAttr(el, 'line');
        if (before !== null && attr(el, 'beforeAutospacing') !== '1') p.before = before;
        if (after !== null && attr(el, 'afterAutospacing') !== '1') p.after = after;
        if (line !== null && line > 0) {
          p.line = line;
          const rule = attr(el, 'lineRule');
          p.lineRule = rule === 'exact' || rule === 'atLeast' ? rule : 'auto';
        }
        break;
      }
      case 'shd': {
        const fill = hexColor(attr(el, 'fill'));
        p.shade = fill ?? null;
        break;
      }
      case 'pageBreakBefore':
        p.pageBreakBefore = !(v === '0' || v === 'false' || v === 'off');
        break;
      case 'pBdr': {
        const visible = (b: Element | null): boolean => {
          const bv = attr(b, 'val');
          return !!b && bv !== 'none' && bv !== 'nil';
        };
        p.border = visible(kid(el, 'bottom')) || visible(kid(el, 'top'));
        break;
      }
      default:
        break;
    }
  }
  return p;
}

function merge<T extends object>(...parts: (T | undefined)[]): T {
  const out = {} as Record<string, unknown>;
  for (const part of parts) {
    if (!part) continue;
    for (const [k, v] of Object.entries(part)) if (v !== undefined) out[k] = v;
  }
  return out as T;
}

// ── styles ───────────────────────────────────────────────────────────────────

interface StyleDef {
  id: string;
  name: string;
  basedOn: string | null;
  rPr: RunProps;
  pPr: ParaProps;
  /** Table styles: the style's own w:tblPr. */
  tblPr: Element | null;
}

interface ResolvedStyle {
  rPr: RunProps;
  pPr: ParaProps;
  /** Normalised ids and names of the style and everything it is based on. */
  keys: string[];
}

const normKey = (s: string): string => s.replace(/[\s_\-]+/g, '').toLowerCase();

const QUOTE_KEYS = new Set(['quote', 'intensequote', 'blocktext', 'quotations', 'blockquote']);
const CODE_BLOCK_KEYS = new Set(['codeblock', 'sourcecode', 'htmlpreformatted', 'preformattedtext', 'code']);
const INLINE_CODE_KEYS = new Set([
  'inlinecode', 'htmlcode', 'verbatimchar', 'sourcetext', 'code', 'codechar', 'htmltypewriter', 'htmlkeyboard',
  'htmlsample',
]);

class StyleSheet {
  private readonly defs = new Map<string, StyleDef>();
  private readonly cache = new Map<string, ResolvedStyle>();
  defaultParaId: string | null = null;
  defaultTableId: string | null = null;
  docRPr: RunProps = {};
  docPPr: ParaProps = {};

  constructor(doc: Document | null, theme: ThemeFonts) {
    const root = doc?.documentElement;
    if (!root) return;
    const defaults = kid(root, 'docDefaults');
    this.docRPr = parseRPr(kid(kid(defaults, 'rPrDefault'), 'rPr'), theme);
    this.docPPr = parsePPr(kid(kid(defaults, 'pPrDefault'), 'pPr'));
    for (const s of kids(root, 'style')) {
      const id = attr(s, 'styleId');
      if (!id) continue;
      const type = attr(s, 'type') ?? 'paragraph';
      this.defs.set(id, {
        id,
        name: val(s, 'name') ?? id,
        basedOn: val(s, 'basedOn'),
        rPr: parseRPr(kid(s, 'rPr'), theme),
        pPr: parsePPr(kid(s, 'pPr')),
        tblPr: type === 'table' ? kid(s, 'tblPr') : null,
      });
      const def = attr(s, 'default');
      const isDefault = def === '1' || def === 'true';
      if (type === 'paragraph' && isDefault && !this.defaultParaId) this.defaultParaId = id;
      if (type === 'table' && isDefault && !this.defaultTableId) this.defaultTableId = id;
    }
  }

  /** Border elements a table style (and the styles it is based on) defines, by side. */
  tableBorders(id: string | null | undefined): Map<string, Element> {
    return this.tableSides(id, 'tblBorders');
  }

  /** Default cell margins (w:tblCellMar) a table style defines, by side. */
  tableCellMargins(id: string | null | undefined): Map<string, Element> {
    return this.tableSides(id, 'tblCellMar');
  }

  private tableSides(id: string | null | undefined, group: string): Map<string, Element> {
    const out = new Map<string, Element>();
    const chain: StyleDef[] = [];
    const seen = new Set<string>();
    for (let cur = id ?? null; cur && !seen.has(cur); ) {
      seen.add(cur);
      const def = this.defs.get(cur);
      if (!def) break;
      chain.push(def);
      cur = def.basedOn;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      for (const b of kids(kid(chain[i].tblPr, group))) out.set(sideName(b.localName), b);
    }
    return out;
  }

  get(id: string): StyleDef | undefined {
    return this.defs.get(id);
  }

  resolve(id: string | null | undefined): ResolvedStyle {
    if (!id) return { rPr: {}, pPr: {}, keys: [] };
    const hit = this.cache.get(id);
    if (hit) return hit;
    const chain: StyleDef[] = [];
    const seen = new Set<string>();
    for (let cur: string | null = id; cur && !seen.has(cur); ) {
      seen.add(cur);
      const def = this.defs.get(cur);
      if (!def) break;
      chain.push(def);
      cur = def.basedOn;
    }
    const keys: string[] = [normKey(id)];
    let rPr: RunProps = {};
    let pPr: ParaProps = {};
    for (let i = chain.length - 1; i >= 0; i--) {
      rPr = merge(rPr, chain[i].rPr);
      pPr = merge(pPr, chain[i].pPr);
    }
    for (const def of chain) keys.push(normKey(def.id), normKey(def.name));
    delete rPr.rStyle;
    delete pPr.styleId;
    const res = { rPr, pPr, keys };
    this.cache.set(id, res);
    return res;
  }
}

function headingLevelOf(keys: string[]): number | null {
  for (const k of keys) {
    const m = /^heading([1-9])$/.exec(k);
    if (m) return Math.min(6, parseInt(m[1], 10));
    if (k === 'title') return 1;
  }
  return null;
}

// ── numbering ────────────────────────────────────────────────────────────────

interface LevelDef {
  fmt: string;
  start: number;
  indent: number | null;
  pStyle: string | null;
}

interface NumDef {
  abstractId: string;
  overrides: Map<number, Partial<LevelDef>>;
  restarts: boolean;
}

class Numbering {
  private readonly abstracts = new Map<string, { levels: Map<number, LevelDef>; styleLink: string | null }>();
  private readonly nums = new Map<string, NumDef>();

  constructor(
    doc: Document | null,
    private readonly styles: StyleSheet,
  ) {
    const root = doc?.documentElement;
    if (!root) return;
    for (const a of kids(root, 'abstractNum')) {
      const id = attr(a, 'abstractNumId');
      if (id === null) continue;
      const levels = new Map<number, LevelDef>();
      for (const lvl of kids(a, 'lvl')) {
        const ilvl = intAttr(lvl, 'ilvl');
        if (ilvl !== null) levels.set(ilvl, Numbering.parseLevel(lvl));
      }
      this.abstracts.set(id, { levels, styleLink: val(a, 'numStyleLink') });
    }
    for (const n of kids(root, 'num')) {
      const id = attr(n, 'numId');
      const abstractId = val(n, 'abstractNumId');
      if (id === null || abstractId === null) continue;
      const overrides = new Map<number, Partial<LevelDef>>();
      let restarts = false;
      for (const o of kids(n, 'lvlOverride')) {
        const ilvl = intAttr(o, 'ilvl');
        if (ilvl === null) continue;
        const lvl = kid(o, 'lvl');
        const ov: Partial<LevelDef> = lvl ? Numbering.parseLevel(lvl) : {};
        const startOverride = intAttr(kid(o, 'startOverride'), 'val');
        if (startOverride !== null) {
          ov.start = startOverride;
          restarts = true;
        }
        overrides.set(ilvl, ov);
      }
      this.nums.set(id, { abstractId, overrides, restarts });
    }
  }

  private static parseLevel(lvl: Element): LevelDef {
    const fmtEl = kid(lvl, 'numFmt') ?? descendant(lvl, 'numFmt');
    return {
      fmt: attr(fmtEl, 'val') ?? 'decimal',
      start: intAttr(kid(lvl, 'start'), 'val') ?? 1,
      indent: intAttr(kid(kid(lvl, 'pPr'), 'ind'), 'left') ?? intAttr(kid(kid(lvl, 'pPr'), 'ind'), 'start'),
      pStyle: val(lvl, 'pStyle'),
    };
  }

  private levelsOf(abstractId: string, depth = 0): Map<number, LevelDef> | null {
    const a = this.abstracts.get(abstractId);
    if (!a) return null;
    if (!a.levels.size && a.styleLink && depth < 3) {
      const numId = this.styles.get(a.styleLink)?.pPr.numId;
      const linked = numId ? this.nums.get(numId) : undefined;
      if (linked) return this.levelsOf(linked.abstractId, depth + 1);
    }
    return a.levels;
  }

  has(numId: string): boolean {
    return this.nums.has(numId);
  }

  level(numId: string, ilvl: number): LevelDef | null {
    const num = this.nums.get(numId);
    if (!num) return null;
    const base = this.levelsOf(num.abstractId)?.get(ilvl);
    const ov = num.overrides.get(ilvl);
    if (!base && !ov) return null;
    return merge<LevelDef>({ fmt: 'decimal', start: 1, indent: null, pStyle: null }, base, ov as LevelDef | undefined);
  }

  /** Level whose `w:pStyle` links it to the given paragraph style (numbering applied through a style). */
  levelForStyle(numId: string, styleId: string): number | null {
    const num = this.nums.get(numId);
    const levels = num ? this.levelsOf(num.abstractId) : null;
    if (!levels) return null;
    for (const [ilvl, def] of levels) if (def.pStyle === styleId) return ilvl;
    return null;
  }

  /** Lists that share a counter in Word: same abstract definition unless the w:num restarts. */
  counterKey(numId: string): string {
    const num = this.nums.get(numId);
    return !num || num.restarts ? `n${numId}` : `a${num.abstractId}`;
  }
}

const OL_TYPES: Record<string, string> = {
  lowerLetter: 'a',
  upperLetter: 'A',
  lowerRoman: 'i',
  upperRoman: 'I',
};

// ── relationships & media ────────────────────────────────────────────────────

interface Rel {
  type: string;
  target: string;
  external: boolean;
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

function sniffMime(b: Uint8Array): string | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  return null;
}

function resolvePath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = baseDir ? baseDir.split('/') : [];
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function parseRels(doc: Document | null): Map<string, Rel> {
  const out = new Map<string, Rel>();
  for (const r of kids(doc?.documentElement, 'Relationship')) {
    const id = attr(r, 'Id');
    const target = attr(r, 'Target');
    if (!id || target === null) continue;
    out.set(id, { type: attr(r, 'Type') ?? '', target, external: attr(r, 'TargetMode') === 'External' });
  }
  return out;
}

function sanitizeHref(href: string | null | undefined): string | null {
  const h = (href ?? '').trim();
  if (!h || /^(javascript|vbscript|data):/i.test(h.replace(/[\u0000- ]+/g, ''))) return null;
  return h;
}

// ── inline model ─────────────────────────────────────────────────────────────

interface Fmt {
  b: boolean;
  i: boolean;
  u: boolean;
  s: boolean;
  va: '' | 'sub' | 'sup';
  code: boolean;
  color: string;
  mark: string;
  font: string;
  size: number;
  key: string;
}

type Item =
  | { t: 'text'; raw: string; fmt: Fmt; href: string | null }
  | { t: 'img'; html: string; href: string | null }
  | { t: 'pagebreak' };

function makeFmt(p: RunProps, base: RunProps, code: boolean, noBold: boolean): Fmt {
  const f: Omit<Fmt, 'key'> = {
    b: !!p.bold && !base.bold && !noBold,
    i: !!p.italic && !base.italic,
    u: !!p.underline && !base.underline,
    s: !!p.strike && !base.strike,
    va: p.vert === 'sub' || p.vert === 'sup' ? p.vert : '',
    code,
    color: p.color && p.color !== (base.color ?? '000000') ? p.color : '',
    mark: p.highlight ?? p.shade ?? '',
    font: p.font && p.font.toLowerCase() !== (base.font ?? '').toLowerCase() ? p.font : '',
    size: p.size && p.size !== base.size ? p.size : 0,
  };
  return {
    ...f,
    key: [f.b, f.i, f.u, f.s, f.va, f.code, f.color, f.mark, f.font, f.size].join('|'),
  };
}

function cssFont(name: string): string {
  const clean = name.replace(/["<>;]/g, '');
  return /^[A-Za-z][A-Za-z0-9-]*( [A-Za-z][A-Za-z0-9-]*)*$/.test(clean) ? clean : `'${clean.replace(/'/g, '')}'`;
}

function formatPt(halfPoints: number): string {
  return String(Math.round(halfPoints * 5) / 10);
}

function renderText(raw: string, fmt: Fmt): string {
  let html = escapeHtml(raw.replace(/ {2,}/g, (m) => ' ' + ' '.repeat(m.length - 1))).replace(/\n/g, '<br>');
  if (!html) return '';
  if (fmt.code) html = `<code>${html}</code>`;
  const styles: string[] = [];
  if (fmt.color) styles.push(`color:#${fmt.color}`);
  if (fmt.font) styles.push(`font-family:${cssFont(fmt.font)}`);
  if (fmt.size) styles.push(`font-size:${formatPt(fmt.size)}pt`);
  if (styles.length) html = `<span style="${escapeHtml(styles.join('; '))}">${html}</span>`;
  if (fmt.mark) html = `<mark data-color="#${fmt.mark}" style="background-color:#${fmt.mark}">${html}</mark>`;
  if (fmt.va) html = `<${fmt.va}>${html}</${fmt.va}>`;
  if (fmt.s) html = `<s>${html}</s>`;
  if (fmt.u) html = `<u>${html}</u>`;
  if (fmt.i) html = `<em>${html}</em>`;
  if (fmt.b) html = `<strong>${html}</strong>`;
  return html;
}

function renderInline(items: Item[]): string {
  // merge neighbouring runs with identical formatting (Word splits runs arbitrarily)
  const merged: Item[] = [];
  for (const it of items) {
    const last = merged[merged.length - 1];
    if (it.t === 'text' && last && last.t === 'text' && last.href === it.href && last.fmt.key === it.fmt.key) {
      last.raw += it.raw;
    } else if (it.t === 'text') {
      merged.push({ ...it });
    } else {
      merged.push(it);
    }
  }
  let out = '';
  for (let i = 0; i < merged.length; ) {
    const first = merged[i];
    const href = first.t === 'pagebreak' ? null : first.href;
    let inner = '';
    let j = i;
    for (; j < merged.length; j++) {
      const it = merged[j];
      if (it.t === 'pagebreak') {
        if (href !== null) break;
        continue;
      }
      if (it.href !== href) break;
      inner += it.t === 'text' ? renderText(it.raw, it.fmt) : it.html;
    }
    if (j === i) j++;
    out += href && inner ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
    i = j;
  }
  return out;
}

function plainText(items: Item[]): string {
  let s = '';
  for (const it of items) if (it.t === 'text') s += it.raw;
  return s;
}

// ── symbols ──────────────────────────────────────────────────────────────────

const SYMBOL_FONTS: Record<string, Record<number, string>> = {
  symbol: {
    0xb7: '•', 0xa8: '♦', 0xae: '→', 0xac: '←', 0xb1: '±', 0xb4: '×', 0xb8: '÷',
    0xa3: '≤', 0xb3: '≥', 0xb9: '≠', 0xa5: '∞', 0xb0: '°', 0xd3: '©', 0xd2: '®',
    0xd4: '™', 0xbc: '…', 0x61: 'α', 0x62: 'β', 0x67: 'γ', 0x64: 'δ', 0x70: 'π',
    0x6d: 'μ', 0x53: 'Σ', 0x57: 'Ω', 0x44: 'Δ',
  },
  wingdings: {
    0xfc: '✓', 0xfb: '✗', 0xfe: '☑', 0xa8: '◻', 0x6f: '□', 0x71: '❑', 0xa7: '▪',
    0x6c: '●', 0x6e: '■', 0x9f: '•', 0xe0: '→', 0xdf: '←', 0xe8: '➔', 0xd8: '➢',
    0x76: '❖', 0x4a: '☺', 0x2a: '✉', 0x28: '☎', 0xab: '★',
  },
};

function symbolChar(font: string | null, charHex: string | null): string {
  let code = parseInt(charHex ?? '', 16);
  if (!Number.isFinite(code)) return '';
  if (code >= 0xf000 && code <= 0xf0ff) code -= 0xf000;
  const table = SYMBOL_FONTS[(font ?? '').toLowerCase()];
  if (table) return table[code] ?? '';
  if (/^(wingdings|webdings|marlett)/i.test(font ?? '')) return '';
  try {
    return code >= 0x20 ? String.fromCodePoint(code) : '';
  } catch {
    return '';
  }
}

// ── import context ───────────────────────────────────────────────────────────

interface Field {
  instr: string;
  phase: 'instr' | 'result';
  href: string | null;
}

interface Ctx {
  styles: StyleSheet;
  numbering: Numbering;
  rels: Map<string, Rel>;
  /** rel id → data URL of a web-renderable image */
  media: Map<string, string>;
  theme: ThemeFonts;
  fields: Field[];
  listCounters: Map<string, number[]>;
  /** >0 while inside table cells / text boxes: page breaks are dropped there. */
  nested: number;
  /** Inside a header cell: bold is implied by <th>. */
  noBold: boolean;
  /** Run / paragraph properties of the enclosing table's style (between doc defaults and paragraph styles). */
  tableRPr: RunProps;
  tablePPr: ParaProps;
  /** Set while converting a header / footer part. */
  hf: HeaderFooterCtx | null;
  /** Body-level DrawingML shape jobs (resolved after the body HTML is built). */
  art: ArtJob[] | null;
}

/** Page geometry in px, for placing header / footer drawings on the page. */
interface PageGeom {
  w: number;
  h: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
  header: number;
  footer: number;
}

interface ArtJob {
  graphicData: Element;
  cx: number;
  cy: number;
  x: number;
  y: number;
  behind: boolean;
  name: string;
}

interface HeaderFooterCtx {
  kind: 'header' | 'footer';
  geom: PageGeom;
  /** Shape groups to render once the part has been converted (rendering is asynchronous). */
  jobs: ArtJob[];
}

interface ParaCtx {
  items: Item[];
  /** Block HTML to emit after the paragraph (text boxes). */
  after: string[];
  styleRPr: RunProps;
  base: RunProps;
  pre: boolean;
}

function parseHyperlinkInstr(instr: string): string | null {
  const m = /^\s*HYPERLINK\b([\s\S]*)$/i.exec(instr);
  if (!m) return null;
  const tokens: { text: string; quoted: boolean }[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (let t = re.exec(m[1]); t; t = re.exec(m[1])) {
    if (t[1] !== undefined) tokens.push({ text: t[1].replace(/\\(.)/g, '$1'), quoted: true });
    else tokens.push({ text: t[2], quoted: false });
  }
  let url = '';
  let anchor = '';
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.quoted && /^\\[a-z]$/i.test(tok.text)) {
      const sw = tok.text[1].toLowerCase();
      if (sw === 'l') anchor = tokens[++i]?.text ?? '';
      else if (sw === 'o' || sw === 't') i++;
      continue;
    }
    if (!url) url = tok.text;
  }
  return sanitizeHref(url + (anchor ? '#' + anchor : ''));
}

function fieldSuppressed(ctx: Ctx): boolean {
  for (const f of ctx.fields) if (f.phase === 'instr') return true;
  return false;
}

function fieldHref(ctx: Ctx): string | null {
  for (let i = ctx.fields.length - 1; i >= 0; i--) {
    if (ctx.fields[i].phase === 'result' && ctx.fields[i].href) return ctx.fields[i].href;
  }
  return null;
}

function pushText(pc: ParaCtx, raw: string, fmt: Fmt, href: string | null): void {
  if (raw) pc.items.push({ t: 'text', raw, fmt, href });
}

// ── images & drawings ────────────────────────────────────────────────────────

const EMU_PER_PX = 9525;
const DRAWING_PARTS = new Set(['pic', 'txbxContent']);
const VML_PARTS = new Set(['imagedata', 'txbxContent']);

interface FloatPos {
  x: number;
  y: number;
  ink: boolean;
  behind?: boolean;
}

function imgTag(
  src: string,
  width: number | null,
  height: number | null,
  alt: string,
  float?: FloatPos | null,
  drawingml?: string | null,
): string {
  let html = `<img src="${escapeHtml(src)}"`;
  if (width && width > 0) html += ` width="${Math.round(width)}"`;
  if (height && height > 0) html += ` height="${Math.round(height)}"`;
  if (float) {
    html += ` data-float-x="${Math.round(float.x)}" data-float-y="${Math.round(float.y)}"`;
    if (float.ink) html += ' data-ink="true"';
    if (float.behind) html += ' data-behind="true"';
  }
  if (drawingml) html += ` data-drawingml="${drawingml}"`;
  return `${html} alt="${escapeHtml(alt)}">`;
}

// ── drawings on the page (headers / footers) ────────────────────────────────

/** Where an anchored drawing sits on the page (px from the page's top-left corner). */
function pagePosition(anchor: Element, w: number, h: number, hf: HeaderFooterCtx): { x: number; y: number } {
  const g = hf.geom;
  const paraTop = hf.kind === 'header' ? g.header : g.h - g.footer - 20;
  const hArea = (rel: string): [number, number] => {
    switch (rel) {
      case 'page':
        return [0, g.w];
      case 'leftMargin':
      case 'insideMargin':
        return [0, g.left];
      case 'rightMargin':
      case 'outsideMargin':
        return [g.w - g.right, g.w];
      default: // margin, column, character
        return [g.left, g.w - g.right];
    }
  };
  const vArea = (rel: string): [number, number] => {
    switch (rel) {
      case 'page':
        return [0, g.h];
      case 'margin':
        return [g.top, g.h - g.bottom];
      case 'topMargin':
        return [0, g.top];
      case 'bottomMargin':
        return [g.h - g.bottom, g.h];
      default: // paragraph, line
        return [paraTop, paraTop];
    }
  };
  const place = (el: Element | null, [a, b]: [number, number], size: number): number => {
    const off = parseInt(kid(el, 'posOffset')?.textContent ?? '', 10);
    if (Number.isFinite(off)) return a + off / EMU_PER_PX;
    const align = (kid(el, 'align')?.textContent ?? '').trim();
    if (align === 'center') return a + (b - a - size) / 2;
    if (align === 'right' || align === 'bottom' || align === 'outside') return b - size;
    return a;
  };
  const H = kid(anchor, 'positionH');
  const V = kid(anchor, 'positionV');
  return {
    x: place(H, hArea(attr(H, 'relativeFrom') ?? 'column'), w),
    y: place(V, vArea(attr(V, 'relativeFrom') ?? 'paragraph'), h),
  };
}

/**
 * A drawing anchored in a header / footer: a picture becomes a floating image placed on the
 * page; a shape or group of shapes is rendered to a picture later (see resolveArt).
 */
function processPageAnchor(anchor: Element, pc: ParaCtx, ctx: Ctx): boolean {
  const hf = ctx.hf!;
  const ext = kid(anchor, 'extent');
  const cx = intAttr(ext, 'cx') ?? 0;
  const cy = intAttr(ext, 'cy') ?? 0;
  const graphicData = descendant(anchor, 'graphicData');
  const content = graphicData ? kids(graphicData)[0] : null;
  if (!content || cx <= 0 || cy <= 0) return false;
  const w = cx / EMU_PER_PX;
  const h = cy / EMU_PER_PX;
  const { x, y } = pagePosition(anchor, w, h, hf);
  const behindDoc = attr(anchor, 'behindDoc');
  const behind = behindDoc === '1' || behindDoc === 'true';
  const name = attr(kid(anchor, 'docPr'), 'descr') || attr(kid(anchor, 'docPr'), 'name') || '';
  if (content.localName === 'pic') {
    const id = relAttr(descendant(content, 'blip'), 'embed');
    const src = id ? ctx.media.get(id) : undefined;
    if (!src) return true;
    pc.items.push({ t: 'img', html: imgTag(src, w, h, name, { x, y, ink: false, behind }), href: null });
    return true;
  }
  if (content.localName !== 'wgp' && content.localName !== 'wsp') return false;
  pc.items.push({ t: 'img', html: `<img data-art-job="${hf.jobs.length}">`, href: null });
  hf.jobs.push({ graphicData: graphicData!, cx, cy, x, y, behind, name });
  // Shape text is painted into the raster (see drawingml-render); don't also emit it as flow
  // paragraphs or title boxes / badges appear twice and drift off the chrome.
  return true;
}

/**
 * Renders shape groups as SVG (preferred) or raster, and keeps the original DrawingML so save
 * can put editable shapes back into Word.
 */
async function resolveArt(html: string, jobs: ArtJob[], env: RenderEnv): Promise<string> {
  if (!jobs.length) return html;
  const rendered = await Promise.all(
    jobs.map(async (job) => {
      try {
        // Prefer raster when the shape has text — SVG path output does not paint run text yet
        const hasText = !!descendant(job.graphicData, 'txbxContent') || !!descendant(job.graphicData, 'txBody') || !!descendant(job.graphicData, 't');
        const svg = hasText ? null : await renderGraphicSvg(job.graphicData, job.cx, job.cy, env);
        const raster = svg ? null : await renderGraphic(job.graphicData, job.cx, job.cy, env, job.behind);
        const src = svg ?? raster;
        if (!src) return null;
        const drawingml = packDrawingMl(job.graphicData, job.cx, job.cy, env.media);
        return { src, drawingml };
      } catch {
        return null;
      }
    }),
  );
  return html.replace(/<img data-art-job="(\d+)">/g, (_m, i: string) => {
    const job = jobs[Number(i)];
    const art = rendered[Number(i)];
    return job && art
      ? imgTag(art.src, job.cx / EMU_PER_PX, job.cy / EMU_PER_PX, job.name, { x: job.x, y: job.y, ink: false, behind: job.behind }, art.drawingml)
      : '';
  });
}

const FLOAT_H_BASES = new Set(['column', 'margin', 'character', 'insideMargin', 'leftMargin', 'rightMargin', 'outsideMargin']);
const FLOAT_V_BASES = new Set(['paragraph', 'line']);

/**
 * An anchored picture positioned from its paragraph can float over the text in the editor
 * (ink, drawings, template chrome). wrapNone always floats; behind-doc images float even with
 * other wrap modes so backgrounds stay behind the text instead of pushing it around.
 */
function floatPosition(frame: Element | null): FloatPos | null {
  if (!frame || frame.localName !== 'anchor') return null;
  const behindDoc = attr(frame, 'behindDoc');
  const behind = behindDoc === '1' || behindDoc === 'true';
  if (!kid(frame, 'wrapNone') && !behind) return null;
  const h = kid(frame, 'positionH');
  const v = kid(frame, 'positionV');
  if (!FLOAT_H_BASES.has(attr(h, 'relativeFrom') ?? '') || !FLOAT_V_BASES.has(attr(v, 'relativeFrom') ?? '')) return null;
  const off = (el: Element | null): number | null => {
    const n = parseInt(kid(el, 'posOffset')?.textContent ?? '', 10);
    return Number.isFinite(n) ? n / EMU_PER_PX : null;
  };
  const x = off(h);
  const y = off(v);
  if (x === null || y === null) return null;
  return { x, y, ink: /^Ink\b/.test(attr(kid(frame, 'docPr'), 'name') ?? ''), behind };
}

function emuSize(ext: Element | null): { w: number; h: number } | null {
  const cx = intAttr(ext, 'cx');
  const cy = intAttr(ext, 'cy');
  if (!cx || !cy || cx <= 0 || cy <= 0) return null;
  return { w: Math.max(1, Math.round(cx / EMU_PER_PX)), h: Math.max(1, Math.round(cy / EMU_PER_PX)) };
}

function processDrawing(drawing: Element, pc: ParaCtx, ctx: Ctx, href: string | null): void {
  const anchor = kid(drawing, 'anchor');
  if (ctx.hf && anchor && processPageAnchor(anchor, pc, ctx)) return;
  // Body-level shape groups (template badges, rounded title boxes, icons): rasterise like headers
  if (!ctx.hf && anchor && ctx.art && processBodyAnchor(anchor, pc, ctx)) return;
  const parts = collect(drawing, DRAWING_PARTS);
  const pics = parts.filter((p) => p.localName === 'pic');
  const frame = kid(drawing, 'inline') ?? kid(drawing, 'anchor');
  const frameSize = emuSize(kid(frame, 'extent'));
  const docPr = kid(frame, 'docPr');
  for (const part of parts) {
    if (part.localName === 'txbxContent') {
      const html = processBlocks(part, ctx, true);
      if (html) pc.after.push(html);
      continue;
    }
    const blip = descendant(part, 'blip');
    const relId = relAttr(blip, 'embed');
    const src = relId ? ctx.media.get(relId) : undefined;
    if (!src) continue; // linked, missing or not web-renderable (emf/wmf/tiff)
    const own = emuSize(kid(descendant(kid(part, 'spPr'), 'xfrm'), 'ext'));
    const size = pics.length === 1 ? (frameSize ?? own) : (own ?? frameSize);
    const alt = attr(docPr, 'descr') ?? attr(kid(kid(part, 'nvPicPr'), 'cNvPr'), 'descr') ?? '';
    const float = pics.length === 1 ? floatPosition(frame) : null;
    pc.items.push({ t: 'img', html: imgTag(src, size?.w ?? null, size?.h ?? null, alt, float), href: float ? null : href });
  }
}

/**
 * Anchored DrawingML shapes in the body (not just headers): queue a raster job at the
 * paragraph-relative float position so template chrome keeps its layout.
 */
function processBodyAnchor(anchor: Element, pc: ParaCtx, ctx: Ctx): boolean {
  const art = ctx.art!;
  const ext = kid(anchor, 'extent');
  const cx = intAttr(ext, 'cx') ?? 0;
  const cy = intAttr(ext, 'cy') ?? 0;
  const graphicData = descendant(anchor, 'graphicData');
  const content = graphicData ? kids(graphicData)[0] : null;
  if (!content || cx <= 0 || cy <= 0) return false;
  if (content.localName !== 'wgp' && content.localName !== 'wsp') return false;
  const float = floatPosition(anchor);
  const behindDoc = attr(anchor, 'behindDoc');
  const behind = behindDoc === '1' || behindDoc === 'true';
  const name = attr(kid(anchor, 'docPr'), 'descr') || attr(kid(anchor, 'docPr'), 'name') || '';
  const x = float?.x ?? 0;
  const y = float?.y ?? 0;
  pc.items.push({ t: 'img', html: `<img data-art-job="${art.length}">`, href: null });
  art.push({ graphicData: graphicData!, cx, cy, x, y, behind: float?.behind ?? behind, name });
  return true;
}

function vmlSize(el: Element): { w: number; h: number } | null {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const style = cur.getAttribute('style');
    if (!style) continue;
    const w = /(?:^|;)\s*width\s*:\s*([^;]+)/i.exec(style);
    const h = /(?:^|;)\s*height\s*:\s*([^;]+)/i.exec(style);
    const wPt = w ? cssLengthToPt(w[1]) : null;
    const hPt = h ? cssLengthToPt(h[1]) : null;
    if (wPt && hPt) return { w: Math.round(wPt / 0.75), h: Math.round(hPt / 0.75) };
    if (cur.localName === 'pict' || cur.localName === 'object') break;
  }
  return null;
}

function processVml(pict: Element, pc: ParaCtx, ctx: Ctx, href: string | null): void {
  for (const part of collect(pict, VML_PARTS)) {
    if (part.localName === 'txbxContent') {
      const html = processBlocks(part, ctx, true);
      if (html) pc.after.push(html);
      continue;
    }
    const relId = relAttr(part, 'id') ?? attr(part, 'relid');
    const src = relId ? ctx.media.get(relId) : undefined;
    if (!src) continue;
    const size = vmlSize(part);
    pc.items.push({ t: 'img', html: imgTag(src, size?.w ?? null, size?.h ?? null, attr(part, 'title') ?? ''), href });
  }
}

// ── runs & inline content ────────────────────────────────────────────────────

function runText(el: Element): string {
  let text = el.textContent ?? '';
  if (el.getAttribute('xml:space') !== 'preserve') text = text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  return text.replace(/[\r\n]+/g, ' ');
}

function processRunChildren(
  parent: Element,
  pc: ParaCtx,
  ctx: Ctx,
  href: string | null,
  fmt: Fmt,
  props: RunProps,
): void {
  for (const c of kids(parent)) {
    const name = c.localName;
    // field plumbing first: it must be tracked even inside hidden / suppressed runs
    if (name === 'fldChar') {
      const type = attr(c, 'fldCharType');
      if (type === 'begin') ctx.fields.push({ instr: '', phase: 'instr', href: null });
      else if (type === 'separate') {
        const f = ctx.fields[ctx.fields.length - 1];
        if (f) {
          f.phase = 'result';
          f.href = parseHyperlinkInstr(f.instr);
        }
      } else if (type === 'end') ctx.fields.pop();
      continue;
    }
    if (name === 'instrText') {
      const f = ctx.fields[ctx.fields.length - 1];
      if (f && f.phase === 'instr') f.instr += c.textContent ?? '';
      continue;
    }
    if (name === 'AlternateContent') {
      const b = mcBranch(c);
      if (b) processRunChildren(b, pc, ctx, href, fmt, props);
      continue;
    }
    if (fieldSuppressed(ctx) || props.vanish) continue;
    const link = href ?? fieldHref(ctx);
    switch (name) {
      case 't': {
        const text = runText(c);
        pushText(pc, props.caps ? text.toUpperCase() : text, fmt, link);
        break;
      }
      case 'tab':
      case 'ptab':
        pushText(pc, pc.pre ? '\t' : '    ', fmt, link);
        break;
      case 'br': {
        const type = attr(c, 'type');
        if (type === 'page') pc.items.push({ t: 'pagebreak' });
        else if (type === 'column') pushText(pc, ' ', fmt, link);
        else pushText(pc, '\n', fmt, link);
        break;
      }
      case 'cr':
        pushText(pc, '\n', fmt, link);
        break;
      case 'noBreakHyphen':
        pushText(pc, '‑', fmt, link);
        break;
      case 'softHyphen':
        pushText(pc, '­', fmt, link);
        break;
      case 'sym':
        pushText(pc, symbolChar(attr(c, 'font'), attr(c, 'char')), fmt, link);
        break;
      case 'drawing':
        processDrawing(c, pc, ctx, link);
        break;
      case 'pict':
      case 'object':
        processVml(c, pc, ctx, link);
        break;
      default:
        // rPr, delText, lastRenderedPageBreak, footnote/endnote/comment references, … → nothing
        break;
    }
  }
}

function processRun(r: Element, pc: ParaCtx, ctx: Ctx, href: string | null): void {
  const direct = parseRPr(kid(r, 'rPr'), ctx.theme);
  let props = pc.styleRPr;
  let code = false;
  if (direct.rStyle) {
    const cs = ctx.styles.resolve(direct.rStyle);
    if (cs.keys.some((k) => INLINE_CODE_KEYS.has(k))) code = true;
    else if (!cs.keys.some((k) => k.includes('hyperlink') || k === 'internetlink')) props = merge(props, cs.rPr);
  }
  props = merge(props, direct);
  processRunChildren(r, pc, ctx, href, makeFmt(props, pc.base, code, ctx.noBold), props);
}

function processInline(parent: Element, pc: ParaCtx, ctx: Ctx, href: string | null): void {
  for (const c of kids(parent)) {
    switch (c.localName) {
      case 'r':
        processRun(c, pc, ctx, href);
        break;
      case 'hyperlink': {
        const relId = relAttr(c, 'id');
        const rel = relId ? ctx.rels.get(relId) : undefined;
        const anchor = attr(c, 'anchor');
        const target = rel ? rel.target + (anchor ? '#' + anchor : '') : anchor ? '#' + anchor : '';
        processInline(c, pc, ctx, sanitizeHref(target) ?? href);
        break;
      }
      case 'fldSimple':
        processInline(c, pc, ctx, parseHyperlinkInstr(attr(c, 'instr') ?? '') ?? href);
        break;
      case 'sdt':
        processInline(kid(c, 'sdtContent') ?? c, pc, ctx, href);
        break;
      case 'ins':
      case 'moveTo':
      case 'smartTag':
      case 'customXml':
      case 'sdtContent':
      case 'dir':
      case 'bdo':
        processInline(c, pc, ctx, href);
        break;
      case 'AlternateContent': {
        const b = mcBranch(c);
        if (b) processInline(b, pc, ctx, href);
        break;
      }
      case 'oMath':
      case 'oMathPara': {
        // equations: keep the linear text
        const text = (c.textContent ?? '').replace(/\s+/g, ' ');
        if (!fieldSuppressed(ctx)) pushText(pc, text, makeFmt(pc.styleRPr, pc.base, false, ctx.noBold), href);
        break;
      }
      default:
        // pPr, del, moveFrom, bookmarks, proofErr, comment ranges, … → nothing
        break;
    }
  }
}

// ── block output ─────────────────────────────────────────────────────────────

const PAGE_BREAK = '<div data-page-break="true"></div>';

interface OpenList {
  numId: string;
  ilvl: number;
  tag: 'ul' | 'ol';
  indent: number;
}

class BlockWriter {
  private readonly parts: string[] = [];
  private readonly lists: OpenList[] = [];
  private pre: string[] | null = null;
  private quote = false;

  private closeLists(downTo = 0): void {
    while (this.lists.length > downTo) {
      const l = this.lists.pop()!;
      this.parts.push(`</li></${l.tag}>`);
    }
  }

  private closePre(): void {
    if (!this.pre) return;
    this.parts.push(`<pre><code>${escapeHtml(this.pre.join('\n'))}</code></pre>`);
    this.pre = null;
  }

  private closeQuote(): void {
    if (!this.quote) return;
    this.parts.push('</blockquote>');
    this.quote = false;
  }

  block(html: string): void {
    this.closeLists();
    this.closePre();
    this.closeQuote();
    if (html) this.parts.push(html);
  }

  preLine(text: string): void {
    this.closeLists();
    this.closeQuote();
    (this.pre ??= []).push(text);
  }

  quoteBlock(html: string): void {
    this.closeLists();
    this.closePre();
    if (!this.quote) {
      this.parts.push('<blockquote>');
      this.quote = true;
    }
    this.parts.push(html);
  }

  listItem(item: OpenList, attrsForNew: () => string, html: string): void {
    this.closePre();
    this.closeQuote();
    while (this.lists.length && this.lists[this.lists.length - 1].ilvl > item.ilvl) this.closeLists(this.lists.length - 1);
    let top = this.lists[this.lists.length - 1];
    if (top && top.ilvl === item.ilvl) {
      if (top.numId === item.numId && top.tag === item.tag) {
        this.parts.push('</li><li>');
        top.indent = item.indent;
        this.parts.push(html);
        return;
      }
      this.closeLists(this.lists.length - 1);
      top = this.lists[this.lists.length - 1];
    }
    this.parts.push(`<${item.tag}${attrsForNew()}><li>`);
    this.lists.push({ ...item });
    this.parts.push(html);
  }

  /** Unnumbered paragraph indented like the current list item → stays inside that <li>. */
  continuation(indent: number, html: string): boolean {
    if (!this.lists.length || this.pre || this.quote) return false;
    let depth = this.lists.length;
    while (depth > 0 && this.lists[depth - 1].indent > indent + 20) depth--;
    if (!depth) return false;
    this.closeLists(depth);
    this.parts.push(html);
    return true;
  }

  get inList(): boolean {
    return this.lists.length > 0;
  }

  toString(): string {
    this.block('');
    return this.parts.join('');
  }
}

// What the editor shows — and the DOCX exporter writes — when a paragraph sets nothing. Only
// differences from these are spelled out, so a document saved by this app re-opens unchanged.
const EDITOR_FONT = 'Calibri';
const EDITOR_SIZE = 22; // half-points
const HEADING_SIZES = [40, 32, 28, 24, 22, 20];
const HEADING_BEFORE = [360, 280, 240, 200, 200, 200];
const HEADING_AFTER = 80;
const BODY_AFTER = 160;
const DEFAULT_LINE = 259;

function editorBase(heading: number | null): RunProps {
  return heading === null
    ? { size: EDITOR_SIZE, font: EDITOR_FONT, color: '000000' }
    : { size: HEADING_SIZES[heading - 1], font: EDITOR_FONT, color: '000000', bold: true };
}

const pt = (twips: number): string => `${Math.round(twips / 2) / 10}pt`;

/** Paragraph spacing, line height, indents and shading as CSS declarations. */
function paragraphCss(eff: ParaProps, heading: number | null, opts: { spacing: boolean; indent: boolean }): string[] {
  const css: string[] = [];
  if (opts.spacing) {
    const before = eff.before ?? 0;
    const after = eff.after ?? 0;
    const defBefore = heading === null ? 0 : HEADING_BEFORE[heading - 1];
    const defAfter = heading === null ? BODY_AFTER : HEADING_AFTER;
    if (before !== defBefore) css.push(`margin-top:${pt(before)}`);
    if (after !== defAfter) css.push(`margin-bottom:${pt(after)}`);
  }
  const rule = eff.lineRule ?? 'auto';
  const line = eff.line ?? 240;
  if (rule !== 'auto') css.push(`line-height:${pt(line)}`);
  else if (line !== DEFAULT_LINE) css.push(`line-height:${Math.round((line / 240) * CSS_LINE_PER_WORD_LINE * 100) / 100}`);
  if (opts.indent) {
    if (eff.indLeft && eff.indLeft > 0) css.push(`margin-left:${pt(eff.indLeft)}`);
    if (eff.indFirst) css.push(`text-indent:${pt(eff.indFirst)}`);
  }
  if (eff.shade) css.push(`background-color:#${eff.shade}`);
  return css;
}

function styleAttr(decls: string[]): string {
  return decls.length ? ` style="${decls.join('; ')}"` : '';
}

function alignCss(align: string | undefined, styleAlign: string | undefined): string {
  const map = (v: string | undefined): string => {
    switch (v) {
      case 'center':
        return 'center';
      case 'right':
      case 'end':
        return 'right';
      case 'both':
      case 'distribute':
      case 'justify':
        return 'justify';
      case 'left':
      case 'start':
        return 'left';
      default:
        return '';
    }
  };
  const direct = map(align);
  const inherited = map(styleAlign);
  const eff = direct || inherited;
  // left is the default; only spell it out when it overrides a style's alignment
  if (!eff || (eff === 'left' && (!inherited || inherited === 'left'))) return '';
  return `text-align:${eff}`;
}

function processParagraph(p: Element, w: BlockWriter, ctx: Ctx): void {
  const pPrEl = kid(p, 'pPr');
  const direct = parsePPr(pPrEl);
  const styleId = direct.styleId ?? ctx.styles.defaultParaId;
  const style = ctx.styles.resolve(styleId);
  const styleRPr = merge(ctx.styles.docRPr, ctx.tableRPr, style.rPr);
  const effPPr = merge(ctx.styles.docPPr, ctx.tablePPr, style.pPr, direct);

  // classification
  let heading = headingLevelOf(style.keys);
  const outline = direct.outlineLvl ?? style.pPr.outlineLvl;
  if (heading === null && outline !== undefined && outline >= 0 && outline <= 8) heading = Math.min(6, outline + 1);
  const isCode = heading === null && style.keys.some((k) => CODE_BLOCK_KEYS.has(k));
  const isQuote = heading === null && !isCode && style.keys.some((k) => QUOTE_KEYS.has(k));

  let list: { item: OpenList; level: LevelDef; counterKey: string } | null = null;
  if (heading === null && !isCode) {
    const numId = direct.numId ?? style.pPr.numId;
    if (numId && numId !== '0' && ctx.numbering.has(numId)) {
      const ilvl =
        direct.ilvl ??
        (direct.numId === undefined && styleId ? ctx.numbering.levelForStyle(numId, styleId) : null) ??
        style.pPr.ilvl ??
        0;
      const level = ctx.numbering.level(numId, ilvl);
      if (level && level.fmt !== 'none') {
        list = {
          item: {
            numId,
            ilvl,
            tag: level.fmt === 'bullet' ? 'ul' : 'ol',
            indent: direct.indLeft ?? level.indent ?? 720 * (ilvl + 1),
          },
          level,
          counterKey: ctx.numbering.counterKey(numId),
        };
      }
    }
  }

  const semantic = heading !== null || isCode || (isQuote && !list);
  const pc: ParaCtx = {
    items: [],
    after: [],
    styleRPr,
    // headings and body text spell out how they differ from the editor's own look;
    // quotes and code blocks have a look of their own, so only differences from their style count
    base: heading !== null ? editorBase(heading) : semantic ? styleRPr : editorBase(null),
    pre: isCode,
  };
  processInline(p, pc, ctx, null);

  // page breaks: split plain paragraphs at the break, otherwise move the break before/after the block
  const top = ctx.nested === 0;
  const segments: Item[][] = [[]];
  for (const it of pc.items) {
    if (it.t === 'pagebreak') segments.push([]);
    else segments[segments.length - 1].push(it);
  }
  const hasContent = (seg: Item[]): boolean => seg.some((it) => it.t === 'img' || (it.t === 'text' && it.raw.length > 0));
  const breaks = segments.length - 1;
  const alignDecl = alignCss(direct.align, style.pPr.align);
  const blockAttr = (opts: { spacing: boolean; indent: boolean }): string =>
    styleAttr([...(alignDecl ? [alignDecl] : []), ...paragraphCss(effPPr, heading, opts)]);
  const align = blockAttr({ spacing: true, indent: true });
  const listAlign = blockAttr({ spacing: false, indent: false });
  const plainAlign = alignDecl ? styleAttr([alignDecl]) : '';
  const breakBefore = top && (direct.pageBreakBefore ?? style.pPr.pageBreakBefore ?? false);
  if (breakBefore) w.block(PAGE_BREAK);

  const emitAfter = (): void => {
    for (const html of pc.after) w.block(html);
  };

  if (heading !== null) {
    const content = pc.items.filter((it) => it.t !== 'pagebreak');
    const leading = breaks > 0 && !hasContent(segments[0]);
    if (top && leading) w.block(PAGE_BREAK);
    if (hasContent(content)) w.block(`<h${heading}${align}>${renderInline(content)}</h${heading}>`);
    if (top && breaks > 0 && !leading) w.block(PAGE_BREAK);
  } else if (isCode) {
    w.preLine(plainText(pc.items));
    if (top && breaks > 0) w.block(PAGE_BREAK);
  } else if (list) {
    const content = pc.items.filter((it) => it.t !== 'pagebreak');
    const leading = breaks > 0 && !hasContent(segments[0]);
    if (top && leading) w.block(PAGE_BREAK);
    // counters (for <ol start>): Word continues numbering when a list is interrupted
    const counters = ctx.listCounters.get(list.counterKey) ?? [];
    ctx.listCounters.set(list.counterKey, counters);
    const { ilvl } = list.item;
    const before = counters[ilvl] ?? 0;
    counters[ilvl] = before + 1;
    counters.length = ilvl + 1; // deeper levels restart
    const level = list.level;
    const attrs = (): string => {
      if (list!.item.tag !== 'ol') return '';
      const start = level.start + before;
      const type = OL_TYPES[level.fmt];
      return (start !== 1 ? ` start="${start}"` : '') + (type ? ` type="${type}"` : '');
    };
    w.listItem(list.item, attrs, `<p${listAlign}>${renderInline(content)}</p>`);
    if (top && breaks > 0 && !leading) w.block(PAGE_BREAK);
  } else if (isQuote) {
    const content = pc.items.filter((it) => it.t !== 'pagebreak');
    w.quoteBlock(`<p${plainAlign}>${renderInline(content)}</p>`);
    if (top && breaks > 0) w.block(PAGE_BREAK);
  } else if (!pc.items.length && direct.border && !pc.after.length) {
    w.block('<hr>');
  } else {
    segments.forEach((seg, i) => {
      if (i > 0 && top) w.block(PAGE_BREAK);
      if (!hasContent(seg) && (breaks > 0 || pc.after.length)) return; // paragraph that only carried the break / a text box
      const inner = renderInline(seg);
      if (i === 0 && !breakBefore && direct.indLeft && direct.indLeft > 0 && w.continuation(direct.indLeft, `<p${listAlign}>${inner}</p>`)) return;
      w.block(`<p${align}>${inner}</p>`);
    });
  }
  emitAfter();

  // a section break that starts a new page behaves like a page break
  const sect = kid(pPrEl, 'sectPr');
  if (sect && top) {
    const type = val(sect, 'type');
    if (type !== 'continuous') w.block(PAGE_BREAK);
  }
}

// ── tables ───────────────────────────────────────────────────────────────────

function unwrap(parent: Element, name: string, out: Element[] = []): Element[] {
  for (const c of kids(parent)) {
    if (c.localName === name) out.push(c);
    else if (c.localName === 'sdt') unwrap(kid(c, 'sdtContent') ?? c, name, out);
    else if (c.localName === 'customXml' || c.localName === 'ins' || c.localName === 'moveTo' || c.localName === 'sdtContent') {
      unwrap(c, name, out);
    } else if (c.localName === 'AlternateContent') {
      const b = mcBranch(c);
      if (b) unwrap(b, name, out);
    }
  }
  return out;
}

interface CellModel {
  el: Element;
  col: number;
  span: number;
  merge: 'restart' | 'continue' | null;
}

const TWIPS_PER_PX = 15;

function sideName(name: string): string {
  return name === 'start' ? 'left' : name === 'end' ? 'right' : name;
}

/** A Word border element as a CSS border value ("none" when it is switched off). */
function borderCss(b: Element | undefined): string | undefined {
  if (!b) return undefined;
  const v = attr(b, 'val');
  if (!v || v === 'nil' || v === 'none') return 'none';
  const eighths = intAttr(b, 'sz') ?? 4; // eighths of a point
  const color = hexColor(attr(b, 'color')) ?? '000000';
  const style = /^(double|triple)|Gap$/i.test(v) ? 'double' : v === 'dotted' ? 'dotted' : /dash/i.test(v) ? 'dashed' : 'solid';
  let px = Math.max(1, Math.round((eighths / 6) * 10) / 10);
  if (style === 'double') px = Math.max(3, px * 3);
  return `${px}px ${style} #${color}`;
}

function processTable(tbl: Element, ctx: Ctx): string {
  const tblPr = kid(tbl, 'tblPr');
  const styleId = val(tblPr, 'tblStyle') ?? ctx.styles.defaultTableId;
  const tableStyle = ctx.styles.resolve(styleId);
  const tableBorders = ctx.styles.tableBorders(styleId);
  const tableMargins = ctx.styles.tableCellMargins(styleId);
  for (const m of kids(kid(tblPr, 'tblCellMar'))) tableMargins.set(sideName(m.localName), m);
  for (const b of kids(kid(tblPr, 'tblBorders'))) tableBorders.set(sideName(b.localName), b);
  const grid = kids(kid(tbl, 'tblGrid'), 'gridCol').map((g) => Math.max(0, intAttr(g, 'w') ?? 0));

  const rows: { cells: CellModel[]; header: boolean; height: number }[] = [];
  for (const tr of unwrap(tbl, 'tr')) {
    const trPr = kid(tr, 'trPr');
    if (kid(trPr, 'del')) continue; // row deleted with change tracking
    let col = Math.max(0, intAttr(kid(trPr, 'gridBefore'), 'val') ?? 0);
    const cells: CellModel[] = [];
    for (const tc of unwrap(tr, 'tc')) {
      const tcPr = kid(tc, 'tcPr');
      const span = Math.max(1, intAttr(kid(tcPr, 'gridSpan'), 'val') ?? 1);
      const vMerge = kid(tcPr, 'vMerge');
      const merge = vMerge ? (attr(vMerge, 'val') === 'restart' ? 'restart' : 'continue') : null;
      cells.push({ el: tc, col, span, merge });
      col += span;
    }
    const trHeight = kid(trPr, 'trHeight');
    const height = attr(trHeight, 'hRule') === 'auto' ? 0 : (intAttr(trHeight, 'val') ?? 0);
    rows.push({ cells, header: toggle(trPr, 'tblHeader') === true, height });
  }
  if (!rows.length) return '';
  const numCols = Math.max(grid.length, ...rows.map((r) => r.cells.reduce((n, c) => Math.max(n, c.col + c.span), 0)));

  /** Column widths (px) for a cell: from the table grid, else the cell's own width split evenly. */
  const widths = (cell: CellModel): number[] | null => {
    const fromGrid = grid.slice(cell.col, cell.col + cell.span);
    if (fromGrid.length === cell.span && fromGrid.every((w) => w > 0)) return fromGrid.map((w) => Math.max(1, Math.round(w / TWIPS_PER_PX)));
    const tcW = kid(kid(cell.el, 'tcPr'), 'tcW');
    const w = attr(tcW, 'type') === 'dxa' || !attr(tcW, 'type') ? (intAttr(tcW, 'w') ?? 0) : 0;
    if (w <= 0) return null;
    return Array.from({ length: cell.span }, () => Math.max(1, Math.round(w / cell.span / TWIPS_PER_PX)));
  };

  const cellAt = (r: number, col: number): CellModel | undefined => rows[r]?.cells.find((c) => c.col === col);
  const tblW = kid(tblPr, 'tblW');
  const tblWType = attr(tblW, 'type');
  const tblWVal = intAttr(tblW, 'w') ?? 0;
  const jc = (val(tblPr, 'jc') ?? '').toLowerCase();
  const tableAttrs: string[] = [];
  if (tblWType === 'pct' || (tblWType === 'auto' && tblWVal <= 0)) tableAttrs.push('data-table-width="pct"');
  else if (tblWType === 'dxa' && tblWVal > 0) tableAttrs.push(`style="width:${Math.round(tblWVal / TWIPS_PER_PX)}px"`);
  else if (grid.length && grid.every((w) => w > 0)) {
    const sum = grid.reduce((a, b) => a + b, 0);
    tableAttrs.push(`style="width:${Math.round(sum / TWIPS_PER_PX)}px"`);
  }
  if (jc === 'center' || jc === 'right') tableAttrs.push(`data-table-align="${jc}"`);
  let html = `<table${tableAttrs.length ? ' ' + tableAttrs.join(' ') : ''}><tbody>`;
  const saved = { noBold: ctx.noBold, tableRPr: ctx.tableRPr, tablePPr: ctx.tablePPr };
  ctx.tableRPr = tableStyle.rPr;
  ctx.tablePPr = tableStyle.pPr;
  ctx.nested++;
  rows.forEach((row, r) => {
    html += row.height > 0 ? `<tr style="height:${Math.round(row.height / TWIPS_PER_PX)}px">` : '<tr>';
    for (const cell of row.cells) {
      if (cell.merge === 'continue') {
        const above = cellAt(r - 1, cell.col);
        if (above && above.merge) continue; // covered by the rowspan of a cell above
      }
      let rowspan = 1;
      if (cell.merge) {
        while (cellAt(r + rowspan, cell.col)?.merge === 'continue') rowspan++;
      }
      const tag = row.header ? 'th' : 'td';
      ctx.noBold = row.header;
      // Word requires a paragraph after a nested table at the end of a cell; drop it when empty
      const content = processBlocks(cell.el, ctx, false).replace(/(<\/table>)<p><\/p>$/, '$1') || '<p></p>';

      const tcPr = kid(cell.el, 'tcPr');
      const lastRow = r + rowspan - 1;
      const own = new Map<string, Element>();
      for (const b of kids(kid(tcPr, 'tcBorders'))) own.set(sideName(b.localName), b);
      const bottomOwn = rowspan > 1 ? kid(kid(kid(cellAt(lastRow, cell.col)?.el, 'tcPr'), 'tcBorders'), 'bottom') : null;
      const side = (name: 'top' | 'right' | 'bottom' | 'left'): string => {
        const fromCell = name === 'bottom' && bottomOwn ? bottomOwn : own.get(name);
        const fromTable =
          name === 'top' ? tableBorders.get(r === 0 ? 'top' : 'insideH')
          : name === 'bottom' ? tableBorders.get(lastRow === rows.length - 1 ? 'bottom' : 'insideH')
          : name === 'left' ? tableBorders.get(cell.col === 0 ? 'left' : 'insideV')
          : tableBorders.get(cell.col + cell.span >= numCols ? 'right' : 'insideV');
        return borderCss(fromCell ?? fromTable) ?? 'none';
      };
      const css = (['top', 'right', 'bottom', 'left'] as const).map((s) => `border-${s}:${side(s)}`);
      const fill = hexColor(attr(kid(tcPr, 'shd'), 'fill'));
      if (fill) css.unshift(`background-color:#${fill}`);
      const vAlign = val(tcPr, 'vAlign');
      if (vAlign === 'center' || vAlign === 'bottom') css.push(`vertical-align:${vAlign === 'center' ? 'middle' : 'bottom'}`);
      const w = widths(cell);
      // Word's cell margins (default 0.075in left / right, none top / bottom); a narrow spacer
      // column can't hold them, so they shrink to fit as Word's do
      const ownMar = new Map<string, Element>();
      for (const m of kids(kid(tcPr, 'tcMar'))) ownMar.set(sideName(m.localName), m);
      const mar = (s: string, d: number): number => {
        const el = ownMar.get(s) ?? tableMargins.get(s);
        const type = attr(el, 'type');
        const v = el && (!type || type === 'dxa') ? intAttr(el, 'w') : null;
        return Math.max(0, (v ?? d) / TWIPS_PER_PX);
      };
      const cellPx = w ? w.reduce((a, b) => a + b, 0) : Infinity;
      const fit = (v: number) => Math.round(Math.min(v, Math.max(0, (cellPx - 2) / 2)) * 10) / 10;
      css.push(`padding:${fit(mar('top', 0))}px ${fit(mar('right', 108))}px ${fit(mar('bottom', 0))}px ${fit(mar('left', 108))}px`);

      html +=
        `<${tag}` +
        (cell.span > 1 ? ` colspan="${cell.span}"` : '') +
        (rowspan > 1 ? ` rowspan="${rowspan}"` : '') +
        (w ? ` colwidth="${w.join(',')}"` : '') +
        ` style="${css.join('; ')}"` +
        `>${content}</${tag}>`;
    }
    html += '</tr>';
  });
  ctx.nested--;
  ctx.noBold = saved.noBold;
  ctx.tableRPr = saved.tableRPr;
  ctx.tablePPr = saved.tablePPr;
  return html + '</tbody></table>';
}

// ── block containers ─────────────────────────────────────────────────────────

function walkBlocks(container: Element, w: BlockWriter, ctx: Ctx): void {
  for (const el of kids(container)) {
    try {
      switch (el.localName) {
        case 'p':
          processParagraph(el, w, ctx);
          break;
        case 'tbl':
          w.block(processTable(el, ctx));
          break;
        case 'sdt':
          walkBlocks(kid(el, 'sdtContent') ?? el, w, ctx);
          break;
        case 'sdtContent':
        case 'customXml':
        case 'smartTag':
        case 'ins':
        case 'moveTo':
          walkBlocks(el, w, ctx);
          break;
        case 'AlternateContent': {
          const b = mcBranch(el);
          if (b) walkBlocks(b, w, ctx);
          break;
        }
        default:
          // sectPr, bookmarks, del, moveFrom, … → nothing
          break;
      }
    } catch {
      /* a broken block must not take the whole document down */
    }
  }
}

/** Converts a block container (body, table cell, text box) to HTML. */
function processBlocks(container: Element, ctx: Ctx, textBox: boolean): string {
  const w = new BlockWriter();
  if (textBox) {
    const savedNoBold = ctx.noBold;
    ctx.noBold = false;
    ctx.nested++;
    walkBlocks(container, w, ctx);
    ctx.nested--;
    ctx.noBold = savedNoBold;
  } else {
    walkBlocks(container, w, ctx);
  }
  return w.toString();
}

// ── page setup / metadata ────────────────────────────────────────────────────

/** The section properties that apply to the end of the document (the last section). */
function finalSection(body: Element): Element | null {
  let sect = kid(body, 'sectPr');
  if (!sect) {
    const paras = kids(body, 'p');
    for (let i = paras.length - 1; i >= 0 && !sect; i--) sect = kid(kid(paras[i], 'pPr'), 'sectPr');
  }
  return sect;
}

function readPageSetup(body: Element): PageSetup {
  const sect = finalSection(body);
  const setup: PageSetup = {
    size: DEFAULT_PAGE_SETUP.size,
    orientation: DEFAULT_PAGE_SETUP.orientation,
    margins: { ...DEFAULT_PAGE_SETUP.margins },
  };
  if (!sect) return setup;
  const pgSz = kid(sect, 'pgSz');
  const wTw = intAttr(pgSz, 'w');
  const hTw = intAttr(pgSz, 'h');
  if (wTw && hTw && wTw > 0 && hTw > 0) {
    const w = wTw / 20;
    const h = hTw / 20;
    setup.orientation = attr(pgSz, 'orient') === 'landscape' || w > h ? 'landscape' : 'portrait';
    const short = Math.min(w, h);
    const long = Math.max(w, h);
    let best: PageSize = 'letter';
    let bestDist = Infinity;
    for (const size of Object.keys(PAGE_SIZES) as PageSize[]) {
      const dist = Math.abs(PAGE_SIZES[size].width - short) + Math.abs(PAGE_SIZES[size].height - long);
      if (dist < bestDist) {
        bestDist = dist;
        best = size;
      }
    }
    setup.size = best;
  } else if (attr(pgSz, 'orient') === 'landscape') {
    setup.orientation = 'landscape';
  }
  const pgMar = kid(sect, 'pgMar');
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const tw = intAttr(pgMar, side);
    if (tw !== null) setup.margins[side] = Math.round(Math.abs(tw) * 5) / 100;
  }
  const header = intAttr(pgMar, 'header');
  const footer = intAttr(pgMar, 'footer');
  // only when they differ from Word's default, so documents round-trip unchanged
  const dist = (tw: number) => Math.round(Math.abs(tw) * 5) / 100;
  if (header !== null && dist(header) !== DEFAULT_HF_DISTANCE) setup.headerDistance = dist(header);
  if (footer !== null && dist(footer) !== DEFAULT_HF_DISTANCE) setup.footerDistance = dist(footer);
  if (kid(sect, 'titlePg')) setup.differentFirstPage = true;
  return setup;
}

/** Page size and margins in px, straight from w:pgSz / w:pgMar. */
function pageGeom(sect: Element | null): PageGeom {
  const pgSz = kid(sect, 'pgSz');
  const pgMar = kid(sect, 'pgMar');
  const tw = (el: Element | null, name: string, d: number) => Math.abs(intAttr(el, name) ?? d) / TWIPS_PER_PX;
  return {
    w: tw(pgSz, 'w', 12240),
    h: tw(pgSz, 'h', 15840),
    top: tw(pgMar, 'top', 1440),
    right: tw(pgMar, 'right', 1440),
    bottom: tw(pgMar, 'bottom', 1440),
    left: tw(pgMar, 'left', 1440),
    header: tw(pgMar, 'header', 720),
    footer: tw(pgMar, 'footer', 720),
  };
}

/** Embedded images of one part → data URLs (only formats a browser can render). */
async function loadMedia(zip: JSZip, rels: Map<string, Rel>, dir: string): Promise<Map<string, string>> {
  const media = new Map<string, string>();
  for (const [id, rel] of rels) {
    if (rel.external || !rel.type.endsWith('/image')) continue;
    const path = resolvePath(dir, rel.target);
    const ext = (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? '').toLowerCase();
    const data = await readPart(zip, path);
    if (!data || !data.length) continue;
    const mime = IMAGE_MIME[ext] ?? sniffMime(data);
    if (mime) media.set(id, toDataUrl(mime, data));
  }
  return media;
}

/** True when converted HTML has any text or picture in it. */
function hasVisibleContent(html: string): boolean {
  return /<img\b/i.test(html) || html.replace(/<[^>]+>/g, '').replace(/&nbsp;|\s/g, '').length > 0;
}

/** One header / footer part (by w:type), converted with its own relationships. */
async function readHeaderFooterPart(
  kind: 'header' | 'footer',
  type: string,
  sect: Element | null,
  zip: JSZip,
  rels: Map<string, Rel>,
  dir: string,
  ctx: Ctx,
  colors: ThemeColors,
): Promise<string | undefined> {
  const refs = kids(sect, `${kind}Reference`);
  const ref = refs.find((r) => (attr(r, 'type') || 'default') === type);
  if (!ref) return undefined;
  const id = relAttr(ref, 'id');
  const rel = id ? rels.get(id) : undefined;
  if (!rel || rel.external) return undefined;
  const path = resolvePath(dir, rel.target);
  const xml = await readXml(zip, path);
  if (!xml?.documentElement) return undefined;
  const slash = path.lastIndexOf('/');
  const partDir = slash >= 0 ? path.slice(0, slash) : '';
  const partRels = parseRels(await readXml(zip, `${partDir ? partDir + '/' : ''}_rels/${path.slice(slash + 1)}.rels`));
  const media = await loadMedia(zip, partRels, partDir);
  const hf: HeaderFooterCtx = { kind, geom: pageGeom(sect), jobs: [] };
  const partCtx: Ctx = { ...ctx, rels: partRels, media, fields: [], listCounters: new Map(), nested: 0, noBold: false, tableRPr: {}, tablePPr: {}, hf, art: null };
  let html = processBlocks(xml.documentElement, partCtx, false);
  html = await resolveArt(html, hf.jobs, { theme: colors, media });
  return hasVisibleContent(html) ? html : undefined;
}

/** Default / first / even header or footer of the last section. */
async function readHeaderFooters(
  kind: 'header' | 'footer',
  sect: Element | null,
  zip: JSZip,
  rels: Map<string, Rel>,
  dir: string,
  ctx: Ctx,
  colors: ThemeColors,
): Promise<{ default?: string; first?: string; even?: string }> {
  const out: { default?: string; first?: string; even?: string } = {};
  for (const type of ['default', 'first', 'even'] as const) {
    try {
      const html = await readHeaderFooterPart(kind, type, sect, zip, rels, dir, ctx, colors);
      if (html) out[type] = html;
    } catch {
      /* a broken header must not lose the document */
    }
  }
  // Word sometimes omits w:type="default"; fall back to the first untyped / unknown ref
  if (!out.default && !out.first && !out.even) {
    const refs = kids(sect, `${kind}Reference`);
    const ref = refs[0];
    if (ref) {
      try {
        const type = attr(ref, 'type') || 'default';
        const html = await readHeaderFooterPart(kind, type, sect, zip, rels, dir, ctx, colors);
        if (html) out.default = html;
      } catch {
        /* ignore */
      }
    }
  } else if (!out.default) {
    // prefer first as the editor's default when only title-page HF exists
    if (out.first) out.default = out.first;
  }
  return out;
}

// ── entry point ──────────────────────────────────────────────────────────────

async function readPart(zip: JSZip, path: string): Promise<Uint8Array | null> {
  const file = zip.file(path) ?? zip.file(path.replace(/^\/+/, ''));
  if (!file) return null;
  try {
    return await file.async('uint8array');
  } catch {
    return null;
  }
}

/** Reads and parses an optional XML part; null when missing or malformed. */
async function readXml(zip: JSZip, path: string): Promise<Document | null> {
  const bytes = await readPart(zip, path);
  if (!bytes) return null;
  try {
    return parseXml(decodeText(bytes));
  } catch {
    return null;
  }
}

function relTarget(rels: Map<string, Rel>, typeSuffix: string, baseDir: string, fallback: string): string {
  for (const rel of rels.values()) {
    if (!rel.external && rel.type.endsWith(typeSuffix)) return resolvePath(baseDir, rel.target);
  }
  return fallback;
}

export const importDocx: Importer = async (bytes) => {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error('Not a valid DOCX file: the file is not a ZIP archive (it may be corrupt or encrypted).');
  }

  // main document part (normally word/document.xml)
  let docPath = 'word/document.xml';
  if (!zip.file(docPath)) {
    const rootRels = parseRels(await readXml(zip, '_rels/.rels'));
    const alt = relTarget(rootRels, '/officeDocument', '', '');
    if (alt && zip.file(alt)) docPath = alt;
  }
  const docBytes = await readPart(zip, docPath);
  if (!docBytes) throw new Error('Not a valid DOCX file: word/document.xml is missing.');
  const docXml = parseXml(decodeText(docBytes));
  const body = kid(docXml.documentElement, 'body');
  if (!body) throw new Error('Not a valid DOCX file: word/document.xml has no document body.');

  const slash = docPath.lastIndexOf('/');
  const dir = slash >= 0 ? docPath.slice(0, slash) : '';
  const base = docPath.slice(slash + 1);
  const rels = parseRels(await readXml(zip, `${dir ? dir + '/' : ''}_rels/${base}.rels`));
  const prefix = dir ? dir + '/' : '';

  // theme fonts (for rFonts that point at the theme)
  const theme: ThemeFonts = {};
  const themeXml = await readXml(zip, relTarget(rels, '/theme', dir, `${prefix}theme/theme1.xml`));
  if (themeXml) {
    const scheme = descendant(themeXml.documentElement, 'fontScheme');
    theme.major = attr(kid(kid(scheme, 'majorFont'), 'latin'), 'typeface') || undefined;
    theme.minor = attr(kid(kid(scheme, 'minorFont'), 'latin'), 'typeface') || undefined;
  }

  const styles = new StyleSheet(await readXml(zip, relTarget(rels, '/styles', dir, `${prefix}styles.xml`)), theme);
  const numbering = new Numbering(
    await readXml(zip, relTarget(rels, '/numbering', dir, `${prefix}numbering.xml`)),
    styles,
  );

  const media = await loadMedia(zip, rels, dir);

  const bodyArt: ArtJob[] = [];
  const ctx: Ctx = {
    styles,
    numbering,
    rels,
    media,
    theme,
    fields: [],
    listCounters: new Map(),
    nested: 0,
    noBold: false,
    tableRPr: {},
    tablePPr: {},
    hf: null,
    art: bodyArt,
  };
  // styleRPr of paragraphs starts from the same spec defaults
  styles.docRPr = merge<RunProps>({ size: 20, font: 'Times New Roman' }, styles.docRPr);

  // headers and footers of the last section (default / first / even)
  const sect = finalSection(body);
  const settingsXml = await readXml(zip, relTarget(rels, '/settings', dir, `${prefix}settings.xml`));
  const colors = readThemeColors(themeXml, settingsXml);

  let bodyHtml = processBlocks(body, ctx, false);
  bodyHtml = await resolveArt(bodyHtml, bodyArt, { theme: colors, media });
  const result: RichDocument = {
    html: bodyHtml,
    pageSetup: readPageSetup(body),
  };
  if (toggle(settingsXml?.documentElement ?? null, 'evenAndOddHeaders') === true) {
    result.pageSetup = { ...(result.pageSetup ?? { ...DEFAULT_PAGE_SETUP }), differentOddEven: true };
  }
  const headers = await readHeaderFooters('header', sect, zip, rels, dir, ctx, colors);
  const footers = await readHeaderFooters('footer', sect, zip, rels, dir, ctx, colors);
  if (headers.default) result.header = headers.default;
  if (headers.first) result.headerFirst = headers.first;
  if (headers.even) result.headerEven = headers.even;
  if (footers.default) result.footer = footers.default;
  if (footers.first) result.footerFirst = footers.first;
  if (footers.even) result.footerEven = footers.even;
  if ((headers.first || footers.first) && result.pageSetup && !result.pageSetup.differentFirstPage) {
    result.pageSetup = { ...result.pageSetup, differentFirstPage: true };
  }
  if ((headers.even || footers.even) && result.pageSetup && !result.pageSetup.differentOddEven) {
    result.pageSetup = { ...result.pageSetup, differentOddEven: true };
  }

  const core = await readXml(zip, 'docProps/core.xml');
  const title = (kid(core?.documentElement, 'title')?.textContent ?? '').trim();
  if (title) result.title = title;
  return result;
};
