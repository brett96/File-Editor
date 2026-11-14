/**
 * Studio (desktop app only): multi-track video & audio editor — timeline with linked clips,
 * keyframed transforms, compositing, colour grading, chroma key, titles, a mixing console
 * with per-track EQ / compressor / delay / reverb, a master limiter and loudness targets,
 * and a destructive waveform editor. Preview and export share one compositor and one mix.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useTabActive } from '../tab-active';
import { openGuide } from '../help/open';
import {
  CircleHelp,
  Film,
  Magnet,
  Minus,
  Pause,
  Play,
  Plus,
  Redo2,
  Scissors,
  SkipBack,
  SlidersHorizontal,
  Square,
  StepBack,
  StepForward,
  Trash2,
  Type,
  Undo2,
  Unlink,
  Rows3,
  Spline,
} from 'lucide-react';
import { addMediaClips, deleteClips, findClip, linkedIds, placeClip, replaceClip, solidClip, splitAt, textClip, unlink } from '../../core/studio/build';
import { bufferToData, buildMix, dataToBuffer, decodeAudio, meterDb, renderMix, type Mix } from '../../core/studio/audio';
import { clipBox, drawFrame } from '../../core/studio/compose';
import { encodeWav, frames, sliceAudio, waveformPeaks, type AudioData } from '../../core/studio/dsp';
import {
  clipEnd,
  newTrack,
  projectDuration,
  setValueAt,
  sid,
  valueAt,
  type AudioClip,
  type Clip,
  type Easing,
  type MasterBus,
  type MediaClip,
  type Project,
  type SourceMeta,
  type Track,
  type VisualClip,
} from '../../core/studio/model';
import { cx } from '../components';
import { AudioClipEditor } from './AudioClipEditor';
import { GraphEditor } from './GraphEditor';
import { Inspector } from './Inspector';
import { Mixer } from './Mixer';
import { Timeline, TIMELINE_HEADER, formatTimecode } from './Timeline';
import './studio.css';

export interface StudioHandle {
  getProject(): Project;
  /** waits until every source is decoded, then returns the media needed to export */
  getMedia(): Promise<{ blobs: Map<string, Blob>; buffers: Map<string, AudioBuffer> }>;
  stop(): void;
}

interface Props {
  initial: Project;
  blobs: Map<string, Blob>;
  onChange: () => void;
  onError: (msg: string) => void;
}

