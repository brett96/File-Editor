/** Studio mixer: a channel strip per audio track (EQ, compressor, delay, reverb, pan, fader, meter) and the master bus. */
import type { ReactNode } from 'react';
import type { MasterBus, Project, Track, TrackAudio } from '../../core/studio/model';
import { cx } from '../components';

export const LOUDNESS_TARGETS: { value: number | null; label: string }[] = [
  { value: null, label: 'Off' },
  { value: -14, label: '−14 LUFS (streaming: YouTube, Spotify)' },
  { value: -16, label: '−16 LUFS (podcasts, Apple)' },
  { value: -23, label: '−23 LUFS (EBU R128 broadcast)' },
  { value: -24, label: '−24 LKFS (ATSC A/85 broadcast)' },
];

function Knob({ label, value, min, max, step = 0.1, unit = '', onChange }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <label className="mx-knob" title={`${label}: ${value}${unit}`}>
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} onDoubleClick={() => onChange(min <= 0 && max >= 0 ? 0 : min)} />
      <output>
        {Math.round(value * 100) / 100}
        {unit}
      </output>
    </label>
  );
}

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

function Fader({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="mx-fader">
      <input type="range" min={-60} max={12} step={0.5} value={value} onChange={(e) => onChange(Number(e.target.value))} onDoubleClick={() => onChange(0)} aria-label="Volume (dB)" />
      <output>{value <= -60 ? '−∞' : `${value > 0 ? '+' : ''}${value.toFixed(1)}`} dB</output>
    </div>
  );
}

function Strip({ track, level, onChange }: { track: Track; level: number; onChange: (t: Track) => void }) {
  const a = track.audio;
  const set = (patch: Partial<TrackAudio>) => onChange({ ...track, audio: { ...a, ...patch } });
  return (
    <div className="mx-strip">
      <header className="mx-name">{track.name}</header>
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
      <Knob label="Pan" value={a.pan} min={-1} max={1} step={0.05} onChange={(v) => set({ pan: v })} />
      <div className="mx-bottom">
        <Meter db={level} />
        <Fader value={a.volumeDb} onChange={(v) => set({ volumeDb: v })} />
      </div>
      <div className="mx-ms">
        <button type="button" className={cx('st-mini', track.muted && 'is-on')} onClick={() => onChange({ ...track, muted: !track.muted })}>M</button>
        <button type="button" className={cx('st-mini', track.solo && 'is-solo')} onClick={() => onChange({ ...track, solo: !track.solo })}>S</button>
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
        <div className="mx-bottom">
          <Meter db={levels.master ?? -Infinity} />
          <Fader value={m.volumeDb} onChange={(v) => onMaster({ ...m, volumeDb: v })} />
        </div>
      </div>
    </div>
  );
}
