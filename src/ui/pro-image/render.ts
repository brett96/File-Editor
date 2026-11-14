/**
 * Compositing for the pro photo editor: draws a layered document onto a canvas with the
 * GPU-backed 2D canvas blend modes. Layer content canvases are cached per immutable layer
 * value (WeakMap), so only edited layers are redrawn. Adjustment layers read the composite
 * below them (CPU) and draw the adjusted copy back with their opacity and blend mode.
 */
import { applyAdjust } from '../../core/pro-image/adjust';
import { BLEND_MODES, type Layer, type ProDocument, type TextLayer } from '../../core/pro-image/document';
import type { Pixels } from '../../core/media/image-ops';
import type { Mask } from '../../core/pro-image/selection';

const contentCache = new WeakMap<object, HTMLCanvasElement>();
const maskCache = new WeakMap<Mask, HTMLCanvasElement>();
const pixelCache = new WeakMap<Pixels, HTMLCanvasElement>();

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function pixelsCanvas(px: Pixels): HTMLCanvasElement {
  let c = pixelCache.get(px);
  if (!c) {
    c = canvas(px.width, px.height);
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.data), px.width, px.height), 0, 0);
    pixelCache.set(px, c);
  }
  return c;
}

/** Forget the cached canvas of pixels that were edited in place (e.g. during a brush stroke). */
export function invalidatePixels(px: Pixels): void {
  pixelCache.delete(px);
}

export function invalidateMask(m: Mask): void {
  maskCache.delete(m);
}

function maskCanvas(m: Mask): HTMLCanvasElement {
  let c = maskCache.get(m);
  if (!c) {
    c = canvas(m.width, m.height);
    const img = new ImageData(m.width, m.height);
    for (let i = 0; i < m.data.length; i++) img.data[i * 4 + 3] = m.data[i];
    c.getContext('2d')!.putImageData(img, 0, 0);
    maskCache.set(m, c);
  }
  return c;
}

export function textFont(l: Pick<TextLayer, 'italic' | 'bold' | 'size' | 'font'>): string {
  return `${l.italic ? 'italic ' : ''}${l.bold ? 700 : 400} ${l.size}px ${l.font}`;
}

let measure: CanvasRenderingContext2D | null = null;
export function textBox(l: TextLayer): { x: number; y: number; width: number; height: number } {
  measure ??= document.createElement('canvas').getContext('2d')!;
  measure.font = textFont(l);
  const lines = l.text.split('\n');
  const width = Math.max(4, ...lines.map((t) => measure!.measureText(t).width));
  const height = lines.length * l.size * 1.2;
  const x = l.align === 'center' ? l.x - width / 2 : l.align === 'right' ? l.x - width : l.x;
  return { x, y: l.y, width, height };
}

