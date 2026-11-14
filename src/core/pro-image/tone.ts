/**
 * Adjustments that look at the neighbourhood of each pixel (Clarity, Dehaze, Grain) or map
 * colours through a 3D table (LUT / .cube files). Used as non-destructive adjustment layers
 * through applyAdjust. Pure maths on RGBA pixels.
 *
 * Clarity and Dehaze size their neighbourhoods from the picture, so a small preview matches
 * the saved file; Grain takes `scale` (preview pixels per document pixel) for the same reason.
 */
import type { Pixels } from '../media/image-ops';

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Separable box blur of one float channel (edges clamp). */
function blurChannel(src: Float32Array, w: number, h: number, radius: number, passes = 2): Float32Array {
  const r = Math.max(1, Math.round(radius));
  let a = src;
  const b = new Float32Array(src.length);
  const span = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += a[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[row + x] = acc / span;
        acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    const c = a === src ? new Float32Array(src.length) : a;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        c[y * w + x] = acc / span;
        acc += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
    a = c;
  }
  return a;
}

/** Separable minimum filter (erosion) of one channel. */
function minChannel(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(1, Math.round(radius));
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      const x1 = Math.min(w - 1, x + r);
      for (let i = Math.max(0, x - r); i <= x1; i++) m = Math.min(m, src[y * w + i]);
      tmp[y * w + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = Infinity;
      const y1 = Math.min(h - 1, y + r);
      for (let i = Math.max(0, y - r); i <= y1; i++) m = Math.min(m, tmp[i * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
}

/**
 * Clarity: local contrast in the midtones. Each pixel is pushed away from the average of
 * its surroundings; shadows and highlights are left alone so they do not clip. A negative
 * amount softens (a gentle glow). amount −100…100.
 */
export function clarity(px: Pixels, amount: number): Uint8ClampedArray {
  const { width: w, height: h, data: d } = px;
  const n = w * h;
  const out = new Uint8ClampedArray(d);
  if (!amount) return out;
  const lum = new Float32Array(n);
  for (let i = 0, k = 0; i < n; i++, k += 4) lum[i] = 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2];
  // a sixtieth of the picture: the same relative size at any preview scale
  const radius = Math.max(2, Math.max(w, h) / 60);
  const soft = blurChannel(lum, w, h, radius);
  const s = (amount / 100) * 1.1;
  for (let i = 0, k = 0; i < n; i++, k += 4) {
    const l = lum[i] / 255;
    // 1 in the midtones, falling to 0 at black and white
    const mid = 1 - (2 * l - 1) ** 4;
    const delta = (lum[i] - soft[i]) * s * mid;
    out[k] = clamp255(d[k] + delta);
    out[k + 1] = clamp255(d[k + 1] + delta);
    out[k + 2] = clamp255(d[k + 2] + delta);
  }
  return out;
}

/**
 * Dehaze (dark channel prior, He et al.): haze lifts the darkest channel of every patch, so
 * that lift measures how much haze there is; it is then subtracted. A negative amount adds
 * haze. amount −100…100.
 */
export function dehaze(px: Pixels, amount: number): Uint8ClampedArray {
  const { width: w, height: h, data: d } = px;
  const n = w * h;
  const out = new Uint8ClampedArray(d);
  if (!amount) return out;
  const dark = new Float32Array(n);
  for (let i = 0, k = 0; i < n; i++, k += 4) dark[i] = Math.min(d[k], d[k + 1], d[k + 2]);
  const patch = Math.max(2, Math.max(w, h) / 80);
  const eroded = minChannel(dark, w, h, patch);
  // the haze colour: the average of the pixels whose patch is the haziest (top 0.1 %)
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[Math.round(eroded[i])]++;
  let need = Math.max(1, Math.round(n * 0.001));
  let cut = 255;
  while (cut > 0 && need > hist[cut]) need -= hist[cut--];
  let ar = 0;
  let ag = 0;
  let ab = 0;
  let count = 0;
  for (let i = 0, k = 0; i < n; i++, k += 4) {
    if (eroded[i] >= cut) {
      ar += d[k];
      ag += d[k + 1];
      ab += d[k + 2];
      count++;
    }
  }
  ar = Math.max(1, ar / count);
  ag = Math.max(1, ag / count);
  ab = Math.max(1, ab / count);
  if (amount < 0) {
    const a = (-amount / 100) * 0.8;
    for (let k = 0; k < n * 4; k += 4) {
      out[k] = d[k] + (ar - d[k]) * a;
      out[k + 1] = d[k + 1] + (ag - d[k + 1]) * a;
      out[k + 2] = d[k + 2] + (ab - d[k + 2]) * a;
    }
    return out;
  }
  for (let i = 0, k = 0; i < n; i++, k += 4) dark[i] = Math.min(d[k] / ar, d[k + 1] / ag, d[k + 2] / ab);
  // smoothing the patch minimum stands in for the paper's matting step: it removes the blocky halos
  const haze = blurChannel(minChannel(dark, w, h, patch), w, h, patch * 2);
  const omega = (amount / 100) * 0.95;
  for (let i = 0, k = 0; i < n; i++, k += 4) {
    // never trust the smoothed estimate beyond what this pixel itself allows
    const t = Math.max(0.12, 1 - omega * Math.min(haze[i], dark[i] + 0.15));
    out[k] = clamp255((d[k] - ar) / t + ar);
    out[k + 1] = clamp255((d[k + 1] - ag) / t + ag);
    out[k + 2] = clamp255((d[k + 2] - ab) / t + ab);
  }
  return out;
}

function hash2(x: number, y: number, seed: number): number {
  let hsh = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1274126177);
  hsh = Math.imul(hsh ^ (hsh >>> 13), 1274126177);
  return ((hsh ^ (hsh >>> 16)) >>> 0) / 4294967295;
}

/**
 * Film grain: luminance noise that is strongest in the midtones, as in a photographic
 * emulsion. The pattern depends only on the position in the document, so it does not
 * crawl when the layer is redrawn. amount 0–100, size 1–10 (px), roughness 0–100.
 */
export function grain(px: Pixels, amount: number, size: number, roughness: number, scale = 1): Uint8ClampedArray {
  const { width: w, height: h, data: d } = px;
  const out = new Uint8ClampedArray(d);
  if (amount <= 0) return out;
  const cell = Math.max(0.5, size * scale);
  const rough = Math.min(1, Math.max(0, roughness / 100));
  const strength = (amount / 100) * 90;
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const value = (x: number, y: number, seed: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const u = smooth(x - xi);
    const v = smooth(y - yi);
    const a = hash2(xi, yi, seed);
    const b = hash2(xi + 1, yi, seed);
    const c = hash2(xi, yi + 1, seed);
    const e = hash2(xi + 1, yi + 1, seed);
    return a + (b - a) * u + (c - a + (a - b - c + e) * u) * v;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      // soft clumps, plus single-pixel speckle for a rougher stock
      const clump = value(x / cell, y / cell, 1) + value(x / (cell * 0.5), y / (cell * 0.5), 2) * 0.5 - 0.75;
      const speck = hash2(Math.floor(x / Math.max(1, scale)), Math.floor(y / Math.max(1, scale)), 3) - 0.5;
      const noise = (clump * (1 - rough) * 1.3 + speck * rough) * strength;
      const l = (0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]) / 255;
      const mid = 0.35 + 0.65 * (1 - (2 * l - 1) ** 2);
      const delta = noise * mid;
      out[k] = clamp255(d[k] + delta);
      out[k + 1] = clamp255(d[k + 1] + delta);
      out[k + 2] = clamp255(d[k + 2] + delta);
    }
  }
  return out;
}

