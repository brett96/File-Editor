/**
 * Draws slides as self-contained HTML (inline styles and inline SVG only). The editor stage,
 * the thumbnails, the slide show and the picture / PDF export all use this one renderer, so
 * they agree. Text from the deck is always escaped: nothing in a file can inject markup.
 */
import {
  PLACEHOLDER_PROMPTS,
  PX_PER_PT,
  isEmptyText,
  textDefaults,
  type Background,
  type Deck,
  type ImageElement,
  type LineElement,
  type Paragraph,
  type ShapeElement,
  type Slide,
  type SlideElement,
  type TableElement,
  type TextRun,
  type Theme,
} from './model';

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Only colours and fonts of a safe shape reach a style attribute. */
const safeColor = (c: string | null | undefined, fallback: string) => (c && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i.test(c) ? c : fallback);
/** Font lists go inside style="…", so family names are quoted with single quotes. */
const safeFont = (f: string) => f.replace(/"/g, "'").replace(/[^\w\s,'-]/g, '');
const safeUrl = (u: string) => (/^(https?:|mailto:)/i.test(u) ? u : '#');
const safeImage = (u: string) => (/^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml|avif);base64,[A-Za-z0-9+/=]+$/.test(u) ? u : '');
const n = (v: number) => (Math.round(v * 100) / 100).toString();

export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})/i.exec(hex) ?? /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  if (!m) return 1;
  const full = m.length === 2 ? m[1] : m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
  const v = parseInt(full, 16);
  return (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255;
}

