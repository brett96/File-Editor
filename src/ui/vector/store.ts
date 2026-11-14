/**
 * Vector Studio editor state: the document, what is selected, undo history and the commands
 * (Object / Path / Type menus, shortcuts, panels) that act on the selection. The canvas tools
 * build on the same few primitives: `apply` for one-step edits, `begin` / `preview` / `end`
 * for a drag that should undo as one step.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { browserMeasure, outlineText, traceImage } from '../../core/vector/browser';
import { derive, joinSubs, offsetSubs, outlineStroke, pathfinder, reverseSubs, simplifySubs, type BooleanOp } from '../../core/vector/geom';
import {
  DEFAULT_CHAR, DEFAULT_PARA, DEFAULT_STYLE, addNodes, allNodes, arrange, cloneNode, findNode, groupNodes, layerOf, mapNodes, newId, removeNodes, replaceNode,
  topLevelOf, ungroupNodes, updateNodes,
  type Arrange, type Artboard, type CharStyle, type Layer, type Paint, type ParaStyle, type PathNode, type Style, type TextNode, type VNode, type VectorDoc,
} from '../../core/vector/model';
import { boundsOfNodes, nodeBounds, rotateAbout, scaleAbout, transformNode, translate, type Box } from '../../core/vector/path';
import type { TraceOptions } from '../../core/vector/trace';

export type ToolId =
  | 'select' | 'direct' | 'pen' | 'curvature' | 'pencil' | 'blob' | 'line' | 'rect' | 'ellipse' | 'polygon' | 'star' | 'text'
  | 'eraser' | 'scissors' | 'shapebuilder' | 'gradient' | 'mesh' | 'eyedropper' | 'artboard' | 'hand' | 'zoom';

export interface AnchorRef {
  id: string;
  sub: number;
  index: number;
}

/** What the colour controls are editing. */
export type PaintTarget = 'fill' | 'stroke';

export interface ToolOptions {
  cornerRadius: number;
  sides: number;
  starPoints: number;
  starRatio: number;
  brushSize: number;
  eraserSize: number;
  smoothness: number;
}

export const DEFAULT_TOOL_OPTIONS: ToolOptions = { cornerRadius: 0, sides: 6, starPoints: 5, starRatio: 0.45, brushSize: 16, eraserSize: 24, smoothness: 4 };

interface Snapshot {
  doc: VectorDoc;
  selection: string[];
}

const HISTORY_MAX = 200;

export type AlignHow = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom' | 'hdist' | 'vdist';

