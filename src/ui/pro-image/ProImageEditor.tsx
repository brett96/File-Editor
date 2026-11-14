/**
 * Pro photo editor (desktop app only): a layered, Photoshop-style workspace.
 *
 *   Layers     pixel, text, shape, fill and adjustment layers; opacity, 16 blend modes,
 *              visibility, lock, layer masks (paint on them), merge, flatten, rasterize
 *   Adjust     non-destructive adjustment layers: Curves, Levels, Hue/Saturation, Color
 *              Balance, Black & White, Exposure, Brightness/Contrast, Vibrance, Invert,
 *              Threshold, Posterize, Photo Filter
 *   Select     rectangle, ellipse, lasso, magic wand (add / subtract / intersect), invert,
 *              feather, load layer transparency; every edit respects the selection
 *   Paint      brush, eraser, clone stamp, spot healing, dodge, burn, paint bucket,
 *              gradient, eyedropper; size / hardness / opacity
 *   Filters    Gaussian Blur, Unsharp Mask, Add Noise, Reduce Noise, Motion Blur, Emboss,
 *              Find Edges
 *   Image      Image Size, Canvas Size, rotate, flip, crop to selection, free transform
 *   Files      opens and saves layered Photoshop (.psd) files; Save As exports a flat image
 *
 * The document model and pixel maths are in src/core/pro-image; compositing in ./render.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTabActive } from '../tab-active';
import {
  Brush as BrushIcon,
  Circle,
  Droplet,
  Eraser,
  Hand,
  Lasso,

  Move,
  PaintBucket,
  Pipette,
  Redo2,
  Square,
  SquareDashed,
  Stamp,
  Sun,
  Moon,
  Sparkles,
  Type,
  Undo2,
  Wand2,
  ZoomIn,
  ZoomOut,
  Blend,
  CircleDashed,
  WandSparkles,
  Bandage,
  Columns2,
  Rows2,
} from 'lucide-react';
import type { Pixels } from '../../core/media/image-ops';
import { ADJUST_LABELS, type AdjustType } from '../../core/pro-image/adjust';
import { openGuide } from '../help/open';
import {
  adjustLayer,
  clonePixels,
  cloneMask,
  duplicateLayer,
  emptyRaster,
  fillLayer,
  moveLayer,
  rasterLayer,
  rasterToDocSize,
  replaceLayer,
  shapeLayer,
  textLayer,
  type Layer,
  type ProDocument,
  type RasterLayer,
} from '../../core/pro-image/document';
import { FILTER_DEFS, runFilter, spotHeal, type FilterId } from '../../core/pro-image/filters';
import { contentAwareFill, dilateMask, expandToShadows, patchClone } from '../../core/pro-image/inpaint';
import { dab, maskDab, strokePoints, type Brush, type DabMode } from '../../core/pro-image/paint';
import { writePsdDocument } from '../../core/pro-image/psd';
import {
  combineMasks,
  ellipseMask,
  emptyMask,
  featherMask,
  fullMask,
  invertMask,
  isEmptyMask,
  magicWand,
  maskBounds,
  maskOutline,
  polygonMask,
  rectMask,
  type CombineMode,
  type Mask,
} from '../../core/pro-image/selection';
import { Field, Modal, MenuItem, Popover, cx } from '../components';
import { LayersPanel, PropertiesPanel, Slider } from './panels';
import { bakeForPsd, bucketFill, canvasToPixels, clearSelection, copySelection, cropToSelection, fillRaster, flattenDocument, flipImage, mergeDown, rasterize, resizeCanvas, resizeImage, rotateImage, transformLayer } from './ops';
import { composite, flatten, invalidateLayer, invalidateMask, pixelsCanvas, rasterizeLayer, textBox } from './render';
import './pro-image.css';

export interface ProImageEditorHandle {
  /** Flattened pixels (Save As image formats). */
  getPixels(): Pixels;
  /** Layered Photoshop file. */
  getPsd(): Uint8Array;
  getDocument(): ProDocument;
}

interface Props {
  initial: ProDocument;
  onChange: () => void;
  onError: (message: string) => void;
  onStatus?: (s: { width: number; height: number; zoom: number }) => void;
}

type Tool =
  | 'move'
  | 'marquee'
  | 'ellipse-marquee'
  | 'lasso'
  | 'wand'
  | 'brush'
  | 'eraser'
  | 'clone'
  | 'heal'
  | 'remove'
  | 'patch'
  | 'dodge'
  | 'burn'
  | 'bucket'
  | 'gradient'
  | 'text'
  | 'shape'
  | 'eyedropper'
  | 'hand';

const TOOLS: { id: Tool; label: string; key: string; icon: ReactNode }[] = [
  { id: 'move', label: 'Move', key: 'V', icon: <Move size={17} /> },
  { id: 'marquee', label: 'Rectangular Marquee', key: 'M', icon: <SquareDashed size={17} /> },
  { id: 'ellipse-marquee', label: 'Elliptical Marquee', key: 'M', icon: <CircleDashed size={17} /> },
  { id: 'lasso', label: 'Lasso', key: 'L', icon: <Lasso size={17} /> },
  { id: 'wand', label: 'Magic Wand', key: 'W', icon: <Wand2 size={17} /> },
  { id: 'brush', label: 'Brush', key: 'B', icon: <BrushIcon size={17} /> },
  { id: 'eraser', label: 'Eraser', key: 'E', icon: <Eraser size={17} /> },
  { id: 'clone', label: 'Clone Stamp (Alt-click to set the source)', key: 'S', icon: <Stamp size={17} /> },
  { id: 'heal', label: 'Spot Healing Brush', key: 'J', icon: <Sparkles size={17} /> },
  { id: 'remove', label: 'Remove (paint over an object to erase it)', key: 'J', icon: <WandSparkles size={17} /> },
  { id: 'patch', label: 'Patch (circle a flaw, then drag it onto clean texture)', key: 'J', icon: <Bandage size={17} /> },
  { id: 'dodge', label: 'Dodge', key: 'O', icon: <Sun size={17} /> },
  { id: 'burn', label: 'Burn', key: 'O', icon: <Moon size={17} /> },
  { id: 'bucket', label: 'Paint Bucket', key: 'G', icon: <PaintBucket size={17} /> },
  { id: 'gradient', label: 'Gradient', key: 'G', icon: <Blend size={17} /> },
  { id: 'text', label: 'Type', key: 'T', icon: <Type size={17} /> },
  { id: 'shape', label: 'Shape', key: 'U', icon: <Square size={17} /> },
  { id: 'eyedropper', label: 'Eyedropper', key: 'I', icon: <Pipette size={17} /> },
  { id: 'hand', label: 'Hand', key: 'H', icon: <Hand size={17} /> },
];

/** Tools that share one place in the tool rail; hovering it reveals the others. */
const TOOL_GROUPS: Tool[][] = [
  ['move'],
  ['marquee', 'ellipse-marquee'],
  ['lasso', 'wand'],
  ['brush', 'eraser'],
  ['clone'],
  ['heal', 'remove', 'patch'],
  ['dodge', 'burn'],
  ['bucket', 'gradient'],
  ['text'],
  ['shape'],
  ['eyedropper'],
  ['hand'],
];

type Compare = 'off' | 'side' | 'stack';

const THEMES = [
  { id: 'graphite', label: 'Graphite (default)' },
  { id: 'midnight', label: 'Midnight (darker, high contrast)' },
  { id: 'light', label: 'Light' },
] as const;
type ThemeId = (typeof THEMES)[number]['id'];
const ACCENTS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#ef4444'];
const LOOK_KEY = 'file-editor.pro-photo.look';

