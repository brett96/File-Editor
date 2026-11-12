/**
 * Destructive waveform editor for one audio clip (Audition-style): select a range on the
 * waveform and cut / copy / paste / delete / silence / insert silence, change gain,
 * normalize, fade, reverse, noise-gate, or learn a noise profile and reduce noise.
 * The result becomes a new source for the clip; the original file is untouched.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { Play, Square, Undo2, Redo2 } from 'lucide-react';
import {
  deleteRange,
  fadeRange,
  frames,
  gainRange,
  gateRange,
  insertAudio,
  noiseProfile,
  normalizeRange,
  peak,
  reduceNoise,
  reverseRange,
  silenceData,
  silenceRange,
  sliceAudio,
  waveformPeaks,
  type AudioData,
} from '../../core/studio/dsp';
import { dataToBuffer } from '../../core/studio/audio';
import { Modal } from '../components';
import { formatTimecode } from './Timeline';

let clipboard: AudioData | null = null;

const W = 860;
const H = 200;

export function AudioClipEditor({ name, data, onApply, onClose }: { name: string; data: AudioData; onApply: (d: AudioData) => void; onClose: () => void }) {
  const [hist, setHist] = useState<{ stack: AudioData[]; i: number }>({ stack: [data], i: 0 });
  const audio = hist.stack[hist.i];
  const n = frames(audio);
  const sr = audio.sampleRate;
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [gainDb, setGainDb] = useState(3);
  const [gateDb, setGateDb] = useState(-45);
  const [silenceSec, setSilenceSec] = useState(1);
  const [strength, setStrength] = useState(60);
  const [profile, setProfile] = useState<Float64Array | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playPos, setPlayPos] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playRef = useRef<{ ctx: AudioContext; src: AudioBufferSourceNode; raf: number } | null>(null);

  const peaks = useMemo(() => waveformPeaks(audio, 0, n, W), [audio, n]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr;
    cv.height = H * dpr;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#10151d';
    ctx.fillRect(0, 0, W, H);
    if (sel && n) {
      ctx.fillStyle = 'rgba(80,150,255,0.28)';
      ctx.fillRect((sel[0] / n) * W, 0, ((sel[1] - sel[0]) / n) * W, H);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();
    ctx.fillStyle = '#4fd1a5';
    for (let x = 0; x < W; x++) {
      const mn = peaks[x * 2];
      const mx = peaks[x * 2 + 1];
      const y0 = H / 2 - mx * (H / 2 - 4);
      const y1 = H / 2 - mn * (H / 2 - 4);
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
    const line = (f: number, color: string) => {
      const x = n ? (f / n) * W : 0;
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(x), 0, 1.5, H);
    };
    line(cursor, '#ffd166');
    if (playPos !== null) line(playPos, '#ffffff');
  }, [peaks, sel, cursor, playPos, n]);

  useEffect(() => () => stop(), []);

  const push = (next: AudioData) => {
    setHist((h) => ({ stack: [...h.stack.slice(0, h.i + 1), next].slice(-30), i: Math.min(h.i + 1, 29) }));
  };
  const range = (): [number, number] => sel ?? [0, n];
  const run = (label: string, fn: () => AudioData | void) => {
    setError(null);
    setBusy(label);
    // let the busy label paint before heavy DSP
    setTimeout(() => {
      try {
        const out = fn();
        if (out) push(out);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    }, 20);
  };

  const frameAt = (e: RPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * n);
  };
  const dragFrom = useRef<number | null>(null);
  const onDown = (e: RPointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const f = frameAt(e);
    dragFrom.current = f;
    setCursor(f);
    setSel(null);
  };
  const onMove = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (dragFrom.current === null) return;
    const f = frameAt(e);
    const a = Math.min(f, dragFrom.current);
    const b = Math.max(f, dragFrom.current);
    setSel(b - a > sr * 0.005 ? [a, b] : null);
  };
  const onUp = () => {
    dragFrom.current = null;
  };

  function stop() {
    const p = playRef.current;
    if (!p) return;
    cancelAnimationFrame(p.raf);
    try {
      p.src.stop();
    } catch {
      /* not started */
    }
    void p.ctx.close();
    playRef.current = null;
    setPlaying(false);
    setPlayPos(null);
  }
  const play = () => {
    stop();
    const [s, e] = sel ?? [cursor, n];
    if (e - s < 10) return;
    const ctx = new AudioContext();
    const src = ctx.createBufferSource();
    src.buffer = dataToBuffer(audio);
    src.connect(ctx.destination);
    const t0 = ctx.currentTime;
    src.start(t0, s / sr, (e - s) / sr);
    src.onended = () => stop();
    const tick = () => {
      setPlayPos(Math.min(e, s + (ctx.currentTime - t0) * sr));
      if (playRef.current) playRef.current.raf = requestAnimationFrame(tick);
    };
    playRef.current = { ctx, src, raf: requestAnimationFrame(tick) };
    setPlaying(true);
  };

  const fmt = (f: number) => formatTimecode(f / sr);
  const pk = peak(audio, ...range());
  const hasSel = !!sel;

  return (
    <Modal
      title={`Edit waveform — ${name}`}
      width={920}
      onClose={() => {
        stop();
        onClose();
      }}
      footer={
        <>
          <span className="st-hint">
            {n ? `${fmt(n)} · ${sr} Hz · ${audio.channels.length === 1 ? 'mono' : `${audio.channels.length} ch`}` : 'Empty'}
            {busy ? ` · ${busy}…` : ''}
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={() => { stop(); onClose(); }}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!!busy || hist.i === 0 || n === 0} onClick={() => { stop(); onApply(audio); }}>
            Apply to clip
          </button>
        </>
      }
    >
      <div className="ae-bar">
        <button type="button" className="btn" onClick={playing ? stop : play} aria-label={playing ? 'Stop' : 'Play'}>
          {playing ? <Square size={14} /> : <Play size={14} />} {playing ? 'Stop' : hasSel ? 'Play selection' : 'Play'}
        </button>
        <button type="button" className="btn btn-icon" aria-label="Undo" disabled={hist.i === 0} onClick={() => setHist((h) => ({ ...h, i: h.i - 1 }))}><Undo2 size={14} /></button>
        <button type="button" className="btn btn-icon" aria-label="Redo" disabled={hist.i >= hist.stack.length - 1} onClick={() => setHist((h) => ({ ...h, i: h.i + 1 }))}><Redo2 size={14} /></button>
        <span className="st-hint">
          {hasSel ? `Selection ${fmt(sel![0])} – ${fmt(sel![1])} (${((sel![1] - sel![0]) / sr).toFixed(2)} s)` : `Cursor ${fmt(cursor)} · drag to select`}
          {' · '}peak {pk > 0 ? `${(20 * Math.log10(pk)).toFixed(1)} dBFS` : '−∞'}
        </span>
        <span className="spacer" />
        <button type="button" className="btn btn-text" disabled={!n} onClick={() => setSel([0, n])}>Select all</button>
      </div>
      <canvas
        ref={canvasRef}
        className="ae-wave"
        style={{ width: '100%', height: H, aspectRatio: `${W} / ${H}` }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        aria-label="Waveform: drag to select a range"
      />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="ae-groups">
        <fieldset>
          <legend>Edit</legend>
          <button type="button" className="btn" disabled={!hasSel} onClick={() => run('Cut', () => { clipboard = sliceAudio(audio, ...sel!); setCursor(sel![0]); setSel(null); return deleteRange(audio, ...sel!); })}>Cut</button>
          <button type="button" className="btn" disabled={!hasSel} onClick={() => { clipboard = sliceAudio(audio, ...sel!); }}>Copy</button>
          <button type="button" className="btn" disabled={!clipboard} onClick={() => run('Paste', () => {
            const clip = clipboard!;
            const base = sel ? deleteRange(audio, ...sel) : audio;
            const at = sel ? sel[0] : cursor;
            setSel([at, at + frames(clip)]);
            return insertAudio(base, at, clip.sampleRate === sr ? clip : resample(clip, sr));
          })}>Paste</button>
          <button type="button" className="btn" disabled={!hasSel} onClick={() => run('Delete', () => { setCursor(sel![0]); setSel(null); return deleteRange(audio, ...sel!); })}>Delete</button>
          <button type="button" className="btn" disabled={!hasSel} onClick={() => run('Silence', () => silenceRange(audio, ...sel!))}>Silence</button>
          <span className="ae-inline">
            <button type="button" className="btn" onClick={() => run('Insert silence', () => insertAudio(audio, sel ? sel[0] : cursor, silenceData(sr, audio.channels.length, Math.round(silenceSec * sr))))}>Insert silence</button>
            <input className="input st-num" type="number" min={0.01} max={600} step={0.1} value={silenceSec} onChange={(e) => setSilenceSec(Math.max(0.01, Number(e.target.value) || 0))} aria-label="Silence length (s)" /> s
          </span>
        </fieldset>
        <fieldset>
          <legend>Level {hasSel ? '(selection)' : '(whole clip)'}</legend>
          <span className="ae-inline">
            <button type="button" className="btn" onClick={() => run('Gain', () => gainRange(audio, ...range(), gainDb))}>Gain</button>
            <input className="input st-num" type="number" min={-40} max={40} step={0.5} value={gainDb} onChange={(e) => setGainDb(Number(e.target.value) || 0)} aria-label="Gain (dB)" /> dB
          </span>
          <button type="button" className="btn" onClick={() => run('Normalize', () => normalizeRange(audio, ...range(), -1))}>Normalize (−1 dB)</button>
          <button type="button" className="btn" disabled={!hasSel} onClick={() => run('Fade in', () => fadeRange(audio, ...sel!, 'in'))}>Fade in</button>
          <button type="button" className="btn" disabled={!hasSel} onClick={() => run('Fade out', () => fadeRange(audio, ...sel!, 'out'))}>Fade out</button>
          <button type="button" className="btn" onClick={() => run('Reverse', () => reverseRange(audio, ...range()))}>Reverse</button>
        </fieldset>
        <fieldset>
          <legend>Repair</legend>
          <span className="ae-inline">
            <button type="button" className="btn" onClick={() => run('Noise gate', () => gateRange(audio, ...range(), gateDb))}>Noise gate</button>
            <input className="input st-num" type="number" min={-90} max={0} step={1} value={gateDb} onChange={(e) => setGateDb(Number(e.target.value) || -45)} aria-label="Gate threshold (dB)" /> dB
          </span>
          <button type="button" className="btn" disabled={!hasSel} title="Select a part that contains only background noise" onClick={() => run('Learning noise', () => { setProfile(noiseProfile(sliceAudio(audio, ...sel!))); })}>
            {profile ? 'Re-learn noise profile' : 'Learn noise profile'}
          </button>
          <span className="ae-inline">
            <button type="button" className="btn" disabled={!profile} onClick={() => run('Reducing noise', () => {
              const [s, e] = range();
              const part = reduceNoise(sliceAudio(audio, s, e), profile!, strength);
              return insertAudio(deleteRange(audio, s, e), s, part);
            })}>Reduce noise</button>
            <input className="input st-num" type="number" min={0} max={100} step={5} value={strength} onChange={(e) => setStrength(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} aria-label="Noise reduction strength" /> %
          </span>
          {!profile && <p className="st-hint">Select a stretch of background noise only, learn it, then reduce noise on the clip or a selection.</p>}
        </fieldset>
      </div>
    </Modal>
  );
}

/** Linear resample (for pasting between sources with different sample rates). */
function resample(a: AudioData, sr: number): AudioData {
  const ratio = a.sampleRate / sr;
  const len = Math.round(frames(a) / ratio);
  return {
    sampleRate: sr,
    channels: a.channels.map((c) => {
      const out = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const x = i * ratio;
        const i0 = Math.floor(x);
        const f = x - i0;
        out[i] = (c[i0] ?? 0) * (1 - f) + (c[i0 + 1] ?? c[i0] ?? 0) * f;
      }
      return out;
    }),
  };
}
