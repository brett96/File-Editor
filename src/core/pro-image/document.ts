/**
 * Layered document for the pro photo editor (desktop app only).
 *
 * Layers are immutable values: an edit replaces a layer object (and copies the pixels it
 * changes), so undo history shares every untouched buffer. Raster layers keep their own
 * pixels at an offset in the document; masks are document-sized (0–255, 255 = shown).
 * Rendering lives in src/ui/pro-image/render.ts (canvas blend modes on the GPU).
 */
import { createPixels, type Pixels } from '../media/image-ops';
import { defaultAdjust, type AdjustSpec, type AdjustType } from './adjust';
import type { Mask } from './selection';

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

/** Blend modes as the editor lists them; `canvas` is the 2D-canvas composite operation, `psd` Photoshop's name. */
export const BLEND_MODES: { id: BlendMode; label: string; canvas: GlobalCompositeOperation; psd: string }[] = [
  { id: 'normal', label: 'Normal', canvas: 'source-over', psd: 'normal' },
  { id: 'darken', label: 'Darken', canvas: 'darken', psd: 'darken' },
  { id: 'multiply', label: 'Multiply', canvas: 'multiply', psd: 'multiply' },
  { id: 'color-burn', label: 'Color Burn', canvas: 'color-burn', psd: 'color burn' },
  { id: 'lighten', label: 'Lighten', canvas: 'lighten', psd: 'lighten' },
  { id: 'screen', label: 'Screen', canvas: 'screen', psd: 'screen' },
  { id: 'color-dodge', label: 'Color Dodge', canvas: 'color-dodge', psd: 'color dodge' },
  { id: 'overlay', label: 'Overlay', canvas: 'overlay', psd: 'overlay' },
  { id: 'soft-light', label: 'Soft Light', canvas: 'soft-light', psd: 'soft light' },
  { id: 'hard-light', label: 'Hard Light', canvas: 'hard-light', psd: 'hard light' },
  { id: 'difference', label: 'Difference', canvas: 'difference', psd: 'difference' },
  { id: 'exclusion', label: 'Exclusion', canvas: 'exclusion', psd: 'exclusion' },
  { id: 'hue', label: 'Hue', canvas: 'hue', psd: 'hue' },
  { id: 'saturation', label: 'Saturation', canvas: 'saturation', psd: 'saturation' },
  { id: 'color', label: 'Color', canvas: 'color', psd: 'color' },
  { id: 'luminosity', label: 'Luminosity', canvas: 'luminosity', psd: 'luminosity' },
];

export function blendFromPsd(name: string | undefined): BlendMode {
  return BLEND_MODES.find((b) => b.psd === name)?.id ?? 'normal';
}

interface LayerBase {
  id: string;
  name: string;
  visible: boolean;
  /** 0–1 */
  opacity: number;
  blend: BlendMode;
  locked: boolean;
  mask: Mask | null;
  maskEnabled: boolean;
}

export interface RasterLayer extends LayerBase {
  kind: 'raster';
  px: Pixels;
  x: number;
  y: number;
}

export interface TextLayer extends LayerBase {
  kind: 'text';
  text: string;
  x: number;
  y: number;
  font: string;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  /** outline stroke in px (0 = none) */
  stroke: number;
  strokeColor: string;
  shadow: boolean;
}

export interface ShapeLayer extends LayerBase {
  kind: 'shape';
  shape: 'rect' | 'ellipse';
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  /** corner radius for rectangles */
  radius: number;
}

export interface FillLayer extends LayerBase {
  kind: 'fill';
  fill: { type: 'solid'; color: string } | { type: 'gradient'; from: string; to: string; angle: number; radial: boolean };
}

export interface AdjustLayer extends LayerBase {
  kind: 'adjust';
  adjust: AdjustSpec;
}

export type Layer = RasterLayer | TextLayer | ShapeLayer | FillLayer | AdjustLayer;

export interface ProDocument {
  width: number;
  height: number;
  /** bottom → top */
  layers: Layer[];
}

let counter = 0;
export const layerId = () => `L${Date.now().toString(36)}${(counter++).toString(36)}`;

