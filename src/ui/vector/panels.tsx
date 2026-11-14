/**
 * Vector Studio's side panels: appearance, colour, swatches, colour guide, gradient,
 * transform and align, pathfinder, character and paragraph, layers and artboards.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalSpaceAround, AlignStartHorizontal, AlignStartVertical,
  AlignVerticalSpaceAround, ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, Eye, EyeOff, FlipHorizontal2, FlipVertical2, Lock, LockOpen, Plus, Trash2,
} from 'lucide-react';
import { browserMeasure, fontFamilies } from '../../core/vector/browser';
import { HARMONY_RULES, cmykToRgb, harmony, hexToRgb, hsvToRgb, rgbToCmyk, rgbToHex, rgbToHsv, type HarmonyRule } from '../../core/vector/color';
import type { BooleanOp } from '../../core/vector/geom';
import { paintColorAt } from '../../core/vector/mesh';
import { ARTBOARD_PRESETS, BLEND_MODES, type BlendMode, type GradientStop, type LinearGradient, type Paint, type PathNode, type RadialGradient, type TextNode, type VNode } from '../../core/vector/model';
import { boundsOfNodes } from '../../core/vector/path';
import { cx } from '../components';
import type { AlignHow, PaintTarget, VectorStore } from './store';

export function Panel({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="vx-panel">
      <button type="button" className="vx-panel-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {title}
      </button>
      {open && <div className="vx-panel-body">{children}</div>}
    </section>
  );
}

/** A number box that commits on Enter / blur, so half-typed values never reach the document. */
export function Num({ label, value, onChange, min, max, step = 1, width = 58, suffix }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; width?: number; suffix?: string }) {
  const shown = Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '';
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    const v = parseFloat(text);
    if (!Number.isFinite(v)) return setText(shown);
    const c = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, v));
    if (c !== value) onChange(c);
    setText(String(Math.round(c * 100) / 100));
  };
  return (
    <label className="vx-num" title={label}>
      <span>{label}</span>
      <input
        type="number"
        value={text}
        step={step}
        min={min}
        max={max}
        style={{ width }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      {suffix && <em>{suffix}</em>}
    </label>
  );
}

export function paintCss(p: Paint): string {
  if (p.type === 'none') return 'linear-gradient(135deg, #fff 45%, #e5383b 45%, #e5383b 55%, #fff 55%)';
  if (p.type === 'solid') return p.color;
  if (p.type === 'mesh') return `conic-gradient(${[p.points[0], p.points[p.cols], p.points[p.points.length - 1], p.points[p.points.length - 1 - p.cols], p.points[0]].map((q) => q.color).join(', ')})`;
  const stops = [...p.stops].sort((a, b) => a.offset - b.offset).map((s) => `${s.color} ${Math.round(s.offset * 100)}%`).join(', ');
  return p.type === 'linear' ? `linear-gradient(90deg, ${stops})` : `radial-gradient(circle, ${stops})`;
}

const solid = (p: Paint, fallback = '#000000') => (p.type === 'solid' ? p.color : p.type === 'none' ? fallback : paintColorAt(p, 0.5, 0.5));

type Styled = PathNode | TextNode;

/** The first selected object that has a fill and stroke (inside groups too), else the defaults. */
export function useAppearance(store: VectorStore) {
  return useMemo(() => {
    const find = (nodes: VNode[]): Styled | null => {
      for (const n of nodes) {
        if (n.type === 'path' || n.type === 'text') return n;
        if (n.type === 'group') {
          const hit = find(n.children);
          if (hit) return hit;
        }
      }
      return null;
    };
    return find(store.selectedNodes) ?? store.style;
  }, [store.selectedNodes, store.style]);
}

// ── appearance ─────────────────────────────────────────────────────────────

