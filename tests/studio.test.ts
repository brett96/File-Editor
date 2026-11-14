import { describe, expect, it } from 'vitest';
import { createPixels } from '../src/core/media/image-ops';
import {
  chromaKey, deleteRange, gateRange, encodeWav, fadeRange, fft, frames, gainRange, insertAudio, integratedLoudness, limit, loudnessGainDb,
  noiseProfile, normalizeRange, peak, reduceNoise, reverseRange, silenceRange, sliceAudio, waveformPeaks, type AudioData,
} from '../src/core/studio/dsp';
import { animProps, keyTimes } from '../src/core/studio/anim';
import { simplifyKeys, toGray, trackPatch, type Gray } from '../src/core/studio/track';
import { homography, projectQuad, type Quad } from '../src/core/studio/compose';
import {
  addKey, anim, audibleTracks, bezierAt, cameraDistance, defaultMask, defaultThree, is3D, envelopeDb, hasKeyAt, newProject, newTrack, projectDuration, removeKey, setValueAt, snap, splitClip, valueAt,
  defaultEffects, defaultTransform, type AudioClip, type MediaClip,
} from '../src/core/studio/model';

const sine = (freq: number, amp: number, seconds: number, sr = 48000, ch = 2): AudioData => {
  const n = Math.round(seconds * sr);
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return { sampleRate: sr, channels: Array.from({ length: ch }, () => c.slice()) };
};

describe('motion tracking', () => {
  const frame = (ox: number, oy: number): Gray => {
    const g = { data: new Float32Array(120 * 80).fill(40), width: 120, height: 80 };
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) g.data[(oy + y) * 120 + ox + x] = 60 + ((Math.imul(x * 31 + y * 17 + 7, 2654435761) >>> 24) % 160);
    return g;
  };
  it('follows a patch between frames', () => {
    const hit = trackPatch(frame(30, 20), frame(37, 15), 38, 28, 16, 16, 12);
    expect([hit.x, hit.y]).toEqual([45, 23]);
    expect(hit.error).toBeLessThan(1);
    // nothing moved: the region stays where it is
    expect(trackPatch(frame(30, 20), frame(30, 20), 38, 28, 16, 16, 12)).toMatchObject({ x: 38, y: 28 });
    // a featureless region does not wander
    expect(trackPatch(frame(30, 20), frame(37, 15), 90, 60, 16, 16, 12)).toMatchObject({ x: 90, y: 60 });
  });
  it('reads luma from pixels and thins straight runs of keys', () => {
    const px = createPixels(2, 1);
    px.data.set([255, 255, 255, 255, 0, 0, 0, 255]);
    expect(Array.from(toGray(px).data).map(Math.round)).toEqual([255, 0]);
    const keys = [0, 1, 2, 3, 4, 5, 6].map((t) => ({ t, v: t <= 3 ? t * 2 : 6 + (t - 3) * -1, ease: 'linear' as const }));
    expect(simplifyKeys(keys, 0.1).map((k) => k.t)).toEqual([0, 3, 6]);
  });
  it('splits mask animation and lists mask properties only when there is a mask', () => {
    const p = newProject(1000, 500, 30);
    const base: MediaClip = { id: 'c', kind: 'video', sourceId: 's', name: 'c', start: 0, duration: 4, in: 0, linkId: null, transform: defaultTransform(p), effects: defaultEffects() };
    expect(animProps(p, base).some((x) => x.group === 'Mask')).toBe(false);
    const masked = { ...base, mask: { ...defaultMask(), x: addKey(addKey(anim(0), 0, 0.2), 4, 0.6) } };
    expect(animProps(p, masked).filter((x) => x.group === 'Mask').map((x) => x.id)).toEqual(['mask.x', 'mask.y', 'mask.w', 'mask.h']);
    expect(keyTimes(p, masked)).toEqual([0, 4]);
    const [, r] = splitClip(masked, 2) as [MediaClip, MediaClip];
    expect(valueAt(r.mask!.x, 0)).toBeCloseTo(0.4, 6);
  });
});

