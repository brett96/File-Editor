/**
 * Video / audio editing and conversion on Mediabunny + WebCodecs (hardware-accelerated where
 * the browser offers it). Edits are a declarative description applied in one conversion pass:
 * trim → rotate/flip → crop → resize/frame rate → per-frame look & overlays → encode.
 * Untouched streams are copied without re-encoding when the target container allows it.
 */
import type { InputAudioTrack, InputVideoTrack, Quality, Rotation, VideoCodec, AudioCodec } from 'mediabunny';
import { CONTAINERS, type AudioCodecId, type ContainerFormat, type VideoCodecId } from './media-formats';
import { applyAdjustments, applyFilter, isIdentity, NO_ADJUSTMENTS, type Adjustments, type FilterPreset } from './image-ops';
import { encodeGif } from './image-encoders';
import { legacyOutputArgs, runFfmpeg } from './ffmpeg-engine';

type MB = typeof import('mediabunny');
let mbPromise: Promise<MB> | null = null;
let extraEncoders: Promise<void> | null = null;

async function mediabunny(): Promise<MB> {
  if (!mbPromise) mbPromise = import('mediabunny');
  return mbPromise;
}

/** Registers WASM encoders for codecs WebCodecs lacks (MP3 always; AAC/FLAC where missing). */
async function ensureExtraEncoders(mb: MB): Promise<void> {
  if (!extraEncoders) {
    extraEncoders = (async () => {
      const [{ registerMp3Encoder }, { registerFlacEncoder }] = await Promise.all([import('@mediabunny/mp3-encoder'), import('@mediabunny/flac-encoder')]);
      registerMp3Encoder();
      registerFlacEncoder();
      if (!(await mb.canEncodeAudio('aac'))) {
        const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
        registerAacEncoder();
      }
    })();
  }
  return extraEncoders;
}

export interface MediaInfo {
  duration: number;
  container: string;
  mime: string;
  hasVideo: boolean;
  hasAudio: boolean;
  /** display size, rotation applied */
  width: number;
  height: number;
  rotation: number;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  /** WebCodecs can decode the streams (otherwise ffmpeg must convert first). */
  decodable: boolean;
}

export async function probeMedia(blob: Blob): Promise<MediaInfo> {
  const mb = await mediabunny();
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  try {
    const format = await input.getFormat();
    const [video, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
    const duration = await input.computeDuration();
    let fps: number | null = null;
    if (video) {
      try {
        fps = Math.round((await video.computePacketStats(120)).averagePacketRate * 100) / 100;
      } catch {
        fps = null;
      }
    }
    const decodable = (!video || (await video.canDecode())) && (!audio || (await audio.canDecode()));
    return {
      duration,
      container: format.name,
      mime: await input.getMimeType(),
      hasVideo: !!video,
      hasAudio: !!audio,
      width: video ? await video.getDisplayWidth() : 0,
      height: video ? await video.getDisplayHeight() : 0,
      rotation: video ? await video.getRotation() : 0,
      fps,
      videoCodec: video ? await video.getCodec() : null,
      audioCodec: audio ? await audio.getCodec() : null,
      sampleRate: audio ? await audio.getSampleRate() : null,
      channels: audio ? await audio.getNumberOfChannels() : null,
      decodable,
    };
  } finally {
    input.dispose();
  }
}

export interface TextOverlay {
  id: string;
  text: string;
  /** centre position as fractions of the output frame */
  x: number;
  y: number;
  /** font size as a fraction of the output frame height */
  size: number;
  color: string;
  background: boolean;
  /** seconds on the trimmed timeline; null = whole clip */
  start: number | null;
  end: number | null;
}

export interface VideoEdits {
  trimStart: number;
  /** null = to the end */
  trimEnd: number | null;
  /** 0/90/180/270, clockwise */
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  /** In pixels of the rotated/flipped frame. */
  crop: { left: number; top: number; width: number; height: number } | null;
  mute: boolean;
  /** 0..2 */
  volume: number;
  /** seconds */
  fadeIn: number;
  fadeOut: number;
  adjustments: Adjustments;
  filter: FilterPreset;
  overlays: TextOverlay[];
}

export const NO_EDITS: VideoEdits = {
  trimStart: 0,
  trimEnd: null,
  rotate: 0,
  flipH: false,
  flipV: false,
  crop: null,
  mute: false,
  volume: 1,
  fadeIn: 0,
  fadeOut: 0,
  adjustments: NO_ADJUSTMENTS,
  filter: 'none',
  overlays: [],
};

export type QualityLevel = 1 | 2 | 3 | 4 | 5;
export const QUALITY_LABELS: Record<QualityLevel, string> = { 1: 'Smallest file', 2: 'Low', 3: 'Medium', 4: 'High', 5: 'Best' };

export interface MediaExportOptions {
  container: ContainerFormat;
  videoCodec?: VideoCodecId;
  audioCodec?: AudioCodecId;
  quality: QualityLevel;
  /** output size; null keeps the (cropped) size */
  width: number | null;
  height: number | null;
  fps: number | null;
  /** Animated GIF only */
  gifColors?: number;
}

export interface ExportProgress {
  phase: string;
  progress: number;
}

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled.');
    this.name = 'ExportCancelled';
  }
}

