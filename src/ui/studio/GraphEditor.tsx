/**
 * Studio graph editor: the keyframed properties of the selected clip as value-over-time
 * curves. Drag a key to retime it or change its value, double-click a curve to add a key,
 * pick an easing per key, and shape a custom (bezier) segment with its two handles.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { Trash2 } from 'lucide-react';
import { animProps, type AnimProp } from '../../core/studio/anim';
import { addKey, DEFAULT_BEZIER, valueAt, type Animatable, type Bezier, type Clip, type Easing, type Keyframe, type Project, type VisualClip } from '../../core/studio/model';
import { cx } from '../components';

const PAD = { l: 14, r: 14, t: 14, b: 22 };
const EASINGS: [Easing, string][] = [
  ['linear', 'Linear'],
  ['easeInOut', 'Ease in-out'],
  ['easeIn', 'Ease in'],
  ['easeOut', 'Ease out'],
  ['hold', 'Hold'],
  ['bezier', 'Custom curve'],
];

interface Range {
  lo: number;
  hi: number;
}

/** The value range a curve is drawn in: its keys with some headroom (custom curves can overshoot). */
function rangeOf(a: Animatable): Range {
  const vs = a.keys.length ? a.keys.map((k) => k.v) : [a.value];
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  if (hi - lo < 1e-6) {
    const pad = Math.max(1e-3, Math.abs(hi) * 0.5 || 0.5);
    lo -= pad;
    hi += pad;
  }
  const pad = (hi - lo) * 0.2;
  return { lo: lo - pad, hi: hi + pad };
}

