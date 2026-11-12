/**
 * Filters for the pro photo editor (Filter menu): Gaussian Blur, Unsharp Mask, Add Noise,
 * Median (Reduce Noise / Despeckle), Motion Blur, Emboss, Find Edges, plus Spot Healing
 * (inpaint a masked area from its surroundings). Pure functions on RGBA buffers; each returns
 * a new buffer and, given a mask, blends the result in only where the mask is set.
 */
import type { Pixels } from '../media/image-ops';
import type { Mask } from './selection';

export type FilterId = 'gaussianBlur' | 'unsharpMask' | 'addNoise' | 'median' | 'motionBlur' | 'emboss' | 'findEdges';

export const FILTER_DEFS: Record<FilterId, { label: string; params: { key: string; label: string; min: number; max: number; step?: number; def: number }[] }> = {
  gaussianBlur: { label: 'Gaussian Blur…', params: [{ key: 'radius', label: 'Radius (px)', min: 0.5, max: 100, step: 0.5, def: 4 }] },
  unsharpMask: {
    label: 'Unsharp Mask…',
    params: [
      { key: 'amount', label: 'Amount (%)', min: 1, max: 500, def: 100 },
      { key: 'radius', label: 'Radius (px)', min: 0.5, max: 50, step: 0.5, def: 1.5 },
      { key: 'threshold', label: 'Threshold (levels)', min: 0, max: 255, def: 2 },
    ],
  },
  addNoise: {
    label: 'Add Noise…',
    params: [
      { key: 'amount', label: 'Amount (%)', min: 1, max: 100, def: 10 },
      { key: 'mono', label: 'Monochromatic (0/1)', min: 0, max: 1, def: 1 },
    ],
  },
  median: { label: 'Reduce Noise (Median)…', params: [{ key: 'radius', label: 'Radius (px)', min: 1, max: 10, def: 1 }] },
  motionBlur: {
    label: 'Motion Blur…',
    params: [
      { key: 'angle', label: 'Angle (°)', min: -90, max: 90, def: 0 },
      { key: 'distance', label: 'Distance (px)', min: 1, max: 200, def: 20 },
    ],
  },
  emboss: { label: 'Emboss', params: [{ key: 'strength', label: 'Strength', min: 0.5, max: 5, step: 0.5, def: 1 }] },
  findEdges: { label: 'Find Edges', params: [] },
};

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

function copy(px: Pixels): Pixels {
  return { data: new Uint8ClampedArray(px.data), width: px.width, height: px.height };
}

/** Blend `out` back over `src` where the mask is partial/unset. Returns `out`. */
function masked(src: Pixels, out: Pixels, mask?: Mask | null): Pixels {
  if (!mask) return out;
  const a = src.data;
  const b = out.data;
  for (let i = 0, n = src.width * src.height; i < n; i++) {
    const m = mask.data[i];
    if (m === 255) continue;
    const k = i * 4;
    if (m === 0) {
      b[k] = a[k];
      b[k + 1] = a[k + 1];
      b[k + 2] = a[k + 2];
      b[k + 3] = a[k + 3];
    } else {
      const t = m / 255;
      for (let c = 0; c < 4; c++) b[k + c] = a[k + c] + (b[k + c] - a[k + c]) * t;
    }
  }
  return out;
}