/** Outline of a preset shape in a w × h box (SVG path data). Unknown presets are rectangles. */
export function shapePath(shape: string, w: number, h: number): string {
  const P = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x * w)} ${n(y * h)}`).join(' ') + ' Z';
  switch (shape) {
    case 'ellipse':
      return `M0 ${n(h / 2)} A${n(w / 2)} ${n(h / 2)} 0 1 1 ${n(w)} ${n(h / 2)} A${n(w / 2)} ${n(h / 2)} 0 1 1 0 ${n(h / 2)} Z`;
    case 'roundRect': {
      const r = Math.min(w, h) * 0.16;
      return `M${n(r)} 0 H${n(w - r)} A${n(r)} ${n(r)} 0 0 1 ${n(w)} ${n(r)} V${n(h - r)} A${n(r)} ${n(r)} 0 0 1 ${n(w - r)} ${n(h)} H${n(r)} A${n(r)} ${n(r)} 0 0 1 0 ${n(h - r)} V${n(r)} A${n(r)} ${n(r)} 0 0 1 ${n(r)} 0 Z`;
    }
    case 'triangle':
      return P([[0.5, 0], [1, 1], [0, 1]]);
    case 'rtTriangle':
      return P([[0, 0], [1, 1], [0, 1]]);
    case 'diamond':
      return P([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]);
    case 'parallelogram':
      return P([[0.25, 0], [1, 0], [0.75, 1], [0, 1]]);
    case 'trapezoid':
      return P([[0.25, 0], [0.75, 0], [1, 1], [0, 1]]);
    case 'pentagon':
      return P([[0.5, 0], [1, 0.38], [0.81, 1], [0.19, 1], [0, 0.38]]);
    case 'hexagon':
      return P([[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]);
    case 'octagon':
      return P([[0.29, 0], [0.71, 0], [1, 0.29], [1, 0.71], [0.71, 1], [0.29, 1], [0, 0.71], [0, 0.29]]);
    case 'star5': {
      const pts: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 0.2 : 0.5;
        const a = (Math.PI * i) / 5 - Math.PI / 2;
        pts.push([0.5 + r * Math.cos(a) * 1.05, 0.52 + r * Math.sin(a) * 1.05]);
      }
      return P(pts);
    }
    case 'rightArrow':
      return P([[0, 0.25], [0.6, 0.25], [0.6, 0], [1, 0.5], [0.6, 1], [0.6, 0.75], [0, 0.75]]);
    case 'leftArrow':
      return P([[1, 0.25], [0.4, 0.25], [0.4, 0], [0, 0.5], [0.4, 1], [0.4, 0.75], [1, 0.75]]);
    case 'upArrow':
      return P([[0.25, 1], [0.25, 0.4], [0, 0.4], [0.5, 0], [1, 0.4], [0.75, 0.4], [0.75, 1]]);
    case 'downArrow':
      return P([[0.25, 0], [0.25, 0.6], [0, 0.6], [0.5, 1], [1, 0.6], [0.75, 0.6], [0.75, 0]]);
    case 'leftRightArrow':
      return P([[0, 0.5], [0.25, 0], [0.25, 0.25], [0.75, 0.25], [0.75, 0], [1, 0.5], [0.75, 1], [0.75, 0.75], [0.25, 0.75], [0.25, 1]]);
    case 'chevron':
      return P([[0, 0], [0.7, 0], [1, 0.5], [0.7, 1], [0, 1], [0.3, 0.5]]);
    case 'homePlate':
      return P([[0, 0], [0.7, 0], [1, 0.5], [0.7, 1], [0, 1]]);
    case 'plus':
      return P([[0.33, 0], [0.67, 0], [0.67, 0.33], [1, 0.33], [1, 0.67], [0.67, 0.67], [0.67, 1], [0.33, 1], [0.33, 0.67], [0, 0.67], [0, 0.33], [0.33, 0.33]]);
    case 'heart':
      return `M${n(w / 2)} ${n(h * 0.3)} C${n(w * 0.5)} ${n(h * 0.05)} ${n(w * 0.05)} ${n(h * -0.02)} ${n(w * 0.04)} ${n(h * 0.33)} C${n(w * 0.03)} ${n(h * 0.62)} ${n(w * 0.35)} ${n(h * 0.8)} ${n(w / 2)} ${n(h)} C${n(w * 0.65)} ${n(h * 0.8)} ${n(w * 0.97)} ${n(h * 0.62)} ${n(w * 0.96)} ${n(h * 0.33)} C${n(w * 0.95)} ${n(h * -0.02)} ${n(w * 0.5)} ${n(h * 0.05)} ${n(w / 2)} ${n(h * 0.3)} Z`;
    case 'wedgeRectCallout':
      return P([[0, 0], [1, 0], [1, 0.75], [0.45, 0.75], [0.2, 1], [0.25, 0.75], [0, 0.75]]);
    case 'wedgeEllipseCallout':
      return `M${n(w * 0.22)} ${n(h * 0.72)} A${n(w / 2)} ${n(h * 0.4)} 0 1 1 ${n(w * 0.42)} ${n(h * 0.79)} L${n(w * 0.15)} ${n(h)} Z`;
    case 'cloud':
      return `M${n(w * 0.25)} ${n(h * 0.85)} A${n(w * 0.2)} ${n(h * 0.25)} 0 0 1 ${n(w * 0.15)} ${n(h * 0.42)} A${n(w * 0.2)} ${n(h * 0.25)} 0 0 1 ${n(w * 0.4)} ${n(h * 0.18)} A${n(w * 0.2)} ${n(h * 0.22)} 0 0 1 ${n(w * 0.72)} ${n(h * 0.22)} A${n(w * 0.18)} ${n(h * 0.25)} 0 0 1 ${n(w * 0.85)} ${n(h * 0.6)} A${n(w * 0.18)} ${n(h * 0.22)} 0 0 1 ${n(w * 0.7)} ${n(h * 0.85)} Z`;
    default:
      return `M0 0 H${n(w)} V${n(h)} H0 Z`;
  }
}

const dashArray = (dash: string | undefined, width: number) => (dash === 'dash' ? `${n(width * 4)} ${n(width * 3)}` : dash === 'dot' ? `${n(width)} ${n(width * 2)}` : '');

export interface TextStyle {
  /** points */
  size: number;
  color: string;
  font: string;
  bullets: boolean;
  bold?: boolean;
  align?: 'left' | 'center' | 'right' | 'justify';
}

function runStyle(r: TextRun, d: TextStyle): string {
  const parts: string[] = [];
  if (r.size && r.size !== d.size) parts.push(`font-size:${n(r.size * PX_PER_PT)}px`);
  if (r.color) parts.push(`color:${safeColor(r.color, d.color)}`);
  if (r.font) parts.push(`font-family:${safeFont(r.font)}`);
  if (r.bold !== undefined ? r.bold : false) parts.push('font-weight:700');
  else if (r.bold === false && d.bold) parts.push('font-weight:400');
  if (r.italic) parts.push('font-style:italic');
  const deco = [r.underline || r.link ? 'underline' : '', r.strike ? 'line-through' : ''].filter(Boolean).join(' ');
  if (deco) parts.push(`text-decoration:${deco}`);
  return parts.join(';');
}

/**
 * Paragraphs as HTML: one <div data-p> per paragraph with <span> runs. The same markup is
 * what the editor makes editable and reads back (see ui/slides/text-edit.ts).
 */
export function paragraphsHtml(ps: Paragraph[], d: TextStyle): string {
  return ps
    .map((p) => {
      const bullet = p.bullet ?? (d.bullets ? 'bullet' : 'none');
      const level = Math.min(8, Math.max(0, p.level ?? 0));
      const biggest = Math.max(d.size, ...p.runs.map((r) => r.size ?? 0));
      const style = [
        'margin:0',
        `text-align:${p.align ?? d.align ?? 'left'}`,
        `line-height:${n(p.lineSpacing ?? 1.2)}`,
        // an empty paragraph still takes a line of its largest run
        `min-height:${n(biggest * PX_PER_PT * (p.lineSpacing ?? 1.2))}px`,
      ];
      if (bullet !== 'none') style.push('display:list-item', `list-style:${bullet === 'number' ? 'decimal' : level % 2 ? 'circle' : 'disc'} outside`, `margin-left:${n(1.3 + level * 1.4)}em`);
      else {
        // any paragraph that is not numbered restarts the numbering after it
        style.push('counter-reset:list-item');
        if (level) style.push(`margin-left:${n(level * 1.4)}em`);
      }
      const attrs = `data-p="1" data-bullet="${bullet}" data-level="${level}"${p.align ? ` data-align="${p.align}"` : ''}${p.lineSpacing ? ` data-ls="${n(p.lineSpacing)}"` : ''}`;
      const runs = p.runs
        .map((r) => {
          const s = runStyle(r, d);
          const link = r.link ? ` data-link="${esc(r.link)}"` : '';
          const flags = `${r.bold ? ' data-b="1"' : r.bold === false ? ' data-b="0"' : ''}`;
          return r.text || p.runs.length === 1 ? `<span${s ? ` style="${s}"` : ''}${link}${flags}>${esc(r.text) || '<br>'}</span>` : '';
        })
        .join('');
      return `<div ${attrs} style="${style.join(';')}">${runs}</div>`;
    })
    .join('');
}

/** The text style a shape's paragraphs start from. */
export function shapeTextStyle(el: ShapeElement, deck: Pick<Deck, 'theme' | 'height'>): TextStyle {
  const d = textDefaults(el, deck);
  const t = deck.theme;
  // text on a filled shape is drawn light or dark to stay readable, as PowerPoint's shape styles do
  const onFill = el.fill && !el.placeholder ? (luminance(el.fill) < 0.6 ? '#ffffff' : '#1f1f1f') : null;
  return { size: d.size, color: onFill ?? (d.heading ? t.heading : t.text), font: d.heading ? t.headingFont : t.bodyFont, bullets: d.bullets };
}

function shapeHtml(el: ShapeElement, deck: Deck, prompts: boolean): string {
  const { w, h } = el;
  const flip = el.flipH || el.flipV ? ` transform="translate(${el.flipH ? n(w) : 0} ${el.flipV ? n(h) : 0}) scale(${el.flipH ? -1 : 1} ${el.flipV ? -1 : 1})"` : '';
  let svg = '';
  if (el.fill || el.line) {
    const gid = `g${el.id.replace(/\W/g, '')}`;
    const grad = el.fill && el.fill2 ? `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${safeColor(el.fill, '#888')}"/><stop offset="1" stop-color="${safeColor(el.fill2, '#888')}"/></linearGradient></defs>` : '';
    const fill = el.fill ? (el.fill2 ? `url(#${gid})` : safeColor(el.fill, '#888')) : 'none';
    const dash = dashArray(el.lineDash, el.lineWidth);
    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}" height="${n(h)}" viewBox="0 0 ${n(w)} ${n(h)}" style="position:absolute;left:0;top:0;overflow:visible${el.shadow ? ';filter:drop-shadow(0 4px 6px rgba(0,0,0,0.35))' : ''}">${grad}<path${flip} d="${shapePath(el.shape, w, h)}" fill="${fill}" stroke="${el.line ? safeColor(el.line, '#000') : 'none'}" stroke-width="${el.line ? n(el.lineWidth) : 0}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linejoin="round"/></svg>`;
  }
  const style = shapeTextStyle(el, deck);
  const empty = isEmptyText(el.text);
  let text = '';
  if (!empty) text = paragraphsHtml(el.text, style);
  else if (prompts && el.placeholder) text = `<div style="margin:0;opacity:0.45;text-align:${el.text[0]?.align ?? 'left'}">${PLACEHOLDER_PROMPTS[el.placeholder]}</div>`;
  const justify = el.valign === 'middle' ? 'center' : el.valign === 'bottom' ? 'flex-end' : 'flex-start';
  const box = `<div data-text="1" style="position:absolute;left:0;top:0;width:${n(w)}px;height:${n(h)}px;box-sizing:border-box;padding:${n(el.padding)}px;display:flex;flex-direction:column;justify-content:${justify};overflow:visible;font-family:${safeFont(style.font)};font-size:${n(style.size * PX_PER_PT)}px;color:${style.color};word-wrap:break-word;overflow-wrap:break-word;white-space:pre-wrap"><div style="width:100%">${text}</div></div>`;
  const dashed = prompts && el.placeholder && empty ? `<div style="position:absolute;left:0;top:0;width:${n(w)}px;height:${n(h)}px;box-sizing:border-box;border:1px dashed rgba(128,128,128,0.6)"></div>` : '';
  return svg + dashed + box;
}

function lineHtml(el: LineElement): string {
  const w = Math.max(el.w, 0.01);
  const h = Math.max(el.h, 0.01);
  const x1 = el.flipH ? w : 0;
  const x2 = el.flipH ? 0 : w;
  const y1 = el.flipV ? h : 0;
  const y2 = el.flipV ? 0 : h;
  const id = el.id.replace(/\W/g, '');
  const color = safeColor(el.color, '#000');
  const head = (mid: string, start: boolean) => `<marker id="${mid}" viewBox="0 0 10 10" refX="${start ? 1 : 9}" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="${color}"/></marker>`;
  const defs = el.startArrow || el.endArrow ? `<defs>${el.startArrow ? head(`a${id}s`, true) : ''}${el.endArrow ? head(`a${id}e`, false) : ''}</defs>` : '';
  const dash = dashArray(el.lineDash, el.lineWidth);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}" height="${n(h)}" style="position:absolute;left:0;top:0;overflow:visible">${defs}<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${color}" stroke-width="${n(el.lineWidth)}" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}${el.startArrow ? ` marker-start="url(#a${id}s)"` : ''}${el.endArrow ? ` marker-end="url(#a${id}e)"` : ''}/></svg>`;
}

