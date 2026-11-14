/**
 * The parts of the vector engine that need a browser: measuring text, turning a gradient mesh
 * or a whole drawing into pixels, converting text to outlines and writing the export formats.
 * (Everything else under core/vector is pure and runs in tests.)
 */
import { fitCurve, loadGeom } from './geom';
import { renderMesh } from './mesh';
import { mapNodes, newId, type MeshPaint, type PathNode, type SubPath, type TextNode, type VNode, type VectorDoc } from './model';
import { corner, textLines, transformSubs, type Measure, type Pt } from './path';
import { docToSvg, fontFamilyCss, nodeToSvg, type SvgExportOptions } from './svg';
import { traceBitmap, traceField, type TraceOptions } from './trace';

let measureCtx: CanvasRenderingContext2D | null = null;

/** Canvas-backed text measurer (the one the renderer, bounds and wrapping all share). */
export const browserMeasure: Measure = (text, node) => {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * node.size * 0.55;
  measureCtx.font = `${node.italic ? 'italic ' : ''}${node.weight} ${node.size}px ${fontFamilyCss(node.family)}`;
  return measureCtx.measureText(text).width + text.length * (node.tracking / 1000) * node.size;
};

const meshCache = new WeakMap<MeshPaint, { key: string; url: string }>();

/** A gradient mesh as a PNG data: URL, cached per mesh object and size. */
export function meshImage(mesh: MeshPaint, width: number, height: number): string | null {
  // the pixels are stretched over the object, so a modest size is enough for smooth colour
  const scale = Math.min(1, 480 / Math.max(width, height, 1));
  const w = Math.max(2, Math.round(width * scale));
  const h = Math.max(2, Math.round(height * scale));
  const key = `${w}x${h}`;
  const hit = meshCache.get(mesh);
  if (hit?.key === key) return hit.url;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const image = ctx.createImageData(w, h);
  image.data.set(renderMesh(mesh, w, h));
  ctx.putImageData(image, 0, 0);
  const url = canvas.toDataURL('image/png');
  meshCache.set(mesh, { key, url });
  return url;
}

export const browserRender = { measure: browserMeasure, meshImage };

