/**
 * Presentations (PowerPoint .pptx, and Google Slides files downloaded as PowerPoint).
 *
 * A deck is plain data: slides hold elements (text and shapes, pictures, tables, lines)
 * placed in slide pixels (96 per inch, so a 13.33 × 7.5 in widescreen slide is 1280 × 720).
 * Text is paragraphs of formatted runs; font sizes are in points, as PowerPoint shows them.
 * Reading and writing .pptx is in ./pptx-read and ./pptx-write, drawing in ./render.
 */

export const EMU_PER_PX = 9525;
export const PX_PER_PT = 96 / 72;

export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** points */
  size?: number;
  color?: string;
  font?: string;
  link?: string;
}

export type Align = 'left' | 'center' | 'right' | 'justify';

export interface Paragraph {
  runs: TextRun[];
  align?: Align;
  bullet?: 'none' | 'bullet' | 'number';
  /** indent level, 0–8 */
  level?: number;
  /** line height as a multiple of the font size (1 = single) */
  lineSpacing?: number;
}

export type PlaceholderType = 'title' | 'ctrTitle' | 'subTitle' | 'body';

interface ElementBase {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** degrees, clockwise */
  rotation: number;
  flipH?: boolean;
  flipV?: boolean;
  name?: string;
  /** came from the slide master or layout of an opened file: drawn, but kept out of the way */
  locked?: boolean;
}

/** Preset shapes the editor draws itself; any other PowerPoint preset is kept by name and drawn as a rectangle. */
export const SHAPES = [
  'rect', 'roundRect', 'ellipse', 'triangle', 'rtTriangle', 'diamond', 'parallelogram', 'trapezoid', 'pentagon', 'hexagon', 'octagon',
  'star5', 'rightArrow', 'leftArrow', 'upArrow', 'downArrow', 'leftRightArrow', 'chevron', 'homePlate', 'plus', 'heart', 'wedgeRectCallout', 'wedgeEllipseCallout', 'cloud',
] as const;
export type KnownShape = (typeof SHAPES)[number];

export const SHAPE_LABELS: Record<KnownShape, string> = {
  rect: 'Rectangle', roundRect: 'Rounded rectangle', ellipse: 'Oval', triangle: 'Triangle', rtTriangle: 'Right triangle', diamond: 'Diamond',
  parallelogram: 'Parallelogram', trapezoid: 'Trapezoid', pentagon: 'Pentagon', hexagon: 'Hexagon', octagon: 'Octagon', star5: 'Star',
  rightArrow: 'Right arrow', leftArrow: 'Left arrow', upArrow: 'Up arrow', downArrow: 'Down arrow', leftRightArrow: 'Double arrow', chevron: 'Chevron',
  homePlate: 'Pentagon arrow', plus: 'Cross', heart: 'Heart', wedgeRectCallout: 'Speech bubble', wedgeEllipseCallout: 'Oval speech bubble', cloud: 'Cloud',
};

export interface ShapeElement extends ElementBase {
  kind: 'shape';
  /** a PowerPoint preset geometry name */
  shape: string;
  fill: string | null;
  /** second colour: a top-to-bottom gradient */
  fill2?: string | null;
  line: string | null;
  /** px */
  lineWidth: number;
  lineDash?: 'solid' | 'dash' | 'dot';
  text: Paragraph[];
  valign: 'top' | 'middle' | 'bottom';
  /** inner margin, px */
  padding: number;
  placeholder?: PlaceholderType;
  shadow?: boolean;
  /** 0–1 */
  opacity?: number;
}

export interface LineElement extends ElementBase {
  kind: 'line';
  /** drawn from the top-left to the bottom-right of its box (flipH / flipV give the other diagonals) */
  color: string;
  lineWidth: number;
  lineDash?: 'solid' | 'dash' | 'dot';
  startArrow?: boolean;
  endArrow?: boolean;
}

export interface ImageElement extends ElementBase {
  kind: 'image';
  /** data: URL */
  src: string;
  /** cropped-away fractions of the picture: left, top, right, bottom */
  crop?: [number, number, number, number];
  /** corner radius as a fraction of the shorter side, 0–0.5 */
  radius?: number;
  line?: string | null;
  lineWidth?: number;
  shadow?: boolean;
  opacity?: number;
  alt?: string;
}

