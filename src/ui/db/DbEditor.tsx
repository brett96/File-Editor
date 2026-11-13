/**
 * SQLite database editor: pick a table/view, browse rows, edit cells, add/delete rows,
 * and run SQL. The database lives in memory (sql.js); App.tsx saves via export().
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Database, Play, Plus, RefreshCw, Table2, Trash2 } from 'lucide-react';
import {
  cellDisplay,
  type DbCell,
  type DbObject,
  type DbPage,
  type SqliteDatabase,
} from '../../core/db/sqlite';
import { cx } from '../components';
import './db.css';

const PAGE_SIZE = 200;

export interface DbEditorHandle {
  /** Current database bytes (after edits). */
  export(): Uint8Array;
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

export const DbEditor = forwardRef<DbEditorHandle, Props>(function DbEditor({ db, onChange, onError }, ref) {
  const [objects, setObjects] = useState<DbObject[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [page, setPage] = useState<DbPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [sql, setSql] = useState('SELECT name, type FROM sqlite_master ORDER BY type, name;');
  const [sqlOpen, setSqlOpen] = useState(false);
  const [sqlResult, setSqlResult] = useState<{ columns: string[]; rows: DbCell[][] } | null>(null);
  const dbRef = useRef(db);
  dbRef.current = db;

  useImperativeHandle(ref, () => ({
    export: () => dbRef.current.export(),
  }));

  const refreshObjects = useCallback(() => {
    try {
      const list = db.listObjects();
      setObjects(list);
      setActive((cur) => (cur && list.some((o) => o.name === cur) ? cur : list[0]?.name ?? null));
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not read the database schema.');
    }
  }, [db, onError]);

  useEffect(() => {
    refreshObjects();
  }, [refreshObjects]);

  const activeObj = objects.find((o) => o.name === active) ?? null;

  const loadPage = useCallback(
    (name: string, kind: 'table' | 'view', off: number) => {
      try {
        const next = db.readPage(name, kind, PAGE_SIZE, off);
        setPage(next);
        setOffset(off);
        setSelected(new Set());
        setSqlResult(null);
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Could not read that table.');
      }
    },
    [db, onError],
  );

  useEffect(() => {
    if (!activeObj) {
      setPage(null);
      return;
    }
    loadPage(activeObj.name, activeObj.kind, 0);
  }, [activeObj?.name, activeObj?.kind, loadPage]);

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
      loadPage(activeObj.name, 'table', offset);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not update that cell.');
      loadPage(activeObj.name, 'table', offset);
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
      const lastPage = Math.max(0, Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE);
      loadPage(activeObj.name, 'table', lastPage);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not insert a row.');
    }
  };

  const deleteSelected = () => {
    if (!activeObj || activeObj.kind !== 'table' || !selected.size) return;
    try {
      db.deleteRows(activeObj.name, [...selected]);
      markChanged();
      loadPage(activeObj.name, 'table', offset);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not delete the selected rows.');
    }
  };

  const runSql = () => {
    try {
      const result = db.exec(sql);
      markChanged();
      refreshObjects();
      if (result) {
        setSqlResult(result);
        setPage(null);
      } else if (activeObj) {
        loadPage(activeObj.name, activeObj.kind, offset);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'SQL error.');
    }
  };

  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + (page?.rows.length ?? 0), total);
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  return (
    <div className="db-editor">
      <aside className="db-sidebar" aria-label="Tables">
        <div className="db-sidebar-head">Tables &amp; views</div>
        {objects.length === 0 ? (
          <p className="db-empty" style={{ padding: 16, fontSize: 13 }}>
            This database has no tables yet. Use SQL below to create one.
          </p>
        ) : (
          <ul className="db-object-list">
            {objects.map((o) => (
              <li key={o.name}>
                <button
                  type="button"
                  className={cx('db-object', active === o.name && !sqlResult && 'is-active')}
                  onClick={() => {
                    setSqlResult(null);
                    setActive(o.name);
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
          <button type="button" className="btn btn-text" onClick={() => activeObj && loadPage(activeObj.name, activeObj.kind, offset)} title="Refresh">
            <RefreshCw size={15} /> Refresh
          </button>
          <button type="button" className="btn btn-text" disabled={!activeObj || activeObj.kind !== 'table'} onClick={addRow} title="Insert row">
            <Plus size={15} /> Add row
          </button>
          <button type="button" className="btn btn-text" disabled={!selected.size || activeObj?.kind !== 'table'} onClick={deleteSelected} title="Delete selected rows">
            <Trash2 size={15} /> Delete
          </button>
          <button type="button" className={cx('btn btn-text', sqlOpen && 'is-active')} onClick={() => setSqlOpen((v) => !v)} title="SQL">
            <Play size={15} /> SQL
          </button>
          <span className="spacer" />
          {page && !sqlResult && (
            <div className="db-pager">
              <button type="button" className="btn btn-icon" disabled={!canPrev} aria-label="Previous page" onClick={() => activeObj && loadPage(activeObj.name, activeObj.kind, Math.max(0, offset - PAGE_SIZE))}>
                <ChevronLeft size={16} />
              </button>
              <span className="db-meta">
                {total === 0 ? 'No rows' : `${from}–${to} of ${total.toLocaleString()}`}
              </span>
              <button type="button" className="btn btn-icon" disabled={!canNext} aria-label="Next page" onClick={() => activeObj && loadPage(activeObj.name, activeObj.kind, offset + PAGE_SIZE)}>
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

        <div className="db-grid-wrap">
          {sqlResult ? (
            <ResultGrid columns={sqlResult.columns} rows={sqlResult.rows} />
          ) : !activeObj ? (
            <p className="db-empty">Open a SQLite database (.sqlite, .db, …) or create tables with SQL.</p>
          ) : !page || page.rows.length === 0 ? (
            <p className="db-empty">{activeObj.kind === 'view' ? 'This view returned no rows.' : 'This table is empty. Add a row, or insert data with SQL.'}</p>
          ) : (
            <table className="db-grid">
              <thead>
                <tr>
                  {activeObj.kind === 'table' && (
                    <th className="db-row-check">
                      <input
                        type="checkbox"
                        aria-label="Select all rows on this page"
                        checked={page.rowids.length > 0 && page.rowids.every((id) => selected.has(id))}
                        onChange={(e) => setSelected(e.target.checked ? new Set(page.rowids) : new Set())}
                      />
                    </th>
                  )}
                  {page.columns.map((col) => {
                    const meta = activeObj.columns.find((c) => c.name === col);
                    return (
                      <th key={col}>
                        {col}
                        {meta && <span className="db-col-type">{meta.type}{meta.pk ? ' · PK' : ''}</span>}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row, ri) => {
                  const rowid = page.rowids[ri];
                  return (
                    <tr key={rowid || ri} className={cx(selected.has(rowid) && 'is-selected')}>
                      {activeObj.kind === 'table' && (
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
                      {row.map((cell, ci) => {
                        const col = page.columns[ci];
                        const isBlob = cell instanceof Uint8Array;
                        const readOnly = activeObj.kind === 'view' || isBlob;
                        return (
                          <td key={col}>
                            {readOnly ? (
                              <span className={cx('db-cell', isBlob && 'is-blob', cell === null && 'is-null')}>{cell === null ? 'NULL' : cellDisplay(cell)}</span>
                            ) : (
                              <input
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
                  runSql();
                }
              }}
            />
            <div className="db-sql-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={runSql}>
                Run SQL
              </button>
              <span className="db-meta">Ctrl+Enter to run · changes are kept when you save the file</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

function ResultGrid({ columns, rows }: { columns: string[]; rows: DbCell[][] }) {
  if (!columns.length) return <p className="db-empty">Statement ran. No result set.</p>;
  return (
    <table className="db-grid">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j}>
                <span className={cx('db-cell', cell === null && 'is-null', cell instanceof Uint8Array && 'is-blob')}>{cell === null ? 'NULL' : cellDisplay(cell)}</span>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