// ── 3D LUTs ───────────────────────────────────────────────────────────────

export interface Lut3D {
  name: string;
  /** points per axis */
  size: number;
  /** size³ × 3 output values 0–1; red changes fastest, then green, then blue (the .cube order) */
  table: Float32Array;
}

/** Reads an Adobe / Resolve .cube file (3D LUTs; DOMAIN_MIN / DOMAIN_MAX are honoured by rescaling the output). */
export function parseCube(text: string, fallbackName = 'LUT'): Lut3D {
  let size = 0;
  let name = fallbackName;
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith('TITLE')) {
      name = line.slice(5).trim().replace(/^"(.*)"$/, '$1') || fallbackName;
    } else if (upper.startsWith('LUT_3D_SIZE')) {
      size = parseInt(line.split(/\s+/)[1], 10);
    } else if (upper.startsWith('LUT_1D_SIZE')) {
      throw new Error('This is a 1D LUT. File Editor applies 3D LUTs (.cube files with LUT_3D_SIZE).');
    } else if (/^[-+.\d]/.test(line)) {
      const p = line.split(/\s+/).map(Number);
      if (p.length >= 3 && p.every(Number.isFinite)) values.push(p[0], p[1], p[2]);
    }
  }
  if (!(size >= 2 && size <= 256)) throw new Error('This is not a .cube LUT file (LUT_3D_SIZE is missing).');
  if (values.length !== size ** 3 * 3) throw new Error(`The LUT file is incomplete: it should have ${size ** 3} colour rows but has ${values.length / 3}.`);
  return { name, size, table: Float32Array.from(values) };
}