export interface TableCell {
  text: Paragraph[];
  fill?: string | null;
  /** cells this one spans; covered cells are null in the grid */
  colSpan?: number;
  rowSpan?: number;
  valign?: 'top' | 'middle' | 'bottom';
}

export interface TableElement extends ElementBase {
  kind: 'table';
  /** px; they add up to w and h */
  cols: number[];
  rows: number[];
  cells: (TableCell | null)[][];
  border: string | null;
  borderWidth: number;
  /** first row styled as a header */
  header: boolean;
  /** alternate rows shaded */
  banded: boolean;
}

export const CHART_TYPES = ['column', 'bar', 'line', 'pie'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export interface ChartSeries {
  name: string;
  /** one value per category; a missing value is a gap */
  values: (number | null)[];
}

export interface ChartElement extends ElementBase {
  kind: 'chart';
  chart: ChartType;
  title?: string;
  categories: string[];
  series: ChartSeries[];
  legend: boolean;
}

/** Something a file contained that the editor cannot draw or keep (chart, SmartArt, video…). */
export interface UnsupportedElement extends ElementBase {
  kind: 'unsupported';
  label: string;
}

export type SlideElement = ShapeElement | LineElement | ImageElement | TableElement | ChartElement | UnsupportedElement;

export type Background = { type: 'color'; color: string } | { type: 'gradient'; from: string; to: string; angle: number } | { type: 'image'; src: string };

export const TRANSITIONS = ['none', 'fade', 'push', 'wipe', 'cover', 'zoom'] as const;
export type TransitionType = (typeof TRANSITIONS)[number];

export interface Slide {
  id: string;
  elements: SlideElement[];
  /** null: the theme's background */
  background: Background | null;
  notes: string;
  transition: { type: TransitionType; /** seconds */ duration: number };
  hidden?: boolean;
}

export interface Theme {
  id: string;
  name: string;
  background: string;
  text: string;
  /** titles */
  heading: string;
  accents: [string, string, string, string, string, string];
  headingFont: string;
  bodyFont: string;
}

export interface Deck {
  width: number;
  height: number;
  slides: Slide[];
  theme: Theme;
}

const SANS = 'Calibri, "Segoe UI", Arial, sans-serif';

export const THEMES: Theme[] = [
  { id: 'office', name: 'Office', background: '#ffffff', text: '#262626', heading: '#1f1f1f', accents: ['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47'], headingFont: '"Calibri Light", Calibri, "Segoe UI", Arial, sans-serif', bodyFont: SANS },
  { id: 'midnight', name: 'Midnight', background: '#0f172a', text: '#e2e8f0', heading: '#ffffff', accents: ['#38bdf8', '#f472b6', '#a78bfa', '#facc15', '#34d399', '#fb923c'], headingFont: '"Segoe UI Semibold", "Segoe UI", Arial, sans-serif', bodyFont: '"Segoe UI", Arial, sans-serif' },
  { id: 'paper', name: 'Paper', background: '#faf6ee', text: '#3b3a36', heading: '#22211f', accents: ['#b45309', '#0f766e', '#7c2d12', '#a16207', '#1d4ed8', '#be123c'], headingFont: 'Georgia, "Times New Roman", serif', bodyFont: 'Georgia, "Times New Roman", serif' },
  { id: 'ocean', name: 'Ocean', background: '#f0f9ff', text: '#0c4a6e', heading: '#075985', accents: ['#0284c7', '#0d9488', '#6366f1', '#f59e0b', '#0ea5e9', '#14b8a6'], headingFont: '"Trebuchet MS", "Segoe UI", Arial, sans-serif', bodyFont: '"Trebuchet MS", "Segoe UI", Arial, sans-serif' },
  { id: 'forest', name: 'Forest', background: '#14281d', text: '#e8f1e9', heading: '#f7fbe9', accents: ['#84cc16', '#facc15', '#22c55e', '#fb923c', '#2dd4bf', '#eab308'], headingFont: 'Georgia, serif', bodyFont: '"Segoe UI", Arial, sans-serif' },
  { id: 'coral', name: 'Coral', background: '#fff7f5', text: '#3f2a2a', heading: '#b4232a', accents: ['#e5484d', '#f59e0b', '#8b5cf6', '#0ea5e9', '#10b981', '#ec4899'], headingFont: 'Arial, Helvetica, sans-serif', bodyFont: 'Arial, Helvetica, sans-serif' },
  { id: 'mono', name: 'Mono', background: '#ffffff', text: '#111111', heading: '#000000', accents: ['#111111', '#555555', '#888888', '#bbbbbb', '#333333', '#dddddd'], headingFont: '"Helvetica Neue", Helvetica, Arial, sans-serif', bodyFont: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
];

let counter = 0;
export const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

export const run = (text: string, style: Omit<TextRun, 'text'> = {}): TextRun => ({ text, ...style });
export const para = (text = '', style: Omit<Paragraph, 'runs'> & Omit<TextRun, 'text'> = {}): Paragraph => {
  const { align, bullet, level, lineSpacing, ...rs } = style;
  const p: Paragraph = { runs: [run(text, rs)] };
  if (align) p.align = align;
  if (bullet) p.bullet = bullet;
  if (level) p.level = level;
  if (lineSpacing) p.lineSpacing = lineSpacing;
  return p;
};

export const paragraphText = (p: Paragraph) => p.runs.map((r) => r.text).join('');
export const plainText = (ps: Paragraph[]) => ps.map(paragraphText).join('\n');

export function textBox(x: number, y: number, w: number, h: number, text: Paragraph[] = [para('')]): ShapeElement {
  return { id: uid('e'), kind: 'shape', shape: 'rect', x, y, w, h, rotation: 0, fill: null, line: null, lineWidth: 1, text, valign: 'top', padding: 10 };
}

export function shape(kind: string, x: number, y: number, w: number, h: number, fill: string, line: string | null = null): ShapeElement {
  return { id: uid('e'), kind: 'shape', shape: kind, x, y, w, h, rotation: 0, fill, line, lineWidth: 1.5, text: [para('', { align: 'center' })], valign: 'middle', padding: 10 };
}

export function line(x: number, y: number, w: number, h: number, color: string, endArrow = false): LineElement {
  return { id: uid('e'), kind: 'line', x, y, w, h, rotation: 0, color, lineWidth: 2, endArrow };
}

export function image(src: string, x: number, y: number, w: number, h: number): ImageElement {
  return { id: uid('e'), kind: 'image', src, x, y, w, h, rotation: 0 };
}

export function table(x: number, y: number, w: number, h: number, rows: number, cols: number): TableElement {
  return {
    id: uid('e'),
    kind: 'table',
    x,
    y,
    w,
    h,
    rotation: 0,
    cols: Array.from({ length: cols }, () => w / cols),
    rows: Array.from({ length: rows }, () => h / rows),
    cells: Array.from({ length: rows }, () => Array.from({ length: cols }, (): TableCell => ({ text: [para('')] }))),
    border: '#bfbfbf',
    borderWidth: 1,
    header: true,
    banded: true,
  };
}

export function chart(type: ChartType, x: number, y: number, w: number, h: number): ChartElement {
  return {
    id: uid('e'),
    kind: 'chart',
    chart: type,
    x,
    y,
    w,
    h,
    rotation: 0,
    categories: ['Q1', 'Q2', 'Q3', 'Q4'],
    series: type === 'pie' ? [{ name: 'Sales', values: [8.2, 3.2, 1.4, 1.2] }] : [{ name: 'Series 1', values: [4.3, 2.5, 3.5, 4.5] }, { name: 'Series 2', values: [2.4, 4.4, 1.8, 2.8] }],
    legend: true,
  };
}

/**
 * Chart data as text a person can edit: one row per line, cells separated by tabs or commas.
 * The first row holds the series names (after an empty corner cell), the first column the categories.
 */
export function chartToText(c: Pick<ChartElement, 'categories' | 'series'>): string {
  const cell = (v: string) => (/[",\t\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = [['', ...c.series.map((s) => s.name)], ...c.categories.map((cat, i) => [cat, ...c.series.map((s) => (s.values[i] === null || s.values[i] === undefined ? '' : String(s.values[i])))])];
  return rows.map((r) => r.map(cell).join('\t')).join('\n');
}

export function chartFromText(text: string): Pick<ChartElement, 'categories' | 'series'> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error('Chart data needs a first row of series names and at least one row of values.');
  const delim = lines[0].includes('\t') ? '\t' : lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
  const split = (l: string) => {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (quoted) {
        if (ch === '"' && l[i + 1] === '"') (cur += '"'), i++;
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delim) (out.push(cur.trim()), (cur = ''));
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const rows = lines.map(split);
  const names = rows[0].slice(1).filter((_, i, a) => i < a.length);
  if (!names.length) throw new Error('The first row needs at least one series name after the empty first cell.');
  const body = rows.slice(1);
  const series = names.map((name, si) => ({
    name: name || `Series ${si + 1}`,
    values: body.map((r) => {
      const raw = (r[si + 1] ?? '').replace(/\s/g, '').replace(/,(?=\d{1,2}$)/, '.');
      const v = raw === '' ? NaN : Number(raw);
      return Number.isFinite(v) ? v : null;
    }),
  }));
  return { categories: body.map((r, i) => r[0] || `${i + 1}`), series };
}

export type LayoutId = 'title' | 'titleContent' | 'section' | 'twoContent' | 'titleOnly' | 'blank';

export const LAYOUTS: { id: LayoutId; label: string }[] = [
  { id: 'title', label: 'Title slide' },
  { id: 'titleContent', label: 'Title and content' },
  { id: 'section', label: 'Section header' },
  { id: 'twoContent', label: 'Two content' },
  { id: 'titleOnly', label: 'Title only' },
  { id: 'blank', label: 'Blank' },
];

/** The placeholders of a layout, sized for the deck. Empty placeholders show a prompt in the editor only. */
export function layoutElements(deck: Pick<Deck, 'width' | 'height'>, layout: LayoutId): ShapeElement[] {
  const { width: W, height: H } = deck;
  const mx = W * 0.07;
  const ph = (placeholder: PlaceholderType, x: number, y: number, w: number, h: number, extra: Partial<ShapeElement> = {}, align?: Align): ShapeElement => ({
    ...textBox(x, y, w, h, [align ? { runs: [run('')], align } : { runs: [run('')] }]),
    placeholder,
    ...extra,
  });
  switch (layout) {
    case 'title':
      return [ph('ctrTitle', mx * 1.5, H * 0.24, W - mx * 3, H * 0.3, { valign: 'bottom' }, 'center'), ph('subTitle', mx * 1.5, H * 0.57, W - mx * 3, H * 0.2, {}, 'center')];
    case 'titleContent':
      return [ph('title', mx, H * 0.06, W - mx * 2, H * 0.18, { valign: 'middle' }), ph('body', mx, H * 0.27, W - mx * 2, H * 0.63)];
    case 'section':
      return [ph('title', mx, H * 0.3, W - mx * 2, H * 0.28, { valign: 'bottom' }), ph('subTitle', mx, H * 0.6, W - mx * 2, H * 0.18)];
    case 'twoContent': {
      const gap = W * 0.03;
      const cw = (W - mx * 2 - gap) / 2;
      return [ph('title', mx, H * 0.06, W - mx * 2, H * 0.18, { valign: 'middle' }), ph('body', mx, H * 0.27, cw, H * 0.63), ph('body', mx + cw + gap, H * 0.27, cw, H * 0.63)];
    }
    case 'titleOnly':
      return [ph('title', mx, H * 0.06, W - mx * 2, H * 0.18, { valign: 'middle' })];
    default:
      return [];
  }
}

export function newSlide(deck: Pick<Deck, 'width' | 'height'>, layout: LayoutId = 'titleContent'): Slide {
  return { id: uid('s'), elements: layoutElements(deck, layout), background: null, notes: '', transition: { type: 'none', duration: 0.6 }, hidden: false };
}

export function newDeck(theme: Theme = THEMES[0], width = 1280, height = 720): Deck {
  const deck: Deck = { width, height, slides: [], theme };
  deck.slides.push(newSlide(deck, 'title'));
  return deck;
}

/** Default text size (pt), weight and whether paragraphs are bulleted, by what a text shape is for. */
export function textDefaults(el: Pick<ShapeElement, 'placeholder'>, deck: Pick<Deck, 'height'>): { size: number; bullets: boolean; heading: boolean } {
  const k = deck.height / 720;
  switch (el.placeholder) {
    case 'ctrTitle':
      return { size: Math.round(54 * k), bullets: false, heading: true };
    case 'title':
      return { size: Math.round(40 * k), bullets: false, heading: true };
    case 'subTitle':
      return { size: Math.round(24 * k), bullets: false, heading: false };
    case 'body':
      return { size: Math.round(24 * k), bullets: true, heading: false };
    default:
      return { size: Math.round(18 * k), bullets: false, heading: false };
  }
}

export const PLACEHOLDER_PROMPTS: Record<PlaceholderType, string> = {
  title: 'Click to add title',
  ctrTitle: 'Click to add title',
  subTitle: 'Click to add subtitle',
  body: 'Click to add text',
};

export const isEmptyText = (ps: Paragraph[]) => ps.every((p) => p.runs.every((r) => !r.text));

/** Deep copy with fresh ids (duplicate slide / paste). */
export function cloneElement<T extends SlideElement>(el: T, dx = 0, dy = 0): T {
  return { ...structuredClone(el), id: uid('e'), x: el.x + dx, y: el.y + dy };
}

export function cloneSlide(s: Slide): Slide {
  return { ...structuredClone(s), id: uid('s'), elements: s.elements.map((e) => cloneElement(e)) };
}

/** Merges neighbouring runs with the same formatting and drops empty ones (keeping one run per paragraph). */
export function normalizeParagraph(p: Paragraph): Paragraph {
  const same = (a: TextRun, b: TextRun) => !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.underline === !!b.underline && !!a.strike === !!b.strike && a.size === b.size && a.color === b.color && a.font === b.font && a.link === b.link;
  const runs: TextRun[] = [];
  for (const r of p.runs) {
    if (!r.text && p.runs.length > 1) continue;
    const last = runs[runs.length - 1];
    if (last && same(last, r)) last.text += r.text;
    else runs.push({ ...r });
  }
  if (!runs.length) runs.push({ ...(p.runs[0] ?? { text: '' }), text: '' });
  return { ...p, runs };
}

/** Applies a style to every run of every paragraph. */
export function styleAll(ps: Paragraph[], patch: Partial<Omit<TextRun, 'text'>>): Paragraph[] {
  return ps.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, ...patch })) }));
}

