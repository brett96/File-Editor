/**
 * A UiPath Studio-like designer for workflow .xaml files: the Activities panel, the workflow
 * as nested activity cards (Sequence, If, While, For Each, Try Catch, scopes…), the selected
 * activity's Properties, and the Variables / Arguments / Imports panels.
 *
 * It edits the XAML text the code editor holds (CodeEditor shows it as the Designer view): each
 * change rewrites the text through src/core/workflow/xaml.ts, which keeps everything the
 * designer doesn't show as it was, so saving, undo, the agent and Git all work on the same file.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Boxes,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  GitBranch,
  MousePointerClick,
  Plus,
  Redo2,
  Search,
  ShieldAlert,
  Square,
  StickyNote,
  Table2,
  Terminal,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { cx } from '../components';
import { ACTIVITY_TEMPLATES, COMMON_TYPES, TEMPLATE_GROUPS } from '../../core/workflow/activities';
import {
  NS,
  addArgument,
  addImport,
  addVariable,
  argumentsOf,
  categoryOf,
  cloneActivity,
  displayName,
  fromSnippet,
  importsOf,
  isActivity,
  parseXaml,
  placeActivity,
  placeOf,
  propertiesOf,
  removeNode,
  serializeXaml,
  setProperty,
  slotsOf,
  summaryOf,
  typeLabel,
  updateArgument,
  updateVariable,
  variableScopeFor,
  variablesInScope,
  type ParsedWorkflow,
  type PropertyRef,
  type Slot,
} from '../../core/workflow/xaml';

const DRAG_TYPE = 'application/x-fe-workflow';

const ICONS = {
  container: Boxes,
  control: GitBranch,
  ui: MousePointerClick,
  data: Table2,
  system: Terminal,
  error: ShieldAlert,
  other: Square,
} as const;

/** Stable ids for elements, for React keys and drag and drop. */
const ids = new WeakMap<Element, string>();
let seq = 0;
const idOf = (el: Element) => {
  let id = ids.get(el);
  if (!id) ids.set(el, (id = `a${++seq}`));
  return id;
};

/** Whether Studio saved this activity collapsed (its ViewState says IsExpanded False). */
function savedCollapsed(el: Element): boolean {
  const vs = Array.from(el.children).find((c) => c.localName === 'WorkflowViewStateService.ViewState');
  const flag = vs ? Array.from(vs.getElementsByTagName('*')).find((c) => c.getAttributeNS(NS.x, 'Key') === 'IsExpanded') : undefined;
  return flag?.textContent?.trim() === 'False';
}

interface Ctx {
  selected: Element | null;
  select: (el: Element) => void;
  collapsed: Set<string>;
  toggle: (el: Element) => void;
  drop: (data: string, slot: Slot, index: number) => void;
  dragging: boolean;
  setDragging: (v: boolean) => void;
  act: (el: Element, action: 'up' | 'down' | 'duplicate' | 'delete') => void;
  addAt: (slot: Slot, index: number) => void;
  version: number;
}

