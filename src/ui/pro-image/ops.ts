/**
 * Document-level operations for the pro photo editor that need a canvas (resampling,
 * rotating, merging). Each returns a new document; inputs are never mutated.
 */
import { adjustToPsd } from '../../core/pro-image/psd';
import type { Pixels } from '../../core/media/image-ops';
import {
  clonePixels,
  rasterLayer,
  type Layer,
  type ProDocument,
  type RasterLayer,
} from '../../core/pro-image/document';
import { emptyMask, maskBounds, type Mask } from '../../core/pro-image/selection';
import { composite, pixelsCanvas, rasterizeLayer } from './render';

function canvasToPixels(c: HTMLCanvasElement): Pixels {
  const img = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
  return { data: img.data, width: c.width, height: c.height };
}

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function maskToCanvas(m: Mask): HTMLCanvasElement {
  const c = newCanvas(m.width, m.height);
  const img = new ImageData(m.width, m.height);
  for (let i = 0; i < m.data.length; i++) img.data[i * 4 + 3] = m.data[i];
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}

function canvasToMask(c: HTMLCanvasElement): Mask {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  const m = emptyMask(c.width, c.height);
  for (let i = 0; i < m.data.length; i++) m.data[i] = d[i * 4 + 3];
  return m;
}

/** Applies a 2D transform to every layer, mask and the document size. */
function transformDoc(doc: ProDocument, width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void, scaleVector: { sx: number; sy: number; map: (x: number, y: number) => [number, number] }): ProDocument {
  const layers = doc.layers.map((l): Layer => {
    let out: Layer;
    if (l.kind === 'raster') {
      const c = newCanvas(width, height);
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      draw(ctx);
      ctx.drawImage(pixelsCanvas(l.px), l.x, l.y);
      out = { ...l, px: canvasToPixels(c), x: 0, y: 0 };
    } else if (l.kind === 'text') {
      const [x, y] = scaleVector.map(l.x, l.y);
      out = { ...l, x, y, size: Math.max(1, l.size * Math.min(Math.abs(scaleVector.sx), Math.abs(scaleVector.sy))) };
    } else if (l.kind === 'shape') {
      const [x, y] = scaleVector.map(l.x, l.y);
      const [x2, y2] = scaleVector.map(l.x + l.width, l.y + l.height);
      out = { ...l, x: Math.min(x, x2), y: Math.min(y, y2), width: Math.abs(x2 - x), height: Math.abs(y2 - y), strokeWidth: l.strokeWidth * Math.abs(scaleVector.sx) };
    } else out = { ...l };
    if (l.mask) {
      const c = newCanvas(width, height);
      const ctx = c.getContext('2d')!;
      draw(ctx);
      ctx.drawImage(maskToCanvas(l.mask), 0, 0);
      out.mask = canvasToMask(c);
    }
    return out;
  });
  return { width: Math.round(width), height: Math.round(height), layers };
}

export function resizeImage(doc: ProDocument, width: number, height: number): ProDocument {
  const sx = width / doc.width;
  const sy = height / doc.height;
  return transformDoc(doc, width, height, (ctx) => ctx.scale(sx, sy), { sx, sy, map: (x, y) => [x * sx, y * sy] });
}

/** Canvas Size: grow or shrink the document around an anchor (0–1 per axis), layers keep their pixels. */
export function resizeCanvas(doc: ProDocument, width: number, height: number, anchorX: number, anchorY: number): ProDocument {
  const dx = Math.round((width - doc.width) * anchorX);
  const dy = Math.round((height - doc.height) * anchorY);
  const layers = doc.layers.map((l): Layer => {
    const moved: Layer = l.kind === 'raster' || l.kind === 'text' || l.kind === 'shape' ? ({ ...l, x: l.x + dx, y: l.y + dy } as Layer) : { ...l };
    if (l.mask) {
      const m = emptyMask(width, height);
      for (let y = 0; y < l.mask.height; y++) {
        const ty = y + dy;
        if (ty < 0 || ty >= height) continue;
        for (let x = 0; x < l.mask.width; x++) {
          const tx = x + dx;
          if (tx >= 0 && tx < width) m.data[ty * width + tx] = l.mask.data[y * l.mask.width + x];
        }
      }
      // new canvas area is revealed
      moved.mask = m;
    }
    return moved;
  });
  return { width, height, layers };
}

