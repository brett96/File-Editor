/**
 * The Vector Studio canvas: draws the artboards and artwork as SVG and turns pointer input
 * into edits for whichever tool is active. Artwork is drawn by the same serialiser that
 * writes files (core/vector/svg.ts), one memoised element per top-level object, so only the
 * objects an edit touches are re-rendered.
 */
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { browserMeasure, browserRender } from '../../core/vector/browser';
import { brushShape, containsPoint, cutPath, fitCurve, flatten, intersects, regions, subtractSubs, uniteSubs, type Region } from '../../core/vector/geom';
import { createMesh, paintColorAt, splitMesh } from '../../core/vector/mesh';
import {
  addNodes, allNodes, cloneNode, findNode, newId, removeNodes, replaceNode, topLevelOf, updateNodes,
  type Anchor, type Artboard, type MeshPaint, type Paint, type PathNode, type SubPath, type TextNode, type VNode,
} from '../../core/vector/model';
import {
  apply as applyMat, autoSmooth, boundsOfNodes, boxesIntersect, corner, ellipseSubs, insertAnchor, invert, lineSubs, nearestOnPath, nodeBounds, polygonSubs, rectSubs,
  rotateAbout, starSubs, subsBounds, subsToD, textLocalBox, transformNode, translate, type Box, type Pt,
} from '../../core/vector/path';
import { fontFamilyCss, nodeToSvg } from '../../core/vector/svg';
import type { AnchorRef, ToolId, ToolOptions, VectorStore } from './store';

const EDITOR_RENDER = { ...browserRender, editor: true };

const NodeView = memo(function NodeView({ node, hidden }: { node: VNode; hidden: boolean }) {
  const html = useMemo(() => nodeToSvg(node, EDITOR_RENDER), [node]);
  return <g style={{ pointerEvents: node.locked ? 'none' : undefined, visibility: hidden ? 'hidden' : undefined }} dangerouslySetInnerHTML={{ __html: html }} />;
});

export interface View {
  zoom: number;
  x: number;
  y: number;
}

export interface CanvasHandle {
  /** ends the path being drawn with the pen / curvature tool */
  finishPath(): boolean;
  fit(box?: Box | null): void;
  zoomTo(zoom: number): void;
  editText(id: string): void;
  isEditingText(): boolean;
  /** the document point at the middle of the view (where placed images land) */
  center(): Pt;
}

interface Props {
  store: VectorStore;
  tool: ToolId;
  options: ToolOptions;
  meshSel: number | null;
  setMeshSel: (i: number | null) => void;
  onView: (v: View) => void;
  onError: (message: string) => void;
}

