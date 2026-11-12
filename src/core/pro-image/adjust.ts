/**
 * Adjustment-layer maths for the pro photo editor (desktop): Curves, Levels, Hue/Saturation,
 * Color Balance, Black & White, Exposure, Brightness/Contrast, Vibrance, Invert, Threshold,
 * Posterize, Photo Filter. Pure functions on RGBA buffers (no DOM), applied in place.
 * `mask` (0–255 per pixel, optional) blends the result with the original, as a layer mask
 * or selection does.
 */
import type { Pixels } from '../media/image-ops';

export type CurvePoint = [number, number];

export interface CurvesSpec {
  type: 'curves';
  /** control points (0–255) for the composite and per channel; at least two points each */
  rgb: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
}
export interface LevelsSpec {
  type: 'levels';
  inBlack: number;
  inWhite: number;
  /** midtone gamma, 0.1–9.99 (1 = none) */
  gamma: number;
  outBlack: number;
  outWhite: number;
}
export interface HueSatSpec {
  type: 'hueSat';
  /** -180..180 */
  hue: number;
  /** -100..100 */
  saturation: number;
  /** -100..100 */
  lightness: number;
  colorize: boolean;
}
export interface ColorBalanceSpec {
  type: 'colorBalance';
  /** per tonal range: [cyan↔red, magenta↔green, yellow↔blue], each -100..100 */
  shadows: [number, number, number];
  midtones: [number, number, number];
  highlights: [number, number, number];
  preserveLuminosity: boolean;
}
export interface BlackWhiteSpec {
  type: 'blackWhite';
  /** channel weights in % (Photoshop's default: reds 40, greens 60… simplified to RGB) */
  red: number;
  green: number;
  blue: number;
  /** optional tint as "#rrggbb", or null */
  tint: string | null;
}
export interface ExposureSpec {
  type: 'exposure';
  /** stops, -5..5 */
  exposure: number;
  /** -0.5..0.5 */
  offset: number;
  /** 0.1..9.99 */
  gamma: number;
}
export interface BrightnessContrastSpec {
  type: 'brightnessContrast';
  /** -150..150 */
  brightness: number;
  /** -50..100 */
  contrast: number;
}
export interface VibranceSpec {
  type: 'vibrance';
  /** -100..100 */
  vibrance: number;
  /** -100..100 */
  saturation: number;
}
export interface InvertSpec {
  type: 'invert';
}
export interface ThresholdSpec {
  type: 'threshold';
  level: number;
}
export interface PosterizeSpec {
  type: 'posterize';
  levels: number;
}
export interface PhotoFilterSpec {
  type: 'photoFilter';
  color: string;
  /** 0..100 */
  density: number;
}

export type AdjustSpec =
  | CurvesSpec
  | LevelsSpec
  | HueSatSpec
  | ColorBalanceSpec
  | BlackWhiteSpec
  | ExposureSpec
  | BrightnessContrastSpec
  | VibranceSpec
  | InvertSpec
  | ThresholdSpec
  | PosterizeSpec
  | PhotoFilterSpec;

export type AdjustType = AdjustSpec['type'];

export const ADJUST_LABELS: Record<AdjustType, string> = {
  curves: 'Curves',
  levels: 'Levels',
  hueSat: 'Hue/Saturation',
  colorBalance: 'Color Balance',
  blackWhite: 'Black & White',
  exposure: 'Exposure',
  brightnessContrast: 'Brightness/Contrast',
  vibrance: 'Vibrance',
  invert: 'Invert',
  threshold: 'Threshold',
  posterize: 'Posterize',
  photoFilter: 'Photo Filter',
};

export function defaultAdjust(type: AdjustType): AdjustSpec {
  const line: CurvePoint[] = [
    [0, 0],
    [255, 255],
  ];
  switch (type) {
    case 'curves':
      return { type, rgb: line, r: line, g: line, b: line };
    case 'levels':
      return { type, inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };
    case 'hueSat':
      return { type, hue: 0, saturation: 0, lightness: 0, colorize: false };
    case 'colorBalance':
      return { type, shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true };
    case 'blackWhite':
      return { type, red: 30, green: 59, blue: 11, tint: null };
    case 'exposure':
      return { type, exposure: 0, offset: 0, gamma: 1 };
    case 'brightnessContrast':
      return { type, brightness: 0, contrast: 0 };
    case 'vibrance':
      return { type, vibrance: 0, saturation: 0 };
    case 'invert':
      return { type };
    case 'threshold':
      return { type, level: 128 };
    case 'posterize':
      return { type, levels: 4 };
    case 'photoFilter':
      return { type, color: '#ec8a00', density: 25 };
  }
}

const clamp = (v: number, lo = 0, hi = 255) => (v < lo ? lo : v > hi ? hi : v);

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 256-entry lookup table through the points, with a monotone cubic (Fritsch–Carlson) spline,
 * so the curve never overshoots between points the way a plain cubic spline can.
 */
