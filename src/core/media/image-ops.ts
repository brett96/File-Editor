/**
 * Pure pixel operations on RGBA buffers. No DOM, no canvas: these run in the browser, in a
 * worker and under Node (tests), and they are used both for still images and per video frame.
 */

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export function createPixels(width: number, height: number): Pixels {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

export interface Adjustments {
  /** -100..100 */
  brightness: number;
  /** -100..100 */
  contrast: number;
  /** -100..100 (−100 = greyscale) */
  saturation: number;
  /** -180..180 degrees */
  hue: number;
  /** -100..100 (stops ×0.02 — gentle exposure curve) */
  exposure: number;
  /** -100..100 (negative = cooler, positive = warmer) */
  warmth: number;
  /** -100..100 lifts / crushes shadows */
  shadows: number;
  /** -100..100 recovers / boosts highlights */
  highlights: number;
  /** 0..100 */
  vignette: number;
}

export const NO_ADJUSTMENTS: Adjustments = {
  brightness: 0, contrast: 0, saturation: 0, hue: 0, exposure: 0, warmth: 0, shadows: 0, highlights: 0, vignette: 0,
};

export function isIdentity(a: Adjustments): boolean {
  return (Object.keys(NO_ADJUSTMENTS) as (keyof Adjustments)[]).every((k) => a[k] === 0);
}

export type FilterPreset = 'none' | 'grayscale' | 'sepia' | 'invert' | 'vintage' | 'cool' | 'warm' | 'dramatic' | 'fade' | 'noir';

export const FILTER_LABELS: Record<FilterPreset, string> = {
  none: 'Original', grayscale: 'Black & white', sepia: 'Sepia', invert: 'Invert', vintage: 'Vintage',
  cool: 'Cool', warm: 'Warm', dramatic: 'Dramatic', fade: 'Faded', noir: 'Noir',
};

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Builds a 256-entry tone curve from brightness / contrast / exposure / shadows / highlights.
 * Using a LUT keeps per-pixel cost to three lookups for the tonal part.
 */
function toneCurve(a: Adjustments): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const expo = Math.pow(2, a.exposure / 50); // ±2 stops at the extremes
  const c = a.contrast / 100;
  const contrastF = c >= 0 ? 1 + c * 2 : 1 + c; // 0..3
  const bright = (a.brightness / 100) * 0.4;
  for (let i = 0; i < 256; i++) {
    let v = i / 255;
    v *= expo;
    v += bright;
    v = (v - 0.5) * contrastF + 0.5;
    // shadows: lift/crush the low end with a smooth weight that fades out by mid-grey
    const sw = Math.max(0, 1 - v * 2);
    v += (a.shadows / 100) * 0.35 * sw * sw;
    // highlights: pull down / push up the top end
    const hw = Math.max(0, v * 2 - 1);
    v += (a.highlights / 100) * 0.35 * hw * hw;
    lut[i] = clamp255(Math.round(v * 255));
  }
  return lut;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
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
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}

/** Applies colour/tone adjustments in place. */
export function applyAdjustments(px: Pixels, a: Adjustments): Pixels {
  if (isIdentity(a)) return px;
  const lut = toneCurve(a);
  const sat = 1 + a.saturation / 100;
  const hueShift = a.hue / 360;
  const warm = a.warmth / 100;
  const doHsl = hueShift !== 0;
  const { data, width, height } = px;
  const cx = width / 2;
  const cy = height / 2;
  const maxD = Math.hypot(cx, cy) || 1;
  const vig = a.vignette / 100;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let r = lut[data[i]];
      let g = lut[data[i + 1]];
      let b = lut[data[i + 2]];
      if (warm !== 0) {
        r += warm * 25;
        b -= warm * 25;
      }
      if (sat !== 1) {
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = lum + (r - lum) * sat;
        g = lum + (g - lum) * sat;
        b = lum + (b - lum) * sat;
      }
      if (doHsl) {
        const [h, s, l] = rgbToHsl(clamp255(r) / 255, clamp255(g) / 255, clamp255(b) / 255);
        const [nr, ng, nb] = hslToRgb((h + hueShift + 1) % 1, s, l);
        r = nr * 255;
        g = ng * 255;
        b = nb * 255;
      }
      if (vig > 0) {
        const d = Math.hypot(x - cx, y - cy) / maxD;
        const f = 1 - vig * Math.pow(Math.max(0, d - 0.35) / 0.65, 2);
        r *= f;
        g *= f;
        b *= f;
      }
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
  return px;
}