const HANDLES: [string, number, number][] = [['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5], ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5]];
const HANDLE_CURSOR: Record<string, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

type Drag =
  | { kind: 'pan'; cx: number; cy: number; view: View }
  | { kind: 'move'; start: Pt; box: Box; snapX: number[]; snapY: number[]; moved: boolean; copied: boolean }
  | { kind: 'scale'; hx: number; hy: number; box: Box }
  | { kind: 'rotate'; center: Pt; angle: number }
  | { kind: 'marquee'; start: Pt; anchors: boolean; add: boolean }
  | { kind: 'anchors'; start: Pt; moved: boolean }
  | { kind: 'ctrl'; ref: AnchorRef; which: 'in' | 'out' }
  | { kind: 'pen'; id: string; sub: number; index: number }
  | { kind: 'draw'; points: Pt[] }
  | { kind: 'shape'; start: Pt; id: string }
  | { kind: 'textbox'; start: Pt }
  | { kind: 'builder'; hits: Set<number>; remove: boolean }
  | { kind: 'gradient'; id: string; start: Pt }
  | { kind: 'mesh'; id: string; index: number }
  | { kind: 'board-new'; start: Pt; id: string }
  | { kind: 'board-move'; id: string; start: Pt }
  | { kind: 'board-size'; id: string; hx: number; hy: number; box: Box };

const baseOf = new WeakMap<object, unknown>();

export const Canvas = forwardRef<CanvasHandle, Props>(function Canvas({ store, tool, options, meshSel, setMeshSel, onView, onError }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [view, setViewState] = useState<View>({ zoom: 1, x: 40, y: 40 });
  const viewRef = useRef(view);
  const setView = useCallback(
    (v: View) => {
      viewRef.current = v;
      setViewState(v);
      onView(v);
    },
    [onView],
  );
  const drag = useRef<Drag | null>(null);
  /** the document when the drag started: every move is computed from it, so nothing accumulates */
  const dragBase = useRef(store.doc);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});
  const [hover, setHover] = useState<Pt | null>(null);
  const [stroke, setStroke] = useState<Pt[] | null>(null);
  const [pen, setPen] = useState<{ id: string; sub: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [builderHits, setBuilderHits] = useState<number[]>([]);
  const [space, setSpace] = useState(false);
  const { doc, selection, anchors } = store;
  void baseOf;

  // ── view ──
  const toDoc = (e: { clientX: number; clientY: number }): Pt => {
    const r = hostRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (e.clientX - r.left - v.x) / v.zoom, y: (e.clientY - r.top - v.y) / v.zoom };
  };
  const fit = useCallback(
    (box?: Box | null) => {
      const host = hostRef.current;
      if (!host) return;
      const d = store.docRef.current;
      const b = box ?? d.artboards.find((a) => a.id === store.activeArtboard) ?? d.artboards[0];
      if (!b || !host.clientWidth) return;
      const zoom = Math.max(0.02, Math.min(64, Math.min((host.clientWidth - 80) / b.width, (host.clientHeight - 80) / b.height)));
      setView({ zoom, x: (host.clientWidth - b.width * zoom) / 2 - b.x * zoom, y: (host.clientHeight - b.height * zoom) / 2 - b.y * zoom });
    },
    [setView, store.activeArtboard, store.docRef],
  );
  const zoomAt = useCallback(
    (zoom: number, sx?: number, sy?: number) => {
      const host = hostRef.current!;
      const v = viewRef.current;
      const z = Math.max(0.02, Math.min(64, zoom));
      const px = sx ?? host.clientWidth / 2;
      const py = sy ?? host.clientHeight / 2;
      setView({ zoom: z, x: px - ((px - v.x) / v.zoom) * z, y: py - ((py - v.y) / v.zoom) * z });
    },
    [setView],
  );
  // fit the first artboard once the canvas has a size
  const fitted = useRef(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      if (!fitted.current && host.clientWidth > 0) {
        fitted.current = true;
        fit();
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [fit]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = host.getBoundingClientRect();
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey || e.altKey) zoomAt(v.zoom * Math.exp(-e.deltaY * (e.ctrlKey && Math.abs(e.deltaY) < 20 ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
      else setView({ ...v, x: v.x - (e.shiftKey ? e.deltaY : e.deltaX), y: v.y - (e.shiftKey ? 0 : e.deltaY) });
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [setView, zoomAt]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '')) setSpace(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpace(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // a path being drawn ends when another tool is picked
  useEffect(() => {
    setPen(null);
    setHover(null);
    setBuilderHits([]);
  }, [tool]);

  const finishPath = useCallback(() => {
    if (!pen) return false;
    const node = findNode(store.docRef.current, pen.id);
    // a path of one point is nothing: take it away again
    if (node?.type === 'path' && node.subs.every((s) => s.anchors.length < 2)) store.apply(removeNodes(store.docRef.current, [pen.id]), []);
    setPen(null);
    return true;
  }, [pen, store]);

  useImperativeHandle(ref, () => ({
    finishPath,
    fit,
    zoomTo: (z) => zoomAt(z),
    editText: (id) => setEditing(id),
    isEditingText: () => editing !== null,
    center: () => {
      const host = hostRef.current!;
      const v = viewRef.current;
      return { x: (host.clientWidth / 2 - v.x) / v.zoom, y: (host.clientHeight / 2 - v.y) / v.zoom };
    },
  }));

  // ── what is under the pointer ──
  const px = (n: number) => n / view.zoom;
  const editable = (n: VNode | null | undefined, d = store.docRef.current): n is VNode => {
    if (!n || n.locked || n.hidden) return false;
    const layer = d.layers.find((l) => l.children.some((c) => c === topLevelOf(d, n.id)));
    return !!layer && !layer.locked && !layer.hidden;
  };
  /** The leaf object under the pointer: what the browser hit, else a path the pointer is within a few pixels of. */
  const hitLeaf = (e: React.PointerEvent | React.MouseEvent, p: Pt): VNode | null => {
    const d = store.docRef.current;
    const id = (e.target as Element).closest?.('[data-id]')?.getAttribute('data-id');
    const direct = id ? findNode(d, id) : null;
    if (editable(direct)) return direct;
    const tol = 5 / viewRef.current.zoom;
    const nodes = allNodes(d).reverse();
    for (const n of nodes) {
      if (n.type !== 'path' || !editable(n)) continue;
      const b = subsBounds(n.subs);
      if (!b || p.x < b.x - tol || p.y < b.y - tol || p.x > b.x + b.width + tol || p.y > b.y + b.height + tol) continue;
      const near = nearestOnPath(n.subs, p.x, p.y);
      if (near && near.distance <= tol) return n;
    }
    return null;
  };
  const hitTop = (e: React.PointerEvent | React.MouseEvent, p: Pt): VNode | null => {
    const leaf = hitLeaf(e, p);
    return leaf ? topLevelOf(store.docRef.current, leaf.id) : null;
  };

  const styled = (subs: SubPath[], patch: Partial<PathNode> = {}): PathNode => ({ ...store.style, id: newId(), type: 'path', opacity: 1, subs, ...patch });
  const solidOf = (p: Paint, fallback: string) => (p.type === 'solid' ? p.color : p.type === 'none' ? fallback : paintColorAt(p, 0.5, 0.5));

  const selBox = useMemo(() => boundsOfNodes(store.selectedNodes, browserMeasure), [store.selectedNodes]);

  // ── shape builder regions ──
  const builderNodes = useMemo(() => {
    if (tool !== 'shapebuilder') return [];
    const sel = new Set(selection);
    return allNodes(doc).filter((n): n is PathNode => sel.has(n.id) && n.type === 'path');
  }, [doc, selection, tool]);
  const builderRegions = useMemo<Region[]>(() => {
    if (builderNodes.length < 2) return [];
    try {
      return regions(builderNodes);
    } catch {
      return [];
    }
  }, [builderNodes]);
  const regionAt = (p: Pt) => builderRegions.findIndex((r) => containsPoint(r.subs, p.x, p.y));

  // ── pointer handling ──
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = toDoc(e);
    const d = store.docRef.current;
    dragBase.current = d;
    const target = e.target as Element;
    if (e.button === 1 || space || tool === 'hand') {
      drag.current = { kind: 'pan', cx: e.clientX, cy: e.clientY, view: viewRef.current };
      return;
    }
    if (editing) setEditing(null);

    if (tool === 'zoom') {
      const r = hostRef.current!.getBoundingClientRect();
      zoomAt(viewRef.current.zoom * (e.altKey ? 0.5 : 2), e.clientX - r.left, e.clientY - r.top);
      return;
    }

    if (tool === 'select') {
      const handle = target.getAttribute('data-handle');
      const box = selBox;
      if (handle && box) {
        store.begin();
        if (handle === 'rot') drag.current = { kind: 'rotate', center: { x: box.x + box.width / 2, y: box.y + box.height / 2 }, angle: Math.atan2(p.y - (box.y + box.height / 2), p.x - (box.x + box.width / 2)) };
        else {
          const h = HANDLES.find((x) => x[0] === handle)!;
          drag.current = { kind: 'scale', hx: h[1], hy: h[2], box };
        }
        return;
      }
      const top = hitTop(e, p);
      if (!top) {
        if (!e.shiftKey) store.select([]);
        drag.current = { kind: 'marquee', start: p, anchors: false, add: e.shiftKey };
        return;
      }
      let ids = store.selRef.current;
      if (e.shiftKey) ids = ids.includes(top.id) ? ids.filter((x) => x !== top.id) : [...ids, top.id];
      else if (!ids.includes(top.id)) ids = [top.id];
      store.select(ids);
      if (!ids.includes(top.id)) return;
      const moving = ids.map((id) => findNode(d, id)).filter((n): n is VNode => !!n);
      const mbox = boundsOfNodes(moving, browserMeasure);
      if (!mbox) return;
      // snap targets: artboard edges and centres, and the boxes of everything not being moved
      const snapX: number[] = [];
      const snapY: number[] = [];
      for (const a of d.artboards) {
        snapX.push(a.x, a.x + a.width / 2, a.x + a.width);
        snapY.push(a.y, a.y + a.height / 2, a.y + a.height);
      }
      for (const n of d.layers.flatMap((l) => (l.hidden ? [] : l.children)).slice(-300)) {
        if (ids.includes(n.id) || n.hidden) continue;
        const b = nodeBounds(n, browserMeasure);
        if (!b) continue;
        snapX.push(b.x, b.x + b.width / 2, b.x + b.width);
        snapY.push(b.y, b.y + b.height / 2, b.y + b.height);
      }
      store.begin();
      drag.current = { kind: 'move', start: p, box: mbox, snapX, snapY, moved: false, copied: false };
      return;
    }

    if (tool === 'direct') {
      const ctrl = target.getAttribute('data-ctrl');
      if (ctrl) {
        const [id, sub, index, which] = ctrl.split(':');
        store.begin();
        drag.current = { kind: 'ctrl', ref: { id, sub: +sub, index: +index }, which: which as 'in' | 'out' };
        return;
      }
      const a = target.getAttribute('data-anchor');
      if (a) {
        const [id, sub, index] = a.split(':');
        const r: AnchorRef = { id, sub: +sub, index: +index };
        const has = store.anchors.some((x) => x.id === r.id && x.sub === r.sub && x.index === r.index);
        if (e.shiftKey) store.setAnchors(has ? store.anchors.filter((x) => !(x.id === r.id && x.sub === r.sub && x.index === r.index)) : [...store.anchors, r]);
        else if (!has) store.setAnchors([r]);
        store.begin();
        drag.current = { kind: 'anchors', start: p, moved: false };
        return;
      }
      const leaf = hitLeaf(e, p);
      if (!leaf) {
        if (!e.shiftKey) {
          store.select([]);
          store.setAnchors([]);
        }
        drag.current = { kind: 'marquee', start: p, anchors: store.selRef.current.length > 0 && e.shiftKey, add: e.shiftKey };
        return;
      }
      const ids = e.shiftKey ? [...new Set([...store.selRef.current, leaf.id])] : store.selRef.current.includes(leaf.id) ? store.selRef.current : [leaf.id];
      store.select(ids);
      store.setAnchors([]);
      const mbox = boundsOfNodes(ids.map((id) => findNode(d, id)).filter((n): n is VNode => !!n), browserMeasure);
      if (!mbox) return;
      store.begin();
      drag.current = { kind: 'move', start: p, box: mbox, snapX: [], snapY: [], moved: false, copied: false };
      return;
    }

    if (tool === 'pen' || tool === 'curvature') {
      const smooth = tool === 'curvature';
      const tol = 7 / viewRef.current.zoom;
      const active = pen ? findNode(d, pen.id) : null;
      if (pen && active?.type === 'path') {
        const sub = active.subs[pen.sub];
        const first = sub.anchors[0];
        if (sub.anchors.length > 1 && Math.hypot(first.x - p.x, first.y - p.y) <= tol) {
          // clicking the first point closes the path
          const closed = { ...sub, closed: true };
          store.apply(updateNodes(d, [pen.id], (n) => ({ ...(n as PathNode), subs: active.subs.map((s, i) => (i === pen.sub ? (smooth ? autoSmooth(closed) : closed) : s)) })));
          setPen(null);
          return;
        }
        const anchor: Anchor = { ...corner(p.x, p.y), ...(smooth ? { smooth: true } : {}) };
        let next: SubPath = { ...sub, anchors: [...sub.anchors, anchor] };
        if (smooth) next = autoSmooth(next);
        store.begin();
        store.preview(updateNodes(d, [pen.id], (n) => ({ ...(n as PathNode), subs: active.subs.map((s, i) => (i === pen.sub ? next : s)) })));
        drag.current = { kind: 'pen', id: pen.id, sub: pen.sub, index: next.anchors.length - 1 };
        return;
      }
      // on a selected path: continue from an end point, remove an anchor, or add one on a segment
      for (const id of store.selRef.current) {
        const n = findNode(d, id);
        if (n?.type !== 'path' || !editable(n)) continue;
        for (let si = 0; si < n.subs.length; si++) {
          const s = n.subs[si];
          const ai = s.anchors.findIndex((a) => Math.hypot(a.x - p.x, a.y - p.y) <= tol);
          if (ai < 0) continue;
          const isEnd = !s.closed && (ai === 0 || ai === s.anchors.length - 1);
          if (isEnd) {
            if (ai === 0 && s.anchors.length > 1) {
              const rev = { ...s, anchors: [...s.anchors].reverse().map((a) => ({ ...a, ix: a.ox, iy: a.oy, ox: a.ix, oy: a.iy })) };
              store.apply(updateNodes(d, [id], (x) => ({ ...(x as PathNode), subs: n.subs.map((q, i) => (i === si ? rev : q)) })));
            }
            setPen({ id, sub: si });
            return;
          }
          if (s.anchors.length > 2) {
            const anchorsLeft = s.anchors.filter((_, i) => i !== ai);
            store.apply(updateNodes(d, [id], (x) => ({ ...(x as PathNode), subs: n.subs.map((q, i) => (i === si ? (smooth ? autoSmooth({ ...s, anchors: anchorsLeft }) : { ...s, anchors: anchorsLeft }) : q)) })));
          }
          return;
        }
        const near = nearestOnPath(n.subs, p.x, p.y);
        if (near && near.distance <= tol) {
          store.apply(updateNodes(d, [id], (x) => ({ ...(x as PathNode), subs: insertAnchor(n.subs, near).subs })));
          return;
        }
      }
      // a new path
      const node = styled([{ closed: false, anchors: [{ ...corner(p.x, p.y), ...(smooth ? { smooth: true } : {}) }] }]);
      store.begin();
      store.preview(addNodes(d, [node], store.activeLayer));
      store.select([node.id]);
      setPen({ id: node.id, sub: 0 });
      drag.current = { kind: 'pen', id: node.id, sub: 0, index: 0 };
      return;
    }

    if (tool === 'pencil' || tool === 'blob' || tool === 'eraser') {
      drag.current = { kind: 'draw', points: [p] };
      setStroke([p]);
      return;
    }

    if (tool === 'line' || tool === 'rect' || tool === 'ellipse' || tool === 'polygon' || tool === 'star') {
      const node = styled(lineSubs(p.x, p.y, p.x, p.y), tool === 'line' ? { fill: { type: 'none' }, stroke: store.style.stroke.type === 'none' ? { type: 'solid', color: '#000000' } : store.style.stroke } : {});
      store.begin();
      store.preview(addNodes(d, [node], store.activeLayer));
      drag.current = { kind: 'shape', start: p, id: node.id };
      return;
    }

    if (tool === 'text') {
      const leaf = hitLeaf(e, p);
      if (leaf?.type === 'text') {
        store.select([leaf.id]);
        setEditing(leaf.id);
        return;
      }
      drag.current = { kind: 'textbox', start: p };
      return;
    }

    if (tool === 'scissors') {
      const leaf = hitLeaf(e, p);
      if (leaf?.type !== 'path') return;
      const pieces = cutPath(leaf.subs, p.x, p.y, 8 / viewRef.current.zoom);
      if (!pieces) return;
      const parts = pieces.map((subs) => ({ ...leaf, id: newId(), subs }));
      store.apply(replaceNode(d, leaf.id, parts), parts.map((n) => n.id));
      return;
    }

    if (tool === 'shapebuilder') {
      if (builderRegions.length < 2) {
        onError('Select two or more overlapping paths, then drag across the regions to merge (Alt-click a region to remove it).');
        return;
      }
      const i = regionAt(p);
      drag.current = { kind: 'builder', hits: new Set(i >= 0 ? [i] : []), remove: e.altKey };
      setBuilderHits(i >= 0 ? [i] : []);
      return;
    }

    if (tool === 'eyedropper') {
      const leaf = hitLeaf(e, p);
      if (leaf?.type !== 'path' && leaf?.type !== 'text') return;
      const { fill, stroke: st, strokeWidth, cap, join, miter, dash } = leaf;
      store.setAppearance({ fill, stroke: st, strokeWidth, cap, join, miter, dash });
      return;
    }

    if (tool === 'gradient') {
      let node = store.selRef.current.length === 1 ? findNode(d, store.selRef.current[0]) : null;
      if (!node || (node.type !== 'path' && node.type !== 'text')) {
        const leaf = hitLeaf(e, p);
        if (leaf?.type !== 'path' && leaf?.type !== 'text') return;
        store.select([leaf.id]);
        node = leaf;
      }
      store.begin();
      drag.current = { kind: 'gradient', id: node.id, start: p };
      return;
    }

    if (tool === 'mesh') {
      const hit = target.getAttribute('data-mesh');
      const selected = store.selRef.current.length === 1 ? findNode(d, store.selRef.current[0]) : null;
      if (hit && selected?.type === 'path') {
        setMeshSel(+hit);
        store.begin();
        drag.current = { kind: 'mesh', id: selected.id, index: +hit };
        return;
      }
      const leaf = hitLeaf(e, p);
      const node = leaf?.type === 'path' ? leaf : selected?.type === 'path' ? selected : null;
      if (!node) return;
      const box = subsBounds(node.subs);
      if (!box || !box.width || !box.height) return;
      const u = Math.max(0, Math.min(1, (p.x - box.x) / box.width));
      const v = Math.max(0, Math.min(1, (p.y - box.y) / box.height));
      const start: MeshPaint = node.fill.type === 'mesh' ? node.fill : createMesh(1, 1, node.fill);
      const made = splitMesh(start, u, v);
      store.apply(updateNodes(d, [node.id], (n) => ({ ...(n as PathNode), fill: made.mesh })), [node.id]);
      setMeshSel(made.row * (made.mesh.cols + 1) + made.col);
      return;
    }

    if (tool === 'artboard') {
      const handle = target.getAttribute('data-board-handle');
      const board = d.artboards.find((a) => a.id === store.activeArtboard);
      if (handle && board) {
        const h = HANDLES.find((x) => x[0] === handle)!;
        store.begin();
        drag.current = { kind: 'board-size', id: board.id, hx: h[1], hy: h[2], box: board };
        return;
      }
      const hit = [...d.artboards].reverse().find((a) => p.x >= a.x && p.x <= a.x + a.width && p.y >= a.y && p.y <= a.y + a.height);
      store.begin();
      if (hit) {
        store.setActiveArtboard(hit.id);
        drag.current = { kind: 'board-move', id: hit.id, start: p };
      } else {
        const board2: Artboard = { id: newId('a'), name: `Artboard ${d.artboards.length + 1}`, x: p.x, y: p.y, width: 1, height: 1 };
        store.preview({ ...d, artboards: [...d.artboards, board2] });
        store.setActiveArtboard(board2.id);
        drag.current = { kind: 'board-new', start: p, id: board2.id };
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = drag.current;
    const p = toDoc(e);
    if (!g) {
      if (pen || tool === 'blob' || tool === 'eraser') setHover(p);
      if (tool === 'shapebuilder' && builderRegions.length) {
        const i = regionAt(p);
        setBuilderHits(i >= 0 ? [i] : []);
      }
      return;
    }
    const base = dragBase.current;
    const z = viewRef.current.zoom;
    switch (g.kind) {
      case 'pan':
        setView({ ...g.view, x: g.view.x + e.clientX - g.cx, y: g.view.y + e.clientY - g.cy });
        break;
      case 'move': {
        let dx = p.x - g.start.x;
        let dy = p.y - g.start.y;
        if (!g.moved && Math.hypot(dx, dy) * z < 3) break;
        g.moved = true;
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const guide: { x?: number; y?: number } = {};
        if (!e.ctrlKey && !e.metaKey) {
          const tol = 6 / z;
          const snap = (targets: number[], edges: number[]): [number, number] | null => {
            let best: [number, number] | null = null;
            for (const edge of edges) for (const t of targets) if (Math.abs(t - edge) < tol && (!best || Math.abs(t - edge) < Math.abs(best[0]))) best = [t - edge, t];
            return best;
          };
          const sx = snap(g.snapX, [g.box.x + dx, g.box.x + g.box.width / 2 + dx, g.box.x + g.box.width + dx]);
          const sy = snap(g.snapY, [g.box.y + dy, g.box.y + g.box.height / 2 + dy, g.box.y + g.box.height + dy]);
          if (sx) {
            dx += sx[0];
            guide.x = sx[1];
          }
          if (sy) {
            dy += sy[0];
            guide.y = sy[1];
          }
        }
        setGuides(guide);
        const ids = store.selRef.current;
        if (e.altKey && !g.copied) {
          // Alt-drag leaves the originals and moves copies
          g.copied = true;
          const copies = ids.map((id) => findNode(base, id)).filter((n): n is VNode => !!n).map(cloneNode);
          const withCopies = addNodes(base, copies, store.activeLayer);
          dragBase.current = withCopies;
          store.select(copies.map((c) => c.id));
          store.preview(updateNodes(withCopies, copies.map((c) => c.id), (n) => transformNode(n, translate(dx, dy))));
          break;
        }
        store.preview(updateNodes(dragBase.current, store.selRef.current, (n) => transformNode(n, translate(dx, dy))));
        break;
      }
      case 'scale': {
        const b = g.box;
        const ax = e.altKey ? b.x + b.width / 2 : b.x + (1 - g.hx) * b.width;
        const ay = e.altKey ? b.y + b.height / 2 : b.y + (1 - g.hy) * b.height;
        const hx = b.x + g.hx * b.width;
        const hy = b.y + g.hy * b.height;
        let sx = g.hx === 0.5 || Math.abs(hx - ax) < 1e-9 ? 1 : (p.x - ax) / (hx - ax);
        let sy = g.hy === 0.5 || Math.abs(hy - ay) < 1e-9 ? 1 : (p.y - ay) / (hy - ay);
        if (e.shiftKey) {
          const s = g.hx === 0.5 ? sy : g.hy === 0.5 ? sx : Math.abs(sx) > Math.abs(sy) ? sx : sy;
          sx = g.hx === 0.5 ? Math.abs(s) : s;
          sy = g.hy === 0.5 ? Math.abs(s) : s;
          if (g.hx !== 0.5 && g.hy !== 0.5) {
            sx = Math.sign(sx || 1) * Math.abs(s);
            sy = Math.sign(sy || 1) * Math.abs(s);
          }
        }
        if (Math.abs(sx) < 1e-4) sx = 1e-4;
        if (Math.abs(sy) < 1e-4) sy = 1e-4;
        store.preview(updateNodes(base, store.selRef.current, (n) => transformNode(n, [sx, 0, 0, sy, ax - sx * ax, ay - sy * ay])));
        break;
      }
      case 'rotate': {
        let a = Math.atan2(p.y - g.center.y, p.x - g.center.x) - g.angle;
        if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
        store.preview(updateNodes(base, store.selRef.current, (n) => transformNode(n, rotateAbout(a, g.center.x, g.center.y))));
        break;
      }
      case 'marquee':
        setMarquee({ x: Math.min(p.x, g.start.x), y: Math.min(p.y, g.start.y), width: Math.abs(p.x - g.start.x), height: Math.abs(p.y - g.start.y) });
        break;
      case 'anchors': {
        const dx = p.x - g.start.x;
        const dy = p.y - g.start.y;
        if (!g.moved && Math.hypot(dx, dy) * z < 2) break;
        g.moved = true;
        const refs = store.anchors;
        store.preview(
          updateNodes(base, new Set(refs.map((r) => r.id)), (n) => {
            if (n.type !== 'path') return n;
            return {
              ...n,
              subs: n.subs.map((s, si) => ({
                ...s,
                anchors: s.anchors.map((a, ai) => (refs.some((r) => r.id === n.id && r.sub === si && r.index === ai) ? { ...a, x: a.x + dx, y: a.y + dy, ix: a.ix + dx, iy: a.iy + dy, ox: a.ox + dx, oy: a.oy + dy } : a)),
              })),
            };
          }),
        );
        break;
      }
      case 'ctrl':
        store.preview(
          updateNodes(base, [g.ref.id], (n) => {
            if (n.type !== 'path') return n;
            return {
              ...n,
              subs: n.subs.map((s, si) =>
                si !== g.ref.sub
                  ? s
                  : {
                      ...s,
                      anchors: s.anchors.map((a, ai) => {
                        if (ai !== g.ref.index) return a;
                        const next = g.which === 'in' ? { ...a, ix: p.x, iy: p.y } : { ...a, ox: p.x, oy: p.y };
                        if (!a.smooth || e.altKey) return { ...next, smooth: e.altKey ? false : a.smooth };
                        // a smooth point keeps its two handles in line (each keeps its own length)
                        const len = g.which === 'in' ? Math.hypot(a.ox - a.x, a.oy - a.y) : Math.hypot(a.ix - a.x, a.iy - a.y);
                        const d = Math.hypot(p.x - a.x, p.y - a.y) || 1;
                        const ox = a.x - ((p.x - a.x) / d) * len;
                        const oy = a.y - ((p.y - a.y) / d) * len;
                        return g.which === 'in' ? { ...next, ox, oy } : { ...next, ix: ox, iy: oy };
                      }),
                    },
              ),
            };
          }),
        );
        break;
      case 'pen': {
        if (tool === 'curvature') {
          // dragging places the point; the curve follows
          store.preview(
            updateNodes(base, [g.id], (n) => {
              if (n.type !== 'path') return n;
              return { ...n, subs: n.subs.map((s, si) => (si !== g.sub ? s : autoSmooth({ ...s, anchors: s.anchors.map((a, ai) => (ai === g.index ? { ...corner(p.x, p.y), smooth: true } : a)) }))) };
            }),
          );
          break;
        }
        const cur = findNode(store.docRef.current, g.id);
        if (cur?.type !== 'path') break;
        const a0 = cur.subs[g.sub].anchors[g.index];
        if (Math.hypot(p.x - a0.x, p.y - a0.y) * z < 3) break;
        // dragging out of a new point pulls its handles
        store.preview(
          updateNodes(store.docRef.current, [g.id], (n) => {
            if (n.type !== 'path') return n;
            return { ...n, subs: n.subs.map((s, si) => (si !== g.sub ? s : { ...s, anchors: s.anchors.map((a, ai) => (ai === g.index ? { ...a, ox: p.x, oy: p.y, ix: 2 * a.x - p.x, iy: 2 * a.y - p.y, smooth: true } : a)) })) };
          }),
        );
        break;
      }
      case 'draw': {
        const last = g.points[g.points.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) * z >= 1.5) {
          g.points.push(p);
          setStroke([...g.points]);
        }
        setHover(p);
        break;
      }
      case 'shape': {
        let x0 = g.start.x;
        let y0 = g.start.y;
        let w = p.x - x0;
        let h = p.y - y0;
        let subs: SubPath[];
        if (tool === 'line') {
          let ex = p.x;
          let ey = p.y;
          if (e.shiftKey) {
            const ang = Math.round(Math.atan2(h, w) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(w, h);
            ex = x0 + Math.cos(ang) * len;
            ey = y0 + Math.sin(ang) * len;
          }
          subs = lineSubs(x0, y0, ex, ey);
        } else if (tool === 'polygon' || tool === 'star') {
          const r = Math.hypot(w, h);
          const rot = e.shiftKey ? -Math.PI / 2 : Math.atan2(h, w);
          subs = tool === 'polygon' ? polygonSubs(x0, y0, r, options.sides, rot) : starSubs(x0, y0, r, r * options.starRatio, options.starPoints, rot);
        } else {
          if (e.shiftKey) {
            const s = Math.max(Math.abs(w), Math.abs(h));
            w = Math.sign(w || 1) * s;
            h = Math.sign(h || 1) * s;
          }
          if (e.altKey) {
            x0 -= w;
            y0 -= h;
            w *= 2;
            h *= 2;
          }
          const x = Math.min(x0, x0 + w);
          const y = Math.min(y0, y0 + h);
          subs = tool === 'rect' ? rectSubs(x, y, Math.abs(w), Math.abs(h), options.cornerRadius) : ellipseSubs(x + Math.abs(w) / 2, y + Math.abs(h) / 2, Math.abs(w) / 2, Math.abs(h) / 2);
        }
        store.preview(updateNodes(store.docRef.current, [g.id], (n) => ({ ...(n as PathNode), subs })));
        break;
      }
      case 'textbox':
        setMarquee({ x: Math.min(p.x, g.start.x), y: Math.min(p.y, g.start.y), width: Math.abs(p.x - g.start.x), height: Math.abs(p.y - g.start.y) });
        break;
      case 'builder': {
        const i = regionAt(p);
        if (i >= 0 && !g.hits.has(i)) {
          g.hits.add(i);
          setBuilderHits([...g.hits]);
        }
        break;
      }
      case 'gradient': {
        const node = findNode(base, g.id);
        if (!node || (node.type !== 'path' && node.type !== 'text')) break;
        const local = node.type === 'text' ? invert(node.matrix) : null;
        const box = node.type === 'text' ? textLocalBox(node, browserMeasure) : subsBounds(node.subs);
        if (!box) break;
        const unit = (q: Pt) => {
          const l = local ? applyMat(local, q.x, q.y) : q;
          return { x: (l.x - box.x) / (box.width || 1), y: (l.y - box.y) / (box.height || 1) };
        };
        const a = unit(g.start);
        const b = unit(p);
        const old = node.fill;
        const stops = old.type === 'linear' || old.type === 'radial' ? old.stops : [{ offset: 0, color: solidOf(old, '#ffffff') }, { offset: 1, color: '#000000' }];
        const fill: Paint = old.type === 'radial' ? { type: 'radial', stops, cx: a.x, cy: a.y, r: Math.max(0.01, Math.hypot(b.x - a.x, b.y - a.y)) } : { type: 'linear', stops, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
        store.preview(updateNodes(base, [g.id], (n) => ({ ...(n as PathNode), fill })));
        break;
      }
      case 'mesh': {
        const node = findNode(base, g.id);
        if (node?.type !== 'path' || node.fill.type !== 'mesh') break;
        const box = subsBounds(node.subs)!;
        const mesh = node.fill;
        const points = mesh.points.map((q, i) => (i === g.index ? { ...q, x: (p.x - box.x) / (box.width || 1), y: (p.y - box.y) / (box.height || 1) } : q));
        store.preview(updateNodes(base, [g.id], (n) => ({ ...(n as PathNode), fill: { ...mesh, points } })));
        break;
      }
      case 'board-new':
        store.preview({
          ...store.docRef.current,
          artboards: store.docRef.current.artboards.map((a) => (a.id === g.id ? { ...a, x: Math.min(p.x, g.start.x), y: Math.min(p.y, g.start.y), width: Math.max(1, Math.abs(p.x - g.start.x)), height: Math.max(1, Math.abs(p.y - g.start.y)) } : a)),
        });
        break;
      case 'board-move': {
        const dx = Math.round(p.x - g.start.x);
        const dy = Math.round(p.y - g.start.y);
        const board = base.artboards.find((a) => a.id === g.id)!;
        // the artwork sitting on the artboard moves with it
        const riders = new Set(
          base.layers.flatMap((l) => l.children).filter((n) => {
            const b = nodeBounds(n, browserMeasure);
            return b && b.x + b.width / 2 >= board.x && b.x + b.width / 2 <= board.x + board.width && b.y + b.height / 2 >= board.y && b.y + b.height / 2 <= board.y + board.height;
          }).map((n) => n.id),
        );
        const moved = updateNodes(base, riders, (n) => transformNode(n, translate(dx, dy)));
        store.preview({ ...moved, artboards: moved.artboards.map((a) => (a.id === g.id ? { ...a, x: board.x + dx, y: board.y + dy } : a)) });
        break;
      }
      case 'board-size': {
        const b = g.box;
        let x0 = b.x;
        let y0 = b.y;
        let x1 = b.x + b.width;
        let y1 = b.y + b.height;
        if (g.hx === 0) x0 = Math.min(p.x, x1 - 1);
        if (g.hx === 1) x1 = Math.max(p.x, x0 + 1);
        if (g.hy === 0) y0 = Math.min(p.y, y1 - 1);
        if (g.hy === 1) y1 = Math.max(p.y, y0 + 1);
        store.preview({ ...base, artboards: base.artboards.map((a) => (a.id === g.id ? { ...a, x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) } : a)) });
        break;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = drag.current;
    drag.current = null;
    if (!g) return;
    const p = toDoc(e);
    const d = store.docRef.current;
    const z = viewRef.current.zoom;
    setGuides({});
    switch (g.kind) {
      case 'marquee': {
        const box = marquee;
        setMarquee(null);
        if (!box || (box.width * z < 3 && box.height * z < 3)) break;
        if (tool === 'direct' && store.selRef.current.length) {
          const refs: AnchorRef[] = [];
          for (const id of store.selRef.current) {
            const n = findNode(d, id);
            if (n?.type !== 'path') continue;
            n.subs.forEach((s, si) => s.anchors.forEach((a, ai) => {
              if (a.x >= box.x && a.x <= box.x + box.width && a.y >= box.y && a.y <= box.y + box.height) refs.push({ id, sub: si, index: ai });
            }));
          }
          store.setAnchors(g.add ? [...store.anchors, ...refs] : refs);
          break;
        }
        const pool = tool === 'direct' ? allNodes(d).filter((n) => n.type !== 'group') : d.layers.filter((l) => !l.locked && !l.hidden).flatMap((l) => l.children);
        const hits = pool.filter((n) => editable(n) && boxesIntersect(nodeBounds(n, browserMeasure) ?? { x: 1e9, y: 1e9, width: 0, height: 0 }, box)).map((n) => n.id);
        store.select(g.add ? [...new Set([...store.selRef.current, ...hits])] : hits);
        break;
      }
      case 'draw': {
        setStroke(null);
        const pts = g.points;
        try {
          if (tool === 'pencil') {
            if (pts.length < 2) break;
            const closes = pts.length > 8 && Math.hypot(pts[0].x - p.x, pts[0].y - p.y) * z < 10;
            const sub = fitCurve(pts, options.smoothness / z, closes);
            if (!sub) break;
            const strokePaint: Paint = store.style.stroke.type === 'none' ? { type: 'solid', color: '#000000' } : store.style.stroke;
            store.add([styled([sub], { fill: closes ? store.style.fill : { type: 'none' }, stroke: strokePaint })]);
          } else if (tool === 'blob') {
            const color = solidOf(store.style.fill, solidOf(store.style.stroke, '#000000'));
            let subs = brushShape(pts, options.brushSize);
            if (!subs.length) break;
            // a stroke that touches blobs of the same colour joins them, as paint would
            const mates = d.layers.find((l) => l.id === store.activeLayer)?.children.filter((n): n is PathNode => n.type === 'path' && editable(n) && n.stroke.type === 'none' && n.fill.type === 'solid' && n.fill.color === color && (n.fill.alpha ?? 1) === 1 && intersects(n.subs, subs)) ?? [];
            let next = d;
            if (mates.length) {
              subs = uniteSubs([...mates.map((m) => m.subs), subs]);
              next = removeNodes(d, mates.map((m) => m.id));
            }
            const node = styled(subs, { fill: { type: 'solid', color }, stroke: { type: 'none' }, fillRule: 'nonzero' });
            store.apply(addNodes(next, [node], store.activeLayer), [node.id]);
          } else {
            const cut = brushShape(pts, options.eraserSize);
            if (!cut.length) break;
            const cutBox = subsBounds(cut)!;
            const sel = new Set(store.selRef.current);
            let next = d;
            const kept: string[] = [];
            for (const n of allNodes(d)) {
              if (n.type !== 'path' || !editable(n) || (sel.size && !sel.has(n.id) && !sel.has(topLevelOf(d, n.id)?.id ?? ''))) continue;
              const b = subsBounds(n.subs);
              if (!b || !boxesIntersect(b, cutBox)) continue;
              const filled = n.fill.type !== 'none' || n.subs.some((s) => s.closed);
              let subs: SubPath[];
              if (filled) subs = subtractSubs(n.subs.map((s) => ({ ...s, closed: true })), cut, n.fillRule);
              else {
                // an open line is cut where the eraser passes: keep the runs outside it
                subs = [];
                for (const line of flatten(n.subs, 0.5)) {
                  let run: Pt[] = [];
                  const flush = () => {
                    if (run.length > 1) {
                      const s = fitCurve(run, 0.3);
                      if (s) subs.push(s);
                    }
                    run = [];
                  };
                  for (const q of line.points) {
                    if (containsPoint(cut, q.x, q.y)) flush();
                    else run.push(q);
                  }
                  flush();
                }
              }
              next = subs.length ? updateNodes(next, [n.id], (x) => ({ ...(x as PathNode), subs })) : removeNodes(next, [n.id]);
              if (subs.length) kept.push(n.id);
            }
            if (next !== d) store.apply(next, store.selRef.current.filter((id) => findNode(next, id)));
          }
        } catch (err) {
          onError(`That stroke could not be applied: ${err instanceof Error ? err.message : err}`);
        }
        break;
      }
      case 'shape': {
        const node = findNode(d, g.id);
        const b = node?.type === 'path' ? subsBounds(node.subs) : null;
        if (b && b.width * z < 2 && b.height * z < 2) {
          // a click without a drag: a default-sized shape at that point
          const s = 100;
          const subs = tool === 'line' ? lineSubs(p.x, p.y, p.x + s, p.y) : tool === 'rect' ? rectSubs(p.x - s / 2, p.y - s / 2, s, s, options.cornerRadius) : tool === 'ellipse' ? ellipseSubs(p.x, p.y, s / 2, s / 2) : tool === 'polygon' ? polygonSubs(p.x, p.y, s / 2, options.sides) : starSubs(p.x, p.y, s / 2, (s / 2) * options.starRatio, options.starPoints);
          store.preview(updateNodes(d, [g.id], (n) => ({ ...(n as PathNode), subs })));
        }
        store.end();
        store.select([g.id]);
        break;
      }
      case 'textbox': {
        const box = marquee;
        setMarquee(null);
        const leaf = hitLeaf(e, p);
        const base: Omit<TextNode, 'kind' | 'x' | 'y'> = {
          ...store.style, ...store.char, ...store.para, id: newId(), type: 'text', opacity: 1, text: '', matrix: [1, 0, 0, 1, 0, 0],
          fill: store.style.fill.type === 'none' || (store.style.fill.type === 'solid' && store.style.fill.color === '#ffffff') ? { type: 'solid', color: '#000000' } : store.style.fill,
          stroke: { type: 'none' },
        };
        let node: TextNode;
        let next = d;
        if (box && box.width * z > 12 && box.height * z > 12) node = { ...base, kind: 'area', x: box.x, y: box.y, width: box.width, height: box.height };
        else if (leaf?.type === 'path') {
          // clicking a path sets type along it; the path itself is used up, as in Illustrator
          node = { ...base, kind: 'path', x: 0, y: 0, path: leaf.subs, startOffset: 0 };
          next = removeNodes(d, [leaf.id]);
        } else node = { ...base, kind: 'point', x: p.x, y: p.y };
        store.begin();
        store.preview(addNodes(next, [node], store.activeLayer));
        store.select([node.id]);
        setEditing(node.id);
        break;
      }
      case 'builder': {
        const hits = [...g.hits];
        setBuilderHits([]);
        if (!hits.length) break;
        const made: PathNode[] = [];
        const style = (r: Region) => builderNodes[r.top];
        if (g.remove) {
          builderRegions.forEach((r, i) => {
            if (!hits.includes(i)) made.push({ ...style(r), id: newId(), subs: r.subs, fillRule: 'nonzero' });
          });
        } else {
          if (hits.length < 2) break;
          builderRegions.forEach((r, i) => {
            if (!hits.includes(i)) made.push({ ...style(r), id: newId(), subs: r.subs, fillRule: 'nonzero' });
          });
          // the merged shape looks like the region the drag started on
          made.push({ ...style(builderRegions[hits[0]]), id: newId(), subs: uniteSubs(hits.map((i) => builderRegions[i].subs)), fillRule: 'nonzero' });
        }
        const top = builderNodes[builderNodes.length - 1];
        let next = replaceNode(d, top.id, made);
        next = removeNodes(next, builderNodes.slice(0, -1).map((n) => n.id));
        store.apply(next, made.map((n) => n.id));
        break;
      }
      case 'move':
        if (!g.moved && tool === 'select' && e.detail === 0) break;
        store.end();
        break;
      case 'anchors':
      case 'ctrl':
      case 'scale':
      case 'rotate':
      case 'gradient':
      case 'mesh':
      case 'board-move':
      case 'board-size':
        store.end();
        break;
      case 'board-new': {
        const board = d.artboards.find((a) => a.id === g.id);
        // a click without a drag makes nothing
        if (board && (board.width * z < 8 || board.height * z < 8)) store.cancel();
        else store.end();
        break;
      }
      case 'pen':
        // the path stays in progress; each point is its own undo step
        store.end();
        break;
      default:
        break;
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const p = toDoc(e);
    if (tool === 'select' || tool === 'direct') {
      const leaf = hitLeaf(e, p);
      if (leaf?.type === 'text') {
        store.select([topLevelOf(store.docRef.current, leaf.id)?.id ?? leaf.id]);
        setEditing(leaf.id);
      }
      return;
    }
    if (tool === 'curvature' && pen) {
      // double-click makes the last point a corner
      const node = findNode(store.docRef.current, pen.id);
      if (node?.type !== 'path') return;
      store.apply(
        updateNodes(store.docRef.current, [pen.id], (n) => {
          const path = n as PathNode;
          return { ...path, subs: path.subs.map((s, si) => (si !== pen.sub ? s : autoSmooth({ ...s, anchors: s.anchors.map((a, ai) => (ai === s.anchors.length - 1 ? { ...a, smooth: false } : a)) }))) };
        }),
      );
    } else if (tool === 'pen') finishPath();
  };

  // ── text editing overlay ──
  const editNode = editing ? findNode(doc, editing) : null;
  const editText = editNode?.type === 'text' ? editNode : null;
  useEffect(() => {
    if (editing && !editText) setEditing(null);
  }, [editing, editText]);
  const endEdit = () => {
    const id = editing;
    setEditing(null);
    if (!id) return;
    const n = findNode(store.docRef.current, id);
    if (n?.type === 'text' && !n.text.trim()) {
      // nothing typed: no empty text object is left behind
      store.preview(removeNodes(store.docRef.current, [id]));
      store.select([]);
    }
    store.end();
  };
  const editBox = editText ? nodeBounds(editText, browserMeasure) : null;

  // ── overlays ──
  const z = view.zoom;
  const cursor = space || tool === 'hand' ? 'grab' : tool === 'select' || tool === 'direct' ? 'default' : tool === 'text' ? 'text' : tool === 'zoom' ? 'zoom-in' : tool === 'blob' || tool === 'eraser' ? 'none' : 'crosshair';
  const penNode = pen ? findNode(doc, pen.id) : null;
  const penLast = penNode?.type === 'path' ? penNode.subs[pen!.sub]?.anchors.at(-1) : null;
  const single = store.selectedNodes.length === 1 ? store.selectedNodes[0] : null;
  const showAnchors = tool === 'direct' || tool === 'pen' || tool === 'curvature' || tool === 'scissors';
  const anchorNodes = showAnchors ? store.selectedNodes.flatMap((n) => (n.type === 'group' ? allNodes({ ...doc, layers: [{ id: '', name: '', children: n.children }] }) : [n])).filter((n): n is PathNode => n.type === 'path') : [];
  const isSel = (id: string, si: number, ai: number) => anchors.some((r) => r.id === id && r.sub === si && r.index === ai);
  const meshNode = single?.type === 'path' && single.fill.type === 'mesh' && (tool === 'mesh' || tool === 'direct' || tool === 'select') ? single : null;
  const gradNode = tool === 'gradient' && single?.type === 'path' && (single.fill.type === 'linear' || single.fill.type === 'radial') ? single : null;
  const activeBoard = doc.artboards.find((a) => a.id === store.activeArtboard);

  return (
    <div className="vx-canvas" ref={hostRef} style={{ cursor }}>
      <svg
        className="vx-svg"
        width="100%"
        height="100%"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null;
          store.cancel();
          setMarquee(null);
          setStroke(null);
        }}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${z})`}>
          {doc.artboards.map((a) => (
            <g key={a.id}>
              <rect className={`vx-board${a.id === store.activeArtboard ? ' is-active' : ''}`} x={a.x} y={a.y} width={a.width} height={a.height} strokeWidth={px(1)} />
              <text className="vx-board-label" x={a.x} y={a.y - px(6)} fontSize={px(11)}>{a.name}</text>
            </g>
          ))}
          <g className="vx-art">
            {doc.layers.map((layer) =>
              layer.hidden ? null : (
                <g key={layer.id} style={{ pointerEvents: layer.locked ? 'none' : undefined }}>
                  {layer.children.map((n) => <NodeView key={n.id} node={n} hidden={n.id === editing && (n as TextNode).kind !== 'path'} />)}
                </g>
              ),
            )}
          </g>

          {/* outlines of the selection */}
          <g className="vx-overlay" pointerEvents="none">
            {store.selectedNodes.map((n) => (n.type === 'path' ? <path key={n.id} className="vx-outline" d={subsToD(n.subs)} strokeWidth={px(1)} /> : null))}
            {guides.x !== undefined && <line className="vx-guide" x1={guides.x} x2={guides.x} y1={-1e5} y2={1e5} strokeWidth={px(1)} />}
            {guides.y !== undefined && <line className="vx-guide" y1={guides.y} y2={guides.y} x1={-1e5} x2={1e5} strokeWidth={px(1)} />}
            {marquee && <rect className="vx-marquee" x={marquee.x} y={marquee.y} width={marquee.width} height={marquee.height} strokeWidth={px(1)} />}
            {stroke && stroke.length > 1 && (
              <polyline
                className={`vx-stroke vx-stroke-${tool}`}
                points={stroke.map((q) => `${q.x},${q.y}`).join(' ')}
                strokeWidth={tool === 'blob' ? options.brushSize : tool === 'eraser' ? options.eraserSize : px(1.5)}
              />
            )}
            {(tool === 'blob' || tool === 'eraser') && hover && <circle className="vx-brush" cx={hover.x} cy={hover.y} r={(tool === 'blob' ? options.brushSize : options.eraserSize) / 2} strokeWidth={px(1)} />}
            {penLast && hover && !drag.current && <line className="vx-rubber" x1={penLast.x} y1={penLast.y} x2={hover.x} y2={hover.y} strokeWidth={px(1)} />}
          </g>

          {/* shape builder regions */}
          {tool === 'shapebuilder' && builderRegions.map((r, i) => (
            <path key={i} className={`vx-region${builderHits.includes(i) ? ' is-hit' : ''}`} d={subsToD(r.subs)} strokeWidth={px(1)} pointerEvents="none" />
          ))}

          {/* selection box and transform handles */}
          {tool === 'select' && selBox && !editing && (
            <g className="vx-box">
              <rect x={selBox.x} y={selBox.y} width={selBox.width} height={selBox.height} strokeWidth={px(1)} pointerEvents="none" />
              <line x1={selBox.x + selBox.width / 2} y1={selBox.y} x2={selBox.x + selBox.width / 2} y2={selBox.y - px(22)} strokeWidth={px(1)} pointerEvents="none" />
              <circle data-handle="rot" cx={selBox.x + selBox.width / 2} cy={selBox.y - px(22)} r={px(5)} strokeWidth={px(1)} style={{ cursor: 'grab' }}><title>Rotate (Shift: 15° steps)</title></circle>
              {HANDLES.map(([id, hx, hy]) => (
                <rect key={id} data-handle={id} x={selBox.x + hx * selBox.width - px(4)} y={selBox.y + hy * selBox.height - px(4)} width={px(8)} height={px(8)} strokeWidth={px(1)} style={{ cursor: HANDLE_CURSOR[id] }} />
              ))}
            </g>
          )}

          {/* anchors and handles */}
          {anchorNodes.map((n) => (
            <g key={n.id} className="vx-anchors">
              {n.subs.map((s, si) =>
                s.anchors.map((a, ai) => {
                  const sel = isSel(n.id, si, ai);
                  return (
                    <g key={`${si}:${ai}`}>
                      {sel && tool === 'direct' && (a.ix !== a.x || a.iy !== a.y) && (
                        <>
                          <line x1={a.x} y1={a.y} x2={a.ix} y2={a.iy} strokeWidth={px(1)} pointerEvents="none" />
                          <circle data-ctrl={`${n.id}:${si}:${ai}:in`} cx={a.ix} cy={a.iy} r={px(3.5)} strokeWidth={px(1)} />
                        </>
                      )}
                      {sel && tool === 'direct' && (a.ox !== a.x || a.oy !== a.y) && (
                        <>
                          <line x1={a.x} y1={a.y} x2={a.ox} y2={a.oy} strokeWidth={px(1)} pointerEvents="none" />
                          <circle data-ctrl={`${n.id}:${si}:${ai}:out`} cx={a.ox} cy={a.oy} r={px(3.5)} strokeWidth={px(1)} />
                        </>
                      )}
                      <rect
                        className={sel ? 'is-selected' : undefined}
                        data-anchor={tool === 'direct' ? `${n.id}:${si}:${ai}` : undefined}
                        pointerEvents={tool === 'direct' ? undefined : 'none'}
                        x={a.x - px(3.5)}
                        y={a.y - px(3.5)}
                        width={px(7)}
                        height={px(7)}
                        strokeWidth={px(1)}
                      />
                    </g>
                  );
                }),
              )}
            </g>
          ))}

          {/* gradient mesh */}
          {meshNode && meshNode.fill.type === 'mesh' && (() => {
            const m = meshNode.fill;
            const b = subsBounds(meshNode.subs)!;
            const at = (i: number) => ({ x: b.x + m.points[i].x * b.width, y: b.y + m.points[i].y * b.height });
            const lines: string[] = [];
            for (let r = 0; r <= m.rows; r++) lines.push(Array.from({ length: m.cols + 1 }, (_, c) => at(r * (m.cols + 1) + c)).map((q) => `${q.x},${q.y}`).join(' '));
            for (let c = 0; c <= m.cols; c++) lines.push(Array.from({ length: m.rows + 1 }, (_, r) => at(r * (m.cols + 1) + c)).map((q) => `${q.x},${q.y}`).join(' '));
            return (
              <g className="vx-mesh">
                {lines.map((pts, i) => <polyline key={i} points={pts} strokeWidth={px(1)} pointerEvents="none" />)}
                {tool === 'mesh' && m.points.map((q, i) => (
                  <circle key={i} data-mesh={i} className={meshSel === i ? 'is-selected' : undefined} cx={at(i).x} cy={at(i).y} r={px(meshSel === i ? 5.5 : 4.5)} fill={q.color} strokeWidth={px(1.5)} />
                ))}
              </g>
            );
          })()}

          {/* gradient annotator */}
          {gradNode && (() => {
            const b = subsBounds(gradNode.subs)!;
            const f = gradNode.fill;
            const P = (u: number, v: number) => ({ x: b.x + u * b.width, y: b.y + v * b.height });
            const a = f.type === 'linear' ? P(f.x1, f.y1) : f.type === 'radial' ? P(f.cx, f.cy) : P(0, 0);
            const c = f.type === 'linear' ? P(f.x2, f.y2) : f.type === 'radial' ? P(f.cx + f.r, f.cy) : P(1, 0);
            return (
              <g className="vx-gradient" pointerEvents="none">
                <line x1={a.x} y1={a.y} x2={c.x} y2={c.y} strokeWidth={px(3)} className="vx-gradient-back" />
                <line x1={a.x} y1={a.y} x2={c.x} y2={c.y} strokeWidth={px(1)} />
                <circle cx={a.x} cy={a.y} r={px(4)} strokeWidth={px(1)} />
                <rect x={c.x - px(4)} y={c.y - px(4)} width={px(8)} height={px(8)} strokeWidth={px(1)} />
              </g>
            );
          })()}

          {/* artboard handles */}
          {tool === 'artboard' && activeBoard && (
            <g className="vx-box vx-board-box">
              <rect x={activeBoard.x} y={activeBoard.y} width={activeBoard.width} height={activeBoard.height} strokeWidth={px(1.5)} pointerEvents="none" />
              {HANDLES.map(([id, hx, hy]) => (
                <rect key={id} data-board-handle={id} x={activeBoard.x + hx * activeBoard.width - px(4)} y={activeBoard.y + hy * activeBoard.height - px(4)} width={px(8)} height={px(8)} strokeWidth={px(1)} style={{ cursor: HANDLE_CURSOR[id] }} />
              ))}
            </g>
          )}
        </g>
      </svg>
      {editText && editBox && (
        <textarea
          className="vx-text-edit"
          autoFocus
          spellCheck={false}
          value={editText.text}
          placeholder="Type…"
          style={{
            left: (editText.kind === 'path' ? editBox.x : editText.align === 'center' && editText.kind === 'point' ? editBox.x + editBox.width / 2 - Math.max(editBox.width, 120 / z) / 2 : editBox.x) * z + view.x - 2,
            top: editBox.y * z + view.y - 2,
            width: Math.max(editText.kind === 'area' ? editBox.width * z : editBox.width * z + editText.size * z * 2, 120),
            height: Math.max(editBox.height * z + 8, editText.size * editText.leading * z + 8),
            font: editText.kind === 'path' ? undefined : `${editText.italic ? 'italic ' : ''}${editText.weight} ${editText.size * z * Math.hypot(editText.matrix[0], editText.matrix[1])}px/${editText.leading} ${fontFamilyCss(editText.family)}`,
            letterSpacing: editText.kind === 'path' ? undefined : `${(editText.tracking / 1000) * editText.size * z}px`,
            textAlign: editText.kind === 'path' ? 'left' : editText.align,
            color: editText.kind === 'path' ? undefined : editText.fill.type === 'solid' ? editText.fill.color : '#000000',
            whiteSpace: editText.kind === 'area' ? 'pre-wrap' : 'pre',
          }}
          onChange={(e) => {
            store.begin();
            store.preview(updateNodes(store.docRef.current, [editText.id], (n) => ({ ...(n as TextNode), text: e.target.value })));
          }}
          onBlur={endEdit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
              e.preventDefault();
              endEdit();
            }
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
});
