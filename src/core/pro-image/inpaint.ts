/**
 * Retouching by synthesis (pro photo editor):
 *
 *   contentAwareFill  the Remove tool: fills a hole with texture copied from the rest of the
 *                     picture, patch by patch, working from a small copy up to full size
 *                     (PatchMatch search + patch voting, after Wexler et al. / Barnes et al.)
 *   expandToShadows   grows a mask over the darker area attached to it (a cast shadow)
 *   patchClone        the Patch tool: copies another area into a selection and blends its
 *                     colour and lighting to the surroundings (membrane / Poisson-style)
 *
 * Pure maths on RGBA pixels; nothing here touches the DOM.
 */
import type { Pixels } from '../media/image-ops';
import type { Mask } from './selection';

const PATCH = 3; // patch radius: 7×7 patches

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Grows the selected part of a mask by `radius` pixels (binary: ≥128 counts as selected). */
export function dilateMask(m: Mask, radius: number): Mask {
  const r = Math.max(0, Math.round(radius));
  const { width: w, height: h } = m;
  const out: Mask = { data: new Uint8Array(w * h), width: w, height: h };
  if (!r) {
    for (let i = 0; i < w * h; i++) out.data[i] = m.data[i] >= 128 ? 255 : 0;
    return out;
  }
  const tmp = new Uint8Array(w * h);
  // running count of selected pixels in the window, rows then columns
  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = 0; x <= Math.min(w - 1, r); x++) if (m.data[y * w + x] >= 128) count++;
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = count > 0 ? 1 : 0;
      if (x + r + 1 < w && m.data[y * w + x + r + 1] >= 128) count++;
      if (x - r >= 0 && m.data[y * w + x - r] >= 128) count--;
    }
  }
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y <= Math.min(h - 1, r); y++) count += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      out.data[y * w + x] = count > 0 ? 255 : 0;
      if (y + r + 1 < h) count += tmp[(y + r + 1) * w + x];
      if (y - r >= 0) count -= tmp[(y - r) * w + x];
    }
  }
  return out;
}

interface Level {
  w: number;
  h: number;
  /** RGB, 3 floats per pixel */
  img: Float32Array;
  /** 1 = to be filled */
  hole: Uint8Array;
}

function downscale(l: Level): Level {
  const w = Math.max(1, l.w >> 1);
  const h = Math.max(1, l.h >> 1);
  const img = new Float32Array(w * h * 3);
  const hole = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let holes = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(l.w - 1, x * 2 + dx);
          const sy = Math.min(l.h - 1, y * 2 + dy);
          const i = sy * l.w + sx;
          if (l.hole[i]) {
            holes++;
            continue;
          }
          r += l.img[i * 3];
          g += l.img[i * 3 + 1];
          b += l.img[i * 3 + 2];
          n++;
        }
      }
      const o = y * w + x;
      hole[o] = holes ? 1 : 0;
      if (n) {
        img[o * 3] = r / n;
        img[o * 3 + 1] = g / n;
        img[o * 3 + 2] = b / n;
      }
    }
  }
  return { w, h, img, hole };
}

/** Fills the hole from its edge inwards with the average of the known neighbours (a smooth first guess). */
function diffuse(l: Level): void {
  const { w, h, img } = l;
  const known = new Uint8Array(w * h);
  let frontier: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (l.hole[i]) frontier.push(i);
    else known[i] = 1;
  }
  while (frontier.length) {
    const next: number[] = [];
    const filled: number[] = [];
    const vals: number[] = [];
    for (const i of frontier) {
      const x = i % w;
      const y = (i / w) | 0;
      let n = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || !known[yy * w + xx]) continue;
          const j = (yy * w + xx) * 3;
          r += img[j];
          g += img[j + 1];
          b += img[j + 2];
          n++;
        }
      }
      if (n) {
        filled.push(i);
        vals.push(r / n, g / n, b / n);
      } else next.push(i);
    }
    if (!filled.length) break;
    filled.forEach((i, k) => {
      img[i * 3] = vals[k * 3];
      img[i * 3 + 1] = vals[k * 3 + 1];
      img[i * 3 + 2] = vals[k * 3 + 2];
      known[i] = 1;
    });
    frontier = next;
  }
}