function imageHtml(el: ImageElement): string {
  const [l, t, r, b] = el.crop ?? [0, 0, 0, 0];
  const iw = el.w / Math.max(0.01, 1 - l - r);
  const ih = el.h / Math.max(0.01, 1 - t - b);
  const radius = el.radius ? `border-radius:${n(Math.min(el.w, el.h) * Math.min(0.5, el.radius))}px;` : '';
  const border = el.line ? `outline:${n(el.lineWidth ?? 1)}px solid ${safeColor(el.line, '#000')};` : '';
  const shadow = el.shadow ? 'box-shadow:0 6px 16px rgba(0,0,0,0.35);' : '';
  const flip = el.flipH || el.flipV ? `transform:scale(${el.flipH ? -1 : 1},${el.flipV ? -1 : 1});` : '';
  const src = safeImage(el.src);
  const img = src
    ? `<img src="${src}" alt="${esc(el.alt ?? '')}" draggable="false" style="position:absolute;left:${n(-l * iw)}px;top:${n(-t * ih)}px;width:${n(iw)}px;height:${n(ih)}px;max-width:none;${flip}"/>`
    : `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#e5e7eb;color:#6b7280;font:12px sans-serif">Picture</div>`;
  return `<div style="position:absolute;left:0;top:0;width:${n(el.w)}px;height:${n(el.h)}px;overflow:hidden;${radius}${border}${shadow}opacity:${n(el.opacity ?? 1)}">${img}</div>`;
}