async function qualityOf(mb: MB, q: QualityLevel): Promise<Quality> {
  return [mb.QUALITY_VERY_LOW, mb.QUALITY_LOW, mb.QUALITY_MEDIUM, mb.QUALITY_HIGH, mb.QUALITY_VERY_HIGH][q - 1];
}

function outputFormat(mb: MB, container: ContainerFormat) {
  switch (container) {
    case 'mp4':
      return new mb.Mp4OutputFormat({ fastStart: 'in-memory' });
    case 'm4a':
      return new mb.Mp4OutputFormat({ fastStart: 'in-memory' });
    case 'mov':
      return new mb.MovOutputFormat({ fastStart: 'in-memory' });
    case 'webm':
      return new mb.WebMOutputFormat();
    case 'mkv':
      return new mb.MkvOutputFormat();
    case 'ts':
      return new mb.MpegTsOutputFormat();
    case 'mp3':
      return new mb.Mp3OutputFormat();
    case 'wav':
      return new mb.WavOutputFormat();
    case 'aac':
      return new mb.AdtsOutputFormat();
    case 'flac':
      return new mb.FlacOutputFormat();
    case 'ogg':
    case 'opus':
      return new mb.OggOutputFormat();
    default:
      throw new Error(`Unsupported container ${container}`);
  }
}

/** Codecs this browser can actually encode for a container (first = default). */
export async function encodableCodecs(container: ContainerFormat, size?: { width: number; height: number }): Promise<{ video: VideoCodecId[]; audio: AudioCodecId[] }> {
  const mb = await mediabunny();
  await ensureExtraEncoders(mb);
  const info = CONTAINERS[container];
  const video: VideoCodecId[] = [];
  for (const c of info.videoCodecs) {
    if (await mb.canEncodeVideo(c as VideoCodec, size ? { width: size.width, height: size.height } : undefined)) video.push(c);
  }
  const audio: AudioCodecId[] = [];
  for (const c of info.audioCodecs) if (await mb.canEncodeAudio(c as AudioCodec)) audio.push(c);
  return { video, audio };
}

function needsFrameProcessing(e: VideoEdits): boolean {
  return !isIdentity(e.adjustments) || e.filter !== 'none' || e.overlays.length > 0 || e.fadeIn > 0 || e.fadeOut > 0;
}