export function AppearancePanel({ store }: { store: VectorStore }) {
  const a = useAppearance(store);
  const node = store.selectedNodes[0];
  const paint = a[store.target];
  const setType = (type: Paint['type']) => {
    const color = solid(paint, store.target === 'fill' ? '#ffffff' : '#000000');
    const stops: GradientStop[] = paint.type === 'linear' || paint.type === 'radial' ? paint.stops : [{ offset: 0, color }, { offset: 1, color: color === '#000000' ? '#ffffff' : '#000000' }];
    const next: Paint =
      type === 'none' ? { type: 'none' } : type === 'solid' ? { type: 'solid', color } : type === 'linear' ? { type: 'linear', stops, x1: 0, y1: 0.5, x2: 1, y2: 0.5 } : type === 'radial' ? { type: 'radial', stops, cx: 0.5, cy: 0.5, r: 0.5 } : paint;
    store.setPaint(store.target, next);
  };
  return (
    <Panel title="Appearance">
      <div className="vx-paints">
        {(['fill', 'stroke'] as PaintTarget[]).map((t) => (
          <button key={t} type="button" className={cx('vx-paint', store.target === t && 'is-active')} onClick={() => store.setTarget(t)} title={`Edit the ${t} colour`}>
            <span className={cx('vx-chip', t === 'stroke' && 'vx-chip-stroke')} style={{ background: paintCss(a[t]) }} />
            {t === 'fill' ? 'Fill' : 'Stroke'}
          </button>
        ))}
        <button type="button" className="btn btn-text btn-sm" title="Swap fill and stroke (Shift+X)" onClick={() => store.setAppearance({ fill: a.stroke.type === 'mesh' ? a.fill : a.stroke, stroke: a.fill.type === 'mesh' ? a.stroke : a.fill })}>Swap</button>
      </div>
      <div className="vx-seg" role="radiogroup" aria-label="Paint type">
        {(['none', 'solid', 'linear', 'radial'] as const).map((t) => (
          <button key={t} type="button" role="radio" aria-checked={paint.type === t} className={paint.type === t ? 'is-active' : ''} onClick={() => setType(t)}>
            {t === 'none' ? 'None' : t === 'solid' ? 'Solid' : t === 'linear' ? 'Linear' : 'Radial'}
          </button>
        ))}
      </div>
      {paint.type === 'mesh' && <p className="vx-hint">Gradient mesh: pick the Mesh tool (U), click a point and choose its colour.</p>}
      <div className="vx-row">
        <Num label="Stroke" value={a.strokeWidth} min={0} max={1000} step={0.5} onChange={(v) => store.setAppearance({ strokeWidth: v })} suffix="px" />
        <select className="tb-select" aria-label="Line cap" title="Line cap" value={a.cap} onChange={(e) => store.setAppearance({ cap: e.target.value as PathNode['cap'] })}>
          <option value="butt">Butt cap</option>
          <option value="round">Round cap</option>
          <option value="square">Square cap</option>
        </select>
      </div>
      <div className="vx-row">
        <select className="tb-select" aria-label="Corner join" title="Corner join" value={a.join} onChange={(e) => store.setAppearance({ join: e.target.value as PathNode['join'] })}>
          <option value="miter">Miter join</option>
          <option value="round">Round join</option>
          <option value="bevel">Bevel join</option>
        </select>
        <select
          className="tb-select"
          aria-label="Dashes"
          title="Dashed line"
          value={a.dash.length ? a.dash.join(' ') : ''}
          onChange={(e) => store.setAppearance({ dash: e.target.value ? e.target.value.split(' ').map(Number) : [] })}
        >
          <option value="">Solid line</option>
          {a.dash.length > 0 && ![[4, 4], [8, 4], [1, 4], [12, 4, 2, 4]].some((d) => d.join(' ') === a.dash.join(' ')) && <option value={a.dash.join(' ')}>Custom dash</option>}
          <option value="4 4">Dashed</option>
          <option value="8 4">Long dash</option>
          <option value="1 4">Dotted</option>
          <option value="12 4 2 4">Dash-dot</option>
        </select>
      </div>
      {node && (
        <div className="vx-row">
          <Num label="Opacity" value={Math.round(node.opacity * 100)} min={0} max={100} onChange={(v) => store.apply(patchAll(store, (n) => ({ ...n, opacity: v / 100 })))} suffix="%" />
          <select className="tb-select" aria-label="Blend mode" title="Blend mode" value={node.blend ?? 'normal'} onChange={(e) => store.apply(patchAll(store, (n) => ({ ...n, blend: e.target.value === 'normal' ? undefined : (e.target.value as BlendMode) })))}>
            {BLEND_MODES.map((b) => <option key={b} value={b}>{b[0].toUpperCase() + b.slice(1).replace('-', ' ')}</option>)}
          </select>
        </div>
      )}
    </Panel>
  );
}

function patchAll(store: VectorStore, fn: (n: VNode) => VNode) {
  const ids = new Set(store.selRef.current);
  const walk = (nodes: VNode[]): VNode[] => nodes.map((n) => (ids.has(n.id) ? fn(n) : n.type === 'group' ? { ...n, children: walk(n.children) } : n));
  const d = store.docRef.current;
  return { ...d, layers: d.layers.map((l) => ({ ...l, children: walk(l.children) })) };
}

