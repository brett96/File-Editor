/**
 * Browser-side image decode / encode. Every input format is turned into plain RGBA pixels
 * (EXIF orientation applied), and every output is produced from pixels — so camera metadata
 * such as GPS location is never carried into a saved copy.
 */
import { IMAGE_FORMATS, sniffMedia, type ImageFormat, type ImageOutputFormat } from './media-formats';
import { createPixels, flatten, hasTransparency, type Pixels } from './image-ops';
import { decodeTiff, encodeBmp, encodeGif, encodeIco, encodeTiff, ICO_SIZES } from './image-encoders';

export interface DecodedImage {
  pixels: Pixels;
  format: ImageFormat;
  warnings: string[];
}

export function pixelsToCanvas(px: Pixels, canvas: HTMLCanvasElement = document.createElement('canvas')): HTMLCanvasElement {
  canvas.width = px.width;
  canvas.height = px.height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(px.data as unknown as Uint8ClampedArray<ArrayBuffer>, px.width, px.height), 0, 0);
  return canvas;
}

export function canvasToPixels(canvas: HTMLCanvasElement | OffscreenCanvas): Pixels {
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: img.data, width: img.width, height: img.height };
}

function drawableToPixels(src: CanvasImageSource, width: number, height: number): Pixels {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, width, height);
  return canvasToPixels(canvas);
}

function loadImageElement(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This image could not be decoded.'));
    };
    img.src = url;
  });
}

/** Counts frames in a GIF by scanning for image descriptors (cheap, no full decode). */
function gifFrameCount(bytes: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < bytes.length - 9; i++) {
    // graphic control extension precedes each frame in animated GIFs
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) n++;
    if (n > 1) return n;
  }
  return Math.max(1, n);
}

function isAnimatedWebp(bytes: Uint8Array): boolean {
  // VP8X chunk flag bit 1 = animation
  return bytes.length > 30 && String.fromCharCode(...bytes.subarray(12, 16)) === 'VP8X' && (bytes[20] & 0x02) !== 0;
}

function isApng(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length - 4, 4096);
  for (let i = 8; i < limit; i++) if (bytes[i] === 0x61 && bytes[i + 1] === 0x63 && bytes[i + 2] === 0x54 && bytes[i + 3] === 0x4c) return true; // acTL
  return false;
}

export const MAX_IMAGE_PIXELS = 100_000_000; // ~ 400 MB of RGBA

export async function decodeImage(blob: Blob, name: string): Promise<DecodedImage> {
  const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
  const sniffed = sniffMedia(name, head);
  if (!sniffed || sniffed.kind !== 'image') throw new Error('This file is not a supported image.');
  const format = sniffed.format;
  const warnings: string[] = [];
  let pixels: Pixels;

  switch (format) {
    case 'heic': {
      const { heicTo } = await import('heic-to/csp');
      const bitmap = await heicTo({ blob, type: 'bitmap' });
      pixels = drawableToPixels(bitmap, bitmap.width, bitmap.height);
      bitmap.close();
      break;
    }
    case 'jxl': {
      try {
        const bmp = await createImageBitmap(blob); // native in Safari
        pixels = drawableToPixels(bmp, bmp.width, bmp.height);
        bmp.close();
      } catch {
        const { default: decode } = await import('@jsquash/jxl/decode');
        const img = await decode(await blob.arrayBuffer());
        pixels = { data: img.data, width: img.width, height: img.height };
      }
      break;
    }
    case 'tiff': {
      const t = decodeTiff(new Uint8Array(await blob.arrayBuffer()));
      pixels = { data: t.data, width: t.width, height: t.height };
      if (t.pages > 1) warnings.push(`This TIFF has ${t.pages} pages; the largest one was opened.`);
      break;
    }
    case 'svg': {
      const img = await loadImageElement(new Blob([await blob.arrayBuffer()], { type: 'image/svg+xml' }));
      let w = img.naturalWidth || 1024;
      let h = img.naturalHeight || 1024;
      // rasterise small vector art at a useful size
      const k = Math.max(1, 1024 / Math.max(w, h));
      w = Math.round(w * k);
      h = Math.round(h * k);
      pixels = drawableToPixels(img, w, h);
      warnings.push('The SVG was converted to pixels for editing.');
      break;
    }
    default: {
      try {
        const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
        pixels = drawableToPixels(bmp, bmp.width, bmp.height);
        bmp.close();
      } catch {
        const img = await loadImageElement(blob);
        pixels = drawableToPixels(img, img.naturalWidth, img.naturalHeight);
      }
      const bytes = head;
      if (format === 'gif' && gifFrameCount(new Uint8Array(await blob.arrayBuffer())) > 1) {
        warnings.push('This GIF is animated. Only the first frame is edited here; open it as a video to keep the animation.');
      } else if (format === 'webp' && isAnimatedWebp(bytes)) {
        warnings.push('This WebP is animated. Only the first frame is edited here.');
      } else if (format === 'png' && isApng(bytes)) {
        warnings.push('This PNG is animated (APNG). Only the first frame is edited here.');
      }
    }
  }
  if (pixels.width * pixels.height > MAX_IMAGE_PIXELS) {
    throw new Error(`This image is too large to edit (${pixels.width} × ${pixels.height}). The limit is 100 megapixels.`);
  }
  return { pixels, format, warnings };
}