/** Draws the look, the text overlays and fades onto a frame canvas. Shared with the preview. */
export function renderFrameEffects(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  t: number,
  clipDuration: number,
  e: Pick<VideoEdits, 'adjustments' | 'filter' | 'overlays' | 'fadeIn' | 'fadeOut'>,
  options: { pixelOps?: boolean } = {},
): void {
  if (options.pixelOps !== false && (!isIdentity(e.adjustments) || e.filter !== 'none')) {
    const img = ctx.getImageData(0, 0, width, height);
    const px = { data: img.data, width, height };
    applyFilter(px, e.filter);
    applyAdjustments(px, e.adjustments);
    ctx.putImageData(img, 0, 0);
  }
  for (const o of e.overlays) {
    if (!o.text.trim()) continue;
    if (o.start !== null && t < o.start) continue;
    if (o.end !== null && t > o.end) continue;
    const size = Math.max(8, o.size * height);
    ctx.save();
    ctx.font = `600 ${size}px system-ui, "Segoe UI", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = o.text.split('\n');
    const lh = size * 1.2;
    const cx = o.x * width;
    const cy = o.y * height - ((lines.length - 1) * lh) / 2;
    if (o.background) {
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + size * 0.8;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(cx - w / 2, cy - lh / 2 - size * 0.15, w, lh * lines.length + size * 0.3);
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = size * 0.15;
    }
    ctx.fillStyle = o.color;
    lines.forEach((l, i) => ctx.fillText(l, cx, cy + i * lh));
    ctx.restore();
  }
  let fade = 1;
  if (e.fadeIn > 0 && t < e.fadeIn) fade = Math.min(fade, t / e.fadeIn);
  if (e.fadeOut > 0 && t > clipDuration - e.fadeOut) fade = Math.min(fade, (clipDuration - t) / e.fadeOut);
  if (fade < 1) {
    ctx.fillStyle = `rgba(0,0,0,${Math.max(0, Math.min(1, 1 - fade))})`;
    ctx.fillRect(0, 0, width, height);
  }
}

interface ConvertArgs {
  blob: Blob;
  edits: VideoEdits;
  info: MediaInfo;
  container: ContainerFormat;
  videoCodec: VideoCodecId | null;
  audioCodec: AudioCodecId | null;
  quality: QualityLevel;
  width: number | null;
  height: number | null;
  fps: number | null;
  discardAudio?: boolean;
  onProgress?: (p: number) => void;
  signal?: AbortSignal;
}

/** One Mediabunny conversion pass with every edit applied. */
async function convert(a: ConvertArgs): Promise<Uint8Array> {
  const mb = await mediabunny();
  await ensureExtraEncoders(mb);
  const { edits: e } = a;
  const input = new mb.Input({ source: new mb.BlobSource(a.blob), formats: mb.ALL_FORMATS });
  const target = new mb.BufferTarget();
  const output = new mb.Output({ format: outputFormat(mb, a.container), target });
  const quality = await qualityOf(mb, a.quality);
  const audioOnly = CONTAINERS[a.container].kind === 'audio';
  const clipEnd = e.trimEnd ?? a.info.duration;
  const clipDuration = Math.max(0, clipEnd - e.trimStart);
  const processFrames = !audioOnly && needsFrameProcessing(e);

  let canvas: OffscreenCanvas | null = null;
  let ctx: OffscreenCanvasRenderingContext2D | null = null;

  // Mediabunny rotates first, then flips horizontally; a vertical flip is 180° + horizontal flip.
  let rotate = e.rotate as number;
  let flipH = e.flipH;
  if (e.flipV) {
    rotate = (rotate + 180) % 360;
    flipH = !flipH;
  }

  const conversion = await mb.Conversion.init({
    input,
    output,
    trim: { start: e.trimStart, end: e.trimEnd ?? undefined },
    video: audioOnly
      ? { discard: true }
      : (_track: InputVideoTrack) => ({
          rotate: rotate as Rotation,
          flip: flipH || undefined,
          crop: e.crop ? { left: Math.round(e.crop.left), top: Math.round(e.crop.top), width: Math.round(e.crop.width), height: Math.round(e.crop.height) } : undefined,
          width: a.width ?? undefined,
          height: a.height ?? undefined,
          fit: a.width && a.height ? 'contain' : undefined,
          frameRate: a.fps ?? undefined,
          codec: (a.videoCodec ?? undefined) as VideoCodec | undefined,
          quality,
          allowRotationMetadata: false,
          forceTranscode: processFrames || undefined,
          process: processFrames
            ? (sample) => {
                const w = sample.displayWidth;
                const h = sample.displayHeight;
                if (!canvas || canvas.width !== w || canvas.height !== h) {
                  canvas = new OffscreenCanvas(w, h);
                  ctx = canvas.getContext('2d', { willReadFrequently: true })!;
                }
                sample.draw(ctx!, 0, 0, w, h);
                renderFrameEffects(ctx!, w, h, sample.timestamp - e.trimStart, clipDuration, e);
                return canvas;
              }
            : undefined,
        }),
    audio: (_track: InputAudioTrack) => {
      if (e.mute || a.discardAudio) return { discard: true };
      const needsAudioProcess = e.volume !== 1 || e.fadeIn > 0 || e.fadeOut > 0;
      return {
        codec: (a.audioCodec ?? undefined) as AudioCodec | undefined,
        quality,
        forceTranscode: needsAudioProcess || undefined,
        process: needsAudioProcess
          ? (s) => {
              const ch = s.numberOfChannels;
              const n = s.numberOfFrames;
              const buf = new Float32Array(ch * n);
              for (let p = 0; p < ch; p++) s.copyTo(buf.subarray(p * n, (p + 1) * n), { planeIndex: p, format: 'f32-planar' });
              const t0 = s.timestamp - e.trimStart;
              for (let i = 0; i < n; i++) {
                const t = t0 + i / s.sampleRate;
                let g = e.volume;
                if (e.fadeIn > 0 && t < e.fadeIn) g *= Math.max(0, t / e.fadeIn);
                if (e.fadeOut > 0 && t > clipDuration - e.fadeOut) g *= Math.max(0, (clipDuration - t) / e.fadeOut);
                if (g === 1) continue;
                for (let p = 0; p < ch; p++) {
                  const k = p * n + i;
                  buf[k] = Math.max(-1, Math.min(1, buf[k] * g));
                }
              }
              return new mb.AudioSample({ data: buf, format: 'f32-planar', numberOfChannels: ch, sampleRate: s.sampleRate, timestamp: s.timestamp });
            }
          : undefined,
      };
    },
  });

  if (!conversion.isValid) {
    input.dispose();
    const reasons = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason.replace(/_/g, ' ')}`).join('; ');
    throw new Error(`This combination can't be written by this browser (${reasons || 'no usable tracks'}). Try MP4 with H.264, or WebM.`);
  }
  const onAbort = () => void conversion.cancel();
  a.signal?.addEventListener('abort', onAbort);
  conversion.onProgress = (p) => a.onProgress?.(p);
  try {
    await conversion.execute();
  } catch (err) {
    if (a.signal?.aborted || (err as Error)?.name === 'ConversionCanceledError') throw new ExportCancelled();
    throw err;
  } finally {
    a.signal?.removeEventListener('abort', onAbort);
    input.dispose();
  }
  if (!target.buffer) throw new Error('The export produced no data.');
  return new Uint8Array(target.buffer);
}

