/**
 * Reads a PowerPoint file (.pptx, .ppsx, .potx, and Google Slides / Keynote decks exported as
 * PowerPoint) into a Deck.
 *
 * PowerPoint leaves most things unsaid on a slide: a title's position comes from its layout,
 * its font size from the slide master, its colour from the theme. Everything is resolved
 * here, down that chain (slide → layout → master → theme), so the deck that comes out says
 * everything explicitly. Shapes that belong to the master or layout (logos, bands) are copied
 * onto each slide, locked. What cannot be edited here (charts, SmartArt, video) becomes a
 * labelled placeholder and is reported in `warnings`.
 */
import JSZip from 'jszip';
import { decodeText, parseXml } from '../dom';
import {
  EMU_PER_PX,
  THEMES,
  TRANSITIONS,
  uid,
  type Align,
  type Background,
  type ChartElement,
  type ChartSeries,
  type Deck,
  type Paragraph,
  type PlaceholderType,
  type ShapeElement,
  type Slide,
  type SlideElement,
  type TableCell,
  type TableElement,
  type TextRun,
  type Theme,
  type TransitionType,
} from './model';
import { cellFill } from './render';
import { THEME_MARK, flatten } from './pptx-write';

const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const kids = (el: Element | null | undefined, name?: string): Element[] => (el ? Array.from(el.children).filter((c) => !name || c.localName === name) : []);
const kid = (el: Element | null | undefined, name: string): Element | null => kids(el, name)[0] ?? null;
const path = (el: Element | null | undefined, ...names: string[]): Element | null => {
  let cur: Element | null = el ?? null;
  for (const nm of names) cur = kid(cur, nm);
  return cur;
};
const num = (el: Element | null | undefined, attr: string, fallback = 0): number => {
  const v = el?.getAttribute(attr);
  return v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? fallback : Number(v);
};
const px = (emu: number) => emu / EMU_PER_PX;

interface Part {
  path: string;
  xml: Element;
  /** relationship id → { target path inside the package, or URL; type } */
  rels: Map<string, { target: string; type: string; external: boolean }>;
}

function resolve(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const out = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.') out.push(seg);
  }
  return out.join('/');
}

// ── colours ───────────────────────────────────────────────────────────────

interface ColorCtx {
  /** scheme name (dk1, accent1…) → RRGGBB */
  scheme: Record<string, string>;
  /** bg1 / tx1 / … → scheme name */
  map: Record<string, string>;
}

const PRESET: Record<string, string> = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', orange: 'FFA500', purple: '800080' };

function hslFromRgb(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function rgbFromHsl(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** A DrawingML colour element (srgbClr, schemeClr, sysClr, prstClr) with its tint / shade / luminance changes. */
function colorOf(el: Element | null, ctx: ColorCtx, phClr?: string): { color: string; alpha: number } | null {
  if (!el) return null;
  let hex: string | null = null;
  switch (el.localName) {
    case 'srgbClr':
      hex = el.getAttribute('val');
      break;
    case 'sysClr':
      hex = el.getAttribute('lastClr') ?? (el.getAttribute('val') === 'window' ? 'FFFFFF' : '000000');
      break;
    case 'prstClr':
      hex = PRESET[el.getAttribute('val') ?? ''] ?? '000000';
      break;
    case 'schemeClr': {
      const v = el.getAttribute('val') ?? '';
      hex = v === 'phClr' ? phClr ?? null : ctx.scheme[ctx.map[v] ?? v] ?? null;
      break;
    }
    case 'scrgbClr':
      hex = ['r', 'g', 'b'].map((c) => Math.round((num(el, c) / 100000) * 255).toString(16).padStart(2, '0')).join('');
      break;
  }
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return null;
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex!.slice(i, i + 2), 16));
  let alpha = 1;
  for (const mod of kids(el)) {
    const v = num(mod, 'val', 100000) / 100000;
    if (mod.localName === 'alpha') alpha = v;
    else if (mod.localName === 'tint') [r, g, b] = [r, g, b].map((c) => c + (255 - c) * (1 - v));
    else if (mod.localName === 'shade') [r, g, b] = [r, g, b].map((c) => c * v);
    else if (mod.localName === 'lumMod' || mod.localName === 'lumOff') {
      const [h, s, l] = hslFromRgb(r, g, b);
      [r, g, b] = rgbFromHsl(h, s, Math.min(1, Math.max(0, mod.localName === 'lumMod' ? l * v : l + v)));
    }
  }
  const to = (c: number) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0');
  return { color: `#${to(r)}${to(g)}${to(b)}`, alpha };
}

/** The colour inside a fill-like parent (<a:solidFill>, or the first stop of a gradient). */
function fillColor(parent: Element | null, ctx: ColorCtx, phClr?: string): { color: string; alpha: number; color2?: string } | null {
  if (!parent) return null;
  const solid = kid(parent, 'solidFill');
  if (solid) return colorOf(kids(solid)[0] ?? null, ctx, phClr);
  const grad = kid(parent, 'gradFill');
  if (grad) {
    const stops = kids(kid(grad, 'gsLst'), 'gs').sort((a, b) => num(a, 'pos') - num(b, 'pos'));
    const first = colorOf(kids(stops[0])[0] ?? null, ctx, phClr);
    const last = colorOf(kids(stops[stops.length - 1])[0] ?? null, ctx, phClr);
    return first ? { ...first, color2: last?.color } : null;
  }
  return null;
}