/** Box blur of all four channels (premultiplied so transparent edges don't darken). */
function boxBlur(px: Pixels, r: number): Pixels {
  const { width: w, height: h } = px;
  const n = w * h;
  const src = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = px.data[i * 4 + 3] / 255;
    src[i * 4] = px.data[i * 4] * a;
    src[i * 4 + 1] = px.data[i * 4 + 1] * a;
    src[i * 4 + 2] = px.data[i * 4 + 2] * a;
    src[i * 4 + 3] = px.data[i * 4 + 3];
  }
  const tmp = new Float32Array(n * 4);
  const span = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[(y * w + Math.min(w - 1, Math.max(0, x))) * 4 + c];
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * 4 + c] = acc / span;
        acc += src[(y * w + Math.min(w - 1, x + r + 1)) * 4 + c] - src[(y * w + Math.max(0, x - r)) * 4 + c];
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[(Math.min(h - 1, Math.max(0, y)) * w + x) * 4 + c];
      for (let y = 0; y < h; y++) {
        src[(y * w + x) * 4 + c] = acc / span;
        acc += tmp[(Math.min(h - 1, y + r + 1) * w + x) * 4 + c] - tmp[(Math.max(0, y - r) * w + x) * 4 + c];
      }
    }
  }
  const out: Pixels = { data: new Uint8ClampedArray(n * 4), width: w, height: h };
  for (let i = 0; i < n; i++) {
    const a = src[i * 4 + 3];
    const k = a > 0 ? 255 / a : 0;
    out.data[i * 4] = src[i * 4] * k;
    out.data[i * 4 + 1] = src[i * 4 + 1] * k;
    out.data[i * 4 + 2] = src[i * 4 + 2] * k;
    out.data[i * 4 + 3] = a;
  }
  return out;
}

/** Gaussian blur approximated by three box blurs (σ ≈ radius / 2). */
export function gaussianBlur(px: Pixels, radius: number, mask?: Mask | null): Pixels {
  const sigma = Math.max(0.5, radius / 2);
  // box sizes for three passes (Kovesi)
  const wIdeal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const m = Math.round((12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4));
  let out = px;
  for (let i = 0; i < 3; i++) out = boxBlur(out, ((i < m ? wl : wl + 2) - 1) / 2);
  return masked(px, out === px ? copy(px) : out, mask);
}

export function unsharpMask(px: Pixels, amount: number, radius: number, threshold: number, mask?: Mask | null): Pixels {
  const blurred = gaussianBlur(px, radius);
  const out = copy(px);
  const k = amount / 100;
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const diff = px.data[i + c] - blurred.data[i + c];
      if (Math.abs(diff) >= threshold) out.data[i + c] = clamp(px.data[i + c] + diff * k);
    }
  }
  return masked(px, out, mask);
}

/** Deterministic noise (seeded), so the preview and the final render match. */
export function addNoise(px: Pixels, amount: number, mono: boolean, mask?: Mask | null, seed = 1): Pixels {
  const out = copy(px);
  let s = seed >>> 0 || 1;
  const rand = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
  const a = (amount / 100) * 128;
  for (let i = 0; i < out.data.length; i += 4) {
    if (mono) {
      const n = rand() * a;
      out.data[i] = clamp(px.data[i] + n);
      out.data[i + 1] = clamp(px.data[i + 1] + n);
      out.data[i + 2] = clamp(px.data[i + 2] + n);
    } else {
      for (let c = 0; c < 3; c++) out.data[i + c] = clamp(px.data[i + c] + rand() * a);
    }
  }
  return masked(px, out, mask);
}

/** Median filter per channel (removes speckles and salt-and-pepper noise, keeps edges). */
export function median(px: Pixels, radius: number, mask?: Mask | null): Pixels {
  const r = Math.max(1, Math.min(10, Math.round(radius)));
  const { width: w, height: h } = px;
  const out = copy(px);
  const hist = new Uint32Array(256);
  const size = (2 * r + 1) * (2 * r + 1);
  const half = size >> 1;
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      hist.fill(0);
      // initial window at x = 0
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) hist[px.data[(yy * w + Math.min(w - 1, Math.max(0, dx))) * 4 + c]]++;
      }
      for (let x = 0; x < w; x++) {
        let acc = 0;
        let v = 0;
        for (; v < 256; v++) {
          acc += hist[v];
          if (acc > half) break;
        }
        out.data[(y * w + x) * 4 + c] = v;
        // slide the window right
        const xo = Math.max(0, x - r);
        const xi = Math.min(w - 1, x + r + 1);
        for (let dy = -r; dy <= r; dy++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          hist[px.data[(yy * w + xo) * 4 + c]]--;
          hist[px.data[(yy * w + xi) * 4 + c]]++;
        }
      }
    }
  }
  return masked(px, out, mask);
}

