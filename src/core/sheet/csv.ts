/**
 * CSV / TSV ⇄ workbook snapshot.
 *
 * Reading: the text encoding is detected (UTF-8/16 BOM, else UTF-8, else Windows-1252) and the
 * delimiter guessed for .csv files (comma, semicolon as in European Excel, tab or pipe). Plain
 * numbers become numbers; anything with leading zeros ("00501"), a leading "+", thousands
 * separators or a currency symbol stays text, as do values starting with "=" (they are not run
 * as formulas, which also blocks CSV formula injection).
 *
 * Writing: one sheet, the values as shown (formatted numbers, formula results), UTF-8 with a
 * BOM so Excel reads accented characters correctly, and RFC 4180 quoting.
 */
import Papa from 'papaparse';
import { decodeText, decodeWindows1252 } from '../dom';
import { StringPool, WorkbookTooLargeError, sheetCellBudget } from '../memory';
import { blankSheet, columnName, newId, type ICellData, type IWorkbookData } from './workbook';
import type { RowSink, RowValue } from './xlsx-stream';

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const DECIMAL_ONLY = /^-?0?\.\d+$/;

/** The number a piece of text plainly is, or null (leading zeros, "+1 555…", "1,234" stay text). */
function plainNumber(text: string): number | null {
  if (text.length > 24) return null;
  const t = text.trim();
  return (NUMBER.test(t) || DECIMAL_ONLY.test(t)) && t.length < 17 ? Number(t) : null;
}

function cellFromText(text: string, pool?: StringPool): ICellData | null {
  if (text === '') return null;
  const n = plainNumber(text);
  if (n !== null) return { v: n, t: 2 };
  // keep the text exactly, including leading zeros, "=…", "+1 555…"
  return { v: pool ? pool.get(text) : text, t: 1 };
}

/**
 * The delimiter that splits the lines into the same number of columns (comma, semicolon as in
 * European Excel, tab or pipe), or null when none does (prose, code: one column).
 */
export function detectDelimiter(text: string): string | null {
  const sample = text.slice(0, 20_000).split(/\r?\n/).slice(0, 20).filter(Boolean);
  if (!sample.length) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const d of [',', ';', '\t', '|']) {
    const counts = sample.map((line) => Papa.parse<string[]>(line, { delimiter: d }).data[0]?.length ?? 1);
    const first = counts[0];
    if (first < 2) continue;
    const consistent = counts.filter((n) => n === first).length;
    // most lines must agree (a stray comma in a sentence doesn't make a CSV)
    if (consistent < Math.max(1, Math.ceil(sample.length * 0.8))) continue;
    const score = consistent * 1000 + first;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** Delimiter for a .csv file: the detected one, or a comma. */
export function guessDelimiter(text: string): string {
  return detectDelimiter(text) ?? ',';
}

/** Builds a one-sheet workbook a row at a time (numbers become numbers; see cellFromText). */
class SheetBuilder {
  private cellData: Record<number, Record<number, ICellData>> = {};
  private widths: number[] = [];
  private maxCols = 0;
  private rows = 0;
  /** Filled cells so far. */
  cells = 0;

  /** `pool`: keep one copy of repeated text, cut loose from the chunk it was parsed out of. */
  constructor(private pool?: StringPool) {}

  add(row: string[]): void {
    const r = this.rows++;
    if (row.length > this.maxCols) this.maxCols = row.length;
    let out: Record<number, ICellData> | null = null;
    for (let c = 0; c < row.length; c++) {
      const value = row[c];
      const cell = cellFromText(value, this.pool);
      if (!cell) continue;
      if (!out) out = this.cellData[r] = {};
      out[c] = cell;
      this.cells++;
      let len = value.length;
      if (len > (this.widths[c] ?? 0)) {
        if (value.indexOf('\n') >= 0) len = Math.max(...value.split('\n').map((l) => l.length));
        len = Math.min(60, len);
        if (len > (this.widths[c] ?? 0)) this.widths[c] = len;
      }
    }
  }

  finish(name: string): IWorkbookData {
    const sheet = blankSheet(name.replace(/\.[^.]+$/, '').replace(/[:\\/?*[\]]/g, '_').slice(0, 31) || 'Sheet1');
    const columnData: Record<number, { w: number }> = {};
    this.widths.forEach((chars, c) => {
      // roughly 7 px per character, as Excel's default column width
      const w = Math.round(Math.min(320, Math.max(64, chars * 7.5 + 16)));
      if (w > 88) columnData[c] = { w };
    });
    Object.assign(sheet, {
      cellData: this.cellData,
      columnData,
      rowCount: Math.max(1000, this.rows + 100),
      columnCount: Math.max(26, this.maxCols + 5),
      freeze: undefined,
    });
    return {
      id: newId('workbook'),
      name: name.replace(/\.[^.]+$/, ''),
      appVersion: '1.0.0',
      locale: 'enUS' as IWorkbookData['locale'],
      styles: {},
      sheetOrder: [sheet.id],
      sheets: { [sheet.id]: sheet },
    };
  }
}

/** A one-sheet workbook from rows of text (numbers become numbers; see cellFromText). */
export function rowsToWorkbook(rows: string[][], name: string): IWorkbookData {
  const builder = new SheetBuilder();
  for (const row of rows) builder.add(row);
  return builder.finish(name);
}

/** Splits delimited text into rows (a trailing newline doesn't add an empty row). */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: false }).data;
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

