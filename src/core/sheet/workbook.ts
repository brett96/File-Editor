/**
 * Spreadsheet model shared by the converters (xlsx.ts, csv.ts) and the spreadsheet editor.
 *
 * The in-memory workbook is Univer's snapshot format (IWorkbookData), so the editor can load
 * and save it without another translation step. This module only uses its types (erased at
 * build time), so the converters stay free of the editor runtime and run in tests.
 *
 * Units: column widths and row heights are CSS pixels; Excel stores widths in "characters"
 * (of the default font's digit width, 7 px for Calibri 11) and heights in points.
 */
import type { ICellData, IStyleData, IWorkbookData, IWorksheetData } from '@univerjs/core';

export type { ICellData, IStyleData, IWorkbookData, IWorksheetData };
export type SheetData = Partial<IWorksheetData> & { id: string; name: string };

export type SheetFormat = 'xlsx' | 'csv' | 'tsv';

export interface SheetFormatInfo {
  id: SheetFormat;
  label: string;
  ext: string;
  extensions: string[];
  mime: string;
  canProtect: boolean;
  note?: string;
}

export const SHEET_FORMATS: Record<SheetFormat, SheetFormatInfo> = {
  xlsx: {
    id: 'xlsx',
    label: 'Excel workbook',
    ext: 'xlsx',
    extensions: ['xlsx', 'xlsm', 'xltx'],
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    canProtect: true,
  },
  csv: {
    id: 'csv',
    label: 'CSV (comma-separated)',
    ext: 'csv',
    extensions: ['csv'],
    mime: 'text/csv',
    canProtect: false,
    note: 'CSV keeps one sheet\'s values as they are shown. Formulas, formatting and other sheets are not saved.',
  },
  tsv: {
    id: 'tsv',
    label: 'TSV (tab-separated)',
    ext: 'tsv',
    extensions: ['tsv', 'tab'],
    mime: 'text/tab-separated-values',
    canProtect: false,
    note: 'TSV keeps one sheet\'s values as they are shown. Formulas, formatting and other sheets are not saved.',
  },
};

export const SHEET_FORMAT_ORDER: SheetFormat[] = ['xlsx', 'csv', 'tsv'];
export const SHEET_EXTENSIONS: string[] = SHEET_FORMAT_ORDER.flatMap((f) => SHEET_FORMATS[f].extensions);

export function sheetFormatFromName(name: string): SheetFormat | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  return SHEET_FORMAT_ORDER.find((f) => SHEET_FORMATS[f].extensions.includes(ext)) ?? null;
}

/** Univer's defaults, also used when a file doesn't say. */
export const DEFAULT_COL_WIDTH_PX = 88;
export const DEFAULT_ROW_HEIGHT_PX = 24;
export const MIN_ROWS = 1000;
export const MIN_COLS = 26;

/** Excel column width (characters) ↔ pixels, for the default Calibri 11 font. */
export const excelWidthToPx = (chars: number): number => Math.round(chars * 7 + 5);
export const pxToExcelWidth = (px: number): number => Math.max(0, Math.round(((px - 5) / 7) * 100) / 100);
/** Points ↔ CSS pixels. */
export const ptToPx = (pt: number): number => Math.round((pt * 4) / 3);
export const pxToPt = (px: number): number => Math.round(px * 0.75 * 100) / 100;

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function blankSheet(name = 'Sheet1', id = newId('sheet')): SheetData {
  return {
    id,
    name,
    rowCount: MIN_ROWS,
    columnCount: MIN_COLS,
    defaultColumnWidth: DEFAULT_COL_WIDTH_PX,
    defaultRowHeight: DEFAULT_ROW_HEIGHT_PX,
    cellData: {},
    rowData: {},
    columnData: {},
    mergeData: [],
  };
}

export function blankWorkbook(name = 'Untitled'): IWorkbookData {
  const sheet = blankSheet();
  return {
    id: newId('workbook'),
    name,
    appVersion: '1.0.0',
    locale: 'enUS' as IWorkbookData['locale'],
    styles: {},
    sheetOrder: [sheet.id],
    sheets: { [sheet.id]: sheet },
  };
}

/** Column index (0-based) → "A", "Z", "AA"… */
export function columnName(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** The style object of a cell (resolving a style id against the workbook's style table). */
export function resolveStyle(wb: Pick<IWorkbookData, 'styles'>, s: ICellData['s']): IStyleData | null {
  if (!s) return null;
  if (typeof s === 'string') return (wb.styles?.[s] as IStyleData | undefined) ?? null;
  return s;
}

/** Plain text of a rich-text cell (Univer keeps those as a small document in `p`). */
export function richTextOf(cell: ICellData): string | null {
  const stream = cell.p?.body?.dataStream;
  if (typeof stream !== 'string') return null;
  return stream.replace(/\r\n$/, '').replace(/\r/g, '\n');
}

/** Iterate the cells of a sheet in row/column order. */
export function* eachCell(sheet: Partial<IWorksheetData>): Generator<[number, number, ICellData]> {
  const rows = Object.keys(sheet.cellData ?? {}).map(Number).sort((a, b) => a - b);
  for (const r of rows) {
    const row = sheet.cellData![r] ?? {};
    const cols = Object.keys(row).map(Number).sort((a, b) => a - b);
    for (const c of cols) {
      const cell = row[c];
      if (cell) yield [r, c, cell];
    }
  }
}

/** Last used row and column (0-based) holding a value or formula, or -1 when empty. */
export function usedRange(sheet: Partial<IWorksheetData>): { lastRow: number; lastCol: number } {
  let lastRow = -1;
  let lastCol = -1;
  for (const [r, c, cell] of eachCell(sheet)) {
    const has = (cell.v !== undefined && cell.v !== null && cell.v !== '') || !!cell.f || !!richTextOf(cell);
    if (!has) continue;
    if (r > lastRow) lastRow = r;
    if (c > lastCol) lastCol = c;
  }
  return { lastRow, lastCol };
}