// ── colour ─────────────────────────────────────────────────────────────────

export interface ColorTarget {
  color: string;
  label: string;
  set: (hex: string) => void;
}

function Slider({ label, value, max, onChange, background }: { label: string; value: number; max: number; onChange: (v: number) => void; background?: string }) {
  return (
    <label className="vx-slider">
      <span>{label}</span>
      <input type="range" min={0} max={max} value={Math.round(value)} style={background ? { background } : undefined} onChange={(e) => onChange(+e.target.value)} />
      <input type="number" min={0} max={max} value={Math.round(value)} onChange={(e) => onChange(Math.max(0, Math.min(max, +e.target.value || 0)))} onKeyDown={(e) => e.stopPropagation()} />
    </label>
  );
}

export function ColorPanel({ target }: { target: ColorTarget }) {
  const [mode, setMode] = useState<'hsb' | 'rgb' | 'cmyk'>('hsb');
  const [hex, setHex] = useState(target.color);
  useEffect(() => setHex(target.color), [target.color]);
  const rgb = hexToRgb(target.color);
  const hsv = rgbToHsv(rgb);
  // a grey has no hue of its own: remember the last one so the hue slider doesn't jump to red
  const hue = useRef(hsv.h);
  if (hsv.s > 0 && hsv.v > 0) hue.current = hsv.h;
  const h = hsv.s > 0 && hsv.v > 0 ? hsv.h : hue.current;
  const cmyk = rgbToCmyk(rgb);
  const set = (c: { r: number; g: number; b: number }) => target.set(rgbToHex(c));
  return (
    <Panel title={`Color · ${target.label}`}>
      <div className="vx-row">
        <input type="color" aria-label="Pick a colour" value={target.color} onChange={(e) => target.set(e.target.value)} />
        <input
          className="input vx-hex"
          aria-label="Hex colour"
          value={hex}
          spellCheck={false}
          onChange={(e) => setHex(e.target.value)}
          onBlur={() => (/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex.trim()) ? target.set(rgbToHex(hexToRgb(hex))) : setHex(target.color))}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
        <div className="vx-seg vx-seg-sm">
          {(['hsb', 'rgb', 'cmyk'] as const).map((m) => <button key={m} type="button" className={mode === m ? 'is-active' : ''} onClick={() => setMode(m)}>{m.toUpperCase()}</button>)}
        </div>
      </div>
      {mode === 'hsb' && (
        <>
          <Slider label="H" max={360} value={h} background="linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)" onChange={(v) => { hue.current = v; set(hsvToRgb(v, hsv.s || 1, hsv.v || 1)); }} />
          <Slider label="S" max={100} value={hsv.s} background={`linear-gradient(90deg,${rgbToHex(hsvToRgb(h, 0, hsv.v))},${rgbToHex(hsvToRgb(h, 100, hsv.v))})`} onChange={(v) => set(hsvToRgb(h, v, hsv.v))} />
          <Slider label="B" max={100} value={hsv.v} background={`linear-gradient(90deg,#000,${rgbToHex(hsvToRgb(h, hsv.s, 100))})`} onChange={(v) => set(hsvToRgb(h, hsv.s, v))} />
        </>
      )}
      {mode === 'rgb' && (
        <>
          <Slider label="R" max={255} value={rgb.r} onChange={(v) => set({ ...rgb, r: v })} />
          <Slider label="G" max={255} value={rgb.g} onChange={(v) => set({ ...rgb, g: v })} />
          <Slider label="B" max={255} value={rgb.b} onChange={(v) => set({ ...rgb, b: v })} />
        </>
      )}
      {mode === 'cmyk' && (
        <>
          <Slider label="C" max={100} value={cmyk.c} onChange={(v) => set(cmykToRgb(v, cmyk.m, cmyk.y, cmyk.k))} />
          <Slider label="M" max={100} value={cmyk.m} onChange={(v) => set(cmykToRgb(cmyk.c, v, cmyk.y, cmyk.k))} />
          <Slider label="Y" max={100} value={cmyk.y} onChange={(v) => set(cmykToRgb(cmyk.c, cmyk.m, v, cmyk.k))} />
          <Slider label="K" max={100} value={cmyk.k} onChange={(v) => set(cmykToRgb(cmyk.c, cmyk.m, cmyk.y, v))} />
        </>
      )}
    </Panel>
  );
}

