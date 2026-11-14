/**
 * SQLite databases via sql.js (WebAssembly). The whole file is held in memory (sql.js adopts
 * the file's bytes as its in-memory file, so opening does not copy them); rows are read a
 * page at a time, so the size of a table doesn't matter to the grid. Files past
 * DB_MAX_BYTES are refused with a clear message.
 *
 * Works in the browser and in Electron. WASM is loaded from /sqljs/ (copied by
 * scripts/copy-runtime-assets.mjs), never from a CDN.
 */
import type { Database, SqlJsStatic, SqlValue } from 'sql.js';

export const DB_EXTENSIONS = ['sqlite', 'sqlite3', 'db', 'db3', 'sdb'] as const;
export type DbFormat = (typeof DB_EXTENSIONS)[number];

/** Ceiling: the whole database is held in memory, and saving needs a second copy of it. */
export const DB_MAX_BYTES = 2 * 1024 * 1024 * 1024 - 1;

/** What a file that is not SQLite appears to be, from its first bytes (for a useful message). */
export function describeNonSqlite(head: Uint8Array): string | null {
  const ascii = (off: number, n: number) => String.fromCharCode(...head.subarray(off, off + n));
  if (ascii(4, 15) === 'Standard Jet DB' || ascii(4, 15) === 'Standard ACE DB') return 'a Microsoft Access database';
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return 'a Windows compound file (such as Thumbs.db), not a database File Editor can open';
  if (ascii(0, 4) === 'PK\u0003\u0004') return 'a zip archive';
  if (ascii(0, 6) === '-- H2 ' || ascii(0, 16).startsWith('-- H2')) return 'an H2 database';
  if (ascii(0, 4) === 'T-DB') return 'a Realm database';
  return null;
}

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

/** What SqliteDatabase.query returns: one page of a statement's rows, and how many there are. */
export interface SqlResult {
  columns: string[];
  /** The first rows only: a page for a query, at most SQL_HELD_ROWS otherwise. */
  rows: DbCell[][];
  /** Every row the statement returned, including those not in `rows`. */
  total: number;
  /** A plain query: further pages come from queryPage(query, …). Null when `rows` is all there is to show. */
  query: string | null;
}

/** Rows kept from a statement that cannot be read again a page at a time (PRAGMA, RETURNING…). */
export const SQL_HELD_ROWS = 5000;

/** True when nothing but whitespace, semicolons and comments is left of a script. */
function isBlankSql(sql: string): boolean {
  return /^(?:\s|;|--[^\n]*(?:\n|$)|\/\*[\s\S]*?(?:\*\/|$))*$/.test(sql);
}

