import { describe, expect, it } from 'vitest';
import * as UTIF from 'utif2';
import {
  NO_ADJUSTMENTS,
  applyAdjustments,
  applyFilter,
  blur,
  createPixels,
  crop,
  flatten,
  flip,
  hasTransparency,
  pixelate,
  resizeBilinear,
  rotate90,
  sharpen,
  type Pixels,
} from '../src/core/media/image-ops';
import { decodeTiff, encodeBmp, encodeGif, encodeIco, encodeTiff } from '../src/core/media/image-encoders';
import { CONTAINERS, IMAGE_FORMATS, sniffMedia } from '../src/core/media/media-formats';

function solid(w: number, h: number, rgba: [number, number, number, number]): Pixels {
  const px = createPixels(w, h);
  for (let i = 0; i < px.data.length; i += 4) px.data.set(rgba, i);
  return px;
}

/** 3×2 image with distinct pixels so geometry can be checked exactly. */
function grid(): Pixels {
  const px = createPixels(3, 2);
  for (let i = 0; i < 6; i++) px.data.set([i * 10, i * 10 + 1, i * 10 + 2, 255], i * 4);
  return px;
}

const at = (px: Pixels, x: number, y: number) => Array.from(px.data.subarray((y * px.width + x) * 4, (y * px.width + x) * 4 + 4));

describe('geometry', () => {
  it('rotates by quarter turns', () => {
    const r1 = rotate90(grid(), 1);
    expect([r1.width, r1.height]).toEqual([2, 3]);
    // clockwise: bottom-left pixel (index 3) becomes top-left
    expect(at(r1, 0, 0)[0]).toBe(30);
    expect(at(r1, 1, 0)[0]).toBe(0);
    const r2 = rotate90(grid(), 2);
    expect(at(r2, 0, 0)[0]).toBe(50);
    const r3 = rotate90(grid(), -1);
    expect(at(r3, 0, 0)[0]).toBe(20);
    expect(rotate90(rotate90(grid(), 1), 3).data).toEqual(grid().data);
  });

  it('flips and crops', () => {
    expect(at(flip(grid(), 'horizontal'), 0, 0)[0]).toBe(20);
    expect(at(flip(grid(), 'vertical'), 0, 0)[0]).toBe(30);
    const c = crop(grid(), { x: 1, y: 1, width: 5, height: 5 });
    expect([c.width, c.height]).toEqual([2, 1]);
    expect(at(c, 0, 0)[0]).toBe(40);
  });

  it('resizes with interpolation', () => {
    const r = resizeBilinear(solid(10, 10, [100, 150, 200, 255]), 4, 3);
    expect([r.width, r.height]).toEqual([4, 3]);
    expect(at(r, 2, 1)).toEqual([100, 150, 200, 255]);
  });
});