// ── text ──────────────────────────────────────────────────────────────────

interface TextCtx {
  colors: ColorCtx;
  majorFont: string;
  minorFont: string;
  /** lstStyle-like elements, most specific first; each has lvl1pPr… children */
  styles: Element[];
  /** relationships of the part the text is in (for hyperlinks) */
  rels: Part['rels'];
  /** font scale of a shrunken text box (normAutofit), 1 if none */
  fontScale: number;
  /** text colour from the shape's style: used when a run names none, ahead of the master's default */
  styleColor?: string;
}

function fontName(el: Element | null, t: TextCtx): string | undefined {
  const face = kid(el, 'latin')?.getAttribute('typeface');
  if (!face) return undefined;
  if (face.startsWith('+mj')) return t.majorFont;
  if (face.startsWith('+mn')) return t.minorFont;
  return /^[\w\s.-]+$/.test(face) ? `"${face}", sans-serif` : undefined;
}

/** Looks a property up the chain: the element itself, then each inherited level style. */
function inherited<T>(own: Element | null, level: number, t: TextCtx, get: (pPr: Element) => T | undefined): T | undefined {
  if (own) {
    const v = get(own);
    if (v !== undefined) return v;
  }
  for (const st of t.styles) {
    const lvl = kid(st, `lvl${level + 1}pPr`);
    if (!lvl) continue;
    const v = get(lvl);
    if (v !== undefined) return v;
  }
  return undefined;
}

