/**
 * Studio (desktop app only): a multi-track video/audio project, After Effects / Premiere
 * style. Plain data (no DOM) so it can be tested, undone and serialized.
 *
 *   Project   output size, frame rate, background, tracks, master bus
 *   Track     video tracks (top of the list draws on top) and audio tracks (mixer strips)
 *   Clip      video / image / text / solid layers with keyframed transforms and effects;
 *             audio clips with gain, fades and a volume envelope
 *
 * Times are seconds. A clip covers [start, start + duration) on the timeline and plays its
 * source from `in`. Keyframe times are relative to the clip start.
 */
import { NO_ADJUSTMENTS, type Adjustments, type FilterPreset } from '../media/image-ops';
import type { BlendMode } from '../pro-image/document';
import type { ExprData } from './expr';
import type { StyleEffect } from './fx';

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold' | 'bezier';

/** Control points of a custom easing curve, as in CSS cubic-bezier(x1, y1, x2, y2). */
export type Bezier = [number, number, number, number];

export const DEFAULT_BEZIER: Bezier = [0.33, 0, 0.67, 1];

export interface Keyframe {
  /** seconds from the clip start */
  t: number;
  v: number;
  /** shapes the segment from this key to the next */
  ease: Easing;
  /** the curve of a 'bezier' segment (drawn in the graph editor) */
  bez?: Bezier;
}

/** A value that is either constant or animated by keyframes. */
export interface Animatable {
  value: number;
  keys: Keyframe[];
}

export type TransformProp = 'x' | 'y' | 'scale' | 'rotation' | 'opacity';

export interface Transform {
  /** centre position in output pixels */
  x: Animatable;
  y: Animatable;
  /** 1 = the source fitted inside the frame */
  scale: Animatable;
  /** degrees, clockwise */
  rotation: Animatable;
  /** 0–1 */
  opacity: Animatable;
}

/** Optional 3D placement: the layer becomes a plane seen through the project's camera. */
export interface Transform3D {
  /** degrees: tips the top of the layer away from the viewer */
  rotX: Animatable;
  /** degrees: swings the right edge away from the viewer */
  rotY: Animatable;
  /** output pixels: positive is further from the camera */
  z: Animatable;
}

/** Shows only part of a layer (or, inverted, hides part of it). Position and size are fractions of the layer. */
export interface ClipMask {
  enabled: boolean;
  shape: 'rect' | 'ellipse';
  /** centre, 0–1 across and down the layer */
  x: Animatable;
  y: Animatable;
  /** size, 0–1 of the layer's width and height */
  w: Animatable;
  h: Animatable;
  /** edge softness, 0–100 (% of half the layer's shorter side) */
  feather: number;
  invert: boolean;
}

export interface ChromaKey {
  enabled: boolean;
  color: string;
  /** 0–100: how far from the key colour is still removed */
  tolerance: number;
  /** 0–100: edge softness */
  softness: number;
  /** 0–100: removes the key colour's tint from the remaining edges */
  spill: number;
}

export interface VisualEffects {
  blend: BlendMode;
  adjustments: Adjustments;
  filter: FilterPreset;
  /** Gaussian blur radius in px */
  blur: number;
  chromaKey: ChromaKey;
  /** opacity fades, seconds */
  fadeIn: number;
  fadeOut: number;
  /** drop shadow (useful on text and keyed footage) */
  shadow: boolean;
  /** stylize effects, applied in order (absent in projects from older versions) */
  stylize?: StyleEffect[];
}

export interface SourceMeta {
  id: string;
  name: string;
  kind: 'video' | 'image' | 'audio';
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** frames per second of a video source */
  fps: number | null;
}

interface ClipBase {
  id: string;
  /** timeline start, seconds */
  start: number;
  /** timeline length, seconds */
  duration: number;
  name: string;
  /** clips added together from one file (a video's picture and sound) move together */
  linkId: string | null;
}

/** Extras every visual clip can have. All optional, so projects from older versions still open. */
interface VisualExtras {
  three?: Transform3D;
  mask?: ClipMask;
  /** formulas that drive a property, by property id (see core/studio/expr.ts) */
  expressions?: Record<string, string>;
}

export interface MediaClip extends ClipBase, VisualExtras {
  kind: 'video' | 'image';
  sourceId: string;
  /** source time at the clip start */
  in: number;
  transform: Transform;
  effects: VisualEffects;
}