/** See SqliteDatabase.bulkInsert. */
export interface BulkInsert {
  /** Number of columns the table has now. */
  readonly width: number;
  addColumn(name: string): void;
  /** Missing trailing values are stored as NULL. */
  add(row: DbCell[]): void;
  commit(): void;
  rollback(): void;
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

/** sql.js is CommonJS: depending on the bundler its init function is the module or its default. */
async function importSqlJs(): Promise<(config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>> {
  const mod = (await import('sql.js')) as unknown as { default?: unknown };
  const candidates = [mod.default, (mod.default as { default?: unknown } | undefined)?.default, mod];
  const init = candidates.find((c) => typeof c === 'function');
  if (!init) throw new Error('The SQLite engine could not be loaded.');
  return init as (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>;
}

async function loadSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      const inBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
      const initSqlJs = await importSqlJs();
      if (inBrowser) {
        // Served from public/sqljs (see scripts/copy-runtime-assets.mjs) — never a CDN.
        // Vite resolves the browser export (sql-wasm-browser.js → sql-wasm-browser.wasm).
        return initSqlJs({ locateFile: (file) => sqljsAssetUrl(file) });
      }
      // Node / vitest: resolve the wasm next to the package.
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
      throw new Error(`This database is ${(bytes.byteLength / (1024 * 1024 * 1024)).toFixed(1)} GB. File Editor opens SQLite files up to 2 GB.`);
    }
    if (bytes && bytes.byteLength >= 15) {
      let magic = '';
      for (let i = 0; i < 15; i++) magic += String.fromCharCode(bytes[i]);
      if (magic !== SQLITE_MAGIC) {
        const kind = describeNonSqlite(bytes.subarray(0, 64));
        throw new Error(kind ? `This file is ${kind}, not a SQLite database.` : 'This file is not a SQLite or LiteDB database (it has neither header). Many apps use the .db extension for their own private formats.');
      }
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

  /**
   * The longest values of a column as text (blobs left out), longest first: what a column has
   * to be wide enough for. Reads the whole column, so it can take a moment on a large table.
   */
  longestValues(table: string, column: string, limit = 8): string[] {
    const col = quoteIdent(column);
    const rs = this.db.exec(
      `SELECT CAST(${col} AS TEXT) FROM ${quoteIdent(table)} WHERE ${col} IS NOT NULL AND typeof(${col}) != 'blob' ORDER BY length(CAST(${col} AS TEXT)) DESC LIMIT ${limit | 0}`,
    );
    return rs.length ? rs[0].values.map((r) => String(r[0] ?? '')) : [];
  }

  /**
   * Page of rows for a table/view. Tables include an internal rowid for edits. `knownTotal`
   * skips counting the rows again (counting a table of millions of rows takes a while, and
   * the number only changes when rows are added or deleted).
   */
  readPage(table: string, kind: 'table' | 'view', limit = 200, offset = 0, knownTotal?: number): DbPage {
    const total = knownTotal ?? Number(this.db.exec(`SELECT COUNT(*) FROM ${quoteIdent(table)}`)[0]?.values[0]?.[0] ?? 0);
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

  /** Every row of a table with its rowid, in rowid order (for converting the database to another format). */
  readAll(table: string): { columns: string[]; rowids: number[]; rows: DbCell[][] } {
    const columns = this.columnsOf(table).map((c) => c.name);
    const stmt = this.db.prepare(`SELECT rowid, * FROM ${quoteIdent(table)} ORDER BY rowid`);
    const rowids: number[] = [];
    const rows: DbCell[][] = [];
    try {
      while (stmt.step()) {
        const r = stmt.get();
        rowids.push(Number(r[0]));
        rows.push(r.slice(1).map(fromSql));
      }
    } finally {
      stmt.free();
    }
    return { columns, rowids, rows };
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

  /**
   * Creates a table and fills it (used to bring another database format's data in). Column
   * names are made unique ignoring case, as SQLite requires.
   */
  importTable(name: string, columns: { name: string; type: string }[], rows: DbCell[][]): void {
    const seen = new Set<string>();
    const names = columns.map((c, i) => {
      let n = c.name || `column${i + 1}`;
      for (let k = 2; seen.has(n.toLowerCase()); k++) n = `${c.name}_${k}`;
      seen.add(n.toLowerCase());
      return n;
    });
    const defs = columns.length ? names.map((n, i) => `${quoteIdent(n)} ${columns[i].type.replace(/[^A-Za-z ]/g, '')}`) : ['"value" TEXT'];
    this.db.run('BEGIN');
    try {
      this.db.run(`CREATE TABLE ${quoteIdent(name)} (${defs.join(', ')})`);
      if (columns.length && rows.length) {
        const stmt = this.db.prepare(`INSERT INTO ${quoteIdent(name)} VALUES (${names.map(() => '?').join(', ')})`);
        try {
          for (const row of rows) stmt.run(row.map(toSql));
        } finally {
          stmt.free();
        }
      }
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
  }

  /** Creates an empty table. Column types are SQLite type names (or empty for "any"). */
  createTable(name: string, columns: { name: string; type?: string; pk?: boolean }[]): void {
    const defs = columns.map((c) => `${quoteIdent(c.name)} ${(c.type ?? '').replace(/[^A-Za-z ]/g, '')}${c.pk ? ' PRIMARY KEY' : ''}`.trim());
    this.db.run(`CREATE TABLE ${quoteIdent(name)} (${defs.join(', ')})`);
  }

  addColumn(table: string, name: string, type = ''): void {
    this.db.run(`ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(name)} ${type.replace(/[^A-Za-z ]/g, '')}`.trim());
  }

  /**
   * Fills a new table a row at a time inside one transaction, for data that is too large to
   * build as an array first. Columns can be added while rows are coming in (a later row may
   * be wider than every row before it).
   */
  bulkInsert(table: string, columns: string[]): BulkInsert {
    const db = this.db;
    const names = [...columns];
    let stmt: ReturnType<Database['prepare']> | null = null;
    const prepare = () => {
      stmt?.free();
      stmt = db.prepare(`INSERT INTO ${quoteIdent(table)} VALUES (${names.map(() => '?').join(', ')})`);
    };
    db.run('BEGIN');
    try {
      db.run(`CREATE TABLE ${quoteIdent(table)} (${names.map(quoteIdent).join(', ')})`);
      prepare();
    } catch (err) {
      db.run('ROLLBACK');
      throw err;
    }
    let open = true;
    const end = (sql: string) => {
      if (!open) return;
      open = false;
      stmt?.free();
      stmt = null;
      db.run(sql);
    };
    return {
      get width() {
        return names.length;
      },
      addColumn(name: string) {
        db.run(`ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(name)}`);
        names.push(name);
        prepare();
      },
      add(row: DbCell[]) {
        const values: SqlValue[] = new Array(names.length);
        for (let i = 0; i < names.length; i++) values[i] = toSql(row[i] ?? null);
        stmt!.run(values);
      },
      commit: () => end('COMMIT'),
      rollback: () => end('ROLLBACK'),
    };
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

  /**
   * Runs arbitrary SQL for display, without ever building the whole result in memory (a query
   * over a large table returns hundreds of thousands of rows; turning them all into arrays
   * and grid cells freezes the app). The result is that of the last statement that returns
   * rows, or null if none does.
   *
   * When that statement is a plain query and the last one in the script, only its first
   * `limit` rows are read; the rest come from queryPage. Any other statement that returns
   * rows runs to the end (it may be writing, as INSERT … RETURNING does) but only its first
   * SQL_HELD_ROWS rows are kept.
   */
  query(sql: string, limit = 200): SqlResult | null {
    if (!sql.trim()) return null;
    let result: SqlResult | null = null;
    const it = this.db.iterateStatements(sql);
    for (const stmt of it) {
      const columns = stmt.getColumnNames();
      if (!columns.length) {
        stmt.step();
        continue;
      }
      if (isBlankSql(it.getRemainingSQL())) {
        const query = this.pageableQuery(stmt.getSQL());
        if (query) {
          const total = Number(this.db.exec(`SELECT COUNT(*) FROM (\n${query}\n)`)[0]?.values[0]?.[0] ?? 0);
          result = { columns, rows: this.queryPage(query, limit, 0), total, query };
          continue;
        }
      }
      const rows: DbCell[][] = [];
      let total = 0;
      while (stmt.step()) {
        if (total < SQL_HELD_ROWS) rows.push(stmt.get().map(fromSql));
        total++;
      }
      result = { columns, rows, total, query: null };
    }
    return result;
  }

  /** A page of a query that query() reported as readable a page at a time. */
  queryPage(query: string, limit = 200, offset = 0): DbCell[][] {
    const stmt = this.db.prepare(`SELECT * FROM (\n${query}\n) LIMIT ${limit | 0} OFFSET ${offset | 0}`);
    const rows: DbCell[][] = [];
    try {
      while (stmt.step()) rows.push(stmt.get().map(fromSql));
    } finally {
      stmt.free();
    }
    return rows;
  }

  /** The statement's text if it can be used as a subquery (so it only reads), else null. */
  private pageableQuery(statement: string): string | null {
    const query = statement.trim().replace(/[;\s]+$/, '');
    try {
      this.db.prepare(`SELECT * FROM (\n${query}\n) LIMIT 0`).free();
      return query;
    } catch {
      return null;
    }
  }

  export(): Uint8Array {
    return this.db.export();
  }

  close(): void {
    this.db.close();
  }
}