describe('colour', () => {
  it('adjustments are an identity at zero and move tone when set', () => {
    const px = solid(4, 4, [120, 120, 120, 255]);
    applyAdjustments(px, NO_ADJUSTMENTS);
    expect(at(px, 0, 0)).toEqual([120, 120, 120, 255]);
    applyAdjustments(px, { ...NO_ADJUSTMENTS, brightness: 50 });
    expect(at(px, 0, 0)[0]).toBeGreaterThan(140);
    const sat = solid(1, 1, [200, 100, 50, 255]);
    applyAdjustments(sat, { ...NO_ADJUSTMENTS, saturation: -100 });
    const [r, g, b] = at(sat, 0, 0);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(1);
    const hue = solid(1, 1, [255, 0, 0, 255]);
    applyAdjustments(hue, { ...NO_ADJUSTMENTS, hue: 120 });
    expect(at(hue, 0, 0).slice(0, 3)).toEqual([0, 255, 0]);
  });

  it('filters', () => {
    const g = solid(1, 1, [200, 100, 50, 255]);
    applyFilter(g, 'grayscale');
    const [r, gg, b] = at(g, 0, 0);
    expect(r).toBe(gg);
    expect(gg).toBe(b);
    const inv = solid(1, 1, [10, 20, 30, 255]);
    applyFilter(inv, 'invert');
    expect(at(inv, 0, 0)).toEqual([245, 235, 225, 255]);
    for (const f of ['sepia', 'vintage', 'cool', 'warm', 'dramatic', 'fade', 'noir'] as const) {
      expect(() => applyFilter(solid(8, 8, [90, 120, 150, 255]), f)).not.toThrow();
    }
  });

  it('blur spreads an edge, sharpen keeps flat areas flat', () => {
    const px = solid(10, 1, [0, 0, 0, 255]);
    for (let x = 5; x < 10; x++) px.data.set([255, 255, 255, 255], x * 4);
    blur(px, 2);
    expect(at(px, 4, 0)[0]).toBeGreaterThan(30);
    expect(at(px, 4, 0)[0]).toBeLessThan(225);
    const flat = solid(6, 6, [80, 80, 80, 255]);
    sharpen(flat, 80);
    expect(at(flat, 3, 3)).toEqual([80, 80, 80, 255]);
  });

  it('pixelate makes each block one colour and leaves the rest alone', () => {
    const px = createPixels(8, 8);
    for (let i = 0; i < 64; i++) px.data.set([i * 4, 0, 0, 255], i * 4);
    const before = at(px, 7, 7);
    pixelate(px, { x: 0, y: 0, width: 4, height: 4 }, 4);
    const block = new Set<number>();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) block.add(at(px, x, y)[0]);
    expect(block.size).toBe(1);
    expect(at(px, 7, 7)).toEqual(before);
  });

  it('flattens transparency onto a background', () => {
    const px = solid(2, 2, [255, 0, 0, 0]);
    expect(hasTransparency(px)).toBe(true);
    const f = flatten(px, [0, 0, 255]);
    expect(at(f, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(hasTransparency(f)).toBe(false);
  });
});

describe('encoders', () => {
  it('BMP: valid header, top-down BGRA with alpha', () => {
    const px = grid();
    const bmp = encodeBmp(px);
    const v = new DataView(bmp.buffer);
    expect(String.fromCharCode(bmp[0], bmp[1])).toBe('BM');
    expect(v.getUint32(2, true)).toBe(bmp.length);
    expect(v.getInt32(18, true)).toBe(3);
    expect(v.getInt32(22, true)).toBe(-2);
    expect(v.getUint16(28, true)).toBe(32);
    const off = v.getUint32(10, true);
    expect(Array.from(bmp.subarray(off, off + 4))).toEqual([2, 1, 0, 255]); // B G R A of pixel 0
  });

  it('ICO: directory points at each PNG', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5, 6, 7]);
    const ico = encodeIco([{ width: 16, height: 16, png: a }, { width: 256, height: 256, png: b }]);
    const v = new DataView(ico.buffer);
    expect(v.getUint16(2, true)).toBe(1);
    expect(v.getUint16(4, true)).toBe(2);
    expect(ico[6]).toBe(16);
    expect(ico[22]).toBe(0); // 256 stored as 0
    const off2 = v.getUint32(22 + 12, true);
    expect(Array.from(ico.subarray(off2, off2 + 4))).toEqual([4, 5, 6, 7]);
  });

  it('TIFF round trip', () => {
    const px = grid();
    const tif = encodeTiff(px);
    expect(Array.from(tif.subarray(0, 2))).toEqual([0x4d, 0x4d]);
    const back = decodeTiff(tif);
    expect([back.width, back.height, back.pages]).toEqual([3, 2, 1]);
    expect(Array.from(back.data)).toEqual(Array.from(px.data));
    expect(UTIF.decode(tif.buffer as ArrayBuffer).length).toBe(1);
  });

  it('GIF: still and animated, with transparency', () => {
    const still = encodeGif([{ pixels: solid(4, 4, [10, 200, 30, 255]), delay: 0 }]);
    expect(String.fromCharCode(...still.subarray(0, 6))).toBe('GIF89a');
    expect(still[still.length - 1]).toBe(0x3b);
    const t = solid(4, 4, [0, 0, 0, 0]);
    t.data.set([255, 0, 0, 255], 0);
    const anim = encodeGif([{ pixels: t, delay: 100 }, { pixels: solid(4, 4, [0, 0, 255, 255]), delay: 100 }]);
    const s = Buffer.from(anim).toString('latin1');
    expect(s).toContain('NETSCAPE2.0'); // loop extension
    expect((s.match(/\x21\xf9\x04/g) ?? []).length).toBe(2);
  });
});

