/**
 * Studio stylize effects: per-layer pixel effects applied in a stack, after the colour grade
 * and chroma key. Pure functions on RGBA pixels, edited in place. Sizes are in output
 * pixels and are multiplied by `k` (how large the layer is being drawn relative to the
 * output), so a preview at half size looks like the export.
 */
import type { Pixels } from '../media/image-ops';

export type StyleType = 'curlNoise' | 'contour' | 'glow' | 'pixelate' | 'posterize' | 'sharpen' | 'rgbSplit' | 'lumaKey';

export interface StyleEffect {
  id: string;
  type: StyleType;
  enabled: boolean;
  amount: number;
  size: number;
}

interface ParamDef {
  label: string;
  min: number;
  max: number;
  def: number;
}

export const STYLE_DEFS: Record<StyleType, { label: string; hint: string; amount: ParamDef; size?: ParamDef }> = {
  curlNoise: {
    label: 'Curl noise (liquid distortion)',
    hint: 'Swirls the picture along a flowing noise field that drifts over time, like heat haze or water.',
    amount: { label: 'Strength (px)', min: 0, max: 200, def: 24 },
    size: { label: 'Swirl size (px)', min: 8, max: 600, def: 120 },
  },
  contour: {
    label: 'Contour (outline drawing)',
    hint: 'Traces the edges in the picture as lines.',
    amount: { label: 'Detail', min: 1, max: 100, def: 55 },
    size: { label: 'Keep picture %', min: 0, max: 100, def: 0 },
  },
  glow: {
    label: 'Glow',
    hint: 'Bright areas bloom into their surroundings.',
    amount: { label: 'Strength', min: 0, max: 100, def: 50 },
    size: { label: 'Radius (px)', min: 1, max: 80, def: 16 },
  },
  pixelate: { label: 'Pixelate (mosaic)', hint: 'Large square blocks; with a mask it hides a face.', amount: { label: 'Block size (px)', min: 2, max: 120, def: 16 } },
  posterize: { label: 'Posterize', hint: 'Reduces the picture to a few flat tones.', amount: { label: 'Levels', min: 2, max: 16, def: 4 } },
  sharpen: { label: 'Sharpen', hint: 'Crisper edges.', amount: { label: 'Strength', min: 0, max: 100, def: 50 }, size: { label: 'Radius (px)', min: 1, max: 12, def: 2 } },
  rgbSplit: { label: 'RGB split (glitch)', hint: 'Pulls the red and blue channels apart sideways.', amount: { label: 'Offset (px)', min: 0, max: 60, def: 6 } },
  lumaKey: {
    label: 'Luma key (remove dark areas)',
    hint: 'Makes dark parts transparent: for fire, smoke, sparks or light leaks shot on black.',
    amount: { label: 'Threshold', min: 0, max: 100, def: 15 },
    size: { label: 'Softness', min: 0, max: 100, def: 20 },
  },
};

let n = 0;
export function newStyle(type: StyleType): StyleEffect {
  const d = STYLE_DEFS[type];
  return { id: `F${Date.now().toString(36)}${(n++).toString(36)}`, type, enabled: true, amount: d.amount.def, size: d.size?.def ?? 0 };
}

// ── noise ─────────────────────────────────────────────────────────────────

function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Smooth 3D value noise, 0–1. */
export function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const w = smooth(z - zi);
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  const plane = (k: number) => mix(mix(hash3(xi, yi, k), hash3(xi + 1, yi, k), u), mix(hash3(xi, yi + 1, k), hash3(xi + 1, yi + 1, k), u), v);
  return mix(plane(zi), plane(zi + 1), w);
}

/**
 * The curl of a noise potential: a flow field with no sources or sinks, so the picture swirls
 * without bunching up or tearing. Returned on a coarse grid (one cell per `cell` pixels).
 */
