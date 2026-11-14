/**
 * Path operations that need real computational geometry: boolean combinations (Pathfinder,
 * Shape Builder), cutting (Scissors, Eraser), curve fitting (Pencil, Blob Brush, Simplify) and
 * stroke outlining. They are done by Paper.js on Bézier curves directly, so results keep their
 * curves instead of becoming polygons.
 *
 * Paper is loaded on demand (`loadGeom`) and used headless: it never touches a canvas. Under
 * Node (tests) it runs in its web-worker mode, which needs a global `self`.
 */
import type { Anchor, PathNode, SubPath } from './model';
import { newId, styleOf } from './model';
import { segments, subsBounds, subsToD, cubicAt, type Pt } from './path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Paper = any;
let scope: Paper | null = null;
let loading: Promise<void> | null = null;

/** Loads the geometry engine. Every other function in this file requires it to have resolved. */
export function loadGeom(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      const g = globalThis as unknown as { self?: unknown };
      if (typeof g.self === 'undefined') g.self = globalThis;
      const mod = (await import('paper/dist/paper-core')) as Paper;
      const paper = mod.default ?? mod;
      scope = new paper.PaperScope();
      scope.setup(new paper.Size(1, 1));
      // nothing is ever drawn: keep created items out of the project
      scope.settings.insertItems = false;
    })();
  }
  return loading;
}

function P(): Paper {
  if (!scope) throw new Error('The path engine is still loading.');
  return scope;
}

function toItem(subs: SubPath[], fillRule: 'nonzero' | 'evenodd' = 'nonzero'): Paper {
  const p = P();
  const item = new p.CompoundPath({ insert: false });
  for (const sub of subs) {
    if (!sub.anchors.length) continue;
    const path = new p.Path({ insert: false, closed: sub.closed });
    for (const a of sub.anchors) path.add(new p.Segment(new p.Point(a.x, a.y), new p.Point(a.ix - a.x, a.iy - a.y), new p.Point(a.ox - a.x, a.oy - a.y)));
    item.addChild(path);
  }
  item.fillRule = fillRule;
  return item;
}

function fromPath(path: Paper): SubPath | null {
  const segs = path.segments as Paper[];
  if (!segs || segs.length < 2) return null;
  const anchors: Anchor[] = segs.map((s: Paper) => {
    const x = s.point.x;
    const y = s.point.y;
    const hi = s.handleIn;
    const ho = s.handleOut;
    const smooth = !hi.isZero() && !ho.isZero() && Math.abs(hi.x * ho.y - hi.y * ho.x) < 1e-3 * (hi.length * ho.length || 1) && hi.dot(ho) < 0;
    return { x, y, ix: x + hi.x, iy: y + hi.y, ox: x + ho.x, oy: y + ho.y, ...(smooth ? { smooth: true } : {}) };
  });
  return { anchors, closed: !!path.closed };
}

function fromItem(item: Paper): SubPath[] {
  if (!item) return [];
  const paths: Paper[] = item.children ? item.children : [item];
  const out: SubPath[] = [];
  for (const p of paths) {
    if (p.children) out.push(...fromItem(p));
    else {
      const s = fromPath(p);
      // boolean results can leave zero-area slivers behind
      if (s && (!s.closed || Math.abs(p.area) > 1e-4)) out.push(s);
    }
  }
  return out;
}

export type BooleanOp = 'unite' | 'minus-front' | 'minus-back' | 'intersect' | 'exclude' | 'divide' | 'trim' | 'merge' | 'crop' | 'outline';

function styled(subs: SubPath[], from: PathNode): PathNode {
  return { ...from, id: newId(), subs };
}

/** Whether a paint is the same solid colour (Merge only fuses same-coloured shapes). */
function sameFill(a: PathNode, b: PathNode): boolean {
  return a.fill.type === 'solid' && b.fill.type === 'solid' && a.fill.color === b.fill.color && (a.fill.alpha ?? 1) === (b.fill.alpha ?? 1);
}

/**
 * Pathfinder. `nodes` are in stacking order, bottom first. Shape modes return one object
 * styled like the frontmost (as Illustrator does); the pathfinders return the pieces.
 */