/** Renders the edited clip to an animated GIF (via a temporary high-quality WebM/MP4). */
async function exportGif(blob: Blob, edits: VideoEdits, info: MediaInfo, o: MediaExportOptions, report: (p: ExportProgress) => void, signal?: AbortSignal): Promise<Uint8Array> {
  const mb = await mediabunny();
  const fps = Math.min(30, o.fps ?? 12);
  const baseW = edits.crop?.width ?? (edits.rotate % 180 ? info.height : info.width);
  const baseH = edits.crop?.height ?? (edits.rotate % 180 ? info.width : info.height);
  const width = o.width ?? Math.min(480, baseW);
  const height = o.height ?? Math.round((width / baseW) * baseH);
  const codec = (await mb.getFirstEncodableVideoCodec(['vp9', 'avc', 'vp8', 'av1'], { width, height })) as VideoCodecId | null;
  if (!codec) throw new Error('This browser cannot encode video, so it cannot make a GIF.');
  const container: ContainerFormat = codec === 'avc' ? 'mp4' : 'webm';
  const temp = await convert({
    blob, edits, info, container, videoCodec: codec, audioCodec: null, quality: 5, width, height: height - (height % 2), fps, discardAudio: true,
    onProgress: (p) => report({ phase: 'Rendering frames', progress: p * 0.6 }), signal,
  });
  const input = new mb.Input({ source: new mb.BufferSource(temp), formats: mb.ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video to turn into a GIF.');
    const sink = new mb.CanvasSink(track, { poolSize: 2 });
    const duration = await input.computeDuration();
    const frames = [];
    let last = -1;
    for await (const wrapped of sink.canvases()) {
      if (signal?.aborted) throw new ExportCancelled();
      if (wrapped.timestamp - last < 1 / fps - 1e-3 && last >= 0) continue;
      last = wrapped.timestamp;
      const c = wrapped.canvas as HTMLCanvasElement | OffscreenCanvas;
      const cctx = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
      const img = cctx.getImageData(0, 0, c.width, c.height);
      frames.push({ pixels: { data: new Uint8ClampedArray(img.data), width: c.width, height: c.height }, delay: Math.round(1000 / fps) });
      report({ phase: 'Building GIF', progress: 0.6 + 0.3 * Math.min(1, wrapped.timestamp / (duration || 1)) });
      if (frames.length > 1500) throw new Error('That clip is too long for a GIF. Trim it to under a minute or lower the frame rate.');
    }
    report({ phase: 'Encoding GIF', progress: 0.92 });
    return encodeGif(frames, { colors: o.gifColors ?? 256 });
  } finally {
    input.dispose();
  }
}

/** Exports the edited media in any supported container. */
export async function exportMedia(
  blob: Blob,
  edits: VideoEdits,
  info: MediaInfo,
  o: MediaExportOptions,
  report: (p: ExportProgress) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const c = CONTAINERS[o.container];
  if (c.kind === 'video' && !info.hasVideo) throw new Error('This file has no video track. Choose an audio format.');
  if (c.kind === 'audio' && (!info.hasAudio || edits.mute)) throw new Error('There is no sound to export.');

  if (c.engine === 'gif') return exportGif(blob, edits, info, o, report, signal);

  if (c.engine === 'ffmpeg') {
    const mb = await mediabunny();
    const codec = (await mb.getFirstEncodableVideoCodec(['avc', 'vp9', 'vp8', 'av1'])) as VideoCodecId | null;
    if (!codec) throw new Error('This browser cannot encode video.');
    const inter: ContainerFormat = codec === 'avc' ? 'mp4' : 'webm';
    const temp = await convert({
      blob, edits, info, container: inter, videoCodec: codec, audioCodec: null, quality: 5, width: o.width, height: o.height, fps: o.fps,
      onProgress: (p) => report({ phase: 'Applying edits', progress: p * 0.4 }), signal,
    });
    report({ phase: 'Loading converter', progress: 0.4 });
    const inName = `in.${inter}`;
    const outName = `out.${c.ext}`;
    return runFfmpeg(new Blob([temp as BlobPart]), inName, outName, legacyOutputArgs(o.container, inName, outName, o.quality), (p) => report({ phase: `Writing ${c.label}`, progress: 0.4 + p * 0.6 }), signal);
  }

  report({ phase: 'Starting', progress: 0 });
  return convert({
    blob, edits, info, container: o.container, videoCodec: o.videoCodec ?? null, audioCodec: o.audioCodec ?? null, quality: o.quality,
    width: o.width, height: o.height, fps: o.fps,
    onProgress: (p) => report({ phase: c.kind === 'audio' ? 'Encoding audio' : 'Encoding video', progress: p }), signal,
  });
}

/** Grabs one frame (display orientation, no edits) as a canvas — for "Save frame as image". */
export async function grabFrame(blob: Blob, time: number): Promise<HTMLCanvasElement | OffscreenCanvas> {
  const mb = await mediabunny();
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video track.');
    const sink = new mb.CanvasSink(track, { poolSize: 0 });
    const wrapped = await sink.getCanvas(time);
    if (!wrapped) throw new Error('Could not read that frame.');
    return wrapped.canvas as HTMLCanvasElement | OffscreenCanvas;
  } finally {
    input.dispose();
  }
}
