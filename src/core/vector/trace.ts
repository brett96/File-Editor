/**
 * Pixels → outlines (Image Trace, and text outlines when a font's own glyph data can't be read).
 *
 * A scalar field (coverage 0–1 per pixel) is contoured with marching squares; crossing points
 * are placed by linear interpolation between pixel centres, so an anti-aliased edge gives a
 * contour at sub-pixel accuracy rather than a staircase. Contours come back as closed loops;
 * filled with the even-odd rule they reproduce the shape including its holes.
 */
import type { Pt } from './path';

/** Closed contour loops of `field` (width × height, row by row) at `level`. Coordinates are in pixels. */
export function traceField(field: Float32Array, width: number, height: number, level = 0.5): Pt[][] {
  // one cell of padding all round, so shapes touching the edge still close
  const W = width + 2;
  const H = height + 2;
  const v = (x: number, y: number): number => (x < 1 || y < 1 || x > width || y > height ? 0 : field[(y - 1) * width + (x - 1)]);
  /** crossing on the horizontal grid edge from (x, y) to (x+1, y) */
  const hKey = (x: number, y: number) => y * W + x;
  /** crossing on the vertical grid edge from (x, y) to (x, y+1) */
  const vKey = (x: number, y: number) => W * H + y * W + x;
  const points = new Map<number, Pt>();
  const links = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    (links.get(a) ?? links.set(a, []).get(a)!).push(b);
    (links.get(b) ?? links.set(b, []).get(b)!).push(a);
  };
  const lerp = (a: number, b: number) => (Math.abs(b - a) < 1e-9 ? 0.5 : Math.max(0, Math.min(1, (level - a) / (b - a))));
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const a = v(x, y);
      const b = v(x + 1, y);
      const c = v(x + 1, y + 1);
      const d = v(x, y + 1);
      const code = (a >= level ? 8 : 0) | (b >= level ? 4 : 0) | (c >= level ? 2 : 0) | (d >= level ? 1 : 0);
      if (code === 0 || code === 15) continue;
      // pixel centres sit at integer + 0.5 of the unpadded image, i.e. grid x - 0.5
      const top = hKey(x, y);
      const bottom = hKey(x, y + 1);
      const left = vKey(x, y);
      const right = vKey(x + 1, y);
      if (!points.has(top) && a >= level !== b >= level) points.set(top, { x: x - 0.5 + lerp(a, b), y: y - 0.5 });
      if (!points.has(bottom) && d >= level !== c >= level) points.set(bottom, { x: x - 0.5 + lerp(d, c), y: y + 0.5 });
      if (!points.has(left) && a >= level !== d >= level) points.set(left, { x: x - 0.5, y: y - 0.5 + lerp(a, d) });
      if (!points.has(right) && b >= level !== c >= level) points.set(right, { x: x + 0.5, y: y - 0.5 + lerp(b, c) });
      switch (code) {
        case 1: case 14: link(left, bottom); break;
        case 2: case 13: link(bottom, right); break;
        case 3: case 12: link(left, right); break;
        case 4: case 11: link(top, right); break;
        case 6: case 9: link(top, bottom); break;
        case 7: case 8: link(left, top); break;
        case 5:
        case 10: {
          // saddle: the cell's mean decides which diagonal is connected
          const inside = (a + b + c + d) / 4 >= level;
          if ((code === 5) === inside) {
            link(left, top);
            link(bottom, right);
          } else {
            link(left, bottom);
            link(top, right);
          }
          break;
        }
      }
    }
  }
  const loops: Pt[][] = [];
  const seen = new Set<number>();
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const loop: Pt[] = [];
    let prev = -1;
    let cur = start;
    for (let guard = 0; guard < 1e7; guard++) {
      seen.add(cur);
      loop.push(points.get(cur)!);
      const nb = links.get(cur)!;
      const next = nb[0] !== prev ? nb[0] : nb[1];
      // a saddle point has four links: take the first not yet walked
      const step = nb.length > 2 ? nb.find((k) => k !== prev && !seen.has(k)) ?? next : next;
      if (step === undefined || step === start || seen.has(step)) break;
      prev = cur;
      cur = step;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** A 3 × 3 box blur of a 0/1 mask, so hard pixel edges trace as smooth sub-pixel contours. */
export function softenMask(mask: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          sum += mask[yy * width + xx];
          n++;
        }
      }
      out[y * width + x] = sum / n;
    }
  }
  return out;
}