export interface TextClip extends ClipBase, VisualExtras {
  kind: 'text';
  text: string;
  font: string;
  /** px at scale 1 */
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  stroke: number;
  strokeColor: string;
  /** box behind the text, or null */
  background: string | null;
  /** which edge of the text sits on its position (default: its centre), so edited text grows away from it */
  anchor?: 'left' | 'center' | 'right';
  /** 0–1: how much of the text has been typed so far (typewriter); absent = all of it */
  reveal?: Animatable;
  transform: Transform;
  effects: VisualEffects;
}

export interface SolidClip extends ClipBase, VisualExtras {
  kind: 'solid';
  color: string;
  /** optional second colour: a vertical gradient */
  color2: string | null;
  /** size as fractions of the frame (default: the whole frame), for bars and panels */
  size?: { w: number; h: number };
  transform: Transform;
  effects: VisualEffects;
}

export interface AudioClip extends ClipBase {
  kind: 'audio';
  sourceId: string;
  in: number;
  gainDb: number;
  fadeIn: number;
  fadeOut: number;
  /** volume automation in dB (relative), keyframe times from the clip start */
  envelope: Keyframe[];
}

export type VisualClip = MediaClip | TextClip | SolidClip;
export type Clip = VisualClip | AudioClip;

export interface EqSettings {
  enabled: boolean;
  /** high-pass (low cut) frequency, 0 = off */
  lowCut: number;
  lowShelfGain: number;
  lowShelfFreq: number;
  midGain: number;
  midFreq: number;
  midQ: number;
  highShelfGain: number;
  highShelfFreq: number;
  /** low-pass (high cut) frequency, 0 = off */
  highCut: number;
}

export interface CompressorSettings {
  enabled: boolean;
  threshold: number;
  ratio: number;
  /** seconds */
  attack: number;
  release: number;
  knee: number;
  makeupDb: number;
}

export interface ReverbSettings {
  enabled: boolean;
  /** 0–1 wet level */
  mix: number;
  /** seconds */
  decay: number;
}

export interface DelaySettings {
  enabled: boolean;
  /** seconds */
  time: number;
  /** 0–0.9 */
  feedback: number;
  mix: number;
}

export interface TrackAudio {
  volumeDb: number;
  /** -1 (left) … 1 (right) */
  pan: number;
  eq: EqSettings;
  compressor: CompressorSettings;
  reverb: ReverbSettings;
  delay: DelaySettings;
}

export interface Track {
  id: string;
  kind: 'video' | 'audio';
  name: string;
  /** video: hidden; audio: muted */
  muted: boolean;
  solo: boolean;
  locked: boolean;
  clips: Clip[];
  audio: TrackAudio;
}

export interface MasterBus {
  volumeDb: number;
  limiter: { enabled: boolean; ceilingDb: number };
  /** normalize the export to this integrated loudness, or null */
  loudnessTarget: number | null;
}

export interface Project {
  width: number;
  height: number;
  fps: number;
  background: string;
  /** display order: video tracks (top first), then audio tracks */
  tracks: Track[];
  master: MasterBus;
  sources: Record<string, SourceMeta>;
  /** camera lens for 3D layers, as a 35 mm-equivalent focal length (default 50) */
  lens?: number;
  /** numbers imported from a CSV file, read by expressions with data("column") */
  data?: ExprData;
}

export const DEFAULT_LENS = 50;

/** Distance from the camera to the frame plane, in output pixels (a longer lens flattens perspective). */
export const cameraDistance = (p: Pick<Project, 'width' | 'lens'>) => (p.width * Math.max(8, p.lens ?? DEFAULT_LENS)) / 36;

export const defaultMask = (): ClipMask => ({ enabled: true, shape: 'ellipse', x: anim(0.5), y: anim(0.5), w: anim(0.5), h: anim(0.5), feather: 8, invert: false });

export const defaultThree = (): Transform3D => ({ rotX: anim(0), rotY: anim(0), z: anim(0) });

/** True when the clip is actually turned or moved in depth at some point. */
export function is3D(c: VisualExtras): boolean {
  const t = c.three;
  if (!t) return false;
  return [t.rotX, t.rotY, t.z].some((a) => a.value !== 0 || a.keys.some((k) => k.v !== 0));
}

