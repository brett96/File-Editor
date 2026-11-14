/** Layers and Properties panels of the pro photo editor. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Copy, Eye, EyeOff, Layers as LayersIcon, Lock, Plus, SquareDashed, Trash2, Unlock } from 'lucide-react';
import { LUT_PRESETS, parseCube } from '../../core/pro-image/tone';
import { ADJUST_LABELS, autoLevels, curveLut, histogram, type AdjustSpec, type CurvePoint, type Histogram } from '../../core/pro-image/adjust';
import { BLEND_MODES, type BlendMode, type Layer, type ProDocument } from '../../core/pro-image/document';
import { cx } from '../components';
import { layerThumb, maskThumb } from './render';

function Thumb({ make, title, active, onClick }: { make: () => HTMLCanvasElement; title: string; active?: boolean; onClick?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.replaceChildren(make());
  });
  return <div ref={ref} className={cx('pi-thumb', active && 'is-active')} title={title} onClick={onClick} />;
}

export function LayersPanel({
  doc,
  activeId,
  maskEdit,
  onSelect,
  onMaskEdit,
  onChange,
  onAdd,
  onDuplicate,
  onDelete,
  onMove,
  onAddMask,
  onMerge,
}: {
  doc: ProDocument;
  activeId: string | null;
  maskEdit: boolean;
  onSelect: (id: string) => void;
  onMaskEdit: (id: string, on: boolean) => void;
  onChange: (l: Layer, commit?: boolean) => void;
  onAdd: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: (delta: number) => void;
  onAddMask: () => void;
  onMerge: () => void;
}) {
  const active = doc.layers.find((l) => l.id === activeId) ?? null;
  return (
    <section className="pi-panel pi-layers" aria-label="Layers">
      <header className="pi-panel-head">
        <LayersIcon size={14} /> Layers
      </header>
      {active && (
        <div className="pi-layer-opts">
          <select
            className="tb-select"
            aria-label="Blend mode"
            value={active.blend}
            onChange={(e) => onChange({ ...active, blend: e.target.value as BlendMode }, true)}
          >
            {BLEND_MODES.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
          <label className="pi-opacity" title="Opacity">
            <span>Opacity</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(active.opacity * 100)}
              onChange={(e) => onChange({ ...active, opacity: Number(e.target.value) / 100 })}
              onPointerUp={() => onChange(active, true)}
            />
            <output>{Math.round(active.opacity * 100)}%</output>
          </label>
        </div>
      )}
      <ul className="pi-layer-list" role="listbox" aria-label="Layer list">
        {[...doc.layers].reverse().map((l) => (
          <li
            key={l.id}
            role="option"
            aria-selected={l.id === activeId}
            className={cx('pi-layer', l.id === activeId && 'is-active')}
            onClick={() => onSelect(l.id)}
          >
            <button
              type="button"
              className="pi-icon-btn"
              aria-label={l.visible ? 'Hide layer' : 'Show layer'}
              onClick={(e) => {
                e.stopPropagation();
                onChange({ ...l, visible: !l.visible }, true);
              }}
            >
              {l.visible ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>
            <Thumb make={() => layerThumb(l, doc)} title="Layer" active={l.id === activeId && !maskEdit} onClick={() => onMaskEdit(l.id, false)} />
            {l.mask && (
              <Thumb
                make={() => maskThumb(l.mask!)}
                title={l.maskEnabled ? 'Layer mask (click to paint on it)' : 'Layer mask (disabled)'}
                active={l.id === activeId && maskEdit}
                onClick={() => onMaskEdit(l.id, true)}
              />
            )}
            <span className="pi-layer-name" onDoubleClick={() => {
              const name = window.prompt('Layer name', l.name);
              if (name) onChange({ ...l, name }, true);
            }}>
              {l.name}
              {l.kind !== 'raster' && <small>{l.kind === 'adjust' ? ADJUST_LABELS[l.adjust.type] : l.kind}</small>}
            </span>
            <button
              type="button"
              className="pi-icon-btn"
              aria-label={l.locked ? 'Unlock layer' : 'Lock layer'}
              onClick={(e) => {
                e.stopPropagation();
                onChange({ ...l, locked: !l.locked }, true);
              }}
            >
              {l.locked ? <Lock size={13} /> : <Unlock size={13} className="pi-dim" />}
            </button>
          </li>
        ))}
      </ul>
      <footer className="pi-layer-actions">
        <button type="button" className="pi-icon-btn" title="New layer" aria-label="New layer" onClick={onAdd}><Plus size={15} /></button>
        <button type="button" className="pi-icon-btn" title="Duplicate layer" aria-label="Duplicate layer" onClick={onDuplicate}><Copy size={15} /></button>
        <button type="button" className="pi-icon-btn" title="Add layer mask (from the selection)" aria-label="Add layer mask" onClick={onAddMask}><SquareDashed size={15} /></button>
        <button type="button" className="pi-icon-btn" title="Move up" aria-label="Move layer up" onClick={() => onMove(1)}><ArrowUp size={15} /></button>
        <button type="button" className="pi-icon-btn" title="Move down" aria-label="Move layer down" onClick={() => onMove(-1)}><ArrowDown size={15} /></button>
        <button type="button" className="pi-text-btn" title="Merge down" onClick={onMerge}>Merge</button>
        <button type="button" className="pi-icon-btn" title="Delete layer" aria-label="Delete layer" onClick={onDelete}><Trash2 size={15} /></button>
      </footer>
    </section>
  );
}

function Slider({ label, value, min, max, step = 1, onChange, onCommit }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; onCommit?: () => void }) {
  return (
    <label className="pi-slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} onPointerUp={onCommit} onKeyUp={onCommit} />
      <input
        type="number"
        className="pi-num"
        min={min}
        max={max}
        step={step}
        value={Math.round(value * 100) / 100}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
        }}
        onBlur={onCommit}
      />
    </label>
  );
}

function HistogramView({ h, channel = 'l' }: { h: Histogram; channel?: keyof Histogram }) {
  const path = useMemo(() => {
    const data = h[channel];
    let max = 1;
    for (let i = 2; i < 254; i++) max = Math.max(max, data[i]);
    let d = 'M0,100';
    for (let i = 0; i < 256; i++) d += ` L${(i / 255) * 256},${100 - Math.min(100, (data[i] / max) * 100)}`;
    return `${d} L256,100 Z`;
  }, [h, channel]);
  return (
    <svg className="pi-histogram" viewBox="0 0 256 100" preserveAspectRatio="none" aria-label="Histogram">
      <path d={path} />
    </svg>
  );
}

function CurvesEditor({ spec, onChange, onCommit, hist }: { spec: Extract<AdjustSpec, { type: 'curves' }>; onChange: (s: AdjustSpec) => void; onCommit: () => void; hist: Histogram | null }) {
  const [channel, setChannel] = useState<'rgb' | 'r' | 'g' | 'b'>('rgb');
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const pts = spec[channel];
  const lut = useMemo(() => curveLut(pts), [pts]);
  const line = useMemo(() => Array.from(lut, (v, i) => `${i === 0 ? 'M' : 'L'}${i},${255 - v}`).join(' '), [lut]);
  const toPoint = (e: React.PointerEvent): CurvePoint => {
    const r = svg.current!.getBoundingClientRect();
    return [Math.round(Math.max(0, Math.min(255, ((e.clientX - r.left) / r.width) * 255))), Math.round(Math.max(0, Math.min(255, 255 - ((e.clientY - r.top) / r.height) * 255)))];
  };
  const set = (next: CurvePoint[]) => onChange({ ...spec, [channel]: next });
  return (
    <div className="pi-curves">
      <div className="pi-seg" role="radiogroup" aria-label="Channel">
        {(['rgb', 'r', 'g', 'b'] as const).map((c) => (
          <button key={c} type="button" role="radio" aria-checked={channel === c} className={channel === c ? 'is-active' : ''} onClick={() => setChannel(c)}>
            {c === 'rgb' ? 'RGB' : c.toUpperCase()}
          </button>
        ))}
      </div>
      <svg
        ref={svg}
        className="pi-curve-graph"
        viewBox="0 0 255 255"
        onPointerDown={(e) => {
          const p = toPoint(e);
          // grab a nearby point, or add one on the curve
          let i = pts.findIndex(([x, y]) => Math.hypot(x - p[0], y - p[1]) < 12);
          if (i < 0) {
            const next = [...pts, [p[0], lut[p[0]]] as CurvePoint].sort((a, b) => a[0] - b[0]);
            i = next.findIndex((q) => q[0] === p[0]);
            set(next);
          }
          drag.current = i;
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current === null) return;
          const p = toPoint(e);
          const next = pts.map((q, j) => (j === drag.current ? p : q));
          set(next);
        }}
        onPointerUp={() => {
          drag.current = null;
          onCommit();
        }}
        onDoubleClick={(e) => {
          const p = toPoint(e as unknown as React.PointerEvent);
          const i = pts.findIndex(([x, y]) => Math.hypot(x - p[0], y - p[1]) < 12);
          if (i > 0 && i < pts.length - 1) {
            set(pts.filter((_, j) => j !== i));
            onCommit();
          }
        }}
      >
        {hist && <foreignObject x="0" y="0" width="255" height="255"><HistogramView h={hist} channel={channel === 'rgb' ? 'l' : channel} /></foreignObject>}
        {[64, 128, 192].map((g) => (
          <g key={g} className="pi-grid">
            <line x1={g} y1="0" x2={g} y2="255" />
            <line x1="0" y1={g} x2="255" y2={g} />
          </g>
        ))}
        <line className="pi-diag" x1="0" y1="255" x2="255" y2="0" />
        <path className={cx('pi-curve', `ch-${channel}`)} d={line} />
        {pts.map(([x, y], i) => (
          <circle key={i} cx={x} cy={255 - y} r="5" className="pi-curve-pt" />
        ))}
      </svg>
      <p className="pi-hint">Drag to bend the curve; click to add a point; double-click a point to remove it.</p>
    </div>
  );
}

export function PropertiesPanel({
  doc,
  layer,
  composite,
  onChange,
  onCommit,
  extra,
}: {
  doc: ProDocument;
  layer: Layer | null;
  /** pixels below the active adjustment (for histograms) */
  composite: () => { data: Uint8ClampedArray; width: number; height: number } | null;
  onChange: (l: Layer) => void;
  onCommit: () => void;
  extra?: ReactNode;
}) {
  const [hist, setHist] = useState<Histogram | null>(null);
  const [lutError, setLutError] = useState<string | null>(null);
  const adjustType = layer?.kind === 'adjust' ? layer.adjust.type : null;
  useEffect(() => {
    if (adjustType !== 'curves' && adjustType !== 'levels' && adjustType !== 'threshold') return setHist(null);
    const px = composite();
    setHist(px ? histogram(px) : null);
    // recompute when the layer selection changes, not on every edit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer?.id, adjustType]);

  if (!layer) return <section className="pi-panel pi-props"><header className="pi-panel-head">Properties</header><p className="pi-hint">Select a layer.</p></section>;

  const setAdj = (a: AdjustSpec) => layer.kind === 'adjust' && onChange({ ...layer, adjust: a });

  let body: ReactNode = null;
  if (layer.kind === 'text') {
    const l = layer;
    body = (
      <>
        <textarea className="input pi-text" rows={3} value={l.text} onChange={(e) => onChange({ ...l, text: e.target.value })} onBlur={onCommit} aria-label="Text" />
        <Slider label="Size" value={l.size} min={4} max={600} onChange={(v) => onChange({ ...l, size: v })} onCommit={onCommit} />
        <div className="pi-row">
          <select className="tb-select" aria-label="Font" value={l.font} onChange={(e) => { onChange({ ...l, font: e.target.value }); onCommit(); }}>
            {[
              ['system-ui, "Segoe UI", Arial, sans-serif', 'Sans'],
              ['Georgia, "Times New Roman", serif', 'Serif'],
              ['"Courier New", monospace', 'Mono'],
              ['Impact, "Arial Black", sans-serif', 'Impact'],
              ['"Brush Script MT", cursive', 'Script'],
            ].map(([v, n]) => <option key={v} value={v}>{n}</option>)}
          </select>
          <input type="color" aria-label="Text colour" value={l.color} onChange={(e) => onChange({ ...l, color: e.target.value })} onBlur={onCommit} />
          <label className="check"><input type="checkbox" checked={l.bold} onChange={(e) => { onChange({ ...l, bold: e.target.checked }); onCommit(); }} /> B</label>
          <label className="check"><input type="checkbox" checked={l.italic} onChange={(e) => { onChange({ ...l, italic: e.target.checked }); onCommit(); }} /> I</label>
        </div>
        <div className="pi-row">
          <select className="tb-select" aria-label="Align" value={l.align} onChange={(e) => { onChange({ ...l, align: e.target.value as 'left' }); onCommit(); }}>
            <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
          </select>
          <label className="check"><input type="checkbox" checked={l.shadow} onChange={(e) => { onChange({ ...l, shadow: e.target.checked }); onCommit(); }} /> Shadow</label>
        </div>
        <Slider label="Outline" value={l.stroke} min={0} max={40} onChange={(v) => onChange({ ...l, stroke: v })} onCommit={onCommit} />
        {l.stroke > 0 && <input type="color" aria-label="Outline colour" value={l.strokeColor} onChange={(e) => onChange({ ...l, strokeColor: e.target.value })} onBlur={onCommit} />}
      </>
    );
  } else if (layer.kind === 'shape') {
    const l = layer;
    body = (
      <>
        <div className="pi-row">
          <label className="check"><input type="checkbox" checked={!!l.fill} onChange={(e) => { onChange({ ...l, fill: e.target.checked ? '#3b82f6' : null }); onCommit(); }} /> Fill</label>
          {l.fill && <input type="color" aria-label="Fill colour" value={l.fill} onChange={(e) => onChange({ ...l, fill: e.target.value })} onBlur={onCommit} />}
          <label className="check"><input type="checkbox" checked={!!l.stroke} onChange={(e) => { onChange({ ...l, stroke: e.target.checked ? '#000000' : null, strokeWidth: l.strokeWidth || 4 }); onCommit(); }} /> Stroke</label>
          {l.stroke && <input type="color" aria-label="Stroke colour" value={l.stroke} onChange={(e) => onChange({ ...l, stroke: e.target.value })} onBlur={onCommit} />}
        </div>
        {l.stroke && <Slider label="Stroke width" value={l.strokeWidth} min={1} max={100} onChange={(v) => onChange({ ...l, strokeWidth: v })} onCommit={onCommit} />}
        {l.shape === 'rect' && <Slider label="Corner radius" value={l.radius} min={0} max={Math.round(Math.min(Math.abs(l.width), Math.abs(l.height)) / 2)} onChange={(v) => onChange({ ...l, radius: v })} onCommit={onCommit} />}
        <div className="pi-grid2">
          <Slider label="X" value={Math.round(l.x)} min={-doc.width} max={doc.width * 2} onChange={(v) => onChange({ ...l, x: v })} onCommit={onCommit} />
          <Slider label="Y" value={Math.round(l.y)} min={-doc.height} max={doc.height * 2} onChange={(v) => onChange({ ...l, y: v })} onCommit={onCommit} />
          <Slider label="W" value={Math.round(l.width)} min={1} max={doc.width * 2} onChange={(v) => onChange({ ...l, width: v })} onCommit={onCommit} />
          <Slider label="H" value={Math.round(l.height)} min={1} max={doc.height * 2} onChange={(v) => onChange({ ...l, height: v })} onCommit={onCommit} />
        </div>
      </>
    );
  } else if (layer.kind === 'fill') {
    const l = layer;
    const f = l.fill;
    body = (
      <>
        <div className="pi-seg" role="radiogroup" aria-label="Fill type">
          <button type="button" className={f.type === 'solid' ? 'is-active' : ''} onClick={() => { onChange({ ...l, fill: { type: 'solid', color: f.type === 'solid' ? f.color : f.from } }); onCommit(); }}>Solid</button>
          <button type="button" className={f.type === 'gradient' ? 'is-active' : ''} onClick={() => { onChange({ ...l, fill: { type: 'gradient', from: f.type === 'solid' ? f.color : f.from, to: '#ffffff', angle: 90, radial: false } }); onCommit(); }}>Gradient</button>
        </div>
        {f.type === 'solid' ? (
          <input type="color" aria-label="Colour" value={f.color} onChange={(e) => onChange({ ...l, fill: { ...f, color: e.target.value } })} onBlur={onCommit} />
        ) : (
          <>
            <div className="pi-row">
              <input type="color" aria-label="From colour" value={f.from} onChange={(e) => onChange({ ...l, fill: { ...f, from: e.target.value } })} onBlur={onCommit} />
              <input type="color" aria-label="To colour" value={f.to} onChange={(e) => onChange({ ...l, fill: { ...f, to: e.target.value } })} onBlur={onCommit} />
              <label className="check"><input type="checkbox" checked={f.radial} onChange={(e) => { onChange({ ...l, fill: { ...f, radial: e.target.checked } }); onCommit(); }} /> Radial</label>
            </div>
            {!f.radial && <Slider label="Angle" value={f.angle} min={-180} max={180} onChange={(v) => onChange({ ...l, fill: { ...f, angle: v } })} onCommit={onCommit} />}
          </>
        )}
      </>
    );
  } else if (layer.kind === 'adjust') {
    const a = layer.adjust;
    switch (a.type) {
      case 'curves':
        body = <CurvesEditor spec={a} onChange={setAdj} onCommit={onCommit} hist={hist} />;
        break;
      case 'levels':
        body = (
          <>
            {hist && <HistogramView h={hist} />}
            <Slider label="Input black" value={a.inBlack} min={0} max={253} onChange={(v) => setAdj({ ...a, inBlack: Math.min(v, a.inWhite - 2) })} onCommit={onCommit} />
            <Slider label="Midtones (γ)" value={a.gamma} min={0.1} max={9.99} step={0.01} onChange={(v) => setAdj({ ...a, gamma: v })} onCommit={onCommit} />
            <Slider label="Input white" value={a.inWhite} min={2} max={255} onChange={(v) => setAdj({ ...a, inWhite: Math.max(v, a.inBlack + 2) })} onCommit={onCommit} />
            <Slider label="Output black" value={a.outBlack} min={0} max={255} onChange={(v) => setAdj({ ...a, outBlack: v })} onCommit={onCommit} />
            <Slider label="Output white" value={a.outWhite} min={0} max={255} onChange={(v) => setAdj({ ...a, outWhite: v })} onCommit={onCommit} />
            <button type="button" className="btn" disabled={!hist} onClick={() => { if (hist) { setAdj({ ...a, ...autoLevels(hist) }); onCommit(); } }}>Auto</button>
          </>
        );
        break;
      case 'hueSat':
        body = (
          <>
            <Slider label="Hue" value={a.hue} min={-180} max={180} onChange={(v) => setAdj({ ...a, hue: v })} onCommit={onCommit} />
            <Slider label="Saturation" value={a.saturation} min={-100} max={100} onChange={(v) => setAdj({ ...a, saturation: v })} onCommit={onCommit} />
            <Slider label="Lightness" value={a.lightness} min={-100} max={100} onChange={(v) => setAdj({ ...a, lightness: v })} onCommit={onCommit} />
            <label className="check"><input type="checkbox" checked={a.colorize} onChange={(e) => { setAdj({ ...a, colorize: e.target.checked }); onCommit(); }} /> Colorize</label>
          </>
        );
        break;
      case 'colorBalance':
        body = <ColorBalanceEditor spec={a} onChange={setAdj} onCommit={onCommit} />;
        break;
      case 'blackWhite':
        body = (
          <>
            <Slider label="Reds" value={a.red} min={-200} max={300} onChange={(v) => setAdj({ ...a, red: v })} onCommit={onCommit} />
            <Slider label="Greens" value={a.green} min={-200} max={300} onChange={(v) => setAdj({ ...a, green: v })} onCommit={onCommit} />
            <Slider label="Blues" value={a.blue} min={-200} max={300} onChange={(v) => setAdj({ ...a, blue: v })} onCommit={onCommit} />
            <div className="pi-row">
              <label className="check"><input type="checkbox" checked={!!a.tint} onChange={(e) => { setAdj({ ...a, tint: e.target.checked ? '#e1d3b3' : null }); onCommit(); }} /> Tint</label>
              {a.tint && <input type="color" aria-label="Tint colour" value={a.tint} onChange={(e) => setAdj({ ...a, tint: e.target.value })} onBlur={onCommit} />}
            </div>
          </>
        );
        break;
      case 'exposure':
        body = (
          <>
            <Slider label="Exposure" value={a.exposure} min={-5} max={5} step={0.01} onChange={(v) => setAdj({ ...a, exposure: v })} onCommit={onCommit} />
            <Slider label="Offset" value={a.offset} min={-0.5} max={0.5} step={0.001} onChange={(v) => setAdj({ ...a, offset: v })} onCommit={onCommit} />
            <Slider label="Gamma" value={a.gamma} min={0.1} max={9.99} step={0.01} onChange={(v) => setAdj({ ...a, gamma: v })} onCommit={onCommit} />
          </>
        );
        break;
      case 'brightnessContrast':
        body = (
          <>
            <Slider label="Brightness" value={a.brightness} min={-150} max={150} onChange={(v) => setAdj({ ...a, brightness: v })} onCommit={onCommit} />
            <Slider label="Contrast" value={a.contrast} min={-50} max={100} onChange={(v) => setAdj({ ...a, contrast: v })} onCommit={onCommit} />
          </>
        );
        break;
      case 'vibrance':
        body = (
          <>
            <Slider label="Vibrance" value={a.vibrance} min={-100} max={100} onChange={(v) => setAdj({ ...a, vibrance: v })} onCommit={onCommit} />
            <Slider label="Saturation" value={a.saturation} min={-100} max={100} onChange={(v) => setAdj({ ...a, saturation: v })} onCommit={onCommit} />
          </>
        );
        break;
      case 'threshold':
        body = (
          <>
            {hist && <HistogramView h={hist} />}
            <Slider label="Level" value={a.level} min={1} max={255} onChange={(v) => setAdj({ ...a, level: v })} onCommit={onCommit} />
          </>
        );
        break;
      case 'posterize':
        body = <Slider label="Levels" value={a.levels} min={2} max={64} onChange={(v) => setAdj({ ...a, levels: v })} onCommit={onCommit} />;
        break;
      case 'photoFilter':
        body = (
          <>
            <input type="color" aria-label="Filter colour" value={a.color} onChange={(e) => setAdj({ ...a, color: e.target.value })} onBlur={onCommit} />
            <Slider label="Density" value={a.density} min={0} max={100} onChange={(v) => setAdj({ ...a, density: v })} onCommit={onCommit} />
          </>
        );
        break;
      case 'invert':
        body = <p className="pi-hint">Inverts the colours of the layers below.</p>;
        break;
      case 'clarity':
        body = (
          <>
            <Slider label="Clarity" value={a.amount} min={-100} max={100} onChange={(v) => setAdj({ ...a, amount: v })} onCommit={onCommit} />
            <p className="pi-hint">Adds contrast to midtone detail without clipping shadows or highlights. Negative values soften.</p>
          </>
        );
        break;
      case 'dehaze':
        body = (
          <>
            <Slider label="Dehaze" value={a.amount} min={-100} max={100} onChange={(v) => setAdj({ ...a, amount: v })} onCommit={onCommit} />
            <p className="pi-hint">Removes atmospheric haze and flat, milky contrast. Negative values add haze.</p>
          </>
        );
        break;
      case 'grain':
        body = (
          <>
            <Slider label="Amount" value={a.amount} min={0} max={100} onChange={(v) => setAdj({ ...a, amount: v })} onCommit={onCommit} />
            <Slider label="Size" value={a.size} min={1} max={10} step={0.5} onChange={(v) => setAdj({ ...a, size: v })} onCommit={onCommit} />
            <Slider label="Roughness" value={a.roughness} min={0} max={100} onChange={(v) => setAdj({ ...a, roughness: v })} onCommit={onCommit} />
          </>
        );
        break;
      case 'lut':
        body = (
          <>
            <div className="pi-row">
              <select
                className="tb-select"
                aria-label="Look"
                value={LUT_PRESETS.find((p) => p.label === a.lut?.name)?.id ?? (a.lut ? 'file' : '')}
                onChange={(e) => {
                  const preset = LUT_PRESETS.find((p) => p.id === e.target.value);
                  if (preset) {
                    onChange({ ...layer, adjust: { ...a, lut: preset.build() } });
                    onCommit();
                  }
                }}
              >
                <option value="" disabled>Choose a look…</option>
                {LUT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                {a.lut && !LUT_PRESETS.some((p) => p.label === a.lut?.name) && <option value="file">{a.lut.name}</option>}
              </select>
              <label className="pi-text-btn pi-file-btn">
                Load .cube…
                <input
                  type="file"
                  accept=".cube,text/plain"
                  hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (!f) return;
                    try {
                      const lut = parseCube(await f.text(), f.name.replace(/\.cube$/i, ''));
                      setLutError(null);
                      onChange({ ...layer, adjust: { ...a, lut } });
                      onCommit();
                    } catch (err) {
                      setLutError(err instanceof Error ? err.message : String(err));
                    }
                  }}
                />
              </label>
            </div>
            <Slider label="Strength" value={a.strength} min={0} max={100} onChange={(v) => setAdj({ ...a, strength: v })} onCommit={onCommit} />
            {lutError && <p className="pi-hint pi-error" role="alert">{lutError}</p>}
            <p className="pi-hint">{a.lut ? `${a.lut.name} · ${a.lut.size}³ points` : 'Pick a built-in look, or load a .cube LUT file from a camera maker or colourist.'}</p>
          </>
        );
        break;
    }
  } else {
    body = (
      <p className="pi-hint">
        Pixel layer · {layer.px.width} × {layer.px.height}
        {layer.x || layer.y ? ` at ${layer.x}, ${layer.y}` : ''}
      </p>
    );
  }
  return (
    <section className="pi-panel pi-props" aria-label="Properties">
      <header className="pi-panel-head">Properties · {layer.kind === 'adjust' ? ADJUST_LABELS[layer.adjust.type] : layer.name}</header>
      <div className="pi-props-body">
        {body}
        {extra}
      </div>
    </section>
  );
}

function ColorBalanceEditor({ spec, onChange, onCommit }: { spec: Extract<AdjustSpec, { type: 'colorBalance' }>; onChange: (s: AdjustSpec) => void; onCommit: () => void }) {
  const [tone, setTone] = useState<'shadows' | 'midtones' | 'highlights'>('midtones');
  const v = spec[tone];
  const set = (i: number, val: number) => {
    const next = [...v] as [number, number, number];
    next[i] = val;
    onChange({ ...spec, [tone]: next });
  };
  return (
    <>
      <div className="pi-seg" role="radiogroup" aria-label="Tone">
        {(['shadows', 'midtones', 'highlights'] as const).map((t) => (
          <button key={t} type="button" className={tone === t ? 'is-active' : ''} onClick={() => setTone(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <Slider label="Cyan ↔ Red" value={v[0]} min={-100} max={100} onChange={(x) => set(0, x)} onCommit={onCommit} />
      <Slider label="Magenta ↔ Green" value={v[1]} min={-100} max={100} onChange={(x) => set(1, x)} onCommit={onCommit} />
      <Slider label="Yellow ↔ Blue" value={v[2]} min={-100} max={100} onChange={(x) => set(2, x)} onCommit={onCommit} />
      <label className="check"><input type="checkbox" checked={spec.preserveLuminosity} onChange={(e) => { onChange({ ...spec, preserveLuminosity: e.target.checked }); onCommit(); }} /> Preserve luminosity</label>
    </>
  );
}

export { Slider };
