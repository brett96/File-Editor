/**
 * Path geometry: matrices, Bézier maths, SVG path data in and out, the primitive shapes and
 * the bounds / transform of every kind of node. Pure functions, no DOM.
 */
import type { Anchor, Mat, PathNode, SubPath, TextNode, VNode } from './model';

export interface Pt {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── matrices ───────────────────────────────────────────────────────────────

/** a · b: applies b first, then a. */
export function mul(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function apply(m: Mat, x: number, y: number): Pt {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

export const translate = (dx: number, dy: number): Mat => [1, 0, 0, 1, dx, dy];

/** Scale about the point (cx, cy). */
export function scaleAbout(sx: number, sy: number, cx = 0, cy = 0): Mat {
  return [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy];
}

/** Rotate by `angle` radians (clockwise on screen, y down) about (cx, cy). */
export function rotateAbout(angle: number, cx = 0, cy = 0): Mat {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}

export function isIdentity(m: Mat): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}

/** Uniform scale factor of a matrix (√|det|), for things that can only scale evenly (font size, stroke). */
export function scaleOf(m: Mat): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

// ── anchors ────────────────────────────────────────────────────────────────

export function corner(x: number, y: number): Anchor {
  return { x, y, ix: x, iy: y, ox: x, oy: y };
}

export function transformAnchor(a: Anchor, m: Mat): Anchor {
  const p = apply(m, a.x, a.y);
  const i = apply(m, a.ix, a.iy);
  const o = apply(m, a.ox, a.oy);
  return { ...a, x: p.x, y: p.y, ix: i.x, iy: i.y, ox: o.x, oy: o.y };
}

export function transformSubs(subs: SubPath[], m: Mat): SubPath[] {
  return subs.map((s) => ({ ...s, anchors: s.anchors.map((a) => transformAnchor(a, m)) }));
}

/** The cubic segments of a subpath as [p0, c1, c2, p1] (a closed subpath includes the closing one). */
export function segments(sub: SubPath): [Pt, Pt, Pt, Pt][] {
  const out: [Pt, Pt, Pt, Pt][] = [];
  const a = sub.anchors;
  const n = a.length;
  const count = sub.closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const p = a[i];
    const q = a[(i + 1) % n];
    out.push([{ x: p.x, y: p.y }, { x: p.ox, y: p.oy }, { x: q.ix, y: q.iy }, { x: q.x, y: q.y }]);
  }
  return out;
}

export function cubicAt(s: [Pt, Pt, Pt, Pt], t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * s[0].x + b * s[1].x + c * s[2].x + d * s[3].x, y: a * s[0].y + b * s[1].y + c * s[2].y + d * s[3].y };
}

function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  // derivative: 3(-p0+3p1-3p2+p3)t² + 6(p0-2p1+p2)t + 3(p1-p0)
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const ts: number[] = [];
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) > 1e-9) ts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const r = Math.sqrt(disc);
      ts.push((-b + r) / (2 * a), (-b - r) / (2 * a));
    }
  }
  return ts.filter((t) => t > 0 && t < 1);
}

export function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

/** Exact bounds of the curves (not of the handles). Null for an empty path. */
export function subsBounds(subs: SubPath[]): Box | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (p: Pt) => {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  };
  for (const sub of subs) {
    for (const a of sub.anchors) add(a);
    for (const s of segments(sub)) {
      const straight = s[0].x === s[1].x && s[0].y === s[1].y && s[2].x === s[3].x && s[2].y === s[3].y;
      if (straight) continue;
      for (const t of cubicExtrema(s[0].x, s[1].x, s[2].x, s[3].x)) add(cubicAt(s, t));
      for (const t of cubicExtrema(s[0].y, s[1].y, s[2].y, s[3].y)) add(cubicAt(s, t));
    }
  }
  return x0 === Infinity ? null : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Splits a cubic at t into two cubics (de Casteljau). */
export function splitCubic(s: [Pt, Pt, Pt, Pt], t: number): [[Pt, Pt, Pt, Pt], [Pt, Pt, Pt, Pt]] {
  const l = (a: Pt, b: Pt): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const ab = l(s[0], s[1]);
  const bc = l(s[1], s[2]);
  const cd = l(s[2], s[3]);
  const abc = l(ab, bc);
  const bcd = l(bc, cd);
  const mid = l(abc, bcd);
  return [[s[0], ab, abc, mid], [mid, bcd, cd, s[3]]];
}

export interface PathHit {
  sub: number;
  /** index of the segment's first anchor */
  seg: number;
  t: number;
  point: Pt;
  distance: number;
}

