/**
 * Photoshop (.psd) ⇄ layered document, via ag-psd (MIT). Raw pixel data only (no canvas), so
 * this also runs in tests.
 *
 * Read: every pixel layer with its position, opacity, blend mode, visibility, name and layer
 * mask; groups are flattened into the layer list (their visibility and opacity carry down);
 * common adjustment layers (Brightness/Contrast, Levels, Curves, Exposure, Vibrance,
 * Hue/Saturation, Color Balance, Black & White, Photo Filter, Invert, Posterize, Threshold)
 * stay live adjustment layers. Text layers come in as their rendered pixels.
 * Write: the same, with text/shape/fill layers rasterized (via a callback) and a flattened
 * composite for apps that only read that.
 */
import { readPsd, writePsd, type AdjustmentLayer, type Layer as PsdLayer, type Psd } from 'ag-psd';
import type { Pixels } from '../media/image-ops';
import { defaultAdjust, type AdjustSpec } from './adjust';
import { BLEND_MODES, adjustLayer, blendFromPsd, layerId, rasterLayer, type Layer, type ProDocument } from './document';
import { emptyMask, type Mask } from './selection';

type PixelData = { data: ArrayLike<number>; width: number; height: number };

function toPixels(img: PixelData | undefined): Pixels | null {
  if (!img || !img.width || !img.height) return null;
  const n = img.width * img.height * 4;
  const out = new Uint8ClampedArray(n);
  const src = img.data;
  // 16-bit / 32-bit documents come in as wider samples
  if (src instanceof Uint16Array) for (let i = 0; i < n; i++) out[i] = src[i] >> 8;
  else if (src instanceof Float32Array) for (let i = 0; i < n; i++) out[i] = Math.round(src[i] * 255);
  else out.set(src as ArrayLike<number>);
  return { data: out, width: img.width, height: img.height };
}

function readMask(l: PsdLayer, doc: { width: number; height: number }): Mask | null {
  const m = l.mask;
  if (!m || !m.imageData) return null;
  const px = toPixels(m.imageData as PixelData);
  const out = emptyMask(doc.width, doc.height);
  out.data.fill(m.defaultColor ?? 0);
  if (!px) return out;
  const left = m.left ?? 0;
  const top = m.top ?? 0;
  for (let y = 0; y < px.height; y++) {
    const dy = y + top;
    if (dy < 0 || dy >= doc.height) continue;
    for (let x = 0; x < px.width; x++) {
      const dx = x + left;
      if (dx < 0 || dx >= doc.width) continue;
      // mask image data is greyscale in the red channel
      out.data[dy * doc.width + dx] = px.data[(y * px.width + x) * 4];
    }
  }
  return out;
}

const rgbOf = (c: unknown): [number, number, number] => {
  const o = (c ?? {}) as { r?: number; g?: number; b?: number };
  return [o.r ?? 0, o.g ?? 0, o.b ?? 0];
};
const hex = ([r, g, b]: [number, number, number]) => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