export function motionBlur(px: Pixels, angleDeg: number, distance: number, mask?: Mask | null): Pixels {
  const { width: w, height: h } = px;
  const out = copy(px);
  const steps = Math.max(1, Math.round(distance));
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = -Math.sin(rad);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let s = 0; s < steps; s++) {
        const t = s - (steps - 1) / 2;
        const sx = Math.min(w - 1, Math.max(0, Math.round(x + dx * t)));
        const sy = Math.min(h - 1, Math.max(0, Math.round(y + dy * t)));
        const k = (sy * w + sx) * 4;
        r += px.data[k];
        g += px.data[k + 1];
        b += px.data[k + 2];
        a += px.data[k + 3];
      }
      const k = (y * w + x) * 4;
      out.data[k] = r / steps;
      out.data[k + 1] = g / steps;
      out.data[k + 2] = b / steps;
      out.data[k + 3] = a / steps;
    }
  }
  return masked(px, out, mask);
}

function convolve(px: Pixels, kernel: number[], bias: number, mask?: Mask | null, gray = false): Pixels {
  const { width: w, height: h } = px;
  const out = copy(px);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0];
      let ki = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const k = (yy * w + xx) * 4;
          const kv = kernel[ki++];
          acc[0] += px.data[k] * kv;
          acc[1] += px.data[k + 1] * kv;
          acc[2] += px.data[k + 2] * kv;
        }
      }
      const k = (y * w + x) * 4;
      if (gray) {
        const v = clamp((acc[0] * 0.299 + acc[1] * 0.587 + acc[2] * 0.114) + bias);
        out.data[k] = out.data[k + 1] = out.data[k + 2] = v;
      } else {
        out.data[k] = clamp(acc[0] + bias);
        out.data[k + 1] = clamp(acc[1] + bias);
        out.data[k + 2] = clamp(acc[2] + bias);
      }
    }
  }
  return masked(px, out, mask);
}

export function emboss(px: Pixels, strength: number, mask?: Mask | null): Pixels {
  const s = strength;
  return convolve(px, [-2 * s, -s, 0, -s, 1, s, 0, s, 2 * s], 128 - 128, mask, true);
}

/** Sobel edge magnitude, inverted so edges are dark lines on white (like Photoshop's Find Edges). */
export function findEdges(px: Pixels, mask?: Mask | null): Pixels {
  const { width: w, height: h } = px;
  const out = copy(px);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = px.data[i * 4] * 0.299 + px.data[i * 4 + 1] * 0.587 + px.data[i * 4 + 2] * 0.114;
  const at = (x: number, y: number) => lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      const v = clamp(255 - Math.sqrt(gx * gx + gy * gy));
      const k = (y * w + x) * 4;
      out.data[k] = out.data[k + 1] = out.data[k + 2] = v;
    }
  }
  return masked(px, out, mask);
}

export function runFilter(id: FilterId, px: Pixels, p: Record<string, number>, mask?: Mask | null): Pixels {
  switch (id) {
    case 'gaussianBlur':
      return gaussianBlur(px, p.radius, mask);
    case 'unsharpMask':
      return unsharpMask(px, p.amount, p.radius, p.threshold, mask);
    case 'addNoise':
      return addNoise(px, p.amount, p.mono >= 0.5, mask);
    case 'median':
      return median(px, p.radius, mask);
    case 'motionBlur':
      return motionBlur(px, p.angle, p.distance, mask);
    case 'emboss':
      return emboss(px, p.strength, mask);
    case 'findEdges':
      return findEdges(px, mask);
  }
}

/**
 * Spot healing: fills the masked pixels from their surroundings (diffusion inpainting: each
 * pass sets every unknown pixel to the average of its known neighbours, working inwards),
 * then restores a little of the surrounding texture with noise matched to the area.
 */
