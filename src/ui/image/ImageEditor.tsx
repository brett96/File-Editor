import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import {
  ArrowUpRight,
  Circle,
  Crop,
  EyeOff,
  FlipHorizontal2,
  FlipVertical2,
  Image as ImageIcon,
  Maximize,
  Minus,
  MousePointer2,
  PenLine,
  Redo2,
  RotateCcw,
  RotateCw,
  Scaling,
  SlidersHorizontal,
  Square,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  FILTER_LABELS,
  NO_ADJUSTMENTS,
  applyAdjustments,
  applyFilter,
  blur,
  crop as cropPixels,
  flip,
  isIdentity,
  pixelate,
  rotate90,
  sharpen,
  type Adjustments,
  type FilterPreset,
  type Pixels,
  type Rect,
} from '../../core/media/image-ops';
import { pixelsToCanvas, resizePixels, rotateArbitrary, canvasToPixels, type DecodedImage } from '../../core/media/image-codecs';
import { newId } from '../../core/pdf/types';
import { getHost } from '../../platform/host';
import { ColorPicker, Divider, IconButton, Select, cx } from '../components';
import { IMAGE_EXTENSIONS, loadImageFile } from '../image-utils';

export interface ImageEditorHandle {
  /** Final pixels with every overlay drawn in. Does not change the editor state. */
  getPixels(): Pixels;
}

type Tool = 'select' | 'crop' | 'text' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'draw' | 'redact';
type Panel = 'adjust' | 'resize' | null;

interface Base {
  id: string;
}
type ImgObject =
  | (Base & { type: 'text'; x: number; y: number; text: string; size: number; font: string; color: string; bold: boolean; italic: boolean; outline: boolean })
  | (Base & { type: 'rect' | 'ellipse'; x: number; y: number; width: number; height: number; stroke: string | null; fill: string | null; strokeWidth: number })
  | (Base & { type: 'line' | 'arrow'; x1: number; y1: number; x2: number; y2: number; stroke: string; strokeWidth: number })
  | (Base & { type: 'ink'; points: [number, number][]; stroke: string; strokeWidth: number })
  | (Base & { type: 'image'; x: number; y: number; width: number; height: number; dataUrl: string; el?: HTMLImageElement });

interface Snapshot {
  pixels: Pixels;
  objects: ImgObject[];
}

interface Props {
  initial: DecodedImage;
  onChange: () => void;
  onError: (message: string) => void;
  onStatus?: (s: { width: number; height: number; zoom: number }) => void;
}

const FONTS = [
  { value: 'system-ui, "Segoe UI", Arial, sans-serif', label: 'Sans' },
  { value: 'Georgia, "Times New Roman", serif', label: 'Serif' },
  { value: '"Courier New", monospace', label: 'Mono' },
  { value: 'Impact, "Arial Black", sans-serif', label: 'Impact' },
  { value: '"Comic Sans MS", "Comic Neue", cursive', label: 'Casual' },
];

const ASPECTS: { value: string; label: string; ratio: number | null }[] = [
  { value: 'free', label: 'Free', ratio: null },
  { value: 'original', label: 'Original', ratio: -1 },
  { value: '1:1', label: 'Square 1:1', ratio: 1 },
  { value: '4:3', label: '4:3', ratio: 4 / 3 },
  { value: '3:2', label: '3:2', ratio: 3 / 2 },
  { value: '16:9', label: '16:9', ratio: 16 / 9 },
  { value: '9:16', label: '9:16 (story)', ratio: 9 / 16 },
  { value: '4:5', label: '4:5 (portrait)', ratio: 4 / 5 },
];

const ADJUST_FIELDS: { key: keyof Adjustments; label: string; min: number; max: number }[] = [
  { key: 'exposure', label: 'Exposure', min: -100, max: 100 },
  { key: 'brightness', label: 'Brightness', min: -100, max: 100 },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
  { key: 'highlights', label: 'Highlights', min: -100, max: 100 },
  { key: 'shadows', label: 'Shadows', min: -100, max: 100 },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
  { key: 'warmth', label: 'Warmth', min: -100, max: 100 },
  { key: 'hue', label: 'Hue', min: -180, max: 180 },
  { key: 'vignette', label: 'Vignette', min: 0, max: 100 },
];

const MAX_HISTORY_BYTES = 600 * 1024 * 1024;
const PREVIEW_MAX = 1400;

function clonePixels(px: Pixels): Pixels {
  return { data: new Uint8ClampedArray(px.data), width: px.width, height: px.height };
}

