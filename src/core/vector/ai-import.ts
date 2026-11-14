/**
 * Adobe Illustrator (.ai) and PDF → vector document.
 *
 * Illustrator has saved .ai files as PDF since version 9 ("Create PDF Compatible File", on by
 * default), so an .ai file is read as the PDF it is: pdf.js parses each page into drawing
 * operators, and those are replayed here into editable objects instead of onto a canvas.
 * Every page becomes an artboard. Paths keep their curves, fills, strokes and transparency;
 * axial and radial shadings become gradients; text keeps its font, size and colour; embedded
 * images are kept. Illustrator's private data (live effects, appearances, symbols, its own
 * layer names) lives outside the PDF part and is not read: the artwork arrives as Illustrator
 * drew it, flattened to plain objects.
 *
 * Older (pre-9) and "no PDF compatibility" .ai files are PostScript and can't be read.
 */
import { openPdf } from '../pdf/pdfjs';
import { loadPdfjs } from '../pdf/pdfjs';
import { parseCssColor } from './color';
import { DEFAULT_SWATCHES, IDENTITY, NO_PAINT, newId, type Artboard, type GradientStop, type Layer, type Mat, type Paint, type PathNode, type SubPath, type VNode, type VectorDoc } from './model';
import { apply, corner, mul, scaleOf, subsBounds, transformSubs, type Box } from './path';

export interface AiImport {
  doc: VectorDoc;
  warnings: string[];
}

/** True when the bytes are a PDF (which is what a PDF-compatible .ai file is). */
export function isPdfBased(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

/** A shading waiting for the shape it paints (its geometry is in document space). */
interface Shading {
  kind: 'axial' | 'radial';
  stops: GradientStop[];
  p0: { x: number; y: number };
  p1: { x: number; y: number };
  r1: number;
}

type Ink = { color: string } | { shading: Shading } | null;

interface GState {
  ctm: Mat;
  fill: Ink;
  stroke: Ink;
  fillAlpha: number;
  strokeAlpha: number;
  lineWidth: number;
  cap: PathNode['cap'];
  join: PathNode['join'];
  miter: number;
  dash: number[];
  // text
  font: string;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
}

const MAX_PAGES = 40;
const GAP = 40;

function colorArg(args: unknown[]): string {
  // newer pdf.js passes one "#rrggbb" string, older builds three 0–255 numbers
  if (typeof args[0] === 'string') return parseCssColor(args[0])?.color ?? '#000000';
  const [r, g, b] = args as number[];
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v ?? 0))).toString(16).padStart(2, '0')).join('');
}

