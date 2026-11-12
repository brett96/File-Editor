/**
 * Selections for the pro photo editor: a mask of 0–255 per document pixel (255 = selected,
 * in between = feathered). Pure functions, no DOM.
 */
import type { Pixels } from '../media/image-ops';

export interface Mask {
  data: Uint8Array;
  width: number;
  height: number;
}

export type CombineMode = 'replace' | 'add' | 'subtract' | 'intersect';

export function emptyMask(width: number, height: number): Mask {
  return { data: new Uint8Array(width * height), width, height };
}

export function fullMask(width: number, height: number): Mask {
  return { data: new Uint8Array(width * height).fill(255), width, height };
}

export function rectMask(width: number, height: number, x: number, y: number, w: number, h: number): Mask {
  const m = emptyMask(width, height);
  const x0 = Math.max(0, Math.floor(Math.min(x, x + w)));
  const x1 = Math.min(width, Math.ceil(Math.max(x, x + w)));
  const y0 = Math.max(0, Math.floor(Math.min(y, y + h)));
  const y1 = Math.min(height, Math.ceil(Math.max(y, y + h)));
  for (let yy = y0; yy < y1; yy++) m.data.fill(255, yy * width + x0, yy * width + x1);
  return m;
}

/** Ellipse inscribed in the rectangle, with a one-pixel anti-aliased edge. */
export function ellipseMask(width: number, height: number, x: number, y: number, w: number, h: number): Mask {
  const m = emptyMask(width, height);
  const rx = Math.abs(w) / 2;
  const ry = Math.abs(h) / 2;
  if (rx < 0.5 || ry < 0.5) return m;
  const cx = Math.min(x, x + w) + rx;
  const cy = Math.min(y, y + h) + ry;
  const y0 = Math.max(0, Math.floor(cy - ry - 1));
  const y1 = Math.min(height, Math.ceil(cy + ry + 1));
  const x0 = Math.max(0, Math.floor(cx - rx - 1));
  const x1 = Math.min(width, Math.ceil(cx + rx + 1));
  const r = Math.min(rx, ry);
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const dx = (xx + 0.5 - cx) / rx;
      const dy = (yy + 0.5 - cy) / ry;
      // distance from the edge in pixels (approximate)
      const dist = (1 - Math.sqrt(dx * dx + dy * dy)) * r;
      const a = dist >= 0.5 ? 255 : dist <= -0.5 ? 0 : Math.round((dist + 0.5) * 255);
      if (a) m.data[yy * width + xx] = a;
    }
  }
  return m;
}

/** Polygon (lasso) with the even–odd rule, scanline filled. */
export function polygonMask(width: number, height: number, points: [number, number][]): Mask {
  const m = emptyMask(width, height);
  if (points.length < 3) return m;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, py] of points) {
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(height - 1, Math.ceil(maxY));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const sy = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i];
      const [xj, yj] = points[j];
      if ((yi > sy) !== (yj > sy)) xs.push(xi + ((sy - yi) / (yj - yi)) * (xj - xi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.round(xs[k]));
      const b = Math.min(width, Math.round(xs[k + 1]));
      if (b > a) m.data.fill(255, y * width + a, y * width + b);
    }
  }
  return m;
}

/**
 * Magic wand: pixels within `tolerance` (0–255, per channel max difference incl. alpha) of the
 * clicked colour. Contiguous = flood fill from the point (4-connected); otherwise every
 * matching pixel in the image.
 */
export function magicWand(px: Pixels, x: number, y: number, tolerance: number, contiguous = true): Mask {
  const { width, height, data } = px;
  const m = emptyMask(width, height);
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= width || y >= height) return m;
  const k0 = (y * width + x) * 4;
  const tr = data[k0];
  const tg = data[k0 + 1];
  const tb = data[k0 + 2];
  const ta = data[k0 + 3];
  const tol = Math.max(0, Math.min(255, tolerance));
  const match = (i: number) => {
    const k = i * 4;
    return (
      Math.abs(data[k] - tr) <= tol && Math.abs(data[k + 1] - tg) <= tol && Math.abs(data[k + 2] - tb) <= tol && Math.abs(data[k + 3] - ta) <= tol
    );
  };
  if (!contiguous) {
    for (let i = 0, n = width * height; i < n; i++) if (match(i)) m.data[i] = 255;
    return m;
  }
  const stack = new Int32Array(width * height);
  let sp = 0;
  stack[sp++] = y * width + x;
  m.data[y * width + x] = 255;
  while (sp) {
    const i = stack[--sp];
    const cx = i % width;
    const n4 = [cx > 0 ? i - 1 : -1, cx < width - 1 ? i + 1 : -1, i - width, i + width];
    for (const j of n4) {
      if (j < 0 || j >= width * height || m.data[j]) continue;
      if (!match(j)) continue;
      m.data[j] = 255;
      stack[sp++] = j;
    }
  }
  return m;
}

export function combineMasks(a: Mask | null, b: Mask, mode: CombineMode): Mask {
  if (!a || mode === 'replace') return b;
  const out = emptyMask(b.width, b.height);
  for (let i = 0; i < out.data.length; i++) {
    const x = a.data[i];
    const y = b.data[i];
    out.data[i] = mode === 'add' ? Math.max(x, y) : mode === 'subtract' ? Math.max(0, x - y) : Math.min(x, y);
  }
  return out;
}

export function invertMask(m: Mask): Mask {
  const out = emptyMask(m.width, m.height);
  for (let i = 0; i < m.data.length; i++) out.data[i] = 255 - m.data[i];
  return out;
}

/** Feather: blur the mask edge by `radius` px (three box-blur passes ≈ Gaussian). */
export function featherMask(m: Mask, radius: number): Mask {
  const r = Math.round(radius);
  if (r < 1) return m;
  const { width: w, height: h } = m;
  let src = Float32Array.from(m.data);
  let tmp = new Float32Array(src.length);
  const passR = Math.max(1, Math.round(r / 2));
  for (let pass = 0; pass < 3; pass++) {
    // horizontal
    for (let y = 0; y < h; y++) {
      let acc = 0;
      const row = y * w;
      for (let x = -passR; x <= passR; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / (2 * passR + 1);
        acc += src[row + Math.min(w - 1, x + passR + 1)] - src[row + Math.max(0, x - passR)];
      }
    }
    // vertical
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -passR; y <= passR; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        src[y * w + x] = acc / (2 * passR + 1);
        acc += tmp[Math.min(h - 1, y + passR + 1) * w + x] - tmp[Math.max(0, y - passR) * w + x];
      }
    }
  }
  const out = emptyMask(w, h);
  for (let i = 0; i < out.data.length; i++) out.data[i] = Math.round(src[i]);
  return out;
}

/** Bounding box of the selected pixels, or null when nothing is selected. */
export function maskBounds(m: Mask): { x: number; y: number; width: number; height: number } | null {
  let x0 = m.width;
  let y0 = m.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < m.height; y++) {
    const row = y * m.width;
    for (let x = 0; x < m.width; x++) {
      if (m.data[row + x] < 1) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

export function isEmptyMask(m: Mask | null): boolean {
  if (!m) return true;
  for (let i = 0; i < m.data.length; i++) if (m.data[i]) return false;
  return true;
}

/** Boundary pixels of the selection (for drawing "marching ants"). */
export function maskOutline(m: Mask): Uint8Array {
  const { width: w, height: h, data } = m;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (data[i] < 128) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || data[i - 1] < 128 || data[i + 1] < 128 || data[i - w] < 128 || data[i + w] < 128) out[i] = 1;
    }
  }
  return out;
}