/** Text style of a table cell (header row cells are bold and light on the accent colour). */
export function cellTextStyle(deck: Pick<Deck, 'theme' | 'height'>, t: TableElement, row: number): TextStyle {
  const header = t.header && row === 0;
  return { size: Math.round(16 * (deck.height / 720)), color: header ? '#ffffff' : deck.theme.text, font: deck.theme.bodyFont, bullets: false, bold: header };
}

/** Background of a cell: its own fill, else the header / banding of the table style. */
export function cellFill(theme: Theme, t: TableElement, row: number, own: string | null | undefined): string {
  if (own) return safeColor(own, 'transparent');
  if (t.header && row === 0) return theme.accents[0];
  if (t.banded && (row - (t.header ? 1 : 0)) % 2 === 0) return luminance(theme.background) < 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)';
  return 'transparent';
}

function tableHtml(el: TableElement, deck: Deck): string {
  const border = el.border ? `${n(el.borderWidth)}px solid ${safeColor(el.border, '#bbb')}` : 'none';
  const cols = el.cols.map((c) => `<col style="width:${n(c)}px"/>`).join('');
  const rows = el.cells
    .map((row, ri) => {
      const tds = row
        .map((cell, ci) => {
          if (!cell) return '';
          const style = cellTextStyle(deck, el, ri);
          const va = cell.valign === 'middle' ? 'middle' : cell.valign === 'bottom' ? 'bottom' : 'top';
          return `<td data-cell="${ri},${ci}"${cell.colSpan && cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : ''}${cell.rowSpan && cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ''} style="border:${border};padding:5px 8px;vertical-align:${va};background:${cellFill(deck.theme, el, ri, cell.fill)};font-family:${safeFont(style.font)};font-size:${n(style.size * PX_PER_PT)}px;color:${style.color};${style.bold ? 'font-weight:700;' : ''}overflow:hidden;word-wrap:break-word;white-space:pre-wrap">${paragraphsHtml(cell.text, style)}</td>`;
        })
        .join('');
      return `<tr style="height:${n(el.rows[ri])}px">${tds}</tr>`;
    })
    .join('');
  return `<table style="position:absolute;left:0;top:0;width:${n(el.w)}px;height:${n(el.h)}px;border-collapse:collapse;table-layout:fixed;border-spacing:0"><colgroup>${cols}</colgroup><tbody>${rows}</tbody></table>`;
}

