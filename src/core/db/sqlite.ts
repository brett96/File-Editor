/**
 * SQLite databases via sql.js (WebAssembly). The whole file is held in memory — fine for
 * typical app databases; very large files are refused with a clear message.
 *
 * Works in the browser and in Electron. WASM is loaded from /sqljs/ (copied by
 * scripts/copy-runtime-assets.mjs), never from a CDN.
 */
import type { Database, SqlJsStatic, SqlValue } from 'sql.js';

export const DB_EXTENSIONS = ['sqlite', 'sqlite3', 'db', 'db3', 'sdb'] as const;
export type DbFormat = (typeof DB_EXTENSIONS)[number];

/** Soft ceiling: sql.js keeps the whole database in WASM memory. */
export const DB_MAX_BYTES = 100 * 1024 * 1024;

const SQLITE_MAGIC = 'SQLite format 3';

export type DbCell = string | number | null | Uint8Array;

export interface DbColumn {
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
  dflt: string | null;
}

export interface DbObject {
  name: string;
  kind: 'table' | 'view';
  columns: DbColumn[];
}

export interface DbPage {
  columns: string[];
  /** Parallel to rows: SQLite rowid for tables (0 for views). */
  rowids: number[];
  rows: DbCell[][];
  total: number;
}

export function dbFormatFromName(name: string): DbFormat | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return (DB_EXTENSIONS as readonly string[]).includes(ext) ? (ext as DbFormat) : null;
}

/** True when the bytes (or, if no bytes given, the extension) look like a SQLite database. */
export function isSqliteFile(name: string, head?: Uint8Array): boolean {
  if (head && head.length >= 15) {
    let magic = '';
    for (let i = 0; i < 15; i++) magic += String.fromCharCode(head[i]);
    return magic === SQLITE_MAGIC;
  }
  return dbFormatFromName(name) !== null;
}

let sqlPromise: Promise<SqlJsStatic> | null = null;

function sqljsAssetUrl(file: string): string {
  const base = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');
  return new URL(`${base}sqljs/${file}`, document.baseURI).href;
}

async function loadSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      const inBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
      if (inBrowser) {
        // Served from public/sqljs (see scripts/copy-runtime-assets.mjs) — never a CDN.
        // Vite resolves the browser export (sql-wasm-browser.js → sql-wasm-browser.wasm).
        const initSqlJs = (await import('sql.js')).default;
        return initSqlJs({ locateFile: (file) => sqljsAssetUrl(file) });
      }
      // Node / vitest: resolve the wasm next to the package.
      const initSqlJs = (await import('sql.js')).default;
      const { createRequire } = await import('node:module');
      const path = await import('node:path');
      const require = createRequire(import.meta.url);
      const dist = path.dirname(require.resolve('sql.js'));
      return initSqlJs({ locateFile: (file) => path.join(dist, file) });
    })().catch((err) => {
      sqlPromise = null;
      throw err;
    });
  }
  return sqlPromise;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function fromSql(v: SqlValue): DbCell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (v instanceof Uint8Array) return v;
  // sql.js may hand back a number[] for blobs in some builds
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return String(v);
}

function toSql(v: DbCell): SqlValue {
  if (v === null) return null;
  if (v instanceof Uint8Array) return v;
  return v;
}

/** Display helper for the grid (blobs become a short placeholder). */
export function cellDisplay(v: DbCell): string {
  if (v === null) return '';
  if (v instanceof Uint8Array) return `[BLOB ${v.byteLength} B]`;
  return String(v);
}

export class SqliteDatabase {
  private constructor(private db: Database) {}

  static async open(bytes?: Uint8Array): Promise<SqliteDatabase> {
    if (bytes && bytes.byteLength > DB_MAX_BYTES) {
      throw new Error(`This database is ${(bytes.byteLength / (1024 * 1024)).toFixed(0)} MB. File Editor opens SQLite files up to ${DB_MAX_BYTES / (1024 * 1024)} MB.`);
    }
    if (bytes && bytes.byteLength >= 15) {
      let magic = '';
      for (let i = 0; i < 15; i++) magic += String.fromCharCode(bytes[i]);
      if (magic !== SQLITE_MAGIC) throw new Error('This file is not a SQLite database (missing the SQLite header).');
    }
    const SQL = await loadSql();
    const db = bytes?.byteLength ? new SQL.Database(bytes) : new SQL.Database();
    return new SqliteDatabase(db);
  }