/** High-quality resize using the canvas, halving repeatedly for big reductions. */
export function resizePixels(px: Pixels, width: number, height: number): Pixels {
  const tw = Math.max(1, Math.round(width));
  const th = Math.max(1, Math.round(height));
  if (tw === px.width && th === px.height) return px;
  let canvas = pixelsToCanvas(px);
  let cw = px.width;
  let ch = px.height;
  while (cw / 2 >= tw && ch / 2 >= th) {
    const next = document.createElement('canvas');
    next.width = Math.round(cw / 2);
    next.height = Math.round(ch / 2);
    const ctx = next.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, next.width, next.height);
    canvas = next;
    cw = next.width;
    ch = next.height;
  }
  const out = document.createElement('canvas');
  out.width = tw;
  out.height = th;
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, tw, th);
  return canvasToPixels(out);
}

/** Rotates by any angle (degrees, clockwise), growing the canvas so nothing is cut off. */
export function rotateArbitrary(px: Pixels, degrees: number, background: string | null): Pixels {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const w = Math.round(px.width * cos + px.height * sin);
  const h = Math.round(px.width * sin + px.height * cos);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.translate(w / 2, h / 2);
  ctx.rotate(rad);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(pixelsToCanvas(px), -px.width / 2, -px.height / 2);
  return canvasToPixels(out);
}

export interface ImageEncodeOptions {
  /** 1..100 for lossy formats */
  quality?: number;
  /** For formats without transparency: the colour transparent areas become. */
  background?: string;
  lossless?: boolean;
}

function hexToRgb(hex: string | undefined): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

async function canvasEncode(px: Pixels, mime: string, quality?: number): Promise<Uint8Array> {
  const canvas = pixelsToCanvas(px);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality === undefined ? undefined : quality / 100));
  if (!blob) throw new Error(`Could not encode ${mime}.`);
  if (blob.type !== mime) throw new Error(`This browser cannot write ${IMAGE_FORMATS[(Object.keys(IMAGE_FORMATS) as ImageFormat[]).find((k) => IMAGE_FORMATS[k].mime === mime) ?? 'png'].label} files. Try PNG or JPEG, or use the desktop app.`);
  return new Uint8Array(await blob.arrayBuffer());
}

function squareIcon(px: Pixels, size: number): Pixels {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const k = Math.min(size / px.width, size / px.height);
  const w = Math.max(1, Math.round(px.width * k));
  const h = Math.max(1, Math.round(px.height * k));
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(pixelsToCanvas(resizePixels(px, w, h)), Math.round((size - w) / 2), Math.round((size - h) / 2));
  return canvasToPixels(canvas);
}

export async function encodeImage(px: Pixels, format: ImageOutputFormat, options: ImageEncodeOptions = {}): Promise<Uint8Array> {
  const q = Math.max(1, Math.min(100, options.quality ?? 90));
  const info = IMAGE_FORMATS[format];
  const source = !info.alpha && hasTransparency(px) ? flatten(px, hexToRgb(options.background)) : px;
  switch (format) {
    case 'png':
      return canvasEncode(source, 'image/png');
    case 'jpeg':
      return canvasEncode(source, 'image/jpeg', q);
    case 'webp':
      return canvasEncode(source, 'image/webp', options.lossless ? 100 : q);
    case 'avif': {
      const { default: encode } = await import('@jsquash/avif/encode');
      const data = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
      // jsquash quality is 0..100 (higher = better) with a speed knob; 6 balances time and size
      const buf = await encode(data, { quality: options.lossless ? 100 : q, speed: 6, lossless: !!options.lossless } as never);
      return new Uint8Array(buf);
    }
    case 'jxl': {
      const { default: encode } = await import('@jsquash/jxl/encode');
      const data = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
      const buf = await encode(data, { quality: options.lossless ? 100 : q, lossless: !!options.lossless, effort: 7 });
      return new Uint8Array(buf);
    }
    case 'gif':
      return encodeGif([{ pixels: source, delay: 0 }]);
    case 'bmp':
      return encodeBmp(source);
    case 'tiff':
      return encodeTiff(source);
    case 'ico': {
      const max = Math.min(256, Math.max(source.width, source.height));
      const sizes = ICO_SIZES.filter((s) => s <= max);
      if (!sizes.length) sizes.push(16);
      const entries = [];
      for (const s of sizes) {
        const png = await canvasEncode(squareIcon(source, s), 'image/png');
        entries.push({ width: s, height: s, png });
      }
      return encodeIco(entries);
    }
  }
}

/** Places the image on a PDF page sized to the image (72 dpi at 100%, capped to A3-ish). */
export async function imageToPdf(px: Pixels, title: string, quality = 90): Promise<Uint8Array> {
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer('File Editor');
  const opaque = !hasTransparency(px);
  const bytes = opaque ? await canvasEncode(px, 'image/jpeg', quality) : await canvasEncode(px, 'image/png');
  const img = opaque ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  // treat the image as 150 dpi so phone photos land on a sensible page size
  let w = (px.width * 72) / 150;
  let h = (px.height * 72) / 150;
  const k = Math.min(1, 1190 / Math.max(w, h));
  w *= k;
  h *= k;
  const page = doc.addPage([w, h]);
  page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  return doc.save();
}

export function blankPixels(width: number, height: number, color = '#ffffff'): Pixels {
  const px = createPixels(width, height);
  const [r, g, b] = hexToRgb(color);
  for (let i = 0; i < px.data.length; i += 4) {
    px.data[i] = r;
    px.data[i + 1] = g;
    px.data[i + 2] = b;
    px.data[i + 3] = 255;
  }
  return px;
}
