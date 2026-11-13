import { describe, expect, it } from 'vitest';
import { SqliteDatabase } from '../src/core/db/sqlite';
import { buildTable, columnsFromRow, isDateFormat, planTables, serialToIso, uniqueColumnNames } from '../src/core/sheet/to-database';
import { blankSheet, type ICellData, type IWorkbookData } from '../src/core/sheet/workbook';

type V = string | number | boolean | null | ICellData;

function workbook(sheets: Record<string, V[][]>, styles: IWorkbookData['styles'] = {}): IWorkbookData {
  const wb: IWorkbookData = { id: 'wb', name: 'wb', appVersion: '1', locale: 'enUS' as IWorkbookData['locale'], styles, sheetOrder: [], sheets: {} };
  for (const [name, rows] of Object.entries(sheets)) {
    const sheet = blankSheet(name, `id-${name}`);
    const cellData: Record<number, Record<number, ICellData>> = {};
    rows.forEach((row, r) =>
      row.forEach((v, c) => {
        if (v === null) return;
        (cellData[r] ??= {})[c] = typeof v === 'object' ? v : typeof v === 'number' ? { v, t: 2 } : typeof v === 'boolean' ? { v: v ? 1 : 0, t: 3 } : { v, t: 1 };
      }),
    );
    sheet.cellData = cellData;
    wb.sheets[sheet.id] = sheet;
    wb.sheetOrder.push(sheet.id);
  }
  return wb;
}

