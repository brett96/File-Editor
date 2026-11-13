import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { readXlsx, writeXlsx } from '../src/core/sheet/xlsx';
import { countCells, needsStreamRead, readXlsxStream, writeXlsxStream } from '../src/core/sheet/xlsx-stream';
import { blankSheet, blankWorkbook, resolveStyle, type ICellData, type IWorkbookData } from '../src/core/sheet/workbook';
import { ZipWriter, readZipDirectory, zipEntryString } from '../src/core/zip-stream';

const blobOf = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);

async function sampleXlsx(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Budget', { properties: { tabColor: { argb: 'FF00B050' } }, views: [{ state: 'frozen', xSplit: 1, ySplit: 1, zoomScale: 120, showGridLines: false }] });
  ws.getCell('A1').value = 'Item';
  ws.getCell('B1').value = 'Cost';
  ws.getCell('A1').font = { bold: true, italic: true, color: { argb: 'FFFF0000' }, name: 'Arial', size: 14 };
  ws.getCell('B1').fill = { type: 'pattern', pattern: 'solid', fgColor: { theme: 4, tint: 0.4 } as never };
  ws.getCell('A2').value = 'Rent & <utilities>';
  ws.getCell('B2').value = 1200.5;
  ws.getCell('B2').numFmt = '$#,##0.00';
  ws.getCell('A3').value = ' padded ';
  ws.getCell('B3').value = 300;
  ws.getCell('A4').value = 'Total';
  ws.getCell('B4').value = { formula: 'SUM(B2:B3)', result: 1500.5 };
  ws.getCell('B4').border = { top: { style: 'double', color: { argb: 'FF000000' } }, left: { style: 'thin', color: { argb: 'FF00FF00' } } };
  ws.getCell('C2').value = new Date(Date.UTC(2026, 0, 15));
  ws.getCell('C3').value = true;
  ws.getCell('C4').value = { formula: 'A4&"!"', result: 'Total!' };
  ws.getCell('D2').value = { text: 'site', hyperlink: 'https://example.com/?a=1&b=2' };
  ws.getCell('A6').value = 'Merged';
  ws.getCell('A6').alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  ws.mergeCells('A6:C7');
  ws.getColumn(1).width = 20;
  ws.getRow(6).height = 30;
  ws.getColumn(5).hidden = true;
  ws.getRow(9).hidden = true;
  ws.getCell('A9').value = 'hidden row';
  // shared formula block
  ws.getCell('F2').value = 2;
  ws.getCell('F3').value = 3;
  ws.getCell('F4').value = 4;
  ws.getCell('G2').value = { formula: 'F2*10', result: 20, shareType: 'shared', ref: 'G2:G4' } as never;
  ws.getCell('G3').value = { sharedFormula: 'G2', result: 30 } as never;
  ws.getCell('G4').value = { sharedFormula: 'G2', result: 40 } as never;
  const hidden = wb.addWorksheet('Secret', { state: 'hidden' });
  hidden.getCell('A1').value = 7;
  hidden.getCell('A2').value = { formula: 'Budget!B4*2', result: 3001 };
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** A workbook reduced to what must survive, with styles resolved and ids removed. */
function normalize(wb: IWorkbookData, opts: { formulas?: boolean } = {}) {
  return wb.sheetOrder.map((id) => {
    const s = wb.sheets[id]!;
    const cells: Record<string, unknown> = {};
    for (const [r, row] of Object.entries(s.cellData ?? {})) {
      for (const [c, cell] of Object.entries(row as Record<string, ICellData>)) {
        const st = resolveStyle(wb, cell.s);
        cells[`${r},${c}`] = {
          v: cell.v,
          ...(cell.t !== undefined ? { t: cell.t } : {}),
          ...(opts.formulas === false ? {} : { f: cell.f, shared: !!cell.si && !cell.f }),
          ...(cell.custom ? { custom: cell.custom } : {}),
          ...(st ? { st } : {}),
        };
      }
    }
    return {
      name: s.name,
      hidden: s.hidden,
      tabColor: s.tabColor,
      freeze: s.freeze,
      zoom: s.zoomRatio,
      grid: s.showGridlines,
      merges: s.mergeData,
      cols: s.columnData,
      rows: s.rowData,
      cells,
    };
  });
}

describe('streaming xlsx', () => {
  it('reads the same workbook as the ExcelJS reader', async () => {
    const bytes = await sampleXlsx();
    const viaExcelJs = await readXlsx(bytes, 'budget');
    const viaStream = await readXlsxStream(blobOf(bytes), 'budget');
    const a = normalize(viaExcelJs.workbook, { formulas: false });
    const b = normalize(viaStream.workbook, { formulas: false });
    // row heights: ExcelJS reports every row's height, the stream reader only custom ones
    expect(b[0].rows).toMatchObject({ 5: { h: 40 }, 8: { hd: 1 } });
    for (const s of [...a, ...b]) s.rows = {};
    expect(b).toEqual(a);

    const cd = viaStream.workbook.sheets[viaStream.workbook.sheetOrder[0]].cellData!;
    expect(cd[3][1]).toMatchObject({ f: '=SUM(B2:B3)', v: 1500.5 });
    expect(cd[3][2]).toMatchObject({ f: '=A4&"!"', v: 'Total!' });
    expect(cd[1][0].v).toBe('Rent & <utilities>');
    expect(cd[2][0].v).toBe(' padded ');
    // shared formula: the first cell has the text and an id, the others the id alone
    expect(cd[1][6].f).toBe('=F2*10');
    expect(cd[1][6].si).toBeTruthy();
    expect(cd[2][6]).toMatchObject({ si: cd[1][6].si, v: 30 });
    expect(cd[2][6].f).toBeUndefined();
    expect(viaStream.warnings).toEqual(viaExcelJs.warnings);
  });

  it('writes a workbook the ExcelJS reader reads back unchanged', async () => {
    const original = (await readXlsx(await sampleXlsx(), 'budget')).workbook;
    const bytes = await writeXlsxStream(original);
    const back = (await readXlsx(bytes, 'budget')).workbook;
    const a = normalize(original);
    const b = normalize(back);
    for (const s of [...a, ...b]) s.rows = {};
    expect(b).toEqual(a);
    expect(back.sheets[back.sheetOrder[0]].rowData).toMatchObject({ 5: { h: 40 }, 8: { hd: 1 } });
    // and the two writers agree with each other when read by the stream reader
    const viaExcelJs = (await readXlsxStream(blobOf(await writeXlsx(original)), 'budget')).workbook;
    const viaStream = (await readXlsxStream(blobOf(bytes), 'budget')).workbook;
    const c = normalize(viaExcelJs);
    const d = normalize(viaStream);
    for (const s of [...c, ...d]) s.rows = {};
    expect(d).toEqual(c);
  });

  it('escapes text and keeps odd values', async () => {
    const wb = blankWorkbook('odd');
    const sheet = wb.sheets[wb.sheetOrder[0]]!;
    sheet.name = 'A/B [1]';
    sheet.cellData = {
      0: { 0: { v: 'a<b>&"c"', t: 1 }, 1: { v: 'line1\nline2', t: 1 }, 2: { v: 'bell\u0007', t: 1 }, 3: { v: '00123', t: 1 } },
      1: { 0: { v: -1.5e-7, t: 2 }, 1: { v: 0, t: 2 }, 2: { v: 1, t: 3 }, 3: { v: 0, t: 3 } },
      2: { 0: { f: '=IF(A2<0,"neg","pos")', v: 'neg' }, 5: { v: '😀 emoji', t: 1 } },
    };
    const back = (await readXlsxStream(blobOf(await writeXlsxStream(wb)), 'odd')).workbook;
    const s = back.sheets[back.sheetOrder[0]]!;
    expect(s.name).toBe('A_B _1_');
    const cd = s.cellData!;
    expect([cd[0][0].v, cd[0][1].v, cd[0][2].v, cd[0][3].v]).toEqual(['a<b>&"c"', 'line1\nline2', 'bell\u0007', '00123']);
    expect(cd[0][3].t).toBe(1);
    expect([cd[1][0].v, cd[1][1].v]).toEqual([-1.5e-7, 0]);
    expect(cd[1][2]).toMatchObject({ v: 1, t: 3 });
    expect(cd[1][3]).toMatchObject({ v: 0, t: 3 });
    expect(cd[2][0]).toMatchObject({ f: '=IF(A2<0,"neg","pos")', v: 'neg' });
    expect(cd[2][5].v).toBe('😀 emoji');
  });

  it('round-trips 60,000 rows', async () => {
    const wb = blankWorkbook('big');
    const sheet = wb.sheets[wb.sheetOrder[0]]!;
    const ROWS = 60_000;
    const COLS = 12;
    const cellData: Record<number, Record<number, ICellData>> = {};
    for (let r = 0; r < ROWS; r++) {
      const row: Record<number, ICellData> = {};
      for (let c = 0; c < COLS; c++) row[c] = c % 3 === 0 ? { v: `row ${r} col ${c % 5}`, t: 1 } : c === 11 ? { f: `=B${r + 1}+C${r + 1}`, v: r * 3 } : { v: r * c + 0.25, t: 2 };
      cellData[r] = row;
    }
    sheet.cellData = cellData;
    sheet.rowCount = ROWS + 100;
    sheet.freeze = { xSplit: 0, ySplit: 1, startRow: 1, startColumn: 0 };
    expect(countCells(wb)).toBe(ROWS * COLS);
    let lastWrite = 0;
    const bytes = await writeXlsxStream(wb, (f) => (lastWrite = f));
    expect(lastWrite).toBe(1);
    let progress = 0;
    const back = (await readXlsxStream(blobOf(bytes), 'big', (p) => (progress = p.fraction))).workbook;
    expect(progress).toBe(1);
    const s = back.sheets[back.sheetOrder[0]]!;
    expect(countCells(back)).toBe(ROWS * COLS);
    expect(s.rowCount).toBeGreaterThanOrEqual(ROWS);
    expect(s.freeze).toMatchObject({ xSplit: 0, ySplit: 1 });
    expect(s.cellData![59_999][0].v).toBe('row 59999 col 0');
    expect(s.cellData![59_999][1]).toMatchObject({ v: 59_999.25, t: 2 });
    expect(s.cellData![59_999][11]).toMatchObject({ f: '=B60000+C60000', v: 179_997 });
  });

  it('decides when a package needs the streaming reader', async () => {
    expect(await needsStreamRead(blobOf(await sampleXlsx()))).toBe(false);
    expect(await needsStreamRead(new Blob(['not a zip']))).toBe(false);
  });
});

describe('zip stream', () => {
  it('writes entries that read back, including an empty one', async () => {
    const zip = new ZipWriter();
    await zip.add('a.txt', 'hello');
    await zip.add('dir/b.xml', (function* () {
      for (let i = 0; i < 2000; i++) yield `<row n="${i}">é</row>`;
    })());
    await zip.add('empty.txt', '');
    const blob = blobOf(zip.finish());
    const dir = await readZipDirectory(blob);
    expect(dir.map((e) => e.name)).toEqual(['a.txt', 'dir/b.xml', 'empty.txt']);
    expect(await zipEntryString(blob, dir[0])).toBe('hello');
    const b = await zipEntryString(blob, dir[1]);
    expect(b.length).toBe(dir[1].size - 2000); // é is two bytes
    expect(b.endsWith('<row n="1999">é</row>')).toBe(true);
    expect(await zipEntryString(blob, dir[2])).toBe('');
    // JSZip-compatible: ExcelJS's own zip reader is exercised by the xlsx tests above
    await expect(readZipDirectory(new Blob(['nope']))).rejects.toThrow();
  });
});