export function rotateImage(doc: ProDocument, turns: 1 | 2 | 3): ProDocument {
  const w = turns % 2 ? doc.height : doc.width;
  const h = turns % 2 ? doc.width : doc.height;
  const angle = (turns * Math.PI) / 2;
  return transformDoc(
    doc,
    w,
    h,
    (ctx) => {
      ctx.translate(w / 2, h / 2);
      ctx.rotate(angle);
      ctx.translate(-doc.width / 2, -doc.height / 2);
    },
    {
      sx: 1,
      sy: 1,
      map: (x, y) => {
        const cx = x - doc.width / 2;
        const cy = y - doc.height / 2;
        const c = Math.round(Math.cos(angle));
        const s = Math.round(Math.sin(angle));
        return [cx * c - cy * s + w / 2, cx * s + cy * c + h / 2];
      },
    },
  );
}

export function flipImage(doc: ProDocument, axis: 'h' | 'v'): ProDocument {
  return transformDoc(
    doc,
    doc.width,
    doc.height,
    (ctx) => {
      if (axis === 'h') {
        ctx.translate(doc.width, 0);
        ctx.scale(-1, 1);
      } else {
        ctx.translate(0, doc.height);
        ctx.scale(1, -1);
      }
    },
    { sx: 1, sy: 1, map: (x, y) => (axis === 'h' ? [doc.width - x, y] : [x, doc.height - y]) },
  );
}

export function cropToRect(doc: ProDocument, r: { x: number; y: number; width: number; height: number }): ProDocument {
  const shifted = resizeCanvas(doc, doc.width, doc.height, 0, 0);
  const layers = shifted.layers.map((l): Layer => {
    const moved: Layer = l.kind === 'raster' || l.kind === 'text' || l.kind === 'shape' ? ({ ...l, x: l.x - r.x, y: l.y - r.y } as Layer) : { ...l };
    if (l.mask) {
      const m = emptyMask(r.width, r.height);
      for (let y = 0; y < r.height; y++) m.data.set(l.mask.data.subarray((y + r.y) * l.mask.width + r.x, (y + r.y) * l.mask.width + r.x + r.width), y * r.width);
      moved.mask = m;
    }
    return moved;
  });
  return { width: r.width, height: r.height, layers };
}

export function cropToSelection(doc: ProDocument, sel: Mask): ProDocument | null {
  const b = maskBounds(sel);
  return b ? cropToRect(doc, b) : null;
}

/** Free transform of one raster layer: scale (fractions), rotate (degrees), flip, around its centre. */
export function transformLayer(l: RasterLayer, sx: number, sy: number, degrees: number, flipH: boolean, flipV: boolean): RasterLayer {
  const src = pixelsCanvas(l.px);
  const rad = (degrees * Math.PI) / 180;
  const w = l.px.width * Math.abs(sx);
  const h = l.px.height * Math.abs(sy);
  const bw = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
  const bh = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
  const c = newCanvas(bw, bh);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(rad);
  ctx.scale(sx * (flipH ? -1 : 1), sy * (flipV ? -1 : 1));
  ctx.drawImage(src, -l.px.width / 2, -l.px.height / 2);
  const cx = l.x + l.px.width / 2;
  const cy = l.y + l.px.height / 2;
  return { ...l, px: canvasToPixels(c), x: Math.round(cx - c.width / 2), y: Math.round(cy - c.height / 2) };
}

/**
 * For saving as Photoshop: adjustment layers Photoshop has no equivalent of (Clarity, Dehaze,
 * Grain, LUT) become pixel layers holding the picture as it looks up to and including them,
 * so the file opens looking the same. The other layers are untouched.
 */
export function bakeForPsd(doc: ProDocument): ProDocument {
  if (!doc.layers.some((l) => l.kind === 'adjust' && !adjustToPsd(l.adjust))) return doc;
  const layers = doc.layers.map((l, i) => {
    if (l.kind !== 'adjust' || adjustToPsd(l.adjust) || !l.visible) return l;
    const baked = rasterLayer(l.name, canvasToPixels(composite({ ...doc, layers: doc.layers.slice(0, i + 1) }, 1)));
    return { ...baked, id: l.id, locked: l.locked };
  });
  return { ...doc, layers };
}

/** Merge Down: the layer and the one below become one raster layer (with the lower layer's settings). */
export function mergeDown(doc: ProDocument, id: string): ProDocument {
  const i = doc.layers.findIndex((l) => l.id === id);
  if (i <= 0) return doc;
  const below = doc.layers[i - 1];
  const above = doc.layers[i];
  const px = composite({ ...doc, layers: [{ ...below, opacity: 1, blend: 'normal' }, above] }, 1);
  const merged = rasterLayer(below.name, canvasToPixels(px));
  merged.opacity = below.opacity;
  merged.blend = below.blend;
  merged.visible = below.visible;
  const layers = [...doc.layers];
  layers.splice(i - 1, 2, merged);
  return { ...doc, layers };
}

