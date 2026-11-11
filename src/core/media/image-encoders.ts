/**
 * Encoders that need no browser APIs: BMP, ICO container, TIFF (utif2) and GIF (gifenc).
 * PNG/JPEG/WebP use the canvas and AVIF/JPEG XL use WASM codecs (image-codecs.ts).
 */
import * as UTIF from 'utif2';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import type { Pixels } from './image-ops';

/** 32-bit BGRA BMP (BITMAPV4HEADER so alpha is honoured by Windows and browsers). */
export function encodeBmp(px: Pixels): Uint8Array {
  const { width: w, height: h, data } = px;
  const headerSize = 14 + 108;
  const imageSize = w * h * 4;
  const out = new Uint8Array(headerSize + imageSize);
  const v = new DataView(out.buffer);
  out[0] = 0x42; // B
  out[1] = 0x4d; // M
  v.setUint32(2, out.length, true);
  v.setUint32(10, headerSize, true);
  v.setUint32(14, 108, true); // BITMAPV4HEADER
  v.setInt32(18, w, true);
  v.setInt32(22, -h, true); // negative = top-down rows
  v.setUint16(26, 1, true); // planes
  v.setUint16(28, 32, true); // bpp
  v.setUint32(30, 3, true); // BI_BITFIELDS
  v.setUint32(34, imageSize, true);
  v.setInt32(38, 2835, true); // 72 dpi in px/m
  v.setInt32(42, 2835, true);
  v.setUint32(54, 0x00ff0000, true); // R mask
  v.setUint32(58, 0x0000ff00, true); // G mask
  v.setUint32(62, 0x000000ff, true); // B mask
  v.setUint32(66, 0xff000000, true); // A mask
  v.setUint32(70, 0x73524742, true); // 'sRGB'
  let o = headerSize;
  for (let i = 0; i < data.length; i += 4) {
    out[o++] = data[i + 2];
    out[o++] = data[i + 1];
    out[o++] = data[i];
    out[o++] = data[i + 3];
  }
  return out;
}

/** Wraps PNG-encoded images into a .ico file (Vista+ PNG icons; one entry per size). */
export function encodeIco(entries: { width: number; height: number; png: Uint8Array }[]): Uint8Array {
  const count = entries.length;
  const dirSize = 6 + 16 * count;
  const total = dirSize + entries.reduce((n, e) => n + e.png.length, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint16(0, 0, true);
  v.setUint16(2, 1, true); // icon
  v.setUint16(4, count, true);
  let offset = dirSize;
  entries.forEach((e, i) => {
    const d = 6 + 16 * i;
    out[d] = e.width >= 256 ? 0 : e.width;
    out[d + 1] = e.height >= 256 ? 0 : e.height;
    out[d + 2] = 0; // palette
    out[d + 3] = 0;
    v.setUint16(d + 4, 1, true); // planes
    v.setUint16(d + 6, 32, true); // bpp
    v.setUint32(d + 8, e.png.length, true);
    v.setUint32(d + 12, offset, true);
    out.set(e.png, offset);
    offset += e.png.length;
  });
  return out;
}

export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

export function encodeTiff(px: Pixels): Uint8Array {
  const rgba = new Uint8Array(px.data.buffer, px.data.byteOffset, px.data.byteLength);
  return new Uint8Array(UTIF.encodeImage(rgba, px.width, px.height));
}

/** Decodes the first page of a TIFF (plus the page count, so the UI can mention the rest). */
export function decodeTiff(bytes: Uint8Array): Pixels & { pages: number } {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const tag = (ifd: UTIF.IFD, t: string) => Number((ifd[t] as number[] | undefined)?.[0] ?? 0);
  const ifds = UTIF.decode(buf).filter((ifd) => tag(ifd, 't256') && tag(ifd, 't257'));
  if (!ifds.length) throw new Error('This TIFF file contains no images.');
  // prefer the largest image (some files put a thumbnail first)
  const area = (ifd: UTIF.IFD) => tag(ifd, 't256') * tag(ifd, 't257');
  const ifd = ifds.reduce((best, cur) => (area(cur) > area(best) ? cur : best), ifds[0]);
  UTIF.decodeImage(buf, ifd);
  const rgba = UTIF.toRGBA8(ifd);
  const width = Number(ifd.width ?? tag(ifd, 't256'));
  const height = Number(ifd.height ?? tag(ifd, 't257'));
  return { data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, width * height * 4), width, height, pages: ifds.length };
}

export interface GifFrame {
  pixels: Pixels;
  /** milliseconds */
  delay: number;
}

/**
 * Encodes one or more frames as a GIF. Each frame gets its own 256-colour palette, and fully
 * transparent pixels are kept transparent.
 */
export function encodeGif(frames: GifFrame[], options: { loop?: boolean; colors?: number } = {}): Uint8Array {
  if (!frames.length) throw new Error('A GIF needs at least one frame.');
  const gif = GIFEncoder();
  const colors = Math.max(2, Math.min(256, options.colors ?? 256));
  frames.forEach((f, i) => {
    const { data, width, height } = f.pixels;
    const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    let transparent = false;
    for (let k = 3; k < rgba.length; k += 4) {
      if (rgba[k] < 128) {
        transparent = true;
        break;
      }
    }
    const palette = quantize(rgba, colors, { format: transparent ? 'rgba4444' : 'rgb565', oneBitAlpha: transparent });
    const index = applyPalette(rgba, palette, transparent ? 'rgba4444' : 'rgb565');
    const tIndex = transparent ? palette.findIndex((p: number[]) => p.length > 3 && p[3] === 0) : -1;
    gif.writeFrame(index, width, height, {
      palette,
      delay: f.delay,
      repeat: i === 0 ? (options.loop === false ? -1 : 0) : undefined,
      transparent: tIndex >= 0,
      transparentIndex: Math.max(0, tIndex),
    });
  });
  gif.finish();
  return gif.bytes();
}