/** Applies `fn` to every animatable of a visual clip (transform and the optional extras). */
export function mapAnimatables<T extends VisualClip>(c: T, fn: (a: Animatable) => Animatable): T {
  const out = { ...c, transform: { ...c.transform } } as T;
  for (const k of ['x', 'y', 'scale', 'rotation', 'opacity'] as TransformProp[]) out.transform[k] = fn(c.transform[k]);
  if (c.three) out.three = { rotX: fn(c.three.rotX), rotY: fn(c.three.rotY), z: fn(c.three.z) };
  if (c.mask) out.mask = { ...c.mask, x: fn(c.mask.x), y: fn(c.mask.y), w: fn(c.mask.w), h: fn(c.mask.h) };
  if (out.kind === 'text' && out.reveal) out.reveal = fn(out.reveal);
  return out;
}

let n = 0;
export const sid = (p: string) => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;

export const anim = (value: number): Animatable => ({ value, keys: [] });

export const DEFAULT_EQ: EqSettings = {
  enabled: false,
  lowCut: 0,
  lowShelfGain: 0,
  lowShelfFreq: 120,
  midGain: 0,
  midFreq: 1000,
  midQ: 1,
  highShelfGain: 0,
  highShelfFreq: 8000,
  highCut: 0,
};

export const DEFAULT_TRACK_AUDIO: TrackAudio = {
  volumeDb: 0,
  pan: 0,
  eq: DEFAULT_EQ,
  compressor: { enabled: false, threshold: -18, ratio: 3, attack: 0.01, release: 0.2, knee: 6, makeupDb: 0 },
  reverb: { enabled: false, mix: 0.25, decay: 2 },
  delay: { enabled: false, time: 0.3, feedback: 0.35, mix: 0.25 },
};

export function defaultEffects(): VisualEffects {
  return {
    blend: 'normal',
    adjustments: { ...NO_ADJUSTMENTS },
    filter: 'none',
    blur: 0,
    chromaKey: { enabled: false, color: '#00ff00', tolerance: 30, softness: 10, spill: 50 },
    fadeIn: 0,
    fadeOut: 0,
    shadow: false,
  };
}

export function defaultTransform(p: Pick<Project, 'width' | 'height'>): Transform {
  return { x: anim(p.width / 2), y: anim(p.height / 2), scale: anim(1), rotation: anim(0), opacity: anim(1) };
}

export function newTrack(kind: 'video' | 'audio', name: string): Track {
  return { id: sid('T'), kind, name, muted: false, solo: false, locked: false, clips: [], audio: structuredClone(DEFAULT_TRACK_AUDIO) };
}

export function newProject(width: number, height: number, fps: number): Project {
  return {
    width,
    height,
    fps,
    background: '#000000',
    tracks: [newTrack('video', 'V1'), newTrack('audio', 'A1')],
    master: { volumeDb: 0, limiter: { enabled: true, ceilingDb: -1 }, loudnessTarget: null },
    sources: {},
  };
}

export function clipEnd(c: Clip): number {
  return c.start + c.duration;
}

export function projectDuration(p: Project): number {
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return end;
}

export function hasVideoTracks(p: Project): boolean {
  return p.tracks.some((t) => t.kind === 'video' && t.clips.length > 0);
}

// ── keyframes ────────────────────────────────────────────────────────────

/** y of a CSS-style cubic bezier at x (both 0–1). */
export function bezierAt(x: number, [x1, y1, x2, y2]: Bezier): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const a = Math.min(1, Math.max(0, x1));
  const b = Math.min(1, Math.max(0, x2));
  const curve = (p1: number, p2: number, u: number) => 3 * (1 - u) * (1 - u) * u * p1 + 3 * (1 - u) * u * u * p2 + u * u * u;
  // x(u) is monotonic for control x in 0–1, so bisection always converges
  let lo = 0;
  let hi = 1;
  let u = x;
  for (let i = 0; i < 24; i++) {
    const cx = curve(a, b, u);
    if (Math.abs(cx - x) < 1e-5) break;
    if (cx < x) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return curve(y1, y2, u);
}

function ease(t: number, e: Easing, bez?: Bezier): number {
  switch (e) {
    case 'bezier':
      return bezierAt(t, bez ?? DEFAULT_BEZIER);
    case 'easeIn':
      return t * t * t;
    case 'easeOut':
      return 1 - (1 - t) ** 3;
    case 'easeInOut':
      return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    case 'hold':
      return 0;
    default:
      return t;
  }
}

/** Value at `t` seconds from the clip start (the easing of the earlier key shapes each segment). */
export function valueAt(a: Animatable, t: number): number {
  const k = a.keys;
  if (!k.length) return a.value;
  if (t <= k[0].t) return k[0].v;
  const last = k[k.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < k.length - 2 && t > k[i + 1].t) i++;
  const a0 = k[i];
  const a1 = k[i + 1];
  const span = a1.t - a0.t || 1;
  return a0.v + (a1.v - a0.v) * ease((t - a0.t) / span, a0.ease, a0.bez);
}

