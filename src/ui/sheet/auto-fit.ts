/**
 * Column auto-fit for the spreadsheet: the width that shows the widest value of a column.
 *
 * The grid's own auto-fit (double-click a column heading's right edge) only measures the rows
 * on screen, so a long value further down the sheet stays cut off. This one looks at every
 * row of the column. It reads the cells where the editor keeps them (no copy), remembers the
 * longest candidates as it goes, and measures only those with the canvas, so a column of a
 * million rows is fitted in well under a second.
 */
import { resolveStyle, richTextOf, type ICellData, type IStyleData, type IWorkbookData } from '../../core/sheet/workbook';

/** Candidates kept per column: the longest texts, and the longest number of each cell format. */
const TEXT_CANDIDATES = 12;
const NUMBER_FORMATS = 24;
/** Cell padding on both sides, plus the grid line. */
const CELL_CHROME_PX = 10;
export const MAX_FIT_WIDTH = 1200;
const DEFAULT_FONT_PT = 11;
const DEFAULT_FONT_FAMILY = 'Arial';

export interface FitCandidate {
  row: number;
  text: string;
  /** A number: its text on screen depends on the cell's number format. */
  numeric: boolean;
  style: IStyleData | null;
}

interface ColumnScan {
  /** Longest texts, by estimated width. */
  texts: { score: number; candidate: FitCandidate }[];
  /** The longest raw number per cell format. */
  numbers: Map<unknown, { length: number; candidate: FitCandidate }>;
}

/**
 * The cells worth measuring in each of `columns`: the longest texts and, per number format,
 * the longest number. One pass over the sheet's rows.
 */
export function fitCandidates(wb: Pick<IWorkbookData, 'styles'>, cellData: Record<number, Record<number, ICellData>> | undefined, columns: number[]): Map<number, FitCandidate[]> {
  const scans = new Map<number, ColumnScan>(columns.map((c) => [c, { texts: [], numbers: new Map() }]));
  const cells = cellData ?? {};
  for (const r in cells) {
    const row = cells[r];
    if (!row) continue;
    for (const c of columns) {
      const cell = row[c];
      if (!cell) continue;
      const rich = cell.p ? richTextOf(cell) : null;
      const v = rich ?? cell.v;
      if (v === undefined || v === null || v === '') continue;
      const scan = scans.get(c)!;
      if (typeof v === 'number' && cell.t !== 1) {
        const text = String(v);
        const key = cell.s ?? '';
        const best = scan.numbers.get(key);
        if (!best) {
          if (scan.numbers.size < NUMBER_FORMATS) scan.numbers.set(key, { length: text.length, candidate: { row: Number(r), text, numeric: true, style: resolveStyle(wb, cell.s) } });
        } else if (text.length > best.length) {
          best.length = text.length;
          best.candidate = { row: Number(r), text, numeric: true, style: best.candidate.style };
        }
        continue;
      }
      const text = String(v);
      let length = text.length;
      if (text.indexOf('\n') >= 0) length = Math.max(...text.split('\n').map((l) => l.length));
      const list = scan.texts;
      const style = resolveStyle(wb, cell.s);
      const score = length * (Number(style?.fs) || DEFAULT_FONT_PT) * (style?.bl ? 1.08 : 1);
      if (list.length === TEXT_CANDIDATES && score <= list[list.length - 1].score) continue;
      list.push({ score, candidate: { row: Number(r), text, numeric: false, style } });
      list.sort((a, b) => b.score - a.score);
      if (list.length > TEXT_CANDIDATES) list.length = TEXT_CANDIDATES;
    }
  }
  const out = new Map<number, FitCandidate[]>();
  for (const [c, scan] of scans) out.set(c, [...scan.texts.map((t) => t.candidate), ...[...scan.numbers.values()].map((n) => n.candidate)]);
  return out;
}

/** The CSS font a cell with `style` is drawn in. */
export function cellFont(style: IStyleData | null): string {
  const size = Number(style?.fs) || DEFAULT_FONT_PT;
  return `${style?.it ? 'italic ' : ''}${style?.bl ? 'bold ' : ''}${size}pt ${style?.ff ? `"${String(style.ff).replace(/"/g, '')}", ` : ''}${DEFAULT_FONT_FAMILY}, sans-serif`;
}

/**
 * The width (px) that fits the widest of `candidates`. `display` gives the text a cell shows
 * (formatted numbers and dates); `measure` the width of a text in a font.
 */
export function fittedWidth(candidates: FitCandidate[], display: (c: FitCandidate) => string, measure: (text: string, font: string) => number): number | null {
  let widest = 0;
  for (const c of candidates) {
    const text = c.numeric ? display(c) : c.text;
    const font = cellFont(c.style);
    for (const line of text.split('\n')) {
      const w = measure(line.length > 4000 ? line.slice(0, 4000) : line, font);
      if (w > widest) widest = w;
    }
  }
  if (!widest) return null;
  return Math.min(MAX_FIT_WIDTH, Math.ceil(widest) + CELL_CHROME_PX);
}