export function GraphEditor({ project, clip, playhead, onChange, onSeek }: { project: Project; clip: Clip | null; playhead: number; onChange: (c: Clip) => void; onSeek: (t: number) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 200 });
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [activeProp, setActiveProp] = useState<string>('x');
  const [sel, setSel] = useState<{ prop: string; index: number } | null>(null);
  const drag = useRef<null | { kind: 'key' | 'h1' | 'h2'; prop: AnimProp; index: number; range: Range }>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(200, el.clientWidth), h: Math.max(120, el.clientHeight) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visual = clip && clip.kind !== 'audio' ? (clip as VisualClip) : null;
  const props = useMemo(() => (visual ? animProps(project, visual) : []), [project, visual]);
  useEffect(() => setSel(null), [clip?.id]);

  if (!visual) {
    return (
      <div className="st-graph st-graph-empty">
        <p className="st-hint">Select a video, image, text or colour clip to see its animation curves. Add keyframes with the diamond buttons in the inspector, or double-click a curve here.</p>
      </div>
    );
  }
  const c = visual;
  const dur = Math.max(0.05, c.duration);
  const W = size.w;
  const H = size.h;
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const X = (t: number) => PAD.l + (t / dur) * plotW;
  const Y = (v: number, r: Range) => PAD.t + (1 - (v - r.lo) / (r.hi - r.lo)) * plotH;
  const tAt = (px: number) => Math.min(dur, Math.max(0, ((px - PAD.l) / plotW) * dur));
  const vAt = (py: number, r: Range) => r.lo + (1 - (py - PAD.t) / plotH) * (r.hi - r.lo);
  const local = playhead - c.start;

  const shown = props.filter((p) => !hidden.has(p.id));
  const selProp = sel ? props.find((p) => p.id === sel.prop) ?? null : null;
  const selKey: Keyframe | null = sel && selProp ? selProp.get(c).keys[sel.index] ?? null : null;

  const setKeys = (pr: AnimProp, keys: Keyframe[]) => onChange(pr.set(c, { value: pr.get(c).value, keys }));
  const patchKey = (pr: AnimProp, index: number, patch: Partial<Keyframe>) => setKeys(pr, pr.get(c).keys.map((k, i) => (i === index ? { ...k, ...patch } : k)));

  const point = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onKeyDown = (e: RPointerEvent, pr: AnimProp, index: number, kind: 'key' | 'h1' | 'h2' = 'key') => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setSel({ prop: pr.id, index });
    setActiveProp(pr.id);
    drag.current = { kind, prop: pr, index, range: rangeOf(pr.get(c)) };
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const pt = point(e);
    const a = d.prop.get(c);
    const keys = a.keys;
    const k = keys[d.index];
    if (!k) return;
    if (d.kind === 'key') {
      const lo = d.index > 0 ? keys[d.index - 1].t + 0.001 : 0;
      const hi = d.index < keys.length - 1 ? keys[d.index + 1].t - 0.001 : dur;
      const frame = 1 / project.fps;
      const t = Math.min(hi, Math.max(lo, e.shiftKey ? k.t : Math.round(tAt(pt.x) / frame) * frame));
      const raw = vAt(pt.y, d.range);
      const step = d.prop.step / d.prop.view;
      const v = e.altKey ? k.v : Math.round(raw / step) * step;
      patchKey(d.prop, d.index, { t, v });
      return;
    }
    const next = keys[d.index + 1];
    if (!next) return;
    const bx = Math.min(1, Math.max(0, (tAt(pt.x) - k.t) / (next.t - k.t || 1)));
    const span = next.v - k.v;
    const by = Math.abs(span) < 1e-9 ? 0 : Math.min(2, Math.max(-1, (vAt(pt.y, d.range) - k.v) / span));
    const bez: Bezier = [...(k.bez ?? DEFAULT_BEZIER)];
    if (d.kind === 'h1') {
      bez[0] = bx;
      bez[1] = by;
    } else {
      bez[2] = bx;
      bez[3] = by;
    }
    patchKey(d.prop, d.index, { ease: 'bezier', bez });
  };
  const onUp = () => {
    drag.current = null;
  };

  const addAt = (e: React.MouseEvent) => {
    const pr = props.find((p) => p.id === activeProp && !hidden.has(p.id)) ?? shown[0];
    if (!pr) return;
    const t = Math.round(tAt(point(e).x) * project.fps) / project.fps;
    const a = addKey(pr.get(c), t, valueAt(pr.get(c), t), 'easeInOut');
    onChange(pr.set(c, a));
    setSel({ prop: pr.id, index: a.keys.findIndex((k) => Math.abs(k.t - t) < 1e-4) });
  };

  const removeSel = () => {
    if (!sel || !selProp) return;
    const a = selProp.get(c);
    const keys = a.keys.filter((_, i) => i !== sel.index);
    onChange(selProp.set(c, { value: keys.length ? a.value : valueAt(a, a.keys[sel.index]?.t ?? 0), keys }));
    setSel(null);
  };

  const ticks: number[] = [];
  const stepT = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300].find((s) => (dur / s) * 46 < plotW) ?? 600;
  for (let t = 0; t <= dur + 1e-6; t += stepT) ticks.push(t);

  return (
    <div className="st-graph">
      <div className="st-graph-list" role="listbox" aria-label="Animated properties">
        {props.map((pr) => {
          const n = pr.get(c).keys.length;
          return (
            <div key={pr.id} className={cx('st-graph-prop', activeProp === pr.id && 'is-active', hidden.has(pr.id) && 'is-off')} role="option" aria-selected={activeProp === pr.id} onClick={() => setActiveProp(pr.id)}>
              <input
                type="checkbox"
                checked={!hidden.has(pr.id)}
                aria-label={`Show ${pr.label}`}
                onChange={(e) => {
                  const next = new Set(hidden);
                  if (e.target.checked) next.delete(pr.id);
                  else next.add(pr.id);
                  setHidden(next);
                }}
                onClick={(e) => e.stopPropagation()}
              />
              <span className="st-graph-swatch" style={{ background: pr.color }} />
              <span className="st-graph-name">{pr.label}</span>
              <small>{n ? `${n} key${n > 1 ? 's' : ''}` : '—'}</small>
            </div>
          );
        })}
      </div>
      <div className="st-graph-main">
        <div className="st-graph-bar">
          {selKey && selProp && sel ? (
            <>
              <span className="st-graph-swatch" style={{ background: selProp.color }} />
              <strong>{selProp.label}</strong>
              <label>
                Time
                <input className="st-num" type="number" step={0.01} min={0} max={dur} value={Math.round(selKey.t * 1000) / 1000} onChange={(e) => Number.isFinite(+e.target.value) && patchKey(selProp, sel.index, { t: Math.min(dur, Math.max(0, +e.target.value)) })} />
              </label>
              <label>
                Value
                <input className="st-num" type="number" step={selProp.step} value={Math.round(selKey.v * selProp.view * 1000) / 1000} onChange={(e) => Number.isFinite(+e.target.value) && patchKey(selProp, sel.index, { v: +e.target.value / selProp.view })} />
              </label>
              <label>
                Easing to next key
                <select className="tb-select" value={selKey.ease} onChange={(e) => patchKey(selProp, sel.index, { ease: e.target.value as Easing, bez: e.target.value === 'bezier' ? selKey.bez ?? DEFAULT_BEZIER : selKey.bez })}>
                  {EASINGS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
                </select>
              </label>
              <button type="button" className="btn btn-text" onClick={removeSel} title="Delete keyframe"><Trash2 size={13} /> Delete</button>
            </>
          ) : (
            <span className="st-hint">Drag a key to move it (Shift: value only, Alt: time only) · double-click to add a key to the highlighted property · choose “Custom curve” to shape a segment with handles</span>
          )}
        </div>
        <div className="st-graph-plot" ref={wrap} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <svg
            width={W}
            height={H}
            onPointerDown={(e) => {
              setSel(null);
              onSeek(c.start + tAt(point(e).x));
            }}
            onDoubleClick={addAt}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line className="st-graph-grid" x1={X(t)} x2={X(t)} y1={PAD.t} y2={H - PAD.b} />
                <text className="st-graph-tick" x={X(t)} y={H - 7} textAnchor="middle">{t.toFixed(stepT < 1 ? 2 : 0)}s</text>
              </g>
            ))}
            <rect className="st-graph-frame" x={PAD.l} y={PAD.t} width={plotW} height={plotH} />
            {shown.map((pr) => {
              const a = pr.get(c);
              const r = rangeOf(a);
              const n = Math.max(40, Math.min(400, Math.round(plotW / 3)));
              let path = '';
              for (let i = 0; i <= n; i++) {
                const t = (i / n) * dur;
                path += `${i ? 'L' : 'M'}${X(t).toFixed(1)},${Y(valueAt(a, t), r).toFixed(1)}`;
              }
              const active = activeProp === pr.id;
              return (
                <g key={pr.id} opacity={active ? 1 : 0.55}>
                  <path d={path} fill="none" stroke={pr.color} strokeWidth={active ? 2 : 1.25} strokeDasharray={a.keys.length ? undefined : '4 4'} />
                  {a.keys.map((k, i) => {
                    const isSel = sel?.prop === pr.id && sel.index === i;
                    const next = a.keys[i + 1];
                    return (
                      <g key={i}>
                        {isSel && k.ease === 'bezier' && next && (() => {
                          const b = k.bez ?? DEFAULT_BEZIER;
                          const hx = (u: number) => X(k.t + u * (next.t - k.t));
                          const hy = (u: number) => Y(k.v + u * (next.v - k.v), r);
                          return (
                            <>
                              <line className="st-graph-handle-line" x1={X(k.t)} y1={Y(k.v, r)} x2={hx(b[0])} y2={hy(b[1])} />
                              <line className="st-graph-handle-line" x1={X(next.t)} y1={Y(next.v, r)} x2={hx(b[2])} y2={hy(b[3])} />
                              <circle className="st-graph-handle" cx={hx(b[0])} cy={hy(b[1])} r={5} onPointerDown={(e) => onKeyDown(e, pr, i, 'h1')} />
                              <circle className="st-graph-handle" cx={hx(b[2])} cy={hy(b[3])} r={5} onPointerDown={(e) => onKeyDown(e, pr, i, 'h2')} />
                            </>
                          );
                        })()}
                        <rect
                          className={cx('st-graph-key', isSel && 'is-sel')}
                          x={X(k.t) - 5}
                          y={Y(k.v, r) - 5}
                          width={10}
                          height={10}
                          fill={pr.color}
                          transform={`rotate(45 ${X(k.t)} ${Y(k.v, r)})`}
                          onPointerDown={(e) => onKeyDown(e, pr, i)}
                          onDoubleClick={(e) => e.stopPropagation()}
                        >
                          <title>{`${pr.label}: ${Math.round(k.v * pr.view * 100) / 100} at ${k.t.toFixed(2)} s`}</title>
                        </rect>
                      </g>
                    );
                  })}
                </g>
              );
            })}
            {local >= 0 && local <= dur && <line className="st-graph-playhead" x1={X(local)} x2={X(local)} y1={0} y2={H - PAD.b} />}
          </svg>
        </div>
      </div>
    </div>
  );
}
