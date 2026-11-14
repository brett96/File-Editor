/**
 * Motion tracking by patch matching: follows a small region of the picture from one frame
 * to the next. Pure maths on grey-scale frames, so it can be tested without a video.
 */
import type { Pixels } from '../media/image-ops';
import type { Keyframe } from './model';

export interface Gray {
  data: Float32Array;
  width: number;
  height: number;
}

export function toGray(px: Pixels): Gray {
  const out = new Float32Array(px.width * px.height);
  const d = px.data;
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return { data: out, width: px.width, height: px.height };
}

/** Mean absolute difference between the patch of `a` at (ax, ay) and the patch of `b` at (bx, by). */
function patchError(a: Gray, b: Gray, ax: number, ay: number, bx: number, by: number, w: number, h: number, stride: number, best: number): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y += stride) {
    const ya = ay + y;
    const yb = by + y;
    if (ya < 0 || yb < 0 || ya >= a.height || yb >= b.height) continue;
    for (let x = 0; x < w; x += stride) {
      const xa = ax + x;
      const xb = bx + x;
      if (xa < 0 || xb < 0 || xa >= a.width || xb >= b.width) continue;
      sum += Math.abs(a.data[ya * a.width + xa] - b.data[yb * b.width + xb]);
      n++;
    }
    // no point finishing a candidate that is already worse than the best one
    if (n > 32 && sum / n > best * 1.6) return Infinity;
  }
  return n < 8 ? Infinity : sum / n;
}

/**
 * Where the w×h region of `prev` centred on (cx, cy) is in `next`: searches ±radius pixels,
 * coarsely first and then around the best coarse match. `error` is the mean difference per
 * pixel (0–255) at the match; a large value means the subject was lost.
 */
export function trackPatch(prev: Gray, next: Gray, cx: number, cy: number, w: number, h: number, radius: number): { x: number; y: number; error: number } {
  const pw = Math.max(4, Math.round(w));
  const ph = Math.max(4, Math.round(h));
  const ax = Math.round(cx - pw / 2);
  const ay = Math.round(cy - ph / 2);
  const stride = Math.max(1, Math.floor(Math.min(pw, ph) / 24));
  // staying put wins ties, so a featureless region does not wander
  let best = { dx: 0, dy: 0, e: patchError(prev, next, ax, ay, ax, ay, pw, ph, stride, Infinity) };
  const tryAt = (dx: number, dy: number) => {
    const e = patchError(prev, next, ax, ay, ax + dx, ay + dy, pw, ph, stride, best.e);
    if (e < best.e - 1e-6) best = { dx, dy, e };
  };
  const coarse = radius > 6 ? 2 : 1;
  for (let dy = -radius; dy <= radius; dy += coarse) for (let dx = -radius; dx <= radius; dx += coarse) tryAt(dx, dy);
  if (coarse > 1) {
    const { dx: bx, dy: by } = best;
    for (let dy = by - 1; dy <= by + 1; dy++) for (let dx = bx - 1; dx <= bx + 1; dx++) tryAt(dx, dy);
  }
  return { x: cx + best.dx, y: cy + best.dy, error: best.e };
}

/** Drops keys that lie (within `tolerance`) on the straight line between their neighbours. */
export function simplifyKeys(keys: Keyframe[], tolerance: number): Keyframe[] {
  if (keys.length < 3) return keys;
  const keep = new Array<boolean>(keys.length).fill(false);
  keep[0] = keep[keys.length - 1] = true;
  const stack: [number, number][] = [[0, keys.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let dist = tolerance;
    for (let i = a + 1; i < b; i++) {
      const u = (keys[i].t - keys[a].t) / (keys[b].t - keys[a].t || 1);
      const d = Math.abs(keys[i].v - (keys[a].v + (keys[b].v - keys[a].v) * u));
      if (d > dist) {
        dist = d;
        worst = i;
      }
    }
    if (worst > 0) {
      keep[worst] = true;
      stack.push([a, worst], [worst, b]);
    }
  }
  return keys.filter((_, i) => keep[i]);
}