export function curlField(width: number, height: number, cell: number, noiseSize: number, time: number): { gw: number; gh: number; vx: Float32Array; vy: Float32Array } {
  const gw = Math.ceil(width / cell) + 2;
  const gh = Math.ceil(height / cell) + 2;
  const psi = new Float32Array((gw + 2) * (gh + 2));
  const s = cell / Math.max(1, noiseSize);
  for (let y = 0; y < gh + 2; y++) for (let x = 0; x < gw + 2; x++) psi[y * (gw + 2) + x] = noise3(x * s, y * s, time * 0.35) + 0.5 * noise3(x * s * 2 + 31, y * s * 2 + 17, time * 0.6);
  const vx = new Float32Array(gw * gh);
  const vy = new Float32Array(gw * gh);
  // central differences per grid cell, rescaled to "per noise cell" so the strength does not depend on the grid
  const norm = 1 / (2 * s);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = (y + 1) * (gw + 2) + x + 1;
      vx[y * gw + x] = (psi[i + gw + 2] - psi[i - gw - 2]) * norm;
      vy[y * gw + x] = -(psi[i + 1] - psi[i - 1]) * norm;
    }
  }
  return { gw, gh, vx, vy };
}

function curlNoise(px: Pixels, amount: number, size: number, time: number): void {
  if (amount <= 0) return;
  const { width: w, height: h, data: d } = px;
  const cell = 4;
  const f = curlField(w, h, cell, size, time);
  const src = new Uint8ClampedArray(d);
  for (let y = 0; y < h; y++) {
    const gy = y / cell;
    const y0 = Math.floor(gy);
    const fy = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = x / cell;
      const x0 = Math.floor(gx);
      const fx = gx - x0;
      const i00 = y0 * f.gw + x0;
      const i10 = i00 + 1;
      const i01 = i00 + f.gw;
      const i11 = i01 + 1;
      const dx = (f.vx[i00] * (1 - fx) + f.vx[i10] * fx) * (1 - fy) + (f.vx[i01] * (1 - fx) + f.vx[i11] * fx) * fy;
      const dy = (f.vy[i00] * (1 - fx) + f.vy[i10] * fx) * (1 - fy) + (f.vy[i01] * (1 - fx) + f.vy[i11] * fx) * fy;
      const sx = Math.min(w - 1, Math.max(0, Math.round(x + dx * amount)));
      const sy = Math.min(h - 1, Math.max(0, Math.round(y + dy * amount)));
      const o = (y * w + x) * 4;
      const si = (sy * w + sx) * 4;
      d[o] = src[si];
      d[o + 1] = src[si + 1];
      d[o + 2] = src[si + 2];
      d[o + 3] = src[si + 3];
    }
  }
}

// ── the rest ──────────────────────────────────────────────────────────────

/** Box blur of an RGBA copy (two passes each way approximate a Gaussian). Alpha is blurred too. */
function boxBlur(src: Uint8ClampedArray, w: number, h: number, radius: number): Uint8ClampedArray {
  const r = Math.max(1, Math.round(radius));
  const a = new Float32Array(src);
  const b = new Float32Array(src.length);
  const pass = (from: Float32Array, to: Float32Array, horizontal: boolean) => {
    const len = horizontal ? w : h;
    const lines = horizontal ? h : w;
    const step = horizontal ? 4 : w * 4;
    for (let l = 0; l < lines; l++) {
      const base = horizontal ? l * w * 4 : l * 4;
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let i = -r; i <= r; i++) sum += from[base + Math.min(len - 1, Math.max(0, i)) * step + c];
        for (let i = 0; i < len; i++) {
          to[base + i * step + c] = sum / (2 * r + 1);
          sum += from[base + Math.min(len - 1, i + r + 1) * step + c] - from[base + Math.max(0, i - r) * step + c];
        }
      }
    }
  };
  for (let i = 0; i < 2; i++) {
    pass(a, b, true);
    pass(b, a, false);
  }
  const out = new Uint8ClampedArray(src.length);
  out.set(a);
  return out;
}

const lumaOf = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

function contour(px: Pixels, detail: number, keep: number): void {
  const { width: w, height: h, data: d } = px;
  const l = new Float32Array(w * h);
  for (let i = 0, j = 0; j < l.length; i += 4, j++) l[j] = lumaOf(d, i);
  const gain = 0.5 + (detail / 100) * 7.5;
  const mixIn = Math.min(1, Math.max(0, keep / 100));
  for (let y = 0; y < h; y++) {
    const ym = Math.max(0, y - 1) * w;
    const yp = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(w - 1, x + 1);
      const gx = l[ym + xp] + 2 * l[y * w + xp] + l[yp + xp] - l[ym + xm] - 2 * l[y * w + xm] - l[yp + xm];
      const gy = l[yp + xm] + 2 * l[yp + x] + l[yp + xp] - l[ym + xm] - 2 * l[ym + x] - l[ym + xp];
      const e = Math.min(1, (Math.hypot(gx, gy) / 1020) * gain);
      const o = (y * w + x) * 4;
      // lines only: white on black; with the picture kept: the picture with dark lines drawn over it
      for (let c = 0; c < 3; c++) d[o + c] = e * 255 * (1 - mixIn) + d[o + c] * (1 - e) * mixIn;
    }
  }
}