export function useVectorStore(initial: VectorDoc, onChange: () => void, onError: (message: string) => void) {
  const [doc, setDocState] = useState(initial);
  const [selection, setSelectionState] = useState<string[]>([]);
  const [anchors, setAnchors] = useState<AnchorRef[]>([]);
  const [activeLayer, setActiveLayer] = useState(initial.layers[initial.layers.length - 1]?.id ?? '');
  const [activeArtboard, setActiveArtboard] = useState(initial.artboards[0]?.id ?? '');
  const [style, setStyle] = useState<Style>(DEFAULT_STYLE);
  const [char, setChar] = useState<CharStyle>(DEFAULT_CHAR);
  const [para, setPara] = useState<ParaStyle>(DEFAULT_PARA);
  const [target, setTarget] = useState<PaintTarget>('fill');
  const [, setHistoryTick] = useState(0);

  const docRef = useRef(doc);
  const selRef = useRef(selection);
  const undo = useRef<Snapshot[]>([]);
  const redo = useRef<Snapshot[]>([]);
  /** the document as it was when the current drag started */
  const base = useRef<Snapshot | null>(null);
  const clipboard = useRef<VNode[]>([]);

  const setDoc = useCallback((next: VectorDoc) => {
    docRef.current = next;
    setDocState(next);
  }, []);

  const select = useCallback((ids: string[]) => {
    selRef.current = ids;
    setSelectionState(ids);
    setAnchors((a) => (a.length && !a.every((x) => ids.includes(x.id)) ? a.filter((x) => ids.includes(x.id)) : a));
  }, []);

  const push = useCallback((snap: Snapshot) => {
    undo.current.push(snap);
    if (undo.current.length > HISTORY_MAX) undo.current.shift();
    redo.current = [];
    setHistoryTick((n) => n + 1);
  }, []);

  /** One undoable edit. */
  const apply = useCallback(
    (next: VectorDoc, nextSelection?: string[]) => {
      if (next === docRef.current && !nextSelection) return;
      if (next !== docRef.current) {
        if (!base.current) push({ doc: docRef.current, selection: selRef.current });
        setDoc(next);
        onChange();
      }
      if (nextSelection) select(nextSelection);
    },
    [onChange, push, select, setDoc],
  );

  /** Start of a drag: edits until `end` are one undo step. */
  const begin = useCallback(() => {
    if (!base.current) base.current = { doc: docRef.current, selection: selRef.current };
  }, []);
  const end = useCallback(() => {
    const b = base.current;
    base.current = null;
    if (b && b.doc !== docRef.current) push(b);
  }, [push]);
  /** Abandons the drag in progress, putting the document back. */
  const cancel = useCallback(() => {
    const b = base.current;
    base.current = null;
    if (b) {
      setDoc(b.doc);
      select(b.selection);
    }
  }, [select, setDoc]);

  const undoStep = useCallback(() => {
    const snap = undo.current.pop();
    if (!snap) return;
    redo.current.push({ doc: docRef.current, selection: selRef.current });
    setDoc(snap.doc);
    select(snap.selection.filter((id) => findNode(snap.doc, id)));
    setHistoryTick((n) => n + 1);
    onChange();
  }, [onChange, select, setDoc]);

  const redoStep = useCallback(() => {
    const snap = redo.current.pop();
    if (!snap) return;
    undo.current.push({ doc: docRef.current, selection: selRef.current });
    setDoc(snap.doc);
    select(snap.selection.filter((id) => findNode(snap.doc, id)));
    setHistoryTick((n) => n + 1);
    onChange();
  }, [onChange, select, setDoc]);

  const selectedNodes = useMemo(() => selection.map((id) => findNode(doc, id)).filter((n): n is VNode => !!n), [doc, selection]);

  // ── helpers over the live document ──
  const current = () => selRef.current.map((id) => findNode(docRef.current, id)).filter((n): n is VNode => !!n);
  const selectedBox = (): Box | null => boundsOfNodes(current(), browserMeasure);

  const add = useCallback(
    (nodes: VNode[], selectThem = true) => {
      const layer = docRef.current.layers.find((l) => l.id === activeLayer && !l.locked && !l.hidden);
      apply(addNodes(docRef.current, nodes, layer?.id), selectThem ? nodes.map((n) => n.id) : undefined);
    },
    [activeLayer, apply],
  );

  const patchSelection = useCallback(
    (fn: (n: VNode) => VNode) => {
      if (!selRef.current.length) return;
      // a style change on a group reaches everything inside it
      const deep = (n: VNode): VNode => (n.type === 'group' ? { ...n, children: n.children.map(deep) } : fn(n));
      apply(updateNodes(docRef.current, selRef.current, deep));
    },
    [apply],
  );

  /** Sets appearance on the selection and as the default for what is drawn next. */
  const setAppearance = useCallback(
    (patch: Partial<Style>) => {
      setStyle((s) => ({ ...s, ...patch }));
      patchSelection((n) => (n.type === 'path' || n.type === 'text' ? { ...n, ...patch } : n));
    },
    [patchSelection],
  );

  const setPaint = useCallback((which: PaintTarget, paint: Paint) => setAppearance(which === 'fill' ? { fill: paint } : { stroke: paint }), [setAppearance]);

  const setText = useCallback(
    (c: Partial<CharStyle>, p: Partial<ParaStyle> = {}) => {
      setChar((s) => ({ ...s, ...c }));
      setPara((s) => ({ ...s, ...p }));
      patchSelection((n) => (n.type === 'text' ? { ...n, ...c, ...p } : n));
    },
    [patchSelection],
  );

  const transformSelection = useCallback(
    (m: Parameters<typeof transformNode>[1]) => {
      if (!selRef.current.length) return;
      apply(updateNodes(docRef.current, selRef.current, (n) => transformNode(n, m)));
    },
    [apply],
  );

  const commands = useMemo(() => {
    const paths = (): PathNode[] => current().filter((n): n is PathNode => n.type === 'path');
    /** the selected paths in stacking order, bottom first */
    const stacked = (): PathNode[] => {
      const sel = new Set(selRef.current);
      return allNodes(docRef.current).filter((n): n is PathNode => sel.has(n.id) && n.type === 'path');
    };
    /** swaps the selected paths for `result`, at the place of the topmost of them */
    const replaceMany = (old: PathNode[], result: VNode[]) => {
      if (!old.length) return;
      const top = old[old.length - 1];
      let next = replaceNode(docRef.current, top.id, result);
      next = removeNodes(next, old.slice(0, -1).map((n) => n.id));
      apply(next, result.map((n) => n.id));
    };

    return {
      remove() {
        if (selRef.current.length) apply(removeNodes(docRef.current, selRef.current), []);
      },
      selectAll() {
        select(docRef.current.layers.filter((l) => !l.locked && !l.hidden).flatMap((l) => l.children.filter((n) => !n.locked && !n.hidden).map((n) => n.id)));
      },
      deselect() {
        select([]);
      },
      inverse() {
        const sel = new Set(selRef.current);
        select(docRef.current.layers.filter((l) => !l.locked && !l.hidden).flatMap((l) => l.children.filter((n) => !n.locked && !n.hidden && !sel.has(n.id)).map((n) => n.id)));
      },
      /** Select ▸ Same fill colour / same stroke colour */
      selectSame(which: PaintTarget) {
        const ref = current().find((n): n is PathNode | TextNode => n.type === 'path' || n.type === 'text');
        if (!ref) return;
        const key = JSON.stringify(ref[which]);
        select(allNodes(docRef.current).filter((n) => (n.type === 'path' || n.type === 'text') && JSON.stringify(n[which]) === key && topLevelOf(docRef.current, n.id)?.id === n.id).map((n) => n.id));
      },
      copy() {
        clipboard.current = current();
      },
      cut() {
        clipboard.current = current();
        this.remove();
      },
      paste(inPlace = false) {
        if (!clipboard.current.length) return;
        const d = inPlace ? 0 : 12;
        const nodes = clipboard.current.map((n) => transformNode(cloneNode(n), translate(d, d)));
        clipboard.current = inPlace ? clipboard.current : nodes;
        add(nodes);
      },
      duplicate() {
        const nodes = current().map((n) => transformNode(cloneNode(n), translate(12, 12)));
        if (nodes.length) add(nodes);
      },
      group() {
        const { doc: next, group } = groupNodes(docRef.current, new Set(selRef.current));
        if (group) apply(next, [group.id]);
      },
      ungroup() {
        const { doc: next, children } = ungroupNodes(docRef.current, new Set(selRef.current));
        if (children.length) apply(next, children.map((c) => c.id));
      },
      clippingMask() {
        const sel = current();
        if (sel.length < 2) return onError('Select the artwork and, on top of it, the shape to mask it with.');
        const top = allNodes(docRef.current).filter((n) => selRef.current.includes(n.id)).pop();
        if (top?.type !== 'path') return onError('The topmost selected object must be a path: it becomes the mask.');
        const { doc: next, group } = groupNodes(docRef.current, new Set(selRef.current), true);
        if (group) apply(next, [group.id]);
      },
      releaseMask() {
        this.ungroup();
      },
      /** Object ▸ Compound Path ▸ Make: the selected paths become one path whose overlaps are holes */
      compound() {
        const sel = stacked();
        if (sel.length < 2) return;
        const top = sel[sel.length - 1];
        replaceMany(sel, [derive(top, sel.flatMap((p) => p.subs), { fillRule: 'evenodd' })]);
      },
      releaseCompound() {
        const out: VNode[] = [];
        let next = docRef.current;
        for (const p of paths()) {
          if (p.subs.length < 2) continue;
          const parts = p.subs.map((s) => derive(p, [s], { fillRule: 'nonzero' }));
          out.push(...parts);
          next = replaceNode(next, p.id, parts);
        }
        if (out.length) apply(next, out.map((n) => n.id));
      },
      arrange(how: Arrange) {
        if (selRef.current.length) apply(arrange(docRef.current, new Set(selRef.current), how));
      },
      lock() {
        if (selRef.current.length) apply(updateNodes(docRef.current, selRef.current, (n) => ({ ...n, locked: true })), []);
      },
      hide() {
        if (selRef.current.length) apply(updateNodes(docRef.current, selRef.current, (n) => ({ ...n, hidden: true })), []);
      },
      unlockAll() {
        apply(mapNodes(docRef.current, (n) => (n.locked ? { ...n, locked: undefined } : n)));
      },
      showAll() {
        apply(mapNodes(docRef.current, (n) => (n.hidden ? { ...n, hidden: undefined } : n)));
      },
      pathfinder(op: BooleanOp) {
        const sel = stacked();
        if (sel.length < 2) return onError('Select two or more paths to combine. (Convert text to outlines first.)');
        try {
          const result = pathfinder(op, sel);
          if (!result.length) {
            apply(removeNodes(docRef.current, sel.map((n) => n.id)), []);
            return;
          }
          replaceMany(sel, result);
        } catch (err) {
          onError(`Could not combine these shapes: ${err instanceof Error ? err.message : err}`);
        }
      },
      outlineStroke() {
        let next = docRef.current;
        const made: string[] = [];
        for (const p of paths()) {
          if (p.stroke.type === 'none' || p.strokeWidth <= 0) continue;
          const stroke = derive(p, outlineStroke(p), { fill: p.stroke, stroke: { type: 'none' }, fillRule: 'nonzero' });
          // a filled shape keeps its fill underneath the outlined stroke
          const parts: VNode[] = p.fill.type === 'none' ? [stroke] : [{ id: newId('g'), type: 'group', opacity: 1, children: [{ ...p, id: newId(), stroke: { type: 'none' } }, stroke] }];
          made.push(parts[0].id);
          next = replaceNode(next, p.id, parts);
        }
        if (made.length) apply(next, made);
        else onError('Select a path that has a stroke.');
      },
      offsetPath(distance: number) {
        const made: VNode[] = [];
        for (const p of paths()) {
          const subs = offsetSubs(p.subs.map((s) => ({ ...s, closed: true })), distance);
          if (subs.length) made.push(derive(p, subs, { fillRule: 'nonzero' }));
        }
        if (made.length) add(made);
      },
      simplify(tolerance: number) {
        apply(updateNodes(docRef.current, selRef.current, (n) => (n.type === 'path' ? { ...n, subs: simplifySubs(n.subs, tolerance) } : n)));
      },
      join() {
        const sel = stacked();
        if (!sel.length) return;
        if (sel.length === 1) return apply(updateNodes(docRef.current, [sel[0].id], (n) => (n.type === 'path' ? { ...n, subs: joinSubs(n.subs) } : n)));
        const top = sel[sel.length - 1];
        replaceMany(sel, [derive(top, joinSubs(sel.flatMap((p) => p.subs)))]);
      },
      reverse() {
        apply(updateNodes(docRef.current, selRef.current, (n) => (n.type === 'path' ? { ...n, subs: reverseSubs(n.subs) } : n)));
      },
      async createOutlines() {
        const texts = current().filter((n): n is TextNode => n.type === 'text');
        if (!texts.length) return onError('Select a text object to convert to outlines.');
        let next = docRef.current;
        const made: string[] = [];
        for (const t of texts) {
          const out = await outlineText(t);
          if (!out) continue;
          made.push(out.id);
          next = replaceNode(next, t.id, [out]);
        }
        if (made.length) apply(next, made);
      },
      async imageTrace(options: TraceOptions) {
        const images = current().filter((n): n is Extract<VNode, { type: 'image' }> => n.type === 'image');
        if (!images.length) return onError('Select a placed image to trace.');
        let next = docRef.current;
        const made: string[] = [];
        for (const img of images) {
          const shapes = await traceImage(img, options);
          if (!shapes.length) continue;
          const group: VNode = { id: newId('g'), type: 'group', name: 'Traced image', opacity: 1, children: shapes };
          made.push(group.id);
          next = replaceNode(next, img.id, [group]);
        }
        if (made.length) apply(next, made);
        else onError('Nothing could be traced from this image with these settings.');
      },
      /** Type on a Path: runs the selected text along the selected path. */
      textOnPath() {
        const sel = current();
        const text = sel.find((n): n is TextNode => n.type === 'text');
        const path = sel.find((n): n is PathNode => n.type === 'path');
        if (!text || !path) return onError('Select one text object and one path to flow the text along.');
        const next = removeNodes(updateNodes(docRef.current, [text.id], (n) => ({ ...(n as TextNode), kind: 'path', path: path.subs, startOffset: 0, matrix: [1, 0, 0, 1, 0, 0] })), [path.id]);
        apply(next, [text.id]);
      },
      align(how: AlignHow, toArtboard: boolean) {
        const sel = current();
        if (!sel.length) return;
        const board = docRef.current.artboards.find((a) => a.id === activeArtboard);
        const boxes = sel.map((n) => nodeBounds(n, browserMeasure)!);
        const frame: Box | null = toArtboard || sel.length === 1 ? board ?? null : boundsOfNodes(sel, browserMeasure);
        if (!frame) return;
        const moves = new Map<string, [number, number]>();
        if (how === 'hdist' || how === 'vdist') {
          if (sel.length < 3) return;
          const horizontal = how === 'hdist';
          const order = sel.map((n, i) => ({ n, b: boxes[i] })).sort((a, b) => (horizontal ? a.b.x - b.b.x : a.b.y - b.b.y));
          const size = (b: Box) => (horizontal ? b.width : b.height);
          const start = horizontal ? order[0].b.x : order[0].b.y;
          const last = order[order.length - 1].b;
          const span = (horizontal ? last.x + last.width : last.y + last.height) - start;
          const gap = (span - order.reduce((s, o) => s + size(o.b), 0)) / (order.length - 1);
          let pos = start;
          for (const o of order) {
            const d = pos - (horizontal ? o.b.x : o.b.y);
            moves.set(o.n.id, horizontal ? [d, 0] : [0, d]);
            pos += size(o.b) + gap;
          }
        } else {
          sel.forEach((n, i) => {
            const b = boxes[i];
            const dx = how === 'left' ? frame.x - b.x : how === 'hcenter' ? frame.x + frame.width / 2 - (b.x + b.width / 2) : how === 'right' ? frame.x + frame.width - (b.x + b.width) : 0;
            const dy = how === 'top' ? frame.y - b.y : how === 'vcenter' ? frame.y + frame.height / 2 - (b.y + b.height / 2) : how === 'bottom' ? frame.y + frame.height - (b.y + b.height) : 0;
            moves.set(n.id, [dx, dy]);
          });
        }
        apply(updateNodes(docRef.current, selRef.current, (n) => transformNode(n, translate(...(moves.get(n.id) ?? [0, 0])))));
      },
      flip(horizontal: boolean) {
        const b = selectedBox();
        if (b) transformSelection(scaleAbout(horizontal ? -1 : 1, horizontal ? 1 : -1, b.x + b.width / 2, b.y + b.height / 2));
      },
      rotate(degrees: number) {
        const b = selectedBox();
        if (b) transformSelection(rotateAbout((degrees * Math.PI) / 180, b.x + b.width / 2, b.y + b.height / 2));
      },
      nudge(dx: number, dy: number) {
        transformSelection(translate(dx, dy));
      },
      /** Transform panel: move / resize the selection to an exact box */
      setBox(next: Partial<Box>) {
        const b = selectedBox();
        if (!b) return;
        const w = next.width ?? b.width;
        const h = next.height ?? b.height;
        const sx = b.width ? w / b.width : 1;
        const sy = b.height ? h / b.height : 1;
        transformSelection([sx, 0, 0, sy, (next.x ?? b.x) - b.x * sx, (next.y ?? b.y) - b.y * sy]);
      },

      // ── layers ──
      addLayer() {
        const layer: Layer = { id: newId('l'), name: `Layer ${docRef.current.layers.length + 1}`, children: [] };
        apply({ ...docRef.current, layers: [...docRef.current.layers, layer] });
        setActiveLayer(layer.id);
      },
      patchLayer(id: string, patch: Partial<Layer>) {
        apply({ ...docRef.current, layers: docRef.current.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
      },
      removeLayer(id: string) {
        const layers = docRef.current.layers.filter((l) => l.id !== id);
        if (!layers.length) return onError('A document needs at least one layer.');
        apply({ ...docRef.current, layers }, []);
        if (activeLayer === id) setActiveLayer(layers[layers.length - 1].id);
      },
      moveLayer(id: string, step: 1 | -1) {
        const layers = [...docRef.current.layers];
        const i = layers.findIndex((l) => l.id === id);
        const j = i + step;
        if (i < 0 || j < 0 || j >= layers.length) return;
        [layers[i], layers[j]] = [layers[j], layers[i]];
        apply({ ...docRef.current, layers });
      },
      /** moves the selection to another layer (on top) */
      moveToLayer(id: string) {
        const sel = current();
        if (!sel.length) return;
        const stripped = removeNodes(docRef.current, selRef.current);
        apply(addNodes(stripped, sel, id), selRef.current);
      },
      patchNode(id: string, patch: Partial<VNode>) {
        apply(updateNodes(docRef.current, [id], (n) => ({ ...n, ...patch }) as VNode));
      },

      // ── artboards ──
      addArtboard(width: number, height: number, name?: string) {
        const boards = docRef.current.artboards;
        const right = boards.reduce((x, a) => Math.max(x, a.x + a.width), 0);
        const board: Artboard = { id: newId('a'), name: name ?? `Artboard ${boards.length + 1}`, x: boards.length ? right + 40 : 0, y: boards[0]?.y ?? 0, width, height };
        apply({ ...docRef.current, artboards: [...boards, board] });
        setActiveArtboard(board.id);
        return board;
      },
      patchArtboard(id: string, patch: Partial<Artboard>) {
        apply({ ...docRef.current, artboards: docRef.current.artboards.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
      },
      removeArtboard(id: string) {
        const boards = docRef.current.artboards.filter((a) => a.id !== id);
        if (!boards.length) return onError('A document needs at least one artboard.');
        apply({ ...docRef.current, artboards: boards });
        if (activeArtboard === id) setActiveArtboard(boards[0].id);
      },
      duplicateArtboard(id: string) {
        const src = docRef.current.artboards.find((a) => a.id === id);
        if (!src) return;
        const boards = docRef.current.artboards;
        const right = boards.reduce((x, a) => Math.max(x, a.x + a.width), 0);
        const board: Artboard = { ...src, id: newId('a'), name: `${src.name} copy`, x: right + 40 };
        // the artwork on the artboard comes along
        const inside = docRef.current.layers.flatMap((l) => l.children).filter((n) => {
          const b = nodeBounds(n, browserMeasure);
          return b && b.x + b.width / 2 >= src.x && b.x + b.width / 2 <= src.x + src.width && b.y + b.height / 2 >= src.y && b.y + b.height / 2 <= src.y + src.height;
        });
        let next: VectorDoc = { ...docRef.current, artboards: [...boards, board] };
        for (const n of inside) next = addNodes(next, [transformNode(cloneNode(n), translate(board.x - src.x, board.y - src.y))], layerOf(next, n.id)?.id);
        apply(next);
        setActiveArtboard(board.id);
      },

      // ── swatches and text styles ──
      addSwatch(paint: Paint, name?: string) {
        const key = JSON.stringify(paint);
        if (paint.type === 'none' || docRef.current.swatches.some((s) => JSON.stringify(s.paint) === key)) return;
        apply({ ...docRef.current, swatches: [...docRef.current.swatches, { name: name ?? (paint.type === 'solid' ? paint.color : 'Gradient'), paint }] });
      },
      removeSwatch(index: number) {
        apply({ ...docRef.current, swatches: docRef.current.swatches.filter((_, i) => i !== index) });
      },
      saveTextStyle(name: string, c: CharStyle, p: ParaStyle) {
        const styles = docRef.current.textStyles.filter((s) => s.name !== name);
        apply({ ...docRef.current, textStyles: [...styles, { name, char: c, para: p }] });
      },
      removeTextStyle(name: string) {
        apply({ ...docRef.current, textStyles: docRef.current.textStyles.filter((s) => s.name !== name) });
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeArtboard, activeLayer, add, apply, onError, select, transformSelection]);

  return {
    doc, docRef, selection, selRef, selectedNodes, anchors, setAnchors, select, apply, begin, end, cancel,
    /** sets the document during a drag (between begin and end) */
    preview: setDoc,
    undo: undoStep, redo: redoStep, canUndo: undo.current.length > 0, canRedo: redo.current.length > 0,
    activeLayer, setActiveLayer, activeArtboard, setActiveArtboard,
    style, setStyle, char, para, target, setTarget,
    add, patchSelection, setAppearance, setPaint, setText, transformSelection, commands,
  };
}

export type VectorStore = ReturnType<typeof useVectorStore>;