/** Builds a LUT from a colour function (inputs and outputs 0–1). */
export function makeLut(name: string, size: number, fn: (r: number, g: number, b: number) => [number, number, number]): Lut3D {
  const table = new Float32Array(size ** 3 * 3);
  let i = 0;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const o = fn(r / (size - 1), g / (size - 1), b / (size - 1));
    table[i++] = o[0];
    table[i++] = o[1];
    table[i++] = o[2];
  }
  return { name, size, table };
}

const lumaOf = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const sCurve = (v: number, k: number) => mix(v, v * v * (3 - 2 * v), k);

/** Built-in looks, generated rather than shipped as files. */
const PRESETS: { id: string; label: string; build: () => Lut3D }[] = [
  {
    id: 'tealOrange',
    label: 'Teal & Orange',
    build: () =>
      makeLut('Teal & Orange', 17, (r, g, b) => {
        const l = lumaOf(r, g, b);
        // shadows lean teal, highlights lean orange
        const t = sCurve(l, 1);
        return [sCurve(r + mix(-0.06, 0.07, t), 0.4), sCurve(g + mix(0.02, 0.01, t), 0.4), sCurve(b + mix(0.08, -0.08, t), 0.4)];
      }),
  },
  {
    id: 'warmFilm',
    label: 'Warm film',
    build: () => makeLut('Warm film', 17, (r, g, b) => [mix(0.04, 1, sCurve(r, 0.5)) * 1.03, mix(0.03, 0.98, sCurve(g, 0.5)), mix(0.05, 0.9, sCurve(b, 0.3))]),
  },
  {
    id: 'coolFade',
    label: 'Cool fade',
    build: () => makeLut('Cool fade', 17, (r, g, b) => [mix(0.07, 0.93, r), mix(0.09, 0.96, g), mix(0.13, 1, b)]),
  },
  {
    id: 'bleach',
    label: 'Bleach bypass',
    build: () =>
      makeLut('Bleach bypass', 17, (r, g, b) => {
        const l = lumaOf(r, g, b);
        return [sCurve(mix(r, l, 0.55), 1), sCurve(mix(g, l, 0.55), 1), sCurve(mix(b, l, 0.55), 1)];
      }),
  },
  {
    id: 'noir',
    label: 'Noir (high-contrast B&W)',
    build: () =>
      makeLut('Noir', 17, (r, g, b) => {
        const l = sCurve(sCurve(0.45 * r + 0.45 * g + 0.1 * b, 1), 0.6);
        return [l, l, l];
      }),
  },
];

/** The built-in looks; each table is named after its label, which is how a layer's look is recognised. */
export const LUT_PRESETS = PRESETS.map((p) => ({ ...p, build: (): Lut3D => ({ ...p.build(), name: p.label }) }));

/** Maps every pixel through the LUT (trilinear between table points). strength 0–100 blends with the original. */
export function applyLut(px: Pixels, lut: Lut3D, strength = 100): Uint8ClampedArray {
  const d = px.data;
  const out = new Uint8ClampedArray(d);
  const N = lut.size;
  const t = lut.table;
  const k = (N - 1) / 255;
  const s = Math.min(1, Math.max(0, strength / 100));
  if (s === 0) return out;
  for (let i = 0; i < d.length; i += 4) {
    const rf = d[i] * k;
    const gf = d[i + 1] * k;
    const bf = d[i + 2] * k;
    const r0 = Math.min(N - 2, Math.floor(rf));
    const g0 = Math.min(N - 2, Math.floor(gf));
    const b0 = Math.min(N - 2, Math.floor(bf));
    const fr = rf - r0;
    const fg = gf - g0;
    const fb = bf - b0;
    const base = (r0 + g0 * N + b0 * N * N) * 3;
    const dg = N * 3;
    const db = N * N * 3;
    for (let c = 0; c < 3; c++) {
      const c000 = t[base + c];
      const c100 = t[base + 3 + c];
      const c010 = t[base + dg + c];
      const c110 = t[base + dg + 3 + c];
      const c001 = t[base + db + c];
      const c101 = t[base + db + 3 + c];
      const c011 = t[base + db + dg + c];
      const c111 = t[base + db + dg + 3 + c];
      const v = mix(mix(mix(c000, c100, fr), mix(c010, c110, fr), fg), mix(mix(c001, c101, fr), mix(c011, c111, fr), fg), fb) * 255;
      out[i + c] = clamp255(d[i + c] + (v - d[i + c]) * s);
    }
  }
  return out;
}
