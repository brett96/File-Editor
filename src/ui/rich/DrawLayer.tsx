import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';

export type DrawTool = 'pen' | 'highlighter' | 'eraser';

export interface DrawSettings {
  tool: DrawTool;
  color: string;
  /** Pen width in px (the highlighter is wider). */
  width: number;
}

interface Stroke {
  points: [number, number][];
  color: string;
  width: number;
  opacity: number;
}

export interface DrawLayerHandle {
  /** Turns strokes that are still being drawn into a drawing in the document. */
  flush(): void;
}

/** Strokes drawn within this long of each other become one drawing (like a handwritten word). */
const GROUP_MS = 900;
const HIGHLIGHTER_WIDTH = 16;

function pathOf(points: [number, number][]): string {
  if (!points.length) return '';
  const [x0, y0] = points[0];
  if (points.length === 1) return `M${x0} ${y0} L${x0 + 0.01} ${y0}`;
  let d = `M${x0} ${y0}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += ` Q${x} ${y} ${(x + nx) / 2} ${(y + ny) / 2}`;
  }
  const [lx, ly] = points[points.length - 1];
  return `${d} L${lx} ${ly}`;
}

/**
 * Freehand drawing over the page. Strokes are drawn live as SVG; a group of strokes is then
 * rasterised into a transparent PNG and inserted as a floating image anchored to the paragraph
 * under its top-left corner, so it moves with that text (like ink in Word).
 */
export const DrawLayer = forwardRef<DrawLayerHandle, { editor: Editor; sheet: HTMLElement; settings: DrawSettings }>(function DrawLayer(
  { editor, sheet, settings },
  ref,
) {
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [live, setLive] = useState<Stroke | null>(null);
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const liveRef = useRef<Stroke | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const touches = useRef(new Set<number>());
  const svgRef = useRef<SVGSVGElement>(null);

  /** Unzoomed sheet coordinates of a pointer event, and the zoom factor. */
  const toSheet = (clientX: number, clientY: number) => {
    const r = sheet.getBoundingClientRect();
    const k = r.width / Math.max(1, sheet.offsetWidth) || 1;
    return { x: (clientX - r.left) / k, y: (clientY - r.top) / k, k, r };
  };

  const commit = useCallback(() => {
    window.clearTimeout(timer.current);
    const group = strokesRef.current;
    if (!group.length) return;
    strokesRef.current = [];
    setStrokes([]);
    insertDrawing(editor, sheet, group);
  }, [editor, sheet]);

  useImperativeHandle(ref, () => ({ flush: commit }), [commit]);

  // leaving draw mode (or switching tools) keeps what was drawn
  useEffect(() => () => commit(), [commit]);
  useEffect(() => {
    if (settings.tool === 'eraser') commit();
  }, [settings.tool, commit]);

  const eraseAt = (clientX: number, clientY: number) => {
    // pending strokes near the pointer
    const { x, y } = toSheet(clientX, clientY);
    const near = (s: Stroke) => s.points.some(([px, py]) => Math.hypot(px - x, py - y) < Math.max(8, s.width));
    if (strokesRef.current.some(near)) {
      strokesRef.current = strokesRef.current.filter((s) => !near(s));
      setStrokes(strokesRef.current);
    }
    // committed drawings under the pointer
    const hit = document
      .elementsFromPoint(clientX, clientY)
      .find((el): el is HTMLImageElement => el instanceof HTMLImageElement && el.classList.contains('float-img') && el.hasAttribute('data-ink'));
    if (!hit) return;
    const view = editor.view;
    let target = -1;
    view.state.doc.descendants((node: PMNode, pos: number) => {
      if (target >= 0) return false;
      if (node.type.name !== 'floatingImage') return true;
      const dom = view.nodeDOM(pos);
      if (dom === hit || (dom instanceof Node && dom.contains(hit))) target = pos;
      return true;
    });
    if (target >= 0) view.dispatch(view.state.tr.delete(target, target + 1));
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'touch') {
      touches.current.add(e.pointerId);
      // a second finger means pinch / pan, not drawing
      if (touches.current.size > 1) {
        liveRef.current = null;
        setLive(null);
        return;
      }
    } else if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    svgRef.current?.setPointerCapture(e.pointerId);
    window.clearTimeout(timer.current);
    if (settings.tool === 'eraser') {
      eraseAt(e.clientX, e.clientY);
      liveRef.current = { points: [], color: '', width: 0, opacity: 0 };
      return;
    }
    const { x, y } = toSheet(e.clientX, e.clientY);
    const hl = settings.tool === 'highlighter';
    const stroke: Stroke = { points: [[x, y]], color: settings.color, width: hl ? HIGHLIGHTER_WIDTH : settings.width, opacity: hl ? 0.38 : 1 };
    liveRef.current = stroke;
    setLive({ ...stroke });
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const s = liveRef.current;
    if (!s) return;
    if (settings.tool === 'eraser') {
      eraseAt(e.clientX, e.clientY);
      return;
    }
    const events = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const { x, y } = toSheet(ev.clientX, ev.clientY);
      const [lx, ly] = s.points[s.points.length - 1];
      if (Math.hypot(x - lx, y - ly) >= 0.8) s.points.push([x, y]);
    }
    setLive({ ...s, points: s.points.slice() });
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    touches.current.delete(e.pointerId);
    const s = liveRef.current;
    liveRef.current = null;
    setLive(null);
    if (!s || settings.tool === 'eraser' || !s.points.length) return;
    strokesRef.current = [...strokesRef.current, s];
    setStrokes(strokesRef.current);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(commit, GROUP_MS);
  };

  const all = live ? [...strokes, live] : strokes;
  return (
    <svg
      ref={svgRef}
      className={`ink-overlay ink-${settings.tool}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      aria-label="Drawing area"
    >
      {all.map((s, i) =>
        s.points.length ? (
          <path key={i} d={pathOf(s.points)} fill="none" stroke={s.color} strokeWidth={s.width} strokeOpacity={s.opacity} strokeLinecap="round" strokeLinejoin="round" />
        ) : null,
      )}
    </svg>
  );
});