export function curveLut(points: CurvePoint[]): Uint8ClampedArray {
  const pts = [...points].map(([x, y]) => [clamp(x), clamp(y)] as CurvePoint).sort((a, b) => a[0] - b[0]);
  const dedup: CurvePoint[] = [];
  for (const p of pts) if (!dedup.length || dedup[dedup.length - 1][0] !== p[0]) dedup.push(p);
  const lut = new Uint8ClampedArray(256);
  if (dedup.length === 0) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }
  if (dedup.length === 1) return lut.fill(dedup[0][1]);
  const n = dedup.length;
  const xs = dedup.map((p) => p[0]);
  const ys = dedup.map((p) => p[1]);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  for (let x = 0; x < 256; x++) {
    if (x <= xs[0]) {
      lut[x] = ys[0];
      continue;
    }
    if (x >= xs[n - 1]) {
      lut[x] = ys[n - 1];
      continue;
    }
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    lut[x] = clamp(Math.round(y));
  }
  return lut;
}

export function levelsLut(s: Pick<LevelsSpec, 'inBlack' | 'inWhite' | 'gamma' | 'outBlack' | 'outWhite'>): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const lo = clamp(s.inBlack);
  const hi = Math.max(lo + 1, clamp(s.inWhite));
  const g = Math.max(0.01, s.gamma);
  for (let i = 0; i < 256; i++) {
    const t = clamp((i - lo) / (hi - lo), 0, 1);
    lut[i] = Math.round(s.outBlack + Math.pow(t, 1 / g) * (s.outWhite - s.outBlack));
  }
  return lut;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  return [h, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Applies an adjustment in place. `mask` (w*h, 0–255) limits where it applies. */
export function applyAdjust(px: Pixels, spec: AdjustSpec, mask?: Uint8Array | null): Pixels {
  const d = px.data;
  const n = px.width * px.height;
  const fn = pixelFn(spec);
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    if (d[k + 3] === 0) continue;
    const m = mask ? mask[i] : 255;
    if (m === 0) continue;
    const r = d[k];
    const g = d[k + 1];
    const b = d[k + 2];
    const out = fn(r, g, b);
    if (m === 255) {
      d[k] = out[0];
      d[k + 1] = out[1];
      d[k + 2] = out[2];
    } else {
      const a = m / 255;
      d[k] = r + (out[0] - r) * a;
      d[k + 1] = g + (out[1] - g) * a;
      d[k + 2] = b + (out[2] - b) * a;
    }
  }
  return px;
}

type PixelFn = (r: number, g: number, b: number) => [number, number, number];