export function SwatchesPanel({ store, target }: { store: VectorStore; target: ColorTarget }) {
  const a = useAppearance(store);
  return (
    <Panel title="Swatches">
      <div className="vx-swatches">
        <button type="button" className="vx-swatch" title="None" style={{ background: paintCss({ type: 'none' }) }} onClick={() => store.setPaint(store.target, { type: 'none' })} />
        {store.doc.swatches.map((s, i) => (
          <button
            key={i}
            type="button"
            className="vx-swatch"
            title={`${s.name} (Alt-click to remove)`}
            style={{ background: paintCss(s.paint) }}
            onClick={(e) => {
              if (e.altKey) store.commands.removeSwatch(i);
              else if (s.paint.type === 'solid') target.set(s.paint.color);
              else store.setPaint(store.target, s.paint);
            }}
          />
        ))}
        <button type="button" className="vx-swatch vx-swatch-add" title={`Add the current ${store.target} to the swatches`} onClick={() => store.commands.addSwatch(a[store.target])}><Plus size={12} /></button>
      </div>
    </Panel>
  );
}

export function ColorGuidePanel({ store, target }: { store: VectorStore; target: ColorTarget }) {
  const [rule, setRule] = useState<HarmonyRule>('complementary');
  const colors = useMemo(() => harmony(target.color, rule), [target.color, rule]);
  return (
    <Panel title="Color guide" defaultOpen={false}>
      <div className="vx-row">
        <select className="tb-select vx-grow" aria-label="Harmony rule" value={rule} onChange={(e) => setRule(e.target.value as HarmonyRule)}>
          {HARMONY_RULES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <button type="button" className="btn btn-text btn-sm" title="Add these colours to the swatches" onClick={() => colors.forEach((c) => store.commands.addSwatch({ type: 'solid', color: c }))}>Save</button>
      </div>
      <div className="vx-harmony">
        {colors.map((c, i) => <button key={i} type="button" title={c} style={{ background: c }} onClick={() => target.set(c)} />)}
      </div>
    </Panel>
  );
}

// ── gradient ───────────────────────────────────────────────────────────────

export function GradientPanel({ store, stop, setStop }: { store: VectorStore; stop: number; setStop: (i: number) => void }) {
  const a = useAppearance(store);
  const paint = a[store.target];
  const bar = useRef<HTMLDivElement>(null);
  if (paint.type !== 'linear' && paint.type !== 'radial') return null;
  const g: LinearGradient | RadialGradient = paint;
  const update = (stops: GradientStop[], live = false) => {
    const next = { ...g, stops } as Paint;
    if (live) store.preview(patchAll(store, (n) => (n.type === 'path' || n.type === 'text' ? { ...n, [store.target]: next } : n)));
    else store.setPaint(store.target, next);
  };
  const angle = g.type === 'linear' ? Math.round((Math.atan2(g.y2 - g.y1, g.x2 - g.x1) * 180) / Math.PI) : 0;
  const offsetAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };
  return (
    <Panel title="Gradient">
      <div
        className="vx-gradient-bar"
        ref={bar}
        style={{ background: paintCss({ ...g, type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0 } as Paint) }}
        title="Click to add a colour stop"
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const offset = offsetAt(e.clientX);
          const color = paintColorAt({ ...g, type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0 } as Paint, offset, 0);
          update([...g.stops, { offset, color }]);
          setStop(g.stops.length);
        }}
      >
        {g.stops.map((s, i) => (
          <button
            key={i}
            type="button"
            className={cx('vx-stop', i === stop && 'is-active')}
            style={{ left: `${s.offset * 100}%`, background: s.color }}
            title="Drag to move; select and press Delete to remove"
            onPointerDown={(e) => {
              e.stopPropagation();
              setStop(i);
              (e.target as Element).setPointerCapture(e.pointerId);
              store.begin();
            }}
            onPointerMove={(e) => {
              if (e.buttons !== 1) return;
              update(g.stops.map((x, j) => (j === i ? { ...x, offset: offsetAt(e.clientX) } : x)), true);
            }}
            onPointerUp={() => store.end()}
            onKeyDown={(e) => {
              if ((e.key === 'Delete' || e.key === 'Backspace') && g.stops.length > 2) {
                e.stopPropagation();
                update(g.stops.filter((_, j) => j !== i));
                setStop(0);
              }
            }}
          />
        ))}
      </div>
      <div className="vx-row">
        {g.type === 'linear' && (
          <Num
            label="Angle"
            value={angle}
            min={-360}
            max={360}
            suffix="°"
            onChange={(v) => {
              const r = (v * Math.PI) / 180;
              store.setPaint(store.target, { ...g, x1: 0.5 - Math.cos(r) / 2, y1: 0.5 - Math.sin(r) / 2, x2: 0.5 + Math.cos(r) / 2, y2: 0.5 + Math.sin(r) / 2 });
            }}
          />
        )}
        <Num label="Stop" value={Math.round((g.stops[stop]?.offset ?? 0) * 100)} min={0} max={100} suffix="%" onChange={(v) => update(g.stops.map((x, j) => (j === stop ? { ...x, offset: v / 100 } : x)))} />
        <Num label="Alpha" value={Math.round((g.stops[stop]?.alpha ?? 1) * 100)} min={0} max={100} suffix="%" onChange={(v) => update(g.stops.map((x, j) => (j === stop ? { ...x, alpha: v >= 100 ? undefined : v / 100 } : x)))} />
      </div>
      <div className="vx-row">
        <button type="button" className="btn btn-text btn-sm" onClick={() => update(g.stops.map((s) => ({ ...s, offset: 1 - s.offset })))}>Reverse</button>
        <button type="button" className="btn btn-text btn-sm" disabled={g.stops.length <= 2} onClick={() => { update(g.stops.filter((_, j) => j !== stop)); setStop(0); }}>Remove stop</button>
        <button type="button" className="btn btn-text btn-sm" title="Add this gradient to the swatches" onClick={() => store.commands.addSwatch(g, 'Gradient')}>Save</button>
      </div>
      <p className="vx-hint">Drag across the object with the Gradient tool (G) to set its direction and length.</p>
    </Panel>
  );
}

