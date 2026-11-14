/**
 * Vector document → SVG.
 *
 * One serialiser draws everything: the editor canvas shows each object by this markup, and a
 * saved or exported file is the same markup for the whole document, so what is on screen is
 * what is written. A saved .svg also carries the document itself (artboards, layers, mesh
 * points, text settings) in a <metadata> element, so File Editor reopens it exactly, while
 * every other program just sees a normal SVG. The metadata is trusted only while a checksum
 * of the drawing still matches (see svg-import.ts): once another program edits the file, the
 * drawing wins.
 */
import { escapeXml } from '../dom';
import { meshAverage } from './mesh';
import type { GroupNode, ImageNode, Layer, MeshPaint, Paint, PathNode, Style, TextNode, VNode, VectorDoc, Artboard } from './model';
import { estimateMeasure, isIdentity, nodeBounds, num, subsBounds, subsToD, textLines, textLocalBox, unionBox, type Box, type Measure } from './path';

export interface RenderOptions {
  /** tag every element with data-id, for hit-testing on the canvas */
  editor?: boolean;
  measure?: Measure;
  /** Rasterises a mesh to a data: URL (the browser has a canvas; without one the mesh's average colour is used). */
  meshImage?: (mesh: MeshPaint, width: number, height: number) => string | null;
  /** give images an id so the embedded model can refer to their pixels instead of repeating them */
  imageIds?: boolean;
}

const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);