function inkPaint(ink: Ink, alpha: number, box: Box): Paint {
  if (!ink) return NO_PAINT;
  if ('color' in ink) return alpha < 1 ? { type: 'solid', color: ink.color, alpha } : { type: 'solid', color: ink.color };
  const s = ink.shading;
  const w = box.width || 1;
  const h = box.height || 1;
  const u = (p: { x: number; y: number }) => ({ x: (p.x - box.x) / w, y: (p.y - box.y) / h });
  const stops = alpha < 1 ? s.stops.map((st) => ({ ...st, alpha: (st.alpha ?? 1) * alpha })) : s.stops;
  if (s.kind === 'axial') {
    const a = u(s.p0);
    const b = u(s.p1);
    return { type: 'linear', stops, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }
  const c = u(s.p1);
  return { type: 'radial', stops, cx: c.x, cy: c.y, r: s.r1 / Math.sqrt(w * h) || 0.5 };
}

/** pdf.js path data (DrawOPS: 0 moveTo, 1 lineTo, 2 curveTo, 3 quadraticCurveTo, 4 closePath) → subpaths. */
function readPath(data: ArrayLike<number> | null | undefined): SubPath[] {
  const subs: SubPath[] = [];
  if (!data) return subs;
  let cur: SubPath | null = null;
  let x = 0;
  let y = 0;
  for (let i = 0; i < data.length; ) {
    switch (data[i++]) {
      case 0:
        x = data[i++];
        y = data[i++];
        cur = { anchors: [corner(x, y)], closed: false };
        subs.push(cur);
        break;
      case 1:
        x = data[i++];
        y = data[i++];
        if (!cur) subs.push((cur = { anchors: [], closed: false }));
        cur.anchors.push(corner(x, y));
        break;
      case 2: {
        const c1x = data[i++];
        const c1y = data[i++];
        const c2x = data[i++];
        const c2y = data[i++];
        x = data[i++];
        y = data[i++];
        if (!cur || !cur.anchors.length) break;
        const last = cur.anchors[cur.anchors.length - 1];
        cur.anchors[cur.anchors.length - 1] = { ...last, ox: c1x, oy: c1y };
        cur.anchors.push({ x, y, ix: c2x, iy: c2y, ox: x, oy: y });
        break;
      }
      case 3: {
        const qx = data[i++];
        const qy = data[i++];
        const nx = data[i++];
        const ny = data[i++];
        if (cur && cur.anchors.length) {
          const last = cur.anchors[cur.anchors.length - 1];
          cur.anchors[cur.anchors.length - 1] = { ...last, ox: x + (2 / 3) * (qx - x), oy: y + (2 / 3) * (qy - y) };
          cur.anchors.push({ x: nx, y: ny, ix: nx + (2 / 3) * (qx - nx), iy: ny + (2 / 3) * (qy - ny), ox: nx, oy: ny });
        }
        x = nx;
        y = ny;
        break;
      }
      case 4:
        if (cur && cur.anchors.length > 1) {
          cur.closed = true;
          const a = cur.anchors;
          const last = a[a.length - 1];
          if (Math.abs(last.x - a[0].x) < 1e-6 && Math.abs(last.y - a[0].y) < 1e-6) {
            a[0] = { ...a[0], ix: last.ix, iy: last.iy };
            a.pop();
          }
        }
        cur = null;
        break;
      default:
        return subs;
    }
  }
  return subs.filter((s) => s.anchors.length > 1);
}

/** "ABCDEF+Myriad-BoldItalic" → family, weight, italic. */
function fontInfo(name: string): { family: string; weight: number; italic: boolean } {
  const clean = name.replace(/^[A-Z]{6}\+/, '');
  const [family, style = ''] = clean.split(/[-,]/);
  const s = (style + ' ' + clean).toLowerCase();
  return {
    family: family.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/MT$|PS$/, '').trim() || 'Arial',
    weight: /black|heavy/.test(s) ? 900 : /semibold|demi/.test(s) ? 600 : /bold/.test(s) ? 700 : /light/.test(s) ? 300 : /medium/.test(s) ? 500 : 400,
    italic: /italic|oblique/.test(s),
  };
}