interface Field {
  /** target pixel indices (every pixel whose patch touches the hole) */
  targets: Int32Array;
  /** per pixel: index into `targets`, or −1 */
  slot: Int32Array;
  /** matched source centre per target */
  sx: Int32Array;
  sy: Int32Array;
  cost: Float32Array;
  /** 1 where a whole patch around the pixel is known picture */
  valid: Uint8Array;
  sources: Int32Array;
}

function prepare(l: Level): Field | null {
  const { w, h, hole } = l;
  const near = dilateMask({ data: hole.map((v) => (v ? 255 : 0)), width: w, height: h }, PATCH).data;
  const valid = new Uint8Array(w * h);
  const sources: number[] = [];
  const targets: number[] = [];
  const slot = new Int32Array(w * h).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (near[i]) {
        slot[i] = targets.length;
        targets.push(i);
      } else if (x >= PATCH && y >= PATCH && x < w - PATCH && y < h - PATCH) {
        valid[i] = 1;
        sources.push(i);
      }
    }
  }
  if (!sources.length || !targets.length) return null;
  const n = targets.length;
  return { targets: Int32Array.from(targets), slot, sx: new Int32Array(n).fill(-1), sy: new Int32Array(n), cost: new Float32Array(n).fill(Infinity), valid, sources: Int32Array.from(sources) };
}

/** Sum of squared colour differences between the patch at target (tx, ty) and the one at source (sx, sy). */
function patchCost(l: Level, tx: number, ty: number, sx: number, sy: number, best: number): number {
  const { w, h, img } = l;
  let sum = 0;
  let n = 0;
  for (let dy = -PATCH; dy <= PATCH; dy++) {
    const yy = ty + dy;
    if (yy < 0 || yy >= h) continue;
    const trow = yy * w;
    const srow = (sy + dy) * w;
    for (let dx = -PATCH; dx <= PATCH; dx++) {
      const xx = tx + dx;
      if (xx < 0 || xx >= w) continue;
      const a = (trow + xx) * 3;
      const b = (srow + sx + dx) * 3;
      const dr = img[a] - img[b];
      const dg = img[a + 1] - img[b + 1];
      const db = img[a + 2] - img[b + 2];
      sum += dr * dr + dg * dg + db * db;
      n++;
    }
    if (sum > best * (PATCH * 2 + 1) * (PATCH * 2 + 1)) return Infinity;
  }
  return n ? sum / n : Infinity;
}

/** One PatchMatch sweep: good matches spread to neighbours, then each is improved by random tries nearby. */
function search(l: Level, f: Field, rand: () => number, reverse: boolean): void {
  const { w, h } = l;
  const n = f.targets.length;
  const step = reverse ? -1 : 1;
  const maxR = Math.max(w, h);
  for (let k = reverse ? n - 1 : 0; k >= 0 && k < n; k += step) {
    const i = f.targets[k];
    const x = i % w;
    const y = (i / w) | 0;
    const attempt = (sx: number, sy: number) => {
      if (sx < PATCH || sy < PATCH || sx >= w - PATCH || sy >= h - PATCH || !f.valid[sy * w + sx]) return;
      const c = patchCost(l, x, y, sx, sy, f.cost[k]);
      if (c < f.cost[k]) {
        f.cost[k] = c;
        f.sx[k] = sx;
        f.sy[k] = sy;
      }
    };
    if (f.sx[k] < 0) {
      const s = f.sources[(rand() * f.sources.length) | 0];
      f.sx[k] = s % w;
      f.sy[k] = (s / w) | 0;
      f.cost[k] = patchCost(l, x, y, f.sx[k], f.sy[k], Infinity);
    } else f.cost[k] = patchCost(l, x, y, f.sx[k], f.sy[k], Infinity);
    // propagation: a neighbour's match, shifted by one, is probably a good match here too
    const nx = x - step;
    if (nx >= 0 && nx < w) {
      const j = f.slot[y * w + nx];
      if (j >= 0 && f.sx[j] >= 0) attempt(f.sx[j] + step, f.sy[j]);
    }
    const ny = y - step;
    if (ny >= 0 && ny < h) {
      const j = f.slot[ny * w + x];
      if (j >= 0 && f.sx[j] >= 0) attempt(f.sx[j], f.sy[j] + step);
    }
    for (let r = maxR; r >= 1; r = Math.floor(r / 2)) {
      attempt(f.sx[k] + Math.round((rand() * 2 - 1) * r), f.sy[k] + Math.round((rand() * 2 - 1) * r));
    }
  }
}