function pixelFn(spec: AdjustSpec): PixelFn {
  switch (spec.type) {
    case 'curves': {
      const all = curveLut(spec.rgb);
      const lr = curveLut(spec.r);
      const lg = curveLut(spec.g);
      const lb = curveLut(spec.b);
      return (r, g, b) => [lr[all[r]], lg[all[g]], lb[all[b]]];
    }
    case 'levels': {
      const lut = levelsLut(spec);
      return (r, g, b) => [lut[r], lut[g], lut[b]];
    }
    case 'hueSat': {
      const dh = spec.hue / 360;
      const s = spec.saturation / 100;
      const l = spec.lightness / 100;
      return (r, g, b) => {
        let [h, sat, li] = rgbToHsl(r, g, b);
        if (spec.colorize) {
          h = (((spec.hue + 360) % 360) / 360);
          sat = Math.max(0, Math.min(1, 0.25 + s * 0.75));
        } else {
          h = (h + dh + 1) % 1;
          sat = s >= 0 ? sat + (1 - sat) * s * sat : sat * (1 + s);
        }
        li = l >= 0 ? li + (1 - li) * l : li * (1 + l);
        const o = hslToRgb(h, Math.max(0, Math.min(1, sat)), Math.max(0, Math.min(1, li)));
        return [clamp(o[0]), clamp(o[1]), clamp(o[2])];
      };
    }
    case 'colorBalance': {
      // weights per tonal range peak in shadows / midtones / highlights
      return (r, g, b) => {
        const L = luma(r, g, b) / 255;
        const ws = Math.max(0, 1 - L * 2.5);
        const wh = Math.max(0, L * 2.5 - 1.5);
        const wm = Math.max(0, 1 - Math.abs(L - 0.5) * 3);
        const shift = [0, 1, 2].map((c) => (spec.shadows[c] * ws + spec.midtones[c] * wm + spec.highlights[c] * wh) * 0.6);
        let o: [number, number, number] = [clamp(r + shift[0]), clamp(g + shift[1]), clamp(b + shift[2])];
        if (spec.preserveLuminosity) {
          const before = luma(r, g, b);
          const after = luma(o[0], o[1], o[2]) || 1;
          const k = before / after;
          o = [clamp(o[0] * k), clamp(o[1] * k), clamp(o[2] * k)];
        }
        return o;
      };
    }
    case 'blackWhite': {
      const sum = spec.red + spec.green + spec.blue || 1;
      const wr = spec.red / sum;
      const wg = spec.green / sum;
      const wb = spec.blue / sum;
      const tint = spec.tint ? hexToRgb(spec.tint) : null;
      return (r, g, b) => {
        const y = clamp(r * wr + g * wg + b * wb);
        if (!tint) return [y, y, y];
        const t = y / 255;
        // multiply-style tint that keeps whites white
        return [clamp(y * (1 - t) * (tint[0] / 255) + y * t), clamp(y * (1 - t) * (tint[1] / 255) + y * t), clamp(y * (1 - t) * (tint[2] / 255) + y * t)];
      };
    }
    case 'exposure': {
      const lut = new Uint8ClampedArray(256);
      const k = Math.pow(2, spec.exposure);
      for (let i = 0; i < 256; i++) {
        const v = Math.max(0, (i / 255) * k + spec.offset);
        lut[i] = clamp(Math.round(Math.pow(v, 1 / Math.max(0.01, spec.gamma)) * 255));
      }
      return (r, g, b) => [lut[r], lut[g], lut[b]];
    }
    case 'brightnessContrast': {
      const lut = new Uint8ClampedArray(256);
      const c = spec.contrast / 100;
      const f = c >= 0 ? 1 + c * 2 : 1 + c;
      for (let i = 0; i < 256; i++) lut[i] = clamp(Math.round((i + spec.brightness * 0.5 - 128) * f + 128));
      return (r, g, b) => [lut[r], lut[g], lut[b]];
    }
    case 'vibrance': {
      const v = spec.vibrance / 100;
      const s = spec.saturation / 100;
      return (r, g, b) => {
        const y = luma(r, g, b);
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = (max - min) / 255;
        // vibrance boosts muted colours more than saturated ones
        const k = 1 + s + v * (1 - sat);
        return [clamp(y + (r - y) * k), clamp(y + (g - y) * k), clamp(y + (b - y) * k)];
      };
    }
    case 'invert':
      return (r, g, b) => [255 - r, 255 - g, 255 - b];
    case 'threshold': {
      const t = spec.level;
      return (r, g, b) => {
        const v = luma(r, g, b) >= t ? 255 : 0;
        return [v, v, v];
      };
    }
    case 'posterize': {
      const lv = Math.max(2, Math.min(255, Math.round(spec.levels)));
      const lut = new Uint8ClampedArray(256);
      for (let i = 0; i < 256; i++) lut[i] = Math.round(Math.round((i / 255) * (lv - 1)) * (255 / (lv - 1)));
      return (r, g, b) => [lut[r], lut[g], lut[b]];
    }
    case 'photoFilter': {
      const [fr, fg, fb] = hexToRgb(spec.color);
      const a = spec.density / 100;
      return (r, g, b) => {
        const y = luma(r, g, b);
        const mr = (r * fr) / 255;
        const mg = (g * fg) / 255;
        const mb = (b * fb) / 255;
        // keep luminosity after the colour multiply
        const k = y / (luma(mr, mg, mb) || 1);
        return [clamp(r + (mr * k - r) * a), clamp(g + (mg * k - g) * a), clamp(b + (mb * k - b) * a)];
      };
    }
  }
}

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  /** luminosity */
  l: Uint32Array;
}

export function histogram(px: Pixels, mask?: Uint8Array | null): Histogram {
  const h: Histogram = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256) };
  const d = px.data;
  for (let i = 0, n = px.width * px.height; i < n; i++) {
    const k = i * 4;
    if (d[k + 3] === 0 || (mask && mask[i] < 128)) continue;
    h.r[d[k]]++;
    h.g[d[k + 1]]++;
    h.b[d[k + 2]]++;
    h.l[Math.round(luma(d[k], d[k + 1], d[k + 2]))]++;
  }
  return h;
}

/** Auto Levels: clip `clip` (fraction) of the darkest and brightest pixels. */
export function autoLevels(h: Histogram, clip = 0.001): Pick<LevelsSpec, 'inBlack' | 'inWhite'> {
  let total = 0;
  for (let i = 0; i < 256; i++) total += h.l[i];
  const target = total * clip;
  let acc = 0;
  let lo = 0;
  for (; lo < 255; lo++) {
    acc += h.l[lo];
    if (acc > target) break;
  }
  acc = 0;
  let hi = 255;
  for (; hi > 0; hi--) {
    acc += h.l[hi];
    if (acc > target) break;
  }
  return hi - lo < 8 ? { inBlack: 0, inWhite: 255 } : { inBlack: lo, inWhite: hi };
}
