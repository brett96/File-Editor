/**
 * View adjustments for phone-sized screens. Desktop spreadsheets often freeze a wide first
 * column (account names, labels): on a phone that pane can fill most of the screen and leave
 * a sliver for everything else. Before the workbook is shown, frozen columns/rows that would
 * take more than a share of the screen are unfrozen, and the zoom is lowered so a few columns
 * fit. These are view-only: when the workbook is saved, the file's own freeze and zoom are put
 * back (unless the person changed the freeze themselves).
 */
import { DEFAULT_COL_WIDTH_PX, DEFAULT_ROW_HEIGHT_PX, eachCell, type IWorkbookData, type SheetData } from '../../core/sheet/workbook';

type Freeze = NonNullable<SheetData['freeze']>;

interface SheetRestore {
  freeze?: { original: Freeze | undefined; shown: Freeze };
  zoom: number | undefined;
}

export type PhoneRestore = Map<string, SheetRestore>;

export const NO_FREEZE: Freeze = { xSplit: 0, ySplit: 0, startRow: -1, startColumn: -1 };

/** Phone: a touch screen whose narrow side is phone-sized. */
export function isPhoneScreen(): boolean {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return coarse && Math.min(window.innerWidth, window.innerHeight) < 600;
}

const ROW_HEADER_PX = 46;
const MIN_PHONE_ZOOM = 0.7;

function colWidth(sheet: SheetData, c: number): number {
  const col = sheet.columnData?.[c];
  if (col?.hd) return 0;
  return col?.w ?? sheet.defaultColumnWidth ?? DEFAULT_COL_WIDTH_PX;
}

function rowHeight(sheet: SheetData, r: number): number {
  const row = sheet.rowData?.[r];
  if (row?.hd) return 0;
  return row?.h ?? sheet.defaultRowHeight ?? DEFAULT_ROW_HEIGHT_PX;
}

/**
 * Adjusts `wb` in place for a grid area of `width` × `height` CSS px and returns what to put
 * back on save.
 */
export function fitForPhone(wb: IWorkbookData, width: number, height: number): { restore: PhoneRestore; unfroze: boolean } {
  const restore: PhoneRestore = new Map();
  const availW = Math.max(200, width - ROW_HEADER_PX);
  // the grid gets roughly the height left after the toolbar, formula bar and tabs
  const availH = Math.max(200, height - 190);
  let unfroze = false;
  for (const id of wb.sheetOrder) {
    const sheet = wb.sheets[id] as SheetData | undefined;
    if (!sheet) continue;
    const entry: SheetRestore = { zoom: sheet.zoomRatio };

    const f = sheet.freeze;
    if (f && (f.xSplit > 0 || f.ySplit > 0)) {
      let frozenW = 0;
      for (let c = 0; c < f.xSplit; c++) frozenW += colWidth(sheet, c);
      let frozenH = 0;
      for (let r = 0; r < f.ySplit; r++) frozenH += rowHeight(sheet, r);
      const keepCols = f.xSplit > 0 && frozenW * MIN_PHONE_ZOOM <= availW * 0.4;
      const keepRows = f.ySplit > 0 && frozenH * MIN_PHONE_ZOOM <= availH * 0.3;
      if ((f.xSplit > 0 && !keepCols) || (f.ySplit > 0 && !keepRows)) {
        const shown: Freeze =
          keepCols || keepRows
            ? { xSplit: keepCols ? f.xSplit : 0, ySplit: keepRows ? f.ySplit : 0, startColumn: keepCols ? f.startColumn : 0, startRow: keepRows ? f.startRow : 0 }
            : NO_FREEZE;
        entry.freeze = { original: f, shown };
        sheet.freeze = shown;
        unfroze = true;
      }
    }

    // Zoom so the first used column and the two after it fit, between 70 % and 100 %.
    let firstCol = Infinity;
    for (const [, c] of eachCell(sheet)) firstCol = Math.min(firstCol, c);
    if (!Number.isFinite(firstCol)) firstCol = 0;
    let span = 0;
    for (let c = firstCol; c < firstCol + 3; c++) span += colWidth(sheet, c);
    const base = sheet.zoomRatio && sheet.zoomRatio > 0 ? Math.min(1, sheet.zoomRatio) : 1;
    sheet.zoomRatio = Math.round(Math.max(MIN_PHONE_ZOOM, Math.min(base, availW / Math.max(1, span))) * 100) / 100;
    restore.set(id, entry);
  }
  return { restore, unfroze };
}

const sameFreeze = (a: Freeze | undefined, b: Freeze | undefined) =>
  (a?.xSplit ?? 0) === (b?.xSplit ?? 0) && (a?.ySplit ?? 0) === (b?.ySplit ?? 0);

/** Puts the file's own freeze and zoom back into a snapshot taken from the editor. */
export function restoreFromPhone(snap: IWorkbookData, restore: PhoneRestore | null): IWorkbookData {
  if (!restore) return snap;
  for (const [id, entry] of restore) {
    const sheet = snap.sheets[id];
    if (!sheet) continue;
    sheet.zoomRatio = entry.zoom;
    if (entry.freeze && sameFreeze(sheet.freeze, entry.freeze.shown)) {
      if (entry.freeze.original) sheet.freeze = entry.freeze.original;
      else delete sheet.freeze;
    }
  }
  return snap;
}
