// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { htmlToWorkbook, plainTextToWorkbook, rowsToDocumentHtml, rowsToText } from '../src/core/sheet/convert';
import { detectDelimiter, sheetToRows } from '../src/core/sheet/csv';

const rowsOf = (wb: ReturnType<typeof htmlToWorkbook>, i = 0) => sheetToRows(wb, wb.sheetOrder[i]);

describe('document → spreadsheet', () => {
  it('turns each table into a sheet, numbers as numbers', () => {
    const wb = htmlToWorkbook(
      '<p>Intro</p><table><tbody><tr><th><p>Item</p></th><th><p>Cost</p></th></tr><tr><td><p>Rent</p></td><td><p>1200</p></td></tr></tbody></table>' +
        '<table><tbody><tr><td colspan="2"><p>Wide</p></td><td><p>x</p></td></tr><tr><td><p>a</p></td><td><p>b</p></td><td><p>c</p></td></tr></tbody></table>',
      'Budget',
    );
    expect(wb.name).toBe('Budget');
    expect(wb.sheetOrder).toHaveLength(2);
    expect(wb.sheets[wb.sheetOrder[0]].name).toBe('Table 1');
    expect(rowsOf(wb)).toEqual([['Item', 'Cost'], ['Rent', '1200']]);
    expect(wb.sheets[wb.sheetOrder[0]].cellData![1][1]).toEqual({ v: 1200, t: 2 });
    expect(rowsOf(wb, 1)).toEqual([['Wide', '', 'x'], ['a', 'b', 'c']]);
  });

  it('puts paragraphs and list items one per row without tables', () => {
    const wb = htmlToWorkbook('<h1>Title</h1><p>First, second</p><ul><li><p>one</p></li><li><p>two</p></li></ul><p></p>', 'Notes');
    expect(rowsOf(wb)).toEqual([['Title'], ['First, second'], ['one'], ['two']]);
  });

  it('splits delimited plain text but not prose', () => {
    expect(rowsOf(plainTextToWorkbook('a\tb\n1\t2\n', 'x'))).toEqual([['a', 'b'], ['1', '2']]);
    expect(rowsOf(plainTextToWorkbook('name,qty\npens,3\n', 'x'))).toEqual([['name', 'qty'], ['pens', '3']]);
    expect(rowsOf(plainTextToWorkbook('Hello, world.\nNo commas here\n', 'x'))).toEqual([['Hello, world.'], ['No commas here']]);
    expect(detectDelimiter('Plain sentence one.\nAnother line, with a comma\nThird')).toBeNull();
    expect(rowsOf(plainTextToWorkbook('a { b: c; d: e; }\nf { g: h; i: j; }', 'x', false))).toEqual([['a { b: c; d: e; }'], ['f { g: h; i: j; }']]);
    expect(plainTextToWorkbook('   ', 'Empty').sheetOrder).toHaveLength(1);
  });
});

describe('spreadsheet → document', () => {
  it('makes a table of the displayed values', () => {
    const html = rowsToDocumentHtml([['Item', 'Cost', ''], ['A & B', '$1,200.00'], ['', '', '']]);
    expect(html).toBe('<table><tbody><tr><td><p>Item</p></td><td><p>Cost</p></td></tr><tr><td><p>A &amp; B</p></td><td><p>$1,200.00</p></td></tr></tbody></table><p></p>');
    expect(rowsToDocumentHtml([])).toBe('<p></p>');
    expect(rowsToText([['a', 'b', ''], ['c'], []])).toBe('a\tb\nc');
  });
});