const base = (name: string): LayerBase => ({ id: layerId(), name, visible: true, opacity: 1, blend: 'normal', locked: false, mask: null, maskEnabled: true });

export function rasterLayer(name: string, px: Pixels, x = 0, y = 0): RasterLayer {
  return { ...base(name), kind: 'raster', px, x, y };
}

export function emptyRaster(name: string, width: number, height: number): RasterLayer {
  return rasterLayer(name, createPixels(width, height));
}

export function textLayer(name: string, x: number, y: number, text: string, size: number, color: string): TextLayer {
  return {
    ...base(name),
    kind: 'text',
    text,
    x,
    y,
    font: 'system-ui, "Segoe UI", Arial, sans-serif',
    size,
    color,
    bold: false,
    italic: false,
    align: 'left',
    stroke: 0,
    strokeColor: '#000000',
    shadow: false,
  };
}

export function shapeLayer(name: string, shape: 'rect' | 'ellipse', x: number, y: number, width: number, height: number, fill: string): ShapeLayer {
  return { ...base(name), kind: 'shape', shape, x, y, width, height, fill, stroke: null, strokeWidth: 0, radius: 0 };
}

export function fillLayer(name: string, color: string): FillLayer {
  return { ...base(name), kind: 'fill', fill: { type: 'solid', color } };
}

export function adjustLayer(type: AdjustType, label: string): AdjustLayer {
  return { ...base(label), kind: 'adjust', adjust: defaultAdjust(type) };
}

export function newDocument(px: Pixels, name = 'Background'): ProDocument {
  return { width: px.width, height: px.height, layers: [rasterLayer(name, px)] };
}

export function clonePixels(px: Pixels): Pixels {
  return { data: new Uint8ClampedArray(px.data), width: px.width, height: px.height };
}

export function cloneMask(m: Mask): Mask {
  return { data: new Uint8Array(m.data), width: m.width, height: m.height };
}

/** Deep copy of a layer with a new id (Duplicate Layer). */
export function duplicateLayer(l: Layer): Layer {
  const copy = { ...l, id: layerId(), name: `${l.name} copy`, mask: l.mask ? cloneMask(l.mask) : null } as Layer;
  if (copy.kind === 'raster') copy.px = clonePixels((l as RasterLayer).px);
  return copy;
}

export function replaceLayer(doc: ProDocument, layer: Layer): ProDocument {
  return { ...doc, layers: doc.layers.map((l) => (l.id === layer.id ? layer : l)) };
}

export function moveLayer(doc: ProDocument, id: string, delta: number): ProDocument {
  const i = doc.layers.findIndex((l) => l.id === id);
  const j = Math.max(0, Math.min(doc.layers.length - 1, i + delta));
  if (i < 0 || i === j) return doc;
  const layers = [...doc.layers];
  const [l] = layers.splice(i, 1);
  layers.splice(j, 0, l);
  return { ...doc, layers };
}

/** Layer pixels as a document-sized buffer (raster layers only). */
export function rasterToDocSize(doc: Pick<ProDocument, 'width' | 'height'>, l: RasterLayer): Pixels {
  if (l.x === 0 && l.y === 0 && l.px.width === doc.width && l.px.height === doc.height) return l.px;
  const out = createPixels(doc.width, doc.height);
  for (let y = 0; y < l.px.height; y++) {
    const dy = y + l.y;
    if (dy < 0 || dy >= doc.height) continue;
    const x0 = Math.max(0, -l.x);
    const x1 = Math.min(l.px.width, doc.width - l.x);
    if (x1 <= x0) continue;
    out.data.set(l.px.data.subarray((y * l.px.width + x0) * 4, (y * l.px.width + x1) * 4), (dy * doc.width + x0 + l.x) * 4);
  }
  return out;
}

/** Size of the history entry for memory accounting (shared buffers are counted once by the caller). */
export function layerBytes(l: Layer): number {
  return (l.kind === 'raster' ? l.px.data.byteLength : 0) + (l.mask ? l.mask.data.byteLength : 0);
}