function adjustFromPsd(a: AdjustmentLayer): AdjustSpec | null {
  switch (a.type) {
    case 'brightness/contrast':
      return { type: 'brightnessContrast', brightness: a.brightness ?? 0, contrast: a.contrast ?? 0 };
    case 'levels': {
      const c = a.channels?.[0];
      if (!c) return defaultAdjust('levels');
      const g = c.midtoneInput > 10 ? c.midtoneInput / 100 : c.midtoneInput || 1;
      return { type: 'levels', inBlack: c.shadowInput, inWhite: c.highlightInput, gamma: g, outBlack: c.shadowOutput, outWhite: c.highlightOutput };
    }
    case 'curves': {
      const ch = (i: number) => (a.channels?.[i]?.length ? a.channels[i].map((p) => [p.input, p.output] as [number, number]) : defaultAdjust('curves').type === 'curves' ? ([[0, 0], [255, 255]] as [number, number][]) : []);
      return { type: 'curves', rgb: ch(0), r: ch(1), g: ch(2), b: ch(3) };
    }
    case 'exposure':
      return { type: 'exposure', exposure: a.exposure ?? 0, offset: a.offset ?? 0, gamma: a.gamma ?? 1 };
    case 'vibrance':
      return { type: 'vibrance', vibrance: a.vibrance ?? 0, saturation: a.saturation ?? 0 };
    case 'hue/saturation':
      if (a.colorize && a.colorization) return { type: 'hueSat', hue: a.colorization.hue, saturation: a.colorization.saturation, lightness: a.colorization.lightness, colorize: true };
      return { type: 'hueSat', hue: a.master?.hue ?? 0, saturation: a.master?.saturation ?? 0, lightness: a.master?.lightness ?? 0, colorize: false };
    case 'color balance': {
      const v = (x?: { cyanRed: number; magentaGreen: number; yellowBlue: number }): [number, number, number] => [x?.cyanRed ?? 0, x?.magentaGreen ?? 0, x?.yellowBlue ?? 0];
      return { type: 'colorBalance', shadows: v(a.shadows), midtones: v(a.midtones), highlights: v(a.highlights), preserveLuminosity: a.preserveLuminosity ?? true };
    }
    case 'black & white':
      return { type: 'blackWhite', red: a.reds ?? 40, green: a.greens ?? 40, blue: a.blues ?? 20, tint: a.useTint && a.tintColor ? hex(rgbOf(a.tintColor)) : null };
    case 'photo filter':
      return { type: 'photoFilter', color: a.color ? hex(rgbOf(a.color)) : '#ec8a00', density: a.density ?? 25 };
    case 'invert':
      return { type: 'invert' };
    case 'posterize':
      return { type: 'posterize', levels: a.levels ?? 4 };
    case 'threshold':
      return { type: 'threshold', level: a.level ?? 128 };
    default:
      return null;
  }
}

function adjustToPsd(s: AdjustSpec): AdjustmentLayer {
  const rgb = (h: string) => {
    const n = parseInt(h.slice(1), 16) || 0;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };
  switch (s.type) {
    case 'brightnessContrast':
      return { type: 'brightness/contrast', brightness: s.brightness, contrast: s.contrast, useLegacy: false };
    case 'levels':
      return {
        type: 'levels',
        channels: [{ shadowInput: s.inBlack, highlightInput: s.inWhite, shadowOutput: s.outBlack, highlightOutput: s.outWhite, midtoneInput: s.gamma }],
      };
    case 'curves':
      return { type: 'curves', channels: [s.rgb, s.r, s.g, s.b].map((pts) => pts.map(([input, output]) => ({ input, output }))) };
    case 'exposure':
      return { type: 'exposure', exposure: s.exposure, offset: s.offset, gamma: s.gamma };
    case 'vibrance':
      return { type: 'vibrance', vibrance: s.vibrance, saturation: s.saturation };
    case 'hueSat':
      return s.colorize
        ? { type: 'hue/saturation', colorize: true, colorization: { hue: s.hue, saturation: s.saturation, lightness: s.lightness }, master: { hue: 0, saturation: 0, lightness: 0 } }
        : { type: 'hue/saturation', colorize: false, master: { hue: s.hue, saturation: s.saturation, lightness: s.lightness } };
    case 'colorBalance': {
      const v = (x: [number, number, number]) => ({ cyanRed: x[0], magentaGreen: x[1], yellowBlue: x[2] });
      return { type: 'color balance', shadows: v(s.shadows), midtones: v(s.midtones), highlights: v(s.highlights), preserveLuminosity: s.preserveLuminosity };
    }
    case 'blackWhite':
      return { type: 'black & white', reds: s.red, greens: s.green, blues: s.blue, yellows: (s.red + s.green) / 2, cyans: (s.green + s.blue) / 2, magentas: (s.red + s.blue) / 2, useTint: !!s.tint, tintColor: s.tint ? rgb(s.tint) : { r: 225, g: 211, b: 179 } };
    case 'photoFilter':
      return { type: 'photo filter', color: rgb(s.color), density: s.density, preserveLuminosity: true };
    case 'invert':
      return { type: 'invert' };
    case 'posterize':
      return { type: 'posterize', levels: s.levels };
    case 'threshold':
      return { type: 'threshold', level: s.level };
  }
}

export interface PsdReadResult {
  doc: ProDocument;
  warnings: string[];
}