export function WorkflowDesigner({ text, onEdit, onUndo, onRedo }: { text: string; onEdit: (text: string) => void; onUndo: () => void; onRedo: () => void }) {
  const [workflow, setWorkflow] = useState<ParsedWorkflow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<Element | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const [bottom, setBottom] = useState<'variables' | 'arguments' | 'imports'>('variables');
  /** the next palette click goes here (an empty slot's + button) */
  const [target, setTarget] = useState<{ slot: Slot; index: number } | null>(null);
  const written = useRef<string | null>(null);

  // read the text again when it changed outside the designer (the XAML view, undo, the agent)
  useEffect(() => {
    if (text === written.current) return;
    try {
      const w = parseXaml(text);
      const path = selected && workflow ? pathOf(selected) : null;
      setWorkflow(w);
      setError(null);
      written.current = text;
      const restored = path ? fromPath(w, path) : null;
      setSelected(restored ?? w.main);
      // what Studio saved as collapsed starts collapsed
      const shut = new Set<string>();
      const walk = (el: Element) => {
        if (savedCollapsed(el)) shut.add(idOf(el));
        for (const s of slotsOf(el)) s.activities.forEach(walk);
      };
      if (w.main && !workflow) walk(w.main);
      if (!workflow) setCollapsed(shut);
      setVersion((v) => v + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The workflow could not be read.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const commit = useCallback(() => {
    if (!workflow) return;
    const next = serializeXaml(workflow);
    written.current = next;
    setVersion((v) => v + 1);
    onEdit(next);
  }, [workflow, onEdit]);

  const run = useCallback(
    (fn: () => void) => {
      try {
        fn();
        commit();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That change could not be made.');
        window.setTimeout(() => setError(null), 4000);
      }
    },
    [commit],
  );

  const byId = useCallback(
    (id: string): Element | null => {
      if (!workflow) return null;
      let found: Element | null = null;
      const walk = (el: Element) => {
        if (found) return;
        if (ids.get(el) === id) found = el;
        for (const s of slotsOf(el)) s.activities.forEach(walk);
      };
      if (workflow.main) walk(workflow.main);
      return found;
    },
    [workflow],
  );

  const create = useCallback((templateId: string) => {
    const t = ACTIVITY_TEMPLATES.find((x) => x.id === templateId);
    if (!t || !workflow) throw new Error('Unknown activity.');
    return fromSnippet(workflow.doc, t.xaml);
  }, [workflow]);

  const drop = useCallback(
    (data: string, slot: Slot, index: number) => {
      run(() => {
        if (data.startsWith('new:')) {
          const el = create(data.slice(4));
          placeActivity(el, slot, index);
          setSelected(el);
          return;
        }
        const el = byId(data.slice(5));
        if (!el) return;
        const from = slot.activities.indexOf(el);
        // moving down within the same list: the drop index counted the activity itself
        placeActivity(el, slot, from >= 0 && from < index ? index - 1 : index);
        setSelected(el);
      });
    },
    [run, create, byId],
  );

  /** Where a palette click adds: the chosen empty slot, inside a selected Sequence, after the selected activity. */
  const insertionPoint = useCallback((): { slot: Slot; index: number } | null => {
    if (!workflow?.main) return null;
    if (target) return target;
    const sel = selected ?? workflow.main;
    const own = slotsOf(sel);
    if (own[0]?.list) return { slot: own[0], index: own[0].activities.length };
    const place = placeOf(sel);
    if (place?.slot.list) return { slot: place.slot, index: place.index + 1 };
    const empty = own.find((s) => !s.activities.length);
    if (empty) return { slot: empty, index: 0 };
    const main = slotsOf(workflow.main)[0];
    return main ? { slot: main, index: main.activities.length } : null;
  }, [workflow, selected, target]);

  const addTemplate = (templateId: string) => {
    const at = insertionPoint();
    if (!at) return;
    setTarget(null);
    drop(`new:${templateId}`, at.slot, at.index);
  };

  const act = useCallback(
    (el: Element, action: 'up' | 'down' | 'duplicate' | 'delete') => {
      const place = placeOf(el);
      run(() => {
        if (action === 'delete') {
          if (!place) throw new Error('The top activity of the workflow can’t be deleted.');
          const next = place.slot.activities[place.index + 1] ?? place.slot.activities[place.index - 1] ?? place.parent;
          removeNode(el);
          setSelected(next);
          return;
        }
        if (!place) return;
        if (action === 'duplicate') {
          const copy = cloneActivity(el);
          placeActivity(copy, place.slot, place.slot.list ? place.index + 1 : 1);
          setSelected(copy);
          return;
        }
        if (!place.slot.list) return;
        const to = action === 'up' ? place.index - 1 : place.index + 1;
        if (to < 0 || to >= place.slot.activities.length) return;
        placeActivity(el, place.slot, action === 'up' ? to : to);
      });
    },
    [run],
  );

  const toggle = useCallback((el: Element) => {
    const id = idOf(el);
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  const allContainers = () => {
    const out: string[] = [];
    const walk = (el: Element) => {
      if (slotsOf(el).length) out.push(idOf(el));
      for (const s of slotsOf(el)) s.activities.forEach(walk);
    };
    if (workflow?.main) walk(workflow.main);
    return out;
  };

  const ctx: Ctx = {
    selected,
    select: (el) => {
      setSelected(el);
      setTarget(null);
    },
    collapsed,
    toggle,
    drop,
    dragging,
    setDragging,
    act,
    addAt: (slot, index) => setTarget({ slot, index }),
    version,
  };

  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault();
      act(selected, 'delete');
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) onRedo();
      else onUndo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      onRedo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && selected) {
      e.preventDefault();
      act(selected, 'duplicate');
    }
  };

  if (!workflow) {
    return (
      <div className="wf-designer wf-designer-error" role="alert">
        <p>{error ?? 'Reading the workflow…'}</p>
        {error && <p className="wf-muted">Fix it in the XAML view, then come back to the designer.</p>}
      </div>
    );
  }

  return (
    <div className="wf-designer" onKeyDown={onKey}>
      <Palette onAdd={addTemplate} onDragging={setDragging} targetLabel={target ? `${target.slot.label || 'the empty space'}` : null} onClearTarget={() => setTarget(null)} />
      <div className="wf-center">
        <div className="wf-toolbar" role="toolbar" aria-label="Workflow">
          <button type="button" className="wf-tool" onClick={onUndo} title="Undo (Ctrl+Z)">
            <Undo2 size={15} /> Undo
          </button>
          <button type="button" className="wf-tool" onClick={onRedo} title="Redo (Ctrl+Y)">
            <Redo2 size={15} /> Redo
          </button>
          <span className="wf-sep" />
          <button type="button" className="wf-tool" onClick={() => setCollapsed(new Set())} title="Expand every activity">
            <ChevronsUpDown size={15} /> Expand all
          </button>
          <button type="button" className="wf-tool" onClick={() => setCollapsed(new Set(allContainers().filter((id) => id !== (workflow.main ? idOf(workflow.main) : ''))))} title="Collapse every activity">
            <ChevronsDownUp size={15} /> Collapse all
          </button>
          <span className="wf-class">{workflow.root.getAttributeNS(NS.x, 'Class') ?? 'Workflow'}</span>
          {error && (
            <span className="wf-error" role="alert">
              {error}
            </span>
          )}
        </div>
        <div className="wf-canvas" tabIndex={0} aria-label="Workflow designer">
          {workflow.main ? <ActivityCard el={workflow.main} ctx={ctx} root /> : <p className="wf-muted">This workflow has no activities.</p>}
        </div>
        <BottomPanel workflow={workflow} selected={selected} tab={bottom} setTab={setBottom} run={run} version={version} />
      </div>
      <PropertiesPanel el={selected} run={run} version={version} />
    </div>
  );
}

// ── the canvas ───────────────────────────────────────────────────────────────
const ActivityCard = memo(function ActivityCard({ el, ctx, root = false }: { el: Element; ctx: Ctx; root?: boolean }) {
  const slots = slotsOf(el);
  const id = idOf(el);
  const shut = ctx.collapsed.has(id);
  const Icon = ICONS[categoryOf(el)];
  const summary = summaryOf(el);
  const note = el.getAttributeNS(NS.sap2010, 'Annotation.AnnotationText');
  const isSel = ctx.selected === el;
  const name = displayName(el);
  return (
    <div className={cx('wf-card', `is-${categoryOf(el)}`, isSel && 'is-selected', slots.length > 0 && 'has-body')} data-wf={id}>
      <div
        className="wf-card-head"
        draggable={!root}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, `move:${id}`);
          e.dataTransfer.effectAllowed = 'move';
          e.stopPropagation();
          ctx.setDragging(true);
        }}
        onDragEnd={() => ctx.setDragging(false)}
        onClick={(e) => {
          e.stopPropagation();
          ctx.select(el);
        }}
        role="button"
        tabIndex={0}
        aria-pressed={isSel}
        aria-label={`${name} (${typeLabel(el)})`}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            ctx.select(el);
          }
        }}
      >
        {slots.length > 0 ? (
          <button
            type="button"
            className="wf-chevron"
            aria-label={shut ? 'Expand' : 'Collapse'}
            onClick={(e) => {
              e.stopPropagation();
              ctx.toggle(el);
            }}
          >
            {shut ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
        ) : (
          <span className="wf-chevron-space" />
        )}
        <Icon size={15} className="wf-icon" />
        <span className="wf-name">{name}</span>
        {name !== typeLabel(el) && <span className="wf-type">{typeLabel(el)}</span>}
        {isSel && !root && (
          <span className="wf-actions">
            <button type="button" title="Move up" aria-label="Move up" onClick={(e) => (e.stopPropagation(), ctx.act(el, 'up'))}>
              <ArrowUp size={13} />
            </button>
            <button type="button" title="Move down" aria-label="Move down" onClick={(e) => (e.stopPropagation(), ctx.act(el, 'down'))}>
              <ArrowDown size={13} />
            </button>
            <button type="button" title="Duplicate (Ctrl+D)" aria-label="Duplicate" onClick={(e) => (e.stopPropagation(), ctx.act(el, 'duplicate'))}>
              <Copy size={13} />
            </button>
            <button type="button" title="Delete (Del)" aria-label="Delete" onClick={(e) => (e.stopPropagation(), ctx.act(el, 'delete'))}>
              <Trash2 size={13} />
            </button>
          </span>
        )}
      </div>
      {summary && !shut && <div className="wf-summary" title={summary}>{summary}</div>}
      {note && (
        <div className="wf-note">
          <StickyNote size={12} /> {note}
        </div>
      )}
      {slots.length > 0 && shut && <button type="button" className="wf-collapsed" onClick={() => ctx.toggle(el)}>Collapsed: show what's inside</button>}
      {slots.length > 0 && !shut && (
        <div className={cx('wf-slots', slots.length > 1 && el.localName === 'If' && 'is-columns')}>
          {slots.map((s, i) => (
            <SlotView key={i} slot={s} ctx={ctx} />
          ))}
        </div>
      )}
    </div>
  );
});