/** Every hole pixel becomes the average of what the patches covering it say it should be. */
function vote(l: Level, f: Field): void {
  const { w, h, img, hole } = l;
  const acc = new Float32Array(w * h * 4);
  for (let k = 0; k < f.targets.length; k++) {
    if (f.sx[k] < 0) continue;
    const i = f.targets[k];
    const x = i % w;
    const y = (i / w) | 0;
    // better matches count for more
    const weight = 1 / (1 + f.cost[k] * 0.02);
    for (let dy = -PATCH; dy <= PATCH; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -PATCH; dx <= PATCH; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w || !hole[yy * w + xx]) continue;
        const s = ((f.sy[k] + dy) * w + f.sx[k] + dx) * 3;
        const o = (yy * w + xx) * 4;
        acc[o] += img[s] * weight;
        acc[o + 1] += img[s + 1] * weight;
        acc[o + 2] += img[s + 2] * weight;
        acc[o + 3] += weight;
      }
    }
  }
  for (let i = 0; i < w * h; i++) {
    const wt = acc[i * 4 + 3];
    if (!hole[i] || wt <= 0) continue;
    img[i * 3] = acc[i * 4] / wt;
    img[i * 3 + 1] = acc[i * 4 + 1] / wt;
    img[i * 3 + 2] = acc[i * 4 + 2] / wt;
  }
}

/** The finest level is only refined when it is small enough to stay responsive. */
const FULL_REFINE_TARGETS = 160_000;

/**
 * Fills the masked area (≥128) with content synthesised from the rest of `px`. Returns a new
 * buffer; pixels outside the mask are untouched. Only the area around the mask is examined,
 * so the cost depends on the size of the hole, not of the picture.
 */
export function contentAwareFill(px: Pixels, mask: Mask, seed = 1): Pixels {
  const out: Pixels = { data: new Uint8ClampedArray(px.data), width: px.width, height: px.height };
  let x0 = px.width;
  let y0 = px.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      if (mask.data[y * px.width + x] < 128) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return out;
  // work on the hole plus generous surroundings to copy from
  const margin = Math.max(48, Math.round(Math.max(x1 - x0, y1 - y0) * 1.5));
  const cx = Math.max(0, x0 - margin);
  const cy = Math.max(0, y0 - margin);
  const cw = Math.min(px.width, x1 + margin + 1) - cx;
  const ch = Math.min(px.height, y1 + margin + 1) - cy;
  const base: Level = { w: cw, h: ch, img: new Float32Array(cw * ch * 3), hole: new Uint8Array(cw * ch) };
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const s = (cy + y) * px.width + cx + x;
      const o = y * cw + x;
      // transparent pixels have no colour to copy, so they are treated as hole too (but only the mask is written back)
      base.hole[o] = mask.data[s] >= 128 || px.data[s * 4 + 3] === 0 ? 1 : 0;
      base.img[o * 3] = px.data[s * 4];
      base.img[o * 3 + 1] = px.data[s * 4 + 1];
      base.img[o * 3 + 2] = px.data[s * 4 + 2];
    }
  }
  const levels = [base];
  let span = Math.min(x1 - x0, y1 - y0) + 1;
  while (span > 6 && Math.min(levels[0].w, levels[0].h) >= (PATCH * 2 + 1) * 6) {
    levels.unshift(downscale(levels[0]));
    span /= 2;
  }
  const rand = rng(seed);
  let prev: { l: Level; f: Field } | null = null;
  levels.forEach((l, li) => {
    const f = prepare(l);
    if (!f) {
      diffuse(l);
      prev = null;
      return;
    }
    if (prev) {
      // start from the coarser answer: the same matches, at twice the coordinates
      const { l: pl, f: pf } = prev as { l: Level; f: Field };
      for (let k = 0; k < f.targets.length; k++) {
        const i = f.targets[k];
        const x = i % l.w;
        const y = (i / l.w) | 0;
        const j = pf.slot[Math.min(pl.h - 1, y >> 1) * pl.w + Math.min(pl.w - 1, x >> 1)];
        if (j < 0 || pf.sx[j] < 0) continue;
        const sx = pf.sx[j] * 2 + (x & 1);
        const sy = pf.sy[j] * 2 + (y & 1);
        if (sx >= PATCH && sy >= PATCH && sx < l.w - PATCH && sy < l.h - PATCH && f.valid[sy * l.w + sx]) {
          f.sx[k] = sx;
          f.sy[k] = sy;
          f.cost[k] = 0;
        }
      }
      diffuse(l);
      vote(l, f);
    } else diffuse(l);
    const last = li === levels.length - 1;
    const rounds = last && f.targets.length > FULL_REFINE_TARGETS ? 0 : Math.max(2, Math.round(7 - li * 1.5));
    for (let r = 0; r < rounds; r++) {
      search(l, f, rand, r % 2 === 1);
      vote(l, f);
    }
    prev = { l, f };
  });
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const s = (cy + y) * px.width + cx + x;
      if (mask.data[s] < 128) continue;
      const o = (y * cw + x) * 3;
      out.data[s * 4] = base.img[o];
      out.data[s * 4 + 1] = base.img[o + 1];
      out.data[s * 4 + 2] = base.img[o + 2];
      if (out.data[s * 4 + 3] === 0) out.data[s * 4 + 3] = 255;
    }
  }
  return out;
}