export function readPsdDocument(bytes: Uint8Array): PsdReadResult {
  let psd: Psd;
  try {
    psd = readPsd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
      useImageData: true,
      skipThumbnail: true,
      skipLinkedFilesData: true,
    });
  } catch (err) {
    throw new Error(`This Photoshop file could not be read (${err instanceof Error ? err.message : 'unknown error'}).`);
  }
  const doc: ProDocument = { width: psd.width, height: psd.height, layers: [] };
  const warnings = new Set<string>();
  const walk = (layers: PsdLayer[], hidden: boolean, opacity: number) => {
    for (const l of layers) {
      const vis = !hidden && !l.hidden;
      const op = opacity * (l.opacity ?? 1);
      if (l.children) {
        warnings.add('Layer groups (their layers are listed individually)');
        walk(l.children, !vis, op);
        continue;
      }
      if (l.adjustment) {
        const spec = adjustFromPsd(l.adjustment);
        if (!spec) {
          warnings.add(`${l.adjustment.type} adjustment layers`);
          continue;
        }
        const a = adjustLayer(spec.type, l.name ?? 'Adjustment');
        a.adjust = spec;
        a.visible = vis;
        a.opacity = op;
        a.blend = blendFromPsd(l.blendMode);
        a.mask = readMask(l, doc);
        doc.layers.push(a);
        continue;
      }
      const px = toPixels(l.imageData as PixelData | undefined);
      if (!px) {
        if (l.text) warnings.add('Empty text layers');
        continue;
      }
      if (l.text) warnings.add('Text layers (kept as pixels)');
      if (l.effects) warnings.add('Layer styles (shadows, strokes…)');
      const r = rasterLayer(l.name ?? 'Layer', px, l.left ?? 0, l.top ?? 0);
      r.visible = vis;
      r.opacity = op;
      r.blend = blendFromPsd(l.blendMode);
      r.mask = readMask(l, doc);
      if (l.mask?.disabled) r.maskEnabled = false;
      doc.layers.push(r);
    }
  };
  walk(psd.children ?? [], false, 1);
  // a flat PSD (no layers) only has the composite image
  if (!doc.layers.length) {
    const px = toPixels(psd.imageData as PixelData | undefined);
    if (!px) throw new Error('This Photoshop file has no image data.');
    doc.layers.push(rasterLayer('Background', px));
  }
  return { doc, warnings: [...warnings] };
}

export function writePsdDocument(doc: ProDocument, composite: Pixels, rasterize: (l: Layer) => Pixels): Uint8Array {
  const children: PsdLayer[] = doc.layers.map((l) => {
    const base: PsdLayer = {
      name: l.name,
      hidden: !l.visible,
      opacity: l.opacity,
      blendMode: (BLEND_MODES.find((b) => b.id === l.blend)?.psd ?? 'normal') as PsdLayer['blendMode'],
    };
    if (l.mask) {
      const img = new Uint8ClampedArray(l.mask.width * l.mask.height * 4);
      for (let i = 0; i < l.mask.data.length; i++) {
        img[i * 4] = img[i * 4 + 1] = img[i * 4 + 2] = l.mask.data[i];
        img[i * 4 + 3] = 255;
      }
      base.mask = { left: 0, top: 0, right: l.mask.width, bottom: l.mask.height, defaultColor: 0, disabled: !l.maskEnabled, imageData: { data: img, width: l.mask.width, height: l.mask.height } };
    }
    if (l.kind === 'adjust') return { ...base, adjustment: adjustToPsd(l.adjust) };
    const px = l.kind === 'raster' ? l.px : rasterize(l);
    const left = l.kind === 'raster' ? l.x : 0;
    const top = l.kind === 'raster' ? l.y : 0;
    return { ...base, left, top, right: left + px.width, bottom: top + px.height, imageData: { data: px.data, width: px.width, height: px.height } };
  });
  const psd: Psd = { width: doc.width, height: doc.height, children, imageData: { data: composite.data, width: composite.width, height: composite.height } };
  const buf = writePsd(psd, { generateThumbnail: false, noBackground: true });
  return new Uint8Array(buf);
}

export { layerId };
