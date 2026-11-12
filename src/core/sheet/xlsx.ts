/**
 * Excel (.xlsx / .xlsm / .xltx) ⇄ workbook snapshot, via ExcelJS.
 *
 * Kept: every sheet (order, names, hidden state, tab colour), values (numbers, text, booleans,
 * dates as serial numbers with their format, errors), formulas with their cached results,
 * fonts, fills, borders, alignment / wrap / rotation, number formats, merged cells, column
 * widths, row heights, hidden rows and columns, frozen panes, zoom and gridlines.
 *
 * Not kept (reported as warnings when a file uses them): charts, pictures, comments,
 * conditional formatting, data validation, pivot tables, defined names, rich text runs
 * inside a cell (the text is kept, its mixed formatting is not) and VBA macros (an .xlsm is
 * saved as a macro-free .xlsx).
 */
import type * as ExcelJSTypes from 'exceljs';
import { cssToArgb, excelColorToHex, parseThemeColors, type ExcelColor } from './colors';
import {
  DEFAULT_COL_WIDTH_PX,
  DEFAULT_ROW_HEIGHT_PX,
  MIN_COLS,
  MIN_ROWS,
  eachCell,
  excelWidthToPx,
  newId,
  ptToPx,
  pxToExcelWidth,
  pxToPt,
  resolveStyle,
  richTextOf,
  type ICellData,
  type IStyleData,
  type IWorkbookData,
  type SheetData,
} from './workbook';

type ExcelJSModule = typeof ExcelJSTypes;
let excelPromise: Promise<ExcelJSModule> | null = null;

/** Loads ExcelJS on first use (≈900 KB). */
export function loadExcelJS(): Promise<ExcelJSModule> {
  if (!excelPromise) {
    excelPromise = (async () => {
      // ExcelJS's bundled regenerator runtime assigns a global; without one already present it
      // falls back to Function(), which the app's Content-Security-Policy blocks.
      const g = globalThis as { regeneratorRuntime?: unknown };
      if (!('regeneratorRuntime' in g)) g.regeneratorRuntime = undefined;
      const mod = (await import('exceljs')) as unknown as { default?: ExcelJSModule } & ExcelJSModule;
      return mod.default ?? mod;
    })();
    excelPromise.catch(() => {
      excelPromise = null;
    });
  }
  return excelPromise;
}

// Univer enum values (numbers, so this module needs none of the editor runtime).
const H_ALIGN: Record<string, number> = { left: 1, center: 2, right: 3, justify: 4, distributed: 6, fill: 1, centerContinuous: 2 };
const H_ALIGN_OUT: Record<number, ExcelJSTypes.Alignment['horizontal']> = { 1: 'left', 2: 'center', 3: 'right', 4: 'justify', 5: 'justify', 6: 'distributed' };
const V_ALIGN: Record<string, number> = { top: 1, middle: 2, bottom: 3, justify: 2, distributed: 2 };
const V_ALIGN_OUT: Record<number, ExcelJSTypes.Alignment['vertical']> = { 1: 'top', 2: 'middle', 3: 'bottom' };
const BORDER_STYLES = ['', 'thin', 'hair', 'dotted', 'dashed', 'dashDot', 'dashDotDot', 'double', 'medium', 'mediumDashed', 'mediumDashDot', 'mediumDashDotDot', 'slantDashDot', 'thick'] as const;
const CELL_STRING = 1;
const CELL_NUMBER = 2;
const CELL_BOOLEAN = 3;
const WRAP = 3;
const BOOL = (b: boolean | undefined) => (b ? 1 : 0);