// ── transform, align, pathfinder ───────────────────────────────────────────

export function TransformPanel({ store }: { store: VectorStore }) {
  const box = useMemo(() => boundsOfNodes(store.selectedNodes, browserMeasure), [store.selectedNodes]);
  const [toBoard, setToBoard] = useState(false);
  const [angle, setAngle] = useState(0);
  if (!box) return null;
  const c = store.commands;
  const align = (how: AlignHow, label: string, icon: ReactNode) => (
    <button key={how} type="button" className="btn btn-icon" title={label} aria-label={label} onClick={() => c.align(how, toBoard)}>{icon}</button>
  );
  return (
    <Panel title="Transform & align">
      <div className="vx-row">
        <Num label="X" value={box.x} onChange={(v) => c.setBox({ x: v })} />
        <Num label="Y" value={box.y} onChange={(v) => c.setBox({ y: v })} />
      </div>
      <div className="vx-row">
        <Num label="W" value={box.width} min={0.01} onChange={(v) => c.setBox({ width: v })} />
        <Num label="H" value={box.height} min={0.01} onChange={(v) => c.setBox({ height: v })} />
      </div>
      <div className="vx-row">
        <Num label="Rotate" value={angle} min={-360} max={360} suffix="°" onChange={(v) => { c.rotate(v); setAngle(0); }} />
        <button type="button" className="btn btn-icon" title="Flip horizontally" aria-label="Flip horizontally" onClick={() => c.flip(true)}><FlipHorizontal2 size={15} /></button>
        <button type="button" className="btn btn-icon" title="Flip vertically" aria-label="Flip vertically" onClick={() => c.flip(false)}><FlipVertical2 size={15} /></button>
      </div>
      <div className="vx-row vx-icons">
        {align('left', 'Align left edges', <AlignStartVertical size={15} />)}
        {align('hcenter', 'Align horizontal centres', <AlignCenterVertical size={15} />)}
        {align('right', 'Align right edges', <AlignEndVertical size={15} />)}
        {align('top', 'Align top edges', <AlignStartHorizontal size={15} />)}
        {align('vcenter', 'Align vertical centres', <AlignCenterHorizontal size={15} />)}
        {align('bottom', 'Align bottom edges', <AlignEndHorizontal size={15} />)}
        {align('hdist', 'Distribute horizontally (3 or more objects)', <AlignHorizontalSpaceAround size={15} />)}
        {align('vdist', 'Distribute vertically (3 or more objects)', <AlignVerticalSpaceAround size={15} />)}
      </div>
      <label className="check"><input type="checkbox" checked={toBoard} onChange={(e) => setToBoard(e.target.checked)} /> Align to the artboard</label>
    </Panel>
  );
}

