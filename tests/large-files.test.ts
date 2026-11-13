import { describe, expect, it } from 'vitest';
import { tableSink } from '../src/core/db/import-rows';
import { SqliteDatabase } from '../src/core/db/sqlite';
import { StringPool, WorkbookTooLargeError, detach, memoryProfile, sheetCellBudget } from '../src/core/memory';
import { readDelimited, readDelimitedRows, readDelimitedStream, sheetToRows } from '../src/core/sheet/csv';
import { blankSheet, blankWorkbook, type ICellData } from '../src/core/sheet/workbook';
import { estimateCells, needsStreamRead, readXlsxRows, readXlsxStream, writeXlsxStream, type RowValue } from '../src/core/sheet/xlsx-stream';

const GB = 1024 ** 3;
const blobOf = (bytes: Uint8Array | string) => new Blob([bytes as BlobPart]);

/** A workbook of `rows` × `cols` cells: text in column A, numbers elsewhere, a heading row. */
function gridWorkbook(rows: number, cols: number) {
  const wb = blankWorkbook('grid');
  const sheet = wb.sheets[wb.sheetOrder[0]]!;
  sheet.name = 'Data';
  const cells: Record<number, Record<number, ICellData>> = {};
  cells[0] = Object.fromEntries(Array.from({ length: cols }, (_, c) => [c, { v: c === 0 ? 'Name' : `Value ${c}`, t: 1 }]));
  for (let r = 1; r <= rows; r++) {
    cells[r] = Object.fromEntries(Array.from({ length: cols }, (_, c) => [c, c === 0 ? { v: `Row number ${r} of the grid`, t: 1 } : { v: r * c + 0.5, t: 2 }]));
  }
  sheet.cellData = cells;
  sheet.rowCount = rows + 100;
  return wb;
}

describe('memory budget', () => {
  it('gives a large desktop more cells than the old fixed limit, and a small device fewer', () => {
    const desktop = sheetCellBudget(memoryProfile({ heapLimit: 4 * GB, deviceMemoryGb: 8 }));
    const laptop = sheetCellBudget(memoryProfile({ heapLimit: 4 * GB, deviceMemoryGb: 4 }));
    const phone = sheetCellBudget(memoryProfile({ heapLimit: 1 * GB, deviceMemoryGb: 2, mobile: true }));
    expect(desktop).toBeGreaterThan(25_000_000);
    expect(laptop).toBeLessThan(desktop);
    expect(phone).toBeLessThan(laptop);
    expect(phone).toBeGreaterThanOrEqual(1_000_000);
  });

  it('never plans on more than half the RAM, and flags low-memory devices', () => {
    expect(memoryProfile({ heapLimit: 4 * GB, deviceMemoryGb: 2 }).usableBytes).toBe(1 * GB);
    expect(memoryProfile({ heapLimit: 4 * GB, deviceMemoryGb: 2 }).lowMemory).toBe(true);
    expect(memoryProfile({ heapLimit: 4 * GB, deviceMemoryGb: 8 }).lowMemory).toBe(false);
    // browsers that report nothing
    expect(memoryProfile({}).usableBytes).toBe(2 * GB);
    expect(memoryProfile({ mobile: true }).lowMemory).toBe(true);
  });

  it('keeps one copy of repeated text', () => {
    const pool = new StringPool();
    const a = pool.get('a status that repeats');
    expect(pool.get(['a status', 'that repeats'].join(' '))).toBe(a);
    expect(detach('short')).toBe('short');
    expect(detach('a string long enough to be a slice')).toBe('a string long enough to be a slice');
  });
});