/** Applies a one-click look in place. */
export function applyFilter(px: Pixels, f: FilterPreset): Pixels {
  const { data } = px;
  switch (f) {
    case 'none':
      return px;
    case 'grayscale':
    case 'noir':
      for (let i = 0; i < data.length; i += 4) {
        const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        data[i] = data[i + 1] = data[i + 2] = l;
      }
      return f === 'noir' ? applyAdjustments(px, { ...NO_ADJUSTMENTS, contrast: 45, shadows: -25, vignette: 40 }) : px;
    case 'sepia':
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        data[i] = 0.393 * r + 0.769 * g + 0.189 * b;
        data[i + 1] = 0.349 * r + 0.686 * g + 0.168 * b;
        data[i + 2] = 0.272 * r + 0.534 * g + 0.131 * b;
      }
      return px;
    case 'invert':
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 255 - data[i];
        data[i + 1] = 255 - data[i + 1];
        data[i + 2] = 255 - data[i + 2];
      }
      return px;
    case 'vintage':
      applyFilter(px, 'sepia');
      return applyAdjustments(px, { ...NO_ADJUSTMENTS, contrast: -15, saturation: -10, vignette: 45, shadows: 20 });
    case 'cool':
      return applyAdjustments(px, { ...NO_ADJUSTMENTS, warmth: -45, saturation: 5 });
    case 'warm':
      return applyAdjustments(px, { ...NO_ADJUSTMENTS, warmth: 45, saturation: 10 });
    case 'dramatic':
      return applyAdjustments(px, { ...NO_ADJUSTMENTS, contrast: 40, saturation: 20, shadows: -15, vignette: 35 });
    case 'fade':
      return applyAdjustments(px, { ...NO_ADJUSTMENTS, contrast: -35, saturation: -30, shadows: 35, brightness: 5 });
  }
}

/** Separable box blur (three passes ≈ Gaussian). Radius in pixels. */
export function blur(px: Pixels, radius: number, rect?: Rect): Pixels {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return px;
  const area = clampRect(rect ?? { x: 0, y: 0, width: px.width, height: px.height }, px);
  if (area.width <= 0 || area.height <= 0) return px;
  for (let pass = 0; pass < 3; pass++) {
    boxBlurH(px, r, area);
    boxBlurV(px, r, area);
  }
  return px;
}

function boxBlurH(px: Pixels, r: number, a: Rect) {
  const { data, width } = px;
  const row = new Float32Array(a.width * 4);
  for (let y = a.y; y < a.y + a.height; y++) {
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      // seed window [-r, r] around x = a.x, clamping at the area edges
      for (let k = -r; k <= r; k++) {
        const xx = Math.min(a.x + a.width - 1, Math.max(a.x, a.x + k));
        acc += data[(y * width + xx) * 4 + c];
      }
      for (let x = 0; x < a.width; x++) {
        row[x * 4 + c] = acc / (2 * r + 1);
        const outX = Math.max(a.x, a.x + x - r);
        const inX = Math.min(a.x + a.width - 1, a.x + x + r + 1);
        acc += data[(y * width + inX) * 4 + c] - data[(y * width + outX) * 4 + c];
      }
    }
    for (let x = 0; x < a.width; x++) {
      const o = (y * width + a.x + x) * 4;
      data[o] = row[x * 4];
      data[o + 1] = row[x * 4 + 1];
      data[o + 2] = row[x * 4 + 2];
      data[o + 3] = row[x * 4 + 3];
    }
  }
}

function boxBlurV(px: Pixels, r: number, a: Rect) {
  const { data, width } = px;
  const col = new Float32Array(a.height * 4);
  for (let x = a.x; x < a.x + a.width; x++) {
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(a.y + a.height - 1, Math.max(a.y, a.y + k));
        acc += data[(yy * width + x) * 4 + c];
      }
      for (let y = 0; y < a.height; y++) {
        col[y * 4 + c] = acc / (2 * r + 1);
        const outY = Math.max(a.y, a.y + y - r);
        const inY = Math.min(a.y + a.height - 1, a.y + y + r + 1);
        acc += data[(inY * width + x) * 4 + c] - data[(outY * width + x) * 4 + c];
      }
    }
    for (let y = 0; y < a.height; y++) {
      const o = ((a.y + y) * width + x) * 4;
      data[o] = col[y * 4];
      data[o + 1] = col[y * 4 + 1];
      data[o + 2] = col[y * 4 + 2];
      data[o + 3] = col[y * 4 + 3];
    }
  }
}

