/**
 * Vector Studio: the Illustrator-style editor for SVG and Illustrator artwork. Tools on the
 * left, the canvas in the middle, panels on the right; the Object / Path / Type / Select
 * menus and the tool options run along the top.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Blend, Brush, Circle, Combine, Eraser, Frame, Grid3x3, Hand, Hexagon, ImagePlus, Minus, MousePointer2, MousePointerClick, PenTool, Pencil, Pipette, Redo2, Scissors,
  Spline, Square, Star, Type, Undo2, ZoomIn,
} from 'lucide-react';
import { browserRender } from '../../core/vector/browser';
import { loadGeom } from '../../core/vector/geom';
import { paintColorAt } from '../../core/vector/mesh';
import { findNode, newId, updateNodes, type ImageNode, type Paint, type PathNode, type VectorDoc } from '../../core/vector/model';
import { docToSvg } from '../../core/vector/svg';
import { Modal, MenuItem, Popover, PromptModal, cx } from '../components';
import { useTabActive } from '../tab-active';
import { Canvas, type CanvasHandle, type View } from './Canvas';
import { AppearancePanel, ArtboardsPanel, ColorGuidePanel, ColorPanel, GradientPanel, LayersPanel, Num, PathfinderPanel, SwatchesPanel, TransformPanel, TypePanel, useAppearance, type ColorTarget } from './panels';
import { DEFAULT_TOOL_OPTIONS, useVectorStore, type ToolId, type ToolOptions } from './store';
import './vector.css';

export interface VectorEditorHandle {
  getDocument(): VectorDoc;
  /** the document as the app's own editable SVG */
  getSvg(): string;
}

interface Props {
  initial: VectorDoc;
  onChange: () => void;
  onError: (message: string) => void;
  onStatus?: (s: { artboards: number; objects: number; zoom: number }) => void;
}

const TOOLS: { id: ToolId; label: string; key: string; shift?: boolean; icon: ReactNode; group?: boolean }[] = [
  { id: 'select', label: 'Selection', key: 'v', icon: <MousePointer2 size={17} /> },
  { id: 'direct', label: 'Direct selection: anchor points and handles', key: 'a', icon: <MousePointerClick size={17} /> },
  { id: 'pen', label: 'Pen', key: 'p', icon: <PenTool size={17} />, group: true },
  { id: 'curvature', label: 'Curvature', key: '~', shift: true, icon: <Spline size={17} /> },
  { id: 'pencil', label: 'Pencil', key: 'n', icon: <Pencil size={17} /> },
  { id: 'blob', label: 'Blob brush', key: 'b', shift: true, icon: <Brush size={17} /> },
  { id: 'line', label: 'Line segment', key: '\\', icon: <Minus size={17} />, group: true },
  { id: 'rect', label: 'Rectangle', key: 'm', icon: <Square size={17} /> },
  { id: 'ellipse', label: 'Ellipse', key: 'l', icon: <Circle size={17} /> },
  { id: 'polygon', label: 'Polygon', key: 'y', icon: <Hexagon size={17} /> },
  { id: 'star', label: 'Star', key: 's', icon: <Star size={17} /> },
  { id: 'text', label: 'Type: click for point type, drag for a text box, click a path for type on a path', key: 't', icon: <Type size={17} /> },
  { id: 'eraser', label: 'Eraser', key: 'e', shift: true, icon: <Eraser size={17} />, group: true },
  { id: 'scissors', label: 'Scissors: click a path to cut it', key: 'c', icon: <Scissors size={17} /> },
  { id: 'shapebuilder', label: 'Shape builder: drag across regions to merge, Alt-click to remove', key: 'm', shift: true, icon: <Combine size={17} /> },
  { id: 'gradient', label: 'Gradient', key: 'g', icon: <Blend size={17} />, group: true },
  { id: 'mesh', label: 'Gradient mesh', key: 'u', icon: <Grid3x3 size={17} /> },
  { id: 'eyedropper', label: 'Eyedropper: copy an object’s appearance', key: 'i', icon: <Pipette size={17} /> },
  { id: 'artboard', label: 'Artboard', key: 'o', shift: true, icon: <Frame size={17} />, group: true },
  { id: 'hand', label: 'Hand (hold Space)', key: 'h', icon: <Hand size={17} /> },
  { id: 'zoom', label: 'Zoom (Alt-click to zoom out)', key: 'z', icon: <ZoomIn size={17} /> },
];