export function pathfinder(op: BooleanOp, nodes: PathNode[]): PathNode[] {
  if (nodes.length < 2) return nodes;
  const items = nodes.map((n) => toItem(n.subs, n.fillRule));
  const top = nodes[nodes.length - 1];
  const out = (item: Paper, from: PathNode): PathNode[] => {
    const subs = fromItem(item);
    return subs.length ? [styled(subs, { ...from, fillRule: 'nonzero' })] : [];
  };
  switch (op) {
    case 'unite': {
      let acc = items[0];
      for (let i = 1; i < items.length; i++) acc = acc.unite(items[i], { insert: false });
      return out(acc, top);
    }
    case 'intersect': {
      let acc = items[0];
      for (let i = 1; i < items.length; i++) acc = acc.intersect(items[i], { insert: false });
      return out(acc, top);
    }
    case 'exclude': {
      let acc = items[0];
      for (let i = 1; i < items.length; i++) acc = acc.exclude(items[i], { insert: false });
      return out(acc, top);
    }
    case 'minus-front': {
      let acc = items[0];
      for (let i = 1; i < items.length; i++) acc = acc.subtract(items[i], { insert: false });
      return out(acc, nodes[0]);
    }
    case 'minus-back': {
      let acc = items[items.length - 1];
      for (let i = 0; i < items.length - 1; i++) acc = acc.subtract(items[i], { insert: false });
      return out(acc, top);
    }
    case 'divide':
      return regions(nodes).map((r) => styled(r.subs, { ...nodes[r.top], fillRule: 'nonzero' }));
    case 'trim':
    case 'merge': {
      // every object loses what the objects above it cover; strokes are removed
      const pieces: PathNode[] = [];
      for (let i = 0; i < items.length; i++) {
        let acc = items[i];
        for (let j = i + 1; j < items.length; j++) acc = acc.subtract(items[j], { insert: false });
        pieces.push(...out(acc, { ...nodes[i], stroke: { type: 'none' } }));
      }
      if (op === 'trim') return pieces;
      const merged: PathNode[] = [];
      for (const p of pieces) {
        const mate = merged.findIndex((m) => sameFill(m, p));
        if (mate < 0) merged.push(p);
        else merged[mate] = styled(fromItem(toItem(merged[mate].subs).unite(toItem(p.subs), { insert: false })), merged[mate]);
      }
      return merged;
    }
    case 'crop': {
      // the frontmost object is the cookie cutter
      const cutter = items[items.length - 1];
      return nodes.slice(0, -1).flatMap((n, i) => out(items[i].intersect(cutter, { insert: false }), { ...n, stroke: { type: 'none' } }));
    }
    case 'outline': {
      // the edges of the divided pieces, as unfilled strokes
      return regions(nodes).map((r) => ({ ...styled(r.subs, nodes[r.top]), fill: { type: 'none' }, stroke: nodes[r.top].fill.type === 'solid' ? nodes[r.top].fill : { type: 'solid', color: '#000000' }, strokeWidth: 1 }));
    }
  }
}

export interface Region {
  subs: SubPath[];
  /** indexes (into the input) of the shapes that cover this region */
  sources: number[];
  /** the frontmost of them: its appearance is the region's */
  top: number;
}

/**
 * Cuts overlapping shapes into the distinct regions they form (the Shape Builder's pieces, and
 * Pathfinder ▸ Divide). Each region knows which shapes cover it.
 */
export function regions(nodes: PathNode[]): Region[] {
  let pieces: { item: Paper; sources: number[] }[] = [];
  nodes.forEach((n, i) => {
    const shape = toItem(n.subs, n.fillRule);
    const next: typeof pieces = [];
    let rest = shape;
    for (const p of pieces) {
      const both = p.item.intersect(shape, { insert: false });
      const only = p.item.subtract(shape, { insert: false });
      if (!both.isEmpty() && Math.abs(both.area) > 1e-3) next.push({ item: both, sources: [...p.sources, i] });
      if (!only.isEmpty() && Math.abs(only.area) > 1e-3) next.push({ item: only, sources: p.sources });
      rest = rest.subtract(p.item, { insert: false });
    }
    if (!rest.isEmpty() && Math.abs(rest.area) > 1e-3) next.push({ item: rest, sources: [i] });
    pieces = next;
  });
  const out: Region[] = [];
  for (const p of pieces) {
    // a piece made of separate islands is several regions
    const kids: Paper[] = p.item.children ?? [p.item];
    const outers = kids.filter((k) => k.clockwise === kids[0].clockwise);
    if (outers.length <= 1) {
      const subs = fromItem(p.item);
      if (subs.length) out.push({ subs, sources: p.sources, top: Math.max(...p.sources) });
      continue;
    }
    for (const outer of outers) {
      const holes = kids.filter((k) => k !== outer && k.clockwise !== outer.clockwise && outer.contains(k.interiorPoint));
      const subs = [outer, ...holes].map(fromPath).filter((s): s is SubPath => !!s);
      if (subs.length) out.push({ subs, sources: p.sources, top: Math.max(...p.sources) });
    }
  }
  return out;
}

