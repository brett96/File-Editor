/**
 * Studio export (browser): renders every frame with the compositor and encodes it together
 * with the offline audio mix (loudness-normalized, limited) through Mediabunny / WebCodecs.
 * Video clips are decoded frame-accurately at exactly the timestamps each output frame needs.
 */
import type { WrappedCanvas } from 'mediabunny';
import { CONTAINERS, type ContainerFormat } from '../media/media-formats';
import { ensureExtraEncoders, mediabunny, outputFormat, qualityOf, type QualityLevel } from '../media/video-engine';
import { dataToBuffer, renderMix } from './audio';
import { drawFrame } from './compose';
import { clipEnd, hasVideoTracks, projectDuration, type MediaClip, type Project } from './model';

export interface StudioExportOptions {
  container: ContainerFormat;
  quality: QualityLevel;
  /** output size; defaults to the project size */
  width?: number;
  height?: number;
  fps?: number;
}

export interface StudioExportResult {
  bytes: Uint8Array;
  loudness: number | null;
}

export class StudioCancelled extends Error {
  constructor() {
    super('Export cancelled.');
    this.name = 'StudioCancelled';
  }
}

export async function exportStudio(
  p: Project,
  blobs: Map<string, Blob>,
  buffers: Map<string, AudioBuffer>,
  o: StudioExportOptions,
  report: (phase: string, progress: number) => void,
  signal?: AbortSignal,
): Promise<StudioExportResult> {
  const mb = await mediabunny();
  await ensureExtraEncoders(mb);
  const info = CONTAINERS[o.container];
  const audioOnly = info.kind === 'audio';
  if (!audioOnly && !hasVideoTracks(p)) throw new Error('This project has no video clips. Export it as an audio format (WAV, MP3, M4A, FLAC…).');
  const duration = projectDuration(p);
  if (duration <= 0) throw new Error('The timeline is empty.');
  const quality = await qualityOf(mb, o.quality);
  const target = new mb.BufferTarget();
  const output = new mb.Output({ format: outputFormat(mb, o.container), target });

  // ── audio: offline mix first (fast), streamed in with the video
  const hasAudio = p.tracks.some((t) => t.kind === 'audio' && t.clips.length);
  let mixed: Awaited<ReturnType<typeof renderMix>> | null = null;
  let audioSource: InstanceType<typeof mb.AudioBufferSource> | null = null;
  if (hasAudio) {
    report('Mixing audio', 0);
    mixed = await renderMix(p, buffers, 48000, (f) => report('Mixing audio', f * (audioOnly ? 0.6 : 0.1)));
    const codec = await mb.getFirstEncodableAudioCodec(info.audioCodecs as never, { numberOfChannels: 2, sampleRate: 48000 });
    if (!codec) throw new Error(`No audio encoder for ${info.label} is available.`);
    audioSource = new mb.AudioBufferSource({ codec, bitrate: quality });
    output.addAudioTrack(audioSource);
  }

  // ── video
  const width = Math.round((o.width ?? p.width) / 2) * 2;
  const height = Math.round((o.height ?? p.height) / 2) * 2;
  const fps = o.fps ?? p.fps;
  let videoSource: InstanceType<typeof mb.CanvasSource> | null = null;
  let canvas: OffscreenCanvas | null = null;
  if (!audioOnly) {
    const codec = await mb.getFirstEncodableVideoCodec(info.videoCodecs as never, { width, height });
    if (!codec) throw new Error(`No video encoder for ${info.label} at ${width}×${height} is available.`);
    canvas = new OffscreenCanvas(width, height);
    videoSource = new mb.CanvasSource(canvas, { codec, bitrate: quality, keyFrameInterval: 2 });
    output.addVideoTrack(videoSource, { frameRate: fps });
  }
  if (!audioSource && !videoSource) throw new Error('Nothing to export.');
  await output.start();

  const chunk = async (fromSec: number, toSec: number) => {
    if (!audioSource || !mixed) return;
    const sr = mixed.audio.sampleRate;
    const s = Math.round(fromSec * sr);
    const e = Math.min(mixed.audio.channels[0].length, Math.round(toSec * sr));
    if (e <= s) return;
    await audioSource.add(dataToBuffer({ sampleRate: sr, channels: mixed.audio.channels.map((c) => c.subarray(s, e)) }));
  };

  const inputs: { dispose(): void }[] = [];
  try {
    if (audioOnly || !canvas || !videoSource) {
      await chunk(0, duration + 1);
    } else {
      const scale = width / p.width;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const totalFrames = Math.max(1, Math.ceil(duration * fps));

      // frame iterators per video clip: decode exactly the timestamps the output needs
      const iters = new Map<string, AsyncGenerator<WrappedCanvas | null, void, unknown>>();
      const images = new Map<string, ImageBitmap>();
      const current = new Map<string, CanvasImageSource>();
      for (const t of p.tracks) {
        if (t.kind !== 'video' || t.muted) continue;
        for (const c of t.clips) {
          if (c.kind === 'image' && !images.has(c.sourceId)) {
            const b = blobs.get(c.sourceId);
            if (b) images.set(c.sourceId, await createImageBitmap(b));
          }
          if (c.kind !== 'video') continue;
          const blob = blobs.get(c.sourceId);
          if (!blob) continue;
          const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
          inputs.push(input);
          const track = await input.getPrimaryVideoTrack();
          if (!track || !(await track.canDecode())) throw new Error(`The video "${p.sources[c.sourceId]?.name ?? c.name}" can't be decoded here.`);
          const sink = new mb.CanvasSink(track, { poolSize: 2 });
          const stamps: number[] = [];
          for (let i = 0; i < totalFrames; i++) {
            const tt = i / fps;
            if (tt >= c.start && tt < clipEnd(c)) stamps.push(c.in + (tt - c.start));
          }
          iters.set(c.id, sink.canvasesAtTimestamps(stamps));
        }
      }
      const frameFor = (c: MediaClip) => (c.kind === 'image' ? images.get(c.sourceId) ?? null : current.get(c.id) ?? null);

      let audioUpTo = 0;
      for (let i = 0; i < totalFrames; i++) {
        if (signal?.aborted) throw new StudioCancelled();
        const tt = i / fps;
        for (const t of p.tracks) {
          if (t.kind !== 'video' || t.muted) continue;
          for (const c of t.clips) {
            if (c.kind !== 'video' || tt < c.start || tt >= clipEnd(c)) continue;
            const it = iters.get(c.id);
            const next = it ? await it.next() : null;
            if (next && !next.done && next.value) current.set(c.id, next.value.canvas);
          }
        }
        drawFrame(ctx, p, tt, frameFor, scale);
        await videoSource.add(tt, 1 / fps);
        // keep the audio about a second ahead of the video so the muxer can interleave
        if (tt + 1 > audioUpTo) {
          await chunk(audioUpTo, audioUpTo + 1);
          audioUpTo += 1;
        }
        if (i % 5 === 0) report('Rendering video', 0.1 + (0.88 * i) / totalFrames);
      }
      await chunk(audioUpTo, duration + 1);
      for (const it of iters.values()) await it.return?.();
    }
    report('Finishing', 0.99);
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => undefined);
    throw err;
  } finally {
    for (const i of inputs) i.dispose();
  }
  if (!target.buffer) throw new Error('The export produced no data.');
  report('Done', 1);
  return { bytes: new Uint8Array(target.buffer), loudness: mixed ? mixed.loudnessAfter : null };
}
