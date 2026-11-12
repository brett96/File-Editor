/**
 * Studio signal processing, pure (no Web Audio, no DOM): chroma key for video frames, and for
 * audio an FFT, loudness measurement (ITU-R BS.1770-4 / EBU R128 integrated LUFS), a
 * look-ahead peak limiter, waveform edits and spectral noise reduction.
 */
import type { Pixels } from '../media/image-ops';

// ── video: chroma key ────────────────────────────────────────────────────

export function hexRgb(h: string): [number, number, number] {
  const v = parseInt(h.replace('#', ''), 16) || 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * Removes the key colour (green/blue screen): pixels close to it in chroma (Cb/Cr, so lighting
 * changes on the screen don't matter) become transparent, with a soft edge, and the remaining
 * edge pixels lose the key colour's tint (spill suppression). In place.
 */
export function chromaKey(px: Pixels, key: string, tolerance: number, softness: number, spill: number): Pixels {
  const [kr, kg, kb] = hexRgb(key);
  const kcb = -0.168736 * kr - 0.331264 * kg + 0.5 * kb;
  const kcr = 0.5 * kr - 0.418688 * kg - 0.081312 * kb;
  const t0 = (tolerance / 100) * 120;
  const t1 = t0 + (softness / 100) * 80 + 1e-3;
  const keyCh = kg >= kr && kg >= kb ? 1 : kb >= kr ? 2 : 0;
  const s = spill / 100;
  const d = px.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const cb = -0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
    const dist = Math.hypot(cb - kcb, cr - kcr);
    let a = dist <= t0 ? 0 : dist >= t1 ? 1 : (dist - t0) / (t1 - t0);
    a = a * a * (3 - 2 * a);
    d[i + 3] = d[i + 3] * a;
    if (s > 0 && a > 0) {
      // clamp the key channel to the brighter of the other two
      const ch = [r, g, b];
      const others = ch.filter((_, j) => j !== keyCh);
      const limit = Math.max(others[0], others[1]);
      if (ch[keyCh] > limit) d[i + keyCh] = ch[keyCh] - (ch[keyCh] - limit) * s;
    }
  }
  return px;
}

// ── audio data ───────────────────────────────────────────────────────────

export interface AudioData {
  sampleRate: number;
  /** one Float32Array per channel, equal lengths */
  channels: Float32Array[];
}

export const frames = (a: AudioData) => a.channels[0]?.length ?? 0;

export function silenceData(sampleRate: number, channelCount: number, length: number): AudioData {
  return { sampleRate, channels: Array.from({ length: channelCount }, () => new Float32Array(length)) };
}

function clampRange(a: AudioData, start: number, end: number): [number, number] {
  const n = frames(a);
  const s = Math.max(0, Math.min(n, Math.round(start)));
  const e = Math.max(s, Math.min(n, Math.round(end)));
  return [s, e];
}

export function sliceAudio(a: AudioData, start: number, end: number): AudioData {
  const [s, e] = clampRange(a, start, end);
  return { sampleRate: a.sampleRate, channels: a.channels.map((c) => c.slice(s, e)) };
}

export function deleteRange(a: AudioData, start: number, end: number): AudioData {
  const [s, e] = clampRange(a, start, end);
  return {
    sampleRate: a.sampleRate,
    channels: a.channels.map((c) => {
      const out = new Float32Array(c.length - (e - s));
      out.set(c.subarray(0, s), 0);
      out.set(c.subarray(e), s);
      return out;
    }),
  };
}

/** Inserts `b` at frame `at` (channel counts are matched by repeating/dropping channels). */
export function insertAudio(a: AudioData, at: number, b: AudioData): AudioData {
  const [s] = clampRange(a, at, at);
  const len = frames(b);
  return {
    sampleRate: a.sampleRate,
    channels: a.channels.map((c, i) => {
      const src = b.channels[Math.min(i, b.channels.length - 1)];
      const out = new Float32Array(c.length + len);
      out.set(c.subarray(0, s), 0);
      out.set(src, s);
      out.set(c.subarray(s), s + len);
      return out;
    }),
  };
}

function mapRange(a: AudioData, start: number, end: number, fn: (x: number, i: number, n: number) => number): AudioData {
  const [s, e] = clampRange(a, start, end);
  return {
    sampleRate: a.sampleRate,
    channels: a.channels.map((c) => {
      const out = c.slice();
      for (let i = s; i < e; i++) out[i] = fn(c[i], i - s, e - s);
      return out;
    }),
  };
}

export const silenceRange = (a: AudioData, s: number, e: number) => mapRange(a, s, e, () => 0);
export const gainRange = (a: AudioData, s: number, e: number, db: number) => {
  const g = Math.pow(10, db / 20);
  return mapRange(a, s, e, (x) => x * g);
};

/** Fade in or out over the range; `curve` 'linear' or 'log' (equal-power-ish, sounds smoother). */
export function fadeRange(a: AudioData, s: number, e: number, dir: 'in' | 'out', curve: 'linear' | 'log' = 'log'): AudioData {
  return mapRange(a, s, e, (x, i, n) => {
    let t = n > 1 ? i / (n - 1) : 1;
    if (dir === 'out') t = 1 - t;
    return x * (curve === 'log' ? Math.sin((t * Math.PI) / 2) : t);
  });
}

export function reverseRange(a: AudioData, start: number, end: number): AudioData {
  const [s, e] = clampRange(a, start, end);
  return {
    sampleRate: a.sampleRate,
    channels: a.channels.map((c) => {
      const out = c.slice();
      for (let i = s, j = e - 1; i < e; i++, j--) out[i] = c[j];
      return out;
    }),
  };
}

export function peak(a: AudioData, start = 0, end = frames(a)): number {
  const [s, e] = clampRange(a, start, end);
  let p = 0;
  for (const c of a.channels) for (let i = s; i < e; i++) p = Math.max(p, Math.abs(c[i]));
  return p;
}

/**
 * Noise gate: silences the range wherever the level stays below `thresholdDb` (with attack,
 * hold and release so word endings aren't chopped off).
 */
export function gateRange(a: AudioData, start: number, end: number, thresholdDb: number, attackMs = 2, holdMs = 60, releaseMs = 120): AudioData {
  const [s, e] = clampRange(a, start, end);
  const thr = Math.pow(10, thresholdDb / 20);
  const sr = a.sampleRate;
  const att = 1 - Math.exp(-1 / Math.max(1, (attackMs / 1000) * sr));
  const rel = 1 - Math.exp(-1 / Math.max(1, (releaseMs / 1000) * sr));
  const hold = Math.round((holdMs / 1000) * sr);
  // envelope follower on the peak of all channels
  const env = 1 - Math.exp(-1 / (0.005 * sr));
  let level = 0;
  let g = 0;
  let held = 0;
  const gains = new Float32Array(e - s);
  for (let i = s; i < e; i++) {
    let p = 0;
    for (const c of a.channels) p = Math.max(p, Math.abs(c[i]));
    level = p > level ? p : level + (p - level) * env;
    if (level >= thr) held = hold;
    else if (held > 0) held--;
    const target = level >= thr || held > 0 ? 1 : 0;
    g += (target - g) * (target > g ? att : rel);
    gains[i - s] = g;
  }
  return { sampleRate: a.sampleRate, channels: a.channels.map((c) => {
    const out = c.slice();
    for (let i = s; i < e; i++) out[i] = c[i] * gains[i - s];
    return out;
  }) };
}

/** Peak-normalizes the range to `targetDb` dBFS. */
export function normalizeRange(a: AudioData, s: number, e: number, targetDb = -1): AudioData {
  const p = peak(a, s, e);
  if (p <= 0) return a;
  return gainRange(a, s, e, targetDb - 20 * Math.log10(p));
}

// ── FFT ──────────────────────────────────────────────────────────────────

/** In-place radix-2 complex FFT (length must be a power of two). inverse=true scales by 1/n. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j];
        const ui = im[i + j];
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr;
        im[i + j + len / 2] = ui - vi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] /= n;
  }
}

// ── noise reduction ──────────────────────────────────────────────────────

const N_FFT = 2048;
const HOP = 512;

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** Average magnitude spectrum of a noise-only sample (the "noise profile"). */
export function noiseProfile(noise: AudioData): Float64Array {
  const w = hann(N_FFT);
  const prof = new Float64Array(N_FFT / 2 + 1);
  let count = 0;
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  for (const ch of noise.channels) {
    for (let pos = 0; pos + N_FFT <= ch.length; pos += HOP) {
      for (let i = 0; i < N_FFT; i++) {
        re[i] = ch[pos + i] * w[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 0; k <= N_FFT / 2; k++) prof[k] += Math.hypot(re[k], im[k]);
      count++;
    }
  }
  if (!count) throw new Error('Select at least 0.05 seconds of noise to learn its profile.');
  for (let k = 0; k < prof.length; k++) prof[k] /= count;
  return prof;
}

/**
 * Spectral subtraction: each STFT frame's magnitude is reduced by the noise profile
 * (× over-subtraction from `strength` 0–100) with a spectral floor so it doesn't turn
 * "watery", and gains are smoothed over time. Phase is kept; overlap-add resynthesis.
 */
export function reduceNoise(a: AudioData, profile: Float64Array, strength: number): AudioData {
  const over = 1 + (strength / 100) * 2;
  const floor = 0.25 - (strength / 100) * 0.2;
  const w = hann(N_FFT);
  const bins = N_FFT / 2 + 1;
  const out = a.channels.map((c) => {
    const n = c.length;
    const y = new Float64Array(n + N_FFT);
    const norm = new Float64Array(n + N_FFT);
    const re = new Float64Array(N_FFT);
    const im = new Float64Array(N_FFT);
    const prevGain = new Float64Array(bins).fill(1);
    for (let pos = -N_FFT + HOP; pos < n; pos += HOP) {
      for (let i = 0; i < N_FFT; i++) {
        const j = pos + i;
        re[i] = (j >= 0 && j < n ? c[j] : 0) * w[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 0; k < bins; k++) {
        const mag = Math.hypot(re[k], im[k]);
        const target = Math.max(mag - over * profile[k], floor * mag);
        let g = mag > 1e-12 ? target / mag : 0;
        // attack fast, release slower: avoids musical-noise flutter
        g = g < prevGain[k] ? g : prevGain[k] * 0.6 + g * 0.4;
        prevGain[k] = g;
        re[k] *= g;
        im[k] *= g;
        if (k > 0 && k < N_FFT / 2) {
          re[N_FFT - k] = re[k];
          im[N_FFT - k] = -im[k];
        }
      }
      fft(re, im, true);
      for (let i = 0; i < N_FFT; i++) {
        const j = pos + i;
        if (j < 0 || j >= n) continue;
        y[j] += re[i] * w[i];
        norm[j] += w[i] * w[i];
      }
    }
    const res = new Float32Array(n);
    for (let i = 0; i < n; i++) res[i] = norm[i] > 1e-6 ? y[i] / norm[i] : 0;
    return res;
  });
  return { sampleRate: a.sampleRate, channels: out };
}

// ── loudness (ITU-R BS.1770-4) ───────────────────────────────────────────

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function kWeighting(fs: number): [Biquad, Biquad] {
  // stage 1: high shelf (+4 dB above ~1.7 kHz)
  let G = 3.99984385397;
  let Q = 0.7071752369554193;
  let fc = 1681.9744509555319;
  let A = Math.pow(10, G / 40);
  let w0 = (2 * Math.PI * fc) / fs;
  let alpha = Math.sin(w0) / (2 * Q);
  let cs = Math.cos(w0);
  let a0 = A + 1 - (A - 1) * cs + 2 * Math.sqrt(A) * alpha;
  const shelf: Biquad = {
    b0: (A * (A + 1 + (A - 1) * cs + 2 * Math.sqrt(A) * alpha)) / a0,
    b1: (-2 * A * (A - 1 + (A + 1) * cs)) / a0,
    b2: (A * (A + 1 + (A - 1) * cs - 2 * Math.sqrt(A) * alpha)) / a0,
    a1: (2 * (A - 1 - (A + 1) * cs)) / a0,
    a2: (A + 1 - (A - 1) * cs - 2 * Math.sqrt(A) * alpha) / a0,
  };
  // stage 2: high pass (RLB weighting)
  Q = 0.5003270373253953;
  fc = 38.13547087613982;
  w0 = (2 * Math.PI * fc) / fs;
  alpha = Math.sin(w0) / (2 * Q);
  cs = Math.cos(w0);
  a0 = 1 + alpha;
  const hp: Biquad = { b0: (1 + cs) / 2 / a0, b1: -(1 + cs) / a0, b2: (1 + cs) / 2 / a0, a1: (-2 * cs) / a0, a2: (1 - alpha) / a0 };
  G = A = 0;
  return [shelf, hp];
}

function filter(x: Float32Array, f: Biquad): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = f.b0 * x[i] + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/** Integrated loudness in LUFS (−Infinity for silence). Channel weights 1 (mono/stereo/LCR). */
export function integratedLoudness(a: AudioData): number {
  const [shelf, hp] = kWeighting(a.sampleRate);
  const weighted = a.channels.map((c) => {
    const s1 = filter(c, shelf);
    const f32 = Float32Array.from(s1);
    return filter(f32, hp);
  });
  const block = Math.round(0.4 * a.sampleRate);
  const step = Math.round(0.1 * a.sampleRate);
  const n = frames(a);
  const z: number[] = [];
  for (let s = 0; s + block <= n; s += step) {
    let sum = 0;
    for (const w of weighted) {
      let ms = 0;
      for (let i = s; i < s + block; i++) ms += w[i] * w[i];
      sum += ms / block;
    }
    z.push(sum);
  }
  if (!z.length) return -Infinity;
  const L = (v: number) => -0.691 + 10 * Math.log10(v);
  const abs = z.filter((v) => v > 0 && L(v) > -70);
  if (!abs.length) return -Infinity;
  const rel = L(abs.reduce((x, y) => x + y, 0) / abs.length) - 10;
  const gated = abs.filter((v) => L(v) > rel);
  return L(gated.reduce((x, y) => x + y, 0) / gated.length);
}

/**
 * Look-ahead peak limiter: gain drops just before peaks would exceed `ceilingDb` and recovers
 * over `releaseMs`. Never lets a sample exceed the ceiling. Returns a new buffer.
 */
export function limit(a: AudioData, ceilingDb = -1, lookaheadMs = 5, releaseMs = 80): AudioData {
  const n = frames(a);
  const ceil = Math.pow(10, ceilingDb / 20);
  const look = Math.max(1, Math.round((lookaheadMs / 1000) * a.sampleRate));
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const c of a.channels) p = Math.max(p, Math.abs(c[i]));
    need[i] = p > ceil ? ceil / p : 1;
  }
  // sliding minimum over the look-ahead window (monotonic deque)
  const win = new Float32Array(n);
  const dq = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let j = 0;
  for (let i = 0; i < n; i++) {
    while (j < n && j <= i + look) {
      while (tail > head && need[dq[tail - 1]] >= need[j]) tail--;
      dq[tail++] = j++;
    }
    while (dq[head] < i) head++;
    win[i] = need[dq[head]];
  }
  const rel = 1 - Math.exp(-1 / ((releaseMs / 1000) * a.sampleRate));
  const gain = new Float32Array(n);
  let g = 1;
  for (let i = 0; i < n; i++) {
    g = win[i] < g ? win[i] : g + (win[i] - g) * rel;
    gain[i] = Math.min(g, need[i]);
  }
  return { sampleRate: a.sampleRate, channels: a.channels.map((c) => c.map((v, i) => v * gain[i])) };
}

/** Gain (dB) that brings the audio to `targetLufs`. */
export function loudnessGainDb(a: AudioData, targetLufs: number): number {
  const l = integratedLoudness(a);
  return Number.isFinite(l) ? targetLufs - l : 0;
}

/** Downsampled min/max pairs for drawing a waveform (`buckets` columns). */
export function waveformPeaks(a: AudioData, start: number, end: number, buckets: number): Float32Array {
  const [s, e] = clampRange(a, start, end);
  const out = new Float32Array(buckets * 2);
  const span = Math.max(1, e - s);
  for (let b = 0; b < buckets; b++) {
    const i0 = s + Math.floor((b / buckets) * span);
    const i1 = Math.max(i0 + 1, s + Math.floor(((b + 1) / buckets) * span));
    let mn = 0;
    let mx = 0;
    for (const c of a.channels) {
      for (let i = i0; i < i1 && i < e; i++) {
        const v = c[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    out[b * 2] = mn;
    out[b * 2 + 1] = mx;
  }
  return out;
}

/** 16-bit PCM WAV (for keeping edited audio as a source file). */
export function encodeWav(a: AudioData): Uint8Array {
  const ch = a.channels.length;
  const n = frames(a);
  const buf = new ArrayBuffer(44 + n * ch * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * ch * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, a.sampleRate, true);
  v.setUint32(28, a.sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * ch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, a.channels[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
}