describe('3D layers', () => {
  const p = newProject(1000, 500, 30);
  const edge = (q: Quad, a: number, b: number) => Math.hypot(q[a][0] - q[b][0], q[a][1] - q[b][1]);
  it('leaves a flat layer where it was and shrinks it with depth', () => {
    expect(projectQuad(p, 500, 250, 400, 200, 0, 0, 0, 0)).toEqual([[300, 150], [700, 150], [700, 350], [300, 350]]);
    const far = projectQuad(p, 500, 250, 400, 200, 0, 0, 0, cameraDistance(p))!;
    expect(edge(far, 0, 1)).toBeCloseTo(200, 6);
    expect(projectQuad(p, 500, 250, 400, 200, 0, 0, 0, -cameraDistance(p))).toBeNull();
  });
  it('foreshortens the edge that turns away', () => {
    const swivel = projectQuad(p, 500, 250, 400, 200, 0, 0, 40, 0)!;
    expect(edge(swivel, 1, 2)).toBeLessThan(edge(swivel, 0, 3));
    const tilt = projectQuad(p, 500, 250, 400, 200, 0, 40, 0, 0)!;
    expect(edge(tilt, 0, 1)).toBeLessThan(edge(tilt, 3, 2));
    // a longer lens flattens the perspective
    const tele = projectQuad({ ...p, lens: 200 }, 500, 250, 400, 200, 0, 0, 40, 0)!;
    expect(edge(tele, 0, 3) - edge(tele, 1, 2)).toBeLessThan(edge(swivel, 0, 3) - edge(swivel, 1, 2));
  });
  it('maps the unit square onto the quad', () => {
    const q = projectQuad(p, 500, 250, 400, 200, 10, 30, -25, 80)!;
    const H = homography(q);
    const at = (u: number, v: number) => [(H[0] * u + H[1] * v + H[2]) / (H[6] * u + H[7] * v + 1), (H[3] * u + H[4] * v + H[5]) / (H[6] * u + H[7] * v + 1)];
    ([[0, 0], [1, 0], [1, 1], [0, 1]] as const).forEach(([u, v], i) => {
      expect(at(u, v)[0]).toBeCloseTo(q[i][0], 6);
      expect(at(u, v)[1]).toBeCloseTo(q[i][1], 6);
    });
  });
  it('splits 3D animation between the halves', () => {
    const base: MediaClip = { id: 'c', kind: 'video', sourceId: 's', name: 'c', start: 0, duration: 4, in: 0, linkId: null, transform: defaultTransform(p), effects: defaultEffects() };
    const clip = { ...base, three: { ...defaultThree(), rotY: addKey(addKey(anim(0), 0, 0), 4, 80) } };
    expect(is3D(base)).toBe(false);
    expect(is3D(clip)).toBe(true);
    const [l, r] = splitClip(clip, 1) as [MediaClip, MediaClip];
    expect(valueAt(l.three!.rotY, 1)).toBe(20);
    expect(valueAt(r.three!.rotY, 0)).toBe(20);
    expect(valueAt(r.three!.rotY, 3)).toBe(80);
  });
});