const ALIGN: Record<string, Align> = { l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify' };

function readParagraphs(txBody: Element | null, t: TextCtx): Paragraph[] {
  const out: Paragraph[] = [];
  for (const p of kids(txBody, 'p')) {
    const pPr = kid(p, 'pPr');
    const level = Math.min(8, num(pPr, 'lvl'));
    const algn = inherited(pPr, level, t, (e) => e.getAttribute('algn') ?? undefined);
    const bullet = inherited(pPr, level, t, (e) => (kid(e, 'buNone') ? 'none' : kid(e, 'buAutoNum') ? 'number' : kid(e, 'buChar') || kid(e, 'buBlip') ? 'bullet' : undefined)) ?? 'none';
    const spc = inherited(pPr, level, t, (e) => {
      const pct = path(e, 'lnSpc', 'spcPct');
      return pct ? num(pct, 'val', 100000) / 100000 : undefined;
    });
    const runStyle = (rPr: Element | null): Omit<TextRun, 'text'> => {
      const from = <T,>(get: (e: Element) => T | undefined): T | undefined => {
        if (rPr) {
          const v = get(rPr);
          if (v !== undefined) return v;
        }
        return inherited(pPr ? kid(pPr, 'defRPr') : null, level, t, (e) => (e.localName === 'defRPr' ? get(e) : kid(e, 'defRPr') ? get(kid(e, 'defRPr')!) : undefined));
      };
      const flag = (attr: string) => from((e) => (e.hasAttribute(attr) ? e.getAttribute(attr) !== '0' && e.getAttribute(attr) !== 'false' : undefined));
      const size = from((e) => (e.hasAttribute('sz') ? num(e, 'sz') / 100 : undefined));
      const color = (rPr ? fillColor(rPr, t.colors)?.color : undefined) ?? t.styleColor ?? from((e) => fillColor(e, t.colors)?.color);
      const u = from((e) => e.getAttribute('u') ?? undefined);
      const strike = from((e) => e.getAttribute('strike') ?? undefined);
      const font = from((e) => fontName(e, t));
      const style: Omit<TextRun, 'text'> = {};
      if (flag('b') !== undefined) style.bold = flag('b');
      if (flag('i')) style.italic = true;
      if (u && u !== 'none') style.underline = true;
      if (strike && strike !== 'noStrike') style.strike = true;
      if (size) style.size = Math.max(1, Math.round(size * t.fontScale * 10) / 10);
      if (color) style.color = color;
      if (font) style.font = font;
      const link = rPr ? kid(rPr, 'hlinkClick')?.getAttributeNS(R_NS, 'id') : null;
      const target = link ? t.rels.get(link) : undefined;
      if (target?.external && /^(https?:|mailto:)/i.test(target.target)) style.link = target.target;
      return style;
    };
    const runs: TextRun[] = [];
    for (const c of kids(p)) {
      if (c.localName === 'r' || c.localName === 'fld') runs.push({ text: kid(c, 't')?.textContent ?? '', ...runStyle(kid(c, 'rPr')) });
      else if (c.localName === 'br') runs.push({ text: '\n', ...runStyle(kid(c, 'rPr')) });
    }
    if (!runs.length) runs.push({ text: '', ...runStyle(kid(p, 'endParaRPr')) });
    const para: Paragraph = { runs, bullet: bullet as Paragraph['bullet'] };
    if (algn && ALIGN[algn] && ALIGN[algn] !== 'left') para.align = ALIGN[algn];
    if (level) para.level = level;
    // PowerPoint's 100 % is the editor's 1.2
    if (spc && Math.abs(spc - 1) > 0.01) para.lineSpacing = Math.round(spc * 1.2 * 100) / 100;
    out.push(para);
  }
  return out.length ? out : [{ runs: [{ text: '' }] }];
}

// ── shapes ────────────────────────────────────────────────────────────────

interface Xfrm {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

function readXfrm(el: Element | null): Xfrm | null {
  const off = kid(el, 'off');
  const ext = kid(el, 'ext');
  if (!el || !off || !ext) return null;
  const flag = (a: string) => el.getAttribute(a) === '1' || el.getAttribute(a) === 'true';
  return { x: px(num(off, 'x')), y: px(num(off, 'y')), w: px(num(ext, 'cx')), h: px(num(ext, 'cy')), rotation: num(el, 'rot') / 60000, flipH: flag('flipH'), flipV: flag('flipV') };
}

/** Maps a child's box out of a group's own coordinate space onto the slide. */
type Place = (b: Xfrm) => Xfrm;
const identity: Place = (b) => b;

interface SlideCtx {
  zip: JSZip;
  part: Part;
  layout: Part | null;
  master: Part | null;
  colors: ColorCtx;
  majorFont: string;
  minorFont: string;
  warnings: Set<string>;
  images: Map<string, string>;
  load: (path: string) => Promise<Part | null>;
}

const PH_KINDS: Record<string, PlaceholderType> = { title: 'title', ctrTitle: 'ctrTitle', subTitle: 'subTitle', body: 'body', obj: 'body' };
/** Placeholders that are furniture of the master, not content of a slide. */
const PH_SKIP = new Set(['dt', 'ftr', 'sldNum', 'hdr']);

/** The same placeholder on the layout or master: by index first, then by kind. */
function findPlaceholder(part: Part | null, type: string, idx: string | null): Element | null {
  if (!part) return null;
  const all = Array.from(part.xml.getElementsByTagName('*')).filter((e) => e.localName === 'ph');
  const same = (a: string, b: string) => a === b || (PH_KINDS[a] === 'body' && PH_KINDS[b] === 'body') || ((a === 'title' || a === 'ctrTitle') && (b === 'title' || b === 'ctrTitle'));
  const hit = (idx !== null && all.find((p) => p.getAttribute('idx') === idx)) || all.find((p) => same(p.getAttribute('type') ?? 'body', type));
  // ph → nvPr → nvSpPr → sp
  return hit?.parentElement?.parentElement?.parentElement ?? null;
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' };

async function imageData(ctx: SlideCtx, part: Part, rid: string | null | undefined): Promise<string | null> {
  const rel = rid ? part.rels.get(rid) : undefined;
  if (!rel || rel.external) return null;
  const hit = ctx.images.get(rel.target);
  if (hit !== undefined) return hit || null;
  const ext = rel.target.split('.').pop()?.toLowerCase() ?? '';
  const file = ctx.zip.file(rel.target);
  if (!file || !MIME[ext]) {
    // EMF / WMF / TIFF: formats a browser cannot draw
    ctx.images.set(rel.target, '');
    if (file) ctx.warnings.add(`${ext.toUpperCase()} pictures`);
    return null;
  }
  const url = `data:${MIME[ext]};base64,${await file.async('base64')}`;
  ctx.images.set(rel.target, url);
  return url;
}

function lineOf(spPr: Element | null, colors: ColorCtx): { color: string | null; width: number; dash?: 'dash' | 'dot'; head: boolean; tail: boolean } | null {
  const ln = kid(spPr, 'ln');
  if (!ln) return null;
  const dashVal = kid(ln, 'prstDash')?.getAttribute('val') ?? '';
  const dash = /dot/i.test(dashVal) ? 'dot' : /dash/i.test(dashVal) ? 'dash' : undefined;
  const end = (nm: string) => {
    const t = kid(ln, nm)?.getAttribute('type');
    return !!t && t !== 'none';
  };
  return { color: kid(ln, 'noFill') ? null : fillColor(ln, colors)?.color ?? null, width: Math.max(0.5, px(num(ln, 'w', 9525))), dash, head: end('headEnd'), tail: end('tailEnd') };
}

async function readShape(sp: Element, ctx: SlideCtx, part: Part, place: Place, locked: boolean): Promise<SlideElement | null> {
  const nv = kids(sp).find((c) => /^nv/.test(c.localName)) ?? null;
  const cNvPr = kid(nv, 'cNvPr');
  const name = cNvPr?.getAttribute('name') ?? undefined;
  const ph = path(nv, 'nvPr', 'ph');
  const phType = ph ? ph.getAttribute('type') ?? 'body' : null;
  if (phType && PH_SKIP.has(phType)) return null;
  // on the master and layouts, placeholders are prompts ("Click to edit…"), not content
  if (locked && ph) return null;
  const spPr = kid(sp, 'spPr');
  const chain: Element[] = [];
  if (ph && part === ctx.part) {
    const l = findPlaceholder(ctx.layout, phType!, ph.getAttribute('idx'));
    if (l) chain.push(l);
    const lph = l ? path(kids(l).find((c) => /^nv/.test(c.localName)) ?? null, 'nvPr', 'ph') : null;
    const m = findPlaceholder(ctx.master, lph?.getAttribute('type') ?? phType!, lph ? lph.getAttribute('idx') : ph.getAttribute('idx'));
    if (m) chain.push(m);
  }
  const own = readXfrm(kid(spPr, 'xfrm'));
  const box = own ?? chain.map((c) => readXfrm(path(c, 'spPr', 'xfrm'))).find(Boolean) ?? null;
  if (!box) return null;
  const b = place(box);
  const base = { id: uid('e'), x: b.x, y: b.y, w: b.w, h: b.h, rotation: b.rotation, ...(b.flipH ? { flipH: true } : {}), ...(b.flipV ? { flipV: true } : {}), ...(name ? { name } : {}), ...(locked ? { locked: true } : {}) };
  const ln = lineOf(spPr, ctx.colors);
  const styleLn = path(sp, 'style', 'lnRef');
  const styleFill = path(sp, 'style', 'fillRef');

  if (sp.localName === 'cxnSp' || kid(spPr, 'prstGeom')?.getAttribute('prst') === 'line') {
    const color = ln?.color ?? (styleLn ? colorOf(kids(styleLn)[0] ?? null, ctx.colors)?.color : null) ?? '#000000';
    return { ...base, kind: 'line', color, lineWidth: ln?.width ?? 1, ...(ln?.dash ? { lineDash: ln.dash } : {}), ...(ln?.head ? { startArrow: true } : {}), ...(ln?.tail ? { endArrow: true } : {}) };
  }

  if (sp.localName === 'pic') {
    const blipFill = kid(sp, 'blipFill');
    const src = await imageData(ctx, part, kid(blipFill, 'blip')?.getAttributeNS(R_NS, 'embed'));
    if (!src) return { ...base, kind: 'unsupported', label: 'Picture in a format that cannot be shown here' };
    const rect = kid(blipFill, 'srcRect');
    const crop: [number, number, number, number] | undefined = rect ? [num(rect, 'l') / 100000, num(rect, 't') / 100000, num(rect, 'r') / 100000, num(rect, 'b') / 100000] : undefined;
    const prst = kid(spPr, 'prstGeom')?.getAttribute('prst');
    return {
      ...base,
      kind: 'image',
      src,
      ...(crop && crop.some((v) => v > 0) ? { crop: crop.map((v) => Math.max(0, Math.min(0.95, v))) as [number, number, number, number] } : {}),
      ...(prst === 'roundRect' ? { radius: 0.1 } : prst === 'ellipse' ? { radius: 0.5 } : {}),
      ...(ln?.color ? { line: ln.color, lineWidth: ln.width } : {}),
      ...(path(spPr, 'effectLst', 'outerShdw') ? { shadow: true } : {}),
      ...(cNvPr?.getAttribute('descr') ? { alt: cNvPr.getAttribute('descr')! } : {}),
    };
  }

  // an ordinary shape or text box
  const txBody = kid(sp, 'txBody');
  const bodyPrs = [kid(txBody, 'bodyPr'), ...chain.map((c) => path(c, 'txBody', 'bodyPr'))].filter(Boolean) as Element[];
  const attr = (a: string) => bodyPrs.find((e) => e.hasAttribute(a))?.getAttribute(a) ?? null;
  const anchor = attr('anchor');
  const kind = phType ? PH_KINDS[phType] : undefined;
  const txStyles = kid(ctx.master?.xml, 'txStyles');
  const masterStyle = kind === 'title' || kind === 'ctrTitle' ? kid(txStyles, 'titleStyle') : kind ? kid(txStyles, 'bodyStyle') : kid(txStyles, 'otherStyle');
  const styles = [kid(txBody, 'lstStyle'), ...chain.map((c) => path(c, 'txBody', 'lstStyle')), masterStyle].filter(Boolean) as Element[];
  const fit = kid(kid(txBody, 'bodyPr'), 'normAutofit');
  // the shape style's text colour (white on accent-filled shapes)
  const fontRef = path(sp, 'style', 'fontRef');
  const styleColor = fontRef ? colorOf(kids(fontRef)[0] ?? null, ctx.colors)?.color : undefined;
  const text = readParagraphs(txBody, { colors: ctx.colors, majorFont: ctx.majorFont, minorFont: ctx.minorFont, styles, rels: part.rels, fontScale: fit ? num(fit, 'fontScale', 100000) / 100000 : 1, styleColor });

  const fillSources = [spPr, ...chain.map((c) => kid(c, 'spPr'))];
  let fill: ReturnType<typeof fillColor> = null;
  let noFill = false;
  for (const s of fillSources) {
    if (kid(s, 'noFill')) {
      noFill = true;
      break;
    }
    fill = fillColor(s, ctx.colors);
    if (fill) break;
  }
  if (!fill && !noFill && styleFill && num(styleFill, 'idx') > 0) fill = colorOf(kids(styleFill)[0] ?? null, ctx.colors);
  let line = ln?.color ?? null;
  if (!ln && styleLn && num(styleLn, 'idx') > 0) line = colorOf(kids(styleLn)[0] ?? null, ctx.colors)?.color ?? null;
  const prst = kid(spPr, 'prstGeom')?.getAttribute('prst') ?? 'rect';
  if (kid(spPr, 'custGeom')) ctx.warnings.add('freeform shapes (shown as rectangles)');
  const pad = num(bodyPrs.find((e) => e.hasAttribute('lIns')) ?? null, 'lIns', 91440);
  const el: ShapeElement = {
    ...base,
    kind: 'shape',
    shape: prst,
    fill: fill?.color ?? null,
    ...(fill?.color2 && fill.color2 !== fill.color ? { fill2: fill.color2 } : {}),
    line,
    lineWidth: ln?.width ?? 1,
    ...(ln?.dash ? { lineDash: ln.dash } : {}),
    text,
    valign: anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top',
    padding: Math.round(px(pad)),
    ...(kind && !locked ? { placeholder: kind } : {}),
    ...(path(spPr, 'effectLst', 'outerShdw') ? { shadow: true } : {}),
    ...(fill && fill.alpha < 1 ? { opacity: fill.alpha } : {}),
  };
  return el;
}

function readTable(frame: Element, tbl: Element, ctx: SlideCtx, part: Part, b: Xfrm, locked: boolean): TableElement {
  const cols = kids(kid(tbl, 'tblGrid'), 'gridCol').map((c) => px(num(c, 'w')));
  const trs = kids(tbl, 'tr');
  const rows = trs.map((r) => px(num(r, 'h')));
  const tblPr = kid(tbl, 'tblPr');
  const flag = (a: string) => tblPr?.getAttribute(a) === '1' || tblPr?.getAttribute(a) === 'true';
  let border: string | null = null;
  let borderWidth = 1;
  const cells: (TableCell | null)[][] = trs.map((tr) =>
    kids(tr, 'tc').map((tc): TableCell | null => {
      if (tc.getAttribute('hMerge') === '1' || tc.getAttribute('vMerge') === '1') return null;
      const tcPr = kid(tc, 'tcPr');
      for (const side of ['lnL', 'lnT', 'lnR', 'lnB']) {
        const ln = kid(tcPr, side);
        const c = ln && !kid(ln, 'noFill') ? fillColor(ln, ctx.colors)?.color : null;
        if (c && !border) {
          border = c;
          borderWidth = Math.max(0.5, px(num(ln, 'w', 12700)));
        }
      }
      const anchor = tcPr?.getAttribute('anchor');
      const cell: TableCell = {
        text: readParagraphs(kid(tc, 'txBody'), { colors: ctx.colors, majorFont: ctx.majorFont, minorFont: ctx.minorFont, styles: [], rels: part.rels, fontScale: 1 }),
        fill: kid(tcPr, 'noFill') ? null : fillColor(tcPr, ctx.colors)?.color ?? null,
      };
      if (num(tc, 'gridSpan', 1) > 1) cell.colSpan = num(tc, 'gridSpan');
      if (num(tc, 'rowSpan', 1) > 1) cell.rowSpan = num(tc, 'rowSpan');
      if (anchor === 'ctr') cell.valign = 'middle';
      else if (anchor === 'b') cell.valign = 'bottom';
      return cell;
    }),
  );
  const width = cols.reduce((a, c) => a + c, 0) || b.w;
  const height = rows.reduce((a, c) => a + c, 0) || b.h;
  const name = path(frame, 'nvGraphicFramePr', 'cNvPr')?.getAttribute('name') ?? undefined;
  // a table that names a built-in style but spells out no colours gets this app's table look
  const styled = cells.some((r) => r.some((c) => c?.fill));
  return { id: uid('e'), kind: 'table', x: b.x, y: b.y, w: width, h: height, rotation: 0, cols, rows, cells, border: border ?? (styled ? null : '#bfbfbf'), borderWidth, header: flag('firstRow'), banded: flag('bandRow'), ...(name ? { name } : {}), ...(locked ? { locked: true } : {}) };
}

/** The points of a chart data source (cached values of a reference, or literal values), by index. */
function chartPoints(src: Element | null): { count: number; at: Map<number, string> } {
  const holder = kids(src).find((c) => /Lit$|Ref$/.test(c.localName)) ?? null;
  const cache = holder && /Ref$/.test(holder.localName) ? kids(holder).find((c) => /Cache$/.test(c.localName)) ?? null : holder;
  const at = new Map<number, string>();
  // multi-level category labels: the innermost level
  const level = kid(cache, 'lvl') ?? cache;
  for (const pt of kids(level, 'pt')) at.set(num(pt, 'idx'), kid(pt, 'v')?.textContent ?? '');
  return { count: Math.max(num(kid(cache, 'ptCount'), 'val'), at.size ? Math.max(...at.keys()) + 1 : 0), at };
}

/** Reads a chart part into a chart the editor can draw, or null for kinds it cannot (scatter, radar, 3D surfaces…). */
function readChart(root: Element, b: Xfrm, name: string | undefined, locked: boolean): ChartElement | null {
  const chartEl = kid(root, 'chart');
  const plot = kid(chartEl, 'plotArea');
  const groups = kids(plot).filter((c) => /Chart$/.test(c.localName));
  if (!groups.length) return null;
  const first = groups[0].localName;
  let type: ChartElement['chart'];
  if (/^bar(3D)?Chart$/.test(first)) type = kid(groups[0], 'barDir')?.getAttribute('val') === 'bar' ? 'bar' : 'column';
  else if (/^(line|area)(3D)?Chart$/.test(first)) type = 'line';
  else if (/^(pie|doughnut|ofPie)(3D)?Chart$/.test(first)) type = 'pie';
  else return null;
  let categories: string[] = [];
  const series: ChartSeries[] = [];
  for (const g of groups) {
    for (const ser of kids(g, 'ser')) {
      const cat = chartPoints(kid(ser, 'cat'));
      const val = chartPoints(kid(ser, 'val'));
      const tx = kid(ser, 'tx');
      const label = kid(tx, 'v')?.textContent ?? chartPoints(tx).at.get(0) ?? `Series ${series.length + 1}`;
      const count = Math.max(cat.count, val.count);
      if (count > categories.length) categories = Array.from({ length: count }, (_, i) => cat.at.get(i) ?? categories[i] ?? String(i + 1));
      series.push({
        name: label,
        values: Array.from({ length: count }, (_, i) => {
          const v = val.at.get(i);
          return v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
        }),
      });
    }
  }
  if (!series.length) return null;
  for (const sr of series) while (sr.values.length < categories.length) sr.values.push(null);
  const titleEl = kid(chartEl, 'title');
  const title = titleEl ? Array.from(titleEl.getElementsByTagName('*')).filter((e) => e.localName === 't').map((e) => e.textContent ?? '').join('').trim() : '';
  return { id: uid('e'), kind: 'chart', chart: type, x: b.x, y: b.y, w: b.w, h: b.h, rotation: 0, categories, series, legend: !!kid(chartEl, 'legend'), ...(title ? { title } : {}), ...(name ? { name } : {}), ...(locked ? { locked: true } : {}) };
}

async function readTree(tree: Element | null, ctx: SlideCtx, part: Part, place: Place, locked: boolean, out: SlideElement[]): Promise<void> {
  for (const node of kids(tree)) {
    switch (node.localName) {
      case 'sp':
      case 'cxnSp':
      case 'pic': {
        if (node.localName === 'pic' && path(node, 'nvPicPr', 'nvPr')?.children.length && kids(path(node, 'nvPicPr', 'nvPr')).some((c) => /videoFile|audioFile/.test(c.localName))) {
          ctx.warnings.add('video and audio clips');
        }
        const el = await readShape(node, ctx, part, place, locked);
        if (el) out.push(el);
        break;
      }
      case 'grpSp': {
        const x = path(node, 'grpSpPr', 'xfrm');
        const g = readXfrm(x);
        const chOff = kid(x, 'chOff');
        const chExt = kid(x, 'chExt');
        let inner: Place = place;
        if (g && chOff && chExt) {
          const outer = place(g);
          const sx = outer.w / (px(num(chExt, 'cx')) || 1);
          const sy = outer.h / (px(num(chExt, 'cy')) || 1);
          const ox = px(num(chOff, 'x'));
          const oy = px(num(chOff, 'y'));
          // group rotation is added to its children; their positions are not swung around the group centre
          inner = (c) => ({ ...c, x: outer.x + (c.x - ox) * sx, y: outer.y + (c.y - oy) * sy, w: c.w * sx, h: c.h * sy, rotation: c.rotation + outer.rotation });
          if (outer.rotation) ctx.warnings.add('rotated groups (their shapes may sit slightly differently)');
        }
        await readTree(node, ctx, part, inner, locked, out);
        break;
      }
      case 'graphicFrame': {
        const b = readXfrm(kid(node, 'xfrm'));
        if (!b) break;
        const data = path(node, 'graphic', 'graphicData');
        const tbl = kid(data, 'tbl');
        if (tbl) {
          out.push(readTable(node, tbl, ctx, part, place(b), locked));
          break;
        }
        const uri = data?.getAttribute('uri') ?? '';
        if (/chart$/.test(uri)) {
          const rel = part.rels.get(kids(data)[0]?.getAttributeNS(R_NS, 'id') ?? '');
          const chartPart = rel && !rel.external ? await ctx.load(rel.target) : null;
          const drawn = chartPart ? readChart(chartPart.xml, place(b), path(node, 'nvGraphicFramePr', 'cNvPr')?.getAttribute('name') ?? undefined, locked) : null;
          if (drawn) {
            if (kids(path(chartPart!.xml, 'chart', 'plotArea')).filter((c) => /Chart$/.test(c.localName)).length > 1) ctx.warnings.add('combination charts (drawn as one type)');
            out.push(drawn);
            break;
          }
        }
        const what = /chart/.test(uri) ? 'Chart of a kind that cannot be drawn here' : /diagram/.test(uri) ? 'SmartArt diagram' : /ole/.test(uri) ? 'Embedded object' : 'Object';
        ctx.warnings.add(/chart/.test(uri) ? 'scatter, radar and other special charts' : `${what.toLowerCase()}s`);
        const pb = place(b);
        out.push({ id: uid('e'), kind: 'unsupported', label: `${what} (not shown or saved by File Editor)`, x: pb.x, y: pb.y, w: pb.w, h: pb.h, rotation: 0, ...(locked ? { locked: true } : {}) });
        break;
      }
      case 'AlternateContent': {
        // newer features come with an older fallback: use it
        const fb = kid(node, 'Fallback') ?? kid(node, 'Choice');
        await readTree(fb, ctx, part, place, locked, out);
        break;
      }
    }
  }
}

async function readBackground(part: Part | null, ctx: SlideCtx): Promise<Background | null> {
  const bg = path(part?.xml, 'cSld', 'bg');
  if (!bg || !part) return null;
  const bgPr = kid(bg, 'bgPr');
  if (bgPr) {
    const blip = path(bgPr, 'blipFill', 'blip');
    if (blip) {
      const src = await imageData(ctx, part, blip.getAttributeNS(R_NS, 'embed'));
      if (src) return { type: 'image', src };
    }
    const grad = kid(bgPr, 'gradFill');
    const c = fillColor(bgPr, ctx.colors);
    if (grad && c?.color2) return { type: 'gradient', from: c.color, to: c.color2, angle: (num(kid(grad, 'lin'), 'ang', 5400000) / 60000 + 90) % 360 };
    if (c) return { type: 'color', color: c.color };
    return null;
  }
  const ref = kid(bg, 'bgRef');
  const c = ref ? colorOf(kids(ref)[0] ?? null, ctx.colors) : null;
  return c ? { type: 'color', color: c.color } : null;
}

export interface PptxReadResult {
  deck: Deck;
  /** kinds of content that could not be brought in, for telling the user */
  warnings: string[];
}

export async function readPptx(bytes: Uint8Array): Promise<PptxReadResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error('This is not a PowerPoint file (or it is damaged).');
  }
  const cache = new Map<string, Part | null>();
  const load = async (p: string): Promise<Part | null> => {
    if (cache.has(p)) return cache.get(p)!;
    const f = zip.file(p);
    let part: Part | null = null;
    if (f) {
      const rels: Part['rels'] = new Map();
      const relFile = zip.file(p.replace(/([^/]+)$/, '_rels/$1.rels'));
      if (relFile) {
        for (const r of Array.from(parseXml(decodeText(await relFile.async('uint8array'))).getElementsByTagName('Relationship'))) {
          const external = r.getAttribute('TargetMode') === 'External';
          const target = r.getAttribute('Target') ?? '';
          rels.set(r.getAttribute('Id') ?? '', { target: external ? target : resolve(p, target), type: (r.getAttribute('Type') ?? '').split('/').pop() ?? '', external });
        }
      }
      part = { path: p, xml: parseXml(decodeText(await f.async('uint8array'))).documentElement, rels };
    }
    cache.set(p, part);
    return part;
  };
  const related = async (part: Part | null, type: string) => {
    const r = part ? [...part.rels.values()].find((v) => v.type === type && !v.external) : undefined;
    return r ? load(r.target) : null;
  };

  const pres = await load('ppt/presentation.xml');
  if (!pres) throw new Error('This file has no presentation in it. PowerPoint files (.pptx) can be opened; the older .ppt format cannot.');
  const sz = kid(pres.xml, 'sldSz');
  const width = Math.round(px(num(sz, 'cx', 12192000)));
  const height = Math.round(px(num(sz, 'cy', 6858000)));
  const warnings = new Set<string>();
  const images = new Map<string, string>();
  const slides: Slide[] = [];
  let theme: Theme | null = null;

  for (const id of kids(kid(pres.xml, 'sldIdLst'), 'sldId')) {
    const rel = pres.rels.get(id.getAttributeNS(R_NS, 'id') ?? '');
    const part = rel ? await load(rel.target) : null;
    if (!part) continue;
    const layout = await related(part, 'slideLayout');
    const master = await related(layout, 'slideMaster');
    const themePart = await related(master, 'theme');
    const scheme: Record<string, string> = {};
    const clr = path(themePart?.xml, 'themeElements', 'clrScheme');
    for (const c of kids(clr)) {
      const inner = kids(c)[0];
      const v = inner?.getAttribute('val') ?? '';
      scheme[c.localName] = inner?.localName === 'sysClr' ? inner.getAttribute('lastClr') ?? (v === 'window' ? 'FFFFFF' : '000000') : v;
    }
    const map: Record<string, string> = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };
    const clrMap = kid(master?.xml, 'clrMap');
    for (const a of Array.from(clrMap?.attributes ?? [])) map[a.name] = a.value;
    const over = path(part.xml, 'clrMapOvr', 'overrideClrMapping') ?? path(layout?.xml, 'clrMapOvr', 'overrideClrMapping');
    for (const a of Array.from(over?.attributes ?? [])) map[a.name] = a.value;
    const fonts = path(themePart?.xml, 'themeElements', 'fontScheme');
    const face = (which: string, fallback: string) => {
      const f = path(fonts, which, 'latin')?.getAttribute('typeface');
      return f && /^[\w\s.-]+$/.test(f) ? `"${f}", ${fallback}` : fallback;
    };
    const ctx: SlideCtx = { zip, part, layout, master, colors: { scheme, map }, majorFont: face('majorFont', 'Calibri, Arial, sans-serif'), minorFont: face('minorFont', 'Calibri, Arial, sans-serif'), warnings, images, load };

    if (!theme) {
      const hex = (k: string, fallback: string) => (scheme[map[k] ?? k] && /^[0-9a-f]{6}$/i.test(scheme[map[k] ?? k]) ? `#${scheme[map[k] ?? k].toLowerCase()}` : fallback);
      const themeName = themePart?.xml.getAttribute('name') ?? '';
      const ours = themeName.startsWith(THEME_MARK);
      const known = ours ? THEMES.find((t) => t.name === themeName.slice(THEME_MARK.length)) : undefined;
      theme = known ?? {
        id: 'file',
        name: (ours ? themeName.slice(THEME_MARK.length) : themeName) || 'From file',
        background: hex('bg1', '#ffffff'),
        text: hex('tx1', '#000000'),
        // files written here keep their heading colour in dk2; elsewhere titles are the text colour
        heading: ours ? hex('tx2', hex('tx1', '#000000')) : hex('tx1', '#000000'),
        accents: [1, 2, 3, 4, 5, 6].map((i) => hex(`accent${i}`, THEMES[0].accents[i - 1])) as Theme['accents'],
        headingFont: ctx.majorFont,
        bodyFont: ctx.minorFont,
      };
    }

    const elements: SlideElement[] = [];
    // master and layout artwork sits behind the slide's own content, unless the slide hides it
    const show = (p: Part | null) => p?.xml.getAttribute('showMasterSp') !== '0';
    if (master && show(part) && show(layout)) await readTree(path(master.xml, 'cSld', 'spTree'), ctx, master, identity, true, elements);
    if (layout && show(part)) await readTree(path(layout.xml, 'cSld', 'spTree'), ctx, layout, identity, true, elements);
    await readTree(path(part.xml, 'cSld', 'spTree'), ctx, part, identity, false, elements);

    const background = (await readBackground(part, ctx)) ?? (await readBackground(layout, ctx)) ?? (await readBackground(master, ctx));
    const notesPart = await related(part, 'notesSlide');
    let notes = '';
    if (notesPart) {
      const body = Array.from(notesPart.xml.getElementsByTagName('*')).find((e) => e.localName === 'ph' && e.getAttribute('type') === 'body')?.parentElement?.parentElement?.parentElement;
      notes = kids(kid(body, 'txBody'), 'p').map((p) => Array.from(p.getElementsByTagName('*')).filter((e) => e.localName === 't').map((t) => t.textContent ?? '').join('')).join('\n').trim();
    }
    const tr = kid(part.xml, 'transition') ?? path(part.xml, 'AlternateContent', 'Fallback', 'transition') ?? path(part.xml, 'AlternateContent', 'Choice', 'transition');
    let transition: Slide['transition'] = { type: 'none', duration: 0.6 };
    if (tr) {
      const kindName = kids(tr)[0]?.localName ?? 'fade';
      const type: TransitionType = (TRANSITIONS as readonly string[]).includes(kindName) ? (kindName as TransitionType) : 'fade';
      const spd = tr.getAttribute('spd');
      transition = { type, duration: spd === 'fast' ? 0.3 : spd === 'slow' ? 1.2 : 0.6 };
    }
    const hidden = part.xml.getAttribute('show') === '0';
    slides.push({ id: uid('s'), elements, background, notes, transition, ...(hidden ? { hidden: true } : {}) });
  }

  const deck: Deck = { width, height, slides, theme: theme ?? THEMES[0] };
  // a slide whose background is just the theme's has none of its own; table cells that match the table style have no fill of their own
  for (const s of deck.slides) {
    if (s.background?.type === 'color' && s.background.color.toLowerCase() === deck.theme.background.toLowerCase()) s.background = null;
    for (const e of s.elements) {
      if (e.kind !== 'table') continue;
      e.cells.forEach((row, ri) =>
        row.forEach((c) => {
          if (!c?.fill) return;
          const styled = cellFill(deck.theme, e, ri, null);
          if (styled !== 'transparent' && `#${flatten(styled, deck.theme.background)}`.toLowerCase() === c.fill.toLowerCase()) c.fill = null;
        }),
      );
    }
  }
  if (!deck.slides.length) deck.slides.push({ id: uid('s'), elements: [], background: null, notes: '', transition: { type: 'none', duration: 0.6 } });
  return { deck, warnings: [...warnings] };
}

/** True for a zip that holds a PowerPoint presentation. */
export async function isPptx(bytes: Uint8Array): Promise<boolean> {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  try {
    return !!(await JSZip.loadAsync(bytes)).file('ppt/presentation.xml');
  } catch {
    return false;
  }
}