/** The point on the path nearest to (x, y). */
export function nearestOnPath(subs: SubPath[], x: number, y: number): PathHit | null {
  let best: PathHit | null = null;
  subs.forEach((sub, si) => {
    segments(sub).forEach((s, gi) => {
      // coarse sampling, then a few rounds of refinement around the best sample
      let bt = 0;
      let bd = Infinity;
      const N = 24;
      for (let i = 0; i <= N; i++) {
        const p = cubicAt(s, i / N);
        const d = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (d < bd) {
          bd = d;
          bt = i / N;
        }
      }
      let step = 1 / N;
      for (let k = 0; k < 18; k++) {
        step /= 2;
        for (const t of [bt - step, bt + step]) {
          if (t < 0 || t > 1) continue;
          const p = cubicAt(s, t);
          const d = (p.x - x) ** 2 + (p.y - y) ** 2;
          if (d < bd) {
            bd = d;
            bt = t;
          }
        }
      }
      if (!best || bd < best.distance ** 2) best = { sub: si, seg: gi, t: bt, point: cubicAt(s, bt), distance: Math.sqrt(bd) };
    });
  });
  return best;
}

/** Adds an anchor on a segment at t without changing the curve's shape. */
export function insertAnchor(subs: SubPath[], hit: { sub: number; seg: number; t: number }): { subs: SubPath[]; index: number } {
  const sub = subs[hit.sub];
  const n = sub.anchors.length;
  const s = segments(sub)[hit.seg];
  const [l, r] = splitCubic(s, hit.t);
  const a = sub.anchors[hit.seg];
  const b = sub.anchors[(hit.seg + 1) % n];
  const mid: Anchor = { x: l[3].x, y: l[3].y, ix: l[2].x, iy: l[2].y, ox: r[1].x, oy: r[1].y, smooth: true };
  const anchors = [...sub.anchors];
  anchors[hit.seg] = { ...a, ox: l[1].x, oy: l[1].y };
  anchors[(hit.seg + 1) % n] = { ...b, ix: r[2].x, iy: r[2].y };
  anchors.splice(hit.seg + 1, 0, mid);
  return { subs: subs.map((x, i) => (i === hit.sub ? { ...sub, anchors } : x)), index: hit.seg + 1 };
}

/** Catmull-Rom style automatic handles through every smooth anchor (the curvature tool's shape). */
export function autoSmooth(sub: SubPath): SubPath {
  const a = sub.anchors;
  const n = a.length;
  if (n < 2) return sub;
  const anchors = a.map((p, i): Anchor => {
    if (p.smooth === false) return { ...p, ix: p.x, iy: p.y, ox: p.x, oy: p.y };
    const prev = sub.closed ? a[(i - 1 + n) % n] : a[i - 1];
    const next = sub.closed ? a[(i + 1) % n] : a[i + 1];
    if (!prev && !next) return p;
    if (!prev || !next) {
      // an end of an open path: aim a third of the way at the neighbour's far side
      return { ...p, ix: p.x, iy: p.y, ox: p.x, oy: p.y, smooth: true };
    }
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const dIn = Math.hypot(p.x - prev.x, p.y - prev.y) / 3;
    const dOut = Math.hypot(next.x - p.x, next.y - p.y) / 3;
    return { ...p, ix: p.x - (dx / len) * dIn, iy: p.y - (dy / len) * dIn, ox: p.x + (dx / len) * dOut, oy: p.y + (dy / len) * dOut, smooth: true };
  });
  return { ...sub, anchors };
}

// ── SVG path data ──────────────────────────────────────────────────────────

