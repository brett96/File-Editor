/**
 * Spreadsheet → database: every sheet that holds data becomes a table.
 *
 * The first step is a plan per sheet: where the data is, which row (if any) names the
 * columns, and whether that guess is safe. A heading row is "clear" when it is a full row of
 * distinct labels sitting on top of data that looks different from it (numbers under text, or
 * bold on top of plain). Anything else is left for the person to decide: they pick the row,
 * say there is none, or type the column names themselves.
 */
import { columnName, resolveStyle, richTextOf, type ICellData, type IWorkbookData, type SheetData } from './workbook';

export type TableCell = string | number | null;

export interface SheetTablePlan {
  sheetId: string;
  sheetName: string;
  tableName: string;
  /** Used area (0-based, inclusive). */
  firstRow: number;
  lastRow: number;
  firstCol: number;
  lastCol: number;
  /** Row that holds the column names (0-based, absolute), or null when the sheet has none. */
  headerRow: number | null;
  /** One name per column of the used area. */
  columns: string[];
  /** False when the heading row is a guess the person should confirm. */
  confident: boolean;
  /** Why the guess is not safe (shown in the prompt). */
  reason?: string;
  /** The first rows of the used area as text, for the prompt. */
  preview: string[][];
}

const PREVIEW_ROWS = 6;
const DATE_FORMAT = /(^|[^\\"a-z])(y{2,4}|d{1,4}|m{1,5}|h{1,2}|s{1,2}|am\/pm)/i;

function hasValue(cell: ICellData | undefined | null): boolean {
  if (!cell) return false;
  if (cell.p && richTextOf(cell)) return true;
  return cell.v !== undefined && cell.v !== null && cell.v !== '';
}

/** True for number formats that show a date or time (and not just a number with text). */
export function isDateFormat(pattern: string | undefined | null): boolean {
  if (!pattern || pattern === 'General' || pattern === '@') return false;
  const bare = pattern.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  if (/[0#?]/.test(bare) && !/[ydhs]/i.test(bare)) return false;
  return DATE_FORMAT.test(bare);
}

/** Excel serial → ISO 8601 text ("2026-01-15", "2026-01-15 13:30:00" or "13:30:00"). */
export function serialToIso(serial: number): string {
  const ms = Math.round(serial * 86_400_000);
  const d = new Date(Date.UTC(1899, 11, 30) + ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 19);
  if (serial >= 0 && serial < 1) return time;
  return time === '00:00:00' ? date : `${date} ${time}`;
}

/** A cell as a database value: numbers stay numbers, dates become ISO text, TRUE/FALSE become 1/0. */
export function cellToValue(wb: Pick<IWorkbookData, 'styles'>, cell: ICellData | undefined | null): TableCell {
  if (!cell) return null;
  const rich = cell.p ? richTextOf(cell) : null;
  const v = rich ?? cell.v;
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (cell.t === 3) return v === 1 || v === '1' || v === 'TRUE' ? 1 : 0;
  if (typeof v === 'number') {
    if (cell.t === 1) return String(v);
    const pattern = cell.s ? resolveStyle(wb, cell.s)?.n?.pattern : undefined;
    return isDateFormat(pattern) ? serialToIso(v) : v;
  }
  return String(v);
}

function cellText(wb: Pick<IWorkbookData, 'styles'>, cell: ICellData | undefined | null): string {
  const v = cellToValue(wb, cell);
  return v === null ? '' : String(v);
}

/** Smallest rectangle that holds every value of the sheet, or null when it is empty. */
export function dataBounds(sheet: Partial<SheetData>): { firstRow: number; lastRow: number; firstCol: number; lastCol: number } | null {
  let firstRow = Infinity;
  let lastRow = -1;
  let firstCol = Infinity;
  let lastCol = -1;
  const cells = sheet.cellData ?? {};
  for (const r in cells) {
    const row = cells[r];
    if (!row) continue;
    let any = false;
    for (const c in row) {
      if (!hasValue(row[c])) continue;
      any = true;
      const ci = Number(c);
      if (ci < firstCol) firstCol = ci;
      if (ci > lastCol) lastCol = ci;
    }
    if (!any) continue;
    const ri = Number(r);
    if (ri < firstRow) firstRow = ri;
    if (ri > lastRow) lastRow = ri;
  }
  return lastRow < 0 ? null : { firstRow, lastRow, firstCol, lastCol };
}

/** Valid, distinct column names: blanks become the column letter, repeats get a number. */
export function uniqueColumnNames(raw: (string | null | undefined)[], firstCol = 0): string[] {
  const seen = new Set<string>();
  return raw.map((value, i) => {
    const base = (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || columnName(firstCol + i);
    let name = base;
    for (let k = 2; seen.has(name.toLowerCase()); k++) name = `${base}_${k}`;
    seen.add(name.toLowerCase());
    return name;
  });
}

/** Column names taken from a row of the sheet (or column letters when `row` is null). */
export function columnsFromRow(wb: IWorkbookData, plan: Pick<SheetTablePlan, 'sheetId' | 'firstCol' | 'lastCol'>, row: number | null): string[] {
  const cells = row === null ? undefined : wb.sheets[plan.sheetId]?.cellData?.[row];
  const raw: string[] = [];
  for (let c = plan.firstCol; c <= plan.lastCol; c++) raw.push(cells ? cellText(wb, cells[c]) : '');
  return uniqueColumnNames(raw, plan.firstCol);
}

type Kind = 'empty' | 'text' | 'number';
const kindOf = (v: TableCell): Kind => (v === null ? 'empty' : typeof v === 'number' ? 'number' : 'text');

function guessHeader(wb: IWorkbookData, sheet: Partial<SheetData>, b: NonNullable<ReturnType<typeof dataBounds>>): { headerRow: number | null; confident: boolean; reason?: string } {
  const cells = sheet.cellData ?? {};
  const width = b.lastCol - b.firstCol + 1;
  const top = cells[b.firstRow] ?? {};
  const values: TableCell[] = [];
  for (let c = b.firstCol; c <= b.lastCol; c++) values.push(cellToValue(wb, top[c]));
  if (b.lastRow === b.firstRow) return { headerRow: null, confident: false, reason: 'The sheet has a single row, so it may be headings or data.' };
  if (values.some((v) => kindOf(v) === 'number')) return { headerRow: null, confident: false, reason: 'The first row contains numbers, so it looks like data rather than headings.' };
  const filled = values.filter((v) => v !== null).length;
  if (filled < width) return { headerRow: b.firstRow, confident: false, reason: `The first row names only ${filled} of the ${width} columns.` };
  const names = values.map((v) => String(v).trim().toLowerCase());
  if (new Set(names).size < names.length) return { headerRow: b.firstRow, confident: false, reason: 'The first row repeats a value, so it may not be a heading row.' };

  // a full row of distinct text: is the data under it different in kind or in looks?
  const sample: number[] = [];
  for (const r in cells) {
    const ri = Number(r);
    if (ri > b.firstRow && ri <= b.lastRow) sample.push(ri);
    if (sample.length >= 50) break;
  }
  let numericColumns = 0;
  for (let c = b.firstCol; c <= b.lastCol; c++) {
    let numbers = 0;
    let filledBelow = 0;
    for (const r of sample) {
      const k = kindOf(cellToValue(wb, cells[r]?.[c]));
      if (k === 'empty') continue;
      filledBelow++;
      if (k === 'number') numbers++;
    }
    if (filledBelow && numbers / filledBelow >= 0.6) numericColumns++;
  }
  if (numericColumns > 0) return { headerRow: b.firstRow, confident: true };
  const bold = (r: number) => {
    let n = 0;
    for (let c = b.firstCol; c <= b.lastCol; c++) if (resolveStyle(wb, cells[r]?.[c]?.s)?.bl) n++;
    return n;
  };
  if (bold(b.firstRow) === width && sample.length && bold(sample[0]) < width) return { headerRow: b.firstRow, confident: true };
  if (sheet.freeze && sheet.freeze.ySplit === b.firstRow + 1) return { headerRow: b.firstRow, confident: true };
  return { headerRow: b.firstRow, confident: false, reason: 'Every column holds text, so the first row could be headings or the first record.' };
}

/** A table plan for every sheet that holds data (empty sheets are skipped). */
export function planTables(wb: IWorkbookData): SheetTablePlan[] {
  const plans: SheetTablePlan[] = [];
  const used = new Set<string>();
  for (const id of wb.sheetOrder) {
    const sheet = wb.sheets[id];
    if (!sheet) continue;
    const b = dataBounds(sheet);
    if (!b) continue;
    const sheetName = sheet.name || 'Sheet';
    let tableName = sheetName.trim() || 'Sheet';
    for (let k = 2; used.has(tableName.toLowerCase()); k++) tableName = `${sheetName}_${k}`;
    used.add(tableName.toLowerCase());
    const guess = guessHeader(wb, sheet, b);
    const base = { sheetId: id, firstCol: b.firstCol, lastCol: b.lastCol };
    const preview: string[][] = [];
    for (let r = b.firstRow; r <= b.lastRow && preview.length < PREVIEW_ROWS; r++) {
      const row = sheet.cellData?.[r];
      const out: string[] = [];
      for (let c = b.firstCol; c <= b.lastCol; c++) out.push(cellText(wb, row?.[c]).slice(0, 60));
      preview.push(out);
    }
    plans.push({ ...base, sheetName, tableName, firstRow: b.firstRow, lastRow: b.lastRow, ...guess, columns: columnsFromRow(wb, base, guess.headerRow), preview });
  }
  return plans;
}

export interface SheetTable {
  name: string;
  columns: { name: string; type: 'INTEGER' | 'REAL' | 'TEXT' }[];
  rows: TableCell[][];
}

/** The rows of one sheet as a table, following its plan (rows up to the heading row are left out). */
export function buildTable(wb: IWorkbookData, plan: SheetTablePlan): SheetTable {
  const cells = wb.sheets[plan.sheetId]?.cellData ?? {};
  const width = plan.lastCol - plan.firstCol + 1;
  const start = plan.headerRow === null ? plan.firstRow : plan.headerRow + 1;
  const kinds: Set<string>[] = Array.from({ length: width }, () => new Set<string>());
  const rows: TableCell[][] = [];
  for (const r in cells) {
    const ri = Number(r);
    if (ri < start || ri > plan.lastRow) continue;
    const src = cells[r];
    const row: TableCell[] = new Array(width).fill(null);
    let any = false;
    for (let c = 0; c < width; c++) {
      const v = cellToValue(wb, src?.[plan.firstCol + c]);
      if (v === null) continue;
      row[c] = v;
      any = true;
      kinds[c].add(typeof v === 'string' ? 'TEXT' : Number.isInteger(v) ? 'INTEGER' : 'REAL');
    }
    if (any) rows.push(row);
  }
  const names = uniqueColumnNames(plan.columns.slice(0, width).concat(new Array(Math.max(0, width - plan.columns.length)).fill('')), plan.firstCol);
  const columns = names.map((name, i) => {
    const k = kinds[i];
    const type: SheetTable['columns'][number]['type'] = k.has('TEXT') || k.size === 0 ? 'TEXT' : k.has('REAL') ? 'REAL' : 'INTEGER';
    return { name, type };
  });
  return { name: plan.tableName, columns, rows };
}
