/**
 * The animatable properties of a visual clip, as one list: the inspector, the graph editor
 * and the command palette all work from it, so a property added here appears in each.
 */
import { anim, defaultThree, type Animatable, type Project, type Transform3D, type TransformProp, type VisualClip } from './model';

export interface AnimProp {
  id: string;
  label: string;
  group: 'Transform' | '3D';
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
  void c;
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