describe('sniffMedia', () => {
  const b = (...xs: (number | string)[]) => {
    const out: number[] = [];
    for (const x of xs) typeof x === 'string' ? out.push(...[...x].map((c) => c.charCodeAt(0))) : out.push(x);
    return new Uint8Array([...out, ...new Array(200).fill(0)]);
  };
  const ftyp = (brand: string, ...compat: string[]) => b(0, 0, 0, 0x20, 'ftyp', brand, 0, 0, 0, 0, ...compat);

  it('identifies images', () => {
    expect(sniffMedia('x', b(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toEqual({ kind: 'image', format: 'png' });
    expect(sniffMedia('x', b(0xff, 0xd8, 0xff, 0xe0))).toEqual({ kind: 'image', format: 'jpeg' });
    expect(sniffMedia('x', b('GIF89a'))).toEqual({ kind: 'image', format: 'gif' });
    expect(sniffMedia('x', b('RIFF', 0, 0, 0, 0, 'WEBPVP8 '))).toEqual({ kind: 'image', format: 'webp' });
    expect(sniffMedia('x', b('BM', 0, 0, 0, 0))).toEqual({ kind: 'image', format: 'bmp' });
    expect(sniffMedia('x', b('II', 0x2a, 0))).toEqual({ kind: 'image', format: 'tiff' });
    expect(sniffMedia('x', ftyp('heic', 'mif1'))).toEqual({ kind: 'image', format: 'heic' });
    expect(sniffMedia('x', ftyp('avif', 'mif1'))).toEqual({ kind: 'image', format: 'avif' });
    expect(sniffMedia('logo.svg', b('<svg xmlns="http://www.w3.org/2000/svg">'))).toEqual({ kind: 'image', format: 'svg' });
    expect(sniffMedia('a.ico', b(0, 0, 1, 0, 1, 0))).toEqual({ kind: 'image', format: 'ico' });
  });

  it('identifies video and audio, flagging what needs ffmpeg', () => {
    expect(sniffMedia('clip.mp4', ftyp('isom', 'mp41'))).toMatchObject({ kind: 'video', ffmpegOnly: false });
    expect(sniffMedia('clip.mov', ftyp('qt  '))).toMatchObject({ kind: 'video', ext: 'mov' });
    expect(sniffMedia('song.m4a', ftyp('M4A '))).toMatchObject({ kind: 'audio' });
    expect(sniffMedia('phone.3gp', ftyp('3gp5'))).toMatchObject({ kind: 'video', ffmpegOnly: true });
    expect(sniffMedia('a.webm', b(0x1a, 0x45, 0xdf, 0xa3))).toMatchObject({ kind: 'video', ext: 'webm' });
    expect(sniffMedia('a.avi', b('RIFF', 0, 0, 0, 0, 'AVI LIST'))).toMatchObject({ kind: 'video', ffmpegOnly: true });
    expect(sniffMedia('a.wav', b('RIFF', 0, 0, 0, 0, 'WAVEfmt '))).toMatchObject({ kind: 'audio', ext: 'wav' });
    expect(sniffMedia('a.flv', b('FLV', 1))).toMatchObject({ kind: 'video', ffmpegOnly: true });
    expect(sniffMedia('a.wmv', b(0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11))).toMatchObject({ kind: 'video', ffmpegOnly: true });
    expect(sniffMedia('a.mp3', b('ID3', 4, 0))).toMatchObject({ kind: 'audio', ext: 'mp3' });
    expect(sniffMedia('a.flac', b('fLaC'))).toMatchObject({ kind: 'audio', ext: 'flac' });
    expect(sniffMedia('a.mpg', b(0, 0, 1, 0xba))).toMatchObject({ kind: 'video', ffmpegOnly: true });
    expect(sniffMedia('notes.txt', b('hello'))).toBeNull();
  });

  it('format tables are consistent', () => {
    for (const f of Object.values(IMAGE_FORMATS)) expect(f.extensions).toContain(f.ext);
    for (const c of Object.values(CONTAINERS)) {
      expect(c.extensions).toContain(c.ext);
      if (c.engine === 'mediabunny' && c.kind === 'video') expect(c.videoCodecs.length).toBeGreaterThan(0);
      if (c.engine === 'mediabunny') expect(c.audioCodecs.length).toBeGreaterThan(0);
    }
  });
});