describe('keyframes', () => {
  it('follows a custom bezier curve, with overshoot', () => {
    expect(bezierAt(0.5, [0, 0, 1, 1])).toBeCloseTo(0.5, 3);
    expect(bezierAt(0.25, [0.42, 0, 1, 1])).toBeLessThan(0.25);
    let a = addKey(addKey(anim(0), 0, 0, 'bezier'), 1, 10);
    a = { ...a, keys: [{ ...a.keys[0], bez: [0.3, 1.6, 0.6, 1] }, a.keys[1]] };
    expect(Math.max(...[0.3, 0.4, 0.5, 0.6].map((t) => valueAt(a, t)))).toBeGreaterThan(10);
    expect(valueAt(a, 1)).toBe(10);
    // re-keying a time keeps that key's easing and curve
    expect(addKey(a, 0, 5).keys[0]).toMatchObject({ v: 5, ease: 'bezier', bez: [0.3, 1.6, 0.6, 1] });
  });

  it('interpolates with easing and holds outside the keys', () => {
    let a = anim(5);
    expect(valueAt(a, 3)).toBe(5);
    a = addKey(a, 0, 0);
    a = addKey(a, 2, 100);
    expect(valueAt(a, -1)).toBe(0);
    expect(valueAt(a, 1)).toBe(50);
    expect(valueAt(a, 9)).toBe(100);
    a = { ...a, keys: [{ ...a.keys[0], ease: 'easeIn' }, a.keys[1]] };
    expect(valueAt(a, 1)).toBeLessThan(50);
    a = { ...a, keys: [{ ...a.keys[0], ease: 'hold' }, a.keys[1]] };
    expect(valueAt(a, 1.9)).toBe(0);
    expect(hasKeyAt(a, 2)).toBe(true);
    expect(removeKey(a, 2).keys).toHaveLength(1);
    expect(setValueAt(anim(1), 3, 7)).toEqual({ value: 7, keys: [] });
    expect(envelopeDb([{ t: 0, v: 0, ease: 'linear' }, { t: 1, v: -12, ease: 'linear' }], 0.5)).toBe(-6);
  });

  it('splits clips and their keyframes', () => {
    const p = newProject(1920, 1080, 30);
    const c: MediaClip = { id: 'c', kind: 'video', start: 2, duration: 4, name: 'v', linkId: 'L', sourceId: 's', in: 1, transform: defaultTransform(p), effects: defaultEffects() };
    c.transform.opacity = addKey(addKey(anim(1), 0, 0), 4, 1);
    const [a, b] = splitClip(c, 4) as [MediaClip, MediaClip];
    expect([a.start, a.duration, b.start, b.duration, b.in]).toEqual([2, 2, 4, 2, 3]);
    expect(valueAt(a.transform.opacity, 2)).toBeCloseTo(0.5);
    expect(valueAt(b.transform.opacity, 0)).toBeCloseTo(0.5);
    expect(valueAt(b.transform.opacity, 2)).toBe(1);
    expect(splitClip(c, 2)).toBeNull();
    const au: AudioClip = { id: 'a', kind: 'audio', start: 0, duration: 10, name: 'a', linkId: null, sourceId: 's', in: 0, gainDb: 0, fadeIn: 1, fadeOut: 1, envelope: [] };
    const [l, r] = splitClip(au, 5) as [AudioClip, AudioClip];
    expect([l.fadeOut, r.fadeIn, r.in]).toEqual([0, 0, 5]);
  });

  it('project helpers: duration, snapping, solo/mute', () => {
    const p = newProject(640, 360, 30);
    const t = newTrack('audio', 'A2');
    p.tracks.push(t);
    p.tracks[1].clips.push({ id: 'x', kind: 'audio', start: 1, duration: 4, name: 'a', linkId: null, sourceId: 's', in: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, envelope: [] });
    expect(projectDuration(p)).toBe(5);
    expect(snap(4.96, [0, 5], 0.1)).toBe(5);
    expect(snap(4.5, [0, 5], 0.1)).toBe(4.5);
    expect(audibleTracks(p).size).toBe(2);
    t.solo = true;
    expect([...audibleTracks(p)]).toEqual([t.id]);
  });
});

describe('chroma key', () => {
  it('removes the key colour, keeps others, softens edges and suppresses spill', () => {
    const px = createPixels(3, 1);
    px.data.set([0, 255, 0, 255, 200, 50, 50, 255, 120, 160, 110, 255]);
    chromaKey(px, '#00ff00', 30, 10, 100);
    expect(px.data[3]).toBe(0);
    expect(px.data[7]).toBe(255);
    expect(Array.from(px.data.subarray(4, 7))).toEqual([200, 50, 50]); // red pixel untouched
    expect(px.data[9]).toBeLessThanOrEqual(120); // greenish edge pixel loses its green tint
  });
});

