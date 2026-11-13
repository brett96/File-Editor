/**
 * Excel-style additions to the spreadsheet ribbon, registered through Univer's menu API:
 *
 *  - Insert:   rows / columns around the selection, a new sheet, today's date, the time
 *  - Formulas: AutoSum and its relatives (average, count, max, min) under the selection
 *  - Data:     sort A→Z / Z→A, remove duplicate rows, text to columns, trim spaces
 *  - View:     freeze panes at the selection, freeze top row / first column, unfreeze
 *
 * Every action goes through the workbook's normal commands, so undo/redo and "unsaved
 * changes" tracking treat them like edits made by hand.
 */
import type { FUniver } from '@univerjs/presets';
import { columnName } from '../../core/sheet/workbook';

type Notify = (message: string) => void;
type Workbook = NonNullable<ReturnType<FUniver['getActiveWorkbook']>>;
type Worksheet = ReturnType<Workbook['getActiveSheet']>;
type Range = NonNullable<ReturnType<Worksheet['getActiveRange']>>;
type CellValue = string | number | boolean | null | undefined;

/** Largest selection the row-by-row data tools will rewrite in one go. */
const MAX_TOOL_CELLS = 2_000_000;

/** Rows of `values` with later duplicates removed (cells compared as shown, case-sensitive). */
export function uniqueRows<T extends CellValue[]>(values: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of values) {
    const key = JSON.stringify(row.map((v) => (v === undefined || v === '' ? null : v)));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** The delimiter most of the non-empty values share (comma, tab, semicolon, pipe or space), or null. */
export function commonDelimiter(values: CellValue[]): string | null {
  const texts = values.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  if (!texts.length) return null;
  let best: string | null = null;
  let bestHits = 0;
  for (const d of ['\t', ',', ';', '|', ' ']) {
    const hits = texts.filter((t) => t.trim().includes(d)).length;
    if (hits > bestHits && hits >= Math.ceil(texts.length / 2)) {
      best = d;
      bestHits = hits;
    }
  }
  return best;
}

export function installSheetRibbon(api: FUniver, notify: Notify): void {
  const context = (): { ws: Worksheet; range: Range } | null => {
    const ws = api.getActiveWorkbook()?.getActiveSheet();
    const range = ws?.getActiveRange();
    return ws && range ? { ws, range } : null;
  };
  const guard = (fn: (ctx: { ws: Worksheet; range: Range }) => void) => () => {
    const ctx = context();
    if (!ctx) return notify('Click a cell in the sheet first.');
    try {
      fn(ctx);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'That could not be done here.');
    }
  };
  /** The selection, or the whole used area when only one cell is selected. */
  const dataRange = ({ ws, range }: { ws: Worksheet; range: Range }): Range | null => {
    if (range.getWidth() > 1 || range.getHeight() > 1) return range;
    const lastRow = ws.getLastRow();
    const lastCol = ws.getLastColumn();
    if (lastRow < 0 || lastCol < 0) return null;
    return ws.getRange(0, 0, lastRow + 1, lastCol + 1) as Range;
  };
  const tooBig = (range: Range): boolean => {
    if (range.getWidth() * range.getHeight() <= MAX_TOOL_CELLS) return false;
    notify('That selection is too large for this tool. Select a smaller range.');
    return true;
  };
  const hasFormulas = (range: Range): boolean => range.getFormulas().some((row) => row.some((f) => !!f));

  let order = 0;
  const item = (path: string, id: string, title: string, tooltip: string, action: () => void) =>
    api.createMenu({ id: `fe.${id}`, title, tooltip, action, order: order++ }).appendTo(path);

  // ── Insert ──
  item('ribbon.insert.cell', 'insert-row-above', 'Row above', 'Insert a row above the selection', guard(({ ws, range }) => void ws.insertRowBefore(range.getRow())));
  item('ribbon.insert.cell', 'insert-row-below', 'Row below', 'Insert a row below the selection', guard(({ ws, range }) => void ws.insertRowAfter(range.getLastRow())));
  item('ribbon.insert.cell', 'insert-col-left', 'Column left', 'Insert a column to the left of the selection', guard(({ ws, range }) => void ws.insertColumnBefore(range.getColumn())));
  item('ribbon.insert.cell', 'insert-col-right', 'Column right', 'Insert a column to the right of the selection', guard(({ ws, range }) => void ws.insertColumnAfter(range.getLastColumn())));
  item('ribbon.insert.others', 'insert-sheet', 'New sheet', 'Add a sheet to the workbook', () => void api.getActiveWorkbook()?.insertSheet());
  const stamp = (text: () => string) =>
    guard(({ ws, range }) => void ws.getRange(range.getRow(), range.getColumn()).setValue(text()));
  const pad = (n: number) => String(n).padStart(2, '0');
  item('ribbon.insert.edit', 'insert-date', "Today's date", "Put today's date in the active cell", stamp(() => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }));
  item('ribbon.insert.edit', 'insert-time', 'Current time', 'Put the current time in the active cell', stamp(() => {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }));

  // ── Formulas ──
  const aggregate = (fn: string) =>
    guard(({ ws, range }) => {
      const top = range.getRow();
      const bottom = range.getLastRow();
      const single = range.getWidth() === 1 && range.getHeight() === 1;
      if (single) {
        // Excel's AutoSum on one cell: total the run of numbers directly above it
        const col = range.getColumn();
        let start = top;
        while (start > 0 && typeof ws.getRange(start - 1, col).getValue() === 'number') start--;
        if (start === top) return notify(`Select the numbers to ${fn === 'SUM' ? 'total' : 'summarise'}, or the empty cell just below them.`);
        ws.getRange(top, col).setFormula(`=${fn}(${columnName(col)}${start + 1}:${columnName(col)}${top})`);
        return;
      }
      for (let c = range.getColumn(); c <= range.getLastColumn(); c++) {
        ws.getRange(bottom + 1, c).setFormula(`=${fn}(${columnName(c)}${top + 1}:${columnName(c)}${bottom + 1})`);
      }
    });
  // AutoSum leads the tab; the rest sit after the function library
  api.createMenu({ id: 'fe.autosum', title: 'AutoSum', tooltip: 'Total the selected numbers in the row below them', action: aggregate('SUM'), order: -1 }).appendTo('ribbon.formulas.basic');
  item('ribbon.formulas.others', 'autoavg', 'Average', 'Average of the selected numbers, in the row below them', aggregate('AVERAGE'));
  item('ribbon.formulas.others', 'autocount', 'Count', 'How many of the selected cells hold numbers, in the row below them', aggregate('COUNT'));
  item('ribbon.formulas.others', 'automax', 'Max', 'Largest of the selected numbers, in the row below them', aggregate('MAX'));
  item('ribbon.formulas.others', 'automin', 'Min', 'Smallest of the selected numbers, in the row below them', aggregate('MIN'));

  // ── Data ──
  const sort = (ascending: boolean) =>
    guard((ctx) => {
      let range = dataRange(ctx);
      if (!range) return notify('There is nothing to sort yet.');
      const whole = range !== ctx.range;
      if (whole && range.getHeight() > 1) {
        // like Excel, leave a heading row (all text) where it is
        const first = (ctx.ws.getRange(range.getRow(), range.getColumn(), 1, range.getWidth()).getValues() as CellValue[][])[0] ?? [];
        const filled = first.filter((v) => v !== null && v !== undefined && v !== '');
        if (filled.length && filled.every((v) => typeof v === 'string')) {
          range = ctx.ws.getRange(range.getRow() + 1, range.getColumn(), range.getHeight() - 1, range.getWidth()) as Range;
        }
      }
      // … and total rows (formulas) at the bottom, which sorting would scramble
      for (let guardRows = 0; whole && range.getHeight() > 1 && guardRows < 20; guardRows++) {
        const last = ctx.ws.getRange(range.getLastRow(), range.getColumn(), 1, range.getWidth()).getFormulas()[0] ?? [];
        if (!last.some((f) => !!f)) break;
        range = ctx.ws.getRange(range.getRow(), range.getColumn(), range.getHeight() - 1, range.getWidth()) as Range;
      }
      // sort by the column the active cell is in
      const column = Math.max(0, Math.min(range.getWidth() - 1, ctx.range.getColumn() - range.getColumn()));
      (range as Range & { sort(spec: { column: number; ascending: boolean }): unknown }).sort({ column, ascending });
    });
  item('ribbon.data.organization', 'sort-asc', 'Sort A→Z', "Sort the selection (or the whole sheet under its heading row) by the active cell's column, smallest first", sort(true));
  item('ribbon.data.organization', 'sort-desc', 'Sort Z→A', "Sort the selection (or the whole sheet under its heading row) by the active cell's column, largest first", sort(false));
  item('ribbon.data.rules', 'remove-duplicates', 'Remove duplicates', 'Delete rows of the selection (or the whole sheet) that repeat an earlier row', guard((ctx) => {
    const range = dataRange(ctx);
    if (!range) return notify('There is nothing to check yet.');
    if (tooBig(range)) return;
    if (hasFormulas(range)) return notify('Remove duplicates works on values. This range contains formulas; copy it and paste as values first.');
    const values = range.getValues() as CellValue[][];
    const unique = uniqueRows(values);
    const removed = values.length - unique.length;
    if (!removed) return notify('No duplicate rows found.');
    const blank = (): CellValue[] => new Array(range.getWidth()).fill('');
    range.setValues([...unique, ...Array.from({ length: removed }, blank)] as never);
    notify(`${removed.toLocaleString()} duplicate ${removed === 1 ? 'row' : 'rows'} removed; ${unique.length.toLocaleString()} unique ${unique.length === 1 ? 'row remains' : 'rows remain'}.`);
  }));
  item('ribbon.data.rules', 'text-to-columns', 'Text to columns', 'Split the selected column into columns at commas, tabs, semicolons, pipes or spaces', guard(({ ws, range }) => {
    if (range.getWidth() !== 1) return notify('Select the cells of one column to split.');
    if (tooBig(range)) return;
    const values = (range.getValues() as CellValue[][]).map((r) => r[0]);
    const delimiter = commonDelimiter(values);
    if (!delimiter) return notify('No comma, tab, semicolon, pipe or space was found to split at.');
    const parts = values.map((v) => (typeof v === 'string' ? v.split(delimiter).map((p) => p.trim()) : [v]));
    const width = Math.max(...parts.map((p) => p.length));
    const numeric = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
    const rows = parts.map((p) => Array.from({ length: width }, (_, i) => {
      const v = p[i];
      return typeof v === 'string' && numeric.test(v) && v.length < 16 ? Number(v) : v ?? '';
    }));
    ws.getRange(range.getRow(), range.getColumn(), rows.length, width).setValues(rows as never);
  }));
  item('ribbon.data.rules', 'trim-spaces', 'Trim spaces', 'Remove spaces at the start and end of the selected text, and doubled spaces inside it', guard((ctx) => {
    const range = dataRange(ctx);
    if (!range) return;
    if (tooBig(range)) return;
    const values = range.getValues() as CellValue[][];
    const formulas = range.getFormulas();
    let changed = 0;
    values.forEach((row, r) =>
      row.forEach((v, c) => {
        if (typeof v !== 'string' || formulas[r]?.[c]) return;
        const next = v.trim().replace(/ {2,}/g, ' ');
        if (next === v) return;
        ctx.ws.getRange(range.getRow() + r, range.getColumn() + c).setValue(next);
        changed++;
      }),
    );
    notify(changed ? `Trimmed ${changed.toLocaleString()} ${changed === 1 ? 'cell' : 'cells'}.` : 'No extra spaces found.');
  }));

  // ── View ▸ freeze panes ──
  item('ribbon.view.display', 'freeze-panes', 'Freeze panes', 'Keep the rows above and the columns left of the selected cell in view while scrolling', guard(({ ws, range }) => {
    const row = range.getRow();
    const col = range.getColumn();
    if (!row && !col) return notify('Select the first cell that should scroll (for example B2 to freeze row 1 and column A), then choose Freeze panes.');
    ws.setFreeze({ xSplit: col, ySplit: row, startRow: row || -1, startColumn: col || -1 });
  }));
  item('ribbon.view.display', 'freeze-top-row', 'Freeze top row', 'Keep row 1 in view while scrolling down', guard(({ ws }) => void ws.setFreeze({ xSplit: 0, ySplit: 1, startRow: 1, startColumn: -1 })));
  item('ribbon.view.display', 'freeze-first-col', 'Freeze first column', 'Keep column A in view while scrolling right', guard(({ ws }) => void ws.setFreeze({ xSplit: 1, ySplit: 0, startRow: -1, startColumn: 1 })));
  item('ribbon.view.display', 'unfreeze-panes', 'Unfreeze panes', 'Let every row and column scroll again', guard(({ ws }) => {
    const f = ws.getFreeze();
    if (!f || (f.xSplit <= 0 && f.ySplit <= 0)) return notify('Nothing is frozen on this sheet.');
    ws.cancelFreeze();
  }));
}