/** Draws an SVG string onto a canvas of the given pixel size. */
export async function rasterizeSvg(svg: string, width: number, height: number): Promise<HTMLCanvasElement> {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (w * h > 268_000_000 || w > 16384 || h > 16384) throw new Error('That is larger than a picture can be (16,384 px a side). Choose a smaller scale.');
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('The drawing could not be rendered.'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No canvas is available.');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── text → outlines ────────────────────────────────────────────────────────

interface LocalFont {
  family: string;
  fullName: string;
  style: string;
  blob(): Promise<Blob>;
}

let localFonts: Promise<LocalFont[]> | null = null;

/** Installed fonts, where the browser lets a page read them (Chromium, with the user's consent). */
export function queryFonts(): Promise<LocalFont[]> {
  if (!localFonts) {
    const q = (window as unknown as { queryLocalFonts?: () => Promise<LocalFont[]> }).queryLocalFonts;
    localFonts = q ? q.call(window).catch(() => []) : Promise.resolve([]);
  }
  return localFonts;
}

/** Family names of installed fonts (empty when they can't be listed). */
export async function fontFamilies(): Promise<string[]> {
  return [...new Set((await queryFonts()).map((f) => f.family))].sort((a, b) => a.localeCompare(b));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parsedFonts = new Map<string, Promise<any | null>>();

/** The installed font file for a text object's family and style, parsed for its glyph outlines. */
function glyphFont(node: Pick<TextNode, 'family' | 'weight' | 'italic'>): Promise<unknown | null> {
  const key = `${node.family}|${node.weight}|${node.italic}`;
  let hit = parsedFonts.get(key);
  if (!hit) {
    hit = (async () => {
      const family = node.family.toLowerCase();
      const faces = (await queryFonts()).filter((f) => f.family.toLowerCase() === family);
      if (!faces.length) return null;
      const want = (f: LocalFont) => {
        const s = f.style.toLowerCase();
        const bold = /bold|black|heavy/.test(s) && !/semi|demi/.test(s);
        const italic = /italic|oblique/.test(s);
        return (bold === node.weight >= 600 ? 0 : 2) + (italic === node.italic ? 0 : 1) + (/light|thin|condensed|narrow/.test(s) ? 1 : 0);
      };
      const face = [...faces].sort((a, b) => want(a) - want(b))[0];
      // only an exact style match gives true outlines; otherwise the browser's rendering is traced
      if (want(face) !== 0) return null;
      try {
        const opentype = await import('opentype.js');
        return opentype.parse(await (await face.blob()).arrayBuffer());
      } catch {
        return null;
      }
    })();
    parsedFonts.set(key, hit);
  }
  return hit;
}

function commandsToSubs(commands: { type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }[]): SubPath[] {
  const subs: SubPath[] = [];
  let cur: SubPath | null = null;
  let x = 0;
  let y = 0;
  for (const c of commands) {
    if (c.type === 'M') {
      cur = { anchors: [corner(c.x!, c.y!)], closed: false };
      subs.push(cur);
    } else if (!cur) continue;
    else if (c.type === 'L') cur.anchors.push(corner(c.x!, c.y!));
    else if (c.type === 'C' || c.type === 'Q') {
      const last = cur.anchors[cur.anchors.length - 1];
      const c1 = c.type === 'C' ? { x: c.x1!, y: c.y1! } : { x: x + (2 / 3) * (c.x1! - x), y: y + (2 / 3) * (c.y1! - y) };
      const c2 = c.type === 'C' ? { x: c.x2!, y: c.y2! } : { x: c.x! + (2 / 3) * (c.x1! - c.x!), y: c.y! + (2 / 3) * (c.y1! - c.y!) };
      cur.anchors[cur.anchors.length - 1] = { ...last, ox: c1.x, oy: c1.y };
      cur.anchors.push({ x: c.x!, y: c.y!, ix: c2.x, iy: c2.y, ox: c.x!, oy: c.y! });
    } else if (c.type === 'Z') {
      cur.closed = true;
      const a = cur.anchors;
      const last = a[a.length - 1];
      if (a.length > 1 && Math.abs(last.x - a[0].x) < 1e-6 && Math.abs(last.y - a[0].y) < 1e-6) {
        a[0] = { ...a[0], ix: last.ix, iy: last.iy };
        a.pop();
      }
      cur = null;
    }
    if (c.x !== undefined) {
      x = c.x;
      y = c.y!;
    }
  }
  return subs.filter((s) => s.anchors.length > 1);
}

/** Outlines from the glyph data of the installed font (exact curves). Null when it can't be read. */
async function glyphOutlines(node: TextNode): Promise<SubPath[] | null> {
  if (node.kind === 'path') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const font = (await glyphFont(node)) as any;
  if (!font) return null;
  const lines = textLines(node, browserMeasure);
  const lh = node.size * node.leading;
  const area = node.kind === 'area';
  const options = { kerning: true, letterSpacing: node.tracking / 1000 };
  const subs: SubPath[] = [];
  lines.forEach((line, i) => {
    if (!line) return;
    const width = font.getAdvanceWidth(line, node.size, options);
    const left = area ? node.x : node.x;
    const span = area ? node.width ?? 0 : 0;
    const x = node.align === 'center' ? left + span / 2 - width / 2 : node.align === 'right' ? left + span - width : left;
    const y = (area ? node.y + node.size * 0.9 : node.y) + i * lh;
    subs.push(...commandsToSubs(font.getPath(line, x, y, node.size, options).commands));
  });
  return subs.length ? transformSubs(subs, node.matrix) : null;
}

/** Outlines traced from the browser's own rendering of the text (any font, any layout). */
async function tracedOutlines(node: TextNode): Promise<SubPath[]> {
  await loadGeom();
  const solid: TextNode = { ...node, opacity: 1, blend: undefined, fill: { type: 'solid', color: '#000000' }, stroke: { type: 'none' } };
  const markup = nodeToSvg(solid, { measure: browserMeasure });
  // measure where the text really lands by letting the browser lay it out
  const probe = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  probe.setAttribute('style', 'position:absolute;left:-99999px;top:0;width:10px;height:10px;overflow:visible');
  probe.innerHTML = `<g>${markup}</g>`;
  document.body.appendChild(probe);
  let box: DOMRect;
  try {
    box = (probe.firstElementChild as SVGGElement).getBBox();
  } finally {
    probe.remove();
  }
  if (!box.width || !box.height) return [];
  const pad = node.size * 0.25;
  const x0 = box.x - pad;
  const y0 = box.y - pad;
  const w = box.width + pad * 2;
  const h = box.height + pad * 2;
  // supersample so a glyph is a few hundred pixels tall, within a sane canvas size
  const scale = Math.max(1, Math.min(240 / (node.size * Math.max(0.2, Math.hypot(node.matrix[0], node.matrix[1]))), 4096 / Math.max(w, h)));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" viewBox="${x0} ${y0} ${w} ${h}">${markup}</svg>`;
  const canvas = await rasterizeSvg(svg, w * scale, h * scale);
  const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
  const field = new Float32Array(canvas.width * canvas.height);
  for (let i = 0; i < field.length; i++) field[i] = data[i * 4 + 3] / 255;
  const loops = traceField(field, canvas.width, canvas.height, 0.5);
  const subs: SubPath[] = [];
  for (const loop of loops) {
    const pts: Pt[] = loop.map((p) => ({ x: x0 + p.x / scale, y: y0 + p.y / scale }));
    const fitted = fitCurve(pts, Math.max(0.02, node.size / 900), true);
    if (fitted && fitted.anchors.length > 2) subs.push(fitted);
  }
  return subs;
}

/** Type ▸ Create Outlines: the text as a filled path with the same appearance. */
export async function outlineText(node: TextNode): Promise<PathNode | null> {
  const exact = await glyphOutlines(node).catch(() => null);
  const subs = exact ?? (await tracedOutlines(node));
  if (!subs.length) return null;
  return {
    id: newId(), type: 'path', name: node.name ?? node.text.slice(0, 24), opacity: node.opacity, blend: node.blend, hidden: node.hidden, locked: node.locked, subs,
    fill: node.fill, stroke: node.stroke, strokeWidth: node.strokeWidth, cap: node.cap, join: node.join, miter: node.miter, dash: node.dash, fillRule: 'evenodd',
  };
}

/** The document with every text object converted to outlines (for formats that can't carry fonts). */
export async function outlineAllText(doc: VectorDoc): Promise<VectorDoc> {
  const texts: TextNode[] = [];
  mapNodes(doc, (n) => {
    if (n.type === 'text' && !n.hidden) texts.push(n);
    return n;
  });
  if (!texts.length) return doc;
  const done = new Map<string, VNode | null>();
  for (const t of texts) done.set(t.id, await outlineText(t));
  return mapNodes(doc, (n) => (done.has(n.id) ? done.get(n.id) ?? null : n));
}

// ── image trace ────────────────────────────────────────────────────────────

/** Image Trace: a placed picture as flat-coloured vector shapes, in the image's place. */
export async function traceImage(node: Extract<VNode, { type: 'image' }>, o: TraceOptions): Promise<PathNode[]> {
  await loadGeom();
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('The image could not be read.'));
    img.src = node.href;
  });
  // tracing cost grows with the pixel count: work on at most ~1 megapixel
  const scale = Math.min(1, Math.sqrt(1_000_000 / (img.naturalWidth * img.naturalHeight || 1)));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);
  const shapes = traceBitmap(ctx.getImageData(0, 0, w, h).data, w, h, o);
  // pixel space → the image's box → the document
  const toDoc = (subs: SubPath[]) => transformSubs(transformSubs(subs, [node.width / w, 0, 0, node.height / h, node.x, node.y]), node.matrix);
  const out: PathNode[] = [];
  for (const shape of shapes) {
    const subs: SubPath[] = [];
    for (const loop of shape.loops) {
      const fitted = fitCurve(loop, 0.6, true);
      if (fitted && fitted.anchors.length > 2) subs.push(fitted);
    }
    if (!subs.length) continue;
    out.push({
      id: newId(), type: 'path', opacity: node.opacity, subs: toDoc(subs), fill: { type: 'solid', color: shape.color }, stroke: { type: 'none' },
      strokeWidth: 1, cap: 'butt', join: 'miter', miter: 10, dash: [], fillRule: 'evenodd',
    });
  }
  return out;
}

