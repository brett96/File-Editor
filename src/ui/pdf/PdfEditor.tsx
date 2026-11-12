import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useTabActive } from '../tab-active';
import {
  ArrowDown,
  ArrowUp,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Circle,
  Copy,
  Eraser,
  FilePlus2,
  Highlighter,
  Image as ImageIcon,
  Link as LinkIcon,
  Minus,
  MousePointer2,
  PenLine,
  Redo2,
  RotateCcw,
  RotateCw,
  Square,
  TextCursorInput,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react';
import {
  PDF_FONTS,
  PDF_LINE_HEIGHT,
  newId,
  type PdfFontFamily,
  type PdfObject,
  type PdfPageModel,
  type PdfSession,
  type PdfSource,
  type PdfTextObject,
} from '../../core/pdf/types';
import { getHost, type OpenedFile } from '../../platform/host';
import { ColorPicker, Divider, IconButton, MenuItem, Popover, PromptModal, Select, cx } from '../components';
import { IMAGE_EXTENSIONS, loadImageFile } from '../image-utils';
import { FindBar } from '../FindBar';
import { DEFAULT_SEARCH, findMatches, replaceMatches, type SearchOptions, type TextMatch } from '../../core/search';
import { usePinchZoom } from '../usePinchZoom';
import { ALL_HANDLES, CORNER_HANDLES, HANDLE_CURSOR, HANDLE_POS, mapPoint, resizeBox, type Box, type Handle } from '../resize';
import { PageCanvas, PdfSourceCache, extractTextRuns, type TextRun } from './PageCanvas';

export interface PdfEditorHandle {
  getSession(): PdfSession;
}

type Tool = 'select' | 'text' | 'edit' | 'rect' | 'ellipse' | 'line' | 'highlight' | 'whiteout' | 'ink' | 'link';

interface Props {
  bytes: Uint8Array;
  zoom: number;
  onChange: () => void;
  onError: (message: string, kind?: 'error' | 'info') => void;
  /** Pinch / Ctrl+wheel zoom requests. */
  onZoom?: (zoom: number) => void;
  onPageCount?: (n: number) => void;
  /** Turns any picked file into PDF bytes (handles passwords and conversion); null if cancelled. */
  loadAsPdf: (file: OpenedFile) => Promise<Uint8Array | null>;
}

interface Style {
  fontFamily: PdfFontFamily;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: string;
  stroke: string;
  fill: string | null;
  strokeWidth: number;
  highlight: string;
  whiteout: string;
}

const DEFAULT_STYLE: Style = {
  fontFamily: 'Helvetica',
  fontSize: 12,
  bold: false,
  italic: false,
  color: '#111111',
  stroke: '#c00000',
  fill: null,
  strokeWidth: 2,
  highlight: '#ffe066',
  whiteout: '#ffffff',
};

const PT_TO_PX = 96 / 72;

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function hasBox(o: PdfObject): o is Extract<PdfObject, { width: number }> {
  return 'width' in o;
}

/** A search hit on a page: in an original text run, or in a text object the user added/edited. */
interface PdfHit {
  key: string;
  pageId: string;
  pageIndex: number;
  kind: 'run' | 'obj';
  /** run index in the page's text-run list, or the object id */
  ref: number | string;
  match: TextMatch;
  /** view-space rectangle on the page (points) */
  rect: { x: number; y: number; width: number; height: number };
}

const RUN_FAMILY_CSS: Record<TextRun['family'], string> = {
  'sans-serif': PDF_FONTS.Helvetica.css,
  serif: PDF_FONTS.Times.css,
  monospace: PDF_FONTS.Courier.css,
};

let runMeasureCtx: CanvasRenderingContext2D | null = null;
/** x-offset and width of text[start..end) inside a run, scaled to the run's real width. */
function runSlice(run: TextRun, start: number, end: number): { x: number; width: number } {
  runMeasureCtx ??= document.createElement('canvas').getContext('2d');
  const ctx = runMeasureCtx;
  if (!ctx || !run.text.length) return { x: run.x, width: run.width };
  ctx.font = `${run.fontSize}px ${RUN_FAMILY_CSS[run.family]}`;
  const full = ctx.measureText(run.text).width || 1;
  const k = run.width / full;
  const before = ctx.measureText(run.text.slice(0, start)).width * k;
  const w = ctx.measureText(run.text.slice(start, end)).width * k;
  return { x: run.x + before, width: Math.max(2, w) };
}

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(line: string, o: PdfTextObject): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return line.length * o.fontSize * 0.55;
  measureCtx.font = `${o.italic ? 'italic ' : ''}${o.bold ? 700 : 400} ${o.fontSize}px ${PDF_FONTS[o.fontFamily].css}`;
  return measureCtx.measureText(line).width;
}

/** Fits an object into a new bounding box (resize from any of the 8 handles). */
function resizeObject(o: PdfObject, from: Box, to: Box): PdfObject {
  switch (o.type) {
    case 'text': {
      const k = from.height > 0 ? to.height / from.height : 1;
      const fontSize = Math.max(4, Math.min(400, Math.round(o.fontSize * k * 10) / 10));
      return { ...o, x: to.x, y: to.y, fontSize };
    }
    case 'line': {
      const [x1, y1] = mapPoint(from, to, o.x1, o.y1);
      const [x2, y2] = mapPoint(from, to, o.x2, o.y2);
      return { ...o, x1, y1, x2, y2 };
    }
    case 'ink':
      return { ...o, points: o.points.map(([x, y]) => mapPoint(from, to, x, y)) };
    default:
      return { ...o, x: to.x, y: to.y, width: to.width, height: to.height };
  }
}

function bounds(o: PdfObject): { x: number; y: number; width: number; height: number } {
  switch (o.type) {
    case 'line':
      return { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), width: Math.abs(o.x2 - o.x1), height: Math.abs(o.y2 - o.y1) };
    case 'ink': {
      const xs = o.points.map((p) => p[0]);
      const ys = o.points.map((p) => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    }
    case 'text': {
      const lines = o.text.split('\n');
      const w = Math.max(...lines.map((l) => textWidth(l, o)));
      return { x: o.x, y: o.y, width: w, height: lines.length * o.fontSize * PDF_LINE_HEIGHT };
    }
    default:
      return { x: o.x, y: o.y, width: o.width, height: o.height };
  }
}

function moveObject(o: PdfObject, dx: number, dy: number): PdfObject {
  switch (o.type) {
    case 'line':
      return { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy };
    case 'ink':
      return { ...o, points: o.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
    default:
      return { ...o, x: o.x + dx, y: o.y + dy };
  }
}

/** Picks the page background and the ink colour under a text run from the rendered canvas. */
function sampleColors(canvas: HTMLCanvasElement | undefined, run: TextRun, pageW: number): { bg: string; fg: string } {
  const fallback = { bg: '#ffffff', fg: '#000000' };
  if (!canvas) return fallback;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return fallback;
  const k = canvas.width / pageW;
  const x0 = Math.max(0, Math.floor(run.x * k));
  const y0 = Math.max(0, Math.floor(run.y * k));
  const w = Math.max(1, Math.min(canvas.width - x0, Math.ceil(run.width * k)));
  const h = Math.max(1, Math.min(canvas.height - y0, Math.ceil(run.height * k)));
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(x0, y0, w, h).data;
  } catch {
    return fallback;
  }
  // background = most common colour (quantised); foreground = pixel furthest from it
  const counts = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) {
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let bgKey = 0xfff;
  let best = -1;
  for (const [key, n] of counts) if (n > best) [best, bgKey] = [n, key];
  const bg = [((bgKey >> 8) & 15) * 17, ((bgKey >> 4) & 15) * 17, (bgKey & 15) * 17];
  let fg = [0, 0, 0];
  let far = -1;
  for (let i = 0; i < data.length; i += 4) {
    const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
    if (d > far) {
      far = d;
      fg = [data[i], data[i + 1], data[i + 2]];
    }
  }
  const hex = (c: number[]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  return { bg: hex(bg), fg: far > 60 ? hex(fg) : '#000000' };
}

async function buildPages(cache: PdfSourceCache, source: PdfSource): Promise<PdfPageModel[]> {
  const doc = await cache.get(source);
  const pages: PdfPageModel[] = [];
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    pages.push({ id: newId('p'), sourceId: source.id, sourcePage: i, width: vp.width, height: vp.height, rotation: 0, objects: [] });
  }
  return pages;
}