describe('large Excel workbooks', () => {
  it('stops at the cell limit with an error that says what it is', async () => {
    const bytes = await writeXlsxStream(gridWorkbook(200, 10));
    await expect(readXlsxStream(blobOf(bytes), 'grid', undefined, { maxCells: 500 })).rejects.toBeInstanceOf(WorkbookTooLargeError);
    const ok = await readXlsxStream(blobOf(bytes), 'grid', undefined, { maxCells: 5000 });
    expect(Object.keys(ok.workbook.sheets[ok.workbook.sheetOrder[0]].cellData!)).toHaveLength(201);
  });

  it('builds cells with exactly their own fields', async () => {
    const wb = (await readXlsxStream(blobOf(await writeXlsxStream(gridWorkbook(3, 3))), 'grid')).workbook;
    const cells = wb.sheets[wb.sheetOrder[0]].cellData!;
    expect(cells[1][0]).toEqual({ v: 'Row number 1 of the grid', t: 1 });
    expect(cells[2][2]).toEqual({ v: 4.5, t: 2 });
  });

  it('estimates the cell count from the sheet XML and uses the stream reader sooner on small devices', async () => {
    const bytes = await writeXlsxStream(gridWorkbook(2000, 10));
    const estimate = (await estimateCells(blobOf(bytes)))!;
    expect(estimate).toBeGreaterThan(10_000);
    expect(estimate).toBeLessThan(60_000);
    expect(await estimateCells(blobOf('not a zip'))).toBeNull();
    expect(await needsStreamRead(blobOf(bytes))).toBe(false);
    // 6 MB+ package: over a quarter of the usual threshold
    const big = new Blob([bytes as BlobPart, new Uint8Array(7 * 1024 * 1024)]);
    expect(await needsStreamRead(big, true)).toBe(true);
    expect(await needsStreamRead(big, false)).toBe(false);
  });

  it('reads a workbook row by row into database tables', async () => {
    const wb = gridWorkbook(120, 4);
    // a second sheet with no heading row, a date and a gap
    const second = blankSheet('Log');
    wb.styles = { d: { n: { pattern: 'yyyy-mm-dd' } } };
    second.cellData = {
      0: { 0: { v: 46037, t: 2, s: 'd' }, 1: { v: 1, t: 3 } },
      1: { 0: { v: 46038, t: 2, s: 'd' }, 2: { v: 'late column', t: 1 } },
      4: { 1: { v: 7, t: 2 } },
    };
    wb.sheets[second.id] = second;
    wb.sheetOrder.push(second.id);
    wb.sheets.empty = blankSheet('Nothing here', 'empty');
    wb.sheetOrder.push('empty');
    const bytes = await writeXlsxStream(wb);

    const seen: [number, RowValue[]][] = [];
    const count = await readXlsxRows(blobOf(bytes), { beginSheet() {}, row: (i, v) => void seen.push([i, v]), endSheet() {} });
    expect(count.sheets).toBe(3);
    expect(count.cells).toBe(121 * 4 + 5);
    expect(seen[0]).toEqual([0, ['Name', 'Value 1', 'Value 2', 'Value 3']]);

    const db = await SqliteDatabase.open();
    const sink = tableSink(db);
    await readXlsxRows(blobOf(bytes), sink);
    expect(sink.tables).toEqual([
      { name: 'Data', columns: 4, rows: 120, header: true },
      { name: 'Log', columns: 3, rows: 3, header: false },
    ]);
    const data = db.readPage('Data', 'table', 2, 0);
    expect(data.columns).toEqual(['Name', 'Value 1', 'Value 2', 'Value 3']);
    expect(data.total).toBe(120);
    expect(data.rows[0]).toEqual(['Row number 1 of the grid', 1.5, 2.5, 3.5]);
    const log = db.readPage('Log', 'table', 10, 0);
    expect(log.columns).toEqual(['A', 'B', 'C']);
    // dates as ISO text, TRUE as 1, gaps as NULL
    expect(log.rows).toEqual([
      ['2026-01-15', 1, null],
      ['2026-01-16', null, 'late column'],
      [null, 7, null],
    ]);
    db.close();
  });

  it('adds columns when a later row is wider than the table', async () => {
    const db = await SqliteDatabase.open();
    const sink = tableSink(db);
    sink.beginSheet('Wide');
    for (let r = 0; r < 60; r++) sink.row(r, [r, 'x']);
    sink.row(60, [60, 'y', 'extra', 4]);
    await sink.endSheet();
    const page = db.readPage('Wide', 'table', 1, 60);
    expect(page.columns).toEqual(['A', 'B', 'C', 'D']);
    expect(page.rows[0]).toEqual([60, 'y', 'extra', 4]);
    expect(db.readPage('Wide', 'table', 1, 0).rows[0]).toEqual([0, 'x', null, null]);
    db.close();
  });

  it('writes a workbook as the editor holds it, asking for shared formulas', async () => {
    const wb = blankWorkbook('live');
    const sheet = wb.sheets[wb.sheetOrder[0]]!;
    sheet.cellData = { 0: { 0: { v: 2, t: 2 }, 1: { f: '=A1*10', si: 'sf1', v: 20 } }, 1: { 0: { v: 3, t: 2 }, 1: { si: 'sf1', v: 30 } } };
    const asked: string[] = [];
    const bytes = await writeXlsxStream(wb, undefined, {
      formulaOf: (id, r, c) => {
        asked.push(`${id === sheet.id}:${r},${c}`);
        return '=A2*10';
      },
    });
    expect(asked).toEqual(['true:1,1']);
    const back = (await readXlsxStream(blobOf(bytes), 'live')).workbook;
    expect(back.sheets[back.sheetOrder[0]].cellData![1][1].f).toBe('=A2*10');
    // the snapshot handed in is not changed
    expect(sheet.cellData[1][1].f).toBeUndefined();
  });
});