interface SourceRt {
  blob: Blob;
  url: string;
  buffer: AudioBuffer | null;
  peaks: { peaks: Float32Array; duration: number } | null;
  bitmap: ImageBitmap | null;
  ready: Promise<void>;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i;

export const StudioEditor = forwardRef<StudioHandle, Props>(function StudioEditor({ initial, blobs, onChange, onError }, ref) {
  // ── project + history ───────────────────────────────────────────────────
  const [hist, setHist] = useState<{ past: Project[]; present: Project; future: Project[] }>({ past: [], present: initial, future: [] });
  const project = hist.present;
  const projectRef = useRef(project);
  projectRef.current = project;
  const lastCommit = useRef<{ key: string | null; at: number }>({ key: null, at: 0 });
  const dragSnapshot = useRef<Project | null>(null);

  const commit = useCallback(
    (next: Project, coalesce?: string) => {
      const now = Date.now();
      const merge = coalesce && lastCommit.current.key === coalesce && now - lastCommit.current.at < 900;
      lastCommit.current = { key: coalesce ?? null, at: now };
      setHist((h) => (merge ? { ...h, present: next } : { past: [...h.past, h.present].slice(-150), present: next, future: [] }));
      onChange();
    },
    [onChange],
  );
  const undo = () => setHist((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h));
  const redo = () => setHist((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h));
  const beginDrag = () => {
    dragSnapshot.current = projectRef.current;
  };
  const previewDrag = (p: Project) => setHist((h) => ({ ...h, present: p }));
  const endDrag = () => {
    const snap = dragSnapshot.current;
    dragSnapshot.current = null;
    if (!snap || snap === projectRef.current) return;
    lastCommit.current = { key: null, at: 0 };
    setHist((h) => ({ past: [...h.past, snap].slice(-150), present: h.present, future: [] }));
    onChange();
  };

  // ── ui state ────────────────────────────────────────────────────────────
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [playhead, setPlayheadState] = useState(0);
  const playheadRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [pps, setPps] = useState(40);
  const [view, setView] = useState<'timeline' | 'graph' | 'mixer'>('timeline');
  const [snapOn, setSnapOn] = useState(true);
  const [easing, setEasing] = useState<Easing>('easeInOut');
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [measured, setMeasured] = useState<string | null>(null);
  const [editAudio, setEditAudio] = useState<{ clipId: string; data: AudioData } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [, setMediaTick] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const duration = projectDuration(project);
  const selected = findClip(project, selectedId);
  const setPlayhead = (t: number) => {
    playheadRef.current = t;
    setPlayheadState(t);
  };

  // ── media runtime ───────────────────────────────────────────────────────
  const media = useRef(new Map<string, SourceRt>());
  const videos = useRef(new Map<string, HTMLVideoElement>());

  const registerSource = useCallback((id: string, blob: Blob, meta: SourceMeta | undefined) => {
    if (media.current.has(id)) return media.current.get(id)!;
    const rt: SourceRt = { blob, url: URL.createObjectURL(blob), buffer: null, peaks: null, bitmap: null, ready: Promise.resolve() };
    const jobs: Promise<unknown>[] = [];
    if (meta?.kind === 'image') {
      jobs.push(
        createImageBitmap(blob)
          .then((b) => {
            rt.bitmap = b;
          })
          .catch(() => undefined),
      );
    }
    if (meta?.hasAudio) {
      jobs.push(
        decodeAudio(blob)
          .then((buf) => {
            rt.buffer = buf;
            if (buf) {
              const data = bufferToData(buf);
              rt.peaks = { peaks: waveformPeaks(data, 0, frames(data), Math.min(60000, Math.max(200, Math.ceil(buf.duration * 150)))), duration: buf.duration };
            }
          })
          .catch(() => undefined),
      );
    }
    rt.ready = Promise.all(jobs).then(() => setMediaTick((n) => n + 1));
    media.current.set(id, rt);
    return rt;
  }, []);

  useEffect(() => {
    for (const [id, blob] of blobs) registerSource(id, blob, initial.sources[id]);
    const all = [...media.current.values()].map((m) => m.ready);
    if (all.length) {
      setStatus('Loading media…');
      void Promise.all(all).then(() => setStatus(null));
    }
    const m = media.current;
    const v = videos.current;
    return () => {
      stopPlayback();
      for (const rt of m.values()) {
        URL.revokeObjectURL(rt.url);
        rt.bitmap?.close();
      }
      for (const el of v.values()) {
        el.pause();
        el.removeAttribute('src');
        el.load();
      }
      void audioCtx.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buffers = () => {
    const out = new Map<string, AudioBuffer>();
    for (const [id, rt] of media.current) if (rt.buffer) out.set(id, rt.buffer);
    return out;
  };

  useImperativeHandle(ref, () => ({
    getProject: () => projectRef.current,
    getMedia: async () => {
      await Promise.all([...media.current.values()].map((m) => m.ready));
      const b = new Map<string, Blob>();
      for (const [id, rt] of media.current) b.set(id, rt.blob);
      return { blobs: b, buffers: buffers() };
    },
    stop: () => stopPlayback(),
  }));

  // ── video elements (preview frames) ─────────────────────────────────────
  const syncVideos = (p: Project, t: number, isPlaying: boolean) => {
    const live = new Set<string>();
    for (const tr of p.tracks) {
      if (tr.kind !== 'video') continue;
      for (const c of tr.clips) {
        if (c.kind !== 'video') continue;
        live.add(c.id);
        const rt = media.current.get(c.sourceId);
        if (!rt) continue;
        let el = videos.current.get(c.id);
        if (!el) {
          el = document.createElement('video');
          el.muted = true;
          el.playsInline = true;
          el.preload = 'auto';
          el.src = rt.url;
          el.addEventListener('seeked', () => requestDraw());
          el.addEventListener('loadeddata', () => requestDraw());
          videos.current.set(c.id, el);
        } else if (el.src !== rt.url) el.src = rt.url;
        const active = !tr.muted && t >= c.start && t < clipEnd(c);
        const target = c.in + Math.max(0, t - c.start);
        if (!active) {
          if (!el.paused) el.pause();
          // pre-roll to the clip's first frame so it is ready when the playhead arrives
          if (t < c.start && Math.abs(el.currentTime - c.in) > 0.05 && el.readyState >= 1) el.currentTime = c.in;
          continue;
        }
        if (isPlaying) {
          if (el.paused) {
            el.currentTime = target;
            void el.play().catch(() => undefined);
          } else if (Math.abs(el.currentTime - target) > 0.25) el.currentTime = target;
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - target) > 0.5 / p.fps && el.readyState >= 1) el.currentTime = target;
        }
      }
    }
    for (const [id, el] of videos.current) {
      if (live.has(id)) continue;
      el.pause();
      el.removeAttribute('src');
      el.load();
      videos.current.delete(id);
    }
  };

  const frameFor = (c: MediaClip): CanvasImageSource | null => {
    if (c.kind === 'image') return media.current.get(c.sourceId)?.bitmap ?? null;
    const el = videos.current.get(c.id);
    return el && el.readyState >= 2 ? el : null;
  };

  // ── preview canvas ──────────────────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 640, h: 360 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const view$ = useMemo(() => {
    const fit = Math.min((stage.w - 16) / project.width, (stage.h - 16) / project.height, 1);
    const cssW = Math.max(40, Math.floor(project.width * fit));
    const cssH = Math.max(24, Math.floor(project.height * fit));
    const dpr = window.devicePixelRatio || 1;
    return { cssW, cssH, pxW: Math.min(project.width, Math.round(cssW * dpr)) };
  }, [stage, project.width, project.height]);

  const drawPending = useRef(false);
  const draw = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    const p = projectRef.current;
    const scale = view$Ref.current.pxW / p.width;
    const W = Math.round(p.width * scale);
    const H = Math.round(p.height * scale);
    if (cv.width !== W || cv.height !== H) {
      cv.width = W;
      cv.height = H;
    }
    const ctx = cv.getContext('2d')!;
    const t = playheadRef.current;
    drawFrame(ctx, p, t, frameFor, scale);
    const c = findClip(p, selectedRef.current);
    if (c && c.kind !== 'audio' && t >= c.start && t < clipEnd(c) && !playingRef.current) {
      const b = clipBox(p, c, t - c.start, sizeOf);
      if (b) {
        ctx.save();
        ctx.strokeStyle = '#4ea1ff';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        const cx0 = valueAt(c.transform.x, t - c.start) * scale;
        const cy0 = valueAt(c.transform.y, t - c.start) * scale;
        ctx.translate(cx0, cy0);
        ctx.rotate((valueAt(c.transform.rotation, t - c.start) * Math.PI) / 180);
        ctx.strokeRect((b.x * scale) - cx0, (b.y * scale) - cy0, b.w * scale, b.h * scale);
        ctx.setLineDash([]);
        ctx.fillStyle = '#4ea1ff';
        ctx.fillRect(-3, -3, 6, 6);
        ctx.restore();
      }
    }
  };
  const requestDraw = () => {
    if (drawPending.current) return;
    drawPending.current = true;
    requestAnimationFrame(() => {
      drawPending.current = false;
      draw();
    });
  };
  const view$Ref = useRef(view$);
  view$Ref.current = view$;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const playingRef = useRef(false);
  const sizeOf = (c: MediaClip): [number, number] | null => {
    const s = projectRef.current.sources[c.sourceId];
    return s && s.width && s.height ? [s.width, s.height] : null;
  };