/** Unsharp mask: amount 0..100. */
export function sharpen(px: Pixels, amount: number): Pixels {
  if (amount <= 0) return px;
  const blurred: Pixels = { data: new Uint8ClampedArray(px.data), width: px.width, height: px.height };
  blur(blurred, 1);
  const k = (amount / 100) * 1.5;
  const { data } = px;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i] + (data[i] - blurred.data[i]) * k;
    data[i + 1] = data[i + 1] + (data[i + 1] - blurred.data[i + 1]) * k;
    data[i + 2] = data[i + 2] + (data[i + 2] - blurred.data[i + 2]) * k;
  }
  return px;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function clampRect(r: Rect, px: { width: number; height: number }): Rect {
  const x0 = Math.max(0, Math.min(px.width, Math.floor(Math.min(r.x, r.x + r.width))));
  const y0 = Math.max(0, Math.min(px.height, Math.floor(Math.min(r.y, r.y + r.height))));
  const x1 = Math.max(0, Math.min(px.width, Math.ceil(Math.max(r.x, r.x + r.width))));
  const y1 = Math.max(0, Math.min(px.height, Math.ceil(Math.max(r.y, r.y + r.height))));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Pixelates a region irreversibly (each block becomes its average colour). Used for the
 * "Redact" tool; with a block size ≥ 12 px faces and text are unrecoverable, unlike a blur.
 */
export function pixelate(px: Pixels, rect: Rect, block: number): Pixels {
  const a = clampRect(rect, px);
  const b = Math.max(2, Math.round(block));
  const { data, width } = px;
  for (let by = a.y; by < a.y + a.height; by += b) {
    for (let bx = a.x; bx < a.x + a.width; bx += b) {
      const ex = Math.min(a.x + a.width, bx + b);
      const ey = Math.min(a.y + a.height, by + b);
      let r = 0, g = 0, bl = 0, al = 0, n = 0;
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const i = (y * width + x) * 4;
          r += data[i]; g += data[i + 1]; bl += data[i + 2]; al += data[i + 3]; n++;
        }
      }
      r /= n; g /= n; bl /= n; al /= n;
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const i = (y * width + x) * 4;
          data[i] = r; data[i + 1] = g; data[i + 2] = bl; data[i + 3] = al;
        }
      }
    }
  }
  return px;
}

export function crop(px: Pixels, rect: Rect): Pixels {
  const a = clampRect(rect, px);
  const out = createPixels(Math.max(1, a.width), Math.max(1, a.height));
  for (let y = 0; y < a.height; y++) {
    const src = ((a.y + y) * px.width + a.x) * 4;
    out.data.set(px.data.subarray(src, src + a.width * 4), y * a.width * 4);
  }
  return out;
}

/** Rotates by a multiple of 90° clockwise. */
export function rotate90(px: Pixels, turns: number): Pixels {
  const t = ((Math.round(turns) % 4) + 4) % 4;
  if (t === 0) return { data: new Uint8ClampedArray(px.data), width: px.width, height: px.height };
  const { width: w, height: h, data } = px;
  const out = t === 2 ? createPixels(w, h) : createPixels(h, w);
  const ow = out.width;
  const s32 = new Uint32Array(data.buffer, data.byteOffset, w * h);
  const d32 = new Uint32Array(out.data.buffer, out.data.byteOffset, ow * out.height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number, ny: number;
      if (t === 1) [nx, ny] = [h - 1 - y, x];
      else if (t === 2) [nx, ny] = [w - 1 - x, h - 1 - y];
      else [nx, ny] = [y, w - 1 - x];
      d32[ny * ow + nx] = s32[y * w + x];
    }
  }
  return out;
}

export function flip(px: Pixels, axis: 'horizontal' | 'vertical'): Pixels {
  const { width: w, height: h, data } = px;
  const out = createPixels(w, h);
  const s32 = new Uint32Array(data.buffer, data.byteOffset, w * h);
  const d32 = new Uint32Array(out.data.buffer, out.data.byteOffset, w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = axis === 'horizontal' ? y * w + (w - 1 - x) : (h - 1 - y) * w + x;
      d32[y * w + x] = s32[src];
    }
  }
  return out;
}

/** Composites onto an opaque background (for formats without alpha). */
export function flatten(px: Pixels, background: [number, number, number]): Pixels {
  const out = createPixels(px.width, px.height);
  const { data } = px;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    out.data[i] = data[i] * a + background[0] * (1 - a);
    out.data[i + 1] = data[i + 1] * a + background[1] * (1 - a);
    out.data[i + 2] = data[i + 2] * a + background[2] * (1 - a);
    out.data[i + 3] = 255;
  }
  return out;
}

export function hasTransparency(px: Pixels): boolean {
  for (let i = 3; i < px.data.length; i += 4) if (px.data[i] < 255) return true;
  return false;
}

/** Bilinear resize; for large downscales use the canvas path, which is higher quality. */
export function resizeBilinear(px: Pixels, width: number, height: number): Pixels {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const out = createPixels(w, h);
  const sx = px.width / w;
  const sy = px.height / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.floor(fy);
    const y1 = Math.min(px.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.floor(fx);
      const x1 = Math.min(px.width - 1, x0 + 1);
      const wx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = px.data[(y0 * px.width + x0) * 4 + c];
        const b = px.data[(y0 * px.width + x1) * 4 + c];
        const d = px.data[(y1 * px.width + x0) * 4 + c];
        const e = px.data[(y1 * px.width + x1) * 4 + c];
        out.data[(y * w + x) * 4 + c] = (a * (1 - wx) + b * wx) * (1 - wy) + (d * (1 - wx) + e * wx) * wy;
      }
    }
  }
  return out;
}