export function containsPoint(subs: SubPath[], x: number, y: number, fillRule: 'nonzero' | 'evenodd' = 'nonzero'): boolean {
  return toItem(subs, fillRule).contains(new (P().Point)(x, y));
}

/** Unites several outlines into one (merging Shape Builder regions, joining blob-brush strokes). */
export function uniteSubs(list: SubPath[][]): SubPath[] {
  if (!list.length) return [];
  let acc = toItem(list[0]);
  for (let i = 1; i < list.length; i++) acc = acc.unite(toItem(list[i]), { insert: false });
  return fromItem(acc);
}

export function subtractSubs(a: SubPath[], b: SubPath[], fillRule: 'nonzero' | 'evenodd' = 'nonzero'): SubPath[] {
  return fromItem(toItem(a, fillRule).subtract(toItem(b), { insert: false }));
}

export function intersects(a: SubPath[], b: SubPath[]): boolean {
  const A = toItem(a);
  const B = toItem(b);
  if (A.getIntersections(B).length) return true;
  const fa = a[0]?.anchors[0];
  const fb = b[0]?.anchors[0];
  return (!!fb && A.contains(new (P().Point)(fb.x, fb.y))) || (!!fa && B.contains(new (P().Point)(fa.x, fa.y)));
}

/** Fits smooth curves through freehand points (Pencil). `tolerance` is in document units. */
export function fitCurve(points: Pt[], tolerance: number, closed = false): SubPath | null {
  if (points.length < 2) return null;
  const p = P();
  const path = new p.Path({ insert: false, segments: points.map((q) => [q.x, q.y]) });
  path.closed = closed;
  if (points.length > 2) path.simplify(Math.max(0.01, tolerance));
  return fromPath(path);
}

/** Re-fits a path with fewer anchors (Object ▸ Path ▸ Simplify). */
export function simplifySubs(subs: SubPath[], tolerance: number): SubPath[] {
  const out: SubPath[] = [];
  for (const sub of subs) {
    const item = toItem([sub]).children[0];
    if (!item) continue;
    // sample the curve itself so simplifying starts from its true shape
    const flat = item.clone({ insert: false });
    flat.flatten(Math.max(0.05, tolerance / 4));
    flat.simplify(Math.max(0.01, tolerance));
    const s = fromPath(flat);
    out.push(s && s.anchors.length < sub.anchors.length ? s : sub);
  }
  return out;
}

/** The path as short straight pieces (one polyline per subpath). */
export function flatten(subs: SubPath[], tolerance = 0.25): { points: Pt[]; closed: boolean }[] {
  const out: { points: Pt[]; closed: boolean }[] = [];
  for (const sub of subs) {
    const points: Pt[] = [];
    if (sub.anchors.length) points.push({ x: sub.anchors[0].x, y: sub.anchors[0].y });
    for (const s of segments(sub)) {
      const straight = s[0].x === s[1].x && s[0].y === s[1].y && s[2].x === s[3].x && s[2].y === s[3].y;
      // steps from the control polygon's length: enough that no piece bends by more than the tolerance
      const len = Math.hypot(s[1].x - s[0].x, s[1].y - s[0].y) + Math.hypot(s[2].x - s[1].x, s[2].y - s[1].y) + Math.hypot(s[3].x - s[2].x, s[3].y - s[2].y);
      const steps = straight ? 1 : Math.max(2, Math.min(64, Math.ceil(Math.sqrt(len / Math.max(0.01, tolerance)) * 0.9)));
      for (let i = 1; i <= steps; i++) points.push(cubicAt(s, i / steps));
    }
    if (sub.closed && points.length > 1) points.pop();
    out.push({ points, closed: sub.closed });
  }
  return out;
}

function polyItem(points: Pt[]): Paper {
  return new (P().Path)({ insert: false, closed: true, segments: points.map((q) => [q.x, q.y]) });
}

/**
 * The outline of a stroke of `width` along polylines, as one filled shape. Built as the union
 * of a box around every segment and a disc on every vertex (round joins and caps), which is
 * robust for any self-crossing scribble where offsetting each side is not.
 */
