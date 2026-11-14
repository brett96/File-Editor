/** Studio timeline: ruler + playhead, track headers, clips (move, trim, select), waveforms, keyframes. */
import { useEffect, useRef, type PointerEvent as RPointerEvent } from 'react';
import { Eye, EyeOff, Lock, Unlock, Volume2, VolumeX } from 'lucide-react';
import { clipEnd, snap, snapPoints, type Clip, type Project, type Track, type VisualClip } from '../../core/studio/model';
import { keyTimes } from '../../core/studio/anim';
import { cx } from '../components';

export interface TimelineProps {
  project: Project;
  playhead: number;
  pps: number;
  selectedId: string | null;
  snapOn: boolean;
  peaks: (sourceId: string) => { peaks: Float32Array; duration: number } | null;
  onSeek: (t: number) => void;
  onSelect: (id: string | null) => void;
  /** live update while dragging (no history) */
  onPreview: (p: Project) => void;
  /** start of a drag: record history */
  onBegin: () => void;
  onCommit: () => void;
  onTrack: (t: Track) => void;
}

const HEADER = 150;
const ROW_VIDEO = 54;
const ROW_AUDIO = 64;

/** m:ss.s, or with a frame rate m:ss:ff (timecode) */
function fmt(t: number, fps?: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (fps) {
    const whole = Math.floor(s + 1e-6);
    const f = Math.min(Math.round(fps) - 1, Math.floor((s - whole) * fps + 1e-6));
    return `${m}:${String(whole).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
  }
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function Waveform({ data, from, to, width, height }: { data: { peaks: Float32Array; duration: number }; from: number; to: number; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const w = Math.max(1, Math.min(4000, Math.round(width)));
    c.width = w;
    c.height = height;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, height);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    const n = data.peaks.length / 2;
    const mid = height / 2;
    for (let x = 0; x < w; x++) {
      const t = from + ((to - from) * x) / w;
      const b = Math.floor((t / data.duration) * n);
      if (b < 0 || b >= n) continue;
      const mn = data.peaks[b * 2];
      const mx = data.peaks[b * 2 + 1];
      ctx.fillRect(x, mid - mx * mid, 1, Math.max(1, (mx - mn) * mid));
    }
  }, [data, from, to, width, height]);
  return <canvas ref={ref} className="st-wave" style={{ width, height }} />;
}

export function Timeline(props: TimelineProps) {
  const { project: p, playhead, pps, selectedId } = props;
  const drag = useRef<null | { kind: 'move' | 'trimL' | 'trimR'; id: string; x0: number; y0: number; orig: Project; trackId: string }>(null);
  const lanes = useRef<HTMLDivElement>(null);
  const duration = Math.max(10, ...p.tracks.flatMap((t) => t.clips.map(clipEnd))) + 10;
  const width = duration * pps;

  const timeAt = (clientX: number) => {
    const r = lanes.current!.getBoundingClientRect();
    return Math.max(0, (clientX - r.left + lanes.current!.scrollLeft - HEADER) / pps);
  };

  const onRulerDown = (e: RPointerEvent) => {
    // seeking keeps the selection (so a selected clip can be keyframed at the new time)
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    props.onSeek(timeAt(e.clientX));
    const move = (ev: PointerEvent) => props.onSeek(timeAt(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onClipDown = (e: RPointerEvent, c: Clip, t: Track, kind: 'move' | 'trimL' | 'trimR') => {
    e.stopPropagation();
    props.onSelect(c.id);
    if (t.locked) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    props.onBegin();
    drag.current = { kind, id: c.id, x0: e.clientX, y0: e.clientY, orig: p, trackId: t.id };
  };

  const onClipMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dt = (e.clientX - d.x0) / pps;
    const orig = d.orig;
    const track = orig.tracks.find((t) => t.id === d.trackId)!;
    const clip = track.clips.find((c) => c.id === d.id)!;
    const exclude = new Set([clip.id, ...(clip.linkId ? orig.tracks.flatMap((t) => t.clips.filter((c) => c.linkId === clip.linkId).map((c) => c.id)) : [])]);
    const pts = props.snapOn ? [...snapPoints(orig, exclude), playhead] : [];
    const thr = 8 / pps;
    let next: Project = orig;
    if (d.kind === 'move') {
      let start = Math.max(0, clip.start + dt);
      if (props.snapOn) {
        const s1 = snap(start, pts, thr);
        const s2 = snap(start + clip.duration, pts, thr) - clip.duration;
        start = Math.abs(s1 - start) <= Math.abs(s2 - start) ? s1 : s2;
      }
      const delta = start - clip.start;
      // vertical: move to another track of the same kind under the pointer
      const targetTrack = trackUnder(e.clientY) ?? track;
      const sameKind = targetTrack.kind === track.kind && !targetTrack.locked;
      next = {
        ...orig,
        tracks: orig.tracks.map((t) => {
          let clips = t.clips.map((c) => (exclude.has(c.id) ? ({ ...c, start: Math.max(0, c.start + delta) } as Clip) : c));
          if (sameKind && targetTrack.id !== track.id) {
            if (t.id === track.id) clips = clips.filter((c) => c.id !== clip.id);
            if (t.id === targetTrack.id) clips = [...clips, { ...clip, start } as Clip];
          }
          return { ...t, clips };
        }),
      };
    } else {
      const srcDur = 'sourceId' in clip ? p.sources[clip.sourceId]?.duration ?? Infinity : Infinity;
      const isStill = clip.kind === 'image' || clip.kind === 'text' || clip.kind === 'solid';
      next = {
        ...orig,
        tracks: orig.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) => {
            if (!exclude.has(c.id)) return c;
            if (d.kind === 'trimR') {
              let end = clipEnd(c) + dt;
              if (props.snapOn) end = snap(end, pts, thr);
              const maxDur = isStill ? Infinity : srcDur - ('in' in c ? c.in : 0);
              return { ...c, duration: Math.max(0.05, Math.min(maxDur, end - c.start)) } as Clip;
            }
            let start = c.start + dt;
            if (props.snapOn) start = snap(start, pts, thr);
            const minStart = isStill ? 0 : c.start - ('in' in c ? c.in : 0);
            start = Math.max(Math.max(0, minStart), Math.min(clipEnd(c) - 0.05, start));
            const shift = start - c.start;
            return { ...c, start, duration: c.duration - shift, ...('in' in c ? { in: c.in + shift } : {}) } as Clip;
          }),
        })),
      };
    }
    props.onPreview(next);
  };

  const onClipUp = () => {
    if (!drag.current) return;
    drag.current = null;
    props.onCommit();
  };

  const trackUnder = (clientY: number): Track | null => {
    const el = document.elementsFromPoint(lanes.current!.getBoundingClientRect().left + HEADER + 10, clientY).find((x) => (x as HTMLElement).dataset?.track);
    const id = (el as HTMLElement | undefined)?.dataset.track;
    return p.tracks.find((t) => t.id === id) ?? null;
  };

  // keep the playhead in view while playing
  useEffect(() => {
    const el = lanes.current;
    if (!el) return;
    const x = HEADER + playhead * pps;
    if (x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - el.clientWidth / 3;
    else if (x < el.scrollLeft + HEADER) el.scrollLeft = Math.max(0, x - HEADER - 40);
  }, [playhead, pps]);

  const tick = pps >= 120 ? 0.5 : pps >= 40 ? 1 : pps >= 15 ? 5 : 10;
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += tick) ticks.push(t);
  const selected = p.tracks.flatMap((t) => t.clips).find((c) => c.id === selectedId);

  return (
    <div ref={lanes} className="st-timeline" onPointerMove={onClipMove} onPointerUp={onClipUp} onPointerDown={() => props.onSelect(null)}>
      <div className="st-tl-inner" style={{ width: width + HEADER }}>
        <div className="st-ruler" onPointerDown={onRulerDown} style={{ marginLeft: HEADER, width }}>
          {ticks.map((t) => (
            <span key={t} className="st-tick" style={{ left: t * pps }}>
              {Number.isInteger(t / (tick * 2)) ? fmt(t) : ''}
            </span>
          ))}
        </div>
        {p.tracks.map((t) => (
          <div key={t.id} className={cx('st-track', `st-${t.kind}`)} style={{ height: t.kind === 'video' ? ROW_VIDEO : ROW_AUDIO }} data-track={t.id}>
            <div className="st-track-head" onPointerDown={(e) => e.stopPropagation()}>
              <span className="st-track-name">{t.name}</span>
              <button type="button" className={cx('st-mini', t.muted && 'is-on')} title={t.kind === 'video' ? (t.muted ? 'Show track' : 'Hide track') : t.muted ? 'Unmute' : 'Mute'} aria-label={t.kind === 'video' ? 'Hide track' : 'Mute track'} onClick={() => props.onTrack({ ...t, muted: !t.muted })}>
                {t.kind === 'video' ? t.muted ? <EyeOff size={13} /> : <Eye size={13} /> : t.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
              </button>
              {t.kind === 'audio' && (
                <button type="button" className={cx('st-mini', t.solo && 'is-solo')} title="Solo" aria-label="Solo track" onClick={() => props.onTrack({ ...t, solo: !t.solo })}>
                  S
                </button>
              )}
              <button type="button" className={cx('st-mini', t.locked && 'is-on')} title={t.locked ? 'Unlock track' : 'Lock track'} aria-label="Lock track" onClick={() => props.onTrack({ ...t, locked: !t.locked })}>
                {t.locked ? <Lock size={12} /> : <Unlock size={12} />}
              </button>
            </div>
            <div className="st-lane" style={{ width }}>
              {t.clips.map((c) => {
                const left = c.start * pps;
                const w = Math.max(4, c.duration * pps);
                const src = 'sourceId' in c ? p.sources[c.sourceId] : null;
                const wave = c.kind === 'audio' ? props.peaks(c.sourceId) : null;
                return (
                  <div
                    key={c.id}
                    className={cx('st-clip', `st-clip-${c.kind}`, c.id === selectedId && 'is-selected', t.locked && 'is-locked')}
                    style={{ left, width: w }}
                    onPointerDown={(e) => onClipDown(e, c, t, 'move')}
                    title={`${c.name} · ${c.duration.toFixed(2)} s`}
                  >
                    {wave && <Waveform data={wave} from={'in' in c ? c.in : 0} to={('in' in c ? c.in : 0) + c.duration} width={w} height={ROW_AUDIO - 18} />}
                    <span className="st-clip-name">{c.kind === 'text' ? `T  ${c.text.split('\n')[0]}` : c.name}{src && c.kind === 'video' ? '' : ''}</span>
                    {c.id === selectedId && 'transform' in c && <KeyMarks clip={c} pps={pps} />}
                    {c.kind === 'audio' && c.envelope.length > 0 && <EnvelopeLine clip={c} pps={pps} height={ROW_AUDIO - 4} />}
                    <span className="st-trim st-trim-l" onPointerDown={(e) => onClipDown(e, c, t, 'trimL')} />
                    <span className="st-trim st-trim-r" onPointerDown={(e) => onClipDown(e, c, t, 'trimR')} />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        <div className="st-playhead" style={{ left: HEADER + playhead * pps }} />
        {selected && <div className="st-sel-range" style={{ left: HEADER + selected.start * pps, width: selected.duration * pps }} />}
      </div>
    </div>
  );
}

function KeyMarks({ clip, pps }: { clip: VisualClip; pps: number }) {
  return (
    <>
      {keyTimes({ width: 0, height: 0 }, clip).map((t) => (
        <span key={t} className="st-key" style={{ left: t * pps - 4 }} />
      ))}
    </>
  );
}

function EnvelopeLine({ clip, pps, height }: { clip: Extract<Clip, { kind: 'audio' }>; pps: number; height: number }) {
  const y = (db: number) => height * (1 - (Math.max(-40, Math.min(12, db)) + 40) / 52);
  const pts = [{ t: 0, v: clip.envelope[0].v }, ...clip.envelope, { t: clip.duration, v: clip.envelope[clip.envelope.length - 1].v }];
  return (
    <svg className="st-env" width={clip.duration * pps} height={height}>
      <polyline points={pts.map((k) => `${k.t * pps},${y(k.v)}`).join(' ')} />
      {clip.envelope.map((k, i) => (
        <circle key={i} cx={k.t * pps} cy={y(k.v)} r="3" />
      ))}
    </svg>
  );
}

export { fmt as formatTimecode, HEADER as TIMELINE_HEADER };