function SlotView({ slot, ctx }: { slot: Slot; ctx: Ctx }) {
  const label = slot.label ? `${slot.label}${slot.argument ? ` (${slot.argument})` : ''}` : '';
  return (
    <div className={cx('wf-slot', slot.list && 'is-list')}>
      {label && <div className="wf-slot-label">{label}</div>}
      {slot.activities.length === 0 ? (
        <DropZone slot={slot} index={0} ctx={ctx} empty />
      ) : (
        <>
          {slot.list && <DropZone slot={slot} index={0} ctx={ctx} />}
          {slot.activities.map((a, i) => (
            <div key={idOf(a)} className="wf-item">
              <ActivityCard el={a} ctx={ctx} />
              {slot.list ? <DropZone slot={slot} index={i + 1} ctx={ctx} /> : <DropZone slot={slot} index={1} ctx={ctx} wrap />}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function DropZone({ slot, index, ctx, empty = false, wrap = false }: { slot: Slot; index: number; ctx: Ctx; empty?: boolean; wrap?: boolean }) {
  const [over, setOver] = useState(false);
  const accept = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(DRAG_TYPE);
  if (wrap && !ctx.dragging) return null;
  return (
    <div
      className={cx('wf-drop', empty && 'is-empty', over && 'is-over', ctx.dragging && 'is-dragging')}
      onDragOver={(e) => {
        if (!accept(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!accept(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        ctx.setDragging(false);
        ctx.drop(e.dataTransfer.getData(DRAG_TYPE), slot, index);
      }}
    >
      {empty && (
        <button type="button" className="wf-drop-add" onClick={() => ctx.addAt(slot, index)}>
          <Plus size={13} /> Drop an activity here, or pick one in Activities
        </button>
      )}
      {wrap && <span className="wf-drop-hint">Drop to add after (both go in a Sequence)</span>}
    </div>
  );
}

// ── panels ───────────────────────────────────────────────────────────────────
function Palette({ onAdd, onDragging, targetLabel, onClearTarget }: { onAdd: (id: string) => void; onDragging: (v: boolean) => void; targetLabel: string | null; onClearTarget: () => void }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = ACTIVITY_TEMPLATES.filter((t) => !q || `${t.name} ${t.hint} ${t.group}`.toLowerCase().includes(q));
  return (
    <aside className="wf-palette" aria-label="Activities">
      <div className="wf-panel-title">Activities</div>
      <label className="wf-search">
        <Search size={13} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search activities" aria-label="Search activities" />
      </label>
      {targetLabel && (
        <div className="wf-target">
          Adding into <strong>{targetLabel}</strong>
          <button type="button" aria-label="Cancel" onClick={onClearTarget}>
            <X size={12} />
          </button>
        </div>
      )}
      <div className="wf-palette-list">
        {TEMPLATE_GROUPS.map((g) => {
          const items = shown.filter((t) => t.group === g);
          if (!items.length) return null;
          return (
            <div key={g} className="wf-group">
              <div className="wf-group-title">{g}</div>
              {items.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="wf-palette-item"
                  draggable
                  title={`${t.hint}. Click to add after the selected activity, or drag it into place.`}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, `new:${t.id}`);
                    e.dataTransfer.effectAllowed = 'copy';
                    onDragging(true);
                  }}
                  onDragEnd={() => onDragging(false)}
                  onClick={() => onAdd(t.id)}
                >
                  <Plus size={12} />
                  <span>{t.name}</span>
                </button>
              ))}
            </div>
          );
        })}
        {!shown.length && <p className="wf-muted">No activity matches.</p>}
      </div>
    </aside>
  );
}

/** A text field that writes its value when it loses focus or on Enter (one change per edit). */
function Field({ value, onCommit, multiline = false, placeholder, label }: { value: string; onCommit: (v: string) => void; multiline?: boolean; placeholder?: string; label: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const done = () => {
    if (draft !== value) onCommit(draft);
  };
  const common = {
    value: draft,
    placeholder,
    'aria-label': label,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: done,
  };
  return multiline ? (
    <textarea {...common} rows={Math.min(6, Math.max(2, Math.ceil(draft.length / 34)))} onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && done()} />
  ) : (
    <input {...common} onKeyDown={(e) => e.key === 'Enter' && done()} />
  );
}

function PropertiesPanel({ el, run, version }: { el: Element | null; run: (fn: () => void) => void; version: number }) {
  const props = useMemo(() => (el ? propertiesOf(el) : []), [el, version]);
  return (
    <aside className="wf-props" aria-label="Properties">
      <div className="wf-panel-title">Properties</div>
      {!el ? (
        <p className="wf-muted">Select an activity to see its properties.</p>
      ) : (
        <>
          <div className="wf-props-type">
            {typeLabel(el)}
            <span>{el.prefix ? `${el.prefix}:` : ''}{el.localName}</span>
          </div>
          {props.map((p: PropertyRef) => (
            <label key={p.name} className="wf-prop">
              <span className="wf-prop-name">
                {p.name}
                {p.hint && <em>{p.hint}</em>}
              </span>
              <Field
                label={p.name}
                value={p.value}
                multiline={p.value.length > 40 || /Selector$|Annotation|Text|Message|Condition/.test(p.name)}
                placeholder={p.kind === 'argument' || p.kind === 'expression' ? '[expression]' : p.name === 'DisplayName' ? typeLabel(el) : ''}
                onCommit={(v) => run(() => setProperty(el, p, v))}
              />
            </label>
          ))}
          <p className="wf-hint">Expressions are VB.NET in square brackets, e.g. [rowNum + 1] or ["text"]. Plain text is used as it is.</p>
        </>
      )}
    </aside>
  );
}

function TypeField({ value, onCommit, label }: { value: string; onCommit: (v: string) => void; label: string }) {
  const known = COMMON_TYPES.find((t) => t.type === value);
  const [custom, setCustom] = useState(!known);
  if (custom) {
    return (
      <span className="wf-type-field">
        <Field label={label} value={value} onCommit={onCommit} placeholder="x:String" />
        <button type="button" title="Pick a common type" aria-label="Pick a common type" onClick={() => setCustom(false)}>
          <ChevronDown size={12} />
        </button>
      </span>
    );
  }
  return (
    <select
      aria-label={label}
      value={known ? value : ''}
      onChange={(e) => {
        if (e.target.value === '__custom') return setCustom(true);
        onCommit(e.target.value);
      }}
    >
      {COMMON_TYPES.map((t) => (
        <option key={t.type} value={t.type}>
          {t.label}
        </option>
      ))}
      <option value="__custom">Other type…</option>
    </select>
  );
}

function BottomPanel({
  workflow,
  selected,
  tab,
  setTab,
  run,
  version,
}: {
  workflow: ParsedWorkflow;
  selected: Element | null;
  tab: 'variables' | 'arguments' | 'imports';
  setTab: (t: 'variables' | 'arguments' | 'imports') => void;
  run: (fn: () => void) => void;
  version: number;
}) {
  const vars = useMemo(() => variablesInScope(selected, workflow.main), [selected, workflow, version]);
  const args = useMemo(() => argumentsOf(workflow.root), [workflow, version]);
  const imports = useMemo(() => importsOf(workflow.root), [workflow, version]);
  const scope = variableScopeFor(selected, workflow.main);
  const [newImport, setNewImport] = useState('');
  let body: ReactNode;
  if (tab === 'variables') {
    body = (
      <table className="wf-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Variable type</th>
            <th>Scope</th>
            <th>Default</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {vars.map((v) => (
            <tr key={idOf(v.el)}>
              <td>
                <Field label="Name" value={v.name} onCommit={(name) => run(() => updateVariable(v.el, { name }))} />
              </td>
              <td>
                <TypeField label={`Type of ${v.name}`} value={v.type} onCommit={(type) => run(() => updateVariable(v.el, { type }))} />
              </td>
              <td className="wf-scope">{displayName(v.scope)}</td>
              <td>
                <Field label={`Default of ${v.name}`} value={v.value} placeholder="Enter a VB expression" onCommit={(value) => run(() => updateVariable(v.el, { value }))} />
              </td>
              <td>
                <button type="button" className="wf-row-del" aria-label={`Delete ${v.name}`} onClick={() => run(() => removeNode(v.el))}>
                  <Trash2 size={13} />
                </button>
              </td>
            </tr>
          ))}
          {!vars.length && (
            <tr>
              <td colSpan={5} className="wf-muted">
                No variables in this scope.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    );
  } else if (tab === 'arguments') {
    body = (
      <table className="wf-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Direction</th>
            <th>Argument type</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {args.map((a) => (
            <tr key={idOf(a.el)}>
              <td>
                <Field label="Name" value={a.name} onCommit={(name) => run(() => updateArgument(a.el, { name }))} />
              </td>
              <td>
                {a.direction === 'Property' ? (
                  'Property'
                ) : (
                  <select aria-label={`Direction of ${a.name}`} value={a.direction} onChange={(e) => run(() => updateArgument(a.el, { direction: e.target.value as 'In' | 'Out' | 'InOut' }))}>
                    <option value="In">In</option>
                    <option value="Out">Out</option>
                    <option value="InOut">In/Out</option>
                  </select>
                )}
              </td>
              <td>
                <TypeField label={`Type of ${a.name}`} value={a.type} onCommit={(type) => run(() => updateArgument(a.el, { type }))} />
              </td>
              <td>
                <button type="button" className="wf-row-del" aria-label={`Delete ${a.name}`} onClick={() => run(() => removeNode(a.el))}>
                  <Trash2 size={13} />
                </button>
              </td>
            </tr>
          ))}
          {!args.length && (
            <tr>
              <td colSpan={4} className="wf-muted">
                This workflow has no arguments.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    );
  } else {
    body = (
      <div className="wf-imports">
        <ul>
          {imports.map((i) => (
            <li key={idOf(i)}>
              <span>{i.textContent}</span>
              <button type="button" className="wf-row-del" aria-label={`Remove ${i.textContent}`} onClick={() => run(() => removeNode(i))}>
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const ns = newImport.trim();
            if (!ns) return;
            run(() => addImport(workflow.root, ns));
            setNewImport('');
          }}
        >
          <input value={newImport} onChange={(e) => setNewImport(e.target.value)} placeholder="Add a namespace, e.g. System.Text" aria-label="Namespace to import" />
          <button type="submit" className="wf-tool">
            <Plus size={13} /> Import
          </button>
        </form>
      </div>
    );
  }
  const unique = (base: string, taken: string[]) => {
    let n = base;
    for (let i = 2; taken.includes(n); i++) n = `${base}${i}`;
    return n;
  };
  return (
    <section className="wf-bottom" aria-label="Variables, arguments and imports">
      <div className="wf-tabs" role="tablist">
        {(['variables', 'arguments', 'imports'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={cx('wf-tab', tab === t && 'is-active')} onClick={() => setTab(t)}>
            {t === 'variables' ? `Variables (${vars.length})` : t === 'arguments' ? `Arguments (${args.length})` : `Imports (${imports.length})`}
          </button>
        ))}
        <span className="wf-sep" />
        {tab === 'variables' && (
          <button
            type="button"
            className="wf-tool"
            disabled={!scope}
            title={scope ? `Adds a variable to ${displayName(scope)}` : 'Select a Sequence to add variables to'}
            onClick={() => scope && run(() => addVariable(scope, unique('variable', vars.map((v) => v.name)), 'x:String'))}
          >
            <Plus size={13} /> Variable{scope ? ` in ${displayName(scope)}` : ''}
          </button>
        )}
        {tab === 'arguments' && (
          <button type="button" className="wf-tool" onClick={() => run(() => addArgument(workflow.root, unique('in_Argument', args.map((a) => a.name)), 'In', 'x:String'))}>
            <Plus size={13} /> Argument
          </button>
        )}
      </div>
      <div className="wf-bottom-body">{body}</div>
    </section>
  );
}

// ── keeping the selection when the text is read again ───────────────────────
/** Positions from the top activity down to `el` (slot index, activity index…). */
function pathOf(el: Element): number[] {
  const path: number[] = [];
  for (let cur: Element = el; ; ) {
    const place = placeOf(cur);
    if (!place) return path;
    const slotIndex = slotsOf(place.parent).findIndex((s) => s.host === place.slot.host);
    path.unshift(slotIndex, place.index);
    cur = place.parent;
  }
}

function fromPath(w: ParsedWorkflow, path: number[]): Element | null {
  let cur = w.main;
  for (let i = 0; cur && i < path.length; i += 2) cur = slotsOf(cur)[path[i]]?.activities[path[i + 1]] ?? null;
  return cur && isActivity(cur) ? cur : null;
}