describe('audio edits', () => {
  const a: AudioData = { sampleRate: 10, channels: [Float32Array.from([1, 2, 3, 4, 5]), Float32Array.from([-1, -2, -3, -4, -5])] };
  it('slice, delete, insert, silence, gain, reverse, fade, normalize', () => {
    expect(Array.from(sliceAudio(a, 1, 3).channels[0])).toEqual([2, 3]);
    expect(Array.from(deleteRange(a, 1, 3).channels[1])).toEqual([-1, -4, -5]);
    expect(Array.from(insertAudio(a, 2, sliceAudio(a, 0, 1)).channels[0])).toEqual([1, 2, 1, 3, 4, 5]);
    expect(Array.from(silenceRange(a, 0, 2).channels[0])).toEqual([0, 0, 3, 4, 5]);
    expect(gainRange(a, 0, 5, 20 * Math.log10(2)).channels[0][4]).toBeCloseTo(10);
    expect(Array.from(reverseRange(a, 0, 5).channels[0])).toEqual([5, 4, 3, 2, 1]);
    const f = fadeRange(a, 0, 5, 'in', 'linear').channels[0];
    expect(f[0]).toBe(0);
    expect(f[4]).toBe(5);
    expect(peak(normalizeRange(a, 0, 5, 0))).toBeCloseTo(1);
    expect(frames(a)).toBe(5);
    expect(waveformPeaks(a, 0, 5, 1)).toEqual(Float32Array.from([-5, 5]));
    const quietLoud: AudioData = { sampleRate: 1000, channels: [Float32Array.from({ length: 2000 }, (_, i) => (i < 1000 ? 0.001 : 0.5) * Math.sin(i))] };
    const gated = gateRange(quietLoud, 0, 2000, -30, 1, 10, 20).channels[0];
    expect(Math.max(...gated.subarray(100, 900).map(Math.abs))).toBeLessThan(0.0002);
    expect(Math.max(...gated.subarray(1200, 2000).map(Math.abs))).toBeGreaterThan(0.45);
    const wav = encodeWav({ sampleRate: 8000, channels: [Float32Array.from([0, 0.5, -0.5])] });
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(wav.length).toBe(44 + 6);
  });
});

describe('dsp', () => {
  it('fft round trip and a pure tone peak', () => {
    const n = 64;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 4 * i) / n);
    const orig = re.slice();
    fft(re, im);
    expect(Math.hypot(re[4], im[4])).toBeCloseTo(n / 2);
    fft(re, im, true);
    for (let i = 0; i < n; i++) expect(re[i]).toBeCloseTo(orig[i]);
  });

  it('integrated loudness matches EBU references (1 kHz stereo sine)', () => {
    const amp = Math.pow(10, -23 / 20);
    expect(integratedLoudness(sine(1000, amp, 5))).toBeCloseTo(-23, 0);
    expect(integratedLoudness(sine(1000, amp, 5, 44100))).toBeCloseTo(-23, 0);
    expect(loudnessGainDb(sine(1000, amp, 5), -14)).toBeCloseTo(9, 0);
    expect(integratedLoudness({ sampleRate: 48000, channels: [new Float32Array(48000)] })).toBe(-Infinity);
  });

  it('limiter keeps peaks under the ceiling and leaves quiet audio alone', () => {
    const loud = sine(200, 1.5, 0.5);
    const out = limit(loud, -1);
    expect(peak(out)).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 1e-6);
    const quiet = sine(200, 0.2, 0.5);
    expect(peak(limit(quiet, -1))).toBeCloseTo(0.2, 3);
  });

  it('noise reduction lowers the noise and keeps the tone', () => {
    const sr = 16000;
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    const n = sr * 2;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) c[i] = 0.05 * rnd() + (i > sr ? 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr) : 0);
    const a: AudioData = { sampleRate: sr, channels: [c] };
    const prof = noiseProfile(sliceAudio(a, 0, sr * 0.9));
    const out = reduceNoise(a, prof, 80);
    const rms = (x: Float32Array, s: number, e: number) => Math.sqrt(x.subarray(s, e).reduce((acc, v) => acc + v * v, 0) / (e - s));
    expect(rms(out.channels[0], 2000, sr - 2000)).toBeLessThan(rms(c, 2000, sr - 2000) * 0.35);
    const toneIn = rms(c, sr + 2000, n - 2000);
    expect(rms(out.channels[0], sr + 2000, n - 2000)).toBeGreaterThan(toneIn * 0.85);
  });
});