// ── export ─────────────────────────────────────────────────────────────────

export type VectorFormat = 'svg' | 'ai' | 'pdf' | 'png' | 'jpeg' | 'webp';

export const VECTOR_FORMATS: Record<VectorFormat, { label: string; ext: string; extensions: string[]; mime: string; note?: string }> = {
  svg: { label: 'SVG drawing', ext: 'svg', extensions: ['svg'], mime: 'image/svg+xml', note: 'Editable: reopens with artboards, layers, text and meshes intact. Opens in browsers and every vector app.' },
  ai: { label: 'Adobe Illustrator', ext: 'ai', extensions: ['ai'], mime: 'application/postscript', note: 'A PDF-compatible .ai file that Illustrator opens as editable paths. Text is saved as outlines.' },
  pdf: { label: 'PDF', ext: 'pdf', extensions: ['pdf'], mime: 'application/pdf', note: 'Vector PDF, one page per artboard. Text is saved as outlines.' },
  png: { label: 'PNG image', ext: 'png', extensions: ['png'], mime: 'image/png' },
  jpeg: { label: 'JPEG image', ext: 'jpg', extensions: ['jpg', 'jpeg'], mime: 'image/jpeg' },
  webp: { label: 'WebP image', ext: 'webp', extensions: ['webp'], mime: 'image/webp' },
};