const SHAPE_MODES: [BooleanOp, string, string][] = [
  ['unite', 'Unite', 'Join the shapes into one'],
  ['minus-front', 'Minus front', 'Cut the front shapes out of the back one'],
  ['intersect', 'Intersect', 'Keep only where the shapes overlap'],
  ['exclude', 'Exclude', 'Remove where the shapes overlap'],
];
const PATHFINDERS: [BooleanOp, string, string][] = [
  ['divide', 'Divide', 'Cut into every separate region'],
  ['trim', 'Trim', 'Remove the parts hidden behind other shapes'],
  ['merge', 'Merge', 'Trim, then join touching shapes of the same colour'],
  ['crop', 'Crop', 'Keep only what is inside the front shape'],
  ['outline', 'Outline', 'Turn the regions into unfilled outlines'],
  ['minus-back', 'Minus back', 'Cut the back shapes out of the front one'],
];

export function PathfinderPanel({ store }: { store: VectorStore }) {
  const btn = ([op, label, hint]: [BooleanOp, string, string]) => (
    <button key={op} type="button" className="btn btn-text btn-sm" title={hint} onClick={() => store.commands.pathfinder(op)}>{label}</button>
  );
  return (
    <Panel title="Pathfinder" defaultOpen={false}>
      <div className="vx-sub">Shape modes</div>
      <div className="vx-buttons">{SHAPE_MODES.map(btn)}</div>
      <div className="vx-sub">Pathfinders</div>
      <div className="vx-buttons">{PATHFINDERS.map(btn)}</div>
      <p className="vx-hint">For freeform merging, select the shapes and use the Shape Builder tool (Shift+M).</p>
    </Panel>
  );
}

// ── type ───────────────────────────────────────────────────────────────────

const COMMON_FONTS = ['Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Segoe UI', 'Georgia', 'Times New Roman', 'Garamond', 'Palatino Linotype', 'Courier New', 'Consolas', 'Impact', 'Comic Sans MS'];