function strokeShape(lines: { points: Pt[]; closed: boolean }[], width: number, cap: 'butt' | 'round' | 'square', join: 'miter' | 'round' | 'bevel' = 'round', miter = 4): Paper {
  const p = P();
  const r = width / 2;
  const compound = new p.CompoundPath({ insert: false });
  const disc = (c: Pt) => {
    const n = Math.max(8, Math.min(24, Math.round(r * 1.5) + 8));
    const pts: Pt[] = [];
    for (let i = 0; i < n; i++) pts.push({ x: c.x + r * Math.cos((i * 2 * Math.PI) / n), y: c.y + r * Math.sin((i * 2 * Math.PI) / n) });
    compound.addChild(polyItem(pts));
  };
  for (const line of lines) {
    const pts = line.points.filter((q, i, a) => i === 0 || Math.hypot(q.x - a[i - 1].x, q.y - a[i - 1].y) > 1e-6);
    if (pts.length === 1) {
      disc(pts[0]);
      continue;
    }
    const n = pts.length;
    const count = line.closed ? n : n - 1;
    for (let i = 0; i < count; i++) {
      let a = pts[i];
      let b = pts[(i + 1) % n];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      if (!line.closed && cap === 'square') {
        if (i === 0) a = { x: a.x - ux * r, y: a.y - uy * r };
        if (i === count - 1) b = { x: b.x + ux * r, y: b.y + uy * r };
      }
      const nx = -uy * r;
      const ny = ux * r;
      // counter-clockwise in screen space so every piece winds the same way
      const quad = polyItem([{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }]);
      if (!quad.clockwise) quad.reverse();
      compound.addChild(quad);
    }
    for (let i = 0; i < n; i++) {
      const end = !line.closed && (i === 0 || i === n - 1);
      if (end) {
        if (cap === 'round') disc(pts[i]);
        continue;
      }
      if (join === 'round') {
        disc(pts[i]);
        continue;
      }
      // miter / bevel: fill the wedge on the outside of the corner
      const v = pts[i];
      const a = pts[(i - 1 + n) % n];
      const b = pts[(i + 1) % n];
      const l1 = Math.hypot(v.x - a.x, v.y - a.y);
      const l2 = Math.hypot(b.x - v.x, b.y - v.y);
      const u1 = { x: (v.x - a.x) / l1, y: (v.y - a.y) / l1 };
      const u2 = { x: (b.x - v.x) / l2, y: (b.y - v.y) / l2 };
      const cross = u1.x * u2.y - u1.y * u2.x;
      if (Math.abs(cross) < 1e-6) continue;
      const s = cross > 0 ? -1 : 1;
      const n1 = { x: -u1.y * r * s, y: u1.x * r * s };
      const n2 = { x: -u2.y * r * s, y: u2.x * r * s };
      const cos = u1.x * u2.x + u1.y * u2.y;
      const wedge: Pt[] = [v, { x: v.x + n1.x, y: v.y + n1.y }];
      if (join === 'miter' && Math.sqrt(2 / Math.max(1e-9, 1 + cos)) <= miter) wedge.push({ x: v.x + (n1.x + n2.x) / (1 + cos), y: v.y + (n1.y + n2.y) / (1 + cos) });
      wedge.push({ x: v.x + n2.x, y: v.y + n2.y });
      compound.addChild(polyItem(wedge));
    }
  }
  for (const c of compound.children as Paper[]) if (!c.clockwise) c.reverse();
  compound.fillRule = 'nonzero';
  return compound.unite(undefined, { insert: false });
}

/** Object ▸ Path ▸ Outline Stroke: the stroke as a filled shape. */
export function outlineStroke(node: PathNode): SubPath[] {
  const tol = Math.max(0.1, Math.min(1, node.strokeWidth / 12));
  const shape = strokeShape(flatten(node.subs, tol), node.strokeWidth, node.cap, node.join, node.miter);
  return fromItem(shape);
}

/**
 * A brush stroke as a filled shape (Blob Brush, and the Eraser's cut). The freehand points are
 * thinned first, and the outline is re-fitted with curves so it isn't a polygon of hundreds
 * of tiny edges.
 */
export function brushShape(points: Pt[], width: number): SubPath[] {
  const thin: Pt[] = [];
  const step = Math.max(0.75, width / 5);
  for (const q of points) {
    const last = thin[thin.length - 1];
    if (!last || Math.hypot(q.x - last.x, q.y - last.y) >= step) thin.push(q);
  }
  const end = points[points.length - 1];
  if (end && thin[thin.length - 1] !== end) thin.push(end);
  if (!thin.length) return [];
  const shape = strokeShape([{ points: thin, closed: false }], width, 'round');
  const out: SubPath[] = [];
  const kids: Paper[] = shape.children ?? [shape];
  for (const k of kids) {
    if (Math.abs(k.area) < 0.5) continue;
    k.simplify(Math.max(0.15, width / 40));
    const s = fromPath(k);
    if (s) out.push(s);
  }
  return out;
}