  /** Tables and views, with column metadata (views are read-only in the editor). */
  listObjects(): DbObject[] {
    const rs = this.db.exec(
      `SELECT name, type FROM sqlite_master
       WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
       ORDER BY type = 'view', name COLLATE NOCASE`,
    );
    if (!rs.length) return [];
    const out: DbObject[] = [];
    for (const row of rs[0].values) {
      const name = String(row[0]);
      const kind = row[1] === 'view' ? 'view' : 'table';
      out.push({ name, kind, columns: this.columnsOf(name) });
    }
    return out;
  }

  columnsOf(table: string): DbColumn[] {
    const stmt = this.db.prepare(`PRAGMA table_info(${quoteIdent(table)})`);
    const cols: DbColumn[] = [];
    while (stmt.step()) {
      const r = stmt.getAsObject() as { name: string; type: string; notnull: number; pk: number; dflt_value: string | null };
      cols.push({
        name: r.name,
        type: r.type || 'ANY',
        notnull: !!r.notnull,
        pk: !!r.pk,
        dflt: r.dflt_value == null ? null : String(r.dflt_value),
      });
    }
    stmt.free();
    return cols;
  }

  /** Page of rows for a table/view. Tables include an internal rowid for edits. */
  readPage(table: string, kind: 'table' | 'view', limit = 200, offset = 0): DbPage {
    const total = Number(this.db.exec(`SELECT COUNT(*) FROM ${quoteIdent(table)}`)[0]?.values[0]?.[0] ?? 0);
    if (kind === 'view') {
      const rs = this.db.exec(`SELECT * FROM ${quoteIdent(table)} LIMIT ${limit | 0} OFFSET ${offset | 0}`);
      if (!rs.length) return { columns: this.columnsOf(table).map((c) => c.name), rowids: [], rows: [], total };
      return {
        columns: rs[0].columns,
        rowids: rs[0].values.map(() => 0),
        rows: rs[0].values.map((r) => r.map(fromSql)),
        total,
      };
    }
    const rs = this.db.exec(`SELECT rowid AS __rowid__, * FROM ${quoteIdent(table)} LIMIT ${limit | 0} OFFSET ${offset | 0}`);
    if (!rs.length) {
      return { columns: this.columnsOf(table).map((c) => c.name), rowids: [], rows: [], total };
    }
    const columns = rs[0].columns.slice(1);
    const rowids: number[] = [];
    const rows: DbCell[][] = [];
    for (const r of rs[0].values) {
      rowids.push(Number(r[0]));
      rows.push(r.slice(1).map(fromSql));
    }
    return { columns, rowids, rows, total };
  }

  updateCell(table: string, rowid: number, column: string, value: DbCell): void {
    this.db.run(`UPDATE ${quoteIdent(table)} SET ${quoteIdent(column)} = ? WHERE rowid = ?`, [toSql(value), rowid]);
  }

  insertRow(table: string, values: Record<string, DbCell>): void {
    const cols = Object.keys(values);
    if (!cols.length) {
      this.db.run(`INSERT INTO ${quoteIdent(table)} DEFAULT VALUES`);
      return;
    }
    const placeholders = cols.map(() => '?').join(', ');
    this.db.run(
      `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')}) VALUES (${placeholders})`,
      cols.map((c) => toSql(values[c])),
    );
  }

  deleteRows(table: string, rowids: number[]): void {
    if (!rowids.length) return;
    const placeholders = rowids.map(() => '?').join(', ');
    this.db.run(`DELETE FROM ${quoteIdent(table)} WHERE rowid IN (${placeholders})`, rowids);
  }

  /** Runs arbitrary SQL. Returns a result set for the last SELECT-like statement, else null. */
  exec(sql: string): { columns: string[]; rows: DbCell[][] } | null {
    const trimmed = sql.trim();
    if (!trimmed) return null;
    const rs = this.db.exec(trimmed);
    if (!rs.length) return null;
    const last = rs[rs.length - 1];
    return { columns: last.columns, rows: last.values.map((r) => r.map(fromSql)) };
  }

  export(): Uint8Array {
    return this.db.export();
  }

  close(): void {
    this.db.close();
  }
}