export function TypePanel({ store, onPrompt }: { store: VectorStore; onPrompt: (title: string, initial: string, done: (value: string) => void) => void }) {
  const text = store.selectedNodes.find((n): n is TextNode => n.type === 'text');
  const t = text ?? { ...store.char, ...store.para };
  const [fonts, setFonts] = useState<string[]>(COMMON_FONTS);
  const [asked, setAsked] = useState(false);
  const loadFonts = () => {
    if (asked) return;
    setAsked(true);
    // needs a click: the browser asks before listing installed fonts
    void fontFamilies().then((list) => list.length && setFonts(list));
  };
  const list = fonts.includes(t.family) ? fonts : [t.family, ...fonts];
  const styles = store.doc.textStyles;
  return (
    <Panel title="Character & paragraph" defaultOpen={!!text}>
      <div className="vx-row">
        <select className="tb-select vx-grow" aria-label="Font" title="Font (click to list the fonts installed on this computer)" value={t.family} onMouseDown={loadFonts} onFocus={loadFonts} onChange={(e) => store.setText({ family: e.target.value })}>
          {list.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </div>
      <div className="vx-row">
        <Num label="Size" value={t.size} min={1} max={2000} onChange={(v) => store.setText({ size: v })} />
        <select className="tb-select" aria-label="Weight" title="Weight" value={String(t.weight)} onChange={(e) => store.setText({ weight: +e.target.value })}>
          {[[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [900, 'Black']].map(([w, l]) => <option key={w} value={w}>{l}</option>)}
        </select>
      </div>
      <div className="vx-row">
        <Num label="Tracking" value={t.tracking} min={-500} max={2000} step={10} onChange={(v) => store.setText({ tracking: v })} />
        <Num label="Leading" value={t.leading} min={0.5} max={5} step={0.05} onChange={(v) => store.setText({}, { leading: v })} />
      </div>
      <div className="vx-row">
        <div className="vx-seg vx-seg-sm">
          <button type="button" className={t.italic ? 'is-active' : ''} title="Italic" onClick={() => store.setText({ italic: !t.italic })}><i>I</i></button>
          <button type="button" className={t.underline ? 'is-active' : ''} title="Underline" onClick={() => store.setText({ underline: !t.underline })}><u>U</u></button>
        </div>
        <div className="vx-seg vx-seg-sm" role="radiogroup" aria-label="Paragraph alignment">
          {(['left', 'center', 'right'] as const).map((al) => (
            <button key={al} type="button" role="radio" aria-checked={t.align === al} className={t.align === al ? 'is-active' : ''} onClick={() => store.setText({}, { align: al })}>{al[0].toUpperCase() + al.slice(1)}</button>
          ))}
        </div>
      </div>
      <div className="vx-sub">Styles</div>
      <div className="vx-row">
        <select
          className="tb-select vx-grow"
          aria-label="Apply a text style"
          value=""
          onChange={(e) => {
            const s = styles.find((x) => x.name === e.target.value);
            if (s) store.setText(s.char, s.para);
          }}
        >
          <option value="">{styles.length ? 'Apply a style…' : 'No saved styles'}</option>
          {styles.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
        </select>
        <button
          type="button"
          className="btn btn-text btn-sm"
          title="Save the current character and paragraph settings as a named style"
          onClick={() => onPrompt('Save text style', `Style ${styles.length + 1}`, (name) => store.commands.saveTextStyle(name, { family: t.family, size: t.size, weight: t.weight, italic: t.italic, tracking: t.tracking, underline: t.underline }, { align: t.align, leading: t.leading }))}
        >
          Save
        </button>
      </div>
      {styles.length > 0 && (
        <div className="vx-chips">
          {styles.map((s) => (
            <span key={s.name} className="vx-style-chip">
              <button type="button" onClick={() => store.setText(s.char, s.para)} title={`${s.char.family} ${s.char.size}px`}>{s.name}</button>
              <button type="button" aria-label={`Delete style ${s.name}`} onClick={() => store.commands.removeTextStyle(s.name)}>×</button>
            </span>
          ))}
        </div>
      )}
      {text && (
        <div className="vx-buttons">
          <button type="button" className="btn btn-text btn-sm" title="Convert the text to editable shapes (Ctrl+Shift+O)" onClick={() => void store.commands.createOutlines()}>Create outlines</button>
          <button type="button" className="btn btn-text btn-sm" title="Select the text and a path, then run the text along the path" onClick={() => store.commands.textOnPath()}>Type on path</button>
        </div>
      )}
    </Panel>
  );
}

// ── layers ─────────────────────────────────────────────────────────────────

function nodeLabel(n: VNode): string {
  if (n.name) return n.name;
  if (n.type === 'text') return n.text.split('\n')[0].slice(0, 28) || 'Text';
  if (n.type === 'group') return n.clip ? 'Clipping group' : 'Group';
  if (n.type === 'image') return 'Image';
  return n.subs.length > 1 ? 'Compound path' : 'Path';
}

export function LayersPanel({ store, onPrompt }: { store: VectorStore; onPrompt: (title: string, initial: string, done: (value: string) => void) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const c = store.commands;
  const sel = new Set(store.selection);
  const row = (n: VNode, depth: number): ReactNode => (
    <div key={n.id}>
      <div className={cx('vx-layer-row vx-object-row', sel.has(n.id) && 'is-selected')} style={{ paddingLeft: 8 + depth * 12 }}>
        <button type="button" className="vx-tiny" title={n.hidden ? 'Show' : 'Hide'} onClick={() => c.patchNode(n.id, { hidden: n.hidden ? undefined : true })}>{n.hidden ? <EyeOff size={12} /> : <Eye size={12} />}</button>
        <button type="button" className="vx-tiny" title={n.locked ? 'Unlock' : 'Lock'} onClick={() => c.patchNode(n.id, { locked: n.locked ? undefined : true })}>{n.locked ? <Lock size={12} /> : <LockOpen size={12} />}</button>
        <button type="button" className="vx-layer-name" onClick={(e) => store.select(e.shiftKey ? [...new Set([...store.selection, n.id])] : [n.id])} onDoubleClick={() => onPrompt('Rename object', nodeLabel(n), (name) => c.patchNode(n.id, { name }))}>
          {nodeLabel(n)}
        </button>
      </div>
      {n.type === 'group' && open[n.id] !== false && depth < 3 && [...n.children].reverse().map((k) => row(k, depth + 1))}
    </div>
  );
  return (
    <Panel title="Layers">
      <div className="vx-layers">
        {[...store.doc.layers].reverse().map((l) => (
          <div key={l.id}>
            <div className={cx('vx-layer-row', l.id === store.activeLayer && 'is-active')}>
              <button type="button" className="vx-tiny" onClick={() => setOpen((o) => ({ ...o, [l.id]: !(o[l.id] ?? true) }))} aria-label="Expand layer">{open[l.id] ?? true ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>
              <button type="button" className="vx-tiny" title={l.hidden ? 'Show layer' : 'Hide layer'} onClick={() => c.patchLayer(l.id, { hidden: l.hidden ? undefined : true })}>{l.hidden ? <EyeOff size={12} /> : <Eye size={12} />}</button>
              <button type="button" className="vx-tiny" title={l.locked ? 'Unlock layer' : 'Lock layer'} onClick={() => c.patchLayer(l.id, { locked: l.locked ? undefined : true })}>{l.locked ? <Lock size={12} /> : <LockOpen size={12} />}</button>
              <button type="button" className="vx-layer-name" title="Click to draw on this layer; double-click to rename" onClick={() => store.setActiveLayer(l.id)} onDoubleClick={() => onPrompt('Rename layer', l.name, (name) => c.patchLayer(l.id, { name }))}>
                {l.name} <em>{l.children.length}</em>
              </button>
            </div>
            {(open[l.id] ?? true) && [...l.children].reverse().slice(0, 400).map((n) => row(n, 1))}
          </div>
        ))}
      </div>
      <div className="vx-row vx-icons">
        <button type="button" className="btn btn-icon" title="New layer" aria-label="New layer" onClick={() => c.addLayer()}><Plus size={15} /></button>
        <button type="button" className="btn btn-icon" title="Move layer up" aria-label="Move layer up" onClick={() => c.moveLayer(store.activeLayer, 1)}><ArrowUp size={15} /></button>
        <button type="button" className="btn btn-icon" title="Move layer down" aria-label="Move layer down" onClick={() => c.moveLayer(store.activeLayer, -1)}><ArrowDown size={15} /></button>
        <button type="button" className="btn btn-text btn-sm" title="Move the selected objects to the active layer" disabled={!store.selection.length} onClick={() => c.moveToLayer(store.activeLayer)}>Move here</button>
        <span className="spacer" />
        <button type="button" className="btn btn-icon" title="Delete layer" aria-label="Delete layer" onClick={() => c.removeLayer(store.activeLayer)}><Trash2 size={15} /></button>
      </div>
    </Panel>
  );
}

// ── artboards ──────────────────────────────────────────────────────────────

export function ArtboardsPanel({ store, onFit, onPrompt }: { store: VectorStore; onFit: (id: string) => void; onPrompt: (title: string, initial: string, done: (value: string) => void) => void }) {
  const c = store.commands;
  const board = store.doc.artboards.find((a) => a.id === store.activeArtboard);
  return (
    <Panel title="Artboards">
      <div className="vx-layers">
        {store.doc.artboards.map((a, i) => (
          <div key={a.id} className={cx('vx-layer-row', a.id === store.activeArtboard && 'is-active')}>
            <span className="vx-board-no">{i + 1}</span>
            <button type="button" className="vx-layer-name" title="Click to show; double-click to rename" onClick={() => { store.setActiveArtboard(a.id); onFit(a.id); }} onDoubleClick={() => onPrompt('Rename artboard', a.name, (name) => c.patchArtboard(a.id, { name }))}>
              {a.name} <em>{Math.round(a.width)} × {Math.round(a.height)}</em>
            </button>
          </div>
        ))}
      </div>
      {board && (
        <div className="vx-row">
          <Num label="W" value={board.width} min={1} max={30000} onChange={(v) => c.patchArtboard(board.id, { width: v })} />
          <Num label="H" value={board.height} min={1} max={30000} onChange={(v) => c.patchArtboard(board.id, { height: v })} />
        </div>
      )}
      <div className="vx-row">
        <select
          className="tb-select vx-grow"
          aria-label="Add an artboard"
          value=""
          onChange={(e) => {
            const p = ARTBOARD_PRESETS[+e.target.value];
            if (p) onFit(c.addArtboard(p.width, p.height).id);
          }}
        >
          <option value="">Add artboard…</option>
          {ARTBOARD_PRESETS.map((p, i) => <option key={p.name} value={i}>{p.name} ({p.width} × {p.height})</option>)}
        </select>
        <button type="button" className="btn btn-icon" title="Duplicate artboard with its artwork" aria-label="Duplicate artboard" disabled={!board} onClick={() => board && c.duplicateArtboard(board.id)}><Copy size={15} /></button>
        <button type="button" className="btn btn-icon" title="Delete artboard (artwork stays)" aria-label="Delete artboard" disabled={!board || store.doc.artboards.length < 2} onClick={() => board && c.removeArtboard(board.id)}><Trash2 size={15} /></button>
      </div>
      <p className="vx-hint">Draw, move and resize artboards on the canvas with the Artboard tool (Shift+O). Each one can be exported on its own.</p>
    </Panel>
  );
}
