/**
 * ffmpeg.wasm, loaded on demand for the containers the browser cannot read or write itself
 * (AVI, WMV, FLV, MPEG-PS, 3GP, OGV, WMA, AMR, AIFF…). Single-threaded core, so it works without
 * cross-origin isolation headers; slower than the WebCodecs path, which is why it is only a
 * fallback. The core (GPL-2.0-or-later, includes x264) is served from /ffmpeg/ — see README.
 */
import type { FFmpeg } from '@ffmpeg/ffmpeg';

let instance: Promise<FFmpeg> | null = null;

function assetBase(): string {
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return new URL(base + 'ffmpeg/', document.baseURI).href;
}

async function getFFmpeg(): Promise<FFmpeg> {
  if (!instance) {
    instance = (async () => {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      const ff = new FFmpeg();
      const base = assetBase();
      await ff.load({ coreURL: base + 'ffmpeg-core.js', wasmURL: base + 'ffmpeg-core.wasm' });
      return ff;
    })();
    instance.catch(() => {
      instance = null;
    });
  }
  return instance;
}

export class FfmpegCancelled extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'FfmpegCancelled';
  }
}

/** 2 GB: the wasm heap holds the input and the output at once. */
export const FFMPEG_MAX_BYTES = 1.5 * 1024 * 1024 * 1024;

/**
 * Runs one ffmpeg command on an in-memory file. `args` must reference `inName` and `outName`.
 * Progress is 0..1. On abort, the worker is terminated (and reloaded next time).
 */
export async function runFfmpeg(
  input: Blob,
  inName: string,
  outName: string,
  args: string[],
  onProgress?: (p: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (input.size > FFMPEG_MAX_BYTES) throw new Error('This file is too large to convert in the browser (limit 1.5 GB).');
  const ff = await getFFmpeg();
  const onProg = ({ progress }: { progress: number }) => onProgress?.(Math.max(0, Math.min(1, progress)));
  ff.on('progress', onProg);
  const onAbort = () => {
    ff.terminate();
    instance = null;
  };
  signal?.addEventListener('abort', onAbort);
  try {
    await ff.writeFile(inName, new Uint8Array(await input.arrayBuffer()));
    const code = await ff.exec(['-hide_banner', '-y', ...args]);
    if (signal?.aborted) throw new FfmpegCancelled();
    if (code !== 0) throw new Error('The converter could not process this file.');
    const out = await ff.readFile(outName);
    return out instanceof Uint8Array ? out : new TextEncoder().encode(String(out));
  } catch (err) {
    if (signal?.aborted) throw new FfmpegCancelled();
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!signal?.aborted) {
      ff.off('progress', onProg);
      await ff.deleteFile(inName).catch(() => undefined);
      await ff.deleteFile(outName).catch(() => undefined);
    }
  }
}

/** Converts a legacy file into something the WebCodecs editor can open. */
export async function normalizeForEditing(file: Blob, ext: string, kind: 'video' | 'audio', onProgress?: (p: number) => void, signal?: AbortSignal): Promise<{ blob: Blob; ext: string }> {
  const inName = `input.${ext || 'bin'}`;
  if (kind === 'audio') {
    const out = await runFfmpeg(file, inName, 'out.flac', ['-i', inName, '-vn', '-c:a', 'flac', 'out.flac'], onProgress, signal);
    return { blob: new Blob([out as BlobPart], { type: 'audio/flac' }), ext: 'flac' };
  }
  const out = await runFfmpeg(
    file,
    inName,
    'out.mp4',
    ['-i', inName, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', 'out.mp4'],
    onProgress,
    signal,
  );
  return { blob: new Blob([out as BlobPart], { type: 'video/mp4' }), ext: 'mp4' };
}

/** ffmpeg arguments for the legacy output containers (input is an edited MP4/WebM). */
export function legacyOutputArgs(container: string, inName: string, outName: string, quality: number): string[] {
  // quality 1..5 → codec-specific scales
  const qv = String(Math.round(8 - quality * 1.4)); // mpeg4/mpeg2 -q:v 1(best)..31
  const vbr = `${[0, 600, 1200, 2500, 5000, 8000][quality]}k`;
  const common = ['-i', inName, '-map', '0:v:0?', '-map', '0:a:0?'];
  switch (container) {
    case 'avi':
      return [...common, '-c:v', 'mpeg4', '-vtag', 'xvid', '-q:v', qv, '-c:a', 'libmp3lame', '-q:a', '4', outName];
    case 'wmv':
      return [...common, '-c:v', 'wmv2', '-b:v', vbr, '-c:a', 'wmav2', '-b:a', '160k', outName];
    case 'flv':
      return [...common, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(33 - quality * 3), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-b:a', '128k', outName];
    case 'mpeg':
      return [...common, '-c:v', 'mpeg2video', '-q:v', qv, '-c:a', 'mp2', '-b:a', '192k', '-f', 'mpeg', outName];
    case '3gp':
      return [...common, '-c:v', 'libx264', '-profile:v', 'baseline', '-preset', 'veryfast', '-crf', String(33 - quality * 3), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1', '-ar', '22050', '-b:a', '64k', outName];
    case 'ogv':
      return [...common, '-c:v', 'libtheora', '-q:v', String(Math.min(10, 3 + quality)), '-c:a', 'libvorbis', '-q:a', '4', outName];
    default:
      throw new Error(`No converter for .${container}`);
  }
}