describe('studio project building', () => {
  const video = { id: 'S1', name: 'clip.mp4', kind: 'video' as const, duration: 8, width: 1280, height: 720, hasAudio: true, fps: 29.97 };
  it('creates a project from one file with linked picture and sound', async () => {
    const { projectFromSource, linkedIds } = await import('../src/core/studio/build');
    const p = projectFromSource(video);
    expect([p.width, p.height, p.fps]).toEqual([1280, 720, 30]);
    const v = p.tracks.find((t) => t.kind === 'video')!.clips[0];
    const a = p.tracks.find((t) => t.kind === 'audio')!.clips[0];
    expect(v.linkId).toBeTruthy();
    expect(a.linkId).toBe(v.linkId);
    expect(linkedIds(p, v.id)).toEqual(new Set([v.id, a.id]));
  });
  it('places overlapping clips on new tracks and splits linked clips together', async () => {
    const { projectFromSource, addMediaClips, textClip, placeClip, splitAt, deleteClips, linkedIds, pruneTracks } = await import('../src/core/studio/build');
    let p = projectFromSource(video);
    p = addMediaClips(p, { ...video, id: 'S2' }, 2).project;
    expect(p.tracks.filter((t) => t.kind === 'video')).toHaveLength(2);
    expect(p.tracks.filter((t) => t.kind === 'audio')).toHaveLength(2);
    // new video tracks go on top
    expect(p.tracks[0].clips[0].start).toBe(2);
    p = placeClip(p, 'video', textClip(p, 20)).project;
    expect(p.tracks.filter((t) => t.kind === 'video')).toHaveLength(2);
    const v1 = p.tracks[1].clips[0];
    const r = splitAt(p, v1.id, 3);
    expect(r.rightId).toBeTruthy();
    const all = r.project.tracks.flatMap((t) => t.clips);
    expect(all.filter((c) => 'sourceId' in c && c.sourceId === 'S1')).toHaveLength(4);
    const right = all.find((c) => c.id === r.rightId)!;
    expect(right.start).toBe(3);
    expect((right as { in: number }).in).toBe(3);
    expect(linkedIds(r.project, right.id).size).toBe(2);
    const del = pruneTracks(deleteClips(r.project, linkedIds(r.project, all.find((c) => c.start === 2)!.id)));
    expect(del.tracks.filter((t) => t.kind === 'audio')).toHaveLength(1);
  });
});

describe('studio project files', () => {
  it('round-trips the timeline and only the media it uses', async () => {
    const { projectFromSource, addSource } = await import('../src/core/studio/build');
    const { writeProjectFile, readProjectFile } = await import('../src/core/studio/project-file');
    const src = { id: 'S1', name: 'clip.mp4', kind: 'video' as const, duration: 4, width: 640, height: 360, hasAudio: true, fps: 30 };
    let p = projectFromSource(src);
    // an unused source (left behind by a waveform edit) is dropped from the file
    p = addSource(p, { id: 'S9', name: 'old.wav', kind: 'audio', duration: 1, width: 0, height: 0, hasAudio: true, fps: null });
    p = { ...p, master: { ...p.master, loudnessTarget: -14 } };
    const media = new Uint8Array(5000).map((_, i) => i % 251);
    const bytes = await writeProjectFile(p, new Map([['S1', new Blob([media])], ['S9', new Blob([new Uint8Array(10)])]]));
    const back = await readProjectFile(bytes);
    expect(back.project.master.loudnessTarget).toBe(-14);
    expect(back.project.tracks.map((t) => t.clips.length)).toEqual([1, 1]);
    expect(Object.keys(back.project.sources)).toEqual(['S1']);
    expect([...back.blobs.keys()]).toEqual(['S1']);
    expect(new Uint8Array(await back.blobs.get('S1')!.arrayBuffer())).toEqual(media);
  });
  it('rejects other files', async () => {
    const { readProjectFile } = await import('../src/core/studio/project-file');
    await expect(readProjectFile(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not a Studio project/);
  });
});