/** Compact number for SVG output (up to 3 decimals, no trailing zeros). */
export function num(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

export function subsToD(subs: SubPath[]): string {
  let d = '';
  for (const sub of subs) {
    const a = sub.anchors;
    if (!a.length) continue;
    d += `M${num(a[0].x)} ${num(a[0].y)}`;
    const n = a.length;
    const count = sub.closed ? n : n - 1;
    for (let i = 0; i < count; i++) {
      const p = a[i];
      const q = a[(i + 1) % n];
      const straight = p.ox === p.x && p.oy === p.y && q.ix === q.x && q.iy === q.y;
      // the closing line of a closed path is drawn by Z
      if (straight && sub.closed && i === count - 1) continue;
      d += straight ? `L${num(q.x)} ${num(q.y)}` : `C${num(p.ox)} ${num(p.oy)} ${num(q.ix)} ${num(q.iy)} ${num(q.x)} ${num(q.y)}`;
    }
    if (sub.closed) d += 'Z';
  }
  return d;
}

/** An elliptical arc (SVG endpoint form) as cubic segments: [c1x, c1y, c2x, c2y, x, y][]. */
function arcToCubics(x0: number, y0: number, rx: number, ry: number, rotation: number, large: boolean, sweep: boolean, x: number, y: number): number[][] {
  if (!rx || !ry) return [[x0, y0, x, y, x, y]];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (rotation * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx = (x0 - x) / 2;
  const dy = (y0 - y) / 2;
  const x1 = cosP * dx + sinP * dy;
  const y1 = -sinP * dx + cosP * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const sign = large === sweep ? -1 : 1;
  const numer = Math.max(0, rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1);
  const coef = sign * Math.sqrt(numer / (rx * rx * y1 * y1 + ry * ry * x1 * x1 || 1e-12));
  const cxp = (coef * rx * y1) / ry;
  const cyp = (-coef * ry * x1) / rx;
  const cx = cosP * cxp - sinP * cyp + (x0 + x) / 2;
  const cy = sinP * cxp + cosP * cyp + (y0 + y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let dt = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const pieces = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const step = dt / pieces;
  const k = (4 / 3) * Math.tan(step / 4);
  const out: number[][] = [];
  const at = (t: number): [number, number, number, number] => {
    const c = Math.cos(t);
    const s = Math.sin(t);
    // point and derivative on the rotated ellipse
    return [cx + rx * c * cosP - ry * s * sinP, cy + rx * c * sinP + ry * s * cosP, -rx * s * cosP - ry * c * sinP, -rx * s * sinP + ry * c * cosP];
  };
  for (let i = 0; i < pieces; i++) {
    const a = at(t1 + i * step);
    const b = at(t1 + (i + 1) * step);
    out.push([a[0] + k * a[2], a[1] + k * a[3], b[0] - k * b[2], b[1] - k * b[3], b[0], b[1]]);
  }
  return out;
}

/** Parses SVG path data into subpaths of cubic anchors. Malformed tails are dropped, as browsers do. */
export function parseD(d: string): SubPath[] {
  const subs: SubPath[] = [];
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  /** reflection point for S / T */
  let px = 0;
  let py = 0;
  let prev = '';
  let cur: SubPath | null = null;
  const next = () => parseFloat(tokens[i++]);
  const has = () => i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i]);
  // arc flags may be glued to the next number ("a1 1 0 01100 50")
  const flag = (): boolean => {
    const t = tokens[i];
    if (t.length > 1 && /^[01]/.test(t) && !/^[01]\./.test(t) && !/^[01][eE]/.test(t)) {
      tokens[i] = t.slice(1);
      return t[0] === '1';
    }
    i++;
    return t === '1';
  };
  const start = (nx: number, ny: number) => {
    cur = { anchors: [corner(nx, ny)], closed: false };
    subs.push(cur);
    sx = nx;
    sy = ny;
  };
  const ensure = () => {
    if (!cur) start(x, y);
  };
  const curveTo = (c1x: number, c1y: number, c2x: number, c2y: number, nx: number, ny: number) => {
    ensure();
    const a = cur!.anchors;
    const last = a[a.length - 1];
    a[a.length - 1] = { ...last, ox: c1x, oy: c1y };
    a.push({ x: nx, y: ny, ix: c2x, iy: c2y, ox: nx, oy: ny });
  };
  const lineTo = (nx: number, ny: number) => {
    ensure();
    cur!.anchors.push(corner(nx, ny));
  };
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const c = cmd.toUpperCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    if (c === 'Z') {
      if (cur) {
        const sub: SubPath = cur;
        sub.closed = true;
        // a closing curve that ends on the start point: fold it into the first anchor
        const a = sub.anchors;
        const last = a[a.length - 1];
        if (a.length > 1 && Math.abs(last.x - a[0].x) < 1e-6 && Math.abs(last.y - a[0].y) < 1e-6) {
          a[0] = { ...a[0], ix: last.ix, iy: last.iy };
          a.pop();
        }
      }
      x = sx;
      y = sy;
      cur = null;
      prev = c;
      // a path may go on after Z without a new M
      if (has()) cmd = '';
      continue;
    }
    if (!has()) break;
    switch (c) {
      case 'M':
        x = ox + next();
        y = oy + next();
        start(x, y);
        // further pairs are implicit line-tos
        cmd = rel ? 'l' : 'L';
        break;
      case 'L':
        x = ox + next();
        y = oy + next();
        lineTo(x, y);
        break;
      case 'H':
        x = ox + next();
        lineTo(x, y);
        break;
      case 'V':
        y = oy + next();
        lineTo(x, y);
        break;
      case 'C': {
        const c1x = ox + next();
        const c1y = oy + next();
        const c2x = ox + next();
        const c2y = oy + next();
        x = ox + next();
        y = oy + next();
        curveTo(c1x, c1y, c2x, c2y, x, y);
        px = c2x;
        py = c2y;
        break;
      }
      case 'S': {
        const c1x = prev === 'C' || prev === 'S' ? 2 * x - px : x;
        const c1y = prev === 'C' || prev === 'S' ? 2 * y - py : y;
        const c2x = ox + next();
        const c2y = oy + next();
        x = ox + next();
        y = oy + next();
        curveTo(c1x, c1y, c2x, c2y, x, y);
        px = c2x;
        py = c2y;
        break;
      }
      case 'Q':
      case 'T': {
        let qx: number;
        let qy: number;
        if (c === 'Q') {
          qx = ox + next();
          qy = oy + next();
        } else {
          qx = prev === 'Q' || prev === 'T' ? 2 * x - px : x;
          qy = prev === 'Q' || prev === 'T' ? 2 * y - py : y;
        }
        const nx = ox + next();
        const ny = oy + next();
        curveTo(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), nx + (2 / 3) * (qx - nx), ny + (2 / 3) * (qy - ny), nx, ny);
        px = qx;
        py = qy;
        x = nx;
        y = ny;
        break;
      }
      case 'A': {
        const rx = next();
        const ry = next();
        const rot = next();
        const large = flag();
        const sweep = flag();
        const nx = ox + next();
        const ny = oy + next();
        for (const s of arcToCubics(x, y, rx, ry, rot, large, sweep, nx, ny)) curveTo(s[0], s[1], s[2], s[3], s[4], s[5]);
        x = nx;
        y = ny;
        break;
      }
      default:
        // unknown command: stop, keeping what was read
        i = tokens.length;
    }
    prev = c;
    if (Number.isNaN(x) || Number.isNaN(y)) break;
  }
  return subs.filter((s) => s.anchors.length > 0 && s.anchors.every((a) => Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.ix) && Number.isFinite(a.ox)));
}