const shortcut = (t: (typeof TOOLS)[number]) => `${t.shift ? 'Shift+' : ''}${t.key.toUpperCase()}`;

export const VectorEditor = forwardRef<VectorEditorHandle, Props>(function VectorEditor({ initial, onChange, onError, onStatus }, ref) {
  const store = useVectorStore(initial, onChange, onError);
  const [ready, setReady] = useState(false);
  const [tool, setToolState] = useState<ToolId>('select');
  const [options, setOptions] = useState<ToolOptions>(DEFAULT_TOOL_OPTIONS);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const [meshSel, setMeshSel] = useState<number | null>(null);
  const [stop, setStop] = useState(0);
  const [prompt, setPrompt] = useState<{ title: string; initial: string; done: (value: string) => void } | null>(null);
  const [trace, setTrace] = useState<{ mode: 'bw' | 'color'; threshold: number; colors: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const canvas = useRef<CanvasHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const tabActive = useTabActive();

  useEffect(() => {
    let live = true;
    void loadGeom().then(
      () => live && setReady(true),
      () => onError('The path engine could not be loaded.'),
    );
    return () => {
      live = false;
    };
  }, [onError]);

  const setTool = useCallback((t: ToolId) => {
    canvas.current?.finishPath();
    setToolState(t);
    if (t !== 'mesh') setMeshSel(null);
  }, []);

  useImperativeHandle(ref, () => ({
    getDocument: () => store.docRef.current,
    getSvg: () => docToSvg(store.docRef.current, { ...browserRender, embedModel: true }),
  }));

  const objects = useMemo(() => store.doc.layers.reduce((n, l) => n + l.children.length, 0), [store.doc.layers]);
  useEffect(() => onStatus?.({ artboards: store.doc.artboards.length, objects, zoom: view.zoom }), [onStatus, store.doc.artboards.length, objects, view.zoom]);

  // ── colour target: what the Color panel edits right now ──
  const appearance = useAppearance(store);
  const single = store.selectedNodes.length === 1 ? store.selectedNodes[0] : null;
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** runs of quick colour changes (dragging a slider) undo as one step */
  const coalesce = useCallback(
    (fn: () => void) => {
      store.begin();
      fn();
      clearTimeout(settle.current);
      settle.current = setTimeout(() => store.end(), 500);
    },
    [store],
  );
  const colorTarget = useMemo<ColorTarget>(() => {
    const paint: Paint = appearance[store.target];
    if (single?.type === 'path' && single.fill.type === 'mesh' && meshSel !== null && single.fill.points[meshSel]) {
      const mesh = single.fill;
      return {
        color: mesh.points[meshSel].color,
        label: 'mesh point',
        set: (hex) => coalesce(() => store.apply(updateNodes(store.docRef.current, [single.id], (n) => ({ ...(n as PathNode), fill: { ...mesh, points: mesh.points.map((p, i) => (i === meshSel ? { ...p, color: hex } : p)) } })))),
      };
    }
    if (paint.type === 'linear' || paint.type === 'radial') {
      const i = Math.min(stop, paint.stops.length - 1);
      return { color: paint.stops[i].color, label: `${store.target} gradient stop`, set: (hex) => coalesce(() => store.setPaint(store.target, { ...paint, stops: paint.stops.map((s, j) => (j === i ? { ...s, color: hex } : s)) })) };
    }
    const color = paint.type === 'solid' ? paint.color : paint.type === 'mesh' ? paintColorAt(paint, 0.5, 0.5) : store.target === 'fill' ? '#ffffff' : '#000000';
    return { color, label: store.target, set: (hex) => coalesce(() => store.setPaint(store.target, { type: 'solid', color: hex, ...(paint.type === 'solid' && paint.alpha !== undefined ? { alpha: paint.alpha } : {}) })) };
  }, [appearance, coalesce, meshSel, single, stop, store]);

  // ── placing images ──
  const placeImage = async (file: File) => {
    try {
      const href = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('This picture could not be read.'));
        img.src = href;
      });
      const board = store.doc.artboards.find((a) => a.id === store.activeArtboard);
      const scale = board ? Math.min(1, (board.width * 0.8) / img.naturalWidth, (board.height * 0.8) / img.naturalHeight) : 1;
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      const c = canvas.current?.center() ?? { x: w / 2, y: h / 2 };
      const node: ImageNode = { id: newId(), type: 'image', name: file.name, opacity: 1, href, x: c.x - w / 2, y: c.y - h / 2, width: w, height: h, matrix: [1, 0, 0, 1, 0, 0] };
      store.add([node]);
      setTool('select');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'This picture could not be placed.');
    }
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await new Promise((r) => setTimeout(r, 30));
      await fn();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  // ── keyboard ──
  const live = useRef({ tool, store, setTool });
  live.current = { tool, store, setTool };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!tabActive.current) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (document.querySelector('.modal-backdrop, .help-guide')) return;
      const { store: s, tool: t, setTool: pick } = live.current;
      const c = s.commands;
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      const done = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (mod && !e.altKey) {
        if (k === 'z') return done(), e.shiftKey ? s.redo() : s.undo();
        if (k === 'y') return done(), s.redo();
        if (k === 'c') return done(), c.copy();
        if (k === 'x') return done(), c.cut();
        if (k === 'v') return done(), c.paste(e.shiftKey);
        if (k === 'd') return done(), c.duplicate();
        if (k === 'a') return done(), e.shiftKey ? c.deselect() : c.selectAll();
        if (k === 'g') return done(), e.shiftKey ? c.ungroup() : c.group();
        if (k === 'j') return done(), c.join();
        if (k === '7') return done(), c.clippingMask();
        if (k === '8') return done(), c.compound();
        if (k === ']') return done(), c.arrange(e.shiftKey ? 'front' : 'forward');
        if (k === '[') return done(), c.arrange(e.shiftKey ? 'back' : 'backward');
        if (k === 'o' && e.shiftKey) return done(), void c.createOutlines();
        if (k === '0') return done(), canvas.current?.fit();
        if (k === '1') return done(), canvas.current?.zoomTo(1);
        if (k === '=' || k === '+') return done(), canvas.current?.zoomTo(view0.current * 1.25);
        if (k === '-') return done(), canvas.current?.zoomTo(view0.current / 1.25);
        if (k === '2') return done(), c.lock();
        if (k === '3') return done(), c.hide();
        return;
      }
      if (e.altKey) return;
      if (k === 'escape' || k === 'enter') {
        if (canvas.current?.finishPath()) return done();
        if (k === 'escape') c.deselect();
        return;
      }
      if (k === 'delete' || k === 'backspace') {
        done();
        if (t === 'direct' && s.anchors.length) {
          // remove the selected anchor points; a path left with fewer than two points goes
          const refs = s.anchors;
          let next = updateNodes(s.docRef.current, new Set(refs.map((r) => r.id)), (n) => (n.type !== 'path' ? n : { ...n, subs: n.subs.map((sub, si) => ({ ...sub, anchors: sub.anchors.filter((_, ai) => !refs.some((r) => r.id === n.id && r.sub === si && r.index === ai)) })).filter((sub) => sub.anchors.length > 1) }));
          const empty = [...new Set(refs.map((r) => r.id))].filter((id) => {
            const n = findNode(next, id);
            return n?.type === 'path' && !n.subs.length;
          });
          if (empty.length) next = { ...next, layers: next.layers.map((l) => ({ ...l, children: l.children.filter((n) => !empty.includes(n.id)) })) };
          s.setAnchors([]);
          s.apply(next, s.selRef.current.filter((id) => !empty.includes(id)));
        } else if (t === 'artboard') c.removeArtboard(s.activeArtboard);
        else c.remove();
        return;
      }
      if (k.startsWith('arrow')) {
        if (!s.selRef.current.length) return;
        done();
        const d = e.shiftKey ? 10 : 1;
        c.nudge(k === 'arrowleft' ? -d : k === 'arrowright' ? d : 0, k === 'arrowup' ? -d : k === 'arrowdown' ? d : 0);
        return;
      }
      if (k === 'x' && e.shiftKey) {
        done();
        const a = s.selectedNodes.find((n): n is PathNode => n.type === 'path') ?? s.style;
        if (a.fill.type !== 'mesh' && a.stroke.type !== 'mesh') s.setAppearance({ fill: a.stroke, stroke: a.fill });
        return;
      }
      if (k === 'x') return done(), s.setTarget(s.target === 'fill' ? 'stroke' : 'fill');
      if (k === '/') return done(), s.setPaint(s.target, { type: 'none' });
      if (k === 'd') return done(), s.setAppearance({ fill: { type: 'solid', color: '#ffffff' }, stroke: { type: 'solid', color: '#000000' } });
      const hit = TOOLS.find((x) => (x.key === k || (x.key === '~' && (k === '`' || k === '~'))) && !!x.shift === e.shiftKey);
      if (hit) {
        done();
        pick(hit.id);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [tabActive]);
  const view0 = useRef(1);
  view0.current = view.zoom;

  const c = store.commands;
  const has = store.selection.length > 0;
  const item = (label: string, onClick: () => void, hint?: string, disabled?: boolean, close?: () => void) => (
    <MenuItem key={label} hint={hint} disabled={disabled} onClick={() => { close?.(); onClick(); }}>{label}</MenuItem>
  );
  const sep = (k: string) => <div key={k} className="menu-sep" role="separator" />;
  const ask = (title: string, initialValue: string, done: (value: string) => void) => setPrompt({ title, initial: initialValue, done });

  const fitBoard = (id: string) => {
    const b = store.docRef.current.artboards.find((a) => a.id === id);
    if (b) canvas.current?.fit(b);
  };

  if (!ready) return <div className="busy" role="status"><span className="spinner" /> Loading Vector Studio…</div>;

  return (
    <div className="vx-root">
      <div className="vx-menubar" role="toolbar" aria-label="Vector Studio">
        <button type="button" className="btn btn-icon" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!store.canUndo} onClick={store.undo}><Undo2 size={16} /></button>
        <button type="button" className="btn btn-icon" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!store.canRedo} onClick={store.redo}><Redo2 size={16} /></button>
        <span className="vx-sep" />
        <Popover label="Object" text button={<span>Object</span>}>
          {(close) => (
            <div className="format-menu vx-menu" role="menu">
              {item('Group', c.group, 'Ctrl+G', !has, close)}
              {item('Ungroup', c.ungroup, 'Ctrl+Shift+G', !has, close)}
              {sep('a')}
              {item('Bring to front', () => c.arrange('front'), 'Ctrl+Shift+]', !has, close)}
              {item('Bring forward', () => c.arrange('forward'), 'Ctrl+]', !has, close)}
              {item('Send backward', () => c.arrange('backward'), 'Ctrl+[', !has, close)}
              {item('Send to back', () => c.arrange('back'), 'Ctrl+Shift+[', !has, close)}
              {sep('b')}
              {item('Make clipping mask', c.clippingMask, 'Ctrl+7', store.selection.length < 2, close)}
              {item('Release clipping mask', c.releaseMask, undefined, !(single?.type === 'group' && single.clip), close)}
              {item('Make compound path', c.compound, 'Ctrl+8', store.selection.length < 2, close)}
              {item('Release compound path', c.releaseCompound, undefined, !has, close)}
              {sep('c')}
              {item('Lock', c.lock, 'Ctrl+2', !has, close)}
              {item('Unlock all', c.unlockAll, undefined, false, close)}
              {item('Hide', c.hide, 'Ctrl+3', !has, close)}
              {item('Show all', c.showAll, undefined, false, close)}
              {sep('d')}
              {item('Place image…', () => fileInput.current?.click(), undefined, false, close)}
              {item('Image trace…', () => setTrace({ mode: 'color', threshold: 128, colors: 6 }), undefined, single?.type !== 'image', close)}
            </div>
          )}
        </Popover>
        <Popover label="Path" text button={<span>Path</span>}>
          {(close) => (
            <div className="format-menu vx-menu" role="menu">
              {item('Join', c.join, 'Ctrl+J', !has, close)}
              {item('Outline stroke', c.outlineStroke, undefined, !has, close)}
              {item('Offset path…', () => ask('Offset path by (px; negative shrinks)', '10', (v) => Number.isFinite(parseFloat(v)) && c.offsetPath(parseFloat(v))), undefined, !has, close)}
              {item('Simplify…', () => ask('Simplify: tolerance (px)', '2', (v) => parseFloat(v) > 0 && c.simplify(parseFloat(v))), undefined, !has, close)}
              {item('Reverse direction', c.reverse, undefined, !has, close)}
              {sep('a')}
              {item('Unite', () => c.pathfinder('unite'), undefined, store.selection.length < 2, close)}
              {item('Minus front', () => c.pathfinder('minus-front'), undefined, store.selection.length < 2, close)}
              {item('Intersect', () => c.pathfinder('intersect'), undefined, store.selection.length < 2, close)}
              {item('Exclude', () => c.pathfinder('exclude'), undefined, store.selection.length < 2, close)}
              {item('Divide', () => c.pathfinder('divide'), undefined, store.selection.length < 2, close)}
            </div>
          )}
        </Popover>
        <Popover label="Type" text button={<span>Type</span>}>
          {(close) => (
            <div className="format-menu vx-menu" role="menu">
              {item('Create outlines', () => void run('Converting text to outlines…', () => c.createOutlines()), 'Ctrl+Shift+O', !store.selectedNodes.some((n) => n.type === 'text'), close)}
              {item('Type on a path', c.textOnPath, undefined, store.selection.length !== 2, close)}
              {item('Edit text', () => single && canvas.current?.editText(single.id), 'Double-click', single?.type !== 'text', close)}
            </div>
          )}
        </Popover>
        <Popover label="Select" text button={<span>Select</span>}>
          {(close) => (
            <div className="format-menu vx-menu" role="menu">
              {item('All', c.selectAll, 'Ctrl+A', false, close)}
              {item('Deselect', c.deselect, 'Ctrl+Shift+A', !has, close)}
              {item('Inverse', c.inverse, undefined, false, close)}
              {sep('a')}
              {item('Same fill colour', () => c.selectSame('fill'), undefined, !has, close)}
              {item('Same stroke colour', () => c.selectSame('stroke'), undefined, !has, close)}
            </div>
          )}
        </Popover>
        <button type="button" className="btn btn-text" title="Place a picture on the artboard" onClick={() => fileInput.current?.click()}><ImagePlus size={15} /><span>Place</span></button>
        <span className="vx-sep" />
        <div className="vx-options">
          {tool === 'rect' && <Num label="Corner radius" value={options.cornerRadius} min={0} max={1000} onChange={(v) => setOptions({ ...options, cornerRadius: v })} />}
          {tool === 'polygon' && <Num label="Sides" value={options.sides} min={3} max={64} onChange={(v) => setOptions({ ...options, sides: Math.round(v) })} />}
          {tool === 'star' && (
            <>
              <Num label="Points" value={options.starPoints} min={3} max={64} onChange={(v) => setOptions({ ...options, starPoints: Math.round(v) })} />
              <Num label="Inner radius" value={Math.round(options.starRatio * 100)} min={5} max={95} suffix="%" onChange={(v) => setOptions({ ...options, starRatio: v / 100 })} />
            </>
          )}
          {tool === 'blob' && <Num label="Brush size" value={options.brushSize} min={1} max={500} onChange={(v) => setOptions({ ...options, brushSize: v })} />}
          {tool === 'eraser' && (
            <>
              <Num label="Eraser size" value={options.eraserSize} min={1} max={500} onChange={(v) => setOptions({ ...options, eraserSize: v })} />
              <span className="vx-tip">{has ? 'Erases the selected objects only.' : 'Erases every unlocked path it touches.'}</span>
            </>
          )}
          {tool === 'pencil' && <Num label="Smoothness" value={options.smoothness} min={0.5} max={40} step={0.5} onChange={(v) => setOptions({ ...options, smoothness: v })} />}
          {tool === 'direct' && store.anchors.length > 0 && (
            <>
              <button type="button" className="btn btn-text btn-sm" title="Retract the handles: sharp corner" onClick={() => convertAnchors(store, false)}>Corner</button>
              <button type="button" className="btn btn-text btn-sm" title="Give the point smooth handles" onClick={() => convertAnchors(store, true)}>Smooth</button>
            </>
          )}
          {tool === 'pen' && <span className="vx-tip">Click for corners, drag for curves. Click the first point to close, Enter to finish.</span>}
          {tool === 'curvature' && <span className="vx-tip">Click to place smooth points; double-click for a corner. Enter to finish.</span>}
          {tool === 'shapebuilder' && <span className="vx-tip">Select overlapping shapes, then drag across regions to merge. Alt-click removes a region.</span>}
          {tool === 'mesh' && <span className="vx-tip">Click inside a shape to add mesh lines; click a point and choose its colour; drag points to bend the blend.</span>}
          {tool === 'text' && <span className="vx-tip">Click for point type, drag for a text box, click a path to type along it.</span>}
          {tool === 'artboard' && <span className="vx-tip">Drag on empty space for a new artboard; drag an artboard to move it with its artwork.</span>}
        </div>
        <span className="spacer" />
        <button type="button" className="btn btn-text btn-sm" title="Fit the artboard in the window (Ctrl+0)" onClick={() => canvas.current?.fit()}>Fit</button>
        <span className="vx-zoom" title="Ctrl + scroll to zoom">{Math.round(view.zoom * 100)}%</span>
      </div>
      <div className="vx-body">
        <div className="vx-tools" role="toolbar" aria-label="Tools" aria-orientation="vertical">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={cx('vx-tool', tool === t.id && 'is-active', t.group && 'vx-tool-gap')}
              title={`${t.label} (${shortcut(t)})`}
              aria-label={t.label}
              aria-pressed={tool === t.id}
              onClick={() => setTool(t.id)}
            >
              {t.icon}
            </button>
          ))}
        </div>
        <Canvas ref={canvas} store={store} tool={tool} options={options} meshSel={meshSel} setMeshSel={setMeshSel} onView={setView} onError={onError} />
        <aside className="vx-side" aria-label="Panels">
          <AppearancePanel store={store} />
          <ColorPanel target={colorTarget} />
          <GradientPanel store={store} stop={stop} setStop={setStop} />
          <SwatchesPanel store={store} target={colorTarget} />
          <ColorGuidePanel store={store} target={colorTarget} />
          <TransformPanel store={store} />
          <PathfinderPanel store={store} />
          <TypePanel store={store} onPrompt={ask} />
          <LayersPanel store={store} onPrompt={ask} />
          <ArtboardsPanel store={store} onFit={fitBoard} onPrompt={ask} />
        </aside>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/avif,image/bmp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void placeImage(f);
        }}
      />
      {busy && <div className="busy" role="status"><span className="spinner" /> {busy}</div>}
      {prompt && (
        <PromptModal
          title={prompt.title}
          label=""
          initial={prompt.initial}
          onClose={() => setPrompt(null)}
          onSubmit={(v: string) => {
            const p = prompt;
            setPrompt(null);
            if (v.trim()) p.done(v.trim());
          }}
        />
      )}
      {trace && (
        <Modal
          title="Image trace"
          width={420}
          onClose={() => setTrace(null)}
          footer={
            <>
              <span className="spacer" />
              <button type="button" className="btn btn-text" onClick={() => setTrace(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const t = trace;
                  setTrace(null);
                  void run('Tracing the image…', () => c.imageTrace({ mode: t.mode, threshold: t.threshold, colors: t.colors, minSize: 3 }));
                }}
              >
                Trace
              </button>
            </>
          }
        >
          <p className="dialog-text">Turns the selected picture into editable, flat-coloured shapes.</p>
          <div className="choice-list">
            <label className="check"><input type="radio" name="vx-trace" checked={trace.mode === 'color'} onChange={() => setTrace({ ...trace, mode: 'color' })} /> Colour: reduce to
              <input type="number" className="input" style={{ width: 64, marginLeft: 6 }} min={2} max={24} value={trace.colors} onChange={(e) => setTrace({ ...trace, mode: 'color', colors: Math.max(2, Math.min(24, +e.target.value || 2)) })} /> colours
            </label>
            <label className="check"><input type="radio" name="vx-trace" checked={trace.mode === 'bw'} onChange={() => setTrace({ ...trace, mode: 'bw' })} /> Black and white: threshold
              <input type="range" min={1} max={254} value={trace.threshold} style={{ marginLeft: 6 }} onChange={(e) => setTrace({ ...trace, mode: 'bw', threshold: +e.target.value })} /> {trace.threshold}
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
});