/** Excel serial date (days since 1899-12-30, or 1904-01-01) for a JS Date as ExcelJS returns it (UTC). */
function dateToSerial(d: Date, date1904: boolean): number {
  const serial = (d.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000;
  return Math.round((date1904 ? serial - 1462 : serial) * 1e10) / 1e10;
}

export interface ReadResult {
  workbook: IWorkbookData;
  /** Things in the file the editor can't show or keep, for a notice. */
  warnings: string[];
}

function styleFromExcel(cell: ExcelJSTypes.Cell, theme: string[]): IStyleData | null {
  const st: IStyleData = {};
  const f = cell.font;
  if (f) {
    if (f.name) st.ff = f.name;
    if (f.size) st.fs = f.size;
    if (f.bold) st.bl = 1;
    if (f.italic) st.it = 1;
    if (f.underline && f.underline !== 'none') st.ul = { s: 1 };
    if (f.strike) st.st = { s: 1 };
    const color = excelColorToHex(f.color as ExcelColor, theme);
    if (color && color !== '#000000') st.cl = { rgb: color };
    if (f.vertAlign === 'superscript') st.va = 3;
    else if (f.vertAlign === 'subscript') st.va = 2;
  }
  const fill = cell.fill as ExcelJSTypes.FillPattern | undefined;
  if (fill?.type === 'pattern' && fill.pattern && fill.pattern !== 'none') {
    const color = excelColorToHex((fill.fgColor ?? fill.bgColor) as ExcelColor, theme);
    if (color) st.bg = { rgb: color };
  }
  const a = cell.alignment;
  if (a) {
    if (a.horizontal && H_ALIGN[a.horizontal]) st.ht = H_ALIGN[a.horizontal] as IStyleData['ht'];
    if (a.vertical && V_ALIGN[a.vertical]) st.vt = V_ALIGN[a.vertical] as IStyleData['vt'];
    if (a.wrapText) st.tb = WRAP as IStyleData['tb'];
    if (a.textRotation === 'vertical') st.tr = { a: 0, v: 1 };
    else if (typeof a.textRotation === 'number' && a.textRotation) st.tr = { a: a.textRotation };
  }
  const b = cell.border;
  if (b) {
    const bd: NonNullable<IStyleData['bd']> = {};
    for (const [side, key] of [['top', 't'], ['bottom', 'b'], ['left', 'l'], ['right', 'r']] as const) {
      const e = b[side];
      if (!e?.style) continue;
      const idx = BORDER_STYLES.indexOf(e.style as (typeof BORDER_STYLES)[number]);
      if (idx > 0) bd[key] = { s: idx, cl: { rgb: excelColorToHex(e.color as ExcelColor, theme) ?? '#000000' } };
    }
    if (Object.keys(bd).length) st.bd = bd;
  }
  if (cell.numFmt && cell.numFmt !== 'General') st.n = { pattern: cell.numFmt };
  return Object.keys(st).length ? st : null;
}

/** Reads an .xlsx package (already decrypted). */
export async function readXlsx(bytes: Uint8Array, name = 'Workbook'): Promise<ReadResult> {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch (err) {
    throw new Error(`This Excel file could not be read (${err instanceof Error ? err.message : 'unknown error'}). It may be damaged or in an older format (.xls).`);
  }
  const themeXml = (wb as unknown as { _themes?: Record<string, string> })._themes?.theme1;
  const theme = parseThemeColors(themeXml);
  const date1904 = !!(wb.properties as { date1904?: boolean } | undefined)?.date1904;
  const styles: Record<string, IStyleData> = {};
  const styleIds = new Map<string, string>();
  const styleId = (s: IStyleData): string => {
    const key = JSON.stringify(s);
    let id = styleIds.get(key);
    if (!id) {
      id = `s${styleIds.size + 1}`;
      styleIds.set(key, id);
      styles[id] = s;
    }
    return id;
  };
  const warnings = new Set<string>();
  const sheets: Record<string, SheetData> = {};
  const order: string[] = [];

  wb.eachSheet((ws) => {
    const id = newId('sheet');
    const cellData: Record<number, Record<number, ICellData>> = {};
    let lastRow = 0;
    let lastCol = 0;
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const r = rowNumber - 1;
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const c = colNumber - 1;
        if (cell.type === ExcelJS.ValueType.Merge) return; // covered by its merge's top-left cell
        const out: ICellData = {};
        const v = cell.value as ExcelJSTypes.CellValue;
        if (v === null || v === undefined) {
          // style-only cell
        } else if (typeof v === 'number') {
          out.v = v;
          out.t = CELL_NUMBER;
        } else if (typeof v === 'string') {
          out.v = v;
          out.t = CELL_STRING;
        } else if (typeof v === 'boolean') {
          out.v = v ? 1 : 0;
          out.t = CELL_BOOLEAN;
        } else if (v instanceof Date) {
          out.v = dateToSerial(v, date1904);
          out.t = CELL_NUMBER;
        } else if ('richText' in v) {
          out.v = v.richText.map((t) => t.text).join('');
          out.t = CELL_STRING;
          if (v.richText.length > 1) warnings.add('Mixed formatting inside a cell (only the text is kept)');
        } else if ('hyperlink' in v) {
          const text = (v as ExcelJSTypes.CellHyperlinkValue).text;
          out.v = typeof text === 'string' ? text : String(v.hyperlink);
          out.t = CELL_STRING;
          out.custom = { hyperlink: v.hyperlink };
        } else if ('formula' in v || 'sharedFormula' in v) {
          const formula = cell.formula; // shared formulas come back translated for this cell
          if (formula) out.f = `=${formula}`;
          const res = (v as ExcelJSTypes.CellFormulaValue).result;
          if (typeof res === 'number') out.v = res;
          else if (typeof res === 'string') out.v = res;
          else if (typeof res === 'boolean') out.v = res ? 1 : 0;
          else if (res instanceof Date) out.v = dateToSerial(res, date1904);
          else if (res && typeof res === 'object' && 'error' in res) out.v = res.error;
          if ((v as { shareType?: string }).shareType === 'array') warnings.add('Array formulas (kept as ordinary formulas)');
        } else if ('error' in v) {
          out.v = (v as ExcelJSTypes.CellErrorValue).error;
          out.t = CELL_STRING;
        }
        const st = styleFromExcel(cell, theme);
        if (v instanceof Date && !st?.n) {
          out.s = styleId({ ...(st ?? {}), n: { pattern: 'yyyy-mm-dd' } });
        } else if (st) out.s = styleId(st);
        if (cell.note) warnings.add('Comments / notes');
        if (out.v === undefined && !out.f && !out.s) return;
        (cellData[r] ??= {})[c] = out;
        if (r > lastRow) lastRow = r;
        if (c > lastCol) lastCol = c;
      });
    });

    const defaultColWidth = ws.properties.defaultColWidth ? excelWidthToPx(ws.properties.defaultColWidth) : 64;
    const defaultRowHeight = ws.properties.defaultRowHeight ? ptToPx(ws.properties.defaultRowHeight) : 20;
    const columnData: Record<number, { w?: number; hd?: 0 | 1 }> = {};
    (ws.columns ?? []).forEach((col, i) => {
      if (!col) return;
      const entry: { w?: number; hd?: 0 | 1 } = {};
      if (col.width) entry.w = excelWidthToPx(col.width);
      if (col.hidden) entry.hd = 1;
      if (Object.keys(entry).length) columnData[i] = entry;
    });
    const rowData: Record<number, { h?: number; hd?: 0 | 1; ia?: 0 | 1 }> = {};
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const entry: { h?: number; hd?: 0 | 1; ia?: 0 | 1 } = {};
      if (row.height) {
        entry.h = ptToPx(row.height);
        entry.ia = 0;
      }
      if (row.hidden) entry.hd = 1;
      if (Object.keys(entry).length) rowData[rowNumber - 1] = entry;
    });

    const merges = Object.values((ws as unknown as { _merges: Record<string, { top: number; left: number; bottom: number; right: number }> })._merges ?? {}).map((m) => ({
      startRow: m.top - 1,
      startColumn: m.left - 1,
      endRow: m.bottom - 1,
      endColumn: m.right - 1,
    }));
    for (const m of merges) {
      lastRow = Math.max(lastRow, m.endRow);
      lastCol = Math.max(lastCol, m.endColumn);
    }

    const view = ws.views?.[0] as (Partial<ExcelJSTypes.WorksheetView> & { xSplit?: number; ySplit?: number }) | undefined;
    const frozen = view?.state === 'frozen' && ((view.xSplit ?? 0) > 0 || (view.ySplit ?? 0) > 0);
    const tab = excelColorToHex(ws.properties.tabColor as ExcelColor, theme);

    if (ws.getImages?.().length) warnings.add('Pictures');
    const extra = ws as unknown as { conditionalFormattings?: unknown[]; dataValidations?: { model?: Record<string, unknown> } };
    if (extra.conditionalFormattings?.length) warnings.add('Conditional formatting');
    if (extra.dataValidations?.model && Object.keys(extra.dataValidations.model).length) warnings.add('Data validation (drop-down lists)');

    sheets[id] = {
      id,
      name: ws.name,
      hidden: ws.state === 'veryHidden' ? 2 : ws.state === 'hidden' ? 1 : 0,
      ...(tab ? { tabColor: tab } : {}),
      rowCount: Math.min(1_048_576, Math.max(MIN_ROWS, lastRow + 100)),
      columnCount: Math.min(16_384, Math.max(MIN_COLS, lastCol + 10)),
      defaultColumnWidth: defaultColWidth,
      defaultRowHeight: defaultRowHeight,
      cellData,
      rowData,
      columnData,
      mergeData: merges,
      ...(frozen
        ? { freeze: { xSplit: view!.xSplit ?? 0, ySplit: view!.ySplit ?? 0, startColumn: view!.xSplit ?? 0, startRow: view!.ySplit ?? 0 } }
        : {}),
      zoomRatio: view?.zoomScale ? Math.min(4, Math.max(0.1, view.zoomScale / 100)) : 1,
      showGridlines: view?.showGridLines === false ? 0 : 1,
    };
    order.push(id);
  });

  const names = (wb as unknown as { definedNames?: { model?: unknown[] } }).definedNames?.model;
  if (Array.isArray(names) && names.length) warnings.add('Named ranges (formulas that use them may show errors)');
  if (!order.length) throw new Error('This workbook has no sheets.');

  return {
    workbook: {
      id: newId('workbook'),
      name,
      appVersion: '1.0.0',
      locale: 'enUS' as IWorkbookData['locale'],
      styles,
      sheetOrder: order,
      sheets,
    },
    warnings: [...warnings],
  };
}

