/** Studio mixer: a channel strip per audio track (EQ, compressor, delay, reverb, pan, fader, meter) and the master bus. */
import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import type { MasterBus, Project, Track, TrackAudio } from '../../core/studio/model';
import { cx } from '../components';

export const LOUDNESS_TARGETS: { value: number | null; label: string }[] = [
  { value: null, label: 'Off' },
  { value: -14, label: '−14 LUFS (streaming: YouTube, Spotify)' },
  { value: -16, label: '−16 LUFS (podcasts, Apple)' },
  { value: -23, label: '−23 LUFS (EBU R128 broadcast)' },
  { value: -24, label: '−24 LKFS (ATSC A/85 broadcast)' },
];

/** Decimal places that show every step of a control (step 0.05 → 2, step 5 → 0). */
function decimalsFor(step: number): number {
  return step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step) - 1e-9));
}

interface ValueSpec {
  min: number;
  max: number;
  step: number;
  /** text shown for a value (default: the number with the step's decimals) */
  format?: (v: number) => string;
  /** reads typed text back into a value (default: the first number in it) */
  parse?: (s: string) => number;
  onChange: (v: number) => void;
}

const snapTo = (v: number, { min, max, step }: Pick<ValueSpec, 'min' | 'max' | 'step'>) => {
  const clamped = Math.min(max, Math.max(min, v));
  return Number((Math.round((clamped - min) / step) * step + min).toFixed(decimalsFor(step)));
};

const parseNumber = (s: string) => parseFloat(s.replace(',', '.').replace(/[^\d.+-]/g, ''));

/**
 * The number beside a control: type a value and press Enter, or use ↑ / ↓ (Shift for ×10).
 * Esc puts the old value back.
 */
function ValueBox({ value, label, unit, spec }: { value: number; label: string; unit?: string; spec: ValueSpec }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = spec.format ? spec.format(value) : value.toFixed(decimalsFor(spec.step));
  const commit = () => {
    if (draft === null) return;
    const n = (spec.parse ?? parseNumber)(draft);
    setDraft(null);
    if (Number.isFinite(n)) spec.onChange(snapTo(n, spec));
  };
  return (
    <span className="mx-value">
      <input
        value={draft ?? shown}
        aria-label={`${label}${unit ? ` (${unit})` : ''}`}
        spellCheck={false}
        onFocus={(e) => {
          setDraft(shown);
          e.target.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            setDraft(null);
            // keep Esc from also closing anything around the mixer
            e.stopPropagation();
            requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const next = snapTo(value + (e.key === 'ArrowUp' ? 1 : -1) * spec.step * (e.shiftKey ? 10 : 1), spec);
            spec.onChange(next);
            setDraft(spec.format ? spec.format(next) : next.toFixed(decimalsFor(spec.step)));
          }
        }}
      />
      {unit && <span className="mx-unit">{unit}</span>}
    </span>
  );
}

/**
 * One effect parameter: label and editable value on top, a full-width slider below. Controls
 * that run from negative to positive (gains, pan) fill from the centre. Double-click the slider
 * to reset it.
 */
function Knob({
  label,
  value,
  min,
  max,
  step = 0.1,
  unit = '',
  format,
  parse,
  resetTo,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  format?: (v: number) => string;
  parse?: (s: string) => number;
  /** double-click value (default: 0 when the range includes it, else the minimum) */
  resetTo?: number;
  onChange: (v: number) => void;
}) {
  const id = useId();
  const origin = min < 0 && max > 0 ? 0 : min;
  const pct = (v: number) => ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100;
  const fill = { '--lo': `${pct(Math.min(value, origin))}%`, '--hi': `${pct(Math.max(value, origin))}%` } as CSSProperties;
  const spec: ValueSpec = { min, max, step, format, parse, onChange };
  return (
    <div className="mx-knob">
      <div className="mx-knob-head">
        <label htmlFor={id}>{label}</label>
        <ValueBox value={value} label={label} unit={unit.trim()} spec={spec} />
      </div>
      <input
        id={id}
        className="mx-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={fill}
        title="Double-click to reset"
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(resetTo ?? (min <= 0 && max >= 0 ? 0 : min))}
      />
    </div>
  );
}

/** Pan: shown as L 30 / C / R 45; typing "L30", "r 20", "c" or -0.3 all work. */
const formatPan = (v: number) => (Math.abs(v) < 0.005 ? 'C' : `${v < 0 ? 'L' : 'R'} ${Math.round(Math.abs(v) * 100)}`);
const parsePan = (s: string) => {
  const t = s.trim().toLowerCase();
  if (t === 'c' || t === 'center' || t === 'centre') return 0;
  let n = parseNumber(t);
  if (!Number.isFinite(n)) return NaN;
  if (Math.abs(n) > 1) n /= 100;
  if (t.startsWith('l')) return -Math.abs(n);
  if (t.startsWith('r')) return Math.abs(n);
  return n;
};

