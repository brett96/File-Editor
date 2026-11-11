import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Crop,
  FlipHorizontal2,
  FlipVertical2,
  Info,
  Music,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Trash2,
  Type,
  Undo2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { FILTER_LABELS, NO_ADJUSTMENTS, type Adjustments, type FilterPreset, type Pixels } from '../../core/media/image-ops';
import { NO_EDITS, grabFrame, renderFrameEffects, type MediaInfo, type TextOverlay, type VideoEdits } from '../../core/media/video-engine';
import { newId } from '../../core/pdf/types';
import { Divider, IconButton, MenuItem, Popover, cx } from '../components';

export interface VideoEditorHandle {
  getEdits(): VideoEdits;
  /** Current frame with every edit applied, at full output resolution. */
  captureFrame(): Promise<Pixels>;
  currentTime(): number;
}

interface Props {
  blob: Blob;
  info: MediaInfo;
  onChange: () => void;
  onError: (m: string) => void;
  onSaveFrame: (px: Pixels, time: number) => void;
  onEditFrame: (px: Pixels, time: number) => void;
}

type Panel = 'look' | 'text' | 'audio' | 'info' | null;

const ADJUST_FIELDS: { key: keyof Adjustments; label: string; min: number; max: number }[] = [
  { key: 'exposure', label: 'Exposure', min: -100, max: 100 },
  { key: 'brightness', label: 'Brightness', min: -100, max: 100 },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
  { key: 'warmth', label: 'Warmth', min: -100, max: 100 },
  { key: 'hue', label: 'Hue', min: -180, max: 180 },
  { key: 'vignette', label: 'Vignette', min: 0, max: 100 },
];

const PREVIEW_MAX = 960;

export function formatTime(t: number, withMs = true): string {
  if (!isFinite(t)) return '0:00';
  const sign = t < 0 ? '-' : '';
  t = Math.abs(t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t % 1) * 10);
  const core = h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  return sign + core + (withMs ? `.${ms}` : '');
}

/** Size of the frame after rotation (before crop). */
export function rotatedSize(info: MediaInfo, e: Pick<VideoEdits, 'rotate'>): { width: number; height: number } {
  return e.rotate % 180 ? { width: info.height, height: info.width } : { width: info.width, height: info.height };
}

/** Draws a source frame with the edit's rotation / flip / crop onto ctx (size outW×outH). */
function drawTransformed(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  srcW: number,
  srcH: number,
  e: VideoEdits,
  outW: number,
  outH: number,
  applyCrop: boolean,
) {
  const rot = e.rotate % 180 ? { width: srcH, height: srcW } : { width: srcW, height: srcH };
  const c = applyCrop && e.crop ? e.crop : { left: 0, top: 0, width: rot.width, height: rot.height };
  const k = outW / c.width;
  ctx.save();
  ctx.clearRect(0, 0, outW, outH);
  ctx.scale(k, outH / c.height);
  ctx.translate(-c.left, -c.top);
  // into rotated-frame space
  ctx.translate(rot.width / 2, rot.height / 2);
  if (e.flipH) ctx.scale(-1, 1);
  if (e.flipV) ctx.scale(1, -1);
  ctx.rotate((e.rotate * Math.PI) / 180);
  ctx.drawImage(src, -srcW / 2, -srcH / 2, srcW, srcH);
  ctx.restore();
}