/**
 * Extends a mask over the darker region attached to it: the shadow an object casts on the
 * ground or wall it stands against. Looks only within `reach` pixels of the mask, and gives
 * up (returning the mask unchanged) when the surroundings are dark all over, since then
 * "darker than the background" does not single anything out.
 */
export function expandToShadows(px: Pixels, mask: Mask, reach: number): Mask {
  const { width: w, height: h } = px;
  const core = dilateMask(mask, 2);
  const zone = dilateMask(mask, Math.max(4, Math.round(reach)));
  const hist = new Uint32Array(256);
  let ring = 0;
  const lum = (i: number) => Math.round(0.299 * px.data[i * 4] + 0.587 * px.data[i * 4 + 1] + 0.114 * px.data[i * 4 + 2]);
  for (let i = 0; i < w * h; i++) {
    if (!zone.data[i] || core.data[i]) continue;
    hist[lum(i)]++;
    ring++;
  }
  if (ring < 16) return mask;
  // the background brightness: the upper quartile of the ring, so the shadow itself does not drag it down
  let acc = 0;
  let bg = 255;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= ring * 0.25) {
      bg = v;
      break;
    }
  }
  const limit = bg * 0.8;
  let darker = 0;
  for (let v = 0; v < limit; v++) darker += hist[v];
  if (bg < 40 || darker > ring * 0.45) return mask;
  const out: Mask = { data: new Uint8Array(mask.data), width: w, height: h };
  const seen = new Uint8Array(w * h);
  const queue: number[] = [];
  for (let i = 0; i < w * h; i++) if (core.data[i]) {
    seen[i] = 1;
    queue.push(i);
  }
  let added = 0;
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j < 0 || j >= w * h || seen[j] || !zone.data[j]) continue;
      seen[j] = 1;
      if (lum(j) >= limit) continue;
      out.data[j] = 255;
      added++;
      queue.push(j);
    }
  }
  // the soft outer edge of a shadow is lighter than the cut-off, so take a margin around what was found
  return added ? dilateMask(out, Math.max(3, Math.round(reach * 0.06))) : mask;
}

/**
 * Patch: the masked area is replaced by the picture `dx, dy` away, and the difference in
 * colour and brightness between the two places is smoothed across it, so the copied texture
 * takes on the lighting of where it lands. Feathered mask edges blend with the original.
 */
