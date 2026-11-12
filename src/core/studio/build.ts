/** Pure helpers that add sources and clips to a Studio project (placement on free tracks). */
import {
  clipEnd,
  defaultEffects,
  defaultTransform,
  newProject,
  newTrack,
  sid,
  splitClip,
  type AudioClip,
  type Clip,
  type MediaClip,
  type Project,
  type SolidClip,
  type SourceMeta,
  type TextClip,
  type Track,
} from './model';

export const STILL_SECONDS = 5;

function free(t: Track, start: number, end: number): boolean {
  return !t.locked && t.clips.every((c) => clipEnd(c) <= start + 1e-6 || c.start >= end - 1e-6);
}

/** Puts `clip` on the first free track of `kind` (top-most video / first audio), adding a track if needed. */
export function placeClip(p: Project, kind: 'video' | 'audio', clip: Clip): { project: Project; trackId: string } {
  const end = clip.start + clip.duration;
  const target = p.tracks.find((t) => t.kind === kind && free(t, clip.start, end));
  if (target) {
    return { project: { ...p, tracks: p.tracks.map((t) => (t.id === target.id ? { ...t, clips: [...t.clips, clip] } : t)) }, trackId: target.id };
  }
  const count = p.tracks.filter((t) => t.kind === kind).length;
  const track = { ...newTrack(kind, `${kind === 'video' ? 'V' : 'A'}${count + 1}`), clips: [clip] };
  // new video tracks go on top (drawn above), new audio tracks at the bottom
  const tracks = kind === 'video' ? [track, ...p.tracks] : [...p.tracks, track];
  return { project: { ...p, tracks }, trackId: track.id };
}

export function addSource(p: Project, s: SourceMeta): Project {
  return { ...p, sources: { ...p.sources, [s.id]: s } };
}

/** Adds a source's clip(s) at `at`: a video gets its picture and (linked) sound. Returns the first clip id. */
export function addMediaClips(p: Project, s: SourceMeta, at: number): { project: Project; clipId: string } {
  let project = addSource(p, s);
  const duration = s.kind === 'image' ? STILL_SECONDS : Math.max(0.05, s.duration);
  const linkId = s.kind === 'video' && s.hasAudio ? sid('L') : null;
  let first = '';
  if (s.kind === 'video' || s.kind === 'image') {
    const clip: MediaClip = { id: sid('C'), kind: s.kind, sourceId: s.id, name: s.name, start: at, duration, in: 0, linkId, transform: defaultTransform(p), effects: defaultEffects() };
    project = placeClip(project, 'video', clip).project;
    first = clip.id;
  }
  if (s.hasAudio && s.kind !== 'image') {
    const clip: AudioClip = { id: sid('C'), kind: 'audio', sourceId: s.id, name: s.name, start: at, duration, in: 0, linkId, gainDb: 0, fadeIn: 0, fadeOut: 0, envelope: [] };
    project = placeClip(project, 'audio', clip).project;
    first ||= clip.id;
  }
  return { project, clipId: first };
}

export function textClip(p: Project, at: number, text = 'Title'): TextClip {
  return {
    id: sid('C'),
    kind: 'text',
    name: 'Text',
    start: at,
    duration: STILL_SECONDS,
    linkId: null,
    text,
    font: 'system-ui, "Segoe UI", Arial, sans-serif',
    size: Math.round(p.height / 10),
    color: '#ffffff',
    bold: true,
    italic: false,
    align: 'center',
    stroke: 0,
    strokeColor: '#000000',
    background: null,
    transform: defaultTransform(p),
    effects: defaultEffects(),
  };
}

export function solidClip(p: Project, at: number, color = '#1d3557'): SolidClip {
  return { id: sid('C'), kind: 'solid', name: 'Colour', start: at, duration: STILL_SECONDS, linkId: null, color, color2: null, transform: defaultTransform(p), effects: defaultEffects() };
}

/** A project for one opened file: its picture on V1 and its sound on A1. */
export function projectFromSource(s: SourceMeta): Project {
  const w = s.kind === 'audio' ? 1920 : Math.max(16, Math.round(s.width / 2) * 2) || 1920;
  const h = s.kind === 'audio' ? 1080 : Math.max(16, Math.round(s.height / 2) * 2) || 1080;
  const fps = s.fps && s.fps > 1 && s.fps <= 120 ? Math.round(s.fps) : 30;
  return addMediaClips(newProject(w, h, fps), s, 0).project;
}

export const findClip = (p: Project, id: string | null): Clip | null => (id ? p.tracks.flatMap((t) => t.clips).find((c) => c.id === id) ?? null : null);

export const trackOf = (p: Project, id: string): Track | null => p.tracks.find((t) => t.clips.some((c) => c.id === id)) ?? null;

/** The clip and every clip linked to it. */
export function linkedIds(p: Project, id: string): Set<string> {
  const c = findClip(p, id);
  if (!c) return new Set();
  if (!c.linkId) return new Set([id]);
  return new Set(p.tracks.flatMap((t) => t.clips.filter((x) => x.linkId === c.linkId).map((x) => x.id)));
}

export function replaceClip(p: Project, clip: Clip): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.clips.some((c) => c.id === clip.id) ? { ...t, clips: t.clips.map((c) => (c.id === clip.id ? clip : c)) } : t)) };
}

export function deleteClips(p: Project, ids: Set<string>): Project {
  return { ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => !ids.has(c.id)) })) };
}

/** Splits the clip (and its linked clips) at `t`. Returns the id of the right half of `id`. */
export function splitAt(p: Project, id: string, t: number): { project: Project; rightId: string | null } {
  const ids = linkedIds(p, id);
  let rightId: string | null = null;
  const tracks = p.tracks.map((tr) => {
    const clips: Clip[] = [];
    for (const c of tr.clips) {
      const parts = ids.has(c.id) ? splitClip(c, t) : null;
      if (!parts) {
        clips.push(c);
        continue;
      }
      clips.push(parts[0], parts[1]);
      if (c.id === id) rightId = parts[1].id;
    }
    return { ...tr, clips };
  });
  return { project: { ...p, tracks }, rightId };
}

export function unlink(p: Project, id: string): Project {
  const ids = linkedIds(p, id);
  return { ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (ids.has(c.id) ? { ...c, linkId: null } : c)) })) };
}

/** Removes empty tracks beyond the first of each kind. */
export function pruneTracks(p: Project): Project {
  const seen = { video: 0, audio: 0 };
  return { ...p, tracks: p.tracks.filter((t) => ++seen[t.kind] === 1 || t.clips.length > 0) };
}