export function fontFamilyCss(family: string): string {
  const list = family.split(',').map((f) => f.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  if (!list.some((f) => GENERIC_FONTS.has(f.toLowerCase()))) list.push(/mono|courier|consolas/i.test(family) ? 'monospace' : /times|georgia|garamond|serif/i.test(family) && !/sans/i.test(family) ? 'serif' : 'sans-serif');
  return list.map((f) => (GENERIC_FONTS.has(f.toLowerCase()) ? f : `'${f}'`)).join(', ');
}

function stopsMarkup(paint: { stops: { offset: number; color: string; alpha?: number }[] }): string {
  return [...paint.stops]
    .sort((a, b) => a.offset - b.offset)
    .map((s) => `<stop offset="${num(s.offset)}" stop-color="${s.color}"${s.alpha !== undefined && s.alpha < 1 ? ` stop-opacity="${num(s.alpha)}"` : ''}/>`)
    .join('');
}

/**
 * The attribute value for a paint, appending any <defs> it needs. Gradients are mapped from
 * the unit square onto `box` with a gradientTransform, which (unlike objectBoundingBox units)
 * also works for a perfectly horizontal or vertical line.
 */
function paintRef(paint: Paint, id: string, box: Box, defs: string[]): { value: string; opacity: number } {
  if (paint.type === 'none') return { value: 'none', opacity: 1 };
  if (paint.type === 'solid') return { value: paint.color, opacity: paint.alpha ?? 1 };
  if (paint.type === 'mesh') return { value: meshAverage(paint), opacity: 1 };
  const m = `matrix(${num(box.width || 1)} 0 0 ${num(box.height || 1)} ${num(box.x)} ${num(box.y)})`;
  if (paint.type === 'linear') {
    defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" gradientTransform="${m}" x1="${num(paint.x1)}" y1="${num(paint.y1)}" x2="${num(paint.x2)}" y2="${num(paint.y2)}">${stopsMarkup(paint)}</linearGradient>`);
  } else {
    defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" gradientTransform="${m}" cx="${num(paint.cx)}" cy="${num(paint.cy)}" r="${num(paint.r)}">${stopsMarkup(paint)}</radialGradient>`);
  }
  return { value: `url(#${id})`, opacity: 1 };
}

function styleAttrs(node: Style & { id: string }, box: Box, defs: string[], fillOverride?: string): string {
  const fill = fillOverride !== undefined ? { value: fillOverride, opacity: 1 } : paintRef(node.fill, `${node.id}-f`, box, defs);
  const stroke = paintRef(node.stroke, `${node.id}-s`, box, defs);
  let out = ` fill="${fill.value}"`;
  if (fill.opacity < 1) out += ` fill-opacity="${num(fill.opacity)}"`;
  if (node.fillRule === 'evenodd' && fill.value !== 'none') out += ' fill-rule="evenodd"';
  if (stroke.value !== 'none' && node.strokeWidth > 0) {
    out += ` stroke="${stroke.value}" stroke-width="${num(node.strokeWidth)}"`;
    if (stroke.opacity < 1) out += ` stroke-opacity="${num(stroke.opacity)}"`;
    if (node.cap !== 'butt') out += ` stroke-linecap="${node.cap}"`;
    if (node.join !== 'miter') out += ` stroke-linejoin="${node.join}"`;
    else if (node.miter !== 4) out += ` stroke-miterlimit="${num(node.miter)}"`;
    if (node.dash.length) out += ` stroke-dasharray="${node.dash.map(num).join(' ')}"`;
  }
  return out;
}

function commonAttrs(node: VNode, o: RenderOptions): string {
  let out = '';
  if (o.editor) out += ` data-id="${node.id}"`;
  if (node.opacity < 1) out += ` opacity="${num(node.opacity)}"`;
  if (node.blend && node.blend !== 'normal') out += ` style="mix-blend-mode:${node.blend}"`;
  return out;
}

const matrixAttr = (m: readonly number[]) => (isIdentity(m as never) ? '' : ` transform="matrix(${m.map(num).join(' ')})"`);

function defsMarkup(defs: string[]): string {
  return defs.length ? `<defs>${defs.join('')}</defs>` : '';
}

function pathToSvg(node: PathNode, o: RenderOptions): string {
  const d = subsToD(node.subs);
  if (!d) return '';
  const box = subsBounds(node.subs) ?? { x: 0, y: 0, width: 1, height: 1 };
  const defs: string[] = [];
  if (node.fill.type === 'mesh') {
    // the mesh as pixels, clipped to the outline; the stroke is drawn over it
    const href = o.meshImage?.(node.fill, box.width, box.height) ?? null;
    if (href) {
      defs.push(`<clipPath id="${node.id}-m"><path d="${d}"${node.fillRule === 'evenodd' ? ' clip-rule="evenodd"' : ''}/></clipPath>`);
      const image = `<image href="${href}" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" preserveAspectRatio="none" clip-path="url(#${node.id}-m)"${o.editor ? ` data-id="${node.id}"` : ''}/>`;
      const outline = `<path d="${d}"${styleAttrs(node, box, defs, 'none')}${o.editor ? ` data-id="${node.id}"` : ''}/>`;
      return `<g${commonAttrs(node, { ...o, editor: false })}>${defsMarkup(defs)}${image}${outline}</g>`;
    }
  }
  const attrs = styleAttrs(node, box, defs);
  return `${defsMarkup(defs)}<path d="${d}"${attrs}${commonAttrs(node, o)}/>`;
}

function textToSvg(node: TextNode, o: RenderOptions): string {
  const measure = o.measure ?? estimateMeasure;
  const box = textLocalBox(node, measure);
  const defs: string[] = [];
  let attrs = ` font-family="${escapeXml(fontFamilyCss(node.family))}" font-size="${num(node.size)}"`;
  if (node.weight !== 400) attrs += ` font-weight="${node.weight}"`;
  if (node.italic) attrs += ' font-style="italic"';
  if (node.tracking) attrs += ` letter-spacing="${num((node.tracking / 1000) * node.size)}"`;
  if (node.underline) attrs += ' text-decoration="underline"';
  const anchor = node.align === 'center' ? 'middle' : node.align === 'right' ? 'end' : 'start';
  if (anchor !== 'start') attrs += ` text-anchor="${anchor}"`;
  attrs += styleAttrs(node, box, defs) + matrixAttr(node.matrix) + commonAttrs(node, o);
  let body: string;
  if (node.kind === 'path' && node.path) {
    defs.push(`<path id="${node.id}-p" d="${subsToD(node.path)}"/>`);
    const offset = node.align === 'center' ? 50 : node.align === 'right' ? 100 : (node.startOffset ?? 0) * 100;
    body = `<textPath href="#${node.id}-p" startOffset="${num(offset)}%">${escapeXml(node.text.replace(/\n/g, ' '))}</textPath>`;
  } else {
    const lines = textLines(node, measure);
    const lh = node.size * node.leading;
    const area = node.kind === 'area';
    const x = area ? (node.align === 'center' ? node.x + (node.width ?? 0) / 2 : node.align === 'right' ? node.x + (node.width ?? 0) : node.x) : node.x;
    const y0 = area ? node.y + node.size * 0.9 : node.y;
    body = lines.map((line, i) => `<tspan x="${num(x)}" y="${num(y0 + i * lh)}">${escapeXml(line) || ' '}</tspan>`).join('');
  }
  return `${defsMarkup(defs)}<text xml:space="preserve"${attrs}>${body}</text>`;
}

function imageToSvg(node: ImageNode, o: RenderOptions): string {
  return `<image${o.imageIds ? ` id="fe-${node.id}"` : ''} href="${escapeXml(node.href)}" x="${num(node.x)}" y="${num(node.y)}" width="${num(node.width)}" height="${num(node.height)}" preserveAspectRatio="none"${matrixAttr(node.matrix)}${commonAttrs(node, o)}/>`;
}

function groupToSvg(node: GroupNode, o: RenderOptions): string {
  const kids = node.children;
  if (node.clip && kids.length > 1 && kids[0].type === 'path') {
    const mask = kids[0];
    const rest = kids.slice(1).map((c) => nodeToSvg(c, o)).join('');
    const clip = `<clipPath id="${node.id}-c"><path d="${subsToD(mask.subs)}"${mask.fillRule === 'evenodd' ? ' clip-rule="evenodd"' : ''}/></clipPath>`;
    // the mask's own outline stays clickable in the editor (invisible, hit on its fill)
    const handle = o.editor ? `<path d="${subsToD(mask.subs)}" fill="none" stroke="none" pointer-events="all" data-id="${mask.id}"/>` : '';
    return `<g${commonAttrs(node, o)}><defs>${clip}</defs>${handle}<g clip-path="url(#${node.id}-c)">${rest}</g></g>`;
  }
  return `<g${commonAttrs(node, o)}>${kids.map((c) => nodeToSvg(c, o)).join('')}</g>`;
}

/** The SVG markup of one object (and everything inside it). Hidden objects draw nothing. */
export function nodeToSvg(node: VNode, o: RenderOptions = {}): string {
  if (node.hidden) return '';
  switch (node.type) {
    case 'path':
      return pathToSvg(node, o);
    case 'text':
      return textToSvg(node, o);
    case 'image':
      return imageToSvg(node, o);
    case 'group':
      return groupToSvg(node, o);
  }
}

export function layerToSvg(layer: Layer, o: RenderOptions = {}): string {
  if (layer.hidden) return '';
  return layer.children.map((n) => nodeToSvg(n, o)).join('');
}

// ── whole-document output ──────────────────────────────────────────────────

/** FNV-1a over UTF-16 code units: detects that the drawing was edited by another program. */
export function checksum(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** The document without its image pixels (they are read back from the drawing's <image> elements). */
function modelJson(doc: VectorDoc): string {
  return JSON.stringify(doc, (key, value) => (key === 'href' && typeof value === 'string' && value.startsWith('data:') ? '' : value));
}

export const MODEL_ID = 'file-editor-vector';
export const BODY_MARK = '<!--fe-body-->';

export function artboardsBox(artboards: Artboard[]): Box {
  let box: Box | null = null;
  for (const a of artboards) box = unionBox(box, a);
  return box ?? { x: 0, y: 0, width: 800, height: 600 };
}

export interface SvgExportOptions extends RenderOptions {
  /** one artboard's id; omitted = every artboard in one drawing */
  artboard?: string;
  /** embed the editable document (the app's own saves) */
  embedModel?: boolean;
  /** paint each exported artboard's white page (raster / PDF export); a saved SVG stays transparent */
  background?: string | null;
  title?: string;
}

/** The complete SVG file for a document or for one of its artboards. */
export function docToSvg(doc: VectorDoc, o: SvgExportOptions = {}): string {
  const one = o.artboard ? doc.artboards.find((a) => a.id === o.artboard) : undefined;
  let box: Box = one ?? artboardsBox(doc.artboards);
  if (!doc.artboards.length) {
    let content: Box | null = null;
    for (const l of doc.layers) for (const n of l.children) content = unionBox(content, nodeBounds(n, o.measure));
    box = content ?? box;
  }
  const render: RenderOptions = { measure: o.measure, meshImage: o.meshImage, imageIds: o.embedModel };
  let body = '';
  if (o.background) {
    const pages = one ? [one] : doc.artboards;
    body += pages.map((a) => `<rect x="${num(a.x)}" y="${num(a.y)}" width="${num(a.width)}" height="${num(a.height)}" fill="${o.background}"/>`).join('');
  }
  for (const layer of doc.layers) {
    if (layer.hidden) continue;
    body += `<g id="${escapeXml(layer.id)}" data-name="${escapeXml(layer.name)}">${layerToSvg(layer, render)}</g>`;
  }
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${num(box.width)}" height="${num(box.height)}" viewBox="${num(box.x)} ${num(box.y)} ${num(box.width)} ${num(box.height)}">`;
  const title = o.title ? `<title>${escapeXml(o.title)}</title>` : '';
  const meta = o.embedModel ? `<metadata id="${MODEL_ID}" data-hash="${checksum(body)}">${toBase64Utf8(modelJson(doc))}</metadata>${BODY_MARK}` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n${open}${title}${meta}${body}</svg>\n`;
}
