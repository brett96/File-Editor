import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { applyTint, excelColorToHex, parseThemeColors } from '../src/core/sheet/colors';
import { guessDelimiter, readDelimited, sheetToRows, writeDelimited } from '../src/core/sheet/csv';
import { readXlsx, writeXlsx } from '../src/core/sheet/xlsx';
import { blankWorkbook, columnName, resolveStyle, sheetFormatFromName, usedRange } from '../src/core/sheet/workbook';
import { decryptOffice, encryptOffice, isOfficeEncrypted } from '../src/core/crypto/office-crypto';

async function sampleXlsx(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Budget', { properties: { tabColor: { argb: 'FF00B050' } }, views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  ws.getCell('A1').value = 'Item';
  ws.getCell('B1').value = 'Cost';
  ws.getCell('A1').font = { bold: true, color: { argb: 'FFFF0000' }, name: 'Arial', size: 14 };
  ws.getCell('B1').fill = { type: 'pattern', pattern: 'solid', fgColor: { theme: 4, tint: 0.4 } as never };
  ws.getCell('A2').value = 'Rent';
  ws.getCell('B2').value = 1200.5;
  ws.getCell('B2').numFmt = '$#,##0.00';
  ws.getCell('A3').value = 'Food';
  ws.getCell('B3').value = 300;
  ws.getCell('A4').value = 'Total';
  ws.getCell('B4').value = { formula: 'SUM(B2:B3)', result: 1500.5 };
  ws.getCell('B4').border = { top: { style: 'double', color: { argb: 'FF000000' } } };
  ws.getCell('C2').value = new Date(Date.UTC(2026, 0, 15));
  ws.getCell('C3').value = true;
  ws.getCell('D2').value = { text: 'site', hyperlink: 'https://example.com' };
  ws.getCell('A6').value = 'Merged';
  ws.getCell('A6').alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  ws.mergeCells('A6:C7');
  ws.getColumn(1).width = 20;
  ws.getRow(6).height = 30;
  ws.getColumn(5).hidden = true;
  const hidden = wb.addWorksheet('Secret', { state: 'hidden' });
  hidden.getCell('A1').value = 7;
  hidden.getCell('A2').value = { formula: 'Budget!B4*2', result: 3001 };
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe('xlsx', () => {
  it('reads values, formulas, styles and layout', async () => {
    const { workbook: wb, warnings } = await readXlsx(await sampleXlsx(), 'budget');
    expect(wb.sheetOrder).toHaveLength(2);
    const s = wb.sheets[wb.sheetOrder[0]];
    expect(s.name).toBe('Budget');
    expect(s.tabColor).toBe('#00B050');
    expect(s.freeze).toMatchObject({ xSplit: 1, ySplit: 1 });
    const cd = s.cellData!;
    expect(cd[0][0].v).toBe('Item');
    expect(cd[1][1]).toMatchObject({ v: 1200.5, t: 2 });
    expect(cd[3][1]).toMatchObject({ f: '=SUM(B2:B3)', v: 1500.5 });
    expect(cd[2][2].v).toBe(1); // TRUE
    expect(cd[1][2].v).toBe(46037); // 2026-01-15 as an Excel serial
    expect(resolveStyle(wb, cd[1][2].s)?.n?.pattern).toBe('mm-dd-yy'); // ExcelJS's default date format
    expect(cd[1][3]).toMatchObject({ v: 'site', custom: { hyperlink: 'https://example.com' } });
    const a1 = resolveStyle(wb, cd[0][0].s)!;
    expect(a1).toMatchObject({ bl: 1, fs: 14, ff: 'Arial', cl: { rgb: '#FF0000' } });
    expect(resolveStyle(wb, cd[0][1].s)?.bg?.rgb).toBe('#95B3D7'); // the file's own theme (ExcelJS writes Office 2007's): accent1 4F81BD lightened 40 %
    expect(resolveStyle(wb, cd[1][1].s)?.n?.pattern).toBe('$#,##0.00');
    expect(resolveStyle(wb, cd[3][1].s)?.bd?.t?.s).toBe(7); // double
    expect(resolveStyle(wb, cd[5][0].s)).toMatchObject({ ht: 2, vt: 2, tb: 3 });
    expect(s.mergeData).toEqual([{ startRow: 5, startColumn: 0, endRow: 6, endColumn: 2 }]);
    expect(s.columnData![0].w).toBe(145);
    expect(s.columnData![4].hd).toBe(1);
    expect(s.rowData![5].h).toBe(40);
    const hidden = wb.sheets[wb.sheetOrder[1]];
    expect(hidden.hidden).toBe(1);
    expect(hidden.cellData![1][0].f).toBe('=Budget!B4*2');
    expect(warnings).toEqual([]);
  });

  it('writes a workbook Excel reads back the same', async () => {
    const { workbook } = await readXlsx(await sampleXlsx(), 'budget');
    const out = await writeXlsx(workbook);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Budget')!;
    expect(ws.getCell('A1').value).toBe('Item');
    expect(ws.getCell('A1').font).toMatchObject({ bold: true, size: 14, name: 'Arial', color: { argb: 'FFFF0000' } });
    expect(ws.getCell('B2').value).toBe(1200.5);
    expect(ws.getCell('B2').numFmt).toBe('$#,##0.00');
    expect(ws.getCell('B4').value).toMatchObject({ formula: 'SUM(B2:B3)', result: 1500.5 });
    expect(ws.getCell('B4').border.top?.style).toBe('double');
    expect(ws.getCell('C3').value).toBe(true);
    expect(ws.getCell('D2').value).toMatchObject({ text: 'site', hyperlink: 'https://example.com' });
    expect(ws.getCell('A6').isMerged && ws.getCell('C7').master.address).toBe('A6');
    expect(ws.getColumn(1).width).toBeCloseTo(20, 0);
    expect(ws.getColumn(5).hidden).toBe(true);
    expect(ws.getRow(6).height).toBe(30);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', xSplit: 1, ySplit: 1 });
    expect(ws.properties.tabColor).toMatchObject({ argb: 'FF00B050' });
    expect(wb.getWorksheet('Secret')!.state).toBe('hidden');
  });

  it('round-trips through Office encryption', async () => {
    const plain = await writeXlsx(blankWorkbook());
    const locked = await encryptOffice(plain, 'pw');
    expect(isOfficeEncrypted(locked)).toBe(true);
    const { workbook } = await readXlsx(await decryptOffice(locked, 'pw'));
    expect(workbook.sheetOrder).toHaveLength(1);
  });

  it('writes unique, valid sheet names', async () => {
    const wb = blankWorkbook();
    const first = wb.sheets[wb.sheetOrder[0]];
    first.name = 'a/b:c';
    wb.sheetOrder.push('x');
    wb.sheets.x = { id: 'x', name: 'A_B_C' };
    const out = new ExcelJS.Workbook();
    await out.xlsx.load((await writeXlsx(wb)) as unknown as ArrayBuffer);
    expect(out.worksheets.map((w) => w.name)).toEqual(['a_b_c', 'A_B_C (2)']);
  });
});

describe('csv / tsv', () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it('parses numbers but keeps codes, formulas and quoted text as text', () => {
    const wb = readDelimited(enc('id,zip,amount,note\n1,00501,12.50,"hello, ""world"""\n2,90210,-3e2,=1+1\n'), 'data.csv');
    const cd = wb.sheets[wb.sheetOrder[0]].cellData!;
    expect(cd[1][0]).toEqual({ v: 1, t: 2 });
    expect(cd[1][1]).toEqual({ v: '00501', t: 1 });
    expect(cd[1][2]).toEqual({ v: 12.5, t: 2 });
    expect(cd[1][3].v).toBe('hello, "world"');
    expect(cd[2][2].v).toBe(-300);
    expect(cd[2][3]).toEqual({ v: '=1+1', t: 1 });
    expect(cd[2][3].f).toBeUndefined();
    expect(usedRange(wb.sheets[wb.sheetOrder[0]])).toEqual({ lastRow: 2, lastCol: 3 });
  });

  it('detects semicolons, tabs and Windows-1252 text', () => {
    expect(guessDelimiter('a;b;c\n1;2;3\n')).toBe(';');
    expect(guessDelimiter('a\tb\n1\t2\n')).toBe('\t');
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x31, 0x0a]); // "café,1"
    const wb = readDelimited(latin1, 'x.csv');
    expect(wb.sheets[wb.sheetOrder[0]].cellData![0][0].v).toBe('café');
  });

  it('writes RFC 4180 CSV with a BOM, and TSV', () => {
    const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(writeDelimited([['a', 'b,c', 'say "hi"'], ['1', '', ''], ['', '', '']], ','));
    expect(csv).toBe('﻿a,"b,c","say ""hi"""\r\n1,,\r\n');
    const tsv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(writeDelimited([['x', 'y']], '\t'));
    expect(tsv).toBe('﻿x\ty\r\n');
  });

  it('round-trips values', () => {
    const wb = readDelimited(enc('name,qty\nPens,12\n'), 'r.csv');
    expect(sheetToRows(wb)).toEqual([['name', 'qty'], ['Pens', '12']]);
  });
});

describe('helpers', () => {
  it('names columns and formats', () => {
    expect([0, 25, 26, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA']);
    expect(sheetFormatFromName('Q3.XLSX')).toBe('xlsx');
    expect(sheetFormatFromName('a.tsv')).toBe('tsv');
    expect(sheetFormatFromName('a.docx')).toBeNull();
  });

  it('resolves theme and indexed colours with tint', () => {
    expect(excelColorToHex({ argb: 'FF123456' })).toBe('#123456');
    expect(excelColorToHex({ indexed: 2 })).toBe('#FF0000');
    expect(excelColorToHex({ theme: 1 })).toBe('#000000');
    expect(applyTint('4472C4', -0.25)).toBe('2F5597');
    expect(parseThemeColors('<a:clrScheme name="x"><a:dk1><a:sysClr val="windowText" lastClr="111111"/></a:dk1><a:accent1><a:srgbClr val="ABCDEF"/></a:accent1></a:clrScheme>')[4]).toBe('ABCDEF');
  });
});
