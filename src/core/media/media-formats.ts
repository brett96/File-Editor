/**
 * Image, video and audio formats: what we can open, what we can write, and content sniffing.
 *
 * Images are decoded to pixels and edited on a canvas (see image-codecs.ts). Video and audio
 * are edited with Mediabunny on top of the browser's WebCodecs (video-engine.ts); containers
 * the browser cannot demux (AVI, WMV, FLV, MPEG-PS…) go through ffmpeg.wasm (ffmpeg-engine.ts).
 */

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'avif' | 'jxl' | 'gif' | 'bmp' | 'tiff' | 'ico' | 'heic' | 'svg';
export type ImageOutputFormat = Exclude<ImageFormat, 'heic' | 'svg'>;

export interface ImageFormatInfo {
  id: ImageFormat;
  label: string;
  ext: string;
  extensions: string[];
  mime: string;
  canWrite: boolean;
  lossy: boolean;
  alpha: boolean;
  note?: string;
}

export const IMAGE_FORMATS: Record<ImageFormat, ImageFormatInfo> = {
  png: { id: 'png', label: 'PNG', ext: 'png', extensions: ['png', 'apng'], mime: 'image/png', canWrite: true, lossy: false, alpha: true },
  jpeg: { id: 'jpeg', label: 'JPEG', ext: 'jpg', extensions: ['jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'pjp'], mime: 'image/jpeg', canWrite: true, lossy: true, alpha: false },
  webp: { id: 'webp', label: 'WebP', ext: 'webp', extensions: ['webp'], mime: 'image/webp', canWrite: true, lossy: true, alpha: true },
  avif: { id: 'avif', label: 'AVIF', ext: 'avif', extensions: ['avif'], mime: 'image/avif', canWrite: true, lossy: true, alpha: true },
  jxl: { id: 'jxl', label: 'JPEG XL', ext: 'jxl', extensions: ['jxl'], mime: 'image/jxl', canWrite: true, lossy: true, alpha: true },
  gif: { id: 'gif', label: 'GIF', ext: 'gif', extensions: ['gif'], mime: 'image/gif', canWrite: true, lossy: false, alpha: true, note: 'GIF is limited to 256 colours; photos are dithered down.' },
  bmp: { id: 'bmp', label: 'Bitmap (BMP)', ext: 'bmp', extensions: ['bmp', 'dib'], mime: 'image/bmp', canWrite: true, lossy: false, alpha: true },
  tiff: { id: 'tiff', label: 'TIFF', ext: 'tiff', extensions: ['tif', 'tiff'], mime: 'image/tiff', canWrite: true, lossy: false, alpha: true },
  ico: { id: 'ico', label: 'Icon (ICO)', ext: 'ico', extensions: ['ico', 'cur'], mime: 'image/x-icon', canWrite: true, lossy: false, alpha: true, note: 'Saved as a multi-size icon (16–256 px).' },
  heic: { id: 'heic', label: 'HEIC / HEIF', ext: 'heic', extensions: ['heic', 'heif', 'hif'], mime: 'image/heic', canWrite: false, lossy: true, alpha: true, note: 'HEIC can be opened but not written (no royalty-free encoder exists); save as JPEG, WebP or AVIF instead.' },
  svg: { id: 'svg', label: 'SVG', ext: 'svg', extensions: ['svg'], mime: 'image/svg+xml', canWrite: false, lossy: false, alpha: true, note: 'SVG is rasterised when opened.' },
};

export const IMAGE_OUTPUT_ORDER: ImageOutputFormat[] = ['png', 'jpeg', 'webp', 'avif', 'jxl', 'gif', 'bmp', 'tiff', 'ico'];

// ── video / audio ─────────────────────────────────────────────────────────

export type ContainerFormat =
  | 'mp4' | 'mov' | 'webm' | 'mkv' | 'ts'
  | 'gif'
  | 'avi' | 'wmv' | 'flv' | 'mpeg' | '3gp' | 'ogv'
  | 'mp3' | 'wav' | 'aac' | 'm4a' | 'flac' | 'ogg' | 'opus';

export type VideoCodecId = 'avc' | 'hevc' | 'vp9' | 'av1' | 'vp8';
export type AudioCodecId = 'aac' | 'opus' | 'mp3' | 'vorbis' | 'flac' | 'pcm-s16';

export interface ContainerInfo {
  id: ContainerFormat;
  label: string;
  ext: string;
  extensions: string[];
  mime: string;
  kind: 'video' | 'audio';
  /** Which engine writes it. */
  engine: 'mediabunny' | 'gif' | 'ffmpeg';
  /** Codecs offered for this container, first = default. */
  videoCodecs: VideoCodecId[];
  audioCodecs: AudioCodecId[];
  note?: string;
}

export const CONTAINERS: Record<ContainerFormat, ContainerInfo> = {
  mp4: { id: 'mp4', label: 'MP4', ext: 'mp4', extensions: ['mp4', 'm4v'], mime: 'video/mp4', kind: 'video', engine: 'mediabunny', videoCodecs: ['avc', 'hevc', 'av1', 'vp9'], audioCodecs: ['aac', 'opus', 'mp3', 'flac'] },
  mov: { id: 'mov', label: 'QuickTime (MOV)', ext: 'mov', extensions: ['mov', 'qt'], mime: 'video/quicktime', kind: 'video', engine: 'mediabunny', videoCodecs: ['avc', 'hevc'], audioCodecs: ['aac', 'pcm-s16'] },
  webm: { id: 'webm', label: 'WebM', ext: 'webm', extensions: ['webm'], mime: 'video/webm', kind: 'video', engine: 'mediabunny', videoCodecs: ['vp9', 'vp8', 'av1'], audioCodecs: ['opus', 'vorbis'] },
  mkv: { id: 'mkv', label: 'Matroska (MKV)', ext: 'mkv', extensions: ['mkv', 'mk3d'], mime: 'video/x-matroska', kind: 'video', engine: 'mediabunny', videoCodecs: ['avc', 'hevc', 'vp9', 'av1', 'vp8'], audioCodecs: ['aac', 'opus', 'flac', 'mp3', 'vorbis'] },
  ts: { id: 'ts', label: 'MPEG transport stream (TS)', ext: 'ts', extensions: ['ts', 'mts', 'm2ts'], mime: 'video/mp2t', kind: 'video', engine: 'mediabunny', videoCodecs: ['avc', 'hevc'], audioCodecs: ['aac', 'mp3'] },
  gif: { id: 'gif', label: 'Animated GIF', ext: 'gif', extensions: ['gif'], mime: 'image/gif', kind: 'video', engine: 'gif', videoCodecs: [], audioCodecs: [], note: 'No sound, 256 colours, best kept short and small (≤ 15 fps, ≤ 640 px).' },
  avi: { id: 'avi', label: 'AVI', ext: 'avi', extensions: ['avi'], mime: 'video/x-msvideo', kind: 'video', engine: 'ffmpeg', videoCodecs: [], audioCodecs: [], note: 'Written with ffmpeg (MPEG-4 Part 2 + MP3). Slower than MP4/WebM.' },
  wmv: { id: 'wmv', label: 'Windows Media (WMV)', ext: 'wmv', extensions: ['wmv', 'asf'], mime: 'video/x-ms-wmv', kind: 'video', engine: 'ffmpeg', videoCodecs: [], audioCodecs: [], note: 'Written with ffmpeg (WMV2 + WMA2). Slower than MP4/WebM.' },
  flv: { id: 'flv', label: 'Flash video (FLV)', ext: 'flv', extensions: ['flv', 'f4v'], mime: 'video/x-flv', kind: 'video', engine: 'ffmpeg', videoCodecs: [], audioCodecs: [], note: 'Written with ffmpeg (H.264 + AAC).' },
  mpeg: { id: 'mpeg', label: 'MPEG-1/2 (MPG)', ext: 'mpg', extensions: ['mpg', 'mpeg', 'mpe', 'm1v', 'm2v', 'vob'], mime: 'video/mpeg', kind: 'video', engine: 'ffmpeg', videoCodecs: [], audioCodecs: [], note: 'Written with ffmpeg (MPEG-2 + MP2), DVD-compatible.' },
  '3gp': { id: '3gp', label: '3GP (mobile)', ext: '3gp', extensions: ['3gp', '3g2'], mime: 'video/3gpp', kind: 'video', engine: 'ffmpeg', videoCodecs: [], audioCodecs: [], note: 'Written with ffmpeg (H.264 + AAC).' },
  ogv: { id: 'ogv', label: 'Ogg video (OGV)', ext: 'ogv', extensions: ['ogv'], mime: 'video/ogg', kind: 'video', engine: 'ffmpeg', videoCodecs: [], audioCodecs: [], note: 'Written with ffmpeg (Theora + Vorbis).' },
  mp3: { id: 'mp3', label: 'MP3 audio', ext: 'mp3', extensions: ['mp3'], mime: 'audio/mpeg', kind: 'audio', engine: 'mediabunny', videoCodecs: [], audioCodecs: ['mp3'] },
  wav: { id: 'wav', label: 'WAV audio', ext: 'wav', extensions: ['wav', 'wave'], mime: 'audio/wav', kind: 'audio', engine: 'mediabunny', videoCodecs: [], audioCodecs: ['pcm-s16'] },
  aac: { id: 'aac', label: 'AAC audio (ADTS)', ext: 'aac', extensions: ['aac'], mime: 'audio/aac', kind: 'audio', engine: 'mediabunny', videoCodecs: [], audioCodecs: ['aac'] },
  m4a: { id: 'm4a', label: 'M4A audio', ext: 'm4a', extensions: ['m4a', 'm4b'], mime: 'audio/mp4', kind: 'audio', engine: 'mediabunny', videoCodecs: [], audioCodecs: ['aac'] },
  flac: { id: 'flac', label: 'FLAC audio (lossless)', ext: 'flac', extensions: ['flac'], mime: 'audio/flac', kind: 'audio', engine: 'mediabunny', videoCodecs: [], audioCodecs: ['flac'] },
  ogg: { id: 'ogg', label: 'Ogg Vorbis audio', ext: 'ogg', extensions: ['ogg', 'oga'], mime: 'audio/ogg', kind: 'audio', engine: 'mediabunny', videoCodecs: [], audioCodecs: ['vorbis', 'opus'] },
  opus: { id: 'opus', label: 'Opus audio', ext: 'opus', extensions: ['opus'], mime: 'audio/ogg', kind: 'audio', engine: 'mediabunny', videoCodecs: [], audioCodecs: ['opus'] },
};

export const VIDEO_OUTPUT_ORDER: ContainerFormat[] = ['mp4', 'webm', 'mov', 'mkv', 'gif', 'ts', 'avi', 'wmv', 'flv', 'mpeg', '3gp', 'ogv'];
export const AUDIO_OUTPUT_ORDER: ContainerFormat[] = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aac'];

export const VIDEO_CODEC_LABELS: Record<VideoCodecId, string> = {
  avc: 'H.264 (most compatible)',
  hevc: 'H.265 / HEVC (smaller, newer devices)',
  vp9: 'VP9',
  av1: 'AV1 (smallest, slow to encode)',
  vp8: 'VP8 (legacy)',
};

export const AUDIO_CODEC_LABELS: Record<AudioCodecId, string> = {
  aac: 'AAC',
  opus: 'Opus',
  mp3: 'MP3',
  vorbis: 'Vorbis',
  flac: 'FLAC (lossless)',
  'pcm-s16': 'PCM 16-bit (uncompressed)',
};

/** Extensions only ffmpeg can demux in the browser. */
export const FFMPEG_ONLY_INPUT = ['avi', 'wmv', 'asf', 'flv', 'f4v', 'mpg', 'mpeg', 'mpe', 'm1v', 'm2v', 'vob', '3gp', '3g2', 'ogv', 'divx', 'xvid', 'rm', 'rmvb', 'dv', 'mxf', 'wma', 'amr', 'ac3', 'aiff', 'aif', 'ape', 'wv', 'mka'];

export const IMAGE_EXTENSIONS_ALL: string[] = Object.values(IMAGE_FORMATS).flatMap((f) => f.extensions);
export const MEDIA_EXTENSIONS_ALL: string[] = [
  ...new Set([...Object.values(CONTAINERS).filter((c) => c.id !== 'gif').flatMap((c) => c.extensions), ...FFMPEG_ONLY_INPUT]),
];

// ── sniffing ──────────────────────────────────────────────────────────────

function ascii(bytes: Uint8Array, offset: number, len: number): string {
  let s = '';
  for (let i = offset; i < Math.min(bytes.length, offset + len); i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

export type MediaKind = { kind: 'image'; format: ImageFormat } | { kind: 'video' | 'audio'; ext: string; ffmpegOnly: boolean };

const BRANDS_HEIC = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];
const BRANDS_AVIF = ['avif', 'avis'];
const BRANDS_AUDIO = ['M4A ', 'M4B ', 'M4P '];

/** Identifies image / video / audio content from its first bytes (and the name as a tie-breaker). */
export function sniffMedia(name: string, head: Uint8Array): MediaKind | null {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
  const h = head;
  if (startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', format: 'png' };
  if (startsWith(h, [0xff, 0xd8, 0xff])) return { kind: 'image', format: 'jpeg' };
  if (ascii(h, 0, 4) === 'GIF8') return { kind: 'image', format: 'gif' };
  if (ascii(h, 0, 4) === 'RIFF' && ascii(h, 8, 4) === 'WEBP') return { kind: 'image', format: 'webp' };
  if (ascii(h, 0, 2) === 'BM' && h.length > 14) return { kind: 'image', format: 'bmp' };
  if (startsWith(h, [0x49, 0x49, 0x2a, 0x00]) || startsWith(h, [0x4d, 0x4d, 0x00, 0x2a])) {
    // TIFF container — but camera RAW files (DNG/CR2/NEF/ARW) are TIFF too; trust the extension for those
    return { kind: 'image', format: 'tiff' };
  }
  if (startsWith(h, [0x00, 0x00, 0x01, 0x00]) || startsWith(h, [0x00, 0x00, 0x02, 0x00])) {
    if (['ico', 'cur'].includes(ext)) return { kind: 'image', format: 'ico' };
  }
  if (startsWith(h, [0xff, 0x0a]) || startsWith(h, [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20])) return { kind: 'image', format: 'jxl' };
  if (ascii(h, 4, 4) === 'ftyp') {
    const major = ascii(h, 8, 4);
    const brands = [major];
    for (let o = 16; o + 4 <= Math.min(h.length, 64); o += 4) brands.push(ascii(h, o, 4));
    if (brands.some((b) => BRANDS_AVIF.includes(b))) return { kind: 'image', format: 'avif' };
    if (brands.some((b) => BRANDS_HEIC.includes(b))) return { kind: 'image', format: 'heic' };
    if (BRANDS_AUDIO.includes(major) || (['m4a', 'm4b'].includes(ext))) return { kind: 'audio', ext: ext || 'm4a', ffmpegOnly: false };
    if (major.startsWith('3g')) return { kind: 'video', ext: '3gp', ffmpegOnly: true };
    return { kind: 'video', ext: ext || 'mp4', ffmpegOnly: false };
  }
  const textHead = ascii(h, 0, 256).trimStart().toLowerCase();
  if (textHead.startsWith('<svg') || (textHead.startsWith('<?xml') && textHead.includes('<svg')) || ext === 'svg') {
    if (textHead.includes('<svg') || ext === 'svg') return { kind: 'image', format: 'svg' };
  }
  if (startsWith(h, [0x1a, 0x45, 0xdf, 0xa3])) {
    if (ext === 'mka') return { kind: 'audio', ext, ffmpegOnly: false };
    return { kind: 'video', ext: ext === 'webm' ? 'webm' : 'mkv', ffmpegOnly: false };
  }
  if (ascii(h, 0, 4) === 'RIFF' && ascii(h, 8, 4) === 'AVI ') return { kind: 'video', ext: 'avi', ffmpegOnly: true };
  if (ascii(h, 0, 4) === 'RIFF' && ascii(h, 8, 4) === 'WAVE') return { kind: 'audio', ext: 'wav', ffmpegOnly: false };
  if (startsWith(h, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])) {
    return { kind: ext === 'wma' ? 'audio' : 'video', ext: ext || 'wmv', ffmpegOnly: true };
  }
  if (ascii(h, 0, 3) === 'FLV') return { kind: 'video', ext: 'flv', ffmpegOnly: true };
  if (startsWith(h, [0x00, 0x00, 0x01, 0xba]) || startsWith(h, [0x00, 0x00, 0x01, 0xb3])) return { kind: 'video', ext: 'mpg', ffmpegOnly: true };
  if (h[0] === 0x47 && h.length > 188 && h[188] === 0x47) return { kind: 'video', ext: 'ts', ffmpegOnly: false };
  if (ascii(h, 0, 4) === 'OggS') {
    const isVideo = ascii(h, 0, 120).includes('theora') || ext === 'ogv';
    return { kind: isVideo ? 'video' : 'audio', ext: isVideo ? 'ogv' : ext || 'ogg', ffmpegOnly: isVideo };
  }
  if (ascii(h, 0, 4) === 'fLaC') return { kind: 'audio', ext: 'flac', ffmpegOnly: false };
  if (ascii(h, 0, 3) === 'ID3' || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0 && ext !== 'aac')) return { kind: 'audio', ext: 'mp3', ffmpegOnly: false };
  if (h[0] === 0xff && (h[1] & 0xf6) === 0xf0) return { kind: 'audio', ext: 'aac', ffmpegOnly: false };
  if (ascii(h, 0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(ascii(h, 8, 4))) return { kind: 'audio', ext: 'aiff', ffmpegOnly: true };
  if (ascii(h, 0, 6) === '#!AMR\n') return { kind: 'audio', ext: 'amr', ffmpegOnly: true };
  // extension fallback for the remaining ffmpeg-only formats (RealMedia, DV, MXF…)
  if (FFMPEG_ONLY_INPUT.includes(ext)) {
    const audioOnly = ['wma', 'amr', 'ac3', 'aiff', 'aif', 'ape', 'wv'].includes(ext);
    return { kind: audioOnly ? 'audio' : 'video', ext, ffmpegOnly: true };
  }
  return null;
}

export function isMediaName(name: string): boolean {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
  return IMAGE_EXTENSIONS_ALL.includes(ext) || MEDIA_EXTENSIONS_ALL.includes(ext);
}