export function flattenDocument(doc: ProDocument): ProDocument {
  const visible = doc.layers.filter((l) => l.visible);
  return { ...doc, layers: [rasterLayer('Background', canvasToPixels(composite({ ...doc, layers: visible }, 1, { background: '#ffffff' })))] };
}

export function rasterize(doc: ProDocument, l: Layer): RasterLayer {
  const r = rasterLayer(l.name, rasterizeLayer(l, doc));
  return { ...r, id: l.id, visible: l.visible, opacity: l.opacity, blend: l.blend, mask: l.mask, maskEnabled: l.maskEnabled, locked: l.locked };
}

/** Layer pixels within the selection, as a new layer at the same place (Layer via Copy). */
export function copySelection(doc: ProDocument, l: RasterLayer, sel: Mask): RasterLayer | null {
  const b = maskBounds(sel);
  if (!b) return null;
  const out = { data: new Uint8ClampedArray(b.width * b.height * 4), width: b.width, height: b.height };
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      const dx = b.x + x;
      const dy = b.y + y;
      const lx = dx - l.x;
      const ly = dy - l.y;
      if (lx < 0 || ly < 0 || lx >= l.px.width || ly >= l.px.height) continue;
      const a = sel.data[dy * doc.width + dx];
      if (!a) continue;
      const s = (ly * l.px.width + lx) * 4;
      const t = (y * b.width + x) * 4;
      out.data[t] = l.px.data[s];
      out.data[t + 1] = l.px.data[s + 1];
      out.data[t + 2] = l.px.data[s + 2];
      out.data[t + 3] = (l.px.data[s + 3] * a) / 255;
    }
  }
  return rasterLayer(`${l.name} (copy)`, out, b.x, b.y);
}

/** Clears (makes transparent) the selected pixels of a raster layer. */
export function clearSelection(l: RasterLayer, sel: Mask): RasterLayer {
  const px = clonePixels(l.px);
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      const dx = x + l.x;
      const dy = y + l.y;
      if (dx < 0 || dy < 0 || dx >= sel.width || dy >= sel.height) continue;
      const a = sel.data[dy * sel.width + dx];
      if (!a) continue;
      const k = (y * px.width + x) * 4 + 3;
      px.data[k] = (px.data[k] * (255 - a)) / 255;
    }
  }
  return { ...l, px };
}

/** Fills the selection (or the whole layer) of a raster layer with a colour or gradient. */
export function fillRaster(
  doc: ProDocument,
  l: RasterLayer,
  sel: Mask | null,
  paint: { color: string } | { from: string; to: string; x0: number; y0: number; x1: number; y1: number; radial: boolean },
  opacity = 1,
): RasterLayer {
  // work at document size so fills can reach outside a small layer
  const c = newCanvas(doc.width, doc.height);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(pixelsCanvas(l.px), l.x, l.y);
  const fill = newCanvas(doc.width, doc.height);
  const f = fill.getContext('2d')!;
  if ('color' in paint) f.fillStyle = paint.color;
  else {
    const g = paint.radial
      ? f.createRadialGradient(paint.x0, paint.y0, 0, paint.x0, paint.y0, Math.hypot(paint.x1 - paint.x0, paint.y1 - paint.y0))
      : f.createLinearGradient(paint.x0, paint.y0, paint.x1, paint.y1);
    g.addColorStop(0, paint.from);
    g.addColorStop(1, paint.to);
    f.fillStyle = g;
  }
  f.fillRect(0, 0, doc.width, doc.height);
  if (sel) {
    f.globalCompositeOperation = 'destination-in';
    f.drawImage(maskToCanvas(sel), 0, 0);
  }
  ctx.globalAlpha = opacity;
  ctx.drawImage(fill, 0, 0);
  return { ...l, px: canvasToPixels(c), x: 0, y: 0 };
}

/** A flood-fill area of a raster layer filled with a colour (Paint Bucket). */
export function bucketFill(doc: ProDocument, l: RasterLayer, area: Mask, color: string, opacity = 1): RasterLayer {
  return fillRaster(doc, l, area, { color }, opacity);
}

export { canvasToPixels };
