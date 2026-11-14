/** Studio inspector: properties of the selected clip, with keyframes for the transform. */
import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Diamond, AudioWaveform } from 'lucide-react';
import { FILTER_LABELS, type Adjustments, type FilterPreset } from '../../core/media/image-ops';
import { BLEND_MODES, type BlendMode } from '../../core/pro-image/document';
import {
  addKey,
  type Animatable,
  hasKeyAt,
  removeKey,
  setValueAt,
  valueAt,
  type AudioClip,
  type Clip,
  type Easing,
  type Project,
  type TransformProp,
  type VisualClip,
} from '../../core/studio/model';
import { cx } from '../components';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="st-row">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Num({ value, min, max, step = 1, onChange, slider = true }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; slider?: boolean }) {
  return (
    <span className="st-num-wrap">
      {slider && <input type="range" min={min} max={max} step={step} value={Math.min(max, Math.max(min, value))} onChange={(e) => onChange(Number(e.target.value))} />}
      <input
        className="st-num"
        type="number"
        step={step}
        value={Math.round(value * 1000) / 1000}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
    </span>
  );
}

const PROPS: { key: TransformProp; label: string; min: number; max: number; step: number; toView?: (v: number) => number; fromView?: (v: number) => number }[] = [
  { key: 'x', label: 'Position X', min: -2000, max: 6000, step: 1 },
  { key: 'y', label: 'Position Y', min: -2000, max: 4000, step: 1 },
  { key: 'scale', label: 'Scale %', min: 1, max: 500, step: 1, toView: (v) => v * 100, fromView: (v) => v / 100 },
  { key: 'rotation', label: 'Rotation °', min: -360, max: 360, step: 0.5 },
  { key: 'opacity', label: 'Opacity %', min: 0, max: 100, step: 1, toView: (v) => v * 100, fromView: (v) => v / 100 },
];

const LOOK: { key: keyof Adjustments; label: string; min: number; max: number }[] = [
  { key: 'exposure', label: 'Exposure', min: -100, max: 100 },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
  { key: 'highlights', label: 'Highlights', min: -100, max: 100 },
  { key: 'shadows', label: 'Shadows', min: -100, max: 100 },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
  { key: 'warmth', label: 'Temperature', min: -100, max: 100 },
  { key: 'hue', label: 'Hue', min: -180, max: 180 },
  { key: 'brightness', label: 'Brightness', min: -100, max: 100 },
  { key: 'vignette', label: 'Vignette', min: 0, max: 100 },
];

