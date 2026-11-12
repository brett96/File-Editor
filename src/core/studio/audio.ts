/**
 * Studio audio engine (browser, Web Audio): the mixing graph used for live playback and for
 * the offline export render, so what you hear is what you get.
 *
 *   clip   AudioBufferSourceNode → gain (clip gain × fades × volume envelope, as one curve)
 *   track  → EQ (low cut, low shelf, mid peak, high shelf, high cut) → compressor + makeup
 *          → delay and reverb sends (parallel wet) → pan → fader → meter
 *   master → fader → limiter (playback only; the export uses the look-ahead limiter in dsp.ts
 *          after loudness normalization)
 */
import { mediabunny } from '../media/video-engine';
import { integratedLoudness, limit, type AudioData } from './dsp';
import { audibleTracks, clipEnd, dbToGain, envelopeDb, projectDuration, type AudioClip, type Project, type Track } from './model';

/** Decodes the sound of an audio or video file. */
export async function decodeAudio(blob: Blob): Promise<AudioBuffer | null> {
  const bytes = await blob.arrayBuffer();
  try {
    const ctx = new OfflineAudioContext(1, 1, 48000);
    return await ctx.decodeAudioData(bytes.slice(0));
  } catch {
    // containers the browser's decoder doesn't take: decode through Mediabunny
    try {
      const mb = await mediabunny();
      const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
      const track = await input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode())) return null;
      const sink = new mb.AudioBufferSink(track);
      const parts: AudioBuffer[] = [];
      for await (const w of sink.buffers()) parts.push(w.buffer);
      input.dispose();
      if (!parts.length) return null;
      const ch = parts[0].numberOfChannels;
      const sr = parts[0].sampleRate;
      const len = parts.reduce((a, b) => a + b.length, 0);
      const out = new AudioBuffer({ numberOfChannels: ch, length: len, sampleRate: sr });
      let off = 0;
      for (const p of parts) {
        for (let c = 0; c < ch; c++) out.copyToChannel(p.getChannelData(Math.min(c, p.numberOfChannels - 1)), c, off);
        off += p.length;
      }
      return out;
    } catch {
      return null;
    }
  }
}

export function bufferToData(b: AudioBuffer): AudioData {
  return { sampleRate: b.sampleRate, channels: Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i).slice()) };
}

export function dataToBuffer(a: AudioData): AudioBuffer {
  const b = new AudioBuffer({ numberOfChannels: a.channels.length, length: Math.max(1, a.channels[0]?.length ?? 1), sampleRate: a.sampleRate });
  a.channels.forEach((c, i) => b.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  return b;
}

const impulseCache = new Map<string, AudioBuffer>();

/** A synthetic room: stereo decaying noise. */
function impulse(ctx: BaseAudioContext, decay: number): AudioBuffer {
  const key = `${ctx.sampleRate}:${decay.toFixed(2)}`;
  let b = impulseCache.get(key);
  if (b) return b;
  const len = Math.max(1, Math.round(ctx.sampleRate * Math.min(8, Math.max(0.1, decay))));
  b = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: ctx.sampleRate });
  let s = 0x2468ace;
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < len; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const n = (s / 4294967296) * 2 - 1;
      d[i] = n * Math.pow(1 - i / len, 3);
    }
  }
  impulseCache.set(key, b);
  return b;
}

interface TrackChain {
  input: GainNode;
  meter: AnalyserNode;
}

function trackChain(ctx: BaseAudioContext, t: Track, dest: AudioNode): TrackChain {
  const a = t.audio;
  const input = ctx.createGain();
  let node: AudioNode = input;
  const chain = (n: AudioNode) => {
    node.connect(n);
    node = n;
  };
  if (a.eq.enabled) {
    const q = (type: BiquadFilterType, f: number, g = 0, Q = 0.707) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.gain.value = g;
      b.Q.value = Q;
      chain(b);
    };
    if (a.eq.lowCut > 0) q('highpass', a.eq.lowCut);
    if (a.eq.lowShelfGain) q('lowshelf', a.eq.lowShelfFreq, a.eq.lowShelfGain);
    if (a.eq.midGain) q('peaking', a.eq.midFreq, a.eq.midGain, a.eq.midQ);
    if (a.eq.highShelfGain) q('highshelf', a.eq.highShelfFreq, a.eq.highShelfGain);
    if (a.eq.highCut > 0) q('lowpass', a.eq.highCut);
  }
  if (a.compressor.enabled) {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = a.compressor.threshold;
    c.ratio.value = a.compressor.ratio;
    c.attack.value = a.compressor.attack;
    c.release.value = a.compressor.release;
    c.knee.value = a.compressor.knee;
    chain(c);
    const makeup = ctx.createGain();
    makeup.gain.value = dbToGain(a.compressor.makeupDb);
    chain(makeup);
  }
  const pan = ctx.createStereoPanner();
  pan.pan.value = Math.max(-1, Math.min(1, a.pan));
  // dry path
  node.connect(pan);
  if (a.delay.enabled) {
    const d = ctx.createDelay(2);
    d.delayTime.value = Math.min(2, Math.max(0.01, a.delay.time));
    const fb = ctx.createGain();
    fb.gain.value = Math.min(0.9, Math.max(0, a.delay.feedback));
    const wet = ctx.createGain();
    wet.gain.value = a.delay.mix;
    node.connect(d);
    d.connect(fb);
    fb.connect(d);
    d.connect(wet);
    wet.connect(pan);
  }
  if (a.reverb.enabled) {
    const conv = ctx.createConvolver();
    conv.buffer = impulse(ctx, a.reverb.decay);
    const wet = ctx.createGain();
    wet.gain.value = a.reverb.mix;
    node.connect(conv);
    conv.connect(wet);
    wet.connect(pan);
  }
  const fader = ctx.createGain();
  fader.gain.value = dbToGain(a.volumeDb);
  pan.connect(fader);
  const meter = ctx.createAnalyser();
  meter.fftSize = 1024;
  fader.connect(meter);
  fader.connect(dest);
  return { input, meter };
}