/** Changes every slide's size-dependent geometry when the slide size changes. */
export function resizeDeck(deck: Deck, width: number, height: number): Deck {
  const sx = width / deck.width;
  const sy = height / deck.height;
  const s = Math.min(sx, sy);
  const ox = (width - deck.width * s) / 2;
  const oy = (height - deck.height * s) / 2;
  const slides = deck.slides.map((sl) => ({
    ...sl,
    elements: sl.elements.map((e): SlideElement => {
      const base = { ...e, x: e.x * s + ox, y: e.y * s + oy, w: e.w * s, h: e.h * s };
      if (base.kind === 'table') return { ...base, cols: base.cols.map((c) => c * s), rows: base.rows.map((r) => r * s) };
      return base;
    }),
  }));
  return { ...deck, width, height, slides };
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every paragraph list in a slide (shape text and table cells), with a way to write it back. */
function mapSlideText(slide: Slide, fn: (ps: Paragraph[]) => Paragraph[]): Slide {
  return {
    ...slide,
    elements: slide.elements.map((e): SlideElement => {
      if (e.locked) return e;
      if (e.kind === 'shape') return { ...e, text: fn(e.text) };
      if (e.kind === 'table') return { ...e, cells: e.cells.map((row) => row.map((c) => (c ? { ...c, text: fn(c.text) } : c))) };
      return e;
    }),
  };
}

/** The elements of a slide whose text contains `find`. */
export function findInSlide(slide: Slide, find: string, matchCase = false): string[] {
  if (!find) return [];
  const has = (ps: Paragraph[]) => ps.some((p) => (matchCase ? paragraphText(p).includes(find) : paragraphText(p).toLowerCase().includes(find.toLowerCase())));
  return slide.elements.filter((e) => !e.locked && ((e.kind === 'shape' && has(e.text)) || (e.kind === 'table' && e.cells.some((row) => row.some((c) => c && has(c.text)))))).map((e) => e.id);
}

/**
 * Replaces text throughout the deck (slides and speaker notes), keeping the formatting of the
 * text it replaces. Text that changes formatting part-way through a match is left alone.
 */
export function replaceInDeck(deck: Deck, find: string, replace: string, matchCase = false): { deck: Deck; count: number } {
  if (!find) return { deck, count: 0 };
  const re = new RegExp(escapeRe(find), matchCase ? 'g' : 'gi');
  let count = 0;
  const swap = (t: string) =>
    t.replace(re, () => {
      count++;
      return replace;
    });
  const slides = deck.slides.map((s) => ({ ...mapSlideText(s, (ps) => ps.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, text: swap(r.text) })) }))), notes: swap(s.notes) }));
  return count ? { deck: { ...deck, slides }, count } : { deck, count: 0 };
}