export function patchClone(px: Pixels, mask: Mask, dx: number, dy: number): Pixels {
  const { width: w, height: h } = px;
  const out: Pixels = { data: new Uint8ClampedArray(px.data), width: w, height: h };
  const inside = new Uint8Array(w * h);
  const idx: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (mask.data[i] > 0) {
      inside[i] = 1;
      idx.push(i);
    }
  }
  if (!idx.length) return out;
  const ox = Math.round(dx);
  const oy = Math.round(dy);
  const srcOf = (i: number) => {
    const x = Math.min(w - 1, Math.max(0, (i % w) + ox));
    const y = Math.min(h - 1, Math.max(0, ((i / w) | 0) + oy));
    return y * w + x;
  };
  // the correction: (what is here) − (what is at the source), known just outside the mask and smoothed across it
  const f = new Float32Array(w * h * 3);
  const fixed = new Uint8Array(w * h);
  const edge = (j: number) => {
    if (j < 0 || j >= w * h || inside[j] || fixed[j]) return;
    fixed[j] = 1;
    const s = srcOf(j);
    for (let c = 0; c < 3; c++) f[j * 3 + c] = px.data[j * 4 + c] - px.data[s * 4 + c];
  };
  for (const i of idx) {
    const x = i % w;
    if (x > 0) edge(i - 1);
    if (x < w - 1) edge(i + 1);
    edge(i - w);
    edge(i + w);
  }
  // first guess from the edge inwards, then relax towards the smooth (harmonic) solution
  diffuseWithin({ w, h, img: f, hole: inside }, fixed);
  const omega = 1.85;
  const sweeps = Math.min(400, 40 + Math.round(Math.sqrt(idx.length) * 3));
  for (let s = 0; s < sweeps; s++) {
    for (let n = 0; n < idx.length; n++) {
      const i = idx[s % 2 ? idx.length - 1 - n : n];
      const x = i % w;
      const y = (i / w) | 0;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let cnt = 0;
        if (x > 0 && (inside[i - 1] || fixed[i - 1])) (sum += f[(i - 1) * 3 + c]), cnt++;
        if (x < w - 1 && (inside[i + 1] || fixed[i + 1])) (sum += f[(i + 1) * 3 + c]), cnt++;
        if (y > 0 && (inside[i - w] || fixed[i - w])) (sum += f[(i - w) * 3 + c]), cnt++;
        if (y < h - 1 && (inside[i + w] || fixed[i + w])) (sum += f[(i + w) * 3 + c]), cnt++;
        if (cnt) f[i * 3 + c] += omega * (sum / cnt - f[i * 3 + c]);
      }
    }
  }
  for (const i of idx) {
    const s = srcOf(i);
    const a = mask.data[i] / 255;
    for (let c = 0; c < 3; c++) {
      const v = px.data[s * 4 + c] + f[i * 3 + c];
      out.data[i * 4 + c] = px.data[i * 4 + c] + (v - px.data[i * 4 + c]) * a;
    }
    out.data[i * 4 + 3] = Math.max(px.data[i * 4 + 3], px.data[s * 4 + 3] * a);
  }
  return out;
}

/** diffuse(), but only the pixels marked in `known` count as known to begin with. */
function diffuseWithin(l: Level, known0: Uint8Array): void {
  const { w, h, img } = l;
  const known = new Uint8Array(known0);
  let frontier: number[] = [];
  for (let i = 0; i < w * h; i++) if (l.hole[i]) frontier.push(i);
  while (frontier.length) {
    const next: number[] = [];
    const filled: number[] = [];
    const vals: number[] = [];
    for (const i of frontier) {
      const x = i % w;
      let n = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= w * h || !known[j]) continue;
        r += img[j * 3];
        g += img[j * 3 + 1];
        b += img[j * 3 + 2];
        n++;
      }
      if (n) {
        filled.push(i);
        vals.push(r / n, g / n, b / n);
      } else next.push(i);
    }
    if (!filled.length) break;
    filled.forEach((i, k) => {
      img[i * 3] = vals[k * 3];
      img[i * 3 + 1] = vals[k * 3 + 1];
      img[i * 3 + 2] = vals[k * 3 + 2];
      known[i] = 1;
    });
    frontier = next;
  }
}