function loadLook(): { theme: ThemeId; accent: string } {
  try {
    const v = JSON.parse(localStorage.getItem(LOOK_KEY) ?? 'null') as { theme?: string; accent?: string } | null;
    return { theme: THEMES.some((t) => t.id === v?.theme) ? (v!.theme as ThemeId) : 'graphite', accent: /^#[0-9a-f]{6}$/i.test(v?.accent ?? '') ? v!.accent! : ACCENTS[0] };
  } catch {
    return { theme: 'graphite', accent: ACCENTS[0] };
  }
}

const PAINT_TOOLS: Tool[] = ['brush', 'eraser', 'clone', 'heal', 'remove', 'dodge', 'burn'];
const RASTER_TOOLS: Tool[] = [...PAINT_TOOLS, 'bucket', 'gradient'];
const ADJUST_ORDER: AdjustType[] = ['brightnessContrast', 'levels', 'curves', 'exposure', 'vibrance', 'hueSat', 'colorBalance', 'blackWhite', 'photoFilter', 'clarity', 'dehaze', 'grain', 'lut', 'invert', 'posterize', 'threshold'];
const MAX_HISTORY = 40;
const MAX_RENDER_SIDE = 4096;

interface Snapshot {
  doc: ProDocument;
  activeId: string | null;
  selection: Mask | null;
}

let clipboard: RasterLayer | null = null;

const hexToRgb = (h: string): [number, number, number] => {
  const n = parseInt(h.replace('#', ''), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const luma = (h: string) => {
  const [r, g, b] = hexToRgb(h);
  return Math.round(r * 0.299 + g * 0.587 + b * 0.114);
};

export const ProImageEditor = forwardRef<ProImageEditorHandle, Props>(function ProImageEditor({ initial, onChange, onError, onStatus }, ref) {
  const [doc, setDocState] = useState<ProDocument>(initial);
  const docRef = useRef(doc);
  const [activeId, setActiveId] = useState<string | null>(initial.layers[initial.layers.length - 1]?.id ?? null);
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const [selection, setSelectionState] = useState<Mask | null>(null);
  const selRef = useRef(selection);
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const [, bump] = useState(0);

  const [tool, setTool] = useState<Tool>('move');
  const [brush, setBrush] = useState<Brush>({ size: 40, hardness: 0.6, opacity: 1 });
  const [fg, setFg] = useState('#000000');
  const [bg, setBg] = useState('#ffffff');
  const [tolerance, setTolerance] = useState(32);
  const [contiguous, setContiguous] = useState(true);
  const [sampleAll, setSampleAll] = useState(false);
  const [selMode, setSelMode] = useState<CombineMode>('replace');
  const [featherPx, setFeatherPx] = useState(0);
  const [exposure, setExposure] = useState(30);
  const [radialGradient, setRadialGradient] = useState(false);
  const [shapeKind, setShapeKind] = useState<'rect' | 'ellipse'>('rect');
  const [maskEdit, setMaskEdit] = useState(false);
  const [removeShadows, setRemoveShadows] = useState(true);
  // before / after comparison: the picture as it was opened on one side of a divider
  const [compare, setCompare] = useState<Compare>('off');
  const [split, setSplit] = useState(0.5);
  const compareRef = useRef({ mode: compare, split });
  compareRef.current = { mode: compare, split };
  const beforeCache = useRef<HTMLCanvasElement | null>(null);
  const [look, setLook] = useState(loadLook);
  useEffect(() => {
    try {
      localStorage.setItem(LOOK_KEY, JSON.stringify(look));
    } catch {
      // private mode: the look just isn't remembered
    }
  }, [look]);
  /** the tool last used from each group is the one its rail button shows */
  const [groupTool, setGroupTool] = useState<Record<number, Tool>>({});
  const [cloneSrc, setCloneSrc] = useState<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [dialog, setDialog] = useState<null | { kind: 'filter'; id: FilterId } | { kind: 'imageSize' } | { kind: 'canvasSize' } | { kind: 'transform' } | { kind: 'feather' }>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const scroller = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const frame = useRef(0);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const spaceDown = useRef(false);

  const setDoc = useCallback((d: ProDocument) => {
    docRef.current = d;
    setDocState(d);
  }, []);
  const setSelection = useCallback((m: Mask | null) => {
    const next = m && !isEmptyMask(m) ? m : null;
    selRef.current = next;
    setSelectionState(next);
  }, []);

  const active = doc.layers.find((l) => l.id === activeId) ?? null;

  // ── history ──────────────────────────────────────────────────────────────
  const snapshot = (): Snapshot => ({ doc: docRef.current, activeId: activeRef.current, selection: selRef.current });
  const pushHistory = useCallback(() => {
    past.current.push(snapshot());
    if (past.current.length > MAX_HISTORY) past.current.shift();
    future.current = [];
    bump((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const restore = (s: Snapshot) => {
    setDoc(s.doc);
    setActiveId(s.activeId);
    setSelection(s.selection);
    for (const l of s.doc.layers) invalidateLayer(l);
  };
  const undo = useCallback(() => {
    const s = past.current.pop();
    if (!s) return;
    future.current.push(snapshot());
    restore(s);
    onChange();
    bump((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onChange]);
  const redo = useCallback(() => {
    const s = future.current.pop();
    if (!s) return;
    past.current.push(snapshot());
    restore(s);
    onChange();
    bump((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onChange]);

  /** Replace the document as one undoable step. */
  const commit = useCallback(
    (d: ProDocument, nextActive?: string | null) => {
      pushHistory();
      setDoc(d);
      if (nextActive !== undefined) setActiveId(nextActive);
      onChange();
    },
    [onChange, pushHistory, setDoc],
  );

  // ── rendering ───────────────────────────────────────────────────────────
  const renderScale = useCallback(() => {
    const d = docRef.current;
    const dpr = window.devicePixelRatio || 1;
    return Math.min(MAX_RENDER_SIDE / Math.max(d.width, d.height), Math.min(1, zoom * dpr));
  }, [zoom]);

  const drawOverlay = useCallback(() => {
    const o = overlay.current;
    if (!o) return;
    const d = docRef.current;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(d.width * zoom * dpr);
    const h = Math.round(d.height * zoom * dpr);
    if (o.width !== w || o.height !== h) {
      o.width = w;
      o.height = h;
    }
    const ctx = o.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    const k = zoom * dpr;
    const sel = selRef.current;
    if (sel) {
      // selection edge: black/white dashes via the outline pixels
      const outline = outlineCache.current?.mask === sel ? outlineCache.current.canvas : null;
      let c = outline;
      if (!c) {
        const edge = maskOutline(sel);
        c = document.createElement('canvas');
        c.width = sel.width;
        c.height = sel.height;
        const img = new ImageData(sel.width, sel.height);
        for (let i = 0; i < edge.length; i++) {
          if (!edge[i]) continue;
          const x = i % sel.width;
          const y = (i / sel.width) | 0;
          const black = ((x + y) >> 2) % 2 === 0;
          img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = black ? 0 : 255;
          img.data[i * 4 + 3] = 255;
        }
        c.getContext('2d')!.putImageData(img, 0, 0);
        outlineCache.current = { mask: sel, canvas: c };
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(c, 0, 0, w, h);
    }
    const g = gesture.current;
    ctx.lineWidth = Math.max(1, dpr);
    if (g && (g.kind === 'marquee' || g.kind === 'shape')) {
      const x = Math.min(g.x0, g.x1) * k;
      const y = Math.min(g.y0, g.y1) * k;
      const gw = Math.abs(g.x1 - g.x0) * k;
      const gh = Math.abs(g.y1 - g.y0) * k;
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.strokeStyle = '#000';
      ctx.beginPath();
      if (g.ellipse) ctx.ellipse(x + gw / 2, y + gh / 2, gw / 2, gh / 2, 0, 0, Math.PI * 2);
      else ctx.rect(x, y, gw, gh);
      ctx.stroke();
      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = 5 * dpr;
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (g && g.kind === 'lasso' && g.points.length > 1) {
      ctx.strokeStyle = '#fff';
      ctx.setLineDash([4 * dpr, 3 * dpr]);
      ctx.beginPath();
      g.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k)));
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (g && g.kind === 'gradient') {
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(g.x0 * k, g.y0 * k);
      ctx.lineTo(g.x1 * k, g.y1 * k);
      ctx.stroke();
    } else if (g && g.kind === 'patch') {
      const edge = outlineCache.current?.canvas;
      const ox = (g.x1 - g.x0) * k;
      const oy = (g.y1 - g.y0) * k;
      // where the texture will be taken from
      if (edge) {
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(edge, ox, oy, w, h);
        ctx.restore();
      }
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(g.x0 * k, g.y0 * k);
      ctx.lineTo(g.x1 * k, g.y1 * k);
      ctx.stroke();
    } else if (g && g.kind === 'heal') {
      const c = document.createElement('canvas');
      c.width = g.mask.width;
      c.height = g.mask.height;
      const img = new ImageData(c.width, c.height);
      for (let i = 0; i < g.mask.data.length; i++) {
        if (!g.mask.data[i]) continue;
        img.data[i * 4] = 255;
        img.data[i * 4 + 1] = 40;
        img.data[i * 4 + 2] = 40;
        img.data[i * 4 + 3] = g.mask.data[i] * 0.45;
      }
      c.getContext('2d')!.putImageData(img, 0, 0);
      ctx.drawImage(c, 0, 0, w, h);
    }
    const cmp = compareRef.current;
    if (cmp.mode !== 'off') {
      const side = cmp.mode === 'side';
      const at = side ? w * cmp.split : h * cmp.split;
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2 * dpr;
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 4 * dpr;
      ctx.beginPath();
      if (side) {
        ctx.moveTo(at, 0);
        ctx.lineTo(at, h);
      } else {
        ctx.moveTo(0, at);
        ctx.lineTo(w, at);
      }
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(side ? at : w / 2, side ? h / 2 : at, 7 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.font = `600 ${11 * dpr}px system-ui, sans-serif`;
      const label = (text: string, x: number, y: number, align: CanvasTextAlign) => {
        ctx.textAlign = align;
        const tw = ctx.measureText(text).width + 10 * dpr;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(align === 'right' ? x - tw + 5 * dpr : x - 5 * dpr, y - 12 * dpr, tw, 17 * dpr);
        ctx.fillStyle = '#fff';
        ctx.fillText(text, x, y);
      };
      if (side) {
        label('Before', at - 12 * dpr, 20 * dpr, 'right');
        label('After', at + 12 * dpr, 20 * dpr, 'left');
      } else {
        label('Before', 12 * dpr, at - 10 * dpr, 'left');
        label('After', 12 * dpr, at + 20 * dpr, 'left');
      }
      ctx.restore();
    }
    // brush outline
    const p = pointer.current;
    if (p && PAINT_TOOLS.includes(toolRef.current)) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(p.x * k, p.y * k, Math.max(1, (brushRef.current.size / 2) * k), 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.beginPath();
      ctx.arc(p.x * k, p.y * k, Math.max(1, (brushRef.current.size / 2) * k) + dpr, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (cloneSrcRef.current && toolRef.current === 'clone') {
      const { x, y } = cloneSrcRef.current;
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(x * k - 8 * dpr, y * k);
      ctx.lineTo(x * k + 8 * dpr, y * k);
      ctx.moveTo(x * k, y * k - 8 * dpr);
      ctx.lineTo(x * k, y * k + 8 * dpr);
      ctx.stroke();
    }
  }, [zoom]);

  const render = useCallback(() => {
    frame.current = 0;
    const v = view.current;
    if (!v) return;
    const d = docRef.current;
    const c = composite(d, renderScale());
    if (v.width !== c.width || v.height !== c.height) {
      v.width = c.width;
      v.height = c.height;
    }
    const ctx = v.getContext('2d')!;
    ctx.clearRect(0, 0, v.width, v.height);
    ctx.drawImage(c, 0, 0);
    const cmp = compareRef.current;
    if (cmp.mode !== 'off') {
      // the opened picture, composited once; stretched if the image has been resized or cropped since
      beforeCache.current ??= composite(initial, Math.min(1, MAX_RENDER_SIDE / Math.max(initial.width, initial.height)));
      const bw = cmp.mode === 'side' ? Math.round(v.width * cmp.split) : v.width;
      const bh = cmp.mode === 'stack' ? Math.round(v.height * cmp.split) : v.height;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, bw, bh);
      ctx.clip();
      ctx.clearRect(0, 0, bw, bh);
      ctx.drawImage(beforeCache.current, 0, 0, v.width, v.height);
      ctx.restore();
    }
    drawOverlay();
  }, [renderScale, drawOverlay, initial]);

  const requestRender = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(render);
  }, [render]);

  const outlineCache = useRef<{ mask: Mask; canvas: HTMLCanvasElement } | null>(null);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const brushRef = useRef(brush);
  brushRef.current = brush;
  const cloneSrcRef = useRef(cloneSrc);
  cloneSrcRef.current = cloneSrc;

  useEffect(() => {
    requestRender();
  }, [doc, selection, zoom, requestRender, compare, split]);

  useEffect(() => onStatus?.({ width: doc.width, height: doc.height, zoom }), [doc.width, doc.height, zoom, onStatus]);

  // fit on open
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const fit = Math.min(1, (el.clientWidth - 48) / initial.width, (el.clientHeight - 48) / initial.height);
    setZoom(Math.max(0.02, Math.floor(fit * 100) / 100));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    getPixels: () => flatten(docRef.current),
    getPsd: () => {
      const d = bakeForPsd(docRef.current);
      return writePsdDocument(d, flatten(docRef.current), (l) => rasterizeLayer(l, d));
    },
    getDocument: () => docRef.current,
  }));

  // ── layer helpers ───────────────────────────────────────────────────────
  const updateLayer = useCallback((l: Layer, record = false) => {
    if (record) pushHistory();
    setDoc(replaceLayer(docRef.current, l));
    onChange();
  }, [onChange, pushHistory, setDoc]);

  /** Layer edits from the panels: history once per editing burst. */
  const editBurst = useRef<{ id: string; t: number } | null>(null);
  const editLayer = useCallback(
    (l: Layer, commitNow = false) => {
      const now = Date.now();
      const burst = editBurst.current;
      if (commitNow || !burst || burst.id !== l.id || now - burst.t > 1200) pushHistory();
      editBurst.current = commitNow ? null : { id: l.id, t: now };
      setDoc(replaceLayer(docRef.current, l));
      onChange();
    },
    [onChange, pushHistory, setDoc],
  );

  const addLayer = useCallback(
    (l: Layer) => {
      const d = docRef.current;
      const i = d.layers.findIndex((x) => x.id === activeRef.current);
      const layers = [...d.layers];
      layers.splice(i < 0 ? layers.length : i + 1, 0, l);
      commit({ ...d, layers }, l.id);
      setMaskEdit(false);
    },
    [commit],
  );

  const activeRaster = (): RasterLayer | null => {
    const l = docRef.current.layers.find((x) => x.id === activeRef.current);
    if (!l) {
      onError('Select a layer first.');
      return null;
    }
    if (l.locked) {
      onError(`"${l.name}" is locked. Unlock it in the Layers panel to edit it.`);
      return null;
    }
    if (l.kind !== 'raster') {
      if (!window.confirm(`"${l.name}" is a ${l.kind === 'adjust' ? 'adjustment' : l.kind} layer. Rasterize it so you can paint on it?`)) return null;
      const r = rasterize(docRef.current, l);
      commit(replaceLayer(docRef.current, r));
      return r;
    }
    return l;
  };

  /** A raster layer stretched to document size at 0,0 (so strokes and fills can reach anywhere). */
  const ensureDocSized = (l: RasterLayer): RasterLayer => {
    const d = docRef.current;
    if (l.x === 0 && l.y === 0 && l.px.width === d.width && l.px.height === d.height) return l;
    return { ...l, px: clonePixels(rasterToDocSize(d, l)), x: 0, y: 0 };
  };

  // ── pointer interaction ─────────────────────────────────────────────────
  type Gesture =
    | { kind: 'paint'; layerId: string; last: [number, number]; carry: number; mode: DabMode | null; mask: Mask | null; source?: Pixels }
    | { kind: 'heal'; layerId: string; mask: Mask; last: [number, number]; carry: number; remove: boolean }
    | { kind: 'patch'; layerId: string; x0: number; y0: number; x1: number; y1: number }
    | { kind: 'move'; layerId: string; startX: number; startY: number; ox: number; oy: number; moved: boolean }
    | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; ellipse: boolean; mode: CombineMode }
    | { kind: 'shape'; x0: number; y0: number; x1: number; y1: number; ellipse: boolean }
    | { kind: 'lasso'; points: [number, number][]; mode: CombineMode }
    | { kind: 'gradient'; x0: number; y0: number; x1: number; y1: number }
    | { kind: 'pan'; sx: number; sy: number; left: number; top: number }
    | { kind: 'compare' };
  const gesture = useRef<Gesture | null>(null);

  const docPoint = (e: React.PointerEvent | PointerEvent): { x: number; y: number } => {
    const r = view.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
  };

  const modeFor = (e: React.PointerEvent): CombineMode => (e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : selMode);

  const samplePixels = (): Pixels => {
    const d = docRef.current;
    const l = d.layers.find((x) => x.id === activeRef.current);
    if (!sampleAll && l?.kind === 'raster') return rasterToDocSize(d, l);
    return flatten(d);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button === 1 || spaceDown.current || tool === 'hand') {
      const el = scroller.current!;
      gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, left: el.scrollLeft, top: el.scrollTop };
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const p = docPoint(e);
    const d = docRef.current;
    const sel = selRef.current;
    (e.target as Element).setPointerCapture(e.pointerId);
    if (compare !== 'off') {
      // grabbing the divider moves it instead of using the tool
      const near = compare === 'side' ? Math.abs(p.x - d.width * split) : Math.abs(p.y - d.height * split);
      if (near * zoom < 10) {
        gesture.current = { kind: 'compare' };
        return;
      }
    }

    switch (tool) {
      case 'move': {
        const l = d.layers.find((x) => x.id === activeRef.current);
        if (!l || l.kind === 'fill' || l.kind === 'adjust') return;
        if (l.locked) return onError(`"${l.name}" is locked.`);
        pushHistory();
        gesture.current = { kind: 'move', layerId: l.id, startX: p.x, startY: p.y, ox: (l as { x: number }).x, oy: (l as { y: number }).y, moved: false };
        return;
      }
      case 'marquee':
      case 'ellipse-marquee':
        gesture.current = { kind: 'marquee', x0: p.x, y0: p.y, x1: p.x, y1: p.y, ellipse: tool === 'ellipse-marquee', mode: modeFor(e) };
        return;
      case 'shape':
        gesture.current = { kind: 'shape', x0: p.x, y0: p.y, x1: p.x, y1: p.y, ellipse: shapeKind === 'ellipse' };
        return;
      case 'lasso':
        gesture.current = { kind: 'lasso', points: [[p.x, p.y]], mode: modeFor(e) };
        return;
      case 'gradient':
        gesture.current = { kind: 'gradient', x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        return;
      case 'wand': {
        const m = magicWand(samplePixels(), p.x, p.y, tolerance, contiguous);
        pushHistory();
        setSelection(combineMasks(sel, featherPx ? featherMask(m, featherPx) : m, modeFor(e)));
        return;
      }
      case 'eyedropper': {
        const px = flatten(d);
        const x = Math.floor(p.x);
        const y = Math.floor(p.y);
        if (x < 0 || y < 0 || x >= px.width || y >= px.height) return;
        const k = (y * px.width + x) * 4;
        const hex = `#${[px.data[k], px.data[k + 1], px.data[k + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
        if (e.altKey) setBg(hex);
        else setFg(hex);
        return;
      }
      case 'text': {
        const hit = [...d.layers].reverse().find((l) => {
          if (l.kind !== 'text') return false;
          const b = textBox(l);
          return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
        });
        if (hit) {
          setActiveId(hit.id);
          return;
        }
        const size = Math.max(12, Math.round(Math.min(d.width, d.height) / 14));
        addLayer(textLayer('Text', Math.round(p.x), Math.round(p.y), 'Text', size, fg));
        setTimeout(() => (document.querySelector('.pi-text') as HTMLTextAreaElement | null)?.select(), 50);
        return;
      }
      case 'bucket': {
        const l = activeRaster();
        if (!l) return;
        let area = magicWand(sampleAll ? flatten(d) : rasterToDocSize(d, l), p.x, p.y, tolerance, contiguous);
        if (sel) area = combineMasks(sel, area, 'intersect');
        commit(replaceLayer(docRef.current, bucketFill(docRef.current, l, area, fg, brush.opacity)));
        return;
      }
      case 'clone':
      case 'brush':
      case 'eraser':
      case 'dodge':
      case 'burn': {
        if (tool === 'clone') {
          if (e.altKey) {
            setCloneSrc({ x: p.x, y: p.y });
            return;
          }
          if (!cloneSrc) return onError('Alt-click (Option-click) where you want to copy from first.');
        }
        const l0 = d.layers.find((x) => x.id === activeRef.current);
        if (maskEdit && l0?.mask) {
          if (l0.locked) return onError(`"${l0.name}" is locked.`);
          pushHistory();
          const mask = cloneMask(l0.mask);
          const nl = { ...l0, mask } as Layer;
          setDoc(replaceLayer(docRef.current, nl));
          gesture.current = { kind: 'paint', layerId: l0.id, last: [p.x, p.y], carry: 0, mode: null, mask };
          paintAt(p.x, p.y);
          return;
        }
        const r = activeRaster();
        if (!r) return;
        pushHistory();
        const base = ensureDocSized(r);
        const nl: RasterLayer = { ...base, px: base === r ? clonePixels(r.px) : base.px };
        setDoc(replaceLayer(docRef.current, nl));
        let mode: DabMode;
        if (tool === 'brush') mode = { kind: 'paint', color: hexToRgb(fg) };
        else if (tool === 'eraser') mode = { kind: 'erase' };
        else if (tool === 'clone') mode = { kind: 'clone', source: sampleAll ? flatten(d) : clonePixels(nl.px), dx: Math.round(cloneSrc!.x - p.x), dy: Math.round(cloneSrc!.y - p.y) };
        else mode = { kind: tool, exposure };
        gesture.current = { kind: 'paint', layerId: nl.id, last: [p.x, p.y], carry: 0, mode, mask: null };
        paintAt(p.x, p.y);
        return;
      }
      case 'patch': {
        const sel = selRef.current;
        const xi = Math.round(p.x);
        const yi = Math.round(p.y);
        const inSel = sel && xi >= 0 && yi >= 0 && xi < sel.width && yi < sel.height && sel.data[yi * sel.width + xi] >= 128;
        if (!inSel) {
          // no selection under the pointer yet: draw one around the flaw
          gesture.current = { kind: 'lasso', points: [[p.x, p.y]], mode: 'replace' };
          return;
        }
        const r = activeRaster();
        if (!r) return;
        gesture.current = { kind: 'patch', layerId: r.id, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        return;
      }
      case 'remove':
      case 'heal': {
        const r = activeRaster();
        if (!r) return;
        const mask = emptyMask(d.width, d.height);
        maskDab(mask, p.x, p.y, { ...brush, hardness: 0.9, opacity: 1 }, 255, null);
        gesture.current = { kind: 'heal', layerId: r.id, mask, last: [p.x, p.y], carry: 0, remove: tool === 'remove' };
        drawOverlay();
        return;
      }
      default:
    }
  };

  const paintAt = (x: number, y: number) => {
    const g = gesture.current;
    if (!g || g.kind !== 'paint') return;
    const l = docRef.current.layers.find((q) => q.id === g.layerId);
    if (!l) return;
    if (g.mask) {
      maskDab(g.mask, x, y, brush, tool === 'eraser' ? luma(bg) : luma(fg), selRef.current);
      invalidateMask(g.mask);
      invalidateLayer(l);
    } else if (l.kind === 'raster' && g.mode) {
      dab(l.px, x, y, brush, g.mode, selRef.current, l.x, l.y);
      invalidateLayer(l);
    }
    requestRender();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = docPoint(e);
    pointer.current = p;
    const g = gesture.current;
    if (!g) {
      if (PAINT_TOOLS.includes(tool) || (tool === 'clone' && cloneSrc)) drawOverlay();
      return;
    }
    switch (g.kind) {
      case 'compare': {
        const d = docRef.current;
        setSplit(Math.min(0.98, Math.max(0.02, compare === 'side' ? p.x / d.width : p.y / d.height)));
        return;
      }
      case 'pan': {
        const el = scroller.current!;
        el.scrollLeft = g.left - (e.clientX - g.sx);
        el.scrollTop = g.top - (e.clientY - g.sy);
        return;
      }
      case 'move': {
        const l = docRef.current.layers.find((x) => x.id === g.layerId);
        if (!l || l.kind === 'fill' || l.kind === 'adjust') return;
        const nx = Math.round(g.ox + p.x - g.startX);
        const ny = Math.round(g.oy + p.y - g.startY);
        g.moved = true;
        setDoc(replaceLayer(docRef.current, { ...l, x: nx, y: ny } as Layer));
        return;
      }
      case 'marquee':
      case 'shape':
      case 'gradient': {
        let x1 = p.x;
        let y1 = p.y;
        if (e.shiftKey && g.kind !== 'gradient') {
          // square / circle
          const s = Math.max(Math.abs(x1 - g.x0), Math.abs(y1 - g.y0));
          x1 = g.x0 + Math.sign(x1 - g.x0 || 1) * s;
          y1 = g.y0 + Math.sign(y1 - g.y0 || 1) * s;
        }
        g.x1 = x1;
        g.y1 = y1;
        drawOverlay();
        return;
      }
      case 'lasso':
        g.points.push([p.x, p.y]);
        drawOverlay();
        return;
      case 'paint': {
        const { points, carry } = strokePoints(g.last[0], g.last[1], p.x, p.y, brush.size, g.carry);
        for (const [x, y] of points) paintAt(x, y);
        g.last = [p.x, p.y];
        g.carry = carry;
        return;
      }
      case 'patch':
        g.x1 = p.x;
        g.y1 = p.y;
        drawOverlay();
        return;
      case 'heal': {
        const { points, carry } = strokePoints(g.last[0], g.last[1], p.x, p.y, brush.size, g.carry);
        for (const [x, y] of points) maskDab(g.mask, x, y, { ...brush, hardness: 0.9, opacity: 1 }, 255, null);
        g.last = [p.x, p.y];
        g.carry = carry;
        drawOverlay();
        return;
      }
    }
  };

  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const d = docRef.current;
    const sel = selRef.current;
    switch (g.kind) {
      case 'move':
        if (g.moved) onChange();
        else past.current.pop();
        return;
      case 'paint':
        onChange();
        bump((n) => n + 1);
        return;
      case 'marquee': {
        const w = g.x1 - g.x0;
        const h = g.y1 - g.y0;
        pushHistory();
        if (Math.abs(w) < 2 && Math.abs(h) < 2) {
          if (g.mode === 'replace') setSelection(null);
          drawOverlay();
          return;
        }
        let m = g.ellipse ? ellipseMask(d.width, d.height, g.x0, g.y0, w, h) : rectMask(d.width, d.height, g.x0, g.y0, w, h);
        if (featherPx) m = featherMask(m, featherPx);
        setSelection(combineMasks(sel, m, g.mode));
        return;
      }
      case 'lasso': {
        pushHistory();
        if (g.points.length < 3) {
          if (g.mode === 'replace') setSelection(null);
          drawOverlay();
          return;
        }
        let m = polygonMask(d.width, d.height, g.points);
        if (featherPx) m = featherMask(m, featherPx);
        setSelection(combineMasks(sel, m, g.mode));
        return;
      }
      case 'shape': {
        const w = g.x1 - g.x0;
        const h = g.y1 - g.y0;
        drawOverlay();
        if (Math.abs(w) < 3 || Math.abs(h) < 3) return;
        addLayer(shapeLayer(g.ellipse ? 'Ellipse' : 'Rectangle', g.ellipse ? 'ellipse' : 'rect', Math.min(g.x0, g.x1), Math.min(g.y0, g.y1), Math.abs(w), Math.abs(h), fg));
        return;
      }
      case 'gradient': {
        drawOverlay();
        if (Math.hypot(g.x1 - g.x0, g.y1 - g.y0) < 2) return;
        const l = activeRaster();
        if (!l) return;
        commit(replaceLayer(docRef.current, fillRaster(docRef.current, l, sel, { from: fg, to: bg, x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, radial: radialGradient }, brush.opacity)));
        return;
      }
      case 'patch': {
        drawOverlay();
        const l = d.layers.find((x) => x.id === g.layerId);
        const dx = Math.round(g.x1 - g.x0);
        const dy = Math.round(g.y1 - g.y0);
        if (!l || l.kind !== 'raster' || !sel || Math.hypot(dx, dy) < 3) return;
        withBusy('Patching…', () => {
          const full = ensureDocSized(l);
          commit(replaceLayer(docRef.current, { ...full, px: patchClone(full.px, sel, dx, dy) }));
        });
        return;
      }
      case 'heal': {
        const l = d.layers.find((x) => x.id === g.layerId);
        if (!l || l.kind !== 'raster') return;
        const b = maskBounds(g.mask);
        if (!b) return;
        if (g.remove) {
          drawOverlay();
          removeArea(l, g.mask);
          return;
        }
        setBusy('Healing…');
        setTimeout(() => {
          try {
            const full = ensureDocSized(l);
            const pad = 24;
            const rx = Math.max(0, b.x - pad);
            const ry = Math.max(0, b.y - pad);
            const rw = Math.min(d.width - rx, b.width + pad * 2);
            const rh = Math.min(d.height - ry, b.height + pad * 2);
            // heal a crop around the spot, then paste it back
            const sub = { data: new Uint8ClampedArray(rw * rh * 4), width: rw, height: rh };
            const subMask = emptyMask(rw, rh);
            for (let y = 0; y < rh; y++) {
              sub.data.set(full.px.data.subarray(((ry + y) * d.width + rx) * 4, ((ry + y) * d.width + rx + rw) * 4), y * rw * 4);
              subMask.data.set(g.mask.data.subarray((ry + y) * d.width + rx, (ry + y) * d.width + rx + rw), y * rw);
            }
            const healed = spotHeal(sub, subMask);
            const px = full === l ? clonePixels(l.px) : full.px;
            for (let y = 0; y < rh; y++) px.data.set(healed.data.subarray(y * rw * 4, (y + 1) * rw * 4), ((ry + y) * d.width + rx) * 4);
            commit(replaceLayer(docRef.current, { ...full, px }));
          } finally {
            setBusy(null);
            drawOverlay();
          }
        }, 10);
        return;
      }
    }
  };

  // ── menu actions ────────────────────────────────────────────────────────
  const withBusy = (label: string, fn: () => void) => {
    setBusy(label);
    setTimeout(() => {
      try {
        fn();
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    }, 10);
  };

  /** Remove: fills the masked area of a layer with texture synthesised from around it. */
  const removeArea = (l: RasterLayer, area: Mask) => {
    withBusy('Removing…', () => {
      const full = ensureDocSized(l);
      const b = maskBounds(area);
      if (!b) return;
      // a few pixels beyond the object, so its soft edge and halo go too
      let hole = dilateMask(area, Math.max(2, Math.round(Math.min(b.width, b.height) * 0.04)));
      if (removeShadows) hole = expandToShadows(full.px, hole, Math.max(b.width, b.height) * 0.75);
      commit(replaceLayer(docRef.current, { ...full, px: contentAwareFill(full.px, hole) }));
    });
  };
  const removeSelection = () => {
    const sel = selRef.current;
    if (!sel) return onError('Select the object to remove first (lasso or marquee), or paint over it with the Remove tool.');
    const l = activeRaster();
    if (l) removeArea(l, sel);
  };

  const newLayer = () => addLayer(emptyRaster(`Layer ${docRef.current.layers.length}`, docRef.current.width, docRef.current.height));
  const newAdjust = (t: AdjustType) => addLayer(adjustLayer(t, ADJUST_LABELS[t]));
  const selectAll = () => {
    pushHistory();
    setSelection(fullMask(docRef.current.width, docRef.current.height));
  };
  const deselect = () => {
    if (!selRef.current) return;
    pushHistory();
    setSelection(null);
  };
  const inverse = () => {
    pushHistory();
    const d = docRef.current;
    setSelection(selRef.current ? invertMask(selRef.current) : fullMask(d.width, d.height));
  };
  const loadTransparency = () => {
    const d = docRef.current;
    const l = d.layers.find((x) => x.id === activeRef.current);
    if (!l) return;
    const px = l.kind === 'raster' ? rasterToDocSize(d, l) : rasterizeLayer(l, d);
    const m = emptyMask(d.width, d.height);
    for (let i = 0; i < m.data.length; i++) m.data[i] = px.data[i * 4 + 3];
    pushHistory();
    setSelection(m);
  };
  const layerViaCopy = (cut = false) => {
    const sel = selRef.current;
    const l = activeRaster();
    if (!l) return;
    if (!sel) return addLayer(duplicateLayer(l));
    const c = copySelection(docRef.current, l, sel);
    if (!c) return;
    let d = docRef.current;
    if (cut) d = replaceLayer(d, clearSelection(l, sel));
    const i = d.layers.findIndex((x) => x.id === l.id);
    const layers = [...d.layers];
    layers.splice(i + 1, 0, c);
    commit({ ...d, layers }, c.id);
  };
  const copy = (cut = false) => {
    const d = docRef.current;
    const sel = selRef.current;
    const l = d.layers.find((x) => x.id === activeRef.current);
    if (!l) return;
    const px = l.kind === 'raster' ? l : rasterize(d, l);
    clipboard = sel ? copySelection(d, px, sel) : { ...px, px: clonePixels(px.px) };
    if (cut && sel && l.kind === 'raster' && !l.locked) commit(replaceLayer(d, clearSelection(l, sel)));
    // also put a PNG on the system clipboard for other apps
    if (clipboard && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      pixelsCanvas(clipboard.px).toBlob((b) => b && navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]).catch(() => undefined), 'image/png');
    }
  };
  const paste = () => {
    if (!clipboard) return;
    const l = duplicateLayer(clipboard) as RasterLayer;
    l.name = 'Pasted';
    addLayer(l);
  };
  const clear = () => {
    const sel = selRef.current;
    const l = activeRaster();
    if (!l) return;
    commit(replaceLayer(docRef.current, sel ? clearSelection(l, sel) : { ...l, px: { ...l.px, data: new Uint8ClampedArray(l.px.data.length) } }));
  };
  const fillSelection = () => {
    const l = activeRaster();
    if (!l) return;
    commit(replaceLayer(docRef.current, fillRaster(docRef.current, l, selRef.current, { color: fg })));
  };
  const deleteLayer = () => {
    const d = docRef.current;
    if (d.layers.length <= 1) return onError('A document needs at least one layer.');
    const i = d.layers.findIndex((x) => x.id === activeRef.current);
    const layers = d.layers.filter((x) => x.id !== activeRef.current);
    commit({ ...d, layers }, layers[Math.max(0, i - 1)]?.id ?? null);
  };
  const addMask = (fromSel = true) => {
    const d = docRef.current;
    const l = d.layers.find((x) => x.id === activeRef.current);
    if (!l) return;
    const sel = selRef.current;
    const mask = fromSel && sel ? cloneMask(sel) : fullMask(d.width, d.height);
    updateLayer({ ...l, mask, maskEnabled: true }, true);
    setMaskEdit(true);
  };
  const applyFilter = (id: FilterId, params: Record<string, number>) => {
    const l = activeRaster();
    if (!l) return;
    withBusy(`${FILTER_DEFS[id].label.replace('…', '')}…`, () => {
      const full = ensureDocSized(l);
      const out = runFilter(id, full.px, params, selRef.current);
      commit(replaceLayer(docRef.current, { ...full, px: out }));
    });
  };

  // keyboard
  const tabActive0 = useTabActive();
  const tabActive1 = useTabActive();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!tabActive0.current) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (dialog) return;
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === ' ') {
        spaceDown.current = true;
        return;
      }
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && k === 'y') {
        e.preventDefault();
        redo();
      } else if (mod && k === 'a') {
        e.preventDefault();
        selectAll();
      } else if (mod && k === 'd') {
        e.preventDefault();
        deselect();
      } else if (mod && e.shiftKey && k === 'i') {
        e.preventDefault();
        inverse();
      } else if (mod && k === 'j') {
        e.preventDefault();
        layerViaCopy(e.shiftKey);
      } else if (mod && k === 'c') {
        e.preventDefault();
        copy();
      } else if (mod && k === 'x') {
        e.preventDefault();
        copy(true);
      } else if (mod && k === 'v') {
        if (clipboard) {
          e.preventDefault();
          paste();
        }
      } else if (mod && k === 't') {
        e.preventDefault();
        setDialog({ kind: 'transform' });
      } else if (mod && (k === '=' || k === '+')) {
        e.preventDefault();
        setZoom((z) => Math.min(32, z * 1.25));
      } else if (mod && k === '-') {
        e.preventDefault();
        setZoom((z) => Math.max(0.02, z / 1.25));
      } else if (mod && k === '0') {
        e.preventDefault();
        fitToScreen();
      } else if (!mod && e.shiftKey && e.key === 'Delete') {
        e.preventDefault();
        removeSelection();
      } else if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        clear();
      } else if (!mod && k === '[') setBrush((b) => ({ ...b, size: Math.max(1, Math.round(b.size / 1.2)) }));
      else if (!mod && k === ']') setBrush((b) => ({ ...b, size: Math.min(2000, Math.round(b.size * 1.2 + 1)) }));
      else if (!mod && e.key === '\\') setCompare((c) => (c === 'off' ? 'side' : c === 'side' ? 'stack' : 'off'));
      else if (!mod && k === 'x') {
        setFg(bg);
        setBg(fg);
      } else if (!mod && k === 'd') {
        setFg('#000000');
        setBg('#ffffff');
      } else if (!mod && !e.altKey) {
        const match = TOOLS.filter((x) => x.key.toLowerCase() === k);
        // pressing the key again steps through the tools that share it
        if (match.length) setTool((cur) => match[(match.findIndex((x) => x.id === cur) + 1) % match.length].id);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!tabActive1.current) return;
      if (e.key === ' ') spaceDown.current = false;
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  });

  // paste images from other apps (system clipboard)
  const tabActive2 = useTabActive();
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      if (!tabActive2.current) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      try {
        const bmp = await createImageBitmap(file);
        const c = document.createElement('canvas');
        c.width = bmp.width;
        c.height = bmp.height;
        c.getContext('2d')!.drawImage(bmp, 0, 0);
        const d = docRef.current;
        addLayer(rasterLayer('Pasted image', canvasToPixels(c), Math.round((d.width - c.width) / 2), Math.round((d.height - c.height) / 2)));
      } catch {
        onError('That image could not be pasted.');
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  const fitToScreen = () => {
    const el = scroller.current;
    if (!el) return;
    const d = docRef.current;
    setZoom(Math.max(0.02, Math.floor(Math.min((el.clientWidth - 48) / d.width, (el.clientHeight - 48) / d.height) * 100) / 100));
  };

  // ctrl + wheel zoom
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => Math.min(32, Math.max(0.02, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const belowComposite = useCallback(() => {
    const d = docRef.current;
    const i = d.layers.findIndex((l) => l.id === activeRef.current);
    if (i < 0) return null;
    const c = composite({ ...d, layers: d.layers.slice(0, i) }, Math.min(1, 512 / Math.max(d.width, d.height)));
    const img = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    return { data: img.data, width: c.width, height: c.height };
  }, []);

  const cursor = tool === 'hand' ? 'grab' : tool === 'move' ? 'move' : tool === 'text' ? 'text' : PAINT_TOOLS.includes(tool) ? 'none' : 'crosshair';
  const canUndo = past.current.length > 0;
  const canRedo = future.current.length > 0;

  const options = useMemo(() => {
    const brushOpts = (
      <>
        <Slider label="Size" value={brush.size} min={1} max={1000} onChange={(v) => setBrush({ ...brush, size: v })} />
        <Slider label="Hardness" value={Math.round(brush.hardness * 100)} min={0} max={100} onChange={(v) => setBrush({ ...brush, hardness: v / 100 })} />
        {tool !== 'heal' && <Slider label="Opacity" value={Math.round(brush.opacity * 100)} min={1} max={100} onChange={(v) => setBrush({ ...brush, opacity: v / 100 })} />}
      </>
    );
    const selOpts = (
      <>
        <div className="pi-seg" role="radiogroup" aria-label="Selection mode">
          {(['replace', 'add', 'subtract', 'intersect'] as CombineMode[]).map((m) => (
            <button key={m} type="button" className={selMode === m ? 'is-active' : ''} onClick={() => setSelMode(m)} title={m === 'add' ? 'Shift' : m === 'subtract' ? 'Alt' : m === 'intersect' ? 'Shift+Alt' : 'New selection'}>
              {m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
        <Slider label="Feather" value={featherPx} min={0} max={200} onChange={setFeatherPx} />
      </>
    );
    switch (tool) {
      case 'brush':
      case 'eraser':
        return brushOpts;
      case 'clone':
        return (
          <>
            {brushOpts}
            <label className="check"><input type="checkbox" checked={sampleAll} onChange={(e) => setSampleAll(e.target.checked)} /> Sample all layers</label>
            <span className="pi-hint">{cloneSrc ? 'Source set' : 'Alt-click to set the source'}</span>
          </>
        );
      case 'heal':
        return (
          <>
            {brushOpts}
            <span className="pi-hint">Paint over a blemish; it is filled from the surrounding area when you let go.</span>
          </>
        );
      case 'remove':
        return (
          <>
            {brushOpts}
            <label className="pi-check" title="Also clears the darker area attached to the object, such as the shadow it casts">
              <input type="checkbox" checked={removeShadows} onChange={(e) => setRemoveShadows(e.target.checked)} /> Remove its shadow too
            </label>
          </>
        );
      case 'patch':
        return <span className="pi-hint">{selection ? 'Drag from inside the selection to a clean area: that area is copied in and blended.' : 'Draw around the flaw, then drag the selection onto clean texture.'}</span>;
      case 'dodge':
      case 'burn':
        return (
          <>
            {brushOpts}
            <Slider label="Exposure" value={exposure} min={1} max={100} onChange={setExposure} />
          </>
        );
      case 'marquee':
      case 'ellipse-marquee':
      case 'lasso':
        return selOpts;
      case 'wand':
      case 'bucket':
        return (
          <>
            {tool === 'wand' && selOpts}
            <Slider label="Tolerance" value={tolerance} min={0} max={255} onChange={setTolerance} />
            <label className="check"><input type="checkbox" checked={contiguous} onChange={(e) => setContiguous(e.target.checked)} /> Contiguous</label>
            <label className="check"><input type="checkbox" checked={sampleAll} onChange={(e) => setSampleAll(e.target.checked)} /> Sample all layers</label>
            {tool === 'bucket' && <Slider label="Opacity" value={Math.round(brush.opacity * 100)} min={1} max={100} onChange={(v) => setBrush({ ...brush, opacity: v / 100 })} />}
          </>
        );
      case 'gradient':
        return (
          <>
            <label className="check"><input type="checkbox" checked={radialGradient} onChange={(e) => setRadialGradient(e.target.checked)} /> Radial</label>
            <span className="pi-hint">Drag across the image: foreground → background colour.</span>
          </>
        );
      case 'shape':
        return (
          <div className="pi-seg" role="radiogroup" aria-label="Shape">
            <button type="button" className={shapeKind === 'rect' ? 'is-active' : ''} onClick={() => setShapeKind('rect')}><Square size={14} /> Rectangle</button>
            <button type="button" className={shapeKind === 'ellipse' ? 'is-active' : ''} onClick={() => setShapeKind('ellipse')}><Circle size={14} /> Ellipse</button>
          </div>
        );
      case 'text':
        return <span className="pi-hint">Click to add text; click existing text to select it. Edit it in Properties.</span>;
      case 'eyedropper':
        return <span className="pi-hint">Click: foreground colour · Alt-click: background colour</span>;
      case 'move':
        return <span className="pi-hint">Drag to move the selected layer.</span>;
      default:
        return null;
    }
  }, [tool, brush, selMode, featherPx, tolerance, contiguous, sampleAll, exposure, radialGradient, shapeKind, cloneSrc]);

  const dispW = doc.width * zoom;
  const dispH = doc.height * zoom;

  return (
    <div className={cx('pi-root', `pi-theme-${look.theme}`)} style={{ '--pi-accent': look.accent } as React.CSSProperties}>
      <div className="pi-menubar" role="menubar">
        <Popover label="Edit" text button={<span>Edit</span>}>
          {(close) => (
            <div className="format-menu">
              <MenuItem hint="Ctrl+Z" disabled={!canUndo} onClick={() => { close(); undo(); }}>Undo</MenuItem>
              <MenuItem hint="Ctrl+Shift+Z" disabled={!canRedo} onClick={() => { close(); redo(); }}>Redo</MenuItem>
              <div className="format-menu-sep" role="separator" />
              <MenuItem hint="Ctrl+X" onClick={() => { close(); copy(true); }}>Cut</MenuItem>
              <MenuItem hint="Ctrl+C" onClick={() => { close(); copy(); }}>Copy</MenuItem>
              <MenuItem hint="Ctrl+V" disabled={!clipboard} onClick={() => { close(); paste(); }}>Paste</MenuItem>
              <MenuItem hint="Del" onClick={() => { close(); clear(); }}>Clear</MenuItem>
              <MenuItem onClick={() => { close(); fillSelection(); }}>Fill with foreground</MenuItem>
              <MenuItem hint="Shift+Del" disabled={!selection} onClick={() => { close(); removeSelection(); }}>Content-Aware Fill (remove selection)</MenuItem>
              <div className="format-menu-sep" role="separator" />
              <MenuItem hint="Ctrl+T" onClick={() => { close(); setDialog({ kind: 'transform' }); }}>Free Transform…</MenuItem>
            </div>
          )}
        </Popover>
        <Popover label="Image" text button={<span>Image</span>}>
          {(close) => (
            <div className="format-menu">
              <MenuItem onClick={() => { close(); setDialog({ kind: 'imageSize' }); }}>Image Size…</MenuItem>
              <MenuItem onClick={() => { close(); setDialog({ kind: 'canvasSize' }); }}>Canvas Size…</MenuItem>
              <div className="format-menu-sep" role="separator" />
              <MenuItem onClick={() => { close(); withBusy('Rotating…', () => commit(rotateImage(docRef.current, 1))); }}>Rotate 90° Clockwise</MenuItem>
              <MenuItem onClick={() => { close(); withBusy('Rotating…', () => commit(rotateImage(docRef.current, 3))); }}>Rotate 90° Counter-clockwise</MenuItem>
              <MenuItem onClick={() => { close(); withBusy('Rotating…', () => commit(rotateImage(docRef.current, 2))); }}>Rotate 180°</MenuItem>
              <MenuItem onClick={() => { close(); withBusy('Flipping…', () => commit(flipImage(docRef.current, 'h'))); }}>Flip Canvas Horizontal</MenuItem>
              <MenuItem onClick={() => { close(); withBusy('Flipping…', () => commit(flipImage(docRef.current, 'v'))); }}>Flip Canvas Vertical</MenuItem>
              <div className="format-menu-sep" role="separator" />
              <MenuItem
                disabled={!selection}
                onClick={() => {
                  close();
                  const next = selRef.current && cropToSelection(docRef.current, selRef.current);
                  if (next) {
                    commit(next);
                    setSelection(null);
                  }
                }}
              >
                Crop to Selection
              </MenuItem>
              <MenuItem onClick={() => { close(); withBusy('Flattening…', () => { const d = flattenDocument(docRef.current); commit(d, d.layers[0].id); }); }}>Flatten Image</MenuItem>
            </div>
          )}
        </Popover>
        <Popover label="Layer" text button={<span>Layer</span>}>
          {(close) => (
            <div className="format-menu pi-menu-scroll">
              <MenuItem onClick={() => { close(); newLayer(); }}>New Layer</MenuItem>
              <MenuItem hint="Ctrl+J" onClick={() => { close(); layerViaCopy(); }}>Layer via Copy</MenuItem>
              <MenuItem hint="Ctrl+Shift+J" onClick={() => { close(); layerViaCopy(true); }}>Layer via Cut</MenuItem>
              <MenuItem onClick={() => { close(); addLayer(fillLayer('Color Fill', fg)); }}>New Fill Layer (Solid Color)</MenuItem>
              <MenuItem onClick={() => { close(); const l = fillLayer('Gradient Fill', fg); l.fill = { type: 'gradient', from: fg, to: bg, angle: 90, radial: false }; addLayer(l); }}>New Fill Layer (Gradient)</MenuItem>
              <div className="format-menu-sep" role="separator" />
              <div className="format-menu-group">New Adjustment Layer</div>
              {ADJUST_ORDER.map((t) => (
                <MenuItem key={t} onClick={() => { close(); newAdjust(t); }}>{ADJUST_LABELS[t]}</MenuItem>
              ))}
              <div className="format-menu-sep" role="separator" />
              <MenuItem onClick={() => { close(); if (active) addLayer(duplicateLayer(active)); }}>Duplicate Layer</MenuItem>
              <MenuItem onClick={() => { close(); deleteLayer(); }}>Delete Layer</MenuItem>
              <MenuItem onClick={() => { close(); if (active) commit(mergeDown(docRef.current, active.id), docRef.current.layers[docRef.current.layers.findIndex((l) => l.id === active.id) - 1]?.id); }}>Merge Down</MenuItem>
              <MenuItem disabled={!active || active.kind === 'raster' || active.kind === 'adjust'} onClick={() => { close(); if (active) commit(replaceLayer(docRef.current, rasterize(docRef.current, active))); }}>Rasterize Layer</MenuItem>
              <div className="format-menu-sep" role="separator" />
              <div className="format-menu-group">Layer Mask</div>
              <MenuItem onClick={() => { close(); addMask(false); }}>Reveal All</MenuItem>
              <MenuItem disabled={!selection} onClick={() => { close(); addMask(true); }}>Reveal Selection</MenuItem>
              <MenuItem disabled={!active?.mask} onClick={() => { close(); if (active) updateLayer({ ...active, maskEnabled: !active.maskEnabled }, true); }}>{active?.maskEnabled === false ? 'Enable' : 'Disable'} Mask</MenuItem>
              <MenuItem disabled={!active?.mask} onClick={() => { close(); if (active) { updateLayer({ ...active, mask: null }, true); setMaskEdit(false); } }}>Delete Mask</MenuItem>
            </div>
          )}
        </Popover>
        <Popover label="Select" text button={<span>Select</span>}>
          {(close) => (
            <div className="format-menu">
              <MenuItem hint="Ctrl+A" onClick={() => { close(); selectAll(); }}>All</MenuItem>
              <MenuItem hint="Ctrl+D" onClick={() => { close(); deselect(); }}>Deselect</MenuItem>
              <MenuItem hint="Ctrl+Shift+I" onClick={() => { close(); inverse(); }}>Inverse</MenuItem>
              <MenuItem disabled={!selection} onClick={() => { close(); setDialog({ kind: 'feather' }); }}>Feather…</MenuItem>
              <MenuItem onClick={() => { close(); loadTransparency(); }}>Load Layer Transparency</MenuItem>
            </div>
          )}
        </Popover>
        <Popover label="Filter" text button={<span>Filter</span>}>
          {(close) => (
            <div className="format-menu">
              {(Object.keys(FILTER_DEFS) as FilterId[]).map((id) => (
                <MenuItem
                  key={id}
                  onClick={() => {
                    close();
                    if (FILTER_DEFS[id].params.length) setDialog({ kind: 'filter', id });
                    else applyFilter(id, {});
                  }}
                >
                  {FILTER_DEFS[id].label}
                </MenuItem>
              ))}
            </div>
          )}
        </Popover>
        <Popover label="View" text button={<span>View</span>}>
          {(close) => (
            <div className="format-menu">
              <div className="format-menu-group">Before / after</div>
              <MenuItem hint="\" onClick={() => { close(); setCompare('side'); }}>{compare === 'side' ? '✓ ' : ''}Compare side by side</MenuItem>
              <MenuItem onClick={() => { close(); setCompare('stack'); }}>{compare === 'stack' ? '✓ ' : ''}Compare top and bottom</MenuItem>
              <MenuItem disabled={compare === 'off'} onClick={() => { close(); setCompare('off'); }}>Stop comparing</MenuItem>
              <div className="format-menu-sep" role="separator" />
              <MenuItem hint="Ctrl+0" onClick={() => { close(); fitToScreen(); }}>Fit on screen</MenuItem>
              <MenuItem hint="Ctrl+1" onClick={() => { close(); setZoom(1); }}>Actual pixels (100%)</MenuItem>
              <div className="format-menu-sep" role="separator" />
              <div className="format-menu-group">Theme</div>
              {THEMES.map((t) => (
                <MenuItem key={t.id} onClick={() => { close(); setLook((l) => ({ ...l, theme: t.id })); }}>{look.theme === t.id ? '✓ ' : ''}{t.label}</MenuItem>
              ))}
              <div className="pi-accents" role="radiogroup" aria-label="Accent colour">
                {ACCENTS.map((a) => (
                  <button key={a} type="button" role="radio" aria-checked={look.accent === a} aria-label={`Accent ${a}`} className={cx('pi-accent-dot', look.accent === a && 'is-active')} style={{ background: a }} onClick={() => setLook((l) => ({ ...l, accent: a }))} />
                ))}
                <input type="color" aria-label="Custom accent colour" value={look.accent} onChange={(e) => setLook((l) => ({ ...l, accent: e.target.value }))} />
              </div>
            </div>
          )}
        </Popover>
        <Popover label="Help" text button={<span>Help</span>}>
          {(close) => (
            <div className="format-menu">
              {([
                ['Pro Photo guide', 'photo-pro'],
                ['Layers, blend modes & masks', 'pro-layers'],
                ['Adjustment layers (Curves, Levels…)', 'pro-adjust'],
                ['Selections', 'pro-select'],
                ['Painting & retouching', 'pro-paint'],
                ['Filters, size & transform', 'pro-filters'],
              ] as const).map(([label, id]) => (
                <MenuItem key={id} onClick={() => { close(); openGuide(id); }}>{label}</MenuItem>
              ))}
            </div>
          )}
        </Popover>
        <span className="pi-menubar-sep" />
        <button type="button" className="pi-icon-btn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}><Undo2 size={16} /></button>
        <button type="button" className="pi-icon-btn" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}><Redo2 size={16} /></button>
        <span className="pi-menubar-sep" />
        <div className="pi-options">{options}</div>
        <span className="spacer" />
        <button
          type="button"
          className={cx('pi-icon-btn', compare !== 'off' && 'is-on')}
          aria-label="Compare before and after"
          aria-pressed={compare !== 'off'}
          title="Before / after: click for side by side, again for top and bottom, again to stop (\\). Drag the divider; zoom in to inspect."
          onClick={() => setCompare((c) => (c === 'off' ? 'side' : c === 'side' ? 'stack' : 'off'))}
        >
          {compare === 'stack' ? <Rows2 size={16} /> : <Columns2 size={16} />}
        </button>
        <button type="button" className="pi-icon-btn" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.02, z / 1.25))}><ZoomOut size={16} /></button>
        <button type="button" className="pi-text-btn" onClick={fitToScreen} title="Fit on screen (Ctrl+0)">{Math.round(zoom * 100)}%</button>
        <button type="button" className="pi-icon-btn" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(32, z * 1.25))}><ZoomIn size={16} /></button>
      </div>

      <div className="pi-body">
        <nav className="pi-tools" aria-label="Tools">
          {TOOL_GROUPS.map((ids, gi) => {
            const members = ids.map((id) => TOOLS.find((t) => t.id === id)!);
            // the rail shows the group's active tool, else the one used last, else its first
            const shown = members.find((t) => t.id === tool) ?? members.find((t) => t.id === groupTool[gi]) ?? members[0];
            const pick = (id: Tool) => {
              setTool(id);
              setGroupTool((g) => ({ ...g, [gi]: id }));
              // let go of the focus, or the pop-out would stay open over the picture
              (document.activeElement as HTMLElement | null)?.blur();
            };
            return (
              <div key={gi} className={cx('pi-tool-group', members.length > 1 && 'has-more')}>
                <button type="button" className={cx('pi-tool', tool === shown.id && 'is-active')} title={members.length > 1 ? undefined : `${shown.label} (${shown.key})`} aria-label={shown.label} aria-pressed={tool === shown.id} onClick={() => pick(shown.id)}>
                  {shown.icon}
                </button>
                {members.length > 1 && (
                  <div className="pi-flyout" role="group" aria-label="Related tools">
                    {members.map((t) => (
                      <button key={t.id} type="button" className={cx('pi-flyout-item', tool === t.id && 'is-active')} aria-label={t.id === shown.id ? `${t.label} (shown)` : t.label} onClick={() => pick(t.id)}>
                        {t.icon}
                        <span>{t.label}</span>
                        <kbd>{t.key}</kbd>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <div className="pi-swatches" title="Foreground / background colour (X swaps, D resets)">
            <label className="pi-swatch pi-fg" style={{ background: fg }}>
              <input type="color" aria-label="Foreground colour" value={fg} onChange={(e) => setFg(e.target.value)} />
            </label>
            <label className="pi-swatch pi-bg" style={{ background: bg }}>
              <input type="color" aria-label="Background colour" value={bg} onChange={(e) => setBg(e.target.value)} />
            </label>
          </div>
          <button type="button" className="pi-icon-btn" title="Swap colours (X)" aria-label="Swap colours" onClick={() => { setFg(bg); setBg(fg); }}><Droplet size={14} /></button>
        </nav>

        <div ref={scroller} className="pi-canvas-area">
          <div className="pi-stage" style={{ width: dispW + 96, height: dispH + 96 }}>
            <div className="pi-checker" style={{ width: dispW, height: dispH }}>
              <canvas ref={view} className="pi-view" style={{ width: dispW, height: dispH }} />
              <canvas
                ref={overlay}
                className="pi-overlay"
                style={{ width: dispW, height: dispH, cursor }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onPointerLeave={() => {
                  pointer.current = null;
                  drawOverlay();
                }}
              />
            </div>
          </div>
          {busy && (
            <div className="pi-busy" role="status">
              <span className="spinner" /> {busy}
            </div>
          )}
        </div>

        <aside className="pi-side">
          <PropertiesPanel
            doc={doc}
            layer={active}
            composite={belowComposite}
            onChange={(l) => editLayer(l)}
            onCommit={() => (editBurst.current = null)}
            extra={maskEdit && active?.mask ? <p className="pi-hint pi-mask-note">Painting on the layer mask: black hides, white reveals.</p> : null}
          />
          <LayersPanel
            doc={doc}
            activeId={activeId}
            maskEdit={maskEdit}
            onSelect={(id) => {
              setActiveId(id);
              setMaskEdit(false);
            }}
            onMaskEdit={(id, on) => {
              setActiveId(id);
              setMaskEdit(on);
            }}
            onChange={(l, record) => editLayer(l, record)}
            onAdd={newLayer}
            onDuplicate={() => active && addLayer(duplicateLayer(active))}
            onDelete={deleteLayer}
            onMove={(delta) => active && commit(moveLayer(docRef.current, active.id, delta))}
            onAddMask={() => addMask(true)}
            onMerge={() => {
              if (!active) return;
              const i = docRef.current.layers.findIndex((l) => l.id === active.id);
              if (i <= 0) return onError('There is no layer below to merge into.');
              commit(mergeDown(docRef.current, active.id), docRef.current.layers[i - 1].id);
            }}
          />
        </aside>
      </div>

      {dialog?.kind === 'filter' && (
        <FilterDialog
          id={dialog.id}
          onClose={() => setDialog(null)}
          onApply={(p) => {
            setDialog(null);
            applyFilter(dialog.id, p);
          }}
        />
      )}
      {dialog?.kind === 'imageSize' && (
        <SizeDialog
          title="Image Size"
          width={doc.width}
          height={doc.height}
          onClose={() => setDialog(null)}
          onApply={(w, h) => {
            setDialog(null);
            withBusy('Resizing…', () => {
              commit(resizeImage(docRef.current, w, h));
              setSelection(null);
            });
          }}
        />
      )}
      {dialog?.kind === 'canvasSize' && (
        <SizeDialog
          title="Canvas Size"
          width={doc.width}
          height={doc.height}
          anchor
          onClose={() => setDialog(null)}
          onApply={(w, h, ax = 0.5, ay = 0.5) => {
            setDialog(null);
            commit(resizeCanvas(docRef.current, w, h, ax, ay));
            setSelection(null);
          }}
        />
      )}
      {dialog?.kind === 'transform' && (
        <TransformDialog
          onClose={() => setDialog(null)}
          onApply={(sx, sy, deg, fh, fv) => {
            setDialog(null);
            const l = activeRaster();
            if (!l) return;
            withBusy('Transforming…', () => commit(replaceLayer(docRef.current, transformLayer(l, sx, sy, deg, fh, fv))));
          }}
        />
      )}
      {dialog?.kind === 'feather' && (
        <NumberDialog
          title="Feather Selection"
          label="Feather radius (px)"
          initial={8}
          min={0.5}
          max={250}
          onClose={() => setDialog(null)}
          onApply={(v) => {
            setDialog(null);
            if (!selRef.current) return;
            pushHistory();
            setSelection(featherMask(selRef.current, v));
          }}
        />
      )}
    </div>
  );
});

function FilterDialog({ id, onApply, onClose }: { id: FilterId; onApply: (p: Record<string, number>) => void; onClose: () => void }) {
  const def = FILTER_DEFS[id];
  const [p, setP] = useState<Record<string, number>>(() => Object.fromEntries(def.params.map((x) => [x.key, x.def])));
  return (
    <Modal
      title={def.label.replace('…', '')}
      width={420}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => onApply(p)}>Apply</button>
        </>
      }
    >
      {def.params.map((x) => (
        <Slider key={x.key} label={x.label} value={p[x.key]} min={x.min} max={x.max} step={x.step} onChange={(v) => setP({ ...p, [x.key]: v })} />
      ))}
      <p className="dialog-hint">Applies to the selected layer, inside the selection if there is one.</p>
    </Modal>
  );
}

function SizeDialog({ title, width, height, anchor, onApply, onClose }: { title: string; width: number; height: number; anchor?: boolean; onApply: (w: number, h: number, ax?: number, ay?: number) => void; onClose: () => void }) {
  const [w, setW] = useState(width);
  const [h, setH] = useState(height);
  const [lock, setLock] = useState(!anchor);
  const [ax, setAx] = useState(0.5);
  const [ay, setAy] = useState(0.5);
  return (
    <Modal
      title={title}
      width={380}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={w < 1 || h < 1 || w > 30000 || h > 30000} onClick={() => onApply(Math.round(w), Math.round(h), ax, ay)}>OK</button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Width (px)">
          <input className="input" type="number" min={1} value={w} onChange={(e) => { const v = Number(e.target.value); setW(v); if (lock) setH(Math.max(1, Math.round((v * height) / width))); }} />
        </Field>
        <Field label="Height (px)">
          <input className="input" type="number" min={1} value={h} onChange={(e) => { const v = Number(e.target.value); setH(v); if (lock) setW(Math.max(1, Math.round((v * width) / height))); }} />
        </Field>
      </div>
      <label className="check"><input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} /> Keep proportions</label>
      {anchor && (
        <Field label="Anchor">
          <div className="pi-anchor">
            {[0, 0.5, 1].map((yy) => [0, 0.5, 1].map((xx) => (
              <button key={`${xx}-${yy}`} type="button" aria-label={`Anchor ${xx},${yy}`} className={ax === xx && ay === yy ? 'is-active' : ''} onClick={() => { setAx(xx); setAy(yy); }} />
            )))}
          </div>
        </Field>
      )}
    </Modal>
  );
}

function TransformDialog({ onApply, onClose }: { onApply: (sx: number, sy: number, deg: number, fh: boolean, fv: boolean) => void; onClose: () => void }) {
  const [sx, setSx] = useState(100);
  const [sy, setSy] = useState(100);
  const [lock, setLock] = useState(true);
  const [deg, setDeg] = useState(0);
  const [fh, setFh] = useState(false);
  const [fv, setFv] = useState(false);
  return (
    <Modal
      title="Free Transform"
      width={400}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => onApply(sx / 100, sy / 100, deg, fh, fv)}>Apply</button>
        </>
      }
    >
      <Slider label="Width %" value={sx} min={1} max={500} onChange={(v) => { setSx(v); if (lock) setSy(v); }} />
      <Slider label="Height %" value={sy} min={1} max={500} onChange={(v) => { setSy(v); if (lock) setSx(v); }} />
      <label className="check"><input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} /> Keep proportions</label>
      <Slider label="Rotate °" value={deg} min={-180} max={180} step={0.5} onChange={setDeg} />
      <div className="pi-row">
        <label className="check"><input type="checkbox" checked={fh} onChange={(e) => setFh(e.target.checked)} /> Flip horizontal</label>
        <label className="check"><input type="checkbox" checked={fv} onChange={(e) => setFv(e.target.checked)} /> Flip vertical</label>
      </div>
      <p className="dialog-hint">Transforms the selected pixel layer around its centre.</p>
    </Modal>
  );
}

function NumberDialog({ title, label, initial, min, max, onApply, onClose }: { title: string; label: string; initial: number; min: number; max: number; onApply: (v: number) => void; onClose: () => void }) {
  const [v, setV] = useState(initial);
  return (
    <Modal
      title={title}
      width={340}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => onApply(v)}>OK</button>
        </>
      }
    >
      <Slider label={label} value={v} min={min} max={max} step={0.5} onChange={setV} />
    </Modal>
  );
}