export function spotHeal(px: Pixels, mask: Mask): Pixels {
  const { width: w, height: h } = px;
  const out = copy(px);
  const known = new Uint8Array(w * h);
  let unknown = 0;
  for (let i = 0; i < w * h; i++) {
    if (mask.data[i] >= 128) unknown++;
    else known[i] = 1;
  }
  if (!unknown) return out;
  const order: number[] = [];
  // peel the hole from its border inwards
  let frontier: number[] = [];
  for (let i = 0; i < w * h; i++) if (!known[i]) frontier.push(i);
  let guard = 0;
  while (frontier.length && guard++ < 4000) {
    const next: number[] = [];
    const fill: [number, number, number, number, number][] = [];
    for (const i of frontier) {
      const x = i % w;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w, x > 0 ? i - w - 1 : -1, x < w - 1 ? i - w + 1 : -1, x > 0 ? i + w - 1 : -1, x < w - 1 ? i + w + 1 : -1]) {
        if (j < 0 || j >= w * h || !known[j]) continue;
        const k = j * 4;
        r += out.data[k];
        g += out.data[k + 1];
        b += out.data[k + 2];
        a += out.data[k + 3];
        n++;
      }
      if (n) fill.push([i, r / n, g / n, b / n, a / n]);
      else next.push(i);
    }
    for (const [i, r, g, b, a] of fill) {
      const k = i * 4;
      out.data[k] = r;
      out.data[k + 1] = g;
      out.data[k + 2] = b;
      out.data[k + 3] = a;
      known[i] = 1;
      order.push(i);
    }
    if (!fill.length) break;
    frontier = next;
  }
  // smooth the filled area a few times so the diffusion seams disappear
  for (let pass = 0; pass < 4; pass++) {
    for (const i of order) {
      const x = i % w;
      const k = i * 4;
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        let n = 0;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
          if (j < 0 || j >= w * h) continue;
          acc += out.data[j * 4 + c];
          n++;
        }
        out.data[k + c] = acc / n;
      }
    }
  }
  // texture: noise with the standard deviation of a ring of pixels around the spot
  let sum = 0;
  let sum2 = 0;
  let cnt = 0;
  for (let i = 0; i < w * h; i++) {
    if (mask.data[i] >= 128) continue;
    const x = i % w;
    const near = [i - 3, i + 3, i - 3 * w, i + 3 * w].some((j) => j >= 0 && j < w * h && mask.data[j] >= 128 && Math.abs((j % w) - x) <= 3);
    if (!near) continue;
    const v = out.data[i * 4] * 0.299 + out.data[i * 4 + 1] * 0.587 + out.data[i * 4 + 2] * 0.114;
    sum += v;
    sum2 += v * v;
    cnt++;
  }
  const sd = cnt > 1 ? Math.sqrt(Math.max(0, sum2 / cnt - (sum / cnt) ** 2)) : 0;
  if (sd > 0.5) {
    let s = 12345;
    for (const i of order) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const n = ((s / 0x7fffffff) * 2 - 1) * sd * 0.6;
      const k = i * 4;
      out.data[k] = clamp(out.data[k] + n);
      out.data[k + 1] = clamp(out.data[k + 1] + n);
      out.data[k + 2] = clamp(out.data[k + 2] + n);
    }
  }
  // feathered masks blend at the edge
  return masked(px, out, mask);
}

/** Dodge (lighten) or burn (darken) where `mask` is set; `range` targets shadows/midtones/highlights. */
export function dodgeBurn(px: Pixels, mask: Mask, mode: 'dodge' | 'burn', exposure: number, range: 'shadows' | 'midtones' | 'highlights'): Pixels {
  const out = copy(px);
  const e = exposure / 100;
  for (let i = 0, n = px.width * px.height; i < n; i++) {
    const m = mask.data[i];
    if (!m) continue;
    const k = i * 4;
    const L = (px.data[k] * 0.299 + px.data[k + 1] * 0.587 + px.data[k + 2] * 0.114) / 255;
    const w = range === 'shadows' ? Math.max(0, 1 - L * 2) : range === 'highlights' ? Math.max(0, L * 2 - 1) : 1 - Math.abs(L - 0.5) * 2;
    const f = 1 + (mode === 'dodge' ? 1 : -1) * e * w * (m / 255);
    for (let c = 0; c < 3; c++) out.data[k + c] = clamp(px.data[k + c] * f + (mode === 'dodge' ? 255 * e * w * 0.1 * (m / 255) : 0));
  }
  return out;
}