export interface VectorExportOptions {
  format: VectorFormat;
  /** an artboard id, or 'all' (SVG: the whole document; PDF / AI: one page each) */
  artboard: string;
  /** raster formats: pixels per document unit */
  scale: number;
  /** raster formats: page colour, or null for transparent (PNG / WebP) */
  background: string | null;
  /** JPEG / WebP, 1–100 */
  quality: number;
  title?: string;
}

/** One artboard as a vector PDF page (pdfmake draws the SVG with real paths, gradients and images). */
async function artboardPdf(doc: VectorDoc, artboardId: string, title: string): Promise<Uint8Array> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const [pm, vfs]: any[] = await Promise.all([import('pdfmake/build/pdfmake'), import('pdfmake/build/vfs_fonts')]);
  const pdfMake = pm.default ?? pm;
  const fonts = vfs.default ?? vfs;
  pdfMake.addVirtualFileSystem?.(fonts.pdfMake?.vfs ?? fonts.vfs ?? fonts);
  const board = doc.artboards.find((a) => a.id === artboardId)!;
  // document units are CSS px; a PDF page is measured in points
  const width = board.width * 0.75;
  const height = board.height * 0.75;
  const svg = docToSvg(doc, { ...browserRender, artboard: artboardId }).replace(/^<\?xml[^>]*>\s*/, '');
  const definition = {
    pageSize: { width, height },
    pageMargins: [0, 0, 0, 0],
    info: { title },
    content: [{ svg, width, height, absolutePosition: { x: 0, y: 0 } }],
  };
  const made = pdfMake.createPdf(definition);
  const buffer: ArrayBuffer | Uint8Array = await (made.getBuffer.length ? new Promise((resolve) => made.getBuffer(resolve)) : made.getBuffer());
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Writes the document (or one artboard) in an export format. */
export async function exportVector(doc: VectorDoc, o: VectorExportOptions): Promise<Uint8Array> {
  const title = o.title ?? 'Drawing';
  const boards = o.artboard === 'all' ? doc.artboards : doc.artboards.filter((a) => a.id === o.artboard);
  if (!boards.length) throw new Error('There is no artboard to export.');
  if (o.format === 'svg') {
    const options: SvgExportOptions = { ...browserRender, title, embedModel: o.artboard === 'all', artboard: o.artboard === 'all' ? undefined : o.artboard };
    return new TextEncoder().encode(docToSvg(doc, options));
  }
  if (o.format === 'pdf' || o.format === 'ai') {
    // fonts aren't embedded, so text travels as outlines and looks the same everywhere
    const outlined = await outlineAllText(doc);
    const pages: Uint8Array[] = [];
    for (const b of boards) pages.push(await artboardPdf(outlined, b.id, title));
    if (pages.length === 1) return pages[0];
    const { PDFDocument } = await import('@cantoo/pdf-lib');
    const out = await PDFDocument.create();
    out.setTitle(title);
    for (const bytes of pages) {
      const src = await PDFDocument.load(bytes);
      const [page] = await out.copyPages(src, [0]);
      out.addPage(page);
    }
    return out.save();
  }
  const board = boards[0];
  const svg = docToSvg(doc, { ...browserRender, artboard: board.id, background: o.format === 'jpeg' ? o.background ?? '#ffffff' : o.background });
  const canvas = await rasterizeSvg(svg, board.width * o.scale, board.height * o.scale);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, VECTOR_FORMATS[o.format].mime, o.quality / 100));
  if (!blob) throw new Error('The image could not be encoded.');
  return new Uint8Array(await blob.arrayBuffer());
}