export const VideoEditor = forwardRef<VideoEditorHandle, Props>(function VideoEditor({ blob, info, onChange, onError, onSaveFrame, onEditFrame }, ref) {
  const [edits, setEditsRaw] = useState<VideoEdits>(NO_EDITS);
  const past = useRef<VideoEdits[]>([]);
  const future = useRef<VideoEdits[]>([]);
  const [, bump] = useState(0);
  const [panel, setPanel] = useState<Panel>(info.hasVideo ? 'look' : 'audio');
  const [cropping, setCropping] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [playable, setPlayable] = useState(true);
  const [selectedOverlay, setSelectedOverlay] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const sinkFrame = useRef<{ canvas: CanvasImageSource; w: number; h: number } | null>(null);
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  const duration = info.duration;
  const trimEnd = edits.trimEnd ?? duration;
  const rot = rotatedSize(info, edits);
  const crop = edits.crop ?? { left: 0, top: 0, width: rot.width, height: rot.height };
  const view = cropping ? { width: rot.width, height: rot.height } : { width: crop.width, height: crop.height };
  const pk = Math.min(1, PREVIEW_MAX / Math.max(view.width || 1, view.height || 1));
  const pw = Math.max(1, Math.round(view.width * pk));
  const ph = Math.max(1, Math.round(view.height * pk));

  // ── edit history ─────────────────────────────────────────────────────────
  const setEdits = useCallback(
    (patch: Partial<VideoEdits> | ((e: VideoEdits) => VideoEdits), record = true) => {
      const next = typeof patch === 'function' ? patch(editsRef.current) : { ...editsRef.current, ...patch };
      if (record) {
        past.current.push(editsRef.current);
        if (past.current.length > 200) past.current.shift();
        future.current = [];
        onChange();
      }
      editsRef.current = next;
      setEditsRaw(next);
      bump((n) => n + 1);
    },
    [onChange],
  );
  const undo = () => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(editsRef.current);
    setEditsRaw(prev);
    onChange();
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(editsRef.current);
    setEditsRaw(next);
    onChange();
  };

  // ── preview rendering ────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !info.hasVideo) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const v = videoRef.current;
    let src: CanvasImageSource | null = null;
    let sw = 0;
    let sh = 0;
    if (playable && v && v.readyState >= 2) {
      src = v;
      sw = v.videoWidth;
      sh = v.videoHeight;
    } else if (sinkFrame.current) {
      src = sinkFrame.current.canvas;
      sw = sinkFrame.current.w;
      sh = sinkFrame.current.h;
    }
    if (!src || !sw) return;
    const e = editsRef.current;
    drawTransformed(ctx, src, sw, sh, e, canvas.width, canvas.height, !cropping);
    if (!cropping) {
      // effects are defined in output-frame terms, so render them at preview scale
      renderFrameEffects(ctx, canvas.width, canvas.height, (v?.currentTime ?? 0) - e.trimStart, (e.trimEnd ?? duration) - e.trimStart, e);
    }
  }, [info.hasVideo, playable, cropping, duration]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = pw;
      canvas.height = ph;
    }
    draw();
  }, [pw, ph, edits, draw]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let handle = 0;
    const tick = () => {
      draw();
      setTime(v.currentTime);
      const e = editsRef.current;
      const end = e.trimEnd ?? duration;
      if (!v.paused && v.currentTime >= end - 0.02) {
        v.pause();
        v.currentTime = e.trimStart;
      }
      handle = 'requestVideoFrameCallback' in v ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    };
    handle = 'requestVideoFrameCallback' in v ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    const onSeeked = () => {
      draw();
      setTime(v.currentTime);
    };
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('loadeddata', onSeeked);
    return () => {
      if ('cancelVideoFrameCallback' in v) v.cancelVideoFrameCallback(handle);
      cancelAnimationFrame(handle);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('loadeddata', onSeeked);
    };
  }, [draw, duration]);

  // audio follows the edit live
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = edits.mute;
    v.volume = Math.min(1, edits.volume);
  }, [edits.mute, edits.volume]);

  /** Browser can't play this file: render frames through WebCodecs instead (scrub only). */
  const renderSinkFrame = useCallback(
    async (t: number) => {
      if (!info.hasVideo) return;
      try {
        const c = await grabFrame(blob, t);
        sinkFrame.current = { canvas: c, w: c.width, h: c.height };
        draw();
      } catch {
        /* keep the last frame */
      }
    },
    [blob, draw, info.hasVideo],
  );

  useEffect(() => {
    if (!playable) void renderSinkFrame(time);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playable]);

  const seek = (t: number) => {
    const clamped = Math.max(0, Math.min(duration, t));
    const v = videoRef.current;
    if (playable && v) v.currentTime = clamped;
    else {
      setTime(clamped);
      void renderSinkFrame(clamped);
    }
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v || !playable) return;
    if (v.paused) {
      if (v.currentTime < edits.trimStart || v.currentTime >= trimEnd - 0.05) v.currentTime = edits.trimStart;
      void v.play();
    } else v.pause();
  };

  const captureFrame = async (): Promise<Pixels> => {
    const e = editsRef.current;
    const t = videoRef.current?.currentTime ?? time;
    const frame = await grabFrame(blob, t);
    const r = rotatedSize(info, e);
    const c = e.crop ?? { left: 0, top: 0, width: r.width, height: r.height };
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(c.width);
    canvas.height = Math.round(c.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    drawTransformed(ctx, frame, frame.width, frame.height, e, canvas.width, canvas.height, true);
    renderFrameEffects(ctx, canvas.width, canvas.height, t - e.trimStart, (e.trimEnd ?? duration) - e.trimStart, e);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: img.data, width: img.width, height: img.height };
  };

  useImperativeHandle(ref, () => ({
    getEdits: () => editsRef.current,
    currentTime: () => videoRef.current?.currentTime ?? time,
    captureFrame,
  }));

  const frameAction = async (fn: (px: Pixels, t: number) => void) => {
    try {
      const t = videoRef.current?.currentTime ?? time;
      fn(await captureFrame(), t);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not read that frame.');
    }
  };

  // ── keyboard ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement;
      if (t instanceof Element && t.closest('input, textarea, select, .modal')) return;
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.key.toLowerCase() === 'z' && !ev.shiftKey) {
        ev.preventDefault();
        undo();
      } else if (mod && (ev.key.toLowerCase() === 'y' || (ev.key.toLowerCase() === 'z' && ev.shiftKey))) {
        ev.preventDefault();
        redo();
      } else if (ev.key === ' ' || ev.key === 'k') {
        ev.preventDefault();
        togglePlay();
      } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        ev.preventDefault();
        const step = ev.shiftKey ? 1 : 1 / (info.fps || 30);
        seek((videoRef.current?.currentTime ?? time) + (ev.key === 'ArrowLeft' ? -step : step));
      } else if (ev.key === 'i') setEdits({ trimStart: Math.min(time, trimEnd - 0.1) });
      else if (ev.key === 'o') setEdits({ trimEnd: Math.max(time, edits.trimStart + 0.1) });
      else if (ev.key === 'Escape') setCropping(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── timeline ─────────────────────────────────────────────────────────────
  const timelineDrag = useRef<'start' | 'end' | 'head' | null>(null);
  const timeAt = (e: { clientX: number }) => {
    const r = timelineRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((e.clientX - r.left) / r.width) * duration));
  };
  const onTimelineDown = (e: RPointerEvent<HTMLDivElement>, what: 'start' | 'end' | 'head') => {
    e.preventDefault();
    e.stopPropagation();
    timelineRef.current?.setPointerCapture(e.pointerId);
    if (what !== 'head') past.current.push(editsRef.current);
    timelineDrag.current = what;
    if (what === 'head') seek(timeAt(e));
  };
  const onTimelineMove = (e: RPointerEvent<HTMLDivElement>) => {
    const what = timelineDrag.current;
    if (!what) return;
    const t = timeAt(e);
    if (what === 'head') seek(t);
    else if (what === 'start') {
      setEdits({ trimStart: Math.min(t, (editsRef.current.trimEnd ?? duration) - 0.1) }, false);
      seek(Math.min(t, (editsRef.current.trimEnd ?? duration) - 0.1));
    } else {
      setEdits({ trimEnd: Math.max(t, editsRef.current.trimStart + 0.1) }, false);
      seek(Math.max(t, editsRef.current.trimStart + 0.1));
    }
  };
  const onTimelineUp = () => {
    if (timelineDrag.current && timelineDrag.current !== 'head') {
      future.current = [];
      onChange();
    }
    timelineDrag.current = null;
  };

  // ── crop / overlay dragging on the preview ───────────────────────────────
  const stageDrag = useRef<{ kind: 'crop-new' | 'crop-move' | 'overlay'; start: [number, number]; orig?: VideoEdits['crop']; id?: string } | null>(null);
  const toFrame = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * view.width, ((e.clientY - r.top) / r.height) * view.height];
  };
  const onStageDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !info.hasVideo) return;
    const [x, y] = toFrame(e);
    stageRef.current?.setPointerCapture(e.pointerId);
    if (cropping) {
      past.current.push(editsRef.current);
      const c = editsRef.current.crop;
      if (c && x >= c.left && x <= c.left + c.width && y >= c.top && y <= c.top + c.height) stageDrag.current = { kind: 'crop-move', start: [x, y], orig: c };
      else stageDrag.current = { kind: 'crop-new', start: [x, y] };
      return;
    }
    if (selectedOverlay) {
      past.current.push(editsRef.current);
      stageDrag.current = { kind: 'overlay', start: [x, y], id: selectedOverlay };
    } else togglePlay();
  };
  const onStageMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = stageDrag.current;
    if (!d) return;
    const [x, y] = toFrame(e);
    if (d.kind === 'crop-new') {
      const x0 = Math.max(0, Math.min(d.start[0], x));
      const y0 = Math.max(0, Math.min(d.start[1], y));
      const x1 = Math.min(rot.width, Math.max(d.start[0], x));
      const y1 = Math.min(rot.height, Math.max(d.start[1], y));
      setEdits({ crop: { left: x0, top: y0, width: Math.max(16, x1 - x0), height: Math.max(16, y1 - y0) } }, false);
    } else if (d.kind === 'crop-move' && d.orig) {
      const nx = Math.max(0, Math.min(rot.width - d.orig.width, d.orig.left + x - d.start[0]));
      const ny = Math.max(0, Math.min(rot.height - d.orig.height, d.orig.top + y - d.start[1]));
      setEdits({ crop: { ...d.orig, left: nx, top: ny } }, false);
    } else if (d.kind === 'overlay' && d.id) {
      setEdits((ed) => ({ ...ed, overlays: ed.overlays.map((o) => (o.id === d.id ? { ...o, x: Math.max(0, Math.min(1, x / view.width)), y: Math.max(0, Math.min(1, y / view.height)) } : o)) }), false);
    }
  };
  const onStageUp = () => {
    if (stageDrag.current) {
      future.current = [];
      onChange();
      // even dimensions keep H.264/HEVC encoders happy
      const c = editsRef.current.crop;
      if (c) setEdits({ crop: { left: Math.round(c.left), top: Math.round(c.top), width: Math.round(c.width / 2) * 2, height: Math.round(c.height / 2) * 2 } }, false);
    }
    stageDrag.current = null;
  };

  const setAdjust = (key: keyof Adjustments, value: number, record: boolean) => setEdits((e) => ({ ...e, adjustments: { ...e.adjustments, [key]: value } }), record);
  const updateOverlay = (id: string, patch: Partial<TextOverlay>, record = true) =>
    setEdits((e) => ({ ...e, overlays: e.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o)) }), record);
  const selected = edits.overlays.find((o) => o.id === selectedOverlay) ?? null;

  const rotateBy = (d: 90 | -90) =>
    setEdits((e) => ({ ...e, rotate: ((((e.rotate + d) % 360) + 360) % 360) as VideoEdits['rotate'], crop: null }));

  const clipLen = trimEnd - edits.trimStart;
  const pct = (t: number) => `${(t / (duration || 1)) * 100}%`;

  return (
    <div className="editor-root">
      <div className="toolbar" role="toolbar" aria-label="Video tools">
        <IconButton label="Undo (Ctrl+Z)" disabled={!past.current.length} onClick={undo}><Undo2 size={16} /></IconButton>
        <IconButton label="Redo (Ctrl+Y)" disabled={!future.current.length} onClick={redo}><Redo2 size={16} /></IconButton>
        <Divider />
        <IconButton label={playing ? 'Pause (Space)' : 'Play (Space)'} disabled={!playable} onClick={togglePlay}>{playing ? <Pause size={16} /> : <Play size={16} />}</IconButton>
        <IconButton label="Previous frame (←)" onClick={() => seek(time - 1 / (info.fps || 30))}><ChevronLeft size={16} /></IconButton>
        <IconButton label="Next frame (→)" onClick={() => seek(time + 1 / (info.fps || 30))}><ChevronRight size={16} /></IconButton>
        <span className="tb-readout time-readout">{formatTime(time)} / {formatTime(duration)}</span>
        <button type="button" className="btn btn-text" title="Start the clip here (I)" onClick={() => setEdits({ trimStart: Math.min(time, trimEnd - 0.1) })}>[ Set start</button>
        <button type="button" className="btn btn-text" title="End the clip here (O)" onClick={() => setEdits({ trimEnd: Math.max(time, edits.trimStart + 0.1) })}>Set end ]</button>
        {info.hasVideo && (
          <>
            <Divider />
            <IconButton label="Crop" active={cropping} onClick={() => setCropping(!cropping)}><Crop size={16} /></IconButton>
            <IconButton label="Rotate left" onClick={() => rotateBy(-90)}><RotateCcw size={16} /></IconButton>
            <IconButton label="Rotate right" onClick={() => rotateBy(90)}><RotateCw size={16} /></IconButton>
            <IconButton label="Flip horizontally" active={edits.flipH} onClick={() => setEdits({ flipH: !edits.flipH })}><FlipHorizontal2 size={16} /></IconButton>
            <IconButton label="Flip vertically" active={edits.flipV} onClick={() => setEdits({ flipV: !edits.flipV })}><FlipVertical2 size={16} /></IconButton>
            <Divider />
            <IconButton label="Look (filters & colour)" active={panel === 'look'} onClick={() => setPanel(panel === 'look' ? null : 'look')}><SlidersHorizontal size={16} /></IconButton>
            <IconButton label="Text" active={panel === 'text'} onClick={() => setPanel(panel === 'text' ? null : 'text')}><Type size={16} /></IconButton>
          </>
        )}
        {info.hasAudio && <IconButton label="Sound" active={panel === 'audio'} onClick={() => setPanel(panel === 'audio' ? null : 'audio')}>{edits.mute ? <VolumeX size={16} /> : <Volume2 size={16} />}</IconButton>}
        <IconButton label="File info" active={panel === 'info'} onClick={() => setPanel(panel === 'info' ? null : 'info')}><Info size={16} /></IconButton>
        {info.hasVideo && (
          <Popover label="Save this frame" button={<Camera size={16} />}>
            {(close) => (
              <div className="menu">
                <MenuItem onClick={() => { close(); void frameAction(onSaveFrame); }}>Save frame as image…</MenuItem>
                <MenuItem onClick={() => { close(); void frameAction(onEditFrame); }}>Edit frame in the image editor</MenuItem>
              </div>
            )}
          </Popover>
        )}
        {cropping && (
          <>
            <Divider />
            <span className="tb-readout">{edits.crop ? `${Math.round(crop.width)} × ${Math.round(crop.height)}` : 'Drag on the video to crop'}</span>
            {edits.crop && <button type="button" className="btn btn-text" onClick={() => setEdits({ crop: null })}>Reset</button>}
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setCropping(false)}>Done</button>
          </>
        )}
      </div>

      <div className="image-body">
        <div className="workspace video-view">
          <video
            ref={videoRef}
            src={url}
            className="video-src"
            playsInline
            preload="auto"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onError={() => {
              setPlayable(false);
              onError('This browser cannot play this file directly, so the preview shows still frames. Editing and saving still work.');
            }}
          />
          {info.hasVideo ? (
            <div className="video-stage" ref={stageRef} onPointerDown={onStageDown} onPointerMove={onStageMove} onPointerUp={onStageUp} onPointerCancel={onStageUp}>
              <canvas ref={canvasRef} className={cx('video-canvas', cropping && 'is-cropping', selectedOverlay && 'is-moving')} />
              {cropping && edits.crop && (
                <svg className="video-crop" viewBox={`0 0 ${view.width} ${view.height}`} preserveAspectRatio="none">
                  <path d={`M0 0H${view.width}V${view.height}H0Z M${crop.left} ${crop.top}v${crop.height}h${crop.width}v${-crop.height}Z`} fill="rgba(0,0,0,0.55)" fillRule="evenodd" />
                  <rect x={crop.left} y={crop.top} width={crop.width} height={crop.height} fill="none" stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                </svg>
              )}
            </div>
          ) : (
            <div className="audio-stage">
              <Music size={56} />
              <button type="button" className="btn btn-primary" onClick={togglePlay}>{playing ? <Pause size={16} /> : <Play size={16} />} {playing ? 'Pause' : 'Play'}</button>
            </div>
          )}
          <div className="timeline-wrap">
            <div className="timeline" ref={timelineRef} onPointerDown={(e) => onTimelineDown(e, 'head')} onPointerMove={onTimelineMove} onPointerUp={onTimelineUp} onPointerCancel={onTimelineUp}>
              <div className="tl-dim" style={{ left: 0, width: pct(edits.trimStart) }} />
              <div className="tl-dim" style={{ left: pct(trimEnd), right: 0 }} />
              <div className="tl-range" style={{ left: pct(edits.trimStart), width: `calc(${pct(trimEnd)} - ${pct(edits.trimStart)})` }} />
              <div className="tl-handle tl-start" style={{ left: pct(edits.trimStart) }} onPointerDown={(e) => onTimelineDown(e, 'start')} role="slider" aria-label="Clip start" aria-valuenow={edits.trimStart} tabIndex={0} />
              <div className="tl-handle tl-end" style={{ left: pct(trimEnd) }} onPointerDown={(e) => onTimelineDown(e, 'end')} role="slider" aria-label="Clip end" aria-valuenow={trimEnd} tabIndex={0} />
              <div className="tl-head" style={{ left: pct(time) }} />
            </div>
            <div className="timeline-meta">
              <span>Start {formatTime(edits.trimStart)}</span>
              <span>Clip length {formatTime(clipLen)}</span>
              <span>End {formatTime(trimEnd)}</span>
            </div>
          </div>
        </div>

        {panel === 'look' && info.hasVideo && (
          <aside className="side-panel" aria-label="Look">
            <h3>Filter</h3>
            <div className="chip-row">
              {(Object.keys(FILTER_LABELS) as FilterPreset[]).map((f) => (
                <button key={f} type="button" className={cx('chip', edits.filter === f && 'is-active')} onClick={() => setEdits({ filter: f })}>{FILTER_LABELS[f]}</button>
              ))}
            </div>
            <h3>Colour</h3>
            {ADJUST_FIELDS.map((f) => (
              <label key={f.key} className="slider-row">
                <span>{f.label}</span>
                <input
                  type="range"
                  min={f.min}
                  max={f.max}
                  value={edits.adjustments[f.key]}
                  onPointerDown={() => { past.current.push(editsRef.current); }}
                  onChange={(e) => setAdjust(f.key, Number(e.target.value), false)}
                  onPointerUp={() => onChange()}
                  onDoubleClick={() => setAdjust(f.key, 0, true)}
                />
                <output>{edits.adjustments[f.key]}</output>
              </label>
            ))}
            <h3>Fade</h3>
            <label className="slider-row"><span>Fade in</span><input type="range" min={0} max={Math.min(5, clipLen / 2)} step={0.1} value={edits.fadeIn} onChange={(e) => setEdits({ fadeIn: Number(e.target.value) }, false)} onPointerUp={() => onChange()} /><output>{edits.fadeIn.toFixed(1)}s</output></label>
            <label className="slider-row"><span>Fade out</span><input type="range" min={0} max={Math.min(5, clipLen / 2)} step={0.1} value={edits.fadeOut} onChange={(e) => setEdits({ fadeOut: Number(e.target.value) }, false)} onPointerUp={() => onChange()} /><output>{edits.fadeOut.toFixed(1)}s</output></label>
            <div className="panel-actions">
              <button type="button" className="btn btn-text" onClick={() => setEdits({ adjustments: NO_ADJUSTMENTS, filter: 'none', fadeIn: 0, fadeOut: 0 })}>Reset look</button>
            </div>
            <p className="panel-note">Colour changes and text are drawn into every frame, so the video is re-encoded when saved.</p>
          </aside>
        )}

        {panel === 'text' && info.hasVideo && (
          <aside className="side-panel" aria-label="Text overlays">
            <h3>Text on video</h3>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                const o: TextOverlay = { id: newId('ov'), text: 'Your text', x: 0.5, y: 0.85, size: 0.07, color: '#ffffff', background: true, start: null, end: null };
                setEdits((e) => ({ ...e, overlays: [...e.overlays, o] }));
                setSelectedOverlay(o.id);
              }}
            >
              <Plus size={14} /> Add text
            </button>
            <ul className="overlay-list">
              {edits.overlays.map((o) => (
                <li key={o.id}>
                  <button type="button" className={cx('overlay-item', o.id === selectedOverlay && 'is-active')} onClick={() => setSelectedOverlay(o.id === selectedOverlay ? null : o.id)}>
                    {o.text || '(empty)'}
                  </button>
                </li>
              ))}
            </ul>
            {selected && (
              <div className="overlay-form">
                <label className="field"><span className="field-label">Text</span>
                  <textarea className="input textarea" rows={2} value={selected.text} onChange={(e) => updateOverlay(selected.id, { text: e.target.value }, false)} onBlur={() => onChange()} />
                </label>
                <label className="slider-row"><span>Size</span><input type="range" min={0.02} max={0.25} step={0.005} value={selected.size} onChange={(e) => updateOverlay(selected.id, { size: Number(e.target.value) }, false)} /><output>{Math.round(selected.size * 100)}</output></label>
                <div className="grid-2">
                  <label className="field"><span className="field-label">Colour</span><input type="color" className="input" value={selected.color} onChange={(e) => updateOverlay(selected.id, { color: e.target.value })} /></label>
                  <label className="check"><input type="checkbox" checked={selected.background} onChange={(e) => updateOverlay(selected.id, { background: e.target.checked })} /> Dark box behind</label>
                </div>
                <div className="grid-2">
                  <label className="field"><span className="field-label">Show from</span>
                    <div className="input-suffix"><input className="input" type="number" min={0} step={0.1} placeholder="start" value={selected.start ?? ''} onChange={(e) => updateOverlay(selected.id, { start: e.target.value === '' ? null : Number(e.target.value) })} /><span>s</span></div>
                  </label>
                  <label className="field"><span className="field-label">Until</span>
                    <div className="input-suffix"><input className="input" type="number" min={0} step={0.1} placeholder="end" value={selected.end ?? ''} onChange={(e) => updateOverlay(selected.id, { end: e.target.value === '' ? null : Number(e.target.value) })} /><span>s</span></div>
                  </label>
                </div>
                <p className="panel-note">Times are measured from the start of the trimmed clip. Drag on the video to move the text.</p>
                <button type="button" className="btn btn-text btn-danger" onClick={() => { setEdits((e) => ({ ...e, overlays: e.overlays.filter((x) => x.id !== selected.id) })); setSelectedOverlay(null); }}><Trash2 size={14} /> Remove text</button>
              </div>
            )}
          </aside>
        )}

        {panel === 'audio' && info.hasAudio && (
          <aside className="side-panel" aria-label="Sound">
            <h3>Sound</h3>
            <label className="check"><input type="checkbox" checked={edits.mute} onChange={(e) => setEdits({ mute: e.target.checked })} /> Remove sound</label>
            <label className="slider-row"><span>Volume</span><input type="range" min={0} max={2} step={0.05} disabled={edits.mute} value={edits.volume} onChange={(e) => setEdits({ volume: Number(e.target.value) }, false)} onPointerUp={() => onChange()} /><output>{Math.round(edits.volume * 100)}%</output></label>
            <label className="slider-row"><span>Fade in</span><input type="range" min={0} max={Math.min(10, clipLen / 2)} step={0.1} value={edits.fadeIn} onChange={(e) => setEdits({ fadeIn: Number(e.target.value) }, false)} onPointerUp={() => onChange()} /><output>{edits.fadeIn.toFixed(1)}s</output></label>
            <label className="slider-row"><span>Fade out</span><input type="range" min={0} max={Math.min(10, clipLen / 2)} step={0.1} value={edits.fadeOut} onChange={(e) => setEdits({ fadeOut: Number(e.target.value) }, false)} onPointerUp={() => onChange()} /><output>{edits.fadeOut.toFixed(1)}s</output></label>
            <p className="panel-note">To keep only the sound, choose an audio format (MP3, M4A, WAV, FLAC…) in Save as.</p>
          </aside>
        )}

        {panel === 'info' && (
          <aside className="side-panel" aria-label="File information">
            <h3>File information</h3>
            <dl className="info-list">
              <dt>Format</dt><dd>{info.container}</dd>
              <dt>Duration</dt><dd>{formatTime(info.duration)}</dd>
              {info.hasVideo && <><dt>Resolution</dt><dd>{info.width} × {info.height}</dd></>}
              {info.fps && <><dt>Frame rate</dt><dd>{info.fps} fps</dd></>}
              {info.videoCodec && <><dt>Video codec</dt><dd>{info.videoCodec.toUpperCase()}</dd></>}
              {info.audioCodec && <><dt>Audio codec</dt><dd>{info.audioCodec.toUpperCase()}</dd></>}
              {info.sampleRate && <><dt>Audio</dt><dd>{info.sampleRate / 1000} kHz, {info.channels === 1 ? 'mono' : info.channels === 2 ? 'stereo' : `${info.channels} channels`}</dd></>}
              <dt>Size</dt><dd>{(blob.size / 1024 / 1024).toFixed(1)} MB</dd>
            </dl>
          </aside>
        )}
      </div>
    </div>
  );
});