// ── primitive shapes ───────────────────────────────────────────────────────

/** Bézier circle constant: handle length for a quarter circle of radius 1. */
const KAPPA = 0.5522847498307936;

export function rectSubs(x: number, y: number, w: number, h: number, r = 0): SubPath[] {
  r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  if (!r) return [{ closed: true, anchors: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)] }];
  const k = r * (1 - KAPPA);
  const a = (px: number, py: number, ix: number, iy: number, ox: number, oy: number): Anchor => ({ x: px, y: py, ix, iy, ox, oy });
  return [{
    closed: true,
    anchors: [
      a(x + r, y, x + k, y, x + r, y),
      a(x + w - r, y, x + w - r, y, x + w - k, y),
      a(x + w, y + r, x + w, y + k, x + w, y + r),
      a(x + w, y + h - r, x + w, y + h - r, x + w, y + h - k),
      a(x + w - r, y + h, x + w - k, y + h, x + w - r, y + h),
      a(x + r, y + h, x + r, y + h, x + k, y + h),
      a(x, y + h - r, x, y + h - k, x, y + h - r),
      a(x, y + r, x, y + r, x, y + k),
    ],
  }];
}

export function ellipseSubs(cx: number, cy: number, rx: number, ry: number): SubPath[] {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [{
    closed: true,
    anchors: [
      { x: cx, y: cy - ry, ix: cx - kx, iy: cy - ry, ox: cx + kx, oy: cy - ry, smooth: true },
      { x: cx + rx, y: cy, ix: cx + rx, iy: cy - ky, ox: cx + rx, oy: cy + ky, smooth: true },
      { x: cx, y: cy + ry, ix: cx + kx, iy: cy + ry, ox: cx - kx, oy: cy + ry, smooth: true },
      { x: cx - rx, y: cy, ix: cx - rx, iy: cy + ky, ox: cx - rx, oy: cy - ky, smooth: true },
    ],
  }];
}

export function polygonSubs(cx: number, cy: number, radius: number, sides: number, rotation = -Math.PI / 2): SubPath[] {
  const n = Math.max(3, Math.round(sides));
  const anchors: Anchor[] = [];
  for (let i = 0; i < n; i++) {
    const a = rotation + (i * 2 * Math.PI) / n;
    anchors.push(corner(cx + radius * Math.cos(a), cy + radius * Math.sin(a)));
  }
  return [{ closed: true, anchors }];
}