/** Pixels of a decoded pdf.js image as a PNG data: URL (needs a canvas; null without one). */
function imageUrl(img: { bitmap?: unknown; data?: Uint8ClampedArray | Uint8Array; width: number; height: number; kind?: number } | null): string | null {
  if (!img || typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    if (img.bitmap) ctx.drawImage(img.bitmap as CanvasImageSource, 0, 0);
    else if (img.data) {
      const out = ctx.createImageData(img.width, img.height);
      const n = img.width * img.height;
      const src = img.data;
      if (src.length >= n * 4) out.data.set(src.subarray(0, n * 4));
      else if (src.length >= n * 3) {
        for (let i = 0; i < n; i++) {
          out.data[i * 4] = src[i * 3];
          out.data[i * 4 + 1] = src[i * 3 + 1];
          out.data[i * 4 + 2] = src[i * 3 + 2];
          out.data[i * 4 + 3] = 255;
        }
      } else return null;
      ctx.putImageData(out, 0, 0);
    } else return null;
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/** Reads a PDF-compatible Illustrator file (or any PDF) into an editable vector document. */
export async function importAi(bytes: Uint8Array, password?: string): Promise<AiImport> {
  if (!isPdfBased(bytes)) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 64));
    throw new Error(
      head.startsWith('%!PS')
        ? 'This Illustrator file was saved without PDF compatibility (or by Illustrator 8 or older), so it holds only PostScript. Re-save it from Illustrator with "Create PDF Compatible File" on, or export it as SVG.'
        : 'This is not an Illustrator or PDF file File Editor can read.',
    );
  }
  const lib = await loadPdfjs();
  const OPS = lib.OPS as unknown as Record<string, number>;
  const opName = new Map<number, string>(Object.entries(OPS).map(([k, v]) => [v, k]));
  const pdf = await openPdf(bytes, password);
  const warnings = new Set<string>();
  const artboards: Artboard[] = [];
  const layers: Layer[] = [];
  try {
    const pages = Math.min(pdf.doc.numPages, MAX_PAGES);
    if (pdf.doc.numPages > MAX_PAGES) warnings.add(`Pages after the first ${MAX_PAGES}`);
    let offsetX = 0;
    for (let pn = 1; pn <= pages; pn++) {
      const page = await pdf.doc.getPage(pn);
      const viewport = page.getViewport({ scale: 96 / 72 });
      const base: Mat = mul([1, 0, 0, 1, offsetX, 0], viewport.transform as unknown as Mat);
      artboards.push({ id: newId('a'), name: pages > 1 ? `Artboard ${pn}` : 'Artboard 1', x: offsetX, y: 0, width: viewport.width, height: viewport.height });
      offsetX += Math.ceil(viewport.width) + GAP;
      const nodes: VNode[] = [];
      const ops = await page.getOperatorList();
      const objs = (id: string): unknown => {
        try {
          return id.startsWith('g_') ? page.commonObjs.get(id) : page.objs.get(id);
        } catch {
          return null;
        }
      };

      let gs: GState = {
        ctm: base, fill: { color: '#000000' }, stroke: { color: '#000000' }, fillAlpha: 1, strokeAlpha: 1, lineWidth: 1, cap: 'butt', join: 'miter', miter: 10, dash: [],
        font: '', fontSize: 12, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0,
      };
      const stack: GState[] = [];
      let textMatrix: Mat = IDENTITY;
      let lineMatrix: Mat = IDENTITY;

      const shadingInk = (args: unknown[]): Ink => {
        // setFillColorN / setStrokeColorN with a shading pattern: ["Shading", objId, matrix]
        try {
          if (args[0] !== 'Shading') {
            warnings.add('Pattern fills (shown as grey)');
            return { color: '#999999' };
          }
          const ir = objs(String(args[1])) as unknown[] | null;
          const m = (args[2] as Mat | null) ?? IDENTITY;
          if (!ir || ir[0] !== 'RadialAxial') {
            warnings.add('Mesh shadings (shown as grey)');
            return { color: '#999999' };
          }
          const stops: GradientStop[] = (ir[3] as [number, string][]).map(([offset, css]) => {
            const c = parseCssColor(css) ?? { color: '#000000', alpha: 1 };
            return { offset, color: c.color, ...(c.alpha < 1 ? { alpha: c.alpha } : {}) };
          });
          // pattern space → default page space → document
          const pm = mul(base, m);
          const p0 = ir[4] as [number, number];
          const p1 = ir[5] as [number, number];
          return { shading: { kind: ir[1] === 'radial' ? 'radial' : 'axial', stops, p0: apply(pm, p0[0], p0[1]), p1: apply(pm, p1[0], p1[1]), r1: ((ir[7] as number) || 0) * scaleOf(pm) } };
        } catch {
          return { color: '#999999' };
        }
      };

      const paintPath = (subsLocal: SubPath[], fill: boolean, stroke: boolean, evenOdd: boolean) => {
        const subs = transformSubs(subsLocal, gs.ctm);
        const box = subsBounds(subs);
        if (!box) return;
        const scale = scaleOf(gs.ctm);
        nodes.push({
          id: newId(),
          type: 'path',
          opacity: 1,
          subs,
          fill: fill ? inkPaint(gs.fill, gs.fillAlpha, box) : NO_PAINT,
          stroke: stroke ? inkPaint(gs.stroke, gs.strokeAlpha, box) : NO_PAINT,
          // a zero-width PDF stroke is a hairline
          strokeWidth: Math.max(0.25, gs.lineWidth * scale),
          cap: gs.cap,
          join: gs.join,
          miter: gs.miter,
          dash: gs.dash.map((d) => d * scale),
          fillRule: evenOdd ? 'evenodd' : 'nonzero',
        });
      };

      const showText = (glyphs: unknown[]) => {
        const font = objs(gs.font) as { name?: string; loadedName?: string; vertical?: boolean } | null;
        const info = fontInfo(font?.name ?? 'Arial');
        let text = '';
        let advance = 0;
        for (const g of glyphs) {
          if (typeof g === 'number') {
            // a kerning adjustment in thousandths of the font size; a big one is a word gap
            advance -= (g / 1000) * gs.fontSize * gs.hScale;
            if (g < -200 && text && !text.endsWith(' ')) text += ' ';
            continue;
          }
          const glyph = g as { unicode?: string; width?: number; isSpace?: boolean } | null;
          if (!glyph) continue;
          text += glyph.unicode ?? '';
          advance += (((glyph.width ?? 0) / 1000) * gs.fontSize + gs.charSpacing + (glyph.isSpace ? gs.wordSpacing : 0)) * gs.hScale;
        }
        if (text.trim() && gs.fill) {
          // unit-em frame of the text (y down) → document
          const frame = mul(mul(gs.ctm, textMatrix), [gs.fontSize * gs.hScale, 0, 0, -gs.fontSize, 0, gs.rise]);
          const s = scaleOf(frame) || 1;
          const matrix: Mat = [frame[0] / s, frame[1] / s, frame[2] / s, frame[3] / s, frame[4], frame[5]];
          const paint = inkPaint(gs.fill, gs.fillAlpha, { x: 0, y: -s, width: Math.max(1, advance), height: s });
          nodes.push({
            id: newId(), type: 'text', opacity: 1, kind: 'point', text: text.replace(/\s+$/, ''), x: 0, y: 0, matrix,
            family: info.family, size: s, weight: info.weight, italic: info.italic,
            tracking: Math.round((gs.charSpacing / (gs.fontSize || 1)) * 1000), align: 'left', leading: 1.2,
            fill: paint, stroke: NO_PAINT, strokeWidth: 1, cap: 'butt', join: 'miter', miter: 10, dash: [], fillRule: 'nonzero',
          });
        }
        textMatrix = mul(textMatrix, [1, 0, 0, 1, advance, 0]);
      };

      for (let i = 0; i < ops.fnArray.length; i++) {
        const name = opName.get(ops.fnArray[i]);
        const args = (ops.argsArray[i] ?? []) as unknown[];
        switch (name) {
          case 'save':
            stack.push({ ...gs });
            break;
          case 'restore':
            gs = stack.pop() ?? gs;
            break;
          case 'transform':
            gs.ctm = mul(gs.ctm, args as unknown as Mat);
            break;
          case 'paintFormXObjectBegin':
            // a form (symbol, placed artwork) draws in its own space
            stack.push({ ...gs });
            if (args[0]) gs.ctm = mul(gs.ctm, Array.from(args[0] as ArrayLike<number>) as unknown as Mat);
            break;
          case 'beginGroup':
            stack.push({ ...gs });
            break;
          case 'paintFormXObjectEnd':
          case 'endGroup':
            gs = stack.pop() ?? gs;
            break;
          case 'setLineWidth':
            gs.lineWidth = args[0] as number;
            break;
          case 'setLineCap':
            gs.cap = (['butt', 'round', 'square'] as const)[args[0] as number] ?? 'butt';
            break;
          case 'setLineJoin':
            gs.join = (['miter', 'round', 'bevel'] as const)[args[0] as number] ?? 'miter';
            break;
          case 'setMiterLimit':
            gs.miter = args[0] as number;
            break;
          case 'setDash':
            gs.dash = Array.from((args[0] as number[]) ?? []);
            break;
          case 'setFillRGBColor':
          case 'setFillRGBColorOpaque':
            gs.fill = { color: colorArg(args) };
            break;
          case 'setStrokeRGBColor':
          case 'setStrokeRGBColorOpaque':
            gs.stroke = { color: colorArg(args) };
            break;
          case 'setFillTransparent':
            gs.fill = null;
            break;
          case 'setStrokeTransparent':
            gs.stroke = null;
            break;
          case 'setFillColorN':
            gs.fill = shadingInk(args);
            break;
          case 'setStrokeColorN':
            gs.stroke = shadingInk(args);
            break;
          case 'setGState':
            for (const [key, value] of (args[0] as [string, unknown][]) ?? []) {
              if (key === 'CA') gs.strokeAlpha = value as number;
              else if (key === 'ca') gs.fillAlpha = value as number;
              else if (key === 'LW') gs.lineWidth = value as number;
              else if (key === 'SMask' && value) warnings.add('Soft masks');
              else if (key === 'BM' && value && value !== 'source-over') warnings.add('Blend modes');
            }
            break;
          case 'constructPath': {
            const paint = opName.get(args[0] as number) ?? '';
            const subs = readPath((args[1] as ArrayLike<number>[] | null)?.[0]);
            if (!subs.length) break;
            const close = /^close/.test(paint);
            const shape = close ? subs.map((s) => ({ ...s, closed: true })) : subs;
            if (paint === 'fill') paintPath(shape, true, false, false);
            else if (paint === 'eoFill') paintPath(shape, true, false, true);
            else if (paint === 'stroke' || paint === 'closeStroke') paintPath(shape, false, true, false);
            else if (paint === 'fillStroke' || paint === 'closeFillStroke') paintPath(shape, true, true, false);
            else if (paint === 'eoFillStroke' || paint === 'closeEOFillStroke') paintPath(shape, true, true, true);
            // endPath: the path was only a clip
            break;
          }
          case 'clip':
          case 'eoClip':
            // Illustrator clips every page to its artboard; real masks are flattened away
            break;
          case 'shadingFill':
            warnings.add('Shadings painted without a shape');
            break;
          case 'paintImageXObject':
          case 'paintInlineImageXObject':
          case 'paintImageXObjectRepeat': {
            const img = (typeof args[0] === 'string' ? objs(args[0]) : args[0]) as Parameters<typeof imageUrl>[0];
            const href = imageUrl(img);
            if (!href) {
              warnings.add('Some images');
              break;
            }
            // an image fills the unit square, with its top at y = 1
            nodes.push({ id: newId(), type: 'image', opacity: gs.fillAlpha, href, x: 0, y: 0, width: 1, height: 1, matrix: mul(gs.ctm, [1, 0, 0, -1, 0, 1]) });
            break;
          }
          case 'paintImageMaskXObject':
          case 'paintImageMaskXObjectGroup':
            warnings.add('Image masks');
            break;
          case 'beginText':
            textMatrix = IDENTITY;
            lineMatrix = IDENTITY;
            break;
          case 'setFont':
            gs.font = String(args[0]);
            gs.fontSize = Math.abs(args[1] as number) || 12;
            break;
          case 'setCharSpacing':
            gs.charSpacing = args[0] as number;
            break;
          case 'setWordSpacing':
            gs.wordSpacing = args[0] as number;
            break;
          case 'setHScale':
            gs.hScale = (args[0] as number) / 100;
            break;
          case 'setLeading':
            gs.leading = -(args[0] as number);
            break;
          case 'setTextRise':
            gs.rise = args[0] as number;
            break;
          case 'setTextMatrix':
            // newer pdf.js passes the matrix as one array argument
            textMatrix = lineMatrix = (Array.isArray(args[0]) || ArrayBuffer.isView(args[0]) ? Array.from(args[0] as ArrayLike<number>) : args) as unknown as Mat;
            break;
          case 'moveText':
            textMatrix = lineMatrix = mul(lineMatrix, [1, 0, 0, 1, args[0] as number, args[1] as number]);
            break;
          case 'setLeadingMoveText':
            gs.leading = args[1] as number;
            textMatrix = lineMatrix = mul(lineMatrix, [1, 0, 0, 1, args[0] as number, args[1] as number]);
            break;
          case 'nextLine':
            textMatrix = lineMatrix = mul(lineMatrix, [1, 0, 0, 1, 0, gs.leading]);
            break;
          case 'showText':
          case 'showSpacedText':
            showText((args[0] as unknown[]) ?? []);
            break;
          case 'nextLineShowText':
            textMatrix = lineMatrix = mul(lineMatrix, [1, 0, 0, 1, 0, gs.leading]);
            showText((args[0] as unknown[]) ?? []);
            break;
          default:
            break;
        }
      }
      layers.push({ id: newId('l'), name: pages > 1 ? `Artboard ${pn}` : 'Layer 1', children: nodes });
      page.cleanup();
    }
  } finally {
    await pdf.close();
  }
  if (!layers.some((l) => l.children.length)) warnings.add('This file has no vector artwork File Editor could read');
  return { doc: { version: 1, artboards, layers, swatches: DEFAULT_SWATCHES, textStyles: [] }, warnings: [...warnings] };
}