/** Clip gain curve (gain × fades × envelope) for the part of the clip that plays from `from` (seconds into the clip). */
function clipCurve(c: AudioClip, from: number, rate = 200): Float32Array {
  const dur = Math.max(0, c.duration - from);
  const n = Math.max(2, Math.ceil(dur * rate) + 1);
  const out = new Float32Array(n);
  const base = dbToGain(c.gainDb);
  for (let i = 0; i < n; i++) {
    const t = from + (i / (n - 1)) * dur;
    let g = base * dbToGain(envelopeDb(c.envelope, t));
    if (c.fadeIn > 0 && t < c.fadeIn) g *= Math.sin(((t / c.fadeIn) * Math.PI) / 2);
    if (c.fadeOut > 0 && t > c.duration - c.fadeOut) g *= Math.sin((Math.max(0, (c.duration - t) / c.fadeOut) * Math.PI) / 2);
    out[i] = g;
  }
  return out;
}

export interface Mix {
  meters: Map<string, AnalyserNode>;
  master: AnalyserNode;
  stop(): void;
}

/**
 * Builds the mix in `ctx` and schedules every audio clip from timeline time `from`, starting
 * at context time `when`.
 */
export function buildMix(ctx: BaseAudioContext, p: Project, buffers: Map<string, AudioBuffer>, from: number, when: number, opts: { limiter: boolean }): Mix {
  const masterGain = ctx.createGain();
  masterGain.gain.value = dbToGain(p.master.volumeDb);
  let out: AudioNode = masterGain;
  if (opts.limiter && p.master.limiter.enabled) {
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = p.master.limiter.ceilingDb;
    lim.ratio.value = 20;
    lim.knee.value = 0;
    lim.attack.value = 0.001;
    lim.release.value = 0.08;
    masterGain.connect(lim);
    out = lim;
  }
  const masterMeter = ctx.createAnalyser();
  masterMeter.fftSize = 1024;
  out.connect(masterMeter);
  out.connect(ctx.destination);

  const audible = audibleTracks(p);
  const meters = new Map<string, AnalyserNode>();
  const sources: AudioBufferSourceNode[] = [];
  for (const t of p.tracks) {
    if (t.kind !== 'audio') continue;
    const chain = trackChain(ctx, t, masterGain);
    meters.set(t.id, chain.meter);
    if (!audible.has(t.id)) continue;
    for (const c of t.clips) {
      if (c.kind !== 'audio' || clipEnd(c) <= from) continue;
      const buf = buffers.get(c.sourceId);
      if (!buf) continue;
      const into = Math.max(0, from - c.start);
      const offset = c.in + into;
      const dur = c.duration - into;
      if (offset >= buf.duration || dur <= 0) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      const start = when + Math.max(0, c.start - from);
      g.gain.setValueCurveAtTime(clipCurve(c, into), start, dur);
      src.connect(g);
      g.connect(chain.input);
      src.start(start, offset, dur);
      sources.push(src);
    }
  }
  return {
    meters,
    master: masterMeter,
    stop() {
      for (const s of sources) {
        try {
          s.stop();
        } catch {
          /* not started */
        }
        s.disconnect();
      }
      masterGain.disconnect();
    },
  };
}

export interface MixdownResult {
  audio: AudioData;
  /** integrated loudness before / after normalization, LUFS */
  loudnessBefore: number;
  loudnessAfter: number;
}

/** Renders the whole project's sound offline, then normalizes loudness and limits peaks. */
export async function renderMix(p: Project, buffers: Map<string, AudioBuffer>, sampleRate = 48000, onProgress?: (f: number) => void): Promise<MixdownResult> {
  const dur = Math.max(0.1, projectDuration(p));
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * sampleRate), sampleRate);
  buildMix(ctx, p, buffers, 0, 0, { limiter: false });
  onProgress?.(0.1);
  const rendered = await ctx.startRendering();
  onProgress?.(0.7);
  let audio = bufferToData(rendered);
  const before = integratedLoudness(audio);
  if (p.master.loudnessTarget !== null && Number.isFinite(before)) {
    const g = dbToGain(p.master.loudnessTarget - before);
    audio = { sampleRate: audio.sampleRate, channels: audio.channels.map((c) => c.map((v) => v * g)) };
  }
  if (p.master.limiter.enabled) audio = limit(audio, p.master.limiter.ceilingDb);
  onProgress?.(1);
  return { audio, loudnessBefore: before, loudnessAfter: integratedLoudness(audio) };
}

/** Peak level of an analyser's current block, in dBFS. */
export function meterDb(a: AnalyserNode, scratch: Float32Array<ArrayBuffer>): number {
  a.getFloatTimeDomainData(scratch);
  let p = 0;
  for (let i = 0; i < scratch.length; i++) p = Math.max(p, Math.abs(scratch[i]));
  return p > 0 ? 20 * Math.log10(p) : -Infinity;
}