export function starSubs(cx: number, cy: number, outer: number, inner: number, points: number, rotation = -Math.PI / 2): SubPath[] {
  const n = Math.max(3, Math.round(points));
  const anchors: Anchor[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = rotation + (i * Math.PI) / n;
    const r = i % 2 ? inner : outer;
    anchors.push(corner(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  return [{ closed: true, anchors }];
}

export function lineSubs(x0: number, y0: number, x1: number, y1: number): SubPath[] {
  return [{ closed: false, anchors: [corner(x0, y0), corner(x1, y1)] }];
}

// ── text layout (shared by the renderer, bounds and outlines) ──────────────

/** Measures a run of text in px; the browser supplies a canvas-backed one, tests use the estimate. */
export type Measure = (text: string, node: Pick<TextNode, 'family' | 'size' | 'weight' | 'italic' | 'tracking'>) => number;

export const estimateMeasure: Measure = (text, node) => text.length * (node.size * 0.55 + (node.tracking / 1000) * node.size);

/** The lines a text object is drawn as: point text splits on newlines, area text also wraps to its width. */
export function textLines(node: TextNode, measure: Measure = estimateMeasure): string[] {
  const paragraphs = node.text.split('\n');
  if (node.kind !== 'area' || !node.width) return paragraphs;
  const lines: string[] = [];
  for (const para of paragraphs) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      if (line && measure((line + w).trimEnd(), node) > node.width) {
        lines.push(line.trimEnd());
        line = /^\s+$/.test(w) ? '' : w;
      } else line += w;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** The text block's box in its own (untransformed) space. */
export function textLocalBox(node: TextNode, measure: Measure = estimateMeasure): Box {
  if (node.kind === 'path' && node.path) {
    const b = subsBounds(node.path) ?? { x: node.x, y: node.y, width: 0, height: 0 };
    return { x: b.x - node.size, y: b.y - node.size, width: b.width + node.size * 2, height: b.height + node.size * 2 };
  }
  const lines = textLines(node, measure);
  const lh = node.size * node.leading;
  if (node.kind === 'area') return { x: node.x, y: node.y, width: node.width ?? 0, height: Math.max(node.height ?? 0, lines.length * lh) };
  const width = Math.max(1, ...lines.map((l) => measure(l, node)));
  const x = node.align === 'center' ? node.x - width / 2 : node.align === 'right' ? node.x - width : node.x;
  return { x, y: node.y - node.size * 0.8, width, height: (lines.length - 1) * lh + node.size * 1.05 };
}

// ── node bounds and transforms ─────────────────────────────────────────────

function boxOfPoints(pts: Pt[]): Box {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function transformBox(b: Box, m: Mat): Box {
  return boxOfPoints([apply(m, b.x, b.y), apply(m, b.x + b.width, b.y), apply(m, b.x + b.width, b.y + b.height), apply(m, b.x, b.y + b.height)]);
}

/** Geometric bounds of a node in document space (strokes are not included). */
export function nodeBounds(node: VNode, measure: Measure = estimateMeasure): Box | null {
  switch (node.type) {
    case 'path':
      return subsBounds(node.subs);
    case 'image':
      return transformBox({ x: node.x, y: node.y, width: node.width, height: node.height }, node.matrix);
    case 'text':
      return transformBox(textLocalBox(node, measure), node.matrix);
    case 'group': {
      if (node.clip && node.children[0]) return nodeBounds(node.children[0], measure);
      let box: Box | null = null;
      for (const c of node.children) box = unionBox(box, nodeBounds(c, measure));
      return box;
    }
  }
}

export function boundsOfNodes(nodes: VNode[], measure: Measure = estimateMeasure): Box | null {
  let box: Box | null = null;
  for (const n of nodes) box = unionBox(box, nodeBounds(n, measure));
  return box;
}

/** Applies an affine transform to a node (paths are rewritten; text and images take it in their matrix). */
export function transformNode<T extends VNode>(node: T, m: Mat): T {
  switch (node.type) {
    case 'path':
      return { ...node, subs: transformSubs(node.subs, m) };
    case 'image':
    case 'text':
      return { ...node, matrix: mul(m, node.matrix) };
    case 'group':
      return { ...node, children: node.children.map((c) => transformNode(c, m)) };
  }
  return node;
}

export function pathNode(subs: SubPath[], style: Omit<PathNode, 'id' | 'type' | 'subs' | 'opacity'>, id: string): PathNode {
  return { ...style, id, type: 'path', opacity: 1, subs };
}