describe('large CSV files', () => {
  const lines = ['id,name,note'];
  for (let i = 1; i <= 400; i++) lines.push(`${i},"Person ${i}","line one\nline ""two"", with a comma"`);
  lines.push('', '401,last,"café"', '', '');
  const text = lines.join('\r\n');

  it('reads the same workbook in pieces as it does whole', async () => {
    const whole = readDelimited(new TextEncoder().encode(text), 'people.csv');
    for (const pieceBytes of [64, 1000, 1 << 20]) {
      const { workbook, cells } = await readDelimitedStream(blobOf(text), 'people.csv', undefined, { pieceBytes });
      expect(sheetToRows(workbook)).toEqual(sheetToRows(whole));
      expect(cells).toBe(3 + 400 * 3 + 3);
      expect(workbook.sheets[workbook.sheetOrder[0]].name).toBe('people');
    }
    const { workbook } = await readDelimitedStream(blobOf(text), 'people.csv', undefined, { pieceBytes: 300 });
    const cells = workbook.sheets[workbook.sheetOrder[0]].cellData!;
    expect(cells[1][0]).toEqual({ v: 1, t: 2 });
    expect(cells[2][2]).toEqual({ v: 'line one\nline "two", with a comma', t: 1 });
    // the empty line inside the data is kept, the ones at the end are not
    expect(cells[401]).toBeUndefined();
    expect(cells[402][2].v).toBe('café');
    expect(Object.keys(cells)).toHaveLength(402);
  });

  it('reports progress and stops at the cell limit', async () => {
    let last = 0;
    await readDelimitedStream(blobOf(text), 'people.csv', undefined, { pieceBytes: 500, onProgress: (p) => (last = p.fraction) });
    expect(last).toBe(1);
    await expect(readDelimitedStream(blobOf(text), 'people.csv', undefined, { pieceBytes: 500, maxCells: 100 })).rejects.toBeInstanceOf(WorkbookTooLargeError);
  });

  it('falls back to Windows-1252 when the file is not UTF-8, and reads UTF-16', async () => {
    const latin = new Uint8Array([...new TextEncoder().encode('name;town\r\nRen'), 0xe9, ...new TextEncoder().encode(';K'), 0xf6, ...new TextEncoder().encode('ln\r\n')]);
    const { workbook } = await readDelimitedStream(blobOf(latin), 'towns.csv', undefined, { pieceBytes: 7 });
    expect(sheetToRows(workbook)).toEqual([['name', 'town'], ['René', 'Köln']]);

    const utf16 = new Uint8Array(2 + 'a\tb\n1\t2\n'.length * 2);
    utf16.set([0xff, 0xfe]);
    [...'a\tb\n1\t2\n'].forEach((ch, i) => (utf16[2 + i * 2] = ch.charCodeAt(0)));
    const tsv = await readDelimitedStream(blobOf(utf16), 'data.tsv', '\t', { pieceBytes: 6 });
    expect(sheetToRows(tsv.workbook)).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('reads a CSV file row by row into a table', async () => {
    const db = await SqliteDatabase.open();
    const sink = tableSink(db);
    await readDelimitedRows(blobOf(text), 'people.csv', sink, () => sink.abort(), undefined, { pieceBytes: 700 });
    expect(sink.tables).toEqual([{ name: 'people', columns: 3, rows: 401, header: true }]);
    const page = db.readPage('people', 'table', 1, 400);
    expect(page.columns).toEqual(['id', 'name', 'note']);
    expect(page.rows[0]).toEqual([401, 'last', 'café']);
    db.close();
  });

  it('starts the table again when the encoding turns out to be Windows-1252', async () => {
    const rows = Array.from({ length: 80 }, (_, i) => `${i},plain`).join('\n');
    const bytes = new Uint8Array([...new TextEncoder().encode(`n,word\n${rows}\n99,caf`), 0xe9, 10]);
    const db = await SqliteDatabase.open();
    const sink = tableSink(db);
    await readDelimitedRows(blobOf(bytes), 'words.csv', sink, () => sink.abort(), undefined, { pieceBytes: 128 });
    expect(sink.tables).toEqual([{ name: 'words', columns: 2, rows: 81, header: true }]);
    expect(db.readPage('words', 'table', 1, 80).rows[0]).toEqual([99, 'café']);
    expect(db.listObjects().map((o) => o.name)).toEqual(['words']);
    db.close();
  });
});

describe('database helpers', () => {
  it('makes tables and columns, and finds the longest values of a column', async () => {
    const db = await SqliteDatabase.open();
    db.createTable('notes', [{ name: 'id', type: 'INTEGER', pk: true }, { name: 'title', type: 'TEXT' }]);
    db.addColumn('notes', 'score', 'REAL');
    expect(db.listObjects()[0].columns.map((c) => `${c.name} ${c.type}${c.pk ? ' pk' : ''}`)).toEqual(['id INTEGER pk', 'title TEXT', 'score REAL']);
    db.insertRow('notes', { title: 'short', score: 1.5 });
    db.insertRow('notes', { title: 'the longest title of them all', score: 2 });
    db.insertRow('notes', { title: null, score: 123456.789 });
    expect(db.longestValues('notes', 'title', 1)).toEqual(['the longest title of them all']);
    expect(db.longestValues('notes', 'score')[0]).toBe('123456.789');
    // a known row count is used as given
    expect(db.readPage('notes', 'table', 10, 0, 42).total).toBe(42);
    expect(db.readPage('notes', 'table', 10, 0).total).toBe(3);
    db.close();
  });
});