export interface TraceOptions {
  mode: 'bw' | 'color';
  /** bw: luminance below this (0–255) is ink */
  threshold: number;
  /** color: how many colours to reduce the picture to (2–24) */
  colors: number;
  /** drop specks smaller than this many pixels across */
  minSize: number;
}

export interface TracedShape {
  color: string;
  loops: Pt[][];
}

const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');

/** k-means palette of an RGBA image (deterministic: seeded from evenly spaced pixels). */
function palette(rgba: Uint8ClampedArray, k: number): number[][] {
  const samples: number[][] = [];
  const stride = Math.max(1, Math.floor(rgba.length / 4 / 20000));
  for (let i = 0; i < rgba.length / 4; i += stride) if (rgba[i * 4 + 3] > 127) samples.push([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]);
  if (!samples.length) return [[0, 0, 0]];
  // seed with the samples spread furthest apart in brightness
  const sorted = [...samples].sort((a, b) => a[0] * 0.3 + a[1] * 0.59 + a[2] * 0.11 - (b[0] * 0.3 + b[1] * 0.59 + b[2] * 0.11));
  let centers = Array.from({ length: k }, (_, i) => [...sorted[Math.min(sorted.length - 1, Math.floor(((i + 0.5) / k) * sorted.length))]]);
  for (let iter = 0; iter < 10; iter++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const s of samples) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = (s[0] - centers[c][0]) ** 2 + (s[1] - centers[c][1]) ** 2 + (s[2] - centers[c][2]) ** 2;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      sums[best][0] += s[0];
      sums[best][1] += s[1];
      sums[best][2] += s[2];
      sums[best][3]++;
    }
    centers = centers.map((c, i) => (sums[i][3] ? [sums[i][0] / sums[i][3], sums[i][1] / sums[i][3], sums[i][2] / sums[i][3]] : c));
  }
  // identical clusters collapse
  return centers.filter((c, i) => centers.findIndex((o) => Math.abs(o[0] - c[0]) + Math.abs(o[1] - c[1]) + Math.abs(o[2] - c[2]) < 6) === i);
}

/**
 * Traces a picture into flat-coloured shapes. Colour mode stacks the shapes: each one also
 * covers everything drawn above it, so neighbouring colours overlap instead of leaving hairline
 * gaps where their fitted curves differ.
 */
export function traceBitmap(rgba: Uint8ClampedArray, width: number, height: number, o: TraceOptions): TracedShape[] {
  const n = width * height;
  const big = (loop: Pt[]) => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const p of loop) {
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
    return Math.max(x1 - x0, y1 - y0) >= o.minSize;
  };
  if (o.mode === 'bw') {
    const mask = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lum = rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114;
      mask[i] = rgba[i * 4 + 3] > 127 && lum < o.threshold ? 1 : 0;
    }
    const loops = traceField(softenMask(mask, width, height), width, height).filter(big);
    return loops.length ? [{ color: '#000000', loops }] : [];
  }
  const colors = palette(rgba, Math.max(2, Math.min(24, Math.round(o.colors))));
  const index = new Uint8Array(n);
  const counts = new Array<number>(colors.length).fill(0);
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3] <= 127) {
      index[i] = 255;
      continue;
    }
    let best = 0;
    let bd = Infinity;
    for (let c = 0; c < colors.length; c++) {
      const d = (rgba[i * 4] - colors[c][0]) ** 2 + (rgba[i * 4 + 1] - colors[c][1]) ** 2 + (rgba[i * 4 + 2] - colors[c][2]) ** 2;
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    index[i] = best;
    counts[best]++;
  }
  // biggest areas at the bottom of the stack
  const order = colors.map((_, i) => i).filter((i) => counts[i] > 0).sort((a, b) => counts[b] - counts[a]);
  const rank = new Uint8Array(256).fill(255);
  order.forEach((c, r) => (rank[c] = r));
  const out: TracedShape[] = [];
  order.forEach((c, r) => {
    const mask = new Float32Array(n);
    for (let i = 0; i < n; i++) mask[i] = index[i] !== 255 && rank[index[i]] >= r ? 1 : 0;
    const loops = traceField(softenMask(mask, width, height), width, height).filter(big);
    if (loops.length) out.push({ color: hex(colors[c][0], colors[c][1], colors[c][2]), loops });
  });
  return out;
}