function glow(px: Pixels, strength: number, radius: number): void {
  const { width: w, height: h, data: d } = px;
  const bright = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const k = Math.max(0, (lumaOf(d, i) - 140) / 115) * (d[i + 3] / 255);
    bright[i] = d[i] * k;
    bright[i + 1] = d[i + 1] * k;
    bright[i + 2] = d[i + 2] * k;
    bright[i + 3] = 255;
  }
  const b = boxBlur(bright, w, h, radius);
  const s = (strength / 100) * 1.6;
  for (let i = 0; i < d.length; i += 4) {
    d[i] += b[i] * s;
    d[i + 1] += b[i + 1] * s;
    d[i + 2] += b[i + 2] * s;
  }
}

function pixelate(px: Pixels, block: number): void {
  const { width: w, height: h, data: d } = px;
  const bs = Math.max(2, Math.round(block));
  for (let by = 0; by < h; by += bs) {
    for (let bx = 0; bx < w; bx += bs) {
      const sums = [0, 0, 0, 0];
      let count = 0;
      const y1 = Math.min(h, by + bs);
      const x1 = Math.min(w, bx + bs);
      for (let y = by; y < y1; y++) for (let x = bx; x < x1; x++, count++) for (let c = 0; c < 4; c++) sums[c] += d[(y * w + x) * 4 + c];
      for (let y = by; y < y1; y++) for (let x = bx; x < x1; x++) for (let c = 0; c < 4; c++) d[(y * w + x) * 4 + c] = sums[c] / count;
    }
  }
}

function posterize(px: Pixels, levels: number): void {
  const nl = Math.max(2, Math.round(levels));
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round((Math.floor((i / 256) * nl) / (nl - 1)) * 255);
  const d = px.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]];
    d[i + 1] = lut[d[i + 1]];
    d[i + 2] = lut[d[i + 2]];
  }
}

function sharpen(px: Pixels, strength: number, radius: number): void {
  const d = px.data;
  const b = boxBlur(d, px.width, px.height, radius);
  const s = (strength / 100) * 2;
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = d[i + c] + (d[i + c] - b[i + c]) * s;
}

function rgbSplit(px: Pixels, offset: number): void {
  const { width: w, height: h, data: d } = px;
  const o = Math.round(offset);
  if (!o) return;
  const src = new Uint8ClampedArray(d);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d[i] = src[(y * w + Math.min(w - 1, Math.max(0, x + o))) * 4];
      d[i + 2] = src[(y * w + Math.min(w - 1, Math.max(0, x - o))) * 4 + 2];
    }
  }
}

function lumaKey(px: Pixels, threshold: number, softness: number): void {
  const d = px.data;
  const t0 = (threshold / 100) * 255;
  const t1 = t0 + (softness / 100) * 255 + 1e-3;
  for (let i = 0; i < d.length; i += 4) {
    const l = lumaOf(d, i);
    let a = l <= t0 ? 0 : l >= t1 ? 1 : (l - t0) / (t1 - t0);
    a = a * a * (3 - 2 * a);
    d[i + 3] *= a;
  }
}

/** Applies one effect in place. `time` is seconds from the clip start; `k` scales pixel sizes to the drawn size. */
export function applyStyle(px: Pixels, fx: StyleEffect, time: number, k = 1): void {
  if (!fx.enabled) return;
  switch (fx.type) {
    case 'curlNoise':
      return curlNoise(px, fx.amount * k, Math.max(2, fx.size * k), time);
    case 'contour':
      return contour(px, fx.amount, fx.size);
    case 'glow':
      return glow(px, fx.amount, Math.max(1, fx.size * k));
    case 'pixelate':
      return pixelate(px, Math.max(2, fx.amount * k));
    case 'posterize':
      return posterize(px, fx.amount);
    case 'sharpen':
      return sharpen(px, fx.amount, Math.max(1, fx.size * k));
    case 'rgbSplit':
      return rgbSplit(px, fx.amount * k);
    case 'lumaKey':
      return lumaKey(px, fx.amount, fx.size);
  }
}