function textLines(o: Extract<ImgObject, { type: 'text' }>) {
  return o.text.split('\n');
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measureText(o: Extract<ImgObject, { type: 'text' }>): { width: number; height: number } {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  const ctx = measureCtx!;
  ctx.font = `${o.italic ? 'italic ' : ''}${o.bold ? 700 : 400} ${o.size}px ${o.font}`;
  const lines = textLines(o);
  return { width: Math.max(4, ...lines.map((l) => ctx.measureText(l).width)), height: lines.length * o.size * 1.2 };
}

function bbox(o: ImgObject): Rect {
  switch (o.type) {
    case 'text': {
      const m = measureText(o);
      return { x: o.x, y: o.y, width: m.width, height: m.height };
    }
    case 'line':
    case 'arrow':
      return { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), width: Math.abs(o.x2 - o.x1), height: Math.abs(o.y2 - o.y1) };
    case 'ink': {
      const xs = o.points.map((p) => p[0]);
      const ys = o.points.map((p) => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    }
    default:
      return { x: o.x, y: o.y, width: o.width, height: o.height };
  }
}

function moveObj(o: ImgObject, dx: number, dy: number): ImgObject {
  switch (o.type) {
    case 'line':
    case 'arrow':
      return { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy };
    case 'ink':
      return { ...o, points: o.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
    default:
      return { ...o, x: o.x + dx, y: o.y + dy };
  }
}

function arrowHead(x1: number, y1: number, x2: number, y2: number, w: number): [number, number][] {
  const len = Math.max(10, w * 4);
  const a = Math.atan2(y2 - y1, x2 - x1);
  return [
    [x2, y2],
    [x2 - len * Math.cos(a - Math.PI / 7), y2 - len * Math.sin(a - Math.PI / 7)],
    [x2 - len * Math.cos(a + Math.PI / 7), y2 - len * Math.sin(a + Math.PI / 7)],
  ];
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Draws overlay objects onto a canvas exactly as the SVG layer shows them. */
function drawObjects(ctx: CanvasRenderingContext2D, objects: ImgObject[]) {
  for (const o of objects) {
    ctx.save();
    switch (o.type) {
      case 'text': {
        ctx.font = `${o.italic ? 'italic ' : ''}${o.bold ? 700 : 400} ${o.size}px ${o.font}`;
        ctx.textBaseline = 'top';
        ctx.fillStyle = o.color;
        textLines(o).forEach((line, i) => {
          const y = o.y + i * o.size * 1.2 + o.size * 0.1;
          if (o.outline) {
            ctx.lineWidth = Math.max(2, o.size / 10);
            ctx.strokeStyle = o.color.toLowerCase() === '#000000' ? '#ffffff' : '#000000';
            ctx.lineJoin = 'round';
            ctx.strokeText(line, o.x, y);
          }
          ctx.fillText(line, o.x, y);
        });
        break;
      }
      case 'rect':
      case 'ellipse': {
        ctx.beginPath();
        if (o.type === 'rect') ctx.rect(o.x, o.y, o.width, o.height);
        else ctx.ellipse(o.x + o.width / 2, o.y + o.height / 2, Math.abs(o.width / 2), Math.abs(o.height / 2), 0, 0, Math.PI * 2);
        if (o.fill) {
          ctx.fillStyle = o.fill;
          ctx.fill();
        }
        if (o.stroke) {
          ctx.strokeStyle = o.stroke;
          ctx.lineWidth = o.strokeWidth;
          ctx.stroke();
        }
        break;
      }
      case 'line':
      case 'arrow': {
        ctx.strokeStyle = o.stroke;
        ctx.lineWidth = o.strokeWidth;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(o.x1, o.y1);
        ctx.lineTo(o.x2, o.y2);
        ctx.stroke();
        if (o.type === 'arrow') {
          ctx.fillStyle = o.stroke;
          const h = arrowHead(o.x1, o.y1, o.x2, o.y2, o.strokeWidth);
          ctx.beginPath();
          ctx.moveTo(h[0][0], h[0][1]);
          ctx.lineTo(h[1][0], h[1][1]);
          ctx.lineTo(h[2][0], h[2][1]);
          ctx.closePath();
          ctx.fill();
        }
        break;
      }
      case 'ink': {
        ctx.strokeStyle = o.stroke;
        ctx.lineWidth = o.strokeWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        o.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        if (o.points.length === 1) ctx.lineTo(o.points[0][0] + 0.01, o.points[0][1]);
        ctx.stroke();
        break;
      }
      case 'image':
        if (o.el) ctx.drawImage(o.el, o.x, o.y, o.width, o.height);
        break;
    }
    ctx.restore();
  }
}

function bake(px: Pixels, objects: ImgObject[]): Pixels {
  if (!objects.length) return px;
  const canvas = pixelsToCanvas(px);
  drawObjects(canvas.getContext('2d')!, objects);
  return canvasToPixels(canvas);
}

function previewOf(px: Pixels): Pixels {
  const k = Math.min(1, PREVIEW_MAX / Math.max(px.width, px.height));
  return k < 1 ? resizePixels(px, px.width * k, px.height * k) : clonePixels(px);
}

interface Look {
  adjustments: Adjustments;
  filter: FilterPreset;
  sharpen: number;
  blur: number;
}
const NO_LOOK: Look = { adjustments: NO_ADJUSTMENTS, filter: 'none', sharpen: 0, blur: 0 };
const lookIsIdentity = (l: Look) => isIdentity(l.adjustments) && l.filter === 'none' && l.sharpen === 0 && l.blur === 0;

function applyLook(px: Pixels, l: Look, scale = 1): Pixels {
  applyFilter(px, l.filter);
  applyAdjustments(px, l.adjustments);
  if (l.blur > 0) blur(px, l.blur * scale);
  if (l.sharpen > 0) sharpen(px, l.sharpen);
  return px;
}

type Gesture =
  | { kind: 'move'; id: string; start: [number, number]; orig: ImgObject }
  | { kind: 'resize'; id: string; start: [number, number]; orig: ImgObject }
  | { kind: 'draw'; id: string; start: [number, number] }
  | { kind: 'crop-new'; start: [number, number] }
  | { kind: 'crop-move'; start: [number, number]; orig: Rect }
  | { kind: 'crop-resize'; corner: 'nw' | 'ne' | 'sw' | 'se'; orig: Rect }
  | { kind: 'redact'; start: [number, number] };

export const ImageEditor = forwardRef<ImageEditorHandle, Props>(function ImageEditor({ initial, onChange, onError, onStatus }, ref) {
  const [pixels, setPixels] = useState<Pixels>(initial.pixels);
  const [objects, setObjects] = useState<ImgObject[]>([]);
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const [, bump] = useState(0);
  const [tool, setTool] = useState<Tool>('select');
  const [panel, setPanel] = useState<Panel>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [style, setStyle] = useState({ color: '#e11d48', fill: null as string | null, strokeWidth: 6, fontSize: 64, font: FONTS[0].value, bold: true, italic: false, outline: false });
  const [redactStyle, setRedactStyle] = useState<'pixelate' | 'blur' | 'black'>('pixelate');
  const [cropRect, setCropRect] = useState<Rect | null>(null);
  const [aspect, setAspect] = useState('free');
  const [look, setLook] = useState<Look>(NO_LOOK);
  const [straighten, setStraighten] = useState(0);
  const [zoomMode, setZoomMode] = useState<'fit' | number>('fit');
  const [fitScale, setFitScale] = useState(1);
  const [busy, setBusy] = useState(false);
  const [draftRect, setDraftRect] = useState<Rect | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pixelsRef = useRef(pixels);
  pixelsRef.current = pixels;
  const objectsRef = useRef(objects);
  objectsRef.current = objects;

  const W = pixels.width;
  const H = pixels.height;
  const scale = zoomMode === 'fit' ? fitScale : zoomMode;

  useImperativeHandle(ref, () => ({ getPixels: () => bake(pixelsRef.current, objectsRef.current) }), []);

  useEffect(() => {
    onStatus?.({ width: W, height: H, zoom: scale });
  }, [W, H, scale, onStatus]);

  useEffect(() => {
    if (initial.warnings.length) initial.warnings.forEach((w) => onError(w));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── fit-to-window ────────────────────────────────────────────────────────
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const update = () => {
      const k = Math.min((el.clientWidth - 56) / W, (el.clientHeight - 56) / H, 1);
      setFitScale(Math.max(0.02, k));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);

  // ── previews ─────────────────────────────────────────────────────────────
  const preview = useMemo(() => (panel === 'adjust' ? previewOf(pixels) : null), [panel, pixels]);
  const lookPreview = useMemo(() => {
    if (!preview || lookIsIdentity(look)) return null;
    return applyLook(clonePixels(preview), look, preview.width / pixels.width);
  }, [preview, look, pixels.width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const src = lookPreview ?? pixels;
    pixelsToCanvas(src, canvas);
  }, [pixels, lookPreview]);

  const filterThumbs = useMemo(() => {
    if (panel !== 'adjust') return null;
    const k = 96 / Math.max(pixels.width, pixels.height);
    const thumb = resizePixels(pixels, Math.max(1, pixels.width * k), Math.max(1, pixels.height * k));
    const out: Partial<Record<FilterPreset, string>> = {};
    for (const f of Object.keys(FILTER_LABELS) as FilterPreset[]) {
      const p = applyFilter(clonePixels(thumb), f);
      out[f] = pixelsToCanvas(p).toDataURL('image/jpeg', 0.8);
    }
    return out;
  }, [panel, pixels]);

  // ── history ──────────────────────────────────────────────────────────────
  const snapshot = useCallback(() => {
    past.current.push({ pixels: pixelsRef.current, objects: objectsRef.current });
    let bytes = past.current.reduce((n, s) => n + s.pixels.data.byteLength, 0);
    while (past.current.length > 1 && (bytes > MAX_HISTORY_BYTES || past.current.length > 40)) {
      bytes -= past.current.shift()!.pixels.data.byteLength;
    }
    future.current = [];
    bump((n) => n + 1);
  }, []);

  const commit = useCallback(
    (next: Partial<Snapshot>) => {
      snapshot();
      if (next.pixels) setPixels(next.pixels);
      if (next.objects) setObjects(next.objects);
      onChange();
    },
    [snapshot, onChange],
  );

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push({ pixels: pixelsRef.current, objects: objectsRef.current });
    setPixels(prev.pixels);
    setObjects(prev.objects);
    setSelected(null);
    setEditing(null);
    onChange();
    bump((n) => n + 1);
  }, [onChange]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push({ pixels: pixelsRef.current, objects: objectsRef.current });
    setPixels(next.pixels);
    setObjects(next.objects);
    setSelected(null);
    onChange();
    bump((n) => n + 1);
  }, [onChange]);

  /** Runs a pixel operation after letting the busy indicator paint. */
  const runOp = useCallback(
    (fn: (px: Pixels) => Pixels, opts: { bakeObjects?: boolean } = {}) => {
      setBusy(true);
      setTimeout(() => {
        try {
          const src = opts.bakeObjects !== false ? bake(pixelsRef.current, objectsRef.current) : pixelsRef.current;
          const out = fn(opts.bakeObjects !== false && objectsRef.current.length ? src : clonePixels(src));
          commit({ pixels: out, objects: opts.bakeObjects !== false ? [] : objectsRef.current });
          setSelected(null);
        } catch (err) {
          onError(err instanceof Error ? err.message : 'That edit failed.');
        } finally {
          setBusy(false);
        }
      }, 16);
    },
    [commit, onError],
  );

  const updateObject = (id: string, patch: (o: ImgObject) => ImgObject, record = true) => {
    const next = objectsRef.current.map((o) => (o.id === id ? patch(o) : o));
    if (record) commit({ objects: next });
    else {
      objectsRef.current = next;
      setObjects(next);
    }
  };

  const removeSelected = () => {
    if (!selected) return;
    commit({ objects: objectsRef.current.filter((o) => o.id !== selected) });
    setSelected(null);
    setEditing(null);
  };

  // ── keyboard ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t instanceof Element && t.closest('input, textarea, select, .modal')) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (selected && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        removeSelected();
      } else if (e.key === 'Escape') {
        setSelected(null);
        setCropRect(null);
        setTool('select');
      } else if (e.key === 'Enter' && tool === 'crop' && cropRect) {
        e.preventDefault();
        applyCrop();
      } else if (selected && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        updateObject(selected, (o) => moveObj(o, e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── pointer ──────────────────────────────────────────────────────────────
  const toLocal = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = stageRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale];
  };

  const aspectRatio = (): number | null => {
    const a = ASPECTS.find((x) => x.value === aspect)?.ratio ?? null;
    return a === -1 ? W / H : a;
  };

  const onStageDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const [x, y] = toLocal(e);
    if (tool !== 'select') e.preventDefault(); // keep focus where we put it (e.g. a new text box)
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (tool === 'select') {
      setSelected(null);
      setEditing(null);
      return;
    }
    if (tool === 'crop') {
      if (cropRect && x >= cropRect.x && x <= cropRect.x + cropRect.width && y >= cropRect.y && y <= cropRect.y + cropRect.height) {
        gesture.current = { kind: 'crop-move', start: [x, y], orig: cropRect };
      } else {
        gesture.current = { kind: 'crop-new', start: [x, y] };
        setCropRect({ x, y, width: 0, height: 0 });
      }
      return;
    }
    if (tool === 'redact') {
      gesture.current = { kind: 'redact', start: [x, y] };
      setDraftRect({ x, y, width: 0, height: 0 });
      return;
    }
    if (tool === 'text') {
      const o: ImgObject = { id: newId('t'), type: 'text', x, y: y - style.fontSize * 0.6, text: '', size: style.fontSize, font: style.font, color: style.color, bold: style.bold, italic: style.italic, outline: style.outline };
      commit({ objects: [...objectsRef.current, o] });
      setSelected(o.id);
      setEditing(o.id);
      setTool('select');
      return;
    }
    snapshot();
    const id = newId('o');
    let o: ImgObject;
    if (tool === 'draw') o = { id, type: 'ink', points: [[x, y]], stroke: style.color, strokeWidth: style.strokeWidth };
    else if (tool === 'line' || tool === 'arrow') o = { id, type: tool, x1: x, y1: y, x2: x, y2: y, stroke: style.color, strokeWidth: style.strokeWidth };
    else o = { id, type: tool, x, y, width: 0, height: 0, stroke: style.color, fill: style.fill, strokeWidth: style.strokeWidth };
    objectsRef.current = [...objectsRef.current, o];
    setObjects(objectsRef.current);
    gesture.current = { kind: 'draw', id, start: [x, y] };
  };

  const onStageMove = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    let [x, y] = toLocal(e);
    x = Math.max(0, Math.min(W, x));
    y = Math.max(0, Math.min(H, y));
    if (g.kind === 'crop-new' || g.kind === 'redact') {
      const [sx, sy] = g.start;
      let w = x - sx;
      let h = y - sy;
      const ar = g.kind === 'crop-new' ? aspectRatio() : null;
      if (ar) {
        const m = Math.max(Math.abs(w), Math.abs(h) * ar);
        w = Math.sign(w || 1) * m;
        h = (Math.sign(h || 1) * m) / ar;
      }
      const r = { x: Math.min(sx, sx + w), y: Math.min(sy, sy + h), width: Math.abs(w), height: Math.abs(h) };
      if (g.kind === 'crop-new') setCropRect(r);
      else setDraftRect(r);
      return;
    }
    if (g.kind === 'crop-move') {
      const nx = Math.max(0, Math.min(W - g.orig.width, g.orig.x + x - g.start[0]));
      const ny = Math.max(0, Math.min(H - g.orig.height, g.orig.y + y - g.start[1]));
      setCropRect({ ...g.orig, x: nx, y: ny });
      return;
    }
    if (g.kind === 'crop-resize') {
      const o = g.orig;
      const fx = g.corner.includes('w') ? o.x + o.width : o.x;
      const fy = g.corner.includes('n') ? o.y + o.height : o.y;
      let w = x - fx;
      let h = y - fy;
      const ar = aspectRatio();
      if (ar) {
        const m = Math.max(Math.abs(w), Math.abs(h) * ar);
        w = Math.sign(w || 1) * m;
        h = (Math.sign(h || 1) * m) / ar;
      }
      setCropRect({ x: Math.min(fx, fx + w), y: Math.min(fy, fy + h), width: Math.abs(w), height: Math.abs(h) });
      return;
    }
    if (g.kind === 'draw') {
      const [sx, sy] = g.start;
      updateObject(g.id, (o) => {
        if (o.type === 'ink') return { ...o, points: [...o.points, [x, y]] };
        if (o.type === 'line' || o.type === 'arrow') {
          if (e.shiftKey) {
            const ang = Math.round(Math.atan2(y - sy, x - sx) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(x - sx, y - sy);
            return { ...o, x2: sx + Math.cos(ang) * len, y2: sy + Math.sin(ang) * len };
          }
          return { ...o, x2: x, y2: y };
        }
        if (o.type === 'rect' || o.type === 'ellipse') {
          let w = x - sx;
          let h = y - sy;
          if (e.shiftKey) {
            const m = Math.max(Math.abs(w), Math.abs(h));
            w = Math.sign(w || 1) * m;
            h = Math.sign(h || 1) * m;
          }
          return { ...o, x: Math.min(sx, sx + w), y: Math.min(sy, sy + h), width: Math.abs(w), height: Math.abs(h) };
        }
        return o;
      }, false);
      return;
    }
    if (g.kind === 'move') {
      const moved = moveObj(g.orig, x - g.start[0], y - g.start[1]);
      updateObject(g.id, () => moved, false);
      return;
    }
    if (g.kind === 'resize') {
      const o = g.orig;
      if (o.type === 'text') {
        const b = bbox(o);
        const k = Math.max(0.1, (b.width + x - g.start[0]) / Math.max(1, b.width));
        updateObject(g.id, () => ({ ...o, size: Math.max(6, Math.round(o.size * k)) }), false);
      } else if ('width' in o) {
        let w = Math.max(4, o.width + x - g.start[0]);
        let h = Math.max(4, o.height + y - g.start[1]);
        if (o.type === 'image' !== e.shiftKey) {
          const k = Math.max(w / o.width, h / o.height);
          w = o.width * k;
          h = o.height * k;
        }
        updateObject(g.id, (cur) => ({ ...cur, width: w, height: h }) as ImgObject, false);
      }
    }
  };

  const onStageUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.kind === 'redact') {
      const r = draftRect;
      setDraftRect(null);
      if (!r || r.width < 3 || r.height < 3) return;
      runOp(
        (px) => {
          if (redactStyle === 'pixelate') return pixelate(px, r, Math.max(12, Math.min(r.width, r.height) / 3.5, Math.max(px.width, px.height) / 80));
          if (redactStyle === 'blur') return blur(px, Math.max(10, Math.min(r.width, r.height) / 3), r);
          const out = px;
          const a = { x: Math.floor(r.x), y: Math.floor(r.y), w: Math.ceil(r.width), h: Math.ceil(r.height) };
          for (let yy = a.y; yy < Math.min(px.height, a.y + a.h); yy++) {
            for (let xx = a.x; xx < Math.min(px.width, a.x + a.w); xx++) out.data.set([0, 0, 0, 255], (yy * px.width + xx) * 4);
          }
          return out;
        },
        { bakeObjects: false },
      );
      return;
    }
    if (g.kind === 'draw') {
      const o = objectsRef.current.find((x) => x.id === g.id);
      if (o) {
        const b = bbox(o);
        if (o.type === 'ink' ? o.points.length < 2 : Math.max(b.width, b.height) < 3) {
          past.current.pop();
          setObjects(objectsRef.current.filter((x) => x.id !== g.id));
          bump((n) => n + 1);
          return;
        }
        setSelected(o.id);
        if (tool !== 'draw') setTool('select');
      }
      onChange();
      return;
    }
    if (g.kind === 'move' || g.kind === 'resize') onChange();
  };

  const startObj = (e: RPointerEvent, o: ImgObject, kind: 'move' | 'resize') => {
    if (e.button !== 0 || tool !== 'select') return;
    e.stopPropagation();
    e.preventDefault();
    setSelected(o.id);
    if (editing === o.id) return;
    setEditing(null);
    stageRef.current?.setPointerCapture(e.pointerId);
    snapshot();
    gesture.current = { kind, id: o.id, start: toLocal(e), orig: o };
  };

  // ── operations ───────────────────────────────────────────────────────────
  const applyCrop = () => {
    const r = cropRect;
    if (!r || r.width < 2 || r.height < 2) return;
    runOp((px) => cropPixels(px, r));
    setCropRect(null);
    setTool('select');
  };

  const insertImage = async () => {
    try {
      const [file] = await getHost().openFiles({ extensions: IMAGE_EXTENSIONS, description: 'Images' });
      if (!file) return;
      const img = await loadImageFile(file.blob, file.name, Math.max(W, H));
      const k = Math.min(1, (W * 0.5) / img.width, (H * 0.5) / img.height);
      const el = await loadImg(img.dataUrl);
      const o: ImgObject = { id: newId('i'), type: 'image', x: (W - img.width * k) / 2, y: (H - img.height * k) / 2, width: img.width * k, height: img.height * k, dataUrl: img.dataUrl, el };
      commit({ objects: [...objectsRef.current, o] });
      setSelected(o.id);
      setTool('select');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not insert the image.');
    }
  };

  const selectedObj = objects.find((o) => o.id === selected) ?? null;
  const applyStyle = (patch: Partial<typeof style>) => {
    setStyle((s) => ({ ...s, ...patch }));
    if (!selectedObj) return;
    updateObject(selectedObj.id, (o) => {
      switch (o.type) {
        case 'text':
          return { ...o, color: patch.color ?? o.color, size: patch.fontSize ?? o.size, font: patch.font ?? o.font, bold: patch.bold ?? o.bold, italic: patch.italic ?? o.italic, outline: patch.outline ?? o.outline };
        case 'rect':
        case 'ellipse':
          return { ...o, stroke: patch.color !== undefined ? patch.color : o.stroke, fill: patch.fill !== undefined ? patch.fill : o.fill, strokeWidth: patch.strokeWidth ?? o.strokeWidth };
        case 'line':
        case 'arrow':
        case 'ink':
          return { ...o, stroke: patch.color ?? o.stroke, strokeWidth: patch.strokeWidth ?? o.strokeWidth };
        default:
          return o;
      }
    });
  };

  const kind = selectedObj?.type ?? tool;
  const textStyle = selectedObj?.type === 'text' ? { color: selectedObj.color, fontSize: selectedObj.size, font: selectedObj.font, bold: selectedObj.bold, italic: selectedObj.italic, outline: selectedObj.outline } : style;
  const s = scale;

  return (
    <div className="editor-root">
      <div className="toolbar" role="toolbar" aria-label="Image tools">
        <IconButton label="Undo (Ctrl+Z)" disabled={!past.current.length} onClick={undo}><Undo2 size={16} /></IconButton>
        <IconButton label="Redo (Ctrl+Y)" disabled={!future.current.length} onClick={redo}><Redo2 size={16} /></IconButton>
        <Divider />
        <IconButton label="Select / move" active={tool === 'select'} onClick={() => setTool('select')}><MousePointer2 size={16} /></IconButton>
        <IconButton label="Crop" active={tool === 'crop'} onClick={() => { setTool('crop'); setPanel(null); setSelected(null); setCropRect({ x: 0, y: 0, width: W, height: H }); }}><Crop size={16} /></IconButton>
        <IconButton label="Rotate left" onClick={() => runOp((px) => rotate90(px, -1))}><RotateCcw size={16} /></IconButton>
        <IconButton label="Rotate right" onClick={() => runOp((px) => rotate90(px, 1))}><RotateCw size={16} /></IconButton>
        <IconButton label="Flip horizontally" onClick={() => runOp((px) => flip(px, 'horizontal'))}><FlipHorizontal2 size={16} /></IconButton>
        <IconButton label="Flip vertically" onClick={() => runOp((px) => flip(px, 'vertical'))}><FlipVertical2 size={16} /></IconButton>
        <IconButton label="Resize" active={panel === 'resize'} onClick={() => setPanel(panel === 'resize' ? null : 'resize')}><Scaling size={16} /></IconButton>
        <IconButton label="Adjust & filters" active={panel === 'adjust'} onClick={() => { setPanel(panel === 'adjust' ? null : 'adjust'); setTool('select'); }}><SlidersHorizontal size={16} /></IconButton>
        <Divider />
        <IconButton label="Add text" active={tool === 'text'} onClick={() => setTool('text')}><Type size={16} /></IconButton>
        <IconButton label="Draw" active={tool === 'draw'} onClick={() => setTool('draw')}><PenLine size={16} /></IconButton>
        <IconButton label="Arrow" active={tool === 'arrow'} onClick={() => setTool('arrow')}><ArrowUpRight size={16} /></IconButton>
        <IconButton label="Line" active={tool === 'line'} onClick={() => setTool('line')}><Minus size={16} /></IconButton>
        <IconButton label="Rectangle" active={tool === 'rect'} onClick={() => setTool('rect')}><Square size={16} /></IconButton>
        <IconButton label="Ellipse" active={tool === 'ellipse'} onClick={() => setTool('ellipse')}><Circle size={16} /></IconButton>
        <IconButton label="Insert image" onClick={insertImage}><ImageIcon size={16} /></IconButton>
        <IconButton label="Redact an area (pixelate, blur or black out)" active={tool === 'redact'} onClick={() => setTool('redact')}><EyeOff size={16} /></IconButton>

        {tool === 'crop' && (
          <>
            <Divider />
            <Select label="Aspect ratio" value={aspect} width={130} options={ASPECTS.map((a) => ({ value: a.value, label: a.label }))} onChange={(v) => {
              setAspect(v);
              const ratio = ASPECTS.find((a) => a.value === v)?.ratio;
              if (ratio) {
                const ar = ratio === -1 ? W / H : ratio;
                const w = Math.min(W, H * ar);
                const h = w / ar;
                setCropRect({ x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
              }
            }} />
            {cropRect && <span className="tb-readout">{Math.round(cropRect.width)} × {Math.round(cropRect.height)}</span>}
            <button type="button" className="btn btn-primary btn-sm" onClick={applyCrop} disabled={!cropRect || cropRect.width < 2}>Apply crop</button>
            <button type="button" className="btn btn-text" onClick={() => { setCropRect(null); setTool('select'); }}>Cancel</button>
          </>
        )}
        {tool === 'redact' && (
          <>
            <Divider />
            <Select label="Redaction style" value={redactStyle} width={120} options={[{ value: 'pixelate', label: 'Pixelate' }, { value: 'blur', label: 'Blur' }, { value: 'black', label: 'Black box' }]} onChange={setRedactStyle} />
            <span className="tb-hint">Drag over faces, plates or text</span>
          </>
        )}
        {(kind === 'text') && (
          <>
            <Divider />
            <Select label="Font" value={textStyle.font} width={90} options={FONTS} onChange={(v) => applyStyle({ font: v })} />
            <input className="tb-number" type="number" min={6} max={2000} aria-label="Font size" title="Font size (px)" value={Math.round(textStyle.fontSize)} onChange={(e) => { const n = parseFloat(e.target.value); if (n >= 6) applyStyle({ fontSize: n }); }} />
            <IconButton label="Bold" active={textStyle.bold} onClick={() => applyStyle({ bold: !textStyle.bold })}><b>B</b></IconButton>
            <IconButton label="Italic" active={textStyle.italic} onClick={() => applyStyle({ italic: !textStyle.italic })}><i>I</i></IconButton>
            <IconButton label="Outline" active={textStyle.outline} onClick={() => applyStyle({ outline: !textStyle.outline })}><span className="outline-a">A</span></IconButton>
            <ColorPicker label="Text colour" icon={<Type size={14} />} value={textStyle.color} onPick={(c) => applyStyle({ color: c })} />
          </>
        )}
        {['rect', 'ellipse', 'line', 'arrow', 'draw', 'ink'].includes(kind) && (
          <>
            <Divider />
            <ColorPicker label="Colour" icon={<PenLine size={14} />} value={selectedObj && 'stroke' in selectedObj ? selectedObj.stroke : style.color} onPick={(c) => applyStyle({ color: c })} onClear={kind === 'rect' || kind === 'ellipse' ? () => applyStyle({ color: null as unknown as string }) : undefined} clearLabel="No outline" />
            {(kind === 'rect' || kind === 'ellipse') && (
              <ColorPicker label="Fill" icon={<Square size={14} />} value={selectedObj && 'fill' in selectedObj ? selectedObj.fill : style.fill} onPick={(c) => applyStyle({ fill: c })} onClear={() => applyStyle({ fill: null })} clearLabel="No fill" />
            )}
            <Select label="Line width" value={String(selectedObj && 'strokeWidth' in selectedObj ? selectedObj.strokeWidth : style.strokeWidth)} width={72} options={['2', '4', '6', '10', '16', '24', '40'].map((v) => ({ value: v, label: `${v} px` }))} onChange={(v) => applyStyle({ strokeWidth: parseFloat(v) })} />
          </>
        )}
        {selectedObj && <IconButton label="Delete (Del)" onClick={removeSelected}><Trash2 size={16} /></IconButton>}

        <span className="spacer" />
        <IconButton label="Zoom out" onClick={() => setZoomMode(Math.max(0.05, scale / 1.25))}><ZoomOut size={16} /></IconButton>
        <button type="button" className={cx('btn btn-text', zoomMode === 'fit' && 'is-active')} onClick={() => setZoomMode('fit')} title="Fit to window"><Maximize size={14} /> {Math.round(scale * 100)}%</button>
        <IconButton label="Zoom in" onClick={() => setZoomMode(Math.min(8, scale * 1.25))}><ZoomIn size={16} /></IconButton>
        <button type="button" className="btn btn-text" onClick={() => setZoomMode(1)}>100%</button>
      </div>

      <div className="image-body">
        <div className={cx('workspace image-view', `tool-${tool}`)} ref={viewRef}>
          <div
            className="img-stage"
            ref={stageRef}
            style={{ width: W * s, height: H * s }}
            onPointerDown={onStageDown}
            onPointerMove={onStageMove}
            onPointerUp={onStageUp}
            onPointerCancel={onStageUp}
          >
            <canvas ref={canvasRef} className="img-canvas" style={{ width: W * s, height: H * s }} />
            <svg className="img-svg" width={W * s} height={H * s} viewBox={`0 0 ${W} ${H}`}>
              <defs>
                <pattern id="ck" width="16" height="16" patternUnits="userSpaceOnUse" />
              </defs>
              {objects.map((o) => {
                if (o.id === editing) return null;
                const common = { onPointerDown: (e: RPointerEvent) => startObj(e, o, 'move'), className: 'img-obj' };
                switch (o.type) {
                  case 'text':
                    return (
                      <text key={o.id} {...common} x={o.x} y={o.y} fontSize={o.size} fontFamily={o.font} fontWeight={o.bold ? 700 : 400} fontStyle={o.italic ? 'italic' : 'normal'} fill={o.color} stroke={o.outline ? (o.color.toLowerCase() === '#000000' ? '#fff' : '#000') : undefined} strokeWidth={o.outline ? Math.max(2, o.size / 10) : undefined} paintOrder="stroke" strokeLinejoin="round" dominantBaseline="text-before-edge" onDoubleClick={() => setEditing(o.id)}>
                        {textLines(o).map((l, i) => <tspan key={i} x={o.x} dy={i === 0 ? o.size * 0.1 : o.size * 1.2}>{l || ' '}</tspan>)}
                      </text>
                    );
                  case 'rect':
                    return <rect key={o.id} {...common} x={o.x} y={o.y} width={o.width} height={o.height} fill={o.fill ?? 'transparent'} stroke={o.stroke ?? 'none'} strokeWidth={o.strokeWidth} />;
                  case 'ellipse':
                    return <ellipse key={o.id} {...common} cx={o.x + o.width / 2} cy={o.y + o.height / 2} rx={o.width / 2} ry={o.height / 2} fill={o.fill ?? 'transparent'} stroke={o.stroke ?? 'none'} strokeWidth={o.strokeWidth} />;
                  case 'line':
                  case 'arrow':
                    return (
                      <g key={o.id} {...common}>
                        <line x1={o.x1} y1={o.y1} x2={o.x2} y2={o.y2} stroke="transparent" strokeWidth={Math.max(16 / s, o.strokeWidth + 8)} />
                        <line x1={o.x1} y1={o.y1} x2={o.x2} y2={o.y2} stroke={o.stroke} strokeWidth={o.strokeWidth} strokeLinecap="round" />
                        {o.type === 'arrow' && <polygon points={arrowHead(o.x1, o.y1, o.x2, o.y2, o.strokeWidth).map((p) => p.join(',')).join(' ')} fill={o.stroke} />}
                      </g>
                    );
                  case 'ink': {
                    const d = 'M' + o.points.map((p) => p.join(' ')).join(' L');
                    return (
                      <g key={o.id} {...common}>
                        <path d={d} stroke="transparent" strokeWidth={Math.max(16 / s, o.strokeWidth + 8)} fill="none" />
                        <path d={d} stroke={o.stroke} strokeWidth={o.strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                      </g>
                    );
                  }
                  case 'image':
                    return <image key={o.id} {...common} href={o.dataUrl} x={o.x} y={o.y} width={o.width} height={o.height} preserveAspectRatio="none" />;
                }
              })}
              {selectedObj && !editing && (() => {
                const b = bbox(selectedObj);
                const pad = 4 / s;
                const resizable = selectedObj.type !== 'line' && selectedObj.type !== 'arrow' && selectedObj.type !== 'ink';
                return (
                  <g className="img-selection">
                    <rect x={b.x - pad} y={b.y - pad} width={b.width + pad * 2} height={b.height + pad * 2} fill="none" stroke="#2f5bea" strokeWidth={1.5 / s} strokeDasharray={`${4 / s} ${3 / s}`} />
                    {resizable && <rect className="img-handle" x={b.x + b.width + pad - 6 / s} y={b.y + b.height + pad - 6 / s} width={12 / s} height={12 / s} fill="#2f5bea" stroke="#fff" strokeWidth={2 / s} onPointerDown={(e) => startObj(e, selectedObj, 'resize')} />}
                  </g>
                );
              })()}
              {tool === 'crop' && cropRect && (
                <g className="crop-layer">
                  <path d={`M0 0H${W}V${H}H0Z M${cropRect.x} ${cropRect.y}v${cropRect.height}h${cropRect.width}v${-cropRect.height}Z`} fill="rgba(0,0,0,0.55)" fillRule="evenodd" pointerEvents="none" />
                  <rect x={cropRect.x} y={cropRect.y} width={cropRect.width} height={cropRect.height} fill="none" stroke="#fff" strokeWidth={1.5 / s} pointerEvents="none" />
                  {[1, 2].map((i) => (
                    <g key={i} stroke="rgba(255,255,255,0.5)" strokeWidth={1 / s} pointerEvents="none">
                      <line x1={cropRect.x + (cropRect.width * i) / 3} y1={cropRect.y} x2={cropRect.x + (cropRect.width * i) / 3} y2={cropRect.y + cropRect.height} />
                      <line x1={cropRect.x} y1={cropRect.y + (cropRect.height * i) / 3} x2={cropRect.x + cropRect.width} y2={cropRect.y + (cropRect.height * i) / 3} />
                    </g>
                  ))}
                  {(['nw', 'ne', 'sw', 'se'] as const).map((c) => {
                    const hx = c.includes('w') ? cropRect.x : cropRect.x + cropRect.width;
                    const hy = c.includes('n') ? cropRect.y : cropRect.y + cropRect.height;
                    return (
                      <rect key={c} className={`crop-handle crop-${c}`} x={hx - 8 / s} y={hy - 8 / s} width={16 / s} height={16 / s} fill="#fff" stroke="#2f5bea" strokeWidth={2 / s}
                        onPointerDown={(e) => { e.stopPropagation(); stageRef.current?.setPointerCapture(e.pointerId); gesture.current = { kind: 'crop-resize', corner: c, orig: cropRect }; }} />
                    );
                  })}
                </g>
              )}
              {draftRect && <rect x={draftRect.x} y={draftRect.y} width={draftRect.width} height={draftRect.height} fill="rgba(225,29,72,0.15)" stroke="#e11d48" strokeWidth={1.5 / s} strokeDasharray={`${5 / s} ${4 / s}`} />}
            </svg>
            {editing && (() => {
              const o = objects.find((x) => x.id === editing);
              if (!o || o.type !== 'text') return null;
              return (
                <TextBox
                  obj={o}
                  scale={s}
                  onCommit={(text) => {
                    setEditing(null);
                    if (!text.trim()) commit({ objects: objectsRef.current.filter((x) => x.id !== o.id) });
                    else if (text !== o.text) updateObject(o.id, (cur) => ({ ...cur, text }) as ImgObject);
                  }}
                />
              );
            })()}
          </div>
          {busy && <div className="img-busy"><span className="spinner" /> Working…</div>}
        </div>

        {panel === 'adjust' && (
          <aside className="side-panel" aria-label="Adjustments">
            <h3>Filters</h3>
            <div className="filter-grid">
              {(Object.keys(FILTER_LABELS) as FilterPreset[]).map((f) => (
                <button key={f} type="button" className={cx('filter-tile', look.filter === f && 'is-active')} onClick={() => setLook((l) => ({ ...l, filter: f }))}>
                  {filterThumbs?.[f] && <img src={filterThumbs[f]} alt="" />}
                  <span>{FILTER_LABELS[f]}</span>
                </button>
              ))}
            </div>
            <h3>Adjust</h3>
            {ADJUST_FIELDS.map((f) => (
              <label key={f.key} className="slider-row">
                <span>{f.label}</span>
                <input type="range" min={f.min} max={f.max} value={look.adjustments[f.key]} onChange={(e) => setLook((l) => ({ ...l, adjustments: { ...l.adjustments, [f.key]: Number(e.target.value) } }))} onDoubleClick={() => setLook((l) => ({ ...l, adjustments: { ...l.adjustments, [f.key]: 0 } }))} />
                <output>{look.adjustments[f.key]}</output>
              </label>
            ))}
            <label className="slider-row">
              <span>Sharpen</span>
              <input type="range" min={0} max={100} value={look.sharpen} onChange={(e) => setLook((l) => ({ ...l, sharpen: Number(e.target.value) }))} />
              <output>{look.sharpen}</output>
            </label>
            <label className="slider-row">
              <span>Blur</span>
              <input type="range" min={0} max={40} value={look.blur} onChange={(e) => setLook((l) => ({ ...l, blur: Number(e.target.value) }))} />
              <output>{look.blur}</output>
            </label>
            <h3>Straighten</h3>
            <label className="slider-row">
              <span>Angle</span>
              <input type="range" min={-45} max={45} step={0.5} value={straighten} onChange={(e) => setStraighten(Number(e.target.value))} />
              <output>{straighten}°</output>
            </label>
            <div className="panel-actions">
              <button type="button" className="btn btn-text" disabled={lookIsIdentity(look) && straighten === 0} onClick={() => { setLook(NO_LOOK); setStraighten(0); }}>Reset</button>
              <span className="spacer" />
              <button
                type="button"
                className="btn btn-primary"
                disabled={lookIsIdentity(look) && straighten === 0}
                onClick={() => {
                  const l = look;
                  const angle = straighten;
                  runOp((px) => {
                    let out = lookIsIdentity(l) ? px : applyLook(px, l);
                    if (angle) out = rotateArbitrary(out, angle, null);
                    return out;
                  }, { bakeObjects: angle !== 0 });
                  setLook(NO_LOOK);
                  setStraighten(0);
                }}
              >
                Apply
              </button>
            </div>
            {straighten !== 0 && <p className="panel-note">Straightening is shown after Apply; the corners become transparent — crop them off afterwards.</p>}
          </aside>
        )}
        {panel === 'resize' && <ResizePanel width={W} height={H} onApply={(w, h) => { runOp((px) => resizePixels(px, w, h)); setPanel(null); }} onClose={() => setPanel(null)} />}
      </div>
    </div>
  );
});

function ResizePanel({ width, height, onApply, onClose }: { width: number; height: number; onApply: (w: number, h: number) => void; onClose: () => void }) {
  const [w, setW] = useState(width);
  const [h, setH] = useState(height);
  const [lock, setLock] = useState(true);
  const ratio = width / height;
  const setPct = (p: number) => {
    setW(Math.max(1, Math.round(width * p)));
    setH(Math.max(1, Math.round(height * p)));
  };
  return (
    <aside className="side-panel" aria-label="Resize">
      <h3>Resize image</h3>
      <p className="panel-note">Currently {width} × {height} px</p>
      <div className="grid-2">
        <label className="field"><span className="field-label">Width (px)</span>
          <input className="input" type="number" min={1} max={30000} value={w} onChange={(e) => { const v = Math.max(1, Number(e.target.value) || 1); setW(v); if (lock) setH(Math.max(1, Math.round(v / ratio))); }} />
        </label>
        <label className="field"><span className="field-label">Height (px)</span>
          <input className="input" type="number" min={1} max={30000} value={h} onChange={(e) => { const v = Math.max(1, Number(e.target.value) || 1); setH(v); if (lock) setW(Math.max(1, Math.round(v * ratio))); }} />
        </label>
      </div>
      <label className="check"><input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} /> Keep proportions</label>
      <div className="chip-row">
        {[0.25, 0.5, 0.75, 2].map((p) => <button key={p} type="button" className="chip" onClick={() => setPct(p)}>{p * 100}%</button>)}
        {[3840, 1920, 1280, 800].filter((x) => x < Math.max(width, height)).map((x) => (
          <button key={x} type="button" className="chip" onClick={() => setPct(x / Math.max(width, height))}>{x}px</button>
        ))}
      </div>
      <div className="panel-actions">
        <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" disabled={w === width && h === height} onClick={() => onApply(w, h)}>Apply</button>
      </div>
    </aside>
  );
}

function TextBox({ obj, scale, onCommit }: { obj: Extract<ImgObject, { type: 'text' }>; scale: number; onCommit: (t: string) => void }) {
  const [text, setText] = useState(obj.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.width = '0px';
    el.style.height = '0px';
    el.style.width = `${Math.max(el.scrollWidth + 8, 40)}px`;
    el.style.height = `${el.scrollHeight}px`;
  }, [text, scale]);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit(text);
  };
  return (
    <textarea
      ref={ref}
      className="img-text-edit"
      value={text}
      wrap="off"
      spellCheck
      placeholder="Type…"
      style={{
        left: obj.x * scale,
        top: obj.y * scale,
        fontSize: obj.size * scale,
        lineHeight: 1.2,
        fontFamily: obj.font,
        fontWeight: obj.bold ? 700 : 400,
        fontStyle: obj.italic ? 'italic' : 'normal',
        color: obj.color,
        paddingTop: obj.size * 0.1 * scale,
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}