/** Sets the value: a keyframe at `t` when the property is animated, otherwise the constant. */
export function setValueAt(a: Animatable, t: number, v: number): Animatable {
  if (!a.keys.length) return { ...a, value: v };
  return addKey(a, t, v);
}

export function addKey(a: Animatable, t: number, v = valueAt(a, t), e: Easing = 'linear'): Animatable {
  const keys = a.keys.filter((k) => Math.abs(k.t - t) > 1e-4);
  const old = a.keys.find((k) => Math.abs(k.t - t) <= 1e-4);
  keys.push(old ? { ...old, t, v } : { t, v, ease: e });
  keys.sort((x, y) => x.t - y.t);
  return { value: a.value, keys };
}

export function removeKey(a: Animatable, t: number): Animatable {
  const keys = a.keys.filter((k) => Math.abs(k.t - t) > 1e-4);
  return { value: keys.length ? a.value : valueAt(a, t), keys };
}

export function hasKeyAt(a: Animatable, t: number): boolean {
  return a.keys.some((k) => Math.abs(k.t - t) <= 1e-4);
}

/** Envelope gain in dB at `t` (0 dB without points). */
export function envelopeDb(env: Keyframe[], t: number): number {
  return valueAt({ value: 0, keys: env }, t);
}

export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => (g <= 0 ? -Infinity : 20 * Math.log10(g));

// ── timeline edits (pure) ─────────────────────────────────────────────────

/** Splits a clip at timeline time `t` into two clips (keyframes are divided between them). */
export function splitClip(c: Clip, t: number): [Clip, Clip] | null {
  if (t <= c.start + 1e-3 || t >= clipEnd(c) - 1e-3) return null;
  const local = t - c.start;
  const shiftAnim = (a: Animatable, keepLeft: boolean): Animatable => {
    if (!a.keys.length) return a;
    const v = valueAt(a, local);
    if (keepLeft) return { value: a.value, keys: [...a.keys.filter((k) => k.t < local), { t: local, v, ease: 'linear' }] };
    return { value: a.value, keys: [{ t: 0, v, ease: 'linear' }, ...a.keys.filter((k) => k.t > local).map((k) => ({ ...k, t: k.t - local }))] };
  };
  const half = (keepLeft: boolean): Clip => {
    const copy = structuredClone(c);
    return copy.kind === 'audio' ? copy : mapAnimatables(copy, (a) => shiftAnim(a, keepLeft));
  };
  const left = { ...half(true), duration: local } as Clip;
  const right = { ...half(false), id: sid('C'), start: t, duration: c.duration - local } as Clip;
  if ('in' in right) (right as MediaClip | AudioClip).in = (c as MediaClip | AudioClip).in + local;
  if (left.kind !== 'audio' && right.kind !== 'audio') {
    left.effects.fadeOut = 0;
    right.effects.fadeIn = 0;
  }
  if (left.kind === 'audio' && right.kind === 'audio') {
    const env = { value: 0, keys: (c as AudioClip).envelope };
    left.envelope = shiftAnim(env, true).keys;
    right.envelope = shiftAnim(env, false).keys;
    left.fadeOut = 0;
    right.fadeIn = 0;
  }
  if (c.linkId) {
    // the two halves form their own links with the matching halves of linked clips
    left.linkId = `${c.linkId}:L`;
    right.linkId = `${c.linkId}:R`;
  }
  return [left, right];
}

/** All clips that start, end or cross `t` move with drag snapping to these points. */
export function snapPoints(p: Project, exclude: Set<string>): number[] {
  const pts = [0];
  for (const t of p.tracks) for (const c of t.clips) if (!exclude.has(c.id)) pts.push(c.start, clipEnd(c));
  return pts;
}

export function snap(t: number, points: number[], threshold: number): number {
  let best = t;
  let d = threshold;
  for (const p of points) {
    if (Math.abs(p - t) < d) {
      d = Math.abs(p - t);
      best = p;
    }
  }
  return best;
}

/** Which tracks are audible given mute/solo. */
export function audibleTracks(p: Project): Set<string> {
  const audio = p.tracks.filter((t) => t.kind === 'audio');
  const solo = audio.some((t) => t.solo);
  return new Set(audio.filter((t) => !t.muted && (!solo || t.solo)).map((t) => t.id));
}