function excelStyle(st: IStyleData): Partial<ExcelJSTypes.Style> {
  const out: Partial<ExcelJSTypes.Style> = {};
  const font: Partial<ExcelJSTypes.Font> = {};
  if (st.ff) font.name = st.ff;
  if (st.fs) font.size = st.fs;
  if (st.bl) font.bold = true;
  if (st.it) font.italic = true;
  if (st.ul?.s) font.underline = true;
  if (st.st?.s) font.strike = true;
  const color = cssToArgb(st.cl?.rgb ?? null);
  if (color) font.color = { argb: color };
  if (st.va === 3) font.vertAlign = 'superscript';
  else if (st.va === 2) font.vertAlign = 'subscript';
  if (Object.keys(font).length) out.font = font;
  const bg = cssToArgb(st.bg?.rgb ?? null);
  if (bg) out.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
  const al: Partial<ExcelJSTypes.Alignment> = {};
  if (st.ht && H_ALIGN_OUT[st.ht]) al.horizontal = H_ALIGN_OUT[st.ht];
  if (st.vt && V_ALIGN_OUT[st.vt]) al.vertical = V_ALIGN_OUT[st.vt];
  if (st.tb === WRAP) al.wrapText = true;
  if (st.tr?.v) al.textRotation = 'vertical';
  else if (st.tr?.a) al.textRotation = Math.max(-90, Math.min(90, st.tr.a));
  if (Object.keys(al).length) out.alignment = al;
  if (st.bd) {
    const border: Partial<ExcelJSTypes.Borders> = {};
    for (const [key, side] of [['t', 'top'], ['b', 'bottom'], ['l', 'left'], ['r', 'right']] as const) {
      const e = st.bd[key];
      if (!e || !e.s) continue;
      const style = BORDER_STYLES[e.s];
      if (!style) continue;
      border[side] = { style, color: { argb: cssToArgb(e.cl?.rgb ?? null) ?? 'FF000000' } };
    }
    if (Object.keys(border).length) out.border = border;
  }
  if (st.n?.pattern) out.numFmt = st.n.pattern;
  return out;
}

