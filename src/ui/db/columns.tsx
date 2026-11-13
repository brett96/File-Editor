/**
 * Column layout for the database grids: each column has a width that can be dragged at its
 * right edge, the headers can be dragged sideways to change the order the columns are shown
 * in, and a double-click on a column's right edge fits it to its widest value.
 *
 * This is how the table is shown, not how it is stored: the database's own column order and
 * definitions are not touched.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { cx } from '../components';

export const MIN_COL_WIDTH = 44;
export const MAX_COL_WIDTH = 1200;
const DEFAULT_MAX_WIDTH = 280;
/** Pixels of movement before a press on a header becomes a drag. */
const DRAG_START_PX = 5;
/** Left and right padding of a cell, plus its border. */
const CELL_CHROME_PX = 22;

let measureCtx: CanvasRenderingContext2D | null = null;

/** Width in CSS px of `text` in `font` (a CSS font shorthand). */
export function textWidth(text: string, font: string): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * 7.5;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/** A first width for a column, from its heading and the values on screen. */
export function defaultWidth(header: string, sample: string[]): number {
  let chars = header.length + 2;
  for (const s of sample) if (s.length > chars) chars = s.length;
  return Math.round(Math.max(72, Math.min(DEFAULT_MAX_WIDTH, chars * 7.4 + CELL_CHROME_PX)));
}

/** The width that shows `texts` in full (the widest line of the widest one), within limits. */
export function fitWidth(texts: string[], font: string, headerWidth = 0): number {
  let widest = headerWidth;
  for (const t of texts) {
    for (const line of t.length > 4000 ? [t.slice(0, 4000)] : t.split('\n')) {
      const w = textWidth(line, font);
      if (w > widest) widest = w;
    }
  }
  return Math.round(Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, widest + CELL_CHROME_PX + 2)));
}

export interface ColumnLayout {
  /** The columns in the order they are shown. */
  order: string[];
  widthOf(column: string): number;
  /** Sum of the shown columns' widths. */
  totalWidth: number;
  setWidth(column: string, width: number): void;
  /** Moves `column` to sit before (or after) `target`. */
  move(column: string, target: string, after: boolean): void;
}

/**
 * Widths and order for the columns of one table. `layoutKey` names the table: each table
 * keeps its own layout for as long as the editor is open.
 */
export function useColumnLayout(layoutKey: string, columns: string[], sampleOf: (column: string) => string[]): ColumnLayout {
  const [widths, setWidths] = useState<Record<string, Record<string, number>>>({});
  const [orders, setOrders] = useState<Record<string, string[]>>({});
  const sampleRef = useRef(sampleOf);
  sampleRef.current = sampleOf;
  const defaults = useRef<Record<string, Record<string, number>>>({});

  const columnsKey = columns.join('\u0000');
  const order = useMemo(() => {
    const saved = (orders[layoutKey] ?? []).filter((c) => columns.includes(c));
    return [...saved, ...columns.filter((c) => !saved.includes(c))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, layoutKey, columnsKey]);

  const widthOf = useCallback(
    (column: string): number => {
      const set = widths[layoutKey]?.[column];
      if (set !== undefined) return set;
      // worked out once per column, so paging through a table does not make columns jump
      const mine = (defaults.current[layoutKey] ??= {});
      if (mine[column] !== undefined) return mine[column];
      const sample = sampleRef.current(column);
      const width = defaultWidth(column, sample);
      // an empty table says nothing about its values yet: decide again once it has rows
      if (sample.length) mine[column] = width;
      return width;
    },
    [widths, layoutKey],
  );

  const setWidth = useCallback(
    (column: string, width: number) => {
      const w = Math.round(Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, width)));
      setWidths((all) => ({ ...all, [layoutKey]: { ...all[layoutKey], [column]: w } }));
    },
    [layoutKey],
  );

  const move = useCallback(
    (column: string, target: string, after: boolean) => {
      if (column === target) return;
      const next = order.filter((c) => c !== column);
      const at = next.indexOf(target);
      if (at < 0) return;
      next.splice(after ? at + 1 : at, 0, column);
      setOrders((all) => ({ ...all, [layoutKey]: next }));
    },
    [order, layoutKey],
  );

  let totalWidth = 0;
  for (const c of order) totalWidth += widthOf(c);
  return { order, widthOf, totalWidth, setWidth, move };
}