function Section({ title, enabled, onToggle, children }: { title: string; enabled: boolean; onToggle: (on: boolean) => void; children: ReactNode }) {
  return (
    <fieldset className={cx('mx-section', !enabled && 'is-off')}>
      <legend>
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} /> {title}
        </label>
      </legend>
      {enabled && children}
    </fieldset>
  );
}

function Meter({ db }: { db: number }) {
  const pct = Number.isFinite(db) ? Math.max(0, Math.min(100, ((db + 60) / 66) * 100)) : 0;
  return (
    <div className="mx-meter" title={Number.isFinite(db) ? `${db.toFixed(1)} dBFS` : '−∞'}>
      <div className={cx('mx-meter-fill', db > -1 && 'is-clip', db > -9 && db <= -1 && 'is-hot')} style={{ height: `${pct}%` }} />
    </div>
  );
}

const FADER_MIN = -60;
const FADER_MAX = 12;
const FADER_MARKS = [12, 0, -12, -24, -48];
const faderPct = (db: number) => ((Math.min(FADER_MAX, Math.max(FADER_MIN, db)) - FADER_MIN) / (FADER_MAX - FADER_MIN)) * 100;
const formatDb = (v: number) => (v <= FADER_MIN ? '−∞' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`);
const parseDb = (s: string) => (/inf|∞/i.test(s) ? FADER_MIN : parseNumber(s.replace('−', '-')));

/** Channel volume: a vertical fader with a dB scale; double-click for 0 dB. */
function Fader({ value, onChange, label = 'Volume' }: { value: number; onChange: (v: number) => void; label?: string }) {
  const spec: ValueSpec = { min: FADER_MIN, max: FADER_MAX, step: 0.5, format: formatDb, parse: parseDb, onChange };
  return (
    <div className="mx-fader">
      <div className="mx-fader-body">
        <div className="mx-scale" aria-hidden>
          {FADER_MARKS.map((m) => (
            <span key={m} className={cx(m === 0 && 'is-zero')} style={{ bottom: `${faderPct(m)}%` }}>
              {m > 0 ? `+${m}` : m < 0 ? `−${-m}` : '0'}
            </span>
          ))}
        </div>
        <input
          type="range"
          min={FADER_MIN}
          max={FADER_MAX}
          step={0.5}
          value={value}
          style={{ '--fill': `${faderPct(value)}%`, '--zero': `${faderPct(0)}%` } as CSSProperties}
          onChange={(e) => onChange(Number(e.target.value))}
          onDoubleClick={() => onChange(0)}
          aria-label={`${label} (dB)`}
          title="Double-click for 0 dB"
        />
      </div>
      <ValueBox value={value} label={label} unit="dB" spec={spec} />
    </div>
  );
}

function Strip({ track, level, onChange }: { track: Track; level: number; onChange: (t: Track) => void }) {
  const a = track.audio;
  const set = (patch: Partial<TrackAudio>) => onChange({ ...track, audio: { ...a, ...patch } });
  return (
    <div className="mx-strip">
      <header className="mx-name mx-name-row">
        <span className="mx-track-name" title={track.name}>{track.name}</span>
        <span className="mx-ms">
          <button type="button" title="Mute" aria-pressed={track.muted} className={cx('st-mini', track.muted && 'is-on')} onClick={() => onChange({ ...track, muted: !track.muted })}>M</button>
          <button type="button" title="Solo" aria-pressed={track.solo} className={cx('st-mini', track.solo && 'is-solo')} onClick={() => onChange({ ...track, solo: !track.solo })}>S</button>
        </span>
      </header>
      <div className="mx-fx">
        <Section title="EQ" enabled={a.eq.enabled} onToggle={(on) => set({ eq: { ...a.eq, enabled: on } })}>
          <Knob label="Low cut" value={a.eq.lowCut} min={0} max={400} step={5} unit=" Hz" onChange={(v) => set({ eq: { ...a.eq, lowCut: v } })} />
          <Knob label="Low" value={a.eq.lowShelfGain} min={-15} max={15} unit=" dB" onChange={(v) => set({ eq: { ...a.eq, lowShelfGain: v } })} />
          <Knob label="Mid" value={a.eq.midGain} min={-15} max={15} unit=" dB" onChange={(v) => set({ eq: { ...a.eq, midGain: v } })} />
          <Knob label="Mid freq" value={a.eq.midFreq} min={200} max={8000} step={10} unit=" Hz" onChange={(v) => set({ eq: { ...a.eq, midFreq: v } })} />
          <Knob label="Mid Q" value={a.eq.midQ} min={0.2} max={8} onChange={(v) => set({ eq: { ...a.eq, midQ: v } })} />
          <Knob label="High" value={a.eq.highShelfGain} min={-15} max={15} unit=" dB" onChange={(v) => set({ eq: { ...a.eq, highShelfGain: v } })} />
          <Knob label="High cut" value={a.eq.highCut} min={0} max={20000} step={100} unit=" Hz" onChange={(v) => set({ eq: { ...a.eq, highCut: v } })} />
        </Section>
        <Section title="Compressor" enabled={a.compressor.enabled} onToggle={(on) => set({ compressor: { ...a.compressor, enabled: on } })}>
          <Knob label="Threshold" value={a.compressor.threshold} min={-60} max={0} unit=" dB" onChange={(v) => set({ compressor: { ...a.compressor, threshold: v } })} />
          <Knob label="Ratio" value={a.compressor.ratio} min={1} max={20} unit=":1" onChange={(v) => set({ compressor: { ...a.compressor, ratio: v } })} />
          <Knob label="Attack" value={Math.round(a.compressor.attack * 1000)} min={0} max={200} step={1} unit=" ms" onChange={(v) => set({ compressor: { ...a.compressor, attack: v / 1000 } })} />
          <Knob label="Release" value={Math.round(a.compressor.release * 1000)} min={10} max={1000} step={5} unit=" ms" onChange={(v) => set({ compressor: { ...a.compressor, release: v / 1000 } })} />
          <Knob label="Makeup" value={a.compressor.makeupDb} min={0} max={24} unit=" dB" onChange={(v) => set({ compressor: { ...a.compressor, makeupDb: v } })} />
        </Section>
        <Section title="Delay" enabled={a.delay.enabled} onToggle={(on) => set({ delay: { ...a.delay, enabled: on } })}>
          <Knob label="Time" value={Math.round(a.delay.time * 1000)} min={10} max={2000} step={5} unit=" ms" onChange={(v) => set({ delay: { ...a.delay, time: v / 1000 } })} />
          <Knob label="Feedback" value={a.delay.feedback} min={0} max={0.9} step={0.01} onChange={(v) => set({ delay: { ...a.delay, feedback: v } })} />
          <Knob label="Mix" value={a.delay.mix} min={0} max={1} step={0.01} onChange={(v) => set({ delay: { ...a.delay, mix: v } })} />
        </Section>
        <Section title="Reverb" enabled={a.reverb.enabled} onToggle={(on) => set({ reverb: { ...a.reverb, enabled: on } })}>
          <Knob label="Mix" value={a.reverb.mix} min={0} max={1} step={0.01} onChange={(v) => set({ reverb: { ...a.reverb, mix: v } })} />
          <Knob label="Decay" value={a.reverb.decay} min={0.2} max={8} step={0.1} unit=" s" onChange={(v) => set({ reverb: { ...a.reverb, decay: v } })} />
        </Section>
      </div>
      <div className="mx-pan">
        <Knob label="Pan" value={a.pan} min={-1} max={1} step={0.01} format={formatPan} parse={parsePan} onChange={(v) => set({ pan: v })} />
      </div>
      <div className="mx-bottom">
        <Meter db={level} />
        <Fader label={`${track.name} volume`} value={a.volumeDb} onChange={(v) => set({ volumeDb: v })} />
      </div>
    </div>
  );
}

export function Mixer({
  project,
  levels,
  onTrack,
  onMaster,
  onMeasure,
  measured,
}: {
  project: Project;
  levels: Record<string, number>;
  onTrack: (t: Track) => void;
  onMaster: (m: MasterBus) => void;
  onMeasure: () => void;
  measured: string | null;
}) {
  const m = project.master;
  const audio = project.tracks.filter((t) => t.kind === 'audio');
  return (
    <div className="st-mixer">
      {audio.length === 0 && <p className="st-hint">No audio tracks yet: add audio with “Add media”.</p>}
      {audio.map((t) => (
        <Strip key={t.id} track={t} level={levels[t.id] ?? -Infinity} onChange={onTrack} />
      ))}
      <div className="mx-strip mx-master">
        <header className="mx-name">Master</header>
        <div className="mx-fx">
          <fieldset className="mx-section">
            <legend>
              <label className="check">
                <input type="checkbox" checked={m.limiter.enabled} onChange={(e) => onMaster({ ...m, limiter: { ...m.limiter, enabled: e.target.checked } })} /> Limiter
              </label>
            </legend>
            {m.limiter.enabled && <Knob label="Ceiling" value={m.limiter.ceilingDb} min={-12} max={0} unit=" dB" onChange={(v) => onMaster({ ...m, limiter: { ...m.limiter, ceilingDb: v } })} />}
          </fieldset>
          <fieldset className="mx-section">
            <legend>Loudness (export)</legend>
            <select className="tb-select" value={m.loudnessTarget === null ? 'off' : String(m.loudnessTarget)} onChange={(e) => onMaster({ ...m, loudnessTarget: e.target.value === 'off' ? null : Number(e.target.value) })} aria-label="Loudness target">
              {LOUDNESS_TARGETS.map((t) => <option key={String(t.value)} value={t.value === null ? 'off' : String(t.value)}>{t.label}</option>)}
            </select>
            <button type="button" className="btn" onClick={onMeasure}>Measure loudness</button>
            {measured && <p className="st-hint">{measured}</p>}
          </fieldset>
        </div>
        <div className="mx-bottom">
          <Meter db={levels.master ?? -Infinity} />
          <Fader label="Master volume" value={m.volumeDb} onChange={(v) => onMaster({ ...m, volumeDb: v })} />
        </div>
      </div>
    </div>
  );
}
