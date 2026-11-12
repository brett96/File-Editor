/**
 * Brush painting for the pro photo editor: round dabs with hardness, opacity and a selection
 * limit, laid along a stroke at a fixed spacing. Works on a layer's RGBA pixels (paint, erase,
 * clone, dodge/burn) or on a single-channel mask (layer-mask painting, spot-heal area).
 * Coordinates are document pixels; a layer at an offset passes `ox`/`oy`.
 */
import type { Pixels } from '../media/image-ops';
import type { Mask } from './selection';

export interface Brush {
  /** diameter in px */
  size: number;
  /** 0–1: 1 = hard edge, 0 = fully soft */
  hardness: number;
  /** 0–1 */
  opacity: number;
}

export type DabMode =
  | { kind: 'paint'; color: [number, number, number] }
  | { kind: 'erase' }
  | { kind: 'clone'; source: Pixels; dx: number; dy: number }
  | { kind: 'dodge' | 'burn'; exposure: number };

/** Coverage 0–1 of a dab at distance d from its centre. */
export function falloff(d: number, radius: number, hardness: number): number {
  if (d >= radius) return 0;
  const inner = radius * Math.min(0.999, Math.max(0, hardness));
  if (d <= inner) return 1;
  const t = (d - inner) / (radius - inner);
  // smoothstep
  return 1 - t * t * (3 - 2 * t);
}

/** One dab on layer pixels. `sel` is document-sized (or null for no selection). */
export function dab(px: Pixels, cx: number, cy: number, brush: Brush, mode: DabMode, sel: Mask | null, ox = 0, oy = 0): void {
  const r = Math.max(0.5, brush.size / 2);
  const lx = cx - ox;
  const ly = cy - oy;
  const x0 = Math.max(0, Math.floor(lx - r));
  const x1 = Math.min(px.width - 1, Math.ceil(lx + r));
  const y0 = Math.max(0, Math.floor(ly - r));
  const y1 = Math.min(px.height - 1, Math.ceil(ly + r));
  const d = px.data;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let a = falloff(Math.hypot(x + 0.5 - lx, y + 0.5 - ly), r, brush.hardness) * brush.opacity;
      if (a <= 0) continue;
      if (sel) {
        const sx = x + ox;
        const sy = y + oy;
        if (sx < 0 || sy < 0 || sx >= sel.width || sy >= sel.height) continue;
        a *= sel.data[sy * sel.width + sx] / 255;
        if (a <= 0) continue;
      }
      const k = (y * px.width + x) * 4;
      switch (mode.kind) {
        case 'paint': {
          // source-over with straight alpha
          const da = d[k + 3] / 255;
          const oa = a + da * (1 - a);
          if (oa <= 0) break;
          for (let c = 0; c < 3; c++) d[k + c] = (mode.color[c] * a + d[k + c] * da * (1 - a)) / oa;
          d[k + 3] = oa * 255;
          break;
        }
        case 'erase':
          d[k + 3] = d[k + 3] * (1 - a);
          break;
        case 'clone': {
          const sx = x + ox + mode.dx;
          const sy = y + oy + mode.dy;
          if (sx < 0 || sy < 0 || sx >= mode.source.width || sy >= mode.source.height) break;
          const s = (sy * mode.source.width + sx) * 4;
          const sa = (mode.source.data[s + 3] / 255) * a;
          const da = d[k + 3] / 255;
          const oa = sa + da * (1 - sa);
          if (oa <= 0) break;
          for (let c = 0; c < 3; c++) d[k + c] = (mode.source.data[s + c] * sa + d[k + c] * da * (1 - sa)) / oa;
          d[k + 3] = oa * 255;
          break;
        }
        case 'dodge':
        case 'burn': {
          const L = (d[k] * 0.299 + d[k + 1] * 0.587 + d[k + 2] * 0.114) / 255;
          // strongest in the midtones, like Photoshop's default range
          const w = (1 - Math.abs(L - 0.5) * 2) * (mode.exposure / 100) * a * 0.35;
          const f = mode.kind === 'dodge' ? 1 + w : 1 - w;
          for (let c = 0; c < 3; c++) d[k + c] = Math.max(0, Math.min(255, d[k + c] * f));
          break;
        }
      }
    }
  }
}

/** One dab on a mask: paints toward `value` (255 reveal / 0 hide). */
export function maskDab(m: Mask, cx: number, cy: number, brush: Brush, value: number, sel: Mask | null): void {
  const r = Math.max(0.5, brush.size / 2);
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(m.width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(m.height - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let a = falloff(Math.hypot(x + 0.5 - cx, y + 0.5 - cy), r, brush.hardness) * brush.opacity;
      if (sel) a *= sel.data[y * sel.width + x] / 255;
      if (a <= 0) continue;
      const i = y * m.width + x;
      m.data[i] = Math.round(m.data[i] + (value - m.data[i]) * a);
    }
  }
}

/** Dab centres from (x0,y0) to (x1,y1) at 25 % of the brush size, after `carry` px already covered. */
export function strokePoints(x0: number, y0: number, x1: number, y1: number, size: number, carry: number): { points: [number, number][]; carry: number } {
  const spacing = Math.max(1, size * 0.25);
  const len = Math.hypot(x1 - x0, y1 - y0);
  const points: [number, number][] = [];
  let t = spacing - carry;
  while (t <= len) {
    points.push([x0 + ((x1 - x0) * t) / (len || 1), y0 + ((y1 - y0) * t) / (len || 1)]);
    t += spacing;
  }
  return { points, carry: len - (t - spacing) };
}