describe('spreadsheet → database', () => {
  it('finds a clear heading row over numeric data', () => {
    const wb = workbook({ Sales: [['Item', 'Qty', 'Price'], ['Apple', 3, 1.5], ['Pear', 5, 2.25]] });
    const [plan] = planTables(wb);
    expect(plan).toMatchObject({ tableName: 'Sales', headerRow: 0, confident: true, columns: ['Item', 'Qty', 'Price'], firstRow: 0, lastRow: 2 });
    const table = buildTable(wb, plan);
    expect(table.columns).toEqual([{ name: 'Item', type: 'TEXT' }, { name: 'Qty', type: 'INTEGER' }, { name: 'Price', type: 'REAL' }]);
    expect(table.rows).toEqual([['Apple', 3, 1.5], ['Pear', 5, 2.25]]);
  });

  it('trusts a bold or frozen heading row over text-only data', () => {
    const rows: V[][] = [[{ v: 'First', t: 1, s: 'b' }, { v: 'Last', t: 1, s: 'b' }], ['Ada', 'Lovelace'], ['Alan', 'Turing']];
    expect(planTables(workbook({ People: rows }, { b: { bl: 1 } }))[0]).toMatchObject({ headerRow: 0, confident: true });
    const frozen = workbook({ People: [['First', 'Last'], ['Ada', 'Lovelace']] });
    frozen.sheets['id-People']!.freeze = { xSplit: 0, ySplit: 1, startRow: 1, startColumn: 0 };
    expect(planTables(frozen)[0]).toMatchObject({ headerRow: 0, confident: true });
  });

  it('asks when the heading row is not clear', () => {
    const wb = workbook({
      AllText: [['First', 'Last'], ['Ada', 'Lovelace'], ['Alan', 'Turing']],
      Numbers: [[1, 2, 3], [4, 5, 6]],
      Gaps: [['Name', null, 'Total'], ['a', 1, 2]],
      Repeats: [['x', 'x'], ['a', 1]],
      One: [['only', 'row']],
      Empty: [],
    });
    const plans = planTables(wb);
    expect(plans.map((p) => p.sheetName)).toEqual(['AllText', 'Numbers', 'Gaps', 'Repeats', 'One']);
    expect(plans.every((p) => !p.confident && !!p.reason)).toBe(true);
    expect(plans[0]).toMatchObject({ headerRow: 0, columns: ['First', 'Last'] });
    // numbers on top: suggested as data, columns named by letter
    expect(plans[1]).toMatchObject({ headerRow: null, columns: ['A', 'B', 'C'] });
    expect(plans[2].columns).toEqual(['Name', 'B', 'Total']);
    expect(plans[3].columns).toEqual(['x', 'x_2']);
    expect(plans[4]).toMatchObject({ headerRow: null });
    expect(plans[0].preview).toEqual([['First', 'Last'], ['Ada', 'Lovelace'], ['Alan', 'Turing']]);
  });

  it('follows the choice the person makes', () => {
    const wb = workbook({ Report: [['Quarterly report', null], ['Region', 'Units'], ['North', 10], ['South', 12]] });
    const [plan] = planTables(wb);
    expect(plan.confident).toBe(false);
    // pick row 2 as the heading row: the title above it is left out
    const picked = { ...plan, headerRow: 1, columns: columnsFromRow(wb, plan, 1) };
    expect(picked.columns).toEqual(['Region', 'Units']);
    expect(buildTable(wb, picked).rows).toEqual([['North', 10], ['South', 12]]);
    // no heading row, names typed by hand
    const typed = buildTable(wb, { ...plan, headerRow: null, columns: ['label', 'amount'] });
    expect(typed.columns.map((c) => c.name)).toEqual(['label', 'amount']);
    expect(typed.rows).toHaveLength(4);
    expect(typed.columns[1].type).toBe('TEXT'); // "Units" and numbers share the column
  });

  it('starts at the used area, wherever it is', () => {
    const wb = workbook({ Offset: [[], [], [null, null, 'City', 'Pop'], [null, null, 'Oslo', 700000], [], [null, null, 'Bergen', 285000]] });
    const [plan] = planTables(wb);
    expect(plan).toMatchObject({ firstRow: 2, firstCol: 2, lastCol: 3, headerRow: 2, confident: true });
    expect(buildTable(wb, plan).rows).toEqual([['Oslo', 700000], ['Bergen', 285000]]); // the blank row is dropped
  });

  it('converts values: formula results, booleans, dates, text numbers', () => {
    const wb = workbook(
      {
        Mixed: [
          ['What', 'Value'],
          ['sum', { f: '=1+2', v: 3 }],
          ['flag', true],
          ['day', { v: 46037, t: 2, s: 'd' }],
          ['moment', { v: 46037.5625, t: 2, s: 'dt' }],
          ['code', { v: '00123', t: 1 }],
          ['money', { v: 12.5, t: 2, s: 'm' }],
        ],
      },
      { d: { n: { pattern: 'yyyy-mm-dd' } }, dt: { n: { pattern: 'm/d/yy h:mm' } }, m: { n: { pattern: '$#,##0.00' } } },
    );
    const table = buildTable(wb, planTables(wb)[0]);
    expect(table.rows.map((r) => r[1])).toEqual([3, 1, '2026-01-15', '2026-01-15 13:30:00', '00123', 12.5]);
    expect(isDateFormat('mm-dd-yy')).toBe(true);
    expect(isDateFormat('[h]:mm:ss')).toBe(true);
    expect(isDateFormat('#,##0.00 "days"')).toBe(false);
    expect(isDateFormat('0.00%')).toBe(false);
    expect(serialToIso(0.5)).toBe('12:00:00');
  });

  it('makes column and table names valid and distinct', () => {
    expect(uniqueColumnNames(['Name', 'name', '', '  spaced   out ', null], 0)).toEqual(['Name', 'name_2', 'C', 'spaced out', 'E']);
    const wb = workbook({ Data: [['a', 'b'], [1, 2]], data: [['a', 'b'], [3, 4]] });
    expect(planTables(wb).map((p) => p.tableName)).toEqual(['Data', 'data_2']);
  });

  it('loads every sheet into SQLite as a table', async () => {
    const wb = workbook({
      Sales: [['Item', 'Qty'], ['Apple', 3], ['Pear', 5]],
      'Odd "name"': [['select', 'from'], ['x', 1]],
    });
    const db = await SqliteDatabase.open();
    for (const plan of planTables(wb)) {
      const t = buildTable(wb, plan);
      db.importTable(t.name, t.columns, t.rows);
    }
    expect(db.listObjects().map((o) => o.name)).toEqual(['Odd "name"', 'Sales']);
    expect(db.exec('SELECT SUM(Qty) FROM Sales')!.rows[0][0]).toBe(8);
    expect(db.exec('SELECT "select", "from" FROM "Odd ""name"""')!.rows).toEqual([['x', 1]]);
    const reopened = await SqliteDatabase.open(db.export());
    expect(reopened.readPage('Sales', 'table', 10, 0).total).toBe(2);
    db.close();
    reopened.close();
  });
});
