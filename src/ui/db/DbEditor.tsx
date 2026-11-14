/**
 * SQLite database editor: pick a table/view, browse rows, edit cells, add/delete rows,
 * make tables and columns, and run SQL. The database lives in memory (sql.js); App.tsx saves
 * via export().
 *
 * Columns can be resized (drag a heading's right edge), fitted to their widest value
 * (double-click that edge) and rearranged (drag a heading). Work that can take a while on a
 * large table (reading a page, counting rows, running SQL, fitting a column) runs behind a
 * spinner.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Columns3, Database, Play, Plus, RefreshCw, Table2, Trash2 } from 'lucide-react';
import {
  cellDisplay,
  type DbCell,
  type DbObject,
  type DbPage,
  type SqliteDatabase,
  type SqlResult,
} from '../../core/db/sqlite';
import { BusyPill, Field, Modal, cx, useBusy } from '../components';
import { ColumnSizes, HeaderCells, fitWidth, textWidth, useColumnLayout } from './columns';
import './db.css';

const PAGE_SIZE = 200;
const CHECK_COL_PX = 36;
const COLUMN_TYPES = ['TEXT', 'INTEGER', 'REAL', 'NUMERIC', 'BLOB'];

export interface DbEditorHandle {
  /** Current database bytes (after edits). */
  export(): Uint8Array;
  /** Re-reads the table list and the rows on screen (after the database was changed from outside). */
  refresh(): void;
}

interface Props {
  db: SqliteDatabase;
  onChange: () => void;
  onError: (message: string) => void;
}

function parseInput(raw: string, previous: DbCell): DbCell {
  if (raw === '' && (previous === null || previous === '')) return null;
  if (previous !== null && typeof previous === 'number' && raw.trim() !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

/** "name TYPE" pairs from a comma- or line-separated list ("price REAL, note"). */
export function parseColumnList(text: string): { name: string; type: string }[] {
  return text
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = /^(.*?)\s+(TEXT|INTEGER|INT|REAL|NUMERIC|BLOB)$/i.exec(part);
      return m ? { name: m[1].trim(), type: m[2].toUpperCase() === 'INT' ? 'INTEGER' : m[2].toUpperCase() } : { name: part, type: 'TEXT' };
    });
}

/** The CSS font the grid's cells are drawn in, for measuring text. */
function gridFont(el: HTMLElement | null): string {
  const cs = el ? getComputedStyle(el) : null;
  return cs ? `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}` : '13px sans-serif';
}