/** Draws a non-raster layer's content (document coordinates) into ctx. */
function drawVector(ctx: CanvasRenderingContext2D, l: Layer, doc: ProDocument): void {
  if (l.kind === 'text') {
    ctx.font = textFont(l);
    ctx.textAlign = l.align;
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    if (l.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = l.size * 0.12;
      ctx.shadowOffsetX = ctx.shadowOffsetY = l.size * 0.06;
    }
    l.text.split('\n').forEach((line, i) => {
      const y = l.y + i * l.size * 1.2;
      if (l.stroke > 0) {
        ctx.strokeStyle = l.strokeColor;
        ctx.lineWidth = l.stroke * 2;
        ctx.strokeText(line, l.x, y);
      }
      ctx.fillStyle = l.color;
      ctx.fillText(line, l.x, y);
    });
  } else if (l.kind === 'shape') {
    ctx.beginPath();
    const x = Math.min(l.x, l.x + l.width);
    const y = Math.min(l.y, l.y + l.height);
    const w = Math.abs(l.width);
    const h = Math.abs(l.height);
    if (l.shape === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (l.radius > 0) ctx.roundRect(x, y, w, h, Math.min(l.radius, w / 2, h / 2));
    else ctx.rect(x, y, w, h);
    if (l.fill) {
      ctx.fillStyle = l.fill;
      ctx.fill();
    }
    if (l.stroke && l.strokeWidth > 0) {
      ctx.strokeStyle = l.stroke;
      ctx.lineWidth = l.strokeWidth;
      ctx.stroke();
    }
  } else if (l.kind === 'fill') {
    if (l.fill.type === 'solid') ctx.fillStyle = l.fill.color;
    else {
      const { from, to, angle, radial } = l.fill;
      let g: CanvasGradient;
      if (radial) {
        g = ctx.createRadialGradient(doc.width / 2, doc.height / 2, 0, doc.width / 2, doc.height / 2, Math.hypot(doc.width, doc.height) / 2);
      } else {
        const a = (angle * Math.PI) / 180;
        const r = (Math.abs(doc.width * Math.cos(a)) + Math.abs(doc.height * Math.sin(a))) / 2;
        const cx = doc.width / 2;
        const cy = doc.height / 2;
        g = ctx.createLinearGradient(cx - Math.cos(a) * r, cy + Math.sin(a) * r, cx + Math.cos(a) * r, cy - Math.sin(a) * r);
      }
      g.addColorStop(0, from);
      g.addColorStop(1, to);
      ctx.fillStyle = g;
    }
    ctx.fillRect(0, 0, doc.width, doc.height);
  }
}

/** A layer's content at document size (masked), or null for adjustment layers. */
function layerContent(l: Layer, doc: ProDocument): HTMLCanvasElement | null {
  if (l.kind === 'adjust') return null;
  let c = contentCache.get(l);
  if (c && c.width === doc.width && c.height === doc.height) return c;
  c = canvas(doc.width, doc.height);
  const ctx = c.getContext('2d')!;
  if (l.kind === 'raster') ctx.drawImage(pixelsCanvas(l.px), l.x, l.y);
  else drawVector(ctx, l, doc);
  if (l.mask && l.maskEnabled) {
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(maskCanvas(l.mask), 0, 0);
  }
  contentCache.set(l, c);
  return c;
}

/** Forget a layer's cached content (raster pixels or mask were edited in place). */
export function invalidateLayer(l: Layer): void {
  contentCache.delete(l);
  if (l.kind === 'raster') invalidatePixels(l.px);
  if (l.mask) invalidateMask(l.mask);
}

/**
 * Composites the document at `scale` into a new canvas. With `soloId`, renders only that
 * layer (used for thumbnails).
 */
export function composite(doc: ProDocument, scale = 1, options: { background?: string } = {}): HTMLCanvasElement {
  const out = canvas(doc.width * scale, doc.height * scale);
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, out.width, out.height);
  }
  for (const l of doc.layers) {
    if (!l.visible || l.opacity <= 0) continue;
    const op = BLEND_MODES.find((b) => b.id === l.blend)?.canvas ?? 'source-over';
    if (l.kind === 'adjust') {
      const img = ctx.getImageData(0, 0, out.width, out.height);
      let mask: Uint8Array | null = null;
      if (l.mask && l.maskEnabled) {
        const mc = canvas(out.width, out.height);
        const mctx = mc.getContext('2d', { willReadFrequently: true })!;
        mctx.drawImage(maskCanvas(l.mask), 0, 0, out.width, out.height);
        const md = mctx.getImageData(0, 0, out.width, out.height).data;
        mask = new Uint8Array(out.width * out.height);
        for (let i = 0; i < mask.length; i++) mask[i] = md[i * 4 + 3];
      }
      const adjusted = { data: new Uint8ClampedArray(img.data), width: out.width, height: out.height };
      applyAdjust(adjusted, l.adjust, mask, scale);
      const tmp = canvas(out.width, out.height);
      tmp.getContext('2d')!.putImageData(new ImageData(adjusted.data, out.width, out.height), 0, 0);
      ctx.save();
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = op;
      ctx.drawImage(tmp, 0, 0);
      ctx.restore();
      continue;
    }
    const content = layerContent(l, doc);
    if (!content) continue;
    ctx.save();
    ctx.globalAlpha = l.opacity;
    ctx.globalCompositeOperation = op;
    ctx.drawImage(content, 0, 0, out.width, out.height);
    ctx.restore();
  }
  return out;
}

/** Flattened document pixels at full size. */
export function flatten(doc: ProDocument): Pixels {
  const c = composite(doc, 1);
  const img = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
  return { data: img.data, width: c.width, height: c.height };
}

/** A non-raster layer (text, shape, fill) drawn into document-sized pixels (Rasterize Layer). */
export function rasterizeLayer(l: Layer, doc: ProDocument): Pixels {
  const c = canvas(doc.width, doc.height);
  const ctx = c.getContext('2d')!;
  if (l.kind === 'raster') ctx.drawImage(pixelsCanvas(l.px), l.x, l.y);
  else drawVector(ctx, l, doc);
  const img = ctx.getImageData(0, 0, doc.width, doc.height);
  return { data: img.data, width: doc.width, height: doc.height };
}

/** Small preview of one layer for the Layers panel. */
export function layerThumb(l: Layer, doc: ProDocument, size = 40): HTMLCanvasElement {
  const s = Math.min(size / doc.width, size / doc.height);
  const c = canvas(doc.width * s, doc.height * s);
  const content = layerContent({ ...l, mask: null } as Layer, doc);
  if (content) c.getContext('2d')!.drawImage(content, 0, 0, c.width, c.height);
  return c;
}

export function maskThumb(m: Mask, size = 40): HTMLCanvasElement {
  const s = Math.min(size / m.width, size / m.height);
  const c = canvas(m.width * s, m.height * s);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  const mc = maskCanvas(m);
  const tmp = canvas(c.width, c.height);
  const t = tmp.getContext('2d')!;
  t.fillStyle = '#fff';
  t.fillRect(0, 0, tmp.width, tmp.height);
  t.globalCompositeOperation = 'destination-in';
  t.drawImage(mc, 0, 0, tmp.width, tmp.height);
  ctx.drawImage(tmp, 0, 0);
  return c;
}