/** Direct selection ▸ Corner / Smooth: retracts or gives handles to the selected anchor points. */
function convertAnchors(store: ReturnType<typeof useVectorStore>, smooth: boolean) {
  const refs = store.anchors;
  store.apply(
    updateNodes(store.docRef.current, new Set(refs.map((r) => r.id)), (n) => {
      if (n.type !== 'path') return n;
      return {
        ...n,
        subs: n.subs.map((s, si) => {
          const count = s.anchors.length;
          return {
            ...s,
            anchors: s.anchors.map((a, ai) => {
              if (!refs.some((r) => r.id === n.id && r.sub === si && r.index === ai)) return a;
              if (!smooth) return { ...a, ix: a.x, iy: a.y, ox: a.x, oy: a.y, smooth: false };
              const prev = s.anchors[(ai - 1 + count) % count];
              const next = s.anchors[(ai + 1) % count];
              const dx = next.x - prev.x;
              const dy = next.y - prev.y;
              const len = Math.hypot(dx, dy) || 1;
              const dIn = Math.hypot(a.x - prev.x, a.y - prev.y) / 3;
              const dOut = Math.hypot(next.x - a.x, next.y - a.y) / 3;
              return { ...a, ix: a.x - (dx / len) * dIn, iy: a.y - (dy / len) * dIn, ox: a.x + (dx / len) * dOut, oy: a.y + (dy / len) * dOut, smooth: true };
            }),
          };
        }),
      };
    }),
  );
}