export interface RenderOptions {
  /** show "Click to add title" in empty placeholders (editor only) */
  prompts?: boolean;
  /** leave this element out (it is being edited in place) */
  skipId?: string | null;
}

/** What is inside an element's box (not its position or rotation). */
export function elementInner(el: SlideElement, deck: Deck, prompts = false): string {
  switch (el.kind) {
    case 'shape':
      return shapeHtml(el, deck, prompts);
    case 'line':
      return lineHtml(el);
    case 'image':
      return imageHtml(el);
    case 'table':
      return tableHtml(el, deck);
    case 'unsupported':
      return `<div style="position:absolute;left:0;top:0;width:${n(el.w)}px;height:${n(el.h)}px;box-sizing:border-box;border:1px dashed #9ca3af;background:rgba(156,163,175,0.15);color:#6b7280;display:flex;align-items:center;justify-content:center;text-align:center;font:13px sans-serif;padding:6px">${esc(el.label)}</div>`;
  }
}

export function elementHtml(el: SlideElement, deck: Deck, prompts = false): string {
  const opacity = el.kind === 'shape' && el.opacity !== undefined && el.opacity < 1 ? `opacity:${n(el.opacity)};` : '';
  return `<div data-el="${esc(el.id)}" style="position:absolute;left:${n(el.x)}px;top:${n(el.y)}px;width:${n(el.w)}px;height:${n(el.h)}px;${el.rotation ? `transform:rotate(${n(el.rotation)}deg);` : ''}${opacity}">${elementInner(el, deck, prompts)}</div>`;
}

export function backgroundCss(bg: Background | null, theme: Theme): string {
  if (!bg) return `background:${safeColor(theme.background, '#fff')}`;
  if (bg.type === 'color') return `background:${safeColor(bg.color, '#fff')}`;
  if (bg.type === 'gradient') return `background:linear-gradient(${n(bg.angle)}deg, ${safeColor(bg.from, '#fff')}, ${safeColor(bg.to, '#fff')})`;
  const src = safeImage(bg.src);
  return src ? `background:${safeColor(theme.background, '#fff')} url('${src}') center / cover no-repeat` : `background:${safeColor(theme.background, '#fff')}`;
}

/** A whole slide at its natural size (deck.width × deck.height px). */
export function slideHtml(deck: Deck, slide: Slide, o: RenderOptions = {}): string {
  const els = slide.elements.filter((e) => e.id !== o.skipId).map((e) => elementHtml(e, deck, o.prompts)).join('');
  return `<div style="position:relative;width:${deck.width}px;height:${deck.height}px;overflow:hidden;${backgroundCss(slide.background, deck.theme)}">${els}</div>`;
}

/** The slide as a standalone SVG image (HTML inside a foreignObject), for turning into a PNG. */
export function slideSvg(deck: Deck, slide: Slide, scale = 1): string {
  const w = Math.round(deck.width * scale);
  const h = Math.round(deck.height * scale);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${deck.width} ${deck.height}"><foreignObject x="0" y="0" width="${deck.width}" height="${deck.height}"><div xmlns="http://www.w3.org/1999/xhtml">${slideHtml(deck, slide).replace(/<br>/g, '<br/>').replace(/<img ([^>]*[^/])>/g, '<img $1/>')}</div></foreignObject></svg>`;
}