/** Writes the workbook as an .xlsx package (unencrypted). */
export async function writeXlsx(data: IWorkbookData): Promise<Uint8Array> {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'File Editor';
  wb.created = new Date();
  const used = new Set<string>();

  for (const sheetId of data.sheetOrder) {
    const sheet = data.sheets[sheetId];
    if (!sheet) continue;
    // Excel sheet names: ≤ 31 chars, unique, none of : \ / ? * [ ]
    let name = (sheet.name || 'Sheet').replace(/[:\\/?*[\]]/g, '_').slice(0, 31) || 'Sheet';
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${name.slice(0, 27)} (${i})`;
    used.add(name.toLowerCase());
    const freeze = sheet.freeze && (sheet.freeze.xSplit > 0 || sheet.freeze.ySplit > 0) ? sheet.freeze : null;
    const ws = wb.addWorksheet(name, {
      state: sheet.hidden === 2 ? 'veryHidden' : sheet.hidden === 1 ? 'hidden' : 'visible',
      properties: {
        defaultRowHeight: pxToPt(sheet.defaultRowHeight ?? DEFAULT_ROW_HEIGHT_PX),
        defaultColWidth: pxToExcelWidth(sheet.defaultColumnWidth ?? DEFAULT_COL_WIDTH_PX),
        ...(cssToArgb(sheet.tabColor ?? null) ? { tabColor: { argb: cssToArgb(sheet.tabColor ?? null)! } } : {}),
      } as Partial<ExcelJSTypes.WorksheetProperties>,
      views: [
        {
          ...(freeze ? { state: 'frozen' as const, xSplit: freeze.xSplit, ySplit: freeze.ySplit } : { state: 'normal' as const }),
          zoomScale: Math.round((sheet.zoomRatio ?? 1) * 100),
          showGridLines: sheet.showGridlines !== 0,
        },
      ],
    });

    for (const [c, col] of Object.entries(sheet.columnData ?? {})) {
      if (!col) continue;
      const column = ws.getColumn(Number(c) + 1);
      if (col.w && Math.abs(col.w - (sheet.defaultColumnWidth ?? DEFAULT_COL_WIDTH_PX)) > 0.5) column.width = pxToExcelWidth(col.w);
      if (col.hd) column.hidden = true;
    }
    for (const [r, row] of Object.entries(sheet.rowData ?? {})) {
      if (!row) continue;
      const xr = ws.getRow(Number(r) + 1);
      if (row.h && row.ia !== 1 && Math.abs(row.h - (sheet.defaultRowHeight ?? DEFAULT_ROW_HEIGHT_PX)) > 0.5) xr.height = pxToPt(row.h);
      if (row.hd) xr.hidden = true;
    }

    for (const [r, c, cell] of eachCell(sheet)) {
      const xc = ws.getCell(r + 1, c + 1);
      const text = richTextOf(cell);
      const v = text ?? cell.v;
      const link = (cell.custom as { hyperlink?: unknown } | undefined)?.hyperlink;
      if (cell.f) {
        const result = typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : undefined;
        xc.value = { formula: cell.f.replace(/^=/, ''), ...(result !== undefined ? { result } : {}) } as ExcelJSTypes.CellFormulaValue;
      } else if (v !== null && v !== undefined && v !== '') {
        let value: ExcelJSTypes.CellValue;
        if (cell.t === CELL_BOOLEAN) value = v === true || v === 1 || v === '1' || v === 'TRUE';
        else if (cell.t === CELL_NUMBER || (typeof v === 'number' && cell.t !== CELL_STRING && cell.t !== 4)) value = Number(v);
        else value = String(v);
        if (typeof link === 'string' && /^(https?:|mailto:)/i.test(link)) value = { text: String(v), hyperlink: link };
        xc.value = value;
      }
      const st = resolveStyle(data, cell.s);
      if (st) Object.assign(xc, excelStyle(st));
    }

    for (const m of sheet.mergeData ?? []) {
      if (m.endRow > m.startRow || m.endColumn > m.startColumn) {
        try {
          ws.mergeCells(m.startRow + 1, m.startColumn + 1, m.endRow + 1, m.endColumn + 1);
        } catch {
          /* overlapping merges are dropped */
        }
      }
    }
  }
  if (!wb.worksheets.length) wb.addWorksheet('Sheet1');
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
