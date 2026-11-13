/**
 * Rows → database tables, a row at a time.
 *
 * Used to open spreadsheets that are too large for the grid: the reader hands over each row
 * as it is read (see RowSink in sheet/xlsx-stream.ts) and it goes straight into a SQLite
 * table, so the workbook is never held as JavaScript objects.
 *
 * The first rows of a sheet are looked at before its table is made, to decide whether the
 * first row holds the column names (a full row of distinct text on top of more rows) and how
 * many columns there are. A later row that is wider than the table adds columns to it.
 */
import { columnName } from '../sheet/workbook';
import type { RowSink, RowValue } from '../sheet/xlsx-stream';
import type { BulkInsert, SqliteDatabase } from './sqlite';

const LOOKAHEAD_ROWS = 50;

export interface ImportedTable {
  name: string;
  columns: number;
  rows: number;
  /** Whether the sheet's first row became the column names. */
  header: boolean;
}

function uniqueNames(raw: string[], taken = new Set<string>()): string[] {
  return raw.map((value, i) => {
    const base = value.replace(/\s+/g, ' ').trim().slice(0, 120) || columnName(i);
    let name = base;
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${base}_${k}`;
    taken.add(name.toLowerCase());
    return name;
  });
}

/** True when `row` reads as headings: every column named, all text, no repeats. */
export function looksLikeHeader(row: RowValue[], width: number): boolean {
  if (row.length < width) return false;
  const seen = new Set<string>();
  for (let i = 0; i < width; i++) {
    const v = row[i];
    if (typeof v !== 'string' || !v.trim()) return false;
    const key = v.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/** A RowSink that makes one table per sheet in `db`. `tables` lists what was made. */
export function tableSink(db: SqliteDatabase): RowSink & { tables: ImportedTable[]; /** Undoes the sheet being read (it is about to be read again). */ abort(): void } {
  const tables: ImportedTable[] = [];
  const usedTables = new Set<string>();
  let sheet = '';
  let pending: RowValue[][] = [];
  let writer: BulkInsert | null = null;
  let columnNames = new Set<string>();
  let current: ImportedTable | null = null;

  const open = () => {
    let width = 0;
    for (const r of pending) width = Math.max(width, r.length);
    if (!width) return;
    const header = pending.length > 1 && looksLikeHeader(pending[0], width);
    const base = sheet.trim() || 'Sheet';
    let name = base;
    for (let k = 2; usedTables.has(name.toLowerCase()); k++) name = `${base}_${k}`;
    usedTables.add(name.toLowerCase());
    columnNames = new Set<string>();
    const names = uniqueNames(
      Array.from({ length: width }, (_, i) => (header ? String(pending[0][i]) : '')),
      columnNames,
    );
    writer = db.bulkInsert(name, names);
    current = { name, columns: width, rows: 0, header };
    const rows = header ? pending.slice(1) : pending;
    pending = [];
    for (const r of rows) write(r);
  };

  const write = (row: RowValue[]) => {
    const w = writer!;
    while (row.length > w.width) {
      w.addColumn(nextLetter(w.width));
      current!.columns = w.width;
    }
    w.add(row);
    current!.rows++;
  };

  /** The column letter for a column added later, kept clear of the names already used. */
  const nextLetter = (index: number): string => {
    const base = columnName(index);
    let name = base;
    for (let k = 2; columnNames.has(name.toLowerCase()); k++) name = `${base}_${k}`;
    columnNames.add(name.toLowerCase());
    return name;
  };

  return {
    tables,
    abort() {
      (writer as BulkInsert | null)?.rollback();
      if (current) usedTables.delete((current as ImportedTable).name.toLowerCase());
      writer = null;
      current = null;
      pending = [];
    },
    beginSheet(name) {
      sheet = name;
      pending = [];
      writer = null;
      current = null;
    },
    row(_index, values) {
      if (writer) return write(values);
      pending.push(values);
      if (pending.length >= LOOKAHEAD_ROWS) open();
    },
    endSheet() {
      try {
        if (!writer && pending.length) open();
        (writer as BulkInsert | null)?.commit();
        if (current) tables.push(current);
      } catch (err) {
        (writer as BulkInsert | null)?.rollback();
        throw err;
      } finally {
        writer = null;
        current = null;
        pending = [];
      }
    },
  };
}