export function Inspector({
  project,
  clip,
  playhead,
  easing,
  onEasing,
  onChange,
  onSeek,
  onEditAudio,
}: {
  project: Project;
  clip: Clip | null;
  playhead: number;
  easing: Easing;
  onEasing: (e: Easing) => void;
  onChange: (c: Clip) => void;
  onSeek: (t: number) => void;
  onEditAudio: (c: AudioClip) => void;
}) {
  if (!clip) {
    return (
      <aside className="st-inspector">
        <h3>Inspector</h3>
        <p className="st-hint">Select a clip on the timeline. Add media, text or a colour layer from the toolbar.</p>
        <p className="st-hint">Keys: Space play/pause · S split · Del delete · ← → step a frame · Ctrl+Z undo</p>
      </aside>
    );
  }
  const local = Math.max(0, Math.min(clip.duration, playhead - clip.start));
  const inClip = playhead >= clip.start && playhead <= clip.start + clip.duration;

  const timing = (
    <section>
      <h4>Timing</h4>
      <Row label="Start (s)"><Num value={clip.start} min={0} max={36000} step={0.01} slider={false} onChange={(v) => onChange({ ...clip, start: Math.max(0, v) })} /></Row>
      <Row label="Duration (s)"><Num value={clip.duration} min={0.05} max={36000} step={0.01} slider={false} onChange={(v) => onChange({ ...clip, duration: Math.max(0.05, v) })} /></Row>
      {'in' in clip && <Row label="Source in (s)"><Num value={clip.in} min={0} max={36000} step={0.01} slider={false} onChange={(v) => onChange({ ...clip, in: Math.max(0, v) } as Clip)} /></Row>}
    </section>
  );

  if (clip.kind === 'audio') {
    const c = clip;
    const at = c.envelope.find((k) => Math.abs(k.t - local) < 1e-3);
    return (
      <aside className="st-inspector">
        <h3>{c.name}</h3>
        {timing}
        <section>
          <h4>Clip audio</h4>
          <Row label="Gain dB"><Num value={c.gainDb} min={-40} max={20} step={0.5} onChange={(v) => onChange({ ...c, gainDb: v })} /></Row>
          <Row label="Fade in (s)"><Num value={c.fadeIn} min={0} max={Math.min(30, c.duration)} step={0.05} onChange={(v) => onChange({ ...c, fadeIn: v })} /></Row>
          <Row label="Fade out (s)"><Num value={c.fadeOut} min={0} max={Math.min(30, c.duration)} step={0.05} onChange={(v) => onChange({ ...c, fadeOut: v })} /></Row>
        </section>
        <section>
          <h4>Volume envelope</h4>
          <p className="st-hint">Automate the clip volume over time: add points at the playhead.</p>
          <div className="st-row-btns">
            <button type="button" className="btn" disabled={!inClip} onClick={() => onChange({ ...c, envelope: [...c.envelope.filter((k) => Math.abs(k.t - local) > 1e-3), { t: local, v: at?.v ?? 0, ease: 'linear' as Easing }].sort((a, b) => a.t - b.t) })}>
              <Diamond size={13} /> Add point
            </button>
            {c.envelope.length > 0 && <button type="button" className="btn btn-text" onClick={() => onChange({ ...c, envelope: [] })}>Clear</button>}
          </div>
          {c.envelope.map((k, i) => (
            <div key={i} className="st-env-row">
              <button type="button" className="btn btn-text" onClick={() => onSeek(c.start + k.t)}>{k.t.toFixed(2)} s</button>
              <Num value={k.v} min={-40} max={12} step={0.5} onChange={(v) => onChange({ ...c, envelope: c.envelope.map((x, j) => (j === i ? { ...x, v } : x)) })} />
              <button type="button" className="btn btn-text" aria-label="Remove point" onClick={() => onChange({ ...c, envelope: c.envelope.filter((_, j) => j !== i) })}>×</button>
            </div>
          ))}
        </section>
        <section>
          <h4>Waveform</h4>
          <button type="button" className="btn btn-primary" onClick={() => onEditAudio(c)}>
            <AudioWaveform size={14} /> Edit waveform…
          </button>
          <p className="st-hint">Cut, copy, paste, silence, normalize, fades, reverse, noise gate and noise reduction.</p>
        </section>
      </aside>
    );
  }

  const c = clip as VisualClip;
  const keyTimes = [...new Set(Object.values(c.transform).flatMap((a) => a.keys.map((k: { t: number }) => k.t)))].sort((a, b) => a - b);
  const prevKey = [...keyTimes].reverse().find((t) => t < local - 1e-3);
  const nextKey = keyTimes.find((t) => t > local + 1e-3);
  const setTransform = (prop: TransformProp, v: number) => onChange({ ...c, transform: { ...c.transform, [prop]: setValueAt(c.transform[prop], local, v) } } as Clip);
  const toggleKey = (prop: TransformProp) => {
    const a = c.transform[prop];
    const next = hasKeyAt(a, local) ? removeKey(a, local) : addKey(a, local, valueAt(a, local), easing);
    onChange({ ...c, transform: { ...c.transform, [prop]: next } } as Clip);
  };
  const fx = c.effects;
  const setFx = (patch: Partial<VisualClip['effects']>) => onChange({ ...c, effects: { ...fx, ...patch } } as Clip);

  return (
    <aside className="st-inspector">
      <h3>{c.kind === 'text' ? 'Text' : c.name}</h3>
      {c.kind === 'text' && (
        <section>
          <h4>Text</h4>
          <textarea className="input st-textarea" rows={3} value={c.text} onChange={(e) => onChange({ ...c, text: e.target.value })} />
          <Row label="Size"><Num value={c.size} min={6} max={600} onChange={(v) => onChange({ ...c, size: v })} /></Row>
          <div className="st-row-btns">
            <select className="tb-select" value={c.font} onChange={(e) => onChange({ ...c, font: e.target.value })} aria-label="Font">
              {[
                ['system-ui, "Segoe UI", Arial, sans-serif', 'Sans'],
                ['Georgia, "Times New Roman", serif', 'Serif'],
                ['Impact, "Arial Black", sans-serif', 'Impact'],
                ['"Courier New", monospace', 'Mono'],
              ].map(([v, n]) => <option key={v} value={v}>{n}</option>)}
            </select>
            <input type="color" aria-label="Text colour" value={c.color} onChange={(e) => onChange({ ...c, color: e.target.value })} />
            <label className="check"><input type="checkbox" checked={c.bold} onChange={(e) => onChange({ ...c, bold: e.target.checked })} /> Bold</label>
            <label className="check"><input type="checkbox" checked={c.italic} onChange={(e) => onChange({ ...c, italic: e.target.checked })} /> Italic</label>
          </div>
          <Row label="Outline"><Num value={c.stroke} min={0} max={30} onChange={(v) => onChange({ ...c, stroke: v })} /></Row>
          <div className="st-row-btns">
            {c.stroke > 0 && <input type="color" aria-label="Outline colour" value={c.strokeColor} onChange={(e) => onChange({ ...c, strokeColor: e.target.value })} />}
            <label className="check"><input type="checkbox" checked={!!c.background} onChange={(e) => onChange({ ...c, background: e.target.checked ? '#000000aa' : null })} /> Background box</label>
            {c.background && <input type="color" aria-label="Box colour" value={c.background.slice(0, 7)} onChange={(e) => onChange({ ...c, background: `${e.target.value}aa` })} />}
          </div>
        </section>
      )}
      {c.kind === 'solid' && (
        <section>
          <h4>Colour</h4>
          <div className="st-row-btns">
            <input type="color" aria-label="Colour" value={c.color} onChange={(e) => onChange({ ...c, color: e.target.value })} />
            <label className="check"><input type="checkbox" checked={!!c.color2} onChange={(e) => onChange({ ...c, color2: e.target.checked ? '#000000' : null })} /> Gradient</label>
            {c.color2 && <input type="color" aria-label="Second colour" value={c.color2} onChange={(e) => onChange({ ...c, color2: e.target.value })} />}
          </div>
        </section>
      )}
      <section>
        <h4>
          Transform
          <span className="st-key-nav">
            <button type="button" className="btn btn-text" disabled={prevKey === undefined} title="Previous keyframe" aria-label="Previous keyframe" onClick={() => prevKey !== undefined && onSeek(c.start + prevKey)}><ChevronLeft size={14} /></button>
            <button type="button" className="btn btn-text" disabled={nextKey === undefined} title="Next keyframe" aria-label="Next keyframe" onClick={() => nextKey !== undefined && onSeek(c.start + nextKey)}><ChevronRight size={14} /></button>
            <select className="tb-select" value={easing} onChange={(e) => onEasing(e.target.value as Easing)} title="Easing of new keyframes" aria-label="Keyframe easing">
              <option value="linear">Linear</option>
              <option value="easeInOut">Ease in-out</option>
              <option value="easeIn">Ease in</option>
              <option value="easeOut">Ease out</option>
              <option value="hold">Hold</option>
              <option value="bezier">Custom curve</option>
            </select>
          </span>
        </h4>
        {!inClip && <p className="st-hint">Move the playhead over the clip to edit and keyframe it.</p>}
        {PROPS.map((pr) => {
          const a = c.transform[pr.key];
          const v = valueAt(a, local);
          const shown = pr.toView ? pr.toView(v) : v;
          const keyed = hasKeyAt(a, local);
          return (
            <div key={pr.key} className="st-row">
              <span>{pr.label}</span>
              <Num value={shown} min={pr.key === 'x' ? -project.width : pr.key === 'y' ? -project.height : pr.min} max={pr.key === 'x' ? project.width * 2 : pr.key === 'y' ? project.height * 2 : pr.max} step={pr.step} onChange={(nv) => setTransform(pr.key, pr.fromView ? pr.fromView(nv) : nv)} />
              <button type="button" className={cx('st-diamond', keyed && 'is-key', a.keys.length > 0 && 'is-anim')} disabled={!inClip} title={keyed ? 'Remove keyframe' : 'Add keyframe at the playhead'} aria-label={`${keyed ? 'Remove' : 'Add'} ${pr.label} keyframe`} onClick={() => toggleKey(pr.key)}>
                <Diamond size={12} />
              </button>
            </div>
          );
        })}
      </section>
      <section>
        <h4>Compositing</h4>
        <Row label="Blend">
          <select className="tb-select" value={fx.blend} onChange={(e) => setFx({ blend: e.target.value as BlendMode })}>
            {BLEND_MODES.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </Row>
        <Row label="Fade in (s)"><Num value={fx.fadeIn} min={0} max={Math.min(30, c.duration)} step={0.05} onChange={(v) => setFx({ fadeIn: v })} /></Row>
        <Row label="Fade out (s)"><Num value={fx.fadeOut} min={0} max={Math.min(30, c.duration)} step={0.05} onChange={(v) => setFx({ fadeOut: v })} /></Row>
        <Row label="Blur (px)"><Num value={fx.blur} min={0} max={80} step={0.5} onChange={(v) => setFx({ blur: v })} /></Row>
        <label className="check"><input type="checkbox" checked={fx.shadow} onChange={(e) => setFx({ shadow: e.target.checked })} /> Drop shadow</label>
      </section>
      {(c.kind === 'video' || c.kind === 'image') && (
        <>
          <section>
            <h4>Colour grade</h4>
            <Row label="Look">
              <select className="tb-select" value={fx.filter} onChange={(e) => setFx({ filter: e.target.value as FilterPreset })}>
                {(Object.keys(FILTER_LABELS) as FilterPreset[]).map((f) => <option key={f} value={f}>{FILTER_LABELS[f]}</option>)}
              </select>
            </Row>
            {LOOK.map((l) => (
              <Row key={l.key} label={l.label}><Num value={fx.adjustments[l.key]} min={l.min} max={l.max} onChange={(v) => setFx({ adjustments: { ...fx.adjustments, [l.key]: v } })} /></Row>
            ))}
          </section>
          <section>
            <h4>Chroma key (green screen)</h4>
            <label className="check"><input type="checkbox" checked={fx.chromaKey.enabled} onChange={(e) => setFx({ chromaKey: { ...fx.chromaKey, enabled: e.target.checked } })} /> Remove a background colour</label>
            {fx.chromaKey.enabled && (
              <>
                <Row label="Key colour"><input type="color" value={fx.chromaKey.color} onChange={(e) => setFx({ chromaKey: { ...fx.chromaKey, color: e.target.value } })} /></Row>
                <Row label="Tolerance"><Num value={fx.chromaKey.tolerance} min={0} max={100} onChange={(v) => setFx({ chromaKey: { ...fx.chromaKey, tolerance: v } })} /></Row>
                <Row label="Softness"><Num value={fx.chromaKey.softness} min={0} max={100} onChange={(v) => setFx({ chromaKey: { ...fx.chromaKey, softness: v } })} /></Row>
                <Row label="Spill"><Num value={fx.chromaKey.spill} min={0} max={100} onChange={(v) => setFx({ chromaKey: { ...fx.chromaKey, spill: v } })} /></Row>
              </>
            )}
          </section>
        </>
      )}
      {timing}
    </aside>
  );
}