interface DragState {
  column: string;
  target: string;
  after: boolean;
}

/**
 * The header row's cells for a ColumnLayout. `onAutoFit` is called for a double-click on a
 * column's right edge; `renderLabel` adds what goes under the name (the column's type).
 */
export function HeaderCells({
  layout,
  onAutoFit,
  renderLabel,
}: {
  layout: ColumnLayout;
  onAutoFit: (column: string) => void;
  renderLabel?: (column: string) => ReactNode;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [resizing, setResizing] = useState<string | null>(null);
  const cells = useRef(new Map<string, HTMLTableCellElement>());
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  /** Listens on the window until the pointer is released (or the gesture is cancelled). */
  const track = (onMove: (e: PointerEvent) => void, onEnd: (e: PointerEvent | null) => void) => {
    cleanup.current?.();
    const move = (e: PointerEvent) => onMove(e);
    const stop = (e: Event) => {
      done();
      onEnd(e.type === 'pointerup' ? (e as PointerEvent) : null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      done();
      onEnd(null);
    };
    const done = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', stop);
      window.removeEventListener('keydown', key, true);
      document.body.classList.remove('db-col-gesture');
      cleanup.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);
    window.addEventListener('keydown', key, true);
    document.body.classList.add('db-col-gesture');
    cleanup.current = done;
  };

  const startResize = (e: ReactPointerEvent, column: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = layout.widthOf(column);
    setResizing(column);
    track(
      (ev) => layout.setWidth(column, startWidth + ev.clientX - startX),
      () => setResizing(null),
    );
  };

  const startDrag = (e: ReactPointerEvent, column: string) => {
    if (e.button !== 0 || layout.order.length < 2) return;
    const startX = e.clientX;
    let active = false;
    let last: DragState | null = null;
    track(
      (ev) => {
        if (!active && Math.abs(ev.clientX - startX) < DRAG_START_PX) return;
        active = true;
        // the header the pointer is over, or the nearest one when it is past either end
        let best: DragState | null = null;
        let bestDistance = Infinity;
        for (const name of layout.order) {
          const rect = cells.current.get(name)?.getBoundingClientRect();
          if (!rect) continue;
          const mid = rect.left + rect.width / 2;
          const distance = ev.clientX < rect.left ? rect.left - ev.clientX : ev.clientX > rect.right ? ev.clientX - rect.right : 0;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = { column, target: name, after: ev.clientX > mid };
          }
        }
        last = best;
        setDrag(best);
      },
      (ev) => {
        setDrag(null);
        if (ev && active && last && last.target !== column) layout.move(column, last.target, last.after);
      },
    );
  };

  return (
    <>
      {layout.order.map((column) => {
        const width = layout.widthOf(column);
        const style: CSSProperties = { width, minWidth: width, maxWidth: width };
        const dropping = drag && drag.target === column && drag.column !== column;
        return (
          <th
            key={column}
            ref={(el) => {
              if (el) cells.current.set(column, el);
              else cells.current.delete(column);
            }}
            style={style}
            className={cx('db-col', drag?.column === column && 'is-dragging', dropping && (drag.after ? 'drop-after' : 'drop-before'), resizing === column && 'is-resizing')}
            onPointerDown={(e) => startDrag(e, column)}
          >
            <span className="db-col-name">{column}</span>
            {renderLabel?.(column)}
            <span
              className="db-col-resize"
              role="separator"
              aria-orientation="vertical"
              aria-label={`Resize column ${column}`}
              title="Drag to resize. Double-click to fit the widest value."
              onPointerDown={(e) => startResize(e, column)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                onAutoFit(column);
              }}
            />
          </th>
        );
      })}
    </>
  );
}

/** `<col>` elements matching a ColumnLayout (the table uses a fixed layout). */
export function ColumnSizes({ layout, leading = 0 }: { layout: ColumnLayout; leading?: number }) {
  return (
    <colgroup>
      {leading > 0 && <col style={{ width: leading }} />}
      {layout.order.map((c) => (
        <col key={c} style={{ width: layout.widthOf(c) }} />
      ))}
    </colgroup>
  );
}
