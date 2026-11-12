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
import { decodeText } from '../dom';
import { blankSheet, columnName, newId, type ICellData, type IWorkbookData } from './workbook';

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const DECIMAL_ONLY = /^-?0?\.\d+$/;

function cellFromText(text: string): ICellData | null {
  if (text === '') return null;
  const t = text.trim();
  if ((NUMBER.test(t) || DECIMAL_ONLY.test(t)) && t.length < 17) return { v: Number(t), t: 2 };
  // keep the text exactly, including leading zeros, "=…", "+1 555…"
  return { v: text, t: 1 };
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

/** A one-sheet workbook from rows of text (numbers become numbers; see cellFromText). */
export function rowsToWorkbook(rows: string[][], name: string): IWorkbookData {
  const sheet = blankSheet(name.replace(/\.[^.]+$/, '').replace(/[:\\/?*[\]]/g, '_').slice(0, 31) || 'Sheet1');
  const cellData: Record<number, Record<number, ICellData>> = {};
  const widths: number[] = [];
  let maxCols = 0;
  rows.forEach((row, r) => {
    maxCols = Math.max(maxCols, row.length);
    row.forEach((value, c) => {
      const cell = cellFromText(value);
      if (!cell) return;
      (cellData[r] ??= {})[c] = cell;
      const len = Math.min(60, Math.max(...value.split('\n').map((l) => l.length)));
      widths[c] = Math.max(widths[c] ?? 0, len);
    });
  });
  const columnData: Record<number, { w: number }> = {};
  widths.forEach((chars, c) => {
    // roughly 7 px per character, as Excel's default column width
    const w = Math.round(Math.min(320, Math.max(64, chars * 7.5 + 16)));
    if (w > 88) columnData[c] = { w };
  });
  Object.assign(sheet, {
    cellData,
    columnData,
    rowCount: Math.max(1000, rows.length + 100),
    columnCount: Math.max(26, maxCols + 5),
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