/** Grows (d > 0) or shrinks (d < 0) a closed shape by d (Object ▸ Path ▸ Offset Path). */
export function offsetSubs(subs: SubPath[], d: number): SubPath[] {
  if (!d) return subs;
  const band = strokeShape(flatten(subs, Math.max(0.1, Math.abs(d) / 12)), Math.abs(d) * 2, 'round');
  const shape = toItem(subs);
  return fromItem(d > 0 ? shape.unite(band, { insert: false }) : shape.subtract(band, { insert: false }));
}

/**
 * Scissors: cuts a path at the point nearest (x, y). An open path becomes two paths; a closed
 * one opens at that point. Returns the pieces, or null when the point is not on the path.
 */
export function cutPath(subs: SubPath[], x: number, y: number, tolerance: number): SubPath[][] | null {
  const p = P();
  const point = new p.Point(x, y);
  for (let i = 0; i < subs.length; i++) {
    const path = toItem([subs[i]]).children[0];
    if (!path) continue;
    const loc = path.getNearestLocation(point);
    if (!loc || loc.point.getDistance(point) > tolerance) continue;
    const others = subs.filter((_, j) => j !== i);
    if (path.closed) {
      path.splitAt(loc);
      const s = fromPath(path);
      return s ? [[...others, { ...s, closed: false }]] : null;
    }
    const tail = path.splitAt(loc);
    const a = fromPath(path);
    const b = tail ? fromPath(tail) : null;
    const pieces = [a, b].filter((s): s is SubPath => !!s).map((s) => [s]);
    if (pieces.length < 2) return null;
    // other subpaths stay with the first piece
    pieces[0] = [...others, ...pieces[0]];
    return pieces;
  }
  return null;
}

/** Joins the open ends of paths: two open paths become one, a single open path closes. */
export function joinSubs(list: SubPath[]): SubPath[] {
  const open = list.filter((s) => !s.closed && s.anchors.length > 1);
  const rest = list.filter((s) => s.closed || s.anchors.length < 2);
  if (!open.length) return list;
  if (open.length === 1) return [...rest, { ...open[0], closed: true }];
  const chain = [...open];
  while (chain.length > 1) {
    // join the pair of ends that are closest together
    let best = { i: 0, j: 1, ri: false, rj: false, d: Infinity };
    for (let i = 0; i < chain.length; i++) {
      for (let j = i + 1; j < chain.length; j++) {
        const a = chain[i].anchors;
        const b = chain[j].anchors;
        const ends: [Anchor, Anchor, boolean, boolean][] = [
          [a[a.length - 1], b[0], false, false],
          [a[a.length - 1], b[b.length - 1], false, true],
          [a[0], b[0], true, false],
          [a[0], b[b.length - 1], true, true],
        ];
        for (const [p, q, ri, rj] of ends) {
          const d = Math.hypot(p.x - q.x, p.y - q.y);
          if (d < best.d) best = { i, j, ri, rj, d };
        }
      }
    }
    const rev = (s: SubPath): Anchor[] => [...s.anchors].reverse().map((a) => ({ ...a, ix: a.ox, iy: a.oy, ox: a.ix, oy: a.iy }));
    const A = best.ri ? rev(chain[best.i]) : [...chain[best.i].anchors];
    const B = best.rj ? rev(chain[best.j]) : [...chain[best.j].anchors];
    let joined: Anchor[];
    if (best.d < 0.01) {
      // coincident ends fuse into one anchor
      const a = A.pop()!;
      joined = [...A, { ...a, ox: B[0].ox, oy: B[0].oy }, ...B.slice(1)];
    } else joined = [...A, ...B];
    chain.splice(best.j, 1);
    chain.splice(best.i, 1, { anchors: joined, closed: false });
  }
  return [...rest, ...chain];
}

export function reverseSubs(subs: SubPath[]): SubPath[] {
  return subs.map((s) => ({ ...s, anchors: [...s.anchors].reverse().map((a) => ({ ...a, ix: a.ox, iy: a.oy, ox: a.ix, oy: a.iy })) }));
}

/** Total length of a path, and the point a given fraction along it (text on a path's caret). */
export function pathLength(subs: SubPath[]): number {
  return (toItem(subs).children as Paper[]).reduce((n, c) => n + c.length, 0);
}

/** A path node from an outline and the appearance of another node (results of operations). */
export function derive(from: PathNode, subs: SubPath[], patch: Partial<PathNode> = {}): PathNode {
  return { ...from, ...styleOf(from), ...patch, id: newId(), type: 'path', subs };
}

export { subsBounds, subsToD };
