/**
 * The animatable properties of a visual clip, as one list: the inspector, the graph editor
 * and the command palette all work from it, so a property added here appears in each.
 */
import { PURE_FNS, dataValue, evalExpression, noise1, seedOf, type ExprContext } from './expr';
import { anim, defaultThree, valueAt, type Animatable, type Project, type Transform3D, type TransformProp, type VisualClip } from './model';

export interface AnimProp {
  id: string;
  label: string;
  group: 'Transform' | '3D' | 'Mask' | 'Text';
  /** slider range in view units */
  min: number;
  max: number;
  step: number;
  /** stored value → shown value (percentages are stored 0–1) */
  view: number;
  color: string;
  get(c: VisualClip): Animatable;
  set(c: VisualClip, a: Animatable): VisualClip;
}

const COLORS = ['#f87171', '#4ade80', '#fbbf24', '#60a5fa', '#c084fc', '#22d3ee', '#fb923c', '#f472b6', '#a3e635', '#94a3b8', '#e879f9', '#2dd4bf'];

function transformProp(key: TransformProp, label: string, min: number, max: number, step: number, view = 1): Omit<AnimProp, 'color'> {
  return {
    id: key,
    label,
    group: 'Transform',
    min,
    max,
    step,
    view,
    get: (c) => c.transform[key],
    set: (c, a) => ({ ...c, transform: { ...c.transform, [key]: a } }) as VisualClip,
  };
}

function threeProp(key: keyof Transform3D, label: string, min: number, max: number, step: number): Omit<AnimProp, 'color'> {
  return {
    id: key,
    label,
    group: '3D',
    min,
    max,
    step,
    view: 1,
    get: (c) => c.three?.[key] ?? anim(0),
    set: (c, a) => ({ ...c, three: { ...(c.three ?? defaultThree()), [key]: a } }) as VisualClip,
  };
}

/** Every property of `c` that can hold keyframes. */
export function animProps(p: Pick<Project, 'width' | 'height'>, c: VisualClip): AnimProp[] {
  const list: Omit<AnimProp, 'color'>[] = [
    transformProp('x', 'Position X', -p.width, p.width * 2, 1),
    transformProp('y', 'Position Y', -p.height, p.height * 2, 1),
    transformProp('scale', 'Scale %', 1, 500, 1, 100),
    transformProp('rotation', 'Rotation °', -360, 360, 0.5),
    transformProp('opacity', 'Opacity %', 0, 100, 1, 100),
    threeProp('rotX', 'Tilt X °', -180, 180, 0.5),
    threeProp('rotY', 'Swivel Y °', -180, 180, 0.5),
    threeProp('z', 'Depth Z', -p.width * 2, p.width * 4, 1),
  ];
  if (c.kind === 'text') {
    list.push({
      id: 'reveal',
      label: 'Typed %',
      group: 'Text',
      min: 0,
      max: 100,
      step: 1,
      view: 100,
      get: (cl) => (cl.kind === 'text' ? cl.reveal : undefined) ?? anim(1),
      set: (cl, a) => (cl.kind === 'text' ? { ...cl, reveal: a } : cl),
    });
  }
  if (c.mask) {
    for (const [key, label] of [['x', 'Mask X %'], ['y', 'Mask Y %'], ['w', 'Mask width %'], ['h', 'Mask height %']] as const) {
      list.push({
        id: `mask.${key}`,
        label,
        group: 'Mask',
        min: key === 'x' || key === 'y' ? -20 : 1,
        max: key === 'x' || key === 'y' ? 120 : 200,
        step: 0.5,
        view: 100,
        get: (cl) => cl.mask?.[key] ?? anim(0.5),
        set: (cl, a) => (cl.mask ? ({ ...cl, mask: { ...cl.mask, [key]: a } } as VisualClip) : cl),
      });
    }
  }
  return list.map((pr, i) => ({ ...pr, color: COLORS[i % COLORS.length] }));
}

export const findProp = (p: Pick<Project, 'width' | 'height'>, c: VisualClip, id: string): AnimProp | null => animProps(p, c).find((x) => x.id === id) ?? null;

/** Every keyframe time of the clip (seconds from its start), in order. */
export function keyTimes(p: Pick<Project, 'width' | 'height'>, c: VisualClip): number[] {
  const set = new Set<number>();
  for (const pr of animProps(p, c)) for (const k of pr.get(c).keys) set.add(Math.round(k.t * 1000) / 1000);
  return [...set].sort((a, b) => a - b);
}

export { anim };

// ── values, with expressions ──────────────────────────────────────────────

/** Properties shown as percentages: expressions see (and return) the shown value, not the stored 0–1. */
const VIEW: Record<string, number> = { scale: 100, opacity: 100, reveal: 100, 'mask.x': 100, 'mask.y': 100, 'mask.w': 100, 'mask.h': 100 };

/** Repeats the keyframed stretch of `a` after (and before) its keys. */
function loop(a: Animatable, t: number, pingPong: boolean): number {
  const k = a.keys;
  if (k.length < 2) return valueAt(a, t);
  const first = k[0].t;
  const span = k[k.length - 1].t - first;
  if (span <= 0) return valueAt(a, t);
  const n = Math.floor((t - first) / span);
  let u = t - first - n * span;
  if (pingPong && Math.abs(n) % 2 === 1) u = span - u;
  return valueAt(a, first + u);
}

/**
 * The value of property `id` of clip `c` at `local` seconds from its start: its keyframes,
 * passed through the property's expression when it has one. `a` is the property's animatable.
 */
export function propValue(p: Project, c: VisualClip, id: string, a: Animatable, local: number): number {
  const base = valueAt(a, local);
  const src = c.expressions?.[id];
  if (!src || !src.trim()) return base;
  const view = VIEW[id] ?? 1;
  const seed = seedOf(c.id + id);
  const frame = Math.round((c.start + local) * p.fps);
  const ctx: ExprContext = {
    vars: {
      time: local,
      t: local,
      value: base * view,
      frame,
      fps: p.fps,
      duration: c.duration,
      start: c.start,
      playhead: c.start + local,
      width: p.width,
      height: p.height,
      index: p.tracks.findIndex((tr) => tr.clips.some((x) => x.id === c.id)),
      PI: Math.PI,
      E: Math.E,
    },
    fns: {
      ...PURE_FNS,
      wiggle: (freq, amp) => (noise1(local * Number(freq), seed) * 2 - 1) * Number(amp),
      noise: (x) => noise1(Number(x), seed),
      random: (s = 0) => noise1(Number(s) * 7919 + 0.5, seed ^ 0x5bd1e995) % 1,
      loopOut: () => loop(a, local, false) * view,
      pingPong: () => loop(a, local, true) * view,
      valueAtTime: (t) => valueAt(a, Number(t)) * view,
      data: (col, row) => dataValue(p.data, col, row === undefined ? frame : Number(row)),
    },
  };
  return evalExpression(src, ctx, base * view) / view;
}
