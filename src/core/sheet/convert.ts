/**
 * Documents ⇄ spreadsheets, for the status-bar format switcher.
 *
 * Document → workbook: each table becomes a sheet (cell text; merged cells keep their text in
 * the top-left cell); a document without tables puts one paragraph per row in column A.
 * Workbook → document: the active sheet's displayed values become a table.
 */
import { escapeHtml, parseHtml } from '../dom';
import { rowsToWorkbook, textToWorkbook } from './csv';
import { blankWorkbook, type IWorkbookData } from './workbook';

function cellText(el: Element): string {
  // one line per block inside the cell
  const blocks = [...el.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, pre')];
  const text = blocks.length ? blocks.map((b) => b.textContent ?? '').join('\n') : el.textContent ?? '';
  return text.replace(/ /g, ' ').trim();
}

function tableRows(table: HTMLTableElement): string[][] {
  const rows: string[][] = [];
  // occupied[r][c]: a cell above spans into this position
  const occupied: boolean[][] = [];
  [...table.rows].forEach((tr, r) => {
    const out: string[] = (rows[r] ??= []);
    let c = 0;
    for (const cell of [...tr.cells]) {
      while (occupied[r]?.[c]) c++;
      out[c] = cellText(cell);
      const rs = Math.max(1, cell.rowSpan || 1);
      const cs = Math.max(1, cell.colSpan || 1);
      for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) if (i || j) ((occupied[r + i] ??= [])[c + j] = true);
      c += cs;
    }
  });
  return rows.map((r) => Array.from(r, (v) => v ?? ''));
}

/** A workbook from a document's HTML (the editor's HTML contract, see core/types.ts). */
export function htmlToWorkbook(html: string, name: string): IWorkbookData {
  const root = parseHtml(html);
  // tables nested inside other tables are read as part of their outer cell
  const tables = [...root.querySelectorAll('table')].filter((t) => !t.parentElement?.closest('table')) as HTMLTableElement[];
  if (tables.length) {
    const books = tables.map((t, i) => rowsToWorkbook(tableRows(t), tables.length > 1 ? `Table ${i + 1}` : 'Sheet1'));
    const wb = books[0];
    for (const extra of books.slice(1)) {
      for (const id of extra.sheetOrder) {
        wb.sheetOrder.push(id);
        wb.sheets[id] = extra.sheets[id];
      }
    }
    wb.name = name;
    return wb;
  }
  const lines = [...root.children].flatMap((el) => {
    if (el.matches('ul, ol')) return [...el.querySelectorAll('li')].map((li) => li.textContent ?? '');
    return [el.textContent ?? ''];
  });
  const rows = lines.map((l) => l.replace(/ /g, ' ').trim());
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  if (!rows.length) return blankWorkbook(name);
  const wb = rowsToWorkbook(rows.map((l) => [l]), 'Sheet1');
  wb.name = name;
  return wb;
}

/**
 * A workbook from plain text. With `split`, consistently delimited text (tabs, commas…) splits
 * into columns; without (source code), each line is one row in column A.
 */
export function plainTextToWorkbook(text: string, name: string, split = true): IWorkbookData {
  if (!text.trim()) return blankWorkbook(name);
  const wb = textToWorkbook(text, 'Sheet1', split);
  wb.name = name;
  return wb;
}

/** HTML for a document holding one sheet's values as a table (the editor's HTML contract). */
export function rowsToDocumentHtml(rows: string[][]): string {
  const trimmed = rows.map((row) => {
    let end = row.length;
    while (end > 0 && !row[end - 1]) end--;
    return row.slice(0, end);
  });
  while (trimmed.length && !trimmed[trimmed.length - 1].length) trimmed.pop();
  const width = Math.max(0, ...trimmed.map((r) => r.length));
  if (!trimmed.length || !width) return '<p></p>';
  const cell = (v: string) => `<td><p>${v.split('\n').map(escapeHtml).join('<br>')}</p></td>`;
  const body = trimmed.map((r) => `<tr>${Array.from({ length: width }, (_, c) => cell(r[c] ?? '')).join('')}</tr>`).join('');
  return `<table><tbody>${body}</tbody></table><p></p>`;
}

/** Tab-separated text of one sheet's values (for plain-text and code formats). */
export function rowsToText(rows: string[][]): string {
  return rows
    .map((r) => {
      let end = r.length;
      while (end > 0 && !r[end - 1]) end--;
      return r.slice(0, end).join('\t');
    })
    .join('\n')
    .replace(/\n+$/, '');
}