/** Rasterises strokes and inserts them as a floating image anchored to the paragraph below their top edge. */
function insertDrawing(editor: Editor, sheet: HTMLElement, strokes: Stroke[]): void {
  const pad = Math.max(...strokes.map((s) => s.width)) / 2 + 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of strokes) {
    for (const [x, y] of s.points) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  minX -= pad;
  minY -= pad;
  const w = Math.max(2, Math.ceil(maxX + pad - minX));
  const h = Math.max(2, Math.ceil(maxY + pad - minY));

  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(scale, scale);
  ctx.translate(-minX, -minY);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    ctx.globalAlpha = s.opacity;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.stroke(new Path2D(pathOf(s.points)));
  }
  const src = canvas.toDataURL('image/png');

  // anchor: the text block whose top is closest above the drawing's top-left corner
  const view = editor.view;
  const r = sheet.getBoundingClientRect();
  const k = r.width / Math.max(1, sheet.offsetWidth) || 1;
  const cx = r.left + minX * k;
  const cy = r.top + minY * k;
  type Hit = { pos: number; rect: DOMRect };
  let inColumn: Hit | null = null; // closest block above whose column contains the corner
  let above: Hit | null = null; // closest block above, anywhere
  let first: Hit | null = null; // drawings above all text anchor to the first block
  view.state.doc.descendants((node: PMNode, pos: number) => {
    if (!node.isTextblock) return true;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return false;
    const rect = dom.getBoundingClientRect();
    first ??= { pos, rect };
    if (rect.top <= cy) {
      if (!above || rect.top >= above.rect.top) above = { pos, rect };
      if (cx >= rect.left - 4 && cx <= rect.right + 4 && (!inColumn || rect.top >= inColumn.rect.top)) inColumn = { pos, rect };
    }
    return false;
  });
  const anchor = (inColumn ?? above ?? first) as Hit | null;
  if (!anchor) return;
  const node = view.state.schema.nodes.floatingImage.create({
    src,
    alt: 'Drawing',
    width: w,
    height: h,
    x: Math.round((cx - anchor.rect.left) / k),
    y: Math.round((cy - anchor.rect.top) / k),
    ink: true,
  });
  view.dispatch(view.state.tr.insert(anchor.pos + 1, node));
}