/** Parses CSV/TSV bytes into a one-sheet workbook. */
export function readDelimited(bytes: Uint8Array, name: string, delimiter?: string): IWorkbookData {
  const text = decodeText(bytes);
  return rowsToWorkbook(parseDelimited(text, delimiter ?? guessDelimiter(text)), name);
}

// ── large files: read from the file in pieces ────────────────────────────────
/** Files past this size are read in pieces instead of being decoded and parsed whole. */
export const STREAM_DELIMITED_BYTES = 8 * 1024 * 1024;
const PIECE_BYTES = 4 * 1024 * 1024;

class EncodingError extends Error {}

export interface DelimitedProgress {
  /** 0–1 through the file. */
  fraction: number;
  rows: number;
}

/**
 * The rows of a delimited file, in batches, reading and decoding about 4 MB at a time. A
 * piece is cut at the last line break that is not inside a quoted field, so every batch is
 * whole rows. Trailing empty lines are dropped, as when the file is read whole.
 */
async function* delimitedBatches(
  blob: Blob,
  delimiter: string | undefined,
  encoding: 'auto' | 'windows-1252',
  onProgress?: (p: DelimitedProgress) => void,
  pieceBytes = PIECE_BYTES,
): AsyncGenerator<string[][]> {
  const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  let skip = 0;
  let label = 'utf-8';
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) skip = 3;
  else if (head[0] === 0xff && head[1] === 0xfe) [label, skip] = ['utf-16le', 2];
  else if (head[0] === 0xfe && head[1] === 0xff) [label, skip] = ['utf-16be', 2];
  const legacy = encoding === 'windows-1252' && label === 'utf-8' && !skip;
  // a file with no byte-order mark is UTF-8 unless a byte says otherwise (then Windows-1252)
  const decoder = legacy ? null : new TextDecoder(label, { fatal: label === 'utf-8' && !skip });
  let delim = delimiter;
  let carry = '';
  let quotes = 0; // quote characters seen in `carry` so far (odd: inside a quoted field)
  let rows = 0;
  let emptyHeld = 0; // empty lines not yet passed on (they only count if a row follows)

  const parse = (text: string): string[][] => {
    const data = Papa.parse<string[]>(text, { delimiter: delim, skipEmptyLines: false }).data;
    const out: string[][] = [];
    for (const row of data) {
      if (row.length === 1 && row[0] === '') {
        emptyHeld++;
        continue;
      }
      for (; emptyHeld > 0; emptyHeld--) out.push(['']);
      out.push(row);
    }
    rows += out.length;
    return out;
  };

  for (let at = skip; at < blob.size; at += pieceBytes) {
    const bytes = new Uint8Array(await blob.slice(at, Math.min(blob.size, at + pieceBytes)).arrayBuffer());
    let text: string;
    try {
      text = decoder ? decoder.decode(bytes, { stream: true }) : decodeWindows1252(bytes);
    } catch {
      throw new EncodingError();
    }
    if (delim === undefined) delim = guessDelimiter(text);
    // the last line break outside quotes, counting on from where the carried text stopped
    let cut = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (ch === 34) quotes++;
      else if (ch === 10 && (quotes & 1) === 0) cut = i;
    }
    if (cut < 0) {
      carry += text;
      continue;
    }
    const whole = carry + text.slice(0, cut > 0 && text.charCodeAt(cut - 1) === 13 ? cut - 1 : cut);
    carry = text.slice(cut + 1);
    quotes = 0;
    for (let i = 0; i < carry.length; i++) if (carry.charCodeAt(i) === 34) quotes++;
    const batch = parse(whole);
    if (batch.length) yield batch;
    onProgress?.({ fraction: Math.min(0.999, (at + bytes.length) / blob.size), rows });
  }
  let tail: string;
  try {
    tail = carry + (decoder ? decoder.decode() : '');
  } catch {
    throw new EncodingError();
  }
  tail = tail.replace(/\r?\n$/, '');
  if (tail !== '') {
    if (delim === undefined) delim = guessDelimiter(tail);
    const batch = parse(tail);
    if (batch.length) yield batch;
  }
  onProgress?.({ fraction: 1, rows });
}

/** Runs `read` on the file as UTF-8 and, if a byte turns out not to be, again as Windows-1252. */
async function withEncoding<T>(read: (encoding: 'auto' | 'windows-1252') => Promise<T>): Promise<T> {
  try {
    return await read('auto');
  } catch (err) {
    if (!(err instanceof EncodingError)) throw err;
    return read('windows-1252');
  }
}