type Gesture =
  | { kind: 'move'; pageId: string; objId: string; start: [number, number]; orig: PdfObject }
  | { kind: 'resize'; pageId: string; objId: string; start: [number, number]; orig: PdfObject; box: Box; handle: Handle }
  | { kind: 'draw'; pageId: string; objId: string; start: [number, number] };

export const PdfEditor = forwardRef<PdfEditorHandle, Props>(function PdfEditor({ bytes, zoom, onChange, onError, onPageCount, loadAsPdf , onZoom }, ref) {
  const cache = useMemo(() => new PdfSourceCache(), []);
  const [sources, setSources] = useState<PdfSource[]>(() => [{ id: 'src0', bytes }]);
  const [pages, setPagesRaw] = useState<PdfPageModel[] | null>(null);
  const past = useRef<PdfPageModel[][]>([]);
  const future = useRef<PdfPageModel[][]>([]);
  const [, bump] = useState(0);
  const [tool, setTool] = useState<Tool>('select');
  const [style, setStyle] = useState<Style>(DEFAULT_STYLE);
  const [selected, setSelected] = useState<{ pageId: string; objId: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);
  const [runs, setRuns] = useState<Record<string, TextRun[]>>({});
  const addRuns = useCallback((batch: Record<string, TextRun[]>) => {
    Object.assign(runsRef.current, batch);
    setRuns((prev) => ({ ...prev, ...batch }));
  }, []);
  const [linkPrompt, setLinkPrompt] = useState<{ pageId: string; objId: string; initial: string } | null>(null);
  const [dragThumb, setDragThumb] = useState<number | null>(null);
  // the page list takes a third of a phone screen, so it starts hidden there
  const [showThumbs, setShowThumbs] = useState(() => typeof window === 'undefined' || window.matchMedia('(min-width: 721px)').matches);
  const canvases = useRef<Record<string, HTMLCanvasElement>>({});
  const gesture = useRef<Gesture | null>(null);
  /** Last press on an object, for double-click / double-tap detection (see startMove). */
  const lastPress = useRef<{ id: string; t: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [pagesEl, setPagesEl] = useState<HTMLDivElement | null>(null);
  // ── find & replace state ───────────────────────────────────────────────
  const [find, setFind] = useState<{ replace: boolean; token: number } | null>(null);
  const [query, setQuery] = useState('');
  const [searchOpts, setSearchOpts] = useState<SearchOptions>(DEFAULT_SEARCH);
  const [hitKey, setHitKey] = useState<string | null>(null);
  const [indexProgress, setIndexProgress] = useState<{ done: number; total: number } | null>(null);
  const runsRef = useRef<Record<string, TextRun[]>>({});
  const pageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const scale = zoom * PT_TO_PX;

  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  useImperativeHandle(ref, () => ({ getSession: () => ({ sources: sourcesRef.current, pages: pagesRef.current ?? [] }) }), []);

  useEffect(() => {
    let alive = true;
    buildPages(cache, sources[0])
      .then((p) => alive && setPagesRaw(p))
      .catch((err) => alive && onError(err instanceof Error ? err.message : 'Could not read this PDF.'));
    return () => {
      alive = false;
      void cache.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache]);

  useEffect(() => {
    if (pages) onPageCount?.(pages.length);
  }, [pages, onPageCount]);

  // ── history ──────────────────────────────────────────────────────────────
  const snapshot = useCallback(() => {
    if (!pagesRef.current) return;
    past.current.push(pagesRef.current);
    if (past.current.length > 200) past.current.shift();
    future.current = [];
  }, []);

  const commit = useCallback(
    (updater: (p: PdfPageModel[]) => PdfPageModel[]) => {
      if (!pagesRef.current) return;
      snapshot();
      const next = updater(pagesRef.current);
      pagesRef.current = next;
      setPagesRaw(next);
      onChange();
    },
    [onChange, snapshot],
  );

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev || !pagesRef.current) return;
    future.current.push(pagesRef.current);
    setPagesRaw(prev);
    setSelected(null);
    setEditingId(null);
    onChange();
    bump((n) => n + 1);
  }, [onChange]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next || !pagesRef.current) return;
    past.current.push(pagesRef.current);
    setPagesRaw(next);
    setSelected(null);
    onChange();
    bump((n) => n + 1);
  }, [onChange]);

  const updateObject = useCallback(
    (pageId: string, objId: string, patch: (o: PdfObject) => PdfObject, record = true) => {
      const apply = (list: PdfPageModel[]) =>
        list.map((p) => (p.id !== pageId ? p : { ...p, objects: p.objects.map((o) => (o.id === objId ? patch(o) : o)) }));
      if (record) commit(apply);
      else if (pagesRef.current) {
        const next = apply(pagesRef.current);
        pagesRef.current = next;
        setPagesRaw(next);
      }
    },
    [commit],
  );

  const addObject = useCallback((pageId: string, obj: PdfObject, record = true) => {
    const apply = (list: PdfPageModel[]) => list.map((p) => (p.id === pageId ? { ...p, objects: [...p.objects, obj] } : p));
    if (record) commit(apply);
    else if (pagesRef.current) {
      const next = apply(pagesRef.current);
      pagesRef.current = next;
      setPagesRaw(next);
    }
  }, [commit]);

  const removeObject = useCallback((pageId: string, objId: string) => {
    commit((list) => list.map((p) => (p.id === pageId ? { ...p, objects: p.objects.filter((o) => o.id !== objId) } : p)));
    setSelected(null);
    setEditingId(null);
  }, [commit]);

  const selectedObj = useMemo(() => {
    if (!selected || !pages) return null;
    return pages.find((p) => p.id === selected.pageId)?.objects.find((o) => o.id === selected.objId) ?? null;
  }, [selected, pages]);

  // ── text runs for "edit existing text" ───────────────────────────────────
  useEffect(() => {
    if (tool !== 'edit' || !pages) return;
    let alive = true;
    (async () => {
      const want = pages.filter((p) => p.sourceId && !runs[`${p.sourceId}:${p.sourcePage}`]);
      for (const p of want) {
        const src = sources.find((s) => s.id === p.sourceId);
        if (!src) continue;
        try {
          const r = await extractTextRuns(await cache.page(src, p.sourcePage));
          if (!alive) return;
          addRuns({ [`${p.sourceId}:${p.sourcePage}`]: r });
        } catch {
          /* page without extractable text */
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, pages, sources, cache]);

  // ── track the page in view ────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pages) return;
    const onScroll = () => {
      const mid = el.getBoundingClientRect().top + el.clientHeight / 2;
      let best = 0;
      let bestD = Infinity;
      pages.forEach((p, i) => {
        const r = pageRefs.current[p.id]?.getBoundingClientRect();
        if (!r) return;
        const d = Math.abs((r.top + r.bottom) / 2 - mid);
        if (d < bestD) [bestD, best] = [d, i];
      });
      setCurrent(best);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [pages]);

  const scrollToPage = (i: number) => {
    const p = pagesRef.current?.[i];
    if (p) pageRefs.current[p.id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setCurrent(i);
  };

  // ── keyboard ──────────────────────────────────────────────────────────────
  const tabActive0 = useTabActive();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!tabActive0.current) return;
      const target = e.target as HTMLElement;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], .modal')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (selected && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        removeObject(selected.pageId, selected.objId);
      } else if (e.key === 'Escape') {
        setSelected(null);
        setTool('select');
      } else if (selected && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        updateObject(selected.pageId, selected.objId, (o) => moveObject(o, dx, dy));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, undo, redo, removeObject, updateObject]);

  // ── page operations ──────────────────────────────────────────────────────
  const rotatePage = (i: number, delta: 90 | -90) =>
    commit((list) => list.map((p, j) => (j === i ? { ...p, rotation: ((((p.rotation + delta) % 360) + 360) % 360) as PdfPageModel['rotation'] } : p)));

  const deletePage = (i: number) => {
    if ((pagesRef.current?.length ?? 0) <= 1) {
      onError('A PDF needs at least one page.');
      return;
    }
    commit((list) => list.filter((_, j) => j !== i));
    setSelected(null);
  };

  const duplicatePage = (i: number) =>
    commit((list) => {
      const p = list[i];
      const copy: PdfPageModel = { ...p, id: newId('p'), objects: p.objects.map((o) => ({ ...o, id: newId() })) };
      return [...list.slice(0, i + 1), copy, ...list.slice(i + 1)];
    });

  const movePage = (from: number, to: number) => {
    if (from === to) return;
    commit((list) => {
      const next = [...list];
      const [p] = next.splice(from, 1);
      next.splice(to, 0, p);
      return next;
    });
    setCurrent(to);
  };

  const insertBlank = (at: number) => {
    const ref = pagesRef.current?.[Math.min(at, (pagesRef.current?.length ?? 1) - 1)];
    const w = ref ? (ref.rotation % 180 ? ref.height : ref.width) : 612;
    const h = ref ? (ref.rotation % 180 ? ref.width : ref.height) : 792;
    commit((list) => [...list.slice(0, at), { id: newId('p'), sourceId: null, sourcePage: 0, width: w, height: h, rotation: 0, objects: [] }, ...list.slice(at)]);
    setTimeout(() => scrollToPage(at), 50);
  };

  const insertFromFile = async (at: number) => {
    try {
      const [file] = await getHost().openFiles({
        extensions: ['pdf', 'docx', 'doc', 'odt', 'rtf', 'md', 'html', 'htm', 'txt'],
        description: 'Documents',
      });
      if (!file) return;
      const pdfBytes = await loadAsPdf(file);
      if (!pdfBytes) return;
      const source: PdfSource = { id: newId('src'), bytes: pdfBytes, name: file.name };
      const newPages = await buildPages(cache, source);
      setSources((s) => [...s, source]);
      sourcesRef.current = [...sourcesRef.current, source];
      commit((list) => [...list.slice(0, at), ...newPages, ...list.slice(at)]);
      setTimeout(() => scrollToPage(at), 50);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not insert pages from that file.');
    }
  };

  // ── images ───────────────────────────────────────────────────────────────
  const insertImage = async () => {
    const list = pagesRef.current;
    if (!list) return;
    try {
      const [file] = await getHost().openFiles({ extensions: IMAGE_EXTENSIONS, description: 'Images' });
      if (!file) return;
      const img = await loadImageFile(file.blob, file.name);
      const page = list[current] ?? list[0];
      const maxW = page.width * 0.5;
      const maxH = page.height * 0.5;
      const k = Math.min(1, maxW / (img.width * 0.75), maxH / (img.height * 0.75));
      const w = img.width * 0.75 * k;
      const h = img.height * 0.75 * k;
      const obj: PdfObject = { id: newId(), type: 'image', x: (page.width - w) / 2, y: (page.height - h) / 2, width: w, height: h, dataUrl: img.dataUrl };
      addObject(page.id, obj);
      setSelected({ pageId: page.id, objId: obj.id });
      setTool('select');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not insert the image.');
    }
  };

  // ── pointer handling ─────────────────────────────────────────────────────
  /** Converts a pointer position to view-space points on a page (undoing zoom and CSS rotation). */
  const toLocal = (e: { clientX: number; clientY: number }, page: PdfPageModel): [number, number] => {
    const el = pageRefs.current[page.id]?.querySelector<HTMLElement>('.pdf-page-inner');
    if (!el) return [0, 0];
    const r = el.getBoundingClientRect();
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    const t = (-page.rotation * Math.PI) / 180;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const x = dx * Math.cos(t) - dy * Math.sin(t);
    const y = dx * Math.sin(t) + dy * Math.cos(t);
    return [(x + (page.width * scale) / 2) / scale, (y + (page.height * scale) / 2) / scale];
  };

  const onPagePointerDown = (e: RPointerEvent<HTMLDivElement>, page: PdfPageModel, index: number) => {
    if (e.button !== 0) return;
    setCurrent(index);
    const [x, y] = toLocal(e, page);
    if (tool === 'select' || tool === 'edit') {
      setSelected(null);
      setEditingId(null);
      return;
    }
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (tool === 'text') {
      const obj: PdfTextObject = {
        id: newId(), type: 'text', x, y: y - style.fontSize * 0.6, text: '', fontSize: style.fontSize,
        fontFamily: style.fontFamily, bold: style.bold, italic: style.italic, color: style.color,
      };
      addObject(page.id, obj);
      setSelected({ pageId: page.id, objId: obj.id });
      setEditingId(obj.id);
      setTool('select');
      return;
    }
    snapshot();
    const id = newId();
    let obj: PdfObject;
    switch (tool) {
      case 'line':
        obj = { id, type: 'line', x1: x, y1: y, x2: x, y2: y, stroke: style.stroke, strokeWidth: style.strokeWidth };
        break;
      case 'ink':
        obj = { id, type: 'ink', points: [[x, y]], stroke: style.stroke, strokeWidth: style.strokeWidth };
        break;
      case 'highlight':
        obj = { id, type: 'highlight', x, y, width: 0, height: 0, color: style.highlight };
        break;
      case 'whiteout':
        obj = { id, type: 'whiteout', x, y, width: 0, height: 0, color: style.whiteout };
        break;
      case 'link':
        obj = { id, type: 'link', x, y, width: 0, height: 0, url: '' };
        break;
      default:
        obj = { id, type: tool, x, y, width: 0, height: 0, stroke: style.stroke, fill: style.fill, strokeWidth: style.strokeWidth };
    }
    addObject(page.id, obj, false);
    gesture.current = { kind: 'draw', pageId: page.id, objId: id, start: [x, y] };
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>, page: PdfPageModel) => {
    const g = gesture.current;
    if (!g || g.pageId !== page.id) return;
    const [x, y] = toLocal(e, page);
    const [sx, sy] = g.start;
    if (g.kind === 'draw') {
      updateObject(page.id, g.objId, (o) => {
        if (o.type === 'line') {
          let x2 = x;
          let y2 = y;
          if (e.shiftKey) {
            // snap to 45°
            const ang = Math.round(Math.atan2(y - sy, x - sx) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(x - sx, y - sy);
            x2 = sx + Math.cos(ang) * len;
            y2 = sy + Math.sin(ang) * len;
          }
          return { ...o, x2, y2 };
        }
        if (o.type === 'ink') return { ...o, points: [...o.points, [x, y]] };
        if (hasBox(o)) {
          let w = x - sx;
          let h = y - sy;
          if (e.shiftKey && (o.type === 'rect' || o.type === 'ellipse')) {
            const m = Math.max(Math.abs(w), Math.abs(h));
            w = Math.sign(w || 1) * m;
            h = Math.sign(h || 1) * m;
          }
          return { ...o, x: Math.min(sx, sx + w), y: Math.min(sy, sy + h), width: Math.abs(w), height: Math.abs(h) };
        }
        return o;
      }, false);
    } else if (g.kind === 'move') {
      const moved = moveObject(g.orig, x - sx, y - sy);
      updateObject(page.id, g.objId, () => moved, false);
    } else if (g.kind === 'resize') {
      // images and text keep their proportions (hold Shift to stretch an image freely)
      const keepAspect = g.orig.type === 'text' || ((g.orig.type === 'image') !== e.shiftKey);
      const to = resizeBox(g.box, g.handle, x - sx, y - sy, { keepAspect, min: 4 });
      updateObject(page.id, g.objId, () => resizeObject(g.orig, g.box, to), false);
    }
  };

  const onPointerUp = (page: PdfPageModel) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.pageId !== page.id) return;
    const obj = pagesRef.current?.find((p) => p.id === page.id)?.objects.find((o) => o.id === g.objId);
    if ((g.kind === 'move' || g.kind === 'resize') && obj === g.orig) {
      // a click that didn't move anything: drop the undo step it reserved
      past.current.pop();
      return;
    }
    if (g.kind === 'draw' && obj) {
      const b = bounds(obj);
      const tiny = obj.type === 'ink' ? obj.points.length < 2 : Math.max(b.width, b.height) < 3;
      if (tiny) {
        // discard accidental clicks without leaving a history entry
        past.current.pop();
        const next = pagesRef.current!.map((p) => (p.id === page.id ? { ...p, objects: p.objects.filter((o) => o.id !== obj.id) } : p));
        pagesRef.current = next;
        setPagesRaw(next);
        return;
      }
      setSelected({ pageId: page.id, objId: obj.id });
      if (obj.type === 'link') setLinkPrompt({ pageId: page.id, objId: obj.id, initial: '' });
      if (tool !== 'ink' && tool !== 'highlight') setTool('select');
    }
    onChange();
  };

  const startMove = (e: RPointerEvent, page: PdfPageModel, obj: PdfObject) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (tool !== 'select' && tool !== 'edit') return;
    setSelected({ pageId: page.id, objId: obj.id });
    if (editingId === obj.id) return;
    // Re-open text for editing: one click with "Edit existing text", a double-click/tap with
    // Select. Detected here because the pointer capture below retargets the browser's own
    // dblclick to the page, so an onDoubleClick on the text never fires.
    const now = performance.now();
    const again = lastPress.current?.id === obj.id && now - lastPress.current.t < 450;
    lastPress.current = { id: obj.id, t: now };
    if (obj.type === 'text' && (tool === 'edit' || again)) {
      e.preventDefault();
      lastPress.current = null;
      setEditingId(obj.id);
      return;
    }
    setEditingId(null);
    e.preventDefault();
    pageRefs.current[page.id]?.querySelector<HTMLElement>('.pdf-page-inner')?.setPointerCapture(e.pointerId);
    snapshot();
    gesture.current = { kind: 'move', pageId: page.id, objId: obj.id, start: toLocal(e, page), orig: obj };
  };

  const startResize = (e: RPointerEvent, page: PdfPageModel, obj: PdfObject, handle: Handle) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    pageRefs.current[page.id]?.querySelector<HTMLElement>('.pdf-page-inner')?.setPointerCapture(e.pointerId);
    snapshot();
    gesture.current = { kind: 'resize', pageId: page.id, objId: obj.id, start: toLocal(e, page), orig: obj, box: bounds(obj), handle };
  };

  /**
   * Saves typed text. Runs when the box loses focus, on Escape, and when the box is closed
   * any other way (clicking the page, another text run, a tool) — so edits are never lost.
   */
  const commitText = (pageId: string, objId: string, text: string) => {
    setEditingId((cur) => (cur === objId ? null : cur));
    const o = pagesRef.current?.find((p) => p.id === pageId)?.objects.find((x) => x.id === objId);
    if (!o || o.type !== 'text') return;
    if (!text.trim() && !o.cover) {
      commit((list) => list.map((p) => (p.id === pageId ? { ...p, objects: p.objects.filter((x) => x.id !== objId) } : p)));
      setSelected((cur) => (cur?.objId === objId ? null : cur));
    } else if (text !== o.text) {
      updateObject(pageId, objId, (cur) => ({ ...cur, text }) as PdfObject);
    }
  };

  /** A text object that covers an original text run and retypes it (optionally with new text). */
  const buildRunReplacement = (page: PdfPageModel, run: TextRun, text: string = run.text): PdfTextObject => {
    const { bg, fg } = sampleColors(canvases.current[page.id], run, page.width);
    const family: PdfFontFamily = run.family === 'monospace' ? 'Courier' : run.family === 'serif' ? 'Times' : 'Helvetica';
    const fontSize = Math.max(4, run.fontSize);
    const pad = 0.75;
    return {
      id: newId(),
      type: 'text',
      x: run.x,
      y: run.baseline - PDF_FONTS[family].baseline * fontSize,
      text,
      fontSize,
      fontFamily: family,
      bold: false,
      italic: false,
      color: fg,
      cover: { x: run.x - pad, y: run.y - pad, width: run.width + pad * 2, height: run.height + pad * 2, color: bg },
    };
  };

  const replaceRun = (e: { stopPropagation(): void; preventDefault(): void }, page: PdfPageModel, run: TextRun) => {
    e.stopPropagation();
    e.preventDefault();
    const { bg, fg } = sampleColors(canvases.current[page.id], run, page.width);
    const family: PdfFontFamily = run.family === 'monospace' ? 'Courier' : run.family === 'serif' ? 'Times' : 'Helvetica';
    const fontSize = Math.max(4, run.fontSize);
    const pad = 0.75;
    const obj: PdfTextObject = {
      id: newId(),
      type: 'text',
      x: run.x,
      // align our baseline with the original baseline
      y: run.baseline - PDF_FONTS[family].baseline * fontSize,
      text: run.text,
      fontSize,
      fontFamily: family,
      bold: false,
      italic: false,
      color: fg,
      cover: { x: run.x - pad, y: run.y - pad, width: run.width + pad * 2, height: run.height + pad * 2, color: bg },
    };
    addObject(page.id, obj);
    setSelected({ pageId: page.id, objId: obj.id });
    setEditingId(obj.id);
  };

  // ── style changes apply to the selection and become the new defaults ─────
  const applyStyle = (patch: Partial<Style>) => {
    setStyle((s) => ({ ...s, ...patch }));
    if (!selected || !selectedObj) return;
    updateObject(selected.pageId, selected.objId, (o) => {
      switch (o.type) {
        case 'text':
          return {
            ...o,
            fontFamily: patch.fontFamily ?? o.fontFamily,
            fontSize: patch.fontSize ?? o.fontSize,
            bold: patch.bold ?? o.bold,
            italic: patch.italic ?? o.italic,
            color: patch.color ?? o.color,
          };
        case 'rect':
        case 'ellipse':
          return { ...o, stroke: patch.stroke !== undefined ? patch.stroke : o.stroke, fill: patch.fill !== undefined ? patch.fill : o.fill, strokeWidth: patch.strokeWidth ?? o.strokeWidth };
        case 'line':
        case 'ink':
          return { ...o, stroke: patch.stroke ?? o.stroke, strokeWidth: patch.strokeWidth ?? o.strokeWidth };
        case 'highlight':
          return { ...o, color: patch.highlight ?? o.color };
        case 'whiteout':
          return { ...o, color: patch.whiteout ?? o.color };
        default:
          return o;
      }
    });
  };


  // ── find & replace ────────────────────────────────────────────────────────
  const openFind = useCallback((replace: boolean) => {
    const sel = window.getSelection()?.toString() ?? '';
    if (sel && sel.length < 200 && !sel.includes('\n')) setQuery(sel);
    setFind((f) => ({ replace: replace || !!f?.replace, token: (f?.token ?? 0) + 1 }));
  }, []);

  // Index the text of every page in the background (current page first), so search covers the
  // whole document without blocking the UI. Results stream in as pages are read.
  useEffect(() => {
    if (!find || !query || !pages) return;
    let alive = true;
    (async () => {
      const order = pages.map((_, i) => (current + i) % pages.length);
      const todo = order.map((i) => pages[i]).filter((pg) => pg.sourceId && !runsRef.current[`${pg.sourceId}:${pg.sourcePage}`]);
      if (!todo.length) {
        setIndexProgress(null);
        return;
      }
      const total = pages.length;
      let done = total - todo.length;
      let batch: Record<string, TextRun[]> = {};
      let last = performance.now();
      setIndexProgress({ done, total });
      for (const pg of todo) {
        if (!alive) return;
        const src = sourcesRef.current.find((x) => x.id === pg.sourceId);
        const key = `${pg.sourceId}:${pg.sourcePage}`;
        if (!src || runsRef.current[key] || batch[key]) {
          done++;
          continue;
        }
        try {
          batch[key] = await extractTextRuns(await cache.page(src, pg.sourcePage));
        } catch {
          batch[key] = [];
        }
        done++;
        if (performance.now() - last > 250) {
          addRuns(batch);
          batch = {};
          last = performance.now();
          setIndexProgress({ done, total });
        }
      }
      if (!alive) return;
      addRuns(batch);
      setIndexProgress(null);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find, query, pages?.length, cache, addRuns]);

  const hits = useMemo<PdfHit[]>(() => {
    if (!find || !query || !pages) return [];
    const out: PdfHit[] = [];
    pages.forEach((pg, pageIndex) => {
      const local: PdfHit[] = [];
      const covered = new Set(pg.objects.filter((o): o is PdfTextObject => o.type === 'text' && !!o.cover).map((o) => `${Math.round(o.cover!.x)}:${Math.round(o.cover!.y)}`));
      const pageRunList = pg.sourceId ? runs[`${pg.sourceId}:${pg.sourcePage}`] ?? [] : [];
      pageRunList.forEach((run, ri) => {
        if (covered.has(`${Math.round(run.x - 0.75)}:${Math.round(run.y - 0.75)}`)) return;
        for (const m of findMatches(run.text, query, searchOpts)) {
          const sl = runSlice(run, m.start, m.end);
          local.push({ key: `${pg.id}:r${ri}:${m.start}`, pageId: pg.id, pageIndex, kind: 'run', ref: ri, match: m, rect: { x: sl.x, y: run.y, width: sl.width, height: run.height } });
        }
      });
      for (const o of pg.objects) {
        if (o.type !== 'text') continue;
        for (const m of findMatches(o.text, query, searchOpts)) {
          const before = o.text.slice(0, m.start);
          const line = before.split('\n').length - 1;
          const lineStart = before.lastIndexOf('\n') + 1;
          const lineText = o.text.split('\n')[line];
          const x0 = o.x + textWidth(lineText.slice(0, m.start - lineStart), o);
          const w = textWidth(o.text.slice(m.start, m.end), o);
          local.push({ key: `${pg.id}:o${o.id}:${m.start}`, pageId: pg.id, pageIndex, kind: 'obj', ref: o.id, match: m, rect: { x: x0, y: o.y + line * o.fontSize * PDF_LINE_HEIGHT, width: Math.max(2, w), height: o.fontSize * PDF_LINE_HEIGHT } });
        }
      }
      // reading order: top to bottom, then left to right
      local.sort((a, b) => (Math.abs(a.rect.y - b.rect.y) > 2 ? a.rect.y - b.rect.y : a.rect.x - b.rect.x));
      out.push(...local);
    });
    return out;
  }, [find, query, searchOpts, pages, runs]);

  const hitsByPage = useMemo(() => {
    const m = new Map<string, PdfHit[]>();
    for (const h of hits) {
      const list = m.get(h.pageId);
      if (list) list.push(h);
      else m.set(h.pageId, [h]);
    }
    return m;
  }, [hits]);

  // the current hit is tracked by key; if it disappears (replaced), the next one in reading order takes over
  const lastHitPos = useRef<{ pageIndex: number; y: number; x: number; h: number } | null>(null);
  let currentIndex = hitKey ? hits.findIndex((h) => h.key === hitKey) : -1;
  if (currentIndex < 0 && hits.length) {
    const pos = lastHitPos.current;
    // "same line" is judged by text height: a retyped run sits a point or two off the original
    const sameLine = (y: number) => !!pos && Math.abs(y - pos.y) < Math.max(2, pos.h / 2);
    currentIndex = pos
      ? hits.findIndex((h) => h.pageIndex > pos.pageIndex || (h.pageIndex === pos.pageIndex && (sameLine(h.rect.y) ? h.rect.x >= pos.x : h.rect.y > pos.y)))
      : hits.findIndex((h) => h.pageIndex >= current);
    if (currentIndex < 0) currentIndex = 0;
  }
  const currentHit = currentIndex >= 0 ? hits[currentIndex] : null;

  // new query: forget the old position so we start from the page in view
  useEffect(() => {
    lastHitPos.current = null;
    setHitKey(null);
  }, [query, searchOpts]);

  // scrolling waits for React to draw the new current highlight (effect below)
  const pendingScroll = useRef<string | null>(null);
  const scrollToHit = useCallback((key: string) => {
    pendingScroll.current = key;
  }, []);

  const goHit = (delta: number) => {
    if (!hits.length) return;
    const i = (((currentIndex < 0 ? 0 : currentIndex + delta) % hits.length) + hits.length) % hits.length;
    const h = hits[i];
    lastHitPos.current = { pageIndex: h.pageIndex, y: h.rect.y, x: h.rect.x, h: h.rect.height };
    setHitKey(h.key);
    setCurrent(h.pageIndex);
    scrollToHit(h.key);
  };

  // scroll to the first result while typing, and to each hit navigated to
  useEffect(() => {
    if (!find || !currentHit) return;
    if (!hitKey || pendingScroll.current) {
      pendingScroll.current = null;
      scrollRef.current?.querySelector<HTMLElement>('.search-hit-current')?.scrollIntoView({ block: 'center', inline: 'center' });
    }
  }, [find, currentHit?.key, hitKey]);

  /** Applies replacements for a set of hits to the page list (one undo step). */
  const applyReplacements = (list: PdfHit[], replacement: string) => {
    const byPage = new Map<string, PdfHit[]>();
    for (const h of list) byPage.set(h.pageId, [...(byPage.get(h.pageId) ?? []), h]);
    commit((all) =>
      all.map((pg) => {
        const ph = byPage.get(pg.id);
        if (!ph) return pg;
        const runList = pg.sourceId ? runsRef.current[`${pg.sourceId}:${pg.sourcePage}`] ?? [] : [];
        const added: PdfObject[] = [];
        const runGroups = new Map<number, TextMatch[]>();
        const objGroups = new Map<string, TextMatch[]>();
        for (const h of ph) {
          if (h.kind === 'run') runGroups.set(h.ref as number, [...(runGroups.get(h.ref as number) ?? []), h.match]);
          else objGroups.set(h.ref as string, [...(objGroups.get(h.ref as string) ?? []), h.match]);
        }
        for (const [ri, ms] of runGroups) {
          const run = runList[ri];
          if (run) added.push(buildRunReplacement(pg, run, replaceMatches(run.text, ms, replacement)));
        }
        const objects = pg.objects.map((o) => {
          const ms = objGroups.get(o.id);
          return ms && o.type === 'text' ? { ...o, text: replaceMatches(o.text, ms, replacement) } : o;
        });
        return { ...pg, objects: [...objects, ...added] };
      }),
    );
  };

  const replaceCurrentHit = (replacement: string) => {
    const h = currentHit;
    if (!h) return;
    // continue from just after the replaced text; the next match is picked from the updated
    // list (it may now live in the retyped text object, under a new key)
    const w = replacement ? h.rect.width * (replacement.length / Math.max(1, h.match.end - h.match.start)) : 0;
    lastHitPos.current = { pageIndex: h.pageIndex, y: h.rect.y, x: h.rect.x + w + 0.5, h: h.rect.height };
    setHitKey(null);
    applyReplacements([h], replacement);
    scrollToHit('next');
  };

  const replaceAllHits = (replacement: string) => {
    if (!hits.length) return;
    const n = hits.length;
    applyReplacements(hits, replacement);
    setHitKey(null);
    onError(`Replaced ${n} ${n === 1 ? 'match' : 'matches'}. Undo (Ctrl+Z) puts them all back.`, 'info');
  };

  const closeFind = () => {
    setFind(null);
    setHitKey(null);
  };

  // Ctrl/⌘+F find, Ctrl/⌘+H replace
  const tabActive1 = useTabActive();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!tabActive1.current) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'f' || k === 'h') {
        e.preventDefault();
        openFind(k === 'h');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openFind]);

  // pinch / Ctrl+wheel zoom of the pages only (never the toolbars)
  usePinchZoom(scrollEl, pagesEl, zoom, onZoom, { min: 0.1, max: 5 });

  if (!pages) return <div className="loading">Loading PDF…</div>;

  const kind = selectedObj?.type ?? (tool === 'text' || tool === 'edit' ? 'text' : tool);
  const textStyle = selectedObj?.type === 'text' ? selectedObj : style;
  const strokeStyle = selectedObj && 'stroke' in selectedObj ? selectedObj : style;

  return (
    <div className="editor-root">
      <div className="toolbar" role="toolbar" aria-label="PDF tools">
        <IconButton label="Undo (Ctrl+Z)" disabled={!past.current.length} onClick={undo}><Undo2 size={16} /></IconButton>
        <IconButton label="Redo (Ctrl+Y)" disabled={!future.current.length} onClick={redo}><Redo2 size={16} /></IconButton>
        <Divider />
        <IconButton label="Select / move" active={tool === 'select'} onClick={() => setTool('select')}><MousePointer2 size={16} /></IconButton>
        <IconButton label="Edit existing text" active={tool === 'edit'} onClick={() => { setTool('edit'); setSelected(null); }}><TextCursorInput size={16} /></IconButton>
        <IconButton label="Add text" active={tool === 'text'} onClick={() => setTool('text')}><Type size={16} /></IconButton>
        <IconButton label="Insert image" onClick={insertImage}><ImageIcon size={16} /></IconButton>
        <IconButton label="Add link area" active={tool === 'link'} onClick={() => setTool('link')}><LinkIcon size={16} /></IconButton>
        <Divider />
        <IconButton label="Rectangle" active={tool === 'rect'} onClick={() => setTool('rect')}><Square size={16} /></IconButton>
        <IconButton label="Ellipse" active={tool === 'ellipse'} onClick={() => setTool('ellipse')}><Circle size={16} /></IconButton>
        <IconButton label="Line" active={tool === 'line'} onClick={() => setTool('line')}><Minus size={16} /></IconButton>
        <IconButton label="Draw / sign" active={tool === 'ink'} onClick={() => setTool('ink')}><PenLine size={16} /></IconButton>
        <IconButton label="Highlight area" active={tool === 'highlight'} onClick={() => setTool('highlight')}><Highlighter size={16} /></IconButton>
        <IconButton label="White-out (cover content)" active={tool === 'whiteout'} onClick={() => setTool('whiteout')}><Eraser size={16} /></IconButton>
        <Divider />
        <IconButton label="Find & replace (Ctrl+F)" active={!!find} onClick={() => (find ? closeFind() : openFind(false))}><Search size={16} /></IconButton>
        <IconButton label={showThumbs ? 'Hide page list' : 'Show page list'} active={showThumbs} onClick={() => setShowThumbs((v) => !v)}>
          {showThumbs ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </IconButton>
        <Popover label="Insert pages" text button={<><FilePlus2 size={16} /><span>Pages</span></>}>
          {(close) => (
            <div className="menu">
              <MenuItem onClick={() => { insertBlank(current); close(); }}>Blank page before page {current + 1}</MenuItem>
              <MenuItem onClick={() => { insertBlank(current + 1); close(); }}>Blank page after page {current + 1}</MenuItem>
              <MenuItem onClick={() => { insertBlank(pages.length); close(); }}>Blank page at end</MenuItem>
              <div className="menu-sep" />
              <MenuItem onClick={() => { close(); void insertFromFile(current + 1); }}>Pages from a file after page {current + 1}…</MenuItem>
              <MenuItem onClick={() => { close(); void insertFromFile(0); }}>Pages from a file at the start…</MenuItem>
              <div className="menu-sep" />
              <MenuItem onClick={() => { duplicatePage(current); close(); }}>Duplicate page {current + 1}</MenuItem>
              <MenuItem onClick={() => { rotatePage(current, 90); close(); }}>Rotate page {current + 1} clockwise</MenuItem>
              <MenuItem onClick={() => { deletePage(current); close(); }}>Delete page {current + 1}</MenuItem>
            </div>
          )}
        </Popover>

        {/* contextual properties */}
        {(kind === 'text' || selectedObj?.type === 'text') && (
          <>
            <Divider />
            <Select
              label="Font"
              value={textStyle.fontFamily}
              width={130}
              options={(Object.keys(PDF_FONTS) as PdfFontFamily[]).map((f) => ({ value: f, label: PDF_FONTS[f].label }))}
              onChange={(v) => applyStyle({ fontFamily: v })}
            />
            <input
              className="tb-number"
              type="number"
              min={4}
              max={200}
              step={0.5}
              aria-label="Font size"
              title="Font size"
              value={textStyle.fontSize}
              onChange={(e) => {
                const n = parseFloat(e.target.value);
                if (n >= 4 && n <= 200) applyStyle({ fontSize: n });
              }}
            />
            <IconButton label="Bold" active={textStyle.bold} onClick={() => applyStyle({ bold: !textStyle.bold })}><b>B</b></IconButton>
            <IconButton label="Italic" active={textStyle.italic} onClick={() => applyStyle({ italic: !textStyle.italic })}><i>I</i></IconButton>
            <ColorPicker label="Text colour" icon={<Type size={14} />} value={textStyle.color} onPick={(c) => applyStyle({ color: c })} />
            {selectedObj?.type === 'text' && (
              <IconButton label={selectedObj.url ? `Link: ${selectedObj.url}` : 'Make text a link'} active={!!selectedObj.url} onClick={() => setLinkPrompt({ pageId: selected!.pageId, objId: selectedObj.id, initial: selectedObj.url ?? '' })}>
                <LinkIcon size={16} />
              </IconButton>
            )}
          </>
        )}
        {(kind === 'rect' || kind === 'ellipse' || kind === 'line' || kind === 'ink') && (
          <>
            <Divider />
            <ColorPicker
              label="Line colour"
              icon={<PenLine size={14} />}
              value={strokeStyle.stroke ?? null}
              onPick={(c) => applyStyle({ stroke: c })}
              onClear={kind === 'rect' || kind === 'ellipse' ? () => applyStyle({ stroke: null as unknown as string }) : undefined}
              clearLabel="No line"
            />
            {(kind === 'rect' || kind === 'ellipse') && (
              <ColorPicker
                label="Fill colour"
                icon={<Square size={14} />}
                value={(selectedObj && 'fill' in selectedObj ? selectedObj.fill : style.fill) ?? null}
                onPick={(c) => applyStyle({ fill: c })}
                onClear={() => applyStyle({ fill: null })}
                clearLabel="No fill"
              />
            )}
            <Select
              label="Line width"
              value={String(strokeStyle.strokeWidth ?? 2)}
              width={70}
              options={['0.5', '1', '1.5', '2', '3', '4', '6', '8', '12'].map((v) => ({ value: v, label: `${v} pt` }))}
              onChange={(v) => applyStyle({ strokeWidth: parseFloat(v) })}
            />
          </>
        )}
        {kind === 'highlight' && (
          <>
            <Divider />
            <ColorPicker label="Highlight colour" icon={<Highlighter size={14} />} palette="highlight" value={selectedObj?.type === 'highlight' ? selectedObj.color : style.highlight} onPick={(c) => applyStyle({ highlight: c })} />
          </>
        )}
        {kind === 'whiteout' && (
          <>
            <Divider />
            <ColorPicker label="Cover colour" icon={<Eraser size={14} />} value={selectedObj?.type === 'whiteout' ? selectedObj.color : style.whiteout} onPick={(c) => applyStyle({ whiteout: c })} />
          </>
        )}
        {selectedObj?.type === 'link' && (
          <>
            <Divider />
            <button type="button" className="btn btn-text" onClick={() => setLinkPrompt({ pageId: selected!.pageId, objId: selectedObj.id, initial: selectedObj.url })}>
              Edit link…
            </button>
          </>
        )}
        {selectedObj && (
          <IconButton label="Delete object (Del)" onClick={() => removeObject(selected!.pageId, selected!.objId)}><Trash2 size={16} /></IconButton>
        )}
      </div>

      {find && (
        <FindBar
          replaceOpen={find.replace}
          onToggleReplace={() => setFind((f) => f && { ...f, replace: !f.replace })}
          query={query}
          onQuery={setQuery}
          options={searchOpts}
          onOptions={setSearchOpts}
          total={hits.length}
          current={currentIndex}
          focusToken={find.token}
          progress={indexProgress ? `Searching… ${indexProgress.done} / ${indexProgress.total} pages` : null}
          note="Matches split across lines or text pieces can't be found. Replaced text is retyped in a standard font."
          onNext={() => goHit(1)}
          onPrev={() => goHit(-1)}
          onReplace={replaceCurrentHit}
          onReplaceAll={replaceAllHits}
          onClose={closeFind}
        />
      )}
      <div className="pdf-body">
        {showThumbs && <aside className="thumbs" aria-label="Pages">
          {pages.map((p, i) => {
            const src = sources.find((s) => s.id === p.sourceId) ?? null;
            const tScale = 110 / Math.max(p.width, p.height);
            return (
              <div
                key={p.id}
                className={cx('thumb', i === current && 'is-current', dragThumb !== null && dragThumb !== i && 'is-drop')}
                draggable
                onDragStart={(e) => {
                  setDragThumb(i);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/x-page', String(i));
                }}
                onDragEnd={() => setDragThumb(null)}
                onDragOver={(e) => {
                  if (dragThumb !== null) {
                    e.preventDefault();
                    e.stopPropagation();
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (dragThumb !== null) movePage(dragThumb, i);
                  setDragThumb(null);
                }}
              >
                <button type="button" className="thumb-img" onClick={() => scrollToPage(i)} aria-label={`Go to page ${i + 1}`}>
                  <div className="thumb-rot" style={{ transform: `rotate(${p.rotation}deg)` }}>
                    <PageCanvas cache={cache} source={src} pageIndex={p.sourcePage} scale={tScale} width={p.width} height={p.height} />
                  </div>
                </button>
                <div className="thumb-bar">
                  <span className="thumb-num">{i + 1}</span>
                  <span className="thumb-actions">
                    <IconButton label="Move up" disabled={i === 0} onClick={() => movePage(i, i - 1)}><ArrowUp size={12} /></IconButton>
                    <IconButton label="Move down" disabled={i === pages.length - 1} onClick={() => movePage(i, i + 1)}><ArrowDown size={12} /></IconButton>
                    <IconButton label="Rotate left" onClick={() => rotatePage(i, -90)}><RotateCcw size={12} /></IconButton>
                    <IconButton label="Rotate right" onClick={() => rotatePage(i, 90)}><RotateCw size={12} /></IconButton>
                    <IconButton label="Duplicate" onClick={() => duplicatePage(i)}><Copy size={12} /></IconButton>
                    <IconButton label="Delete page" onClick={() => deletePage(i)}><Trash2 size={12} /></IconButton>
                  </span>
                </div>
              </div>
            );
          })}
        </aside>}

        <div
          className={cx('workspace', 'pdf-workspace', 'zoom-scroll', `tool-${tool}`)}
          ref={(el) => {
            scrollRef.current = el;
            setScrollEl(el);
          }}
        >
          <div className="pdf-pages" ref={setPagesEl}>
          {pages.map((page, index) => {
            const src = sources.find((s) => s.id === page.sourceId) ?? null;
            const rotated = page.rotation % 180 !== 0;
            const outerW = (rotated ? page.height : page.width) * scale;
            const outerH = (rotated ? page.width : page.height) * scale;
            const pageRuns = tool === 'edit' && page.sourceId ? runs[`${page.sourceId}:${page.sourcePage}`] ?? [] : [];
            const covered = new Set(page.objects.filter((o): o is PdfTextObject => o.type === 'text' && !!o.cover).map((o) => `${Math.round(o.cover!.x)}:${Math.round(o.cover!.y)}`));
            return (
              <div key={page.id} className="pdf-page" style={{ width: outerW, height: outerH }} ref={(el) => { pageRefs.current[page.id] = el; }} data-page={index + 1}>
                <div
                  className="pdf-page-inner"
                  style={{ width: page.width * scale, height: page.height * scale, transform: `translate(-50%, -50%) rotate(${page.rotation}deg)` }}
                  onPointerDown={(e) => onPagePointerDown(e, page, index)}
                  onPointerMove={(e) => onPointerMove(e, page)}
                  onPointerUp={() => onPointerUp(page)}
                  onPointerCancel={() => onPointerUp(page)}
                >
                  <PageCanvas
                    cache={cache}
                    source={src}
                    pageIndex={page.sourcePage}
                    scale={scale}
                    width={page.width}
                    height={page.height}
                    className="pdf-canvas"
                    onRendered={(c) => { canvases.current[page.id] = c; }}
                  />
                  <svg className="pdf-svg" width={page.width * scale} height={page.height * scale} viewBox={`0 0 ${page.width} ${page.height}`}>
                    {page.objects.map((o) => {
                      if (o.type !== 'line' && o.type !== 'ink') return null;
                      const d = o.type === 'line' ? `M${o.x1} ${o.y1} L${o.x2} ${o.y2}` : 'M' + o.points.map((p) => `${p[0]} ${p[1]}`).join(' L');
                      return (
                        <g key={o.id} onPointerDown={(e) => startMove(e, page, o)} className="svg-obj">
                          <path d={d} stroke="transparent" strokeWidth={Math.max(10, o.strokeWidth + 8)} fill="none" strokeLinecap="round" />
                          <path d={d} stroke={o.stroke} strokeWidth={o.strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                        </g>
                      );
                    })}
                  </svg>
                  {page.objects.map((o) => (
                    <ObjectView
                      key={o.id}
                      obj={o}
                      scale={scale}
                      selected={selected?.objId === o.id}
                      editing={editingId === o.id}
                      onPointerDown={(e) => startMove(e, page, o)}
                      onResize={(e, h) => startResize(e, page, o, h)}
                      onDoubleClick={() => o.type === 'text' && setEditingId(o.id)}
                      onTextCommit={(text) => commitText(page.id, o.id, text)}
                    />
                  ))}
                  {pageRuns
                    .filter((r) => !covered.has(`${Math.round(r.x - 0.75)}:${Math.round(r.y - 0.75)}`))
                    .map((r, i) => (
                      <div
                        key={i}
                        className="text-run"
                        title="Click to edit this text"
                        style={{ left: r.x * scale, top: r.y * scale, width: r.width * scale, height: r.height * scale }}
                        // open on click (pointer up without moving), so a swipe that starts on
                        // text scrolls the page on touch screens instead of opening an edit box
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => replaceRun(e, page, r)}
                      />
                    ))}
                  {hitsByPage.get(page.id)?.map((h) => (
                    <div
                      key={h.key}
                      className={cx('search-hit', h.key === currentHit?.key && 'search-hit-current')}
                      style={{ left: h.rect.x * scale - 1, top: h.rect.y * scale - 1, width: h.rect.width * scale + 2, height: h.rect.height * scale + 2 }}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          </div>
        </div>
      </div>

      {linkPrompt && (
        <PromptModal
          title="Link address"
          label="Web address, e-mail or phone"
          placeholder="https://example.com"
          initial={linkPrompt.initial}
          confirmLabel="Apply"
          onClose={() => {
            const o = pagesRef.current?.find((p) => p.id === linkPrompt.pageId)?.objects.find((x) => x.id === linkPrompt.objId);
            if (o?.type === 'link' && !o.url) removeObject(linkPrompt.pageId, linkPrompt.objId);
            setLinkPrompt(null);
          }}
          onSubmit={(value) => {
            const { pageId, objId } = linkPrompt;
            setLinkPrompt(null);
            let url = value.trim();
            if (url && !/^(https?:|mailto:|tel:)/i.test(url)) {
              if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
                onError('Only web, e-mail and phone links are allowed.');
                url = '';
              } else url = /^[^\s@]+@[^\s@]+$/.test(url) ? 'mailto:' + url : 'https://' + url;
            }
            const o = pagesRef.current?.find((p) => p.id === pageId)?.objects.find((x) => x.id === objId);
            if (!o) return;
            if (o.type === 'link') {
              if (url) updateObject(pageId, objId, (cur) => ({ ...cur, url }) as PdfObject);
              else removeObject(pageId, objId);
            } else if (o.type === 'text') {
              updateObject(pageId, objId, (cur) => ({ ...cur, url: url || undefined, color: url && (cur as PdfTextObject).color === '#111111' ? '#1a56db' : (cur as PdfTextObject).color }) as PdfObject);
            }
          }}
        />
      )}
    </div>
  );
});

function ObjectView({
  obj,
  scale,
  selected,
  editing,
  onPointerDown,
  onResize,
  onDoubleClick,
  onTextCommit,
}: {
  obj: PdfObject;
  scale: number;
  selected: boolean;
  editing: boolean;
  onPointerDown: (e: RPointerEvent) => void;
  onResize: (e: RPointerEvent, handle: Handle) => void;
  onDoubleClick: () => void;
  onTextCommit: (text: string) => void;
}) {
  const s = scale;
  if (obj.type === 'line' || obj.type === 'ink') {
    if (!selected) return null;
    const b = bounds(obj);
    const pad = obj.strokeWidth / 2 + 3;
    return (
      <div className="obj-outline" style={{ left: (b.x - pad) * s, top: (b.y - pad) * s, width: (b.width + pad * 2) * s, height: (b.height + pad * 2) * s }}>
        <ResizeHandles handles={ALL_HANDLES} onStart={onResize} />
      </div>
    );
  }
  if (obj.type === 'text') {
    const font = PDF_FONTS[obj.fontFamily];
    const textCss = {
      fontFamily: font.css,
      fontSize: obj.fontSize * s,
      lineHeight: PDF_LINE_HEIGHT,
      fontWeight: obj.bold ? 700 : 400,
      fontStyle: obj.italic ? 'italic' : 'normal',
      color: obj.color,
      textDecoration: obj.url ? 'underline' : 'none',
    } as const;
    return (
      <>
        {obj.cover && (
          <div
            className="obj-cover"
            style={{ left: obj.cover.x * s, top: obj.cover.y * s, width: obj.cover.width * s, height: obj.cover.height * s, background: obj.cover.color }}
          />
        )}
        {editing ? (
          <TextEditBox obj={obj} scale={s} css={textCss} onCommit={onTextCommit} />
        ) : (
          <div
            className={cx('obj', 'obj-text', selected && 'is-selected')}
            style={{ left: obj.x * s, top: obj.y * s, ...textCss }}
            onPointerDown={onPointerDown}
            onDoubleClick={onDoubleClick}
            title={obj.url ? `Link: ${obj.url}` : 'Double-click to edit'}
          >
            {obj.text || '​'}
            {selected && <ResizeHandles handles={CORNER_HANDLES} onStart={onResize} />}
          </div>
        )}
      </>
    );
  }
  const box = { left: obj.x * s, top: obj.y * s, width: obj.width * s, height: obj.height * s };
  let inner: React.ReactNode = null;
  let style: React.CSSProperties = box;
  switch (obj.type) {
    case 'image':
      inner = <img src={obj.dataUrl} alt="" draggable={false} />;
      break;
    case 'rect':
    case 'ellipse':
      style = {
        ...box,
        border: obj.stroke ? `${obj.strokeWidth * s}px solid ${obj.stroke}` : 'none',
        background: obj.fill ?? 'transparent',
        borderRadius: obj.type === 'ellipse' ? '50%' : 0,
      };
      break;
    case 'highlight':
      style = { ...box, background: obj.color, opacity: 0.45, mixBlendMode: 'multiply' };
      break;
    case 'whiteout':
      style = { ...box, background: obj.color };
      break;
    case 'link':
      break;
  }
  return (
    <div className={cx('obj', `obj-${obj.type}`, selected && 'is-selected')} style={style} onPointerDown={onPointerDown} title={obj.type === 'link' ? obj.url : undefined}>
      {inner}
      {selected && <ResizeHandles handles={ALL_HANDLES} onStart={onResize} />}
    </div>
  );
}

/** Corner and side-midpoint anchors; drag one to resize from that side. */
function ResizeHandles({ handles, onStart }: { handles: Handle[]; onStart: (e: RPointerEvent, h: Handle) => void }) {
  return (
    <>
      {handles.map((h) => (
        <div
          key={h}
          className={cx('rh', `rh-${h}`)}
          style={{ left: `${HANDLE_POS[h][0] * 100}%`, top: `${HANDLE_POS[h][1] * 100}%`, cursor: HANDLE_CURSOR[h] }}
          onPointerDown={(e) => onStart(e, h)}
          aria-label={`Resize ${h}`}
        />
      ))}
    </>
  );
}

function TextEditBox({ obj, scale, css, onCommit }: { obj: PdfTextObject; scale: number; css: React.CSSProperties; onCommit: (t: string) => void }) {
  const [text, setText] = useState(obj.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const committed = useRef(false);
  const mounted = useRef(false);
  const textRef = useRef(text);
  textRef.current = text;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.select();
    }
    // Closing the box without a blur (clicking the page or another text run unmounts it first)
    // must still save. Deferred so React StrictMode's test unmount/remount doesn't commit.
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (!mounted.current && !committed.current) {
          committed.current = true;
          onCommitRef.current(textRef.current);
        }
      });
    };
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.width = '0px';
    el.style.height = '0px';
    el.style.width = `${Math.max(el.scrollWidth + 4, 24)}px`;
    el.style.height = `${el.scrollHeight}px`;
  }, [text, scale, css.fontSize, css.fontFamily]);
  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    onCommit(text);
  };
  return (
    <textarea
      ref={ref}
      className="obj-text-edit"
      style={{ left: obj.x * scale, top: obj.y * scale, ...css, textDecoration: 'none' }}
      value={text}
      spellCheck
      wrap="off"
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

export { clamp };