  useEffect(() => {
    if (!playingRef.current) syncVideos(project, playhead, false);
    requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, playhead, selectedId, view$]);

  // ── playback ────────────────────────────────────────────────────────────
  const audioCtx = useRef<AudioContext | null>(null);
  const mixRef = useRef<Mix | null>(null);
  const clock = useRef<{ ctxStart: number; from: number }>({ ctxStart: 0, from: 0 });
  const raf = useRef(0);
  const meterBuf = useRef(new Float32Array(1024));

  const startMix = (from: number) => {
    const ctx = audioCtx.current!;
    mixRef.current?.stop();
    const when = ctx.currentTime + 0.06;
    mixRef.current = buildMix(ctx, projectRef.current, buffers(), from, when, { limiter: true });
    clock.current = { ctxStart: when, from };
  };

  function stopPlayback() {
    cancelAnimationFrame(raf.current);
    mixRef.current?.stop();
    mixRef.current = null;
    playingRef.current = false;
    for (const el of videos.current.values()) el.pause();
    setPlaying(false);
    setLevels({});
  }

  const startPlayback = async () => {
    const dur = projectDuration(projectRef.current);
    if (dur <= 0) return;
    if (!audioCtx.current) audioCtx.current = new AudioContext({ latencyHint: 'interactive' });
    await audioCtx.current.resume();
    const from = playheadRef.current >= dur - 0.01 ? 0 : playheadRef.current;
    setPlayhead(from);
    startMix(from);
    playingRef.current = true;
    setPlaying(true);
    let frame = 0;
    const loop = () => {
      if (!playingRef.current) return;
      const ctx = audioCtx.current!;
      const t = clock.current.from + Math.max(0, ctx.currentTime - clock.current.ctxStart);
      const end = projectDuration(projectRef.current);
      if (t >= end) {
        setPlayhead(end);
        stopPlayback();
        requestDraw();
        return;
      }
      playheadRef.current = t;
      syncVideos(projectRef.current, t, true);
      draw();
      if (++frame % 3 === 0) {
        setPlayheadState(t);
        const m = mixRef.current;
        if (m) {
          const lv: Record<string, number> = { master: meterDb(m.master, meterBuf.current) };
          for (const [id, a] of m.meters) lv[id] = meterDb(a, meterBuf.current);
          setLevels(lv);
        }
      }
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
  };

  const togglePlay = () => (playingRef.current ? stopPlayback() : void startPlayback());

  // rebuild the live mix when the sound changes during playback (fader moves, mutes, edits)
  const audioKey = useMemo(
    () => JSON.stringify([project.master, project.tracks.filter((t) => t.kind === 'audio').map((t) => [t.audio, t.muted, t.solo, t.clips])]),
    [project.master, project.tracks],
  );
  const firstKey = useRef(true);
  useEffect(() => {
    if (firstKey.current) {
      firstKey.current = false;
      return;
    }
    if (!playingRef.current) return;
    const t = playheadRef.current;
    const id = setTimeout(() => playingRef.current && startMix(t), 60);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioKey]);

  const seek = (t: number) => {
    const tt = Math.max(0, t);
    setPlayhead(tt);
    if (playingRef.current) {
      startMix(tt);
      syncVideos(projectRef.current, tt, true);
    }
  };
  const step = (frames: number) => {
    if (playingRef.current) stopPlayback();
    const f = 1 / projectRef.current.fps;
    seek(Math.round(playheadRef.current / f + frames) * f);
  };

  // ── edits ───────────────────────────────────────────────────────────────
  const updateClip = (c: Clip) => commit(replaceClip(projectRef.current, c), `clip:${c.id}`);
  const updateTrack = (t: Track) => commit({ ...projectRef.current, tracks: projectRef.current.tracks.map((x) => (x.id === t.id ? t : x)) }, `track:${t.id}`);
  const updateMaster = (m: MasterBus) => commit({ ...projectRef.current, master: m }, 'master');

  const split = () => {
    if (!selectedId) return;
    const { project: next, rightId } = splitAt(projectRef.current, selectedId, playheadRef.current);
    if (!rightId) {
      onError('Move the playhead inside the selected clip to split it.');
      return;
    }
    commit(next);
    setSelectedId(rightId);
  };
  const remove = () => {
    if (!selectedId) return;
    commit(deleteClips(projectRef.current, linkedIds(projectRef.current, selectedId)));
    setSelectedId(null);
  };
  const addTrack = (kind: 'video' | 'audio') => {
    const p = projectRef.current;
    const count = p.tracks.filter((t) => t.kind === kind).length;
    const t = newTrack(kind, `${kind === 'video' ? 'V' : 'A'}${count + 1}`);
    commit({ ...p, tracks: kind === 'video' ? [t, ...p.tracks] : [...p.tracks, t] });
  };
  const addVisual = (c: VisualClip) => {
    const { project: next } = placeClip(projectRef.current, 'video', c);
    commit(next);
    setSelectedId(c.id);
    setView('timeline');
  };

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      try {
        setStatus(`Adding ${file.name}…`);
        const id = sid('S');
        let meta: SourceMeta;
        const isImage = file.type.startsWith('image/') || IMAGE_EXT.test(file.name);
        if (isImage) {
          const bmp = await createImageBitmap(file);
          meta = { id, name: file.name, kind: 'image', duration: 0, width: bmp.width, height: bmp.height, hasAudio: false, fps: null };
          bmp.close();
        } else {
          const { probeMedia } = await import('../../core/media/video-engine');
          const info = await probeMedia(file).catch(() => null);
          if (!info || (!info.hasVideo && !info.hasAudio)) throw new Error(`${file.name} can't be read here. Open it on its own first (it will be converted), save it as MP4 or WAV, then add it.`);
          meta = { id, name: file.name, kind: info.hasVideo ? 'video' : 'audio', duration: info.duration, width: info.width, height: info.height, hasAudio: info.hasAudio, fps: info.fps };
        }
        const rt = registerSource(id, file, meta);
        const { project: next, clipId } = addMediaClips(projectRef.current, meta, playheadRef.current);
        commit(next);
        setSelectedId(clipId);
        await rt.ready;
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        setStatus(null);
      }
    }
  };

  const openAudioEditor = (c: AudioClip) => {
    const buf = media.current.get(c.sourceId)?.buffer;
    if (!buf) {
      onError('The sound of this clip is still loading (or could not be decoded).');
      return;
    }
    if (playingRef.current) stopPlayback();
    const data = bufferToData(buf);
    const sr = data.sampleRate;
    setEditAudio({ clipId: c.id, data: sliceAudio(data, c.in * sr, (c.in + c.duration) * sr) });
  };

  const applyAudioEdit = (d: AudioData) => {
    const ed = editAudio;
    setEditAudio(null);
    if (!ed) return;
    const p = projectRef.current;
    const c = findClip(p, ed.clipId);
    if (!c || c.kind !== 'audio') return;
    const old = p.sources[c.sourceId];
    const id = sid('S');
    const dur = frames(d) / d.sampleRate;
    const blob = new Blob([encodeWav(d) as BlobPart], { type: 'audio/wav' });
    const name = `${(old?.name ?? c.name).replace(/( \(edited\))+$/, '')} (edited)`;
    const meta: SourceMeta = { id, name, kind: 'audio', duration: dur, width: 0, height: 0, hasAudio: true, fps: null };
    const rt: SourceRt = { blob, url: URL.createObjectURL(blob), buffer: dataToBuffer(d), peaks: { peaks: waveformPeaks(d, 0, frames(d), Math.min(60000, Math.max(200, Math.ceil(dur * 150)))), duration: dur }, bitmap: null, ready: Promise.resolve() };
    media.current.set(id, rt);
    const lengthChanged = Math.abs(dur - c.duration) > 1e-3;
    const next: AudioClip = { ...c, name, sourceId: id, in: 0, duration: dur, linkId: lengthChanged ? null : c.linkId, envelope: c.envelope.filter((k) => k.t <= dur) };
    let out = replaceClip({ ...p, sources: { ...p.sources, [id]: meta } }, next);
    if (lengthChanged && c.linkId) out = unlink(out, c.id);
    commit(out);
  };

  const measure = async () => {
    setMeasured('Measuring…');
    try {
      const r = await renderMix(projectRef.current, buffers());
      const fmtL = (v: number) => (Number.isFinite(v) ? `${v.toFixed(1)} LUFS` : 'silent');
      const t = projectRef.current.master.loudnessTarget;
      setMeasured(`Mix: ${fmtL(r.loudnessBefore)} integrated${t !== null || projectRef.current.master.limiter.enabled ? ` → export: ${fmtL(r.loudnessAfter)}` : ''}`);
    } catch (err) {
      setMeasured(null);
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  // ── on-canvas move of the selected (or clicked) layer ───────────────────
  const canvasDrag = useRef<{ id: string; x0: number; y0: number; px: number; py: number } | null>(null);
  const toProject = (e: RPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const p = projectRef.current;
    return { x: ((e.clientX - r.left) / r.width) * p.width, y: ((e.clientY - r.top) / r.height) * p.height };
  };
  const hitTest = (x: number, y: number): VisualClip | null => {
    const p = projectRef.current;
    const t = playheadRef.current;
    for (const tr of p.tracks) {
      if (tr.kind !== 'video' || tr.muted) continue;
      for (const c of [...tr.clips].reverse()) {
        if (c.kind === 'audio' || t < c.start || t >= clipEnd(c)) continue;
        const b = clipBox(p, c, t - c.start, sizeOf);
        if (b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return c;
      }
    }
    return null;
  };
  const onCanvasDown = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (playingRef.current) return;
    const pt = toProject(e);
    const sel = findClip(projectRef.current, selectedRef.current);
    const t = playheadRef.current;
    const cur = sel && sel.kind !== 'audio' && t >= sel.start && t < clipEnd(sel) ? sel : null;
    const curBox = cur ? clipBox(projectRef.current, cur, t - cur.start, sizeOf) : null;
    const inCur = curBox && pt.x >= curBox.x && pt.x <= curBox.x + curBox.w && pt.y >= curBox.y && pt.y <= curBox.y + curBox.h;
    const target = inCur ? cur : hitTest(pt.x, pt.y);
    if (!target) {
      setSelectedId(null);
      return;
    }
    setSelectedId(target.id);
    const tr = projectRef.current.tracks.find((x) => x.clips.some((c) => c.id === target.id));
    if (tr?.locked) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const local = t - target.start;
    canvasDrag.current = { id: target.id, x0: pt.x, y0: pt.y, px: valueAt(target.transform.x, local), py: valueAt(target.transform.y, local) };
    beginDrag();
  };
  const onCanvasMove = (e: RPointerEvent<HTMLCanvasElement>) => {
    const d = canvasDrag.current;
    if (!d) return;
    const pt = toProject(e);
    const p = projectRef.current;
    const c = findClip(p, d.id) as VisualClip | null;
    if (!c) return;
    const local = playheadRef.current - c.start;
    let nx = d.px + pt.x - d.x0;
    let ny = d.py + pt.y - d.y0;
    if (snapOn && !e.shiftKey) {
      const thr = p.width / 80;
      if (Math.abs(nx - p.width / 2) < thr) nx = p.width / 2;
      if (Math.abs(ny - p.height / 2) < thr) ny = p.height / 2;
    }
    previewDrag(replaceClip(p, { ...c, transform: { ...c.transform, x: setValueAt(c.transform.x, local, Math.round(nx)), y: setValueAt(c.transform.y, local, Math.round(ny)) } } as Clip));
  };
  const onCanvasUp = () => {
    if (!canvasDrag.current) return;
    canvasDrag.current = null;
    endDrag();
  };

  // ── keyboard ────────────────────────────────────────────────────────────
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (e: KeyboardEvent) => {
    if (editAudio) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    if (document.querySelector('.modal-backdrop')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
    } else if (mod) return;
    else if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 's' || e.key === 'S') split();
    else if (e.key === 'Delete' || e.key === 'Backspace') remove();
    else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      step(e.shiftKey ? -10 : -1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      step(e.shiftKey ? 10 : 1);
    } else if (e.key === 'Home') seek(0);
    else if (e.key === 'End') seek(projectDuration(projectRef.current));
    else if (e.key === '=' || e.key === '+') setPps((v) => Math.min(800, v * 1.4));
    else if (e.key === '-') setPps((v) => Math.max(2, v / 1.4));
  };
  const tabActive0 = useTabActive();
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (tabActive0.current) keyHandler.current(e);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const fit = () => {
    const w = (bottomRef.current?.clientWidth ?? 900) - TIMELINE_HEADER - 30;
    setPps(Math.max(2, Math.min(800, w / Math.max(5, duration))));
  };
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || duration <= 0) return;
    fitted.current = true;
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration]);

  const peaksFor = (sourceId: string) => media.current.get(sourceId)?.peaks ?? null;
  const editing = editAudio ? (findClip(project, editAudio.clipId) as AudioClip | null) : null;

  return (
    <div className="studio">
      <div className="st-toolbar" role="toolbar" aria-label="Studio">
        <button type="button" className="btn" onClick={() => fileInput.current?.click()} title="Add video, audio or image files at the playhead">
          <Plus size={14} /> Add media
        </button>
        <input ref={fileInput} type="file" hidden multiple accept="video/*,audio/*,image/*,.mkv,.mov,.m4a,.flac,.opus,.ogg,.wav" onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
        <button type="button" className="btn" onClick={() => addVisual(textClip(projectRef.current, playheadRef.current))} title="Add a title"><Type size={14} /> Text</button>
        <button type="button" className="btn" onClick={() => addVisual(solidClip(projectRef.current, playheadRef.current))} title="Add a colour / gradient layer"><Square size={14} /> Colour</button>
        <button type="button" className="btn btn-text" onClick={() => addTrack('video')} title="Add a video track"><Film size={14} /> + Video track</button>
        <button type="button" className="btn btn-text" onClick={() => addTrack('audio')} title="Add an audio track"><Rows3 size={14} /> + Audio track</button>
        <span className="st-sep" />
        <button type="button" className="btn btn-icon" onClick={split} disabled={!selected} title="Split at playhead (S)" aria-label="Split"><Scissors size={15} /></button>
        <button type="button" className="btn btn-icon" onClick={remove} disabled={!selected} title="Delete clip (Del)" aria-label="Delete clip"><Trash2 size={15} /></button>
        <button type="button" className="btn btn-icon" onClick={() => selectedId && commit(unlink(projectRef.current, selectedId))} disabled={!selected?.linkId} title="Unlink picture and sound" aria-label="Unlink"><Unlink size={15} /></button>
        <button type="button" className="btn btn-icon" onClick={undo} disabled={!hist.past.length} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo2 size={15} /></button>
        <button type="button" className="btn btn-icon" onClick={redo} disabled={!hist.future.length} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Redo2 size={15} /></button>
        <span className="spacer" />
        {status && <span className="st-hint" role="status">{status}</span>}
        <div className="workspace-switch st-view" role="radiogroup" aria-label="Bottom panel">
          <button type="button" role="radio" aria-checked={view === 'timeline'} className={view === 'timeline' ? 'is-active' : ''} onClick={() => setView('timeline')}><Rows3 size={13} /> Timeline</button>
          <button type="button" role="radio" aria-checked={view === 'graph'} className={view === 'graph' ? 'is-active' : ''} onClick={() => setView('graph')} title="Animation curves of the selected clip"><Spline size={13} /> Graph</button>
          <button type="button" role="radio" aria-checked={view === 'mixer'} className={view === 'mixer' ? 'is-active' : ''} onClick={() => setView('mixer')}><SlidersHorizontal size={13} /> Mixer</button>
        </div>
        <button type="button" className="btn btn-icon" title="Studio guide" aria-label="Studio guide" onClick={() => openGuide(view === 'mixer' ? 'studio-mixer' : 'studio')}>
          <CircleHelp size={15} />
        </button>
      </div>

      <div className="st-main">
        <div className="st-stage" ref={stageRef}>
          <canvas
            ref={canvasRef}
            className="st-canvas"
            style={{ width: view$.cssW, height: view$.cssH }}
            onPointerDown={onCanvasDown}
            onPointerMove={onCanvasMove}
            onPointerUp={onCanvasUp}
            aria-label="Preview: drag a layer to move it"
          />
        </div>
        <Inspector
          project={project}
          clip={selected}
          playhead={playhead}
          easing={easing}
          onEasing={setEasing}
          onChange={updateClip}
          onSeek={seek}
          onEditAudio={openAudioEditor}
        />
      </div>

      <div className="st-transport">
        <button type="button" className="btn btn-icon" onClick={() => seek(0)} title="Go to start (Home)" aria-label="Go to start"><SkipBack size={15} /></button>
        <button type="button" className="btn btn-icon" onClick={() => step(-1)} title="Previous frame (←)" aria-label="Previous frame"><StepBack size={15} /></button>
        <button type="button" className={cx('btn', 'st-play', playing && 'is-on')} onClick={togglePlay} title="Play / pause (Space)" aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button type="button" className="btn btn-icon" onClick={() => step(1)} title="Next frame (→)" aria-label="Next frame"><StepForward size={15} /></button>
        <span className="st-time" aria-label="Playhead">{formatTimecode(playhead, project.fps)} <small>/ {formatTimecode(duration, project.fps)}</small></span>
        <span className="st-hint">{project.width}×{project.height} · {project.fps} fps</span>
        <span className="spacer" />
        <button type="button" className={cx('btn btn-icon', snapOn && 'is-active')} onClick={() => setSnapOn(!snapOn)} title="Snapping" aria-label="Snapping" aria-pressed={snapOn}><Magnet size={15} /></button>
        <button type="button" className="btn btn-icon" onClick={() => setPps((v) => Math.max(2, v / 1.4))} title="Zoom out (−)" aria-label="Zoom out"><Minus size={15} /></button>
        <button type="button" className="btn btn-text" onClick={fit} title="Fit the whole timeline">Fit</button>
        <button type="button" className="btn btn-icon" onClick={() => setPps((v) => Math.min(800, v * 1.4))} title="Zoom in (+)" aria-label="Zoom in"><Plus size={15} /></button>
      </div>

      <div className="st-bottom" ref={bottomRef}>
        {view === 'timeline' ? (
          <Timeline
            project={project}
            playhead={playhead}
            pps={pps}
            selectedId={selectedId}
            snapOn={snapOn}
            peaks={peaksFor}
            onSeek={(t) => seek(t)}
            onSelect={setSelectedId}
            onPreview={previewDrag}
            onBegin={beginDrag}
            onCommit={endDrag}
            onTrack={updateTrack}
          />
        ) : view === 'graph' ? (
          <GraphEditor project={project} clip={selected} playhead={playhead} onChange={updateClip} onSeek={seek} />
        ) : (
          <Mixer project={project} levels={levels} onTrack={updateTrack} onMaster={updateMaster} onMeasure={() => void measure()} measured={measured} />
        )}
      </div>

      {editAudio && editing && (
        <AudioClipEditor name={editing.name} data={editAudio.data} onApply={applyAudioEdit} onClose={() => setEditAudio(null)} />
      )}
    </div>
  );
});