export interface DelimitedReadOptions {
  /** Stop with WorkbookTooLargeError past this many filled cells (default: what this device can hold). */
  maxCells?: number;
  onProgress?: (p: DelimitedProgress) => void;
  /** Bytes read at a time (tests use a small value to cross piece boundaries). */
  pieceBytes?: number;
}

/**
 * Parses a CSV/TSV file into a one-sheet workbook without holding the file, its text and its
 * rows all at once: only the piece being parsed and the cells so far are in memory. Stops with
 * WorkbookTooLargeError past `maxCells` filled cells.
 */
export function readDelimitedStream(blob: Blob, name: string, delimiter?: string, options: DelimitedReadOptions = {}): Promise<{ workbook: IWorkbookData; cells: number }> {
  const maxCells = options.maxCells ?? sheetCellBudget();
  return withEncoding(async (encoding) => {
    const builder = new SheetBuilder(new StringPool());
    for await (const batch of delimitedBatches(blob, delimiter, encoding, options.onProgress, options.pieceBytes)) {
      for (const row of batch) builder.add(row);
      if (builder.cells > maxCells) throw new WorkbookTooLargeError(maxCells);
    }
    return { workbook: builder.finish(name), cells: builder.cells };
  });
}

/**
 * Reads a CSV/TSV file a row at a time into `sink` (a database table), for files too large
 * for the grid. `reset` is called if the file has to be read again in another encoding.
 */
export function readDelimitedRows(
  blob: Blob,
  name: string,
  sink: RowSink,
  reset: () => void,
  delimiter?: string,
  options: Pick<DelimitedReadOptions, 'onProgress' | 'pieceBytes'> = {},
): Promise<void> {
  let first = true;
  return withEncoding(async (encoding) => {
    if (!first) reset();
    first = false;
    sink.beginSheet(name.replace(/\.[^.]+$/, '') || 'Sheet1');
    let index = 0;
    for await (const batch of delimitedBatches(blob, delimiter, encoding, options.onProgress, options.pieceBytes)) {
      for (const row of batch) {
        const values: RowValue[] = new Array(row.length);
        let any = false;
        for (let c = 0; c < row.length; c++) {
          const text = row[c];
          if (text === '') {
            values[c] = null;
            continue;
          }
          values[c] = plainNumber(text) ?? text;
          any = true;
        }
        if (any) sink.row(index, values);
        index++;
      }
    }
    await sink.endSheet();
  });
}

/**
 * A workbook from plain text: split into columns when the text is consistently delimited
 * (tabs, commas…), otherwise one line per row in column A.
 */
export function textToWorkbook(text: string, name: string, split = true): IWorkbookData {
  const delim = split ? detectDelimiter(text) : null;
  const rows = delim ? parseDelimited(text, delim) : text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').map((l) => [l]);
  return rowsToWorkbook(rows.length === 1 && rows[0].length === 1 && rows[0][0] === '' ? [] : rows, name);
}

/** Serializes rows of display text as CSV (comma) or TSV (tab). */
export function writeDelimited(rows: string[][], delimiter: ',' | '\t'): Uint8Array {
  // drop trailing empty cells / rows
  const trimmed = rows.map((row) => {
    let end = row.length;
    while (end > 0 && (row[end - 1] ?? '') === '') end--;
    return row.slice(0, end);
  });
  while (trimmed.length && trimmed[trimmed.length - 1].length === 0) trimmed.pop();
  const width = Math.max(0, ...trimmed.map((r) => r.length));
  const padded = trimmed.map((r) => [...r, ...Array(width - r.length).fill('')]);
  const text = Papa.unparse(padded, { delimiter, newline: '\r\n', quotes: false, escapeFormulae: false });
  return new TextEncoder().encode(`﻿${text}${padded.length ? '\r\n' : ''}`);
}

/**
 * Rows of text for one sheet straight from the snapshot (raw values, not formatted). The editor
 * uses its formatted display values instead; this is the fallback and what tests use.
 */
export function sheetToRows(wb: IWorkbookData, sheetId = wb.sheetOrder[0]): string[][] {
  const sheet = wb.sheets[sheetId];
  const rows: string[][] = [];
  for (const [r, row] of Object.entries(sheet?.cellData ?? {})) {
    for (const [c, cell] of Object.entries((row ?? {}) as Record<string, ICellData>)) {
      if (!cell || cell.v === null || cell.v === undefined) continue;
      const out = (rows[Number(r)] ??= []);
      out[Number(c)] = cell.t === 3 ? (cell.v ? 'TRUE' : 'FALSE') : String(cell.v);
    }
  }
  return Array.from(rows, (r) => Array.from(r ?? [], (v) => v ?? ''));
}

export { columnName };