export const DbEditor = forwardRef<DbEditorHandle, Props>(function DbEditor({ db, onChange, onError }, ref) {
  const [objects, setObjects] = useState<DbObject[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [page, setPage] = useState<DbPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [sql, setSql] = useState('SELECT name, type FROM sqlite_master ORDER BY type, name;');
  const [sqlOpen, setSqlOpen] = useState(false);
  const [sqlResult, setSqlResult] = useState<{ id: number; result: SqlResult; offset: number; rows: DbCell[][] } | null>(null);
  const [newTable, setNewTable] = useState(false);
  const [newColumn, setNewColumn] = useState(false);
  const busy = useBusy();
  const dbRef = useRef(db);
  dbRef.current = db;
  const gridRef = useRef<HTMLDivElement>(null);
  /** Row counts, kept until rows are added or removed (counting a huge table is slow). */
  const totals = useRef(new Map<string, number>());
  const resultSeq = useRef(0);

  const refreshRef = useRef<() => void>(() => {});
  useImperativeHandle(ref, () => ({
    export: () => dbRef.current.export(),
    refresh: () => refreshRef.current(),
  }));

  const refreshObjects = useCallback(
    (select?: string) => {
      try {
        const list = db.listObjects();
        setObjects(list);
        setActive((cur) => {
          const want = select ?? cur;
          return want && list.some((o) => o.name === want) ? want : list[0]?.name ?? null;
        });
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Could not read the database schema.');
      }
    },
    [db, onError],
  );

  useEffect(() => {
    refreshObjects();
  }, [refreshObjects]);

  const activeObj = objects.find((o) => o.name === active) ?? null;

  const loadPage = useCallback(
    (name: string, kind: 'table' | 'view', off: number) =>
      busy.run('Reading rows…', () => {
        try {
          const next = db.readPage(name, kind, PAGE_SIZE, off, totals.current.get(name));
          totals.current.set(name, next.total);
          setPage(next);
          setOffset(off);
          setSelected(new Set());
          setSqlResult(null);
        } catch (err) {
          onError(err instanceof Error ? err.message : 'Could not read that table.');
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, onError, busy.run],
  );

  useEffect(() => {
    if (!activeObj) {
      setPage(null);
      return;
    }
    void loadPage(activeObj.name, activeObj.kind, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeObj?.name, activeObj?.kind, loadPage]);

  /** Re-reads everything: row counts may have changed (SQL, an outside change). */
  const reload = () => {
    totals.current.clear();
    if (activeObj) void loadPage(activeObj.name, activeObj.kind, offset);
  };

  refreshRef.current = () => {
    totals.current.clear();
    refreshObjects();
    if (activeObj && !sqlResult) void loadPage(activeObj.name, activeObj.kind, offset);
  };

  const markChanged = () => onChange();

  const onCellCommit = (rowid: number, column: string, raw: string, previous: DbCell) => {
    if (!activeObj || activeObj.kind !== 'table') return;
    if (previous instanceof Uint8Array) return;
    const next = parseInput(raw, previous);
    const prevText = previous === null ? '' : String(previous);
    if (next === previous || (next === null && prevText === '') || String(next ?? '') === prevText) return;
    try {
      db.updateCell(activeObj.name, rowid, column, next);
      markChanged();
      void loadPage(activeObj.name, 'table', offset);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not update that cell.');
      void loadPage(activeObj.name, 'table', offset);
    }
  };

  const addRow = () => {
    if (!activeObj || activeObj.kind !== 'table') return;
    try {
      const values: Record<string, DbCell> = {};
      for (const col of activeObj.columns) {
        if (col.pk && /INT/i.test(col.type)) continue; // let INTEGER PRIMARY KEY autoincrement
        if (col.dflt != null) continue;
        if (!col.notnull) values[col.name] = null;
        else values[col.name] = '';
      }
      db.insertRow(activeObj.name, values);
      markChanged();
      const total = (page?.total ?? 0) + 1;
      totals.current.set(activeObj.name, total);
      const lastPage = Math.max(0, Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE);
      void loadPage(activeObj.name, 'table', lastPage);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not insert a row.');
    }
  };

  const deleteSelected = () => {
    if (!activeObj || activeObj.kind !== 'table' || !selected.size) return;
    try {
      db.deleteRows(activeObj.name, [...selected]);
      markChanged();
      totals.current.delete(activeObj.name);
      void loadPage(activeObj.name, 'table', offset);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not delete the selected rows.');
    }
  };

  const runSql = () =>
    busy.run('Running SQL…', () => {
      try {
        const result = db.query(sql, PAGE_SIZE);
        markChanged();
        totals.current.clear();
        refreshObjects();
        if (result) {
          setSqlResult({ id: ++resultSeq.current, result, offset: 0, rows: result.rows.slice(0, PAGE_SIZE) });
          setPage(null);
        } else if (activeObj) {
          void loadPage(activeObj.name, activeObj.kind, offset);
        }
      } catch (err) {
        onError(err instanceof Error ? err.message : 'SQL error.');
      }
    });

  /** Another page of the SQL result: read from the database for a query, else from the rows kept. */
  const loadSqlPage = (off: number) => {
    if (!sqlResult) return;
    gridRef.current?.scrollTo({ top: 0 });
    const { id, result } = sqlResult;
    const query = result.query;
    if (query === null) {
      setSqlResult({ id, result, offset: off, rows: result.rows.slice(off, off + PAGE_SIZE) });
      return;
    }
    void busy.run('Reading rows…', () => {
      try {
        setSqlResult({ id, result, offset: off, rows: db.queryPage(query, PAGE_SIZE, off) });
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Could not read those rows.');
      }
    });
  };

  const createTable = (name: string, columns: { name: string; type: string }[], withId: boolean) => {
    try {
      db.createTable(name, [...(withId ? [{ name: 'id', type: 'INTEGER', pk: true }] : []), ...columns]);
      markChanged();
      setNewTable(false);
      setSqlResult(null);
      refreshObjects(name);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not create the table.');
    }
  };

  const addColumn = (name: string, type: string) => {
    if (!activeObj || activeObj.kind !== 'table') return;
    try {
      db.addColumn(activeObj.name, name, type);
      markChanged();
      setNewColumn(false);
      refreshObjects();
      void loadPage(activeObj.name, 'table', offset);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not add the column.');
    }
  };

  // ── column layout (widths, order) of the table on screen ──
  const columns = page?.columns ?? [];
  const sampleOf = (column: string): string[] => {
    const i = columns.indexOf(column);
    if (i < 0 || !page) return [];
    return page.rows.slice(0, 60).map((r) => cellDisplay(r[i]).slice(0, 60));
  };
  const layout = useColumnLayout(`table:${activeObj?.name ?? ''}`, columns, sampleOf);
  const columnIndex = useMemo(() => new Map(columns.map((c, i) => [c, i])), [columns]);
  const metaOf = (column: string) => activeObj?.columns.find((c) => c.name === column);
  const typeLabel = (column: string): string => {
    const meta = metaOf(column);
    return meta ? `${meta.type}${meta.pk ? ' · PK' : ''}` : '';
  };

  /** Fits a column to the widest value it holds anywhere in the table (not just this page). */
  const autoFit = (column: string) => {
    if (!activeObj) return;
    const font = gridFont(gridRef.current?.querySelector('.db-cell') ?? gridRef.current);
    const headFont = gridFont(gridRef.current?.querySelector('th.db-col') ?? gridRef.current);
    void busy.run('Fitting the column…', () => {
      try {
        const i = columnIndex.get(column) ?? -1;
        const onPage = page && i >= 0 ? page.rows.map((r) => cellDisplay(r[i])) : [];
        // a view is a query: its page stands in for the whole of it
        const longest = activeObj.kind === 'table' ? db.longestValues(activeObj.name, column) : [];
        const header = Math.max(textWidth(column, headFont), textWidth(typeLabel(column), `11px ${headFont.split(' ').slice(2).join(' ')}`));
        layout.setWidth(column, fitWidth([...longest, ...onPage, 'NULL'], font, header));
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Could not measure that column.');
      }
    });
  };

  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + (page?.rows.length ?? 0), total);
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;
  const isTable = activeObj?.kind === 'table';
  /** Rows of the SQL result that can be paged to (a statement that is not a query keeps only its first rows). */
  const sqlShown = !sqlResult ? 0 : sqlResult.result.query === null ? sqlResult.result.rows.length : sqlResult.result.total;

  return (
    <div className="db-editor">
      <aside className="db-sidebar" aria-label="Tables">
        <div className="db-sidebar-head">
          <span>Tables &amp; views</span>
          <button type="button" className="btn btn-icon db-new-table" title="New table" aria-label="New table" onClick={() => setNewTable(true)}>
            <Plus size={15} />
          </button>
        </div>
        {objects.length === 0 ? (
          <div className="db-empty db-empty-side">
            <p>This database has no tables yet.</p>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setNewTable(true)}>
              <Plus size={14} /> New table
            </button>
          </div>
        ) : (
          <ul className="db-object-list">
            {objects.map((o) => (
              <li key={o.name}>
                <button
                  type="button"
                  className={cx('db-object', active === o.name && !sqlResult && 'is-active')}
                  onClick={() => {
                    setSqlResult(null);
                    if (active === o.name) void loadPage(o.name, o.kind, 0);
                    else setActive(o.name);
                  }}
                >
                  <span className="db-object-kind">{o.kind === 'view' ? 'view' : 'table'}</span>
                  <span>{o.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <div className="db-main">
        <div className="db-toolbar" role="toolbar" aria-label="Database tools">
          <button type="button" className="btn btn-text" disabled={!activeObj} onClick={reload} title="Refresh">
            <RefreshCw size={15} /> Refresh
          </button>
          <button type="button" className="btn btn-text" disabled={!isTable} onClick={addRow} title="Insert row">
            <Plus size={15} /> Add row
          </button>
          <button type="button" className="btn btn-text" disabled={!isTable} onClick={() => setNewColumn(true)} title="Add a column to this table">
            <Columns3 size={15} /> Add column
          </button>
          <button type="button" className="btn btn-text" disabled={!selected.size || !isTable} onClick={deleteSelected} title="Delete selected rows">
            <Trash2 size={15} /> Delete
          </button>
          <button type="button" className={cx('btn btn-text', sqlOpen && 'is-active')} onClick={() => setSqlOpen((v) => !v)} title="SQL">
            <Play size={15} /> SQL
          </button>
          <span className="spacer" />
          {page && !sqlResult && (
            <div className="db-pager">
              <button type="button" className="btn btn-icon" disabled={!canPrev} aria-label="Previous page" onClick={() => activeObj && void loadPage(activeObj.name, activeObj.kind, Math.max(0, offset - PAGE_SIZE))}>
                <ChevronLeft size={16} />
              </button>
              <span className="db-meta">
                {total === 0 ? 'No rows' : `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`}
              </span>
              <button type="button" className="btn btn-icon" disabled={!canNext} aria-label="Next page" onClick={() => activeObj && void loadPage(activeObj.name, activeObj.kind, offset + PAGE_SIZE)}>
                <ChevronRight size={16} />
              </button>
            </div>
          )}
          {sqlResult && sqlResult.result.columns.length > 0 && (
            <div className="db-pager">
              <button type="button" className="btn btn-icon" disabled={sqlResult.offset <= 0} aria-label="Previous page" onClick={() => loadSqlPage(Math.max(0, sqlResult.offset - PAGE_SIZE))}>
                <ChevronLeft size={16} />
              </button>
              <span className="db-meta" title={sqlShown < sqlResult.result.total ? `Only the first ${sqlShown.toLocaleString()} rows of this result can be shown` : undefined}>
                {sqlResult.result.total === 0
                  ? 'No rows'
                  : `${(sqlResult.offset + 1).toLocaleString()}–${(sqlResult.offset + sqlResult.rows.length).toLocaleString()} of ${sqlResult.result.total.toLocaleString()}`}
              </span>
              <button type="button" className="btn btn-icon" disabled={sqlResult.offset + PAGE_SIZE >= sqlShown} aria-label="Next page" onClick={() => loadSqlPage(sqlResult.offset + PAGE_SIZE)}>
                <ChevronRight size={16} />
              </button>
            </div>
          )}
          {activeObj && !sqlResult && (
            <span className="db-meta" title={activeObj.columns.map((c) => `${c.name} ${c.type}`).join(', ')}>
              {activeObj.kind === 'view' ? <Database size={12} /> : <Table2 size={12} />} {activeObj.columns.length} columns
              {activeObj.kind === 'view' ? ' · read-only' : ''}
            </span>
          )}
        </div>

        <div className="db-grid-wrap" ref={gridRef}>
          <BusyPill label={busy.label} delayed />
          {sqlResult ? (
            <ResultGrid key={sqlResult.id} columns={sqlResult.result.columns} rows={sqlResult.rows} />
          ) : !activeObj ? (
            <div className="db-empty">
              <p>This database is empty. Make its first table to start adding rows.</p>
              <button type="button" className="btn btn-primary" onClick={() => setNewTable(true)}>
                <Plus size={15} /> New table
              </button>
            </div>
          ) : !page ? null : (
            <>
              <table className="db-grid" style={{ width: layout.totalWidth + (isTable ? CHECK_COL_PX : 0) }}>
                <ColumnSizes layout={layout} leading={isTable ? CHECK_COL_PX : 0} />
                <thead>
                  <tr>
                    {isTable && (
                      <th className="db-row-check">
                        <input
                          type="checkbox"
                          aria-label="Select all rows on this page"
                          checked={page.rowids.length > 0 && page.rowids.every((id) => selected.has(id))}
                          onChange={(e) => setSelected(e.target.checked ? new Set(page.rowids) : new Set())}
                        />
                      </th>
                    )}
                    <HeaderCells layout={layout} onAutoFit={autoFit} renderLabel={(col) => (metaOf(col) ? <span className="db-col-type">{typeLabel(col)}</span> : null)} />
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((row, ri) => {
                    const rowid = page.rowids[ri];
                    return (
                      <tr key={rowid || ri} className={cx(selected.has(rowid) && 'is-selected')}>
                        {isTable && (
                          <td className="db-row-check">
                            <input
                              type="checkbox"
                              aria-label={`Select row ${rowid}`}
                              checked={selected.has(rowid)}
                              onChange={(e) => {
                                setSelected((cur) => {
                                  const next = new Set(cur);
                                  if (e.target.checked) next.add(rowid);
                                  else next.delete(rowid);
                                  return next;
                                });
                              }}
                            />
                          </td>
                        )}
                        {layout.order.map((col) => {
                          const cell = row[columnIndex.get(col) ?? -1] ?? null;
                          const isBlob = cell instanceof Uint8Array;
                          const readOnly = !isTable || isBlob;
                          return (
                            <td key={col}>
                              {readOnly ? (
                                <span className={cx('db-cell', isBlob && 'is-blob', cell === null && 'is-null')}>{cell === null ? 'NULL' : cellDisplay(cell)}</span>
                              ) : (
                                <input
                                  // the value is re-read after every edit: a new key shows it
                                  key={`${offset}:${cell === null ? '\u0000' : String(cell)}`}
                                  className={cx('db-cell', cell === null && 'is-null')}
                                  defaultValue={cell === null ? '' : String(cell)}
                                  placeholder="NULL"
                                  aria-label={`${col} row ${rowid}`}
                                  onBlur={(e) => onCellCommit(rowid, col, e.target.value, cell)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                  }}
                                />
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {page.rows.length === 0 && (
                <p className="db-empty">{activeObj.kind === 'view' ? 'This view returned no rows.' : 'This table is empty. Add a row, or insert data with SQL.'}</p>
              )}
            </>
          )}
        </div>

        {sqlOpen && (
          <div className="db-sql">
            <textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              spellCheck={false}
              aria-label="SQL"
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void runSql();
                }
              }}
            />
            <div className="db-sql-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void runSql()}>
                Run SQL
              </button>
              <span className="db-meta">Ctrl+Enter to run · changes are kept when you save the file</span>
            </div>
          </div>
        )}
      </div>

      {newTable && <NewTableModal existing={objects.map((o) => o.name)} onClose={() => setNewTable(false)} onCreate={createTable} />}
      {newColumn && activeObj && (
        <NewColumnModal table={activeObj.name} existing={activeObj.columns.map((c) => c.name)} onClose={() => setNewColumn(false)} onCreate={addColumn} />
      )}
    </div>
  );
});

/** The rows a SQL statement returned: read-only, with the same column handling as tables. */
function ResultGrid({ columns, rows }: { columns: string[]; rows: DbCell[][] }) {
  // a query may return two columns with one name: keep them apart
  const names = useMemo(() => {
    const seen = new Map<string, number>();
    return columns.map((c) => {
      const n = (seen.get(c) ?? 0) + 1;
      seen.set(c, n);
      return n === 1 ? c : `${c} (${n})`;
    });
  }, [columns]);
  const wrap = useRef<HTMLTableElement>(null);
  const sampleOf = (column: string): string[] => {
    const i = names.indexOf(column);
    return i < 0 ? [] : rows.slice(0, 60).map((r) => cellDisplay(r[i]).slice(0, 60));
  };
  const layout = useColumnLayout('result', names, sampleOf);
  const index = useMemo(() => new Map(names.map((c, i) => [c, i])), [names]);
  const autoFit = (column: string) => {
    const i = index.get(column) ?? -1;
    if (i < 0) return;
    const font = gridFont(wrap.current?.querySelector('.db-cell') ?? wrap.current);
    // the longest values by length are the ones worth measuring
    const texts = rows.map((r) => (r[i] === null ? 'NULL' : cellDisplay(r[i])));
    texts.sort((a, b) => b.length - a.length);
    layout.setWidth(column, fitWidth(texts.slice(0, 30), font, textWidth(column, gridFont(wrap.current?.querySelector('th.db-col') ?? wrap.current))));
  };
  if (!columns.length) return <p className="db-empty">Statement ran. No result set.</p>;
  return (
    <table className="db-grid" ref={wrap} style={{ width: layout.totalWidth }}>
      <ColumnSizes layout={layout} />
      <thead>
        <tr>
          <HeaderCells layout={layout} onAutoFit={autoFit} />
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {layout.order.map((col) => {
              const cell = row[index.get(col) ?? -1] ?? null;
              return (
                <td key={col}>
                  <span className={cx('db-cell', cell === null && 'is-null', cell instanceof Uint8Array && 'is-blob')}>{cell === null ? 'NULL' : cellDisplay(cell)}</span>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NewTableModal({
  existing,
  onCreate,
  onClose,
}: {
  existing: string[];
  onCreate: (name: string, columns: { name: string; type: string }[], withId: boolean) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [columns, setColumns] = useState('name, notes');
  const [withId, setWithId] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const table = name.trim();
    if (!table) return setError('Give the table a name.');
    if (existing.some((n) => n.toLowerCase() === table.toLowerCase())) return setError(`There is already a table or view called "${table}".`);
    const cols = parseColumnList(columns);
    const all = [...(withId ? ['id'] : []), ...cols.map((c) => c.name.toLowerCase())];
    if (!all.length) return setError('A table needs at least one column.');
    if (new Set(all).size < all.length) return setError('Two columns have the same name.');
    onCreate(table, cols, withId);
  };
  return (
    <Modal
      title="New table"
      width={480}
      onClose={onClose}
      footer={
        <>
          {error && <span className="dialog-error" role="alert">{error}</span>}
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
          <button type="submit" form="db-new-table" className="btn btn-primary">Create table</button>
        </>
      }
    >
      <form id="db-new-table" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Field label="Table name">
          <input className="input" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} placeholder="customers" data-autofocus />
        </Field>
        <Field label="Columns" hint="Separate names with commas. A type can follow a name (TEXT, INTEGER, REAL, NUMERIC, BLOB): price REAL, in_stock INTEGER. Columns without a type hold text.">
          <textarea className="input" rows={3} value={columns} onChange={(e) => { setColumns(e.target.value); setError(null); }} spellCheck={false} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={withId} onChange={(e) => setWithId(e.target.checked)} /> Add an <strong>id</strong> column that numbers the rows (primary key)
        </label>
      </form>
    </Modal>
  );
}

function NewColumnModal({ table, existing, onCreate, onClose }: { table: string; existing: string[]; onCreate: (name: string, type: string) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('TEXT');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const column = name.trim();
    if (!column) return setError('Give the column a name.');
    if (existing.some((n) => n.toLowerCase() === column.toLowerCase())) return setError(`"${table}" already has a column called "${column}".`);
    onCreate(column, type);
  };
  return (
    <Modal
      title={`Add a column to ${table}`}
      width={440}
      onClose={onClose}
      footer={
        <>
          {error && <span className="dialog-error" role="alert">{error}</span>}
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
          <button type="submit" form="db-new-column" className="btn btn-primary">Add column</button>
        </>
      }
    >
      <form id="db-new-column" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="grid-2">
          <Field label="Column name">
            <input className="input" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} data-autofocus />
          </Field>
          <Field label="Type">
            <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
              {COLUMN_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
        </div>
        <p className="dialog-hint">The new column is added at the end of the table; existing rows have no value (NULL) in it.</p>
      </form>
    </Modal>
  );
}
