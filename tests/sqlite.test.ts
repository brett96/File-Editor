import { describe, expect, it } from 'vitest';
import { cellDisplay, isSqliteFile, SqliteDatabase } from '../src/core/db/sqlite';

describe('sqlite', () => {
  it('detects SQLite by magic bytes and extension', () => {
    const magic = new TextEncoder().encode('SQLite format 3\0…..');
    expect(isSqliteFile('notes.bin', magic)).toBe(true);
    expect(isSqliteFile('app.sqlite')).toBe(true);
    expect(isSqliteFile('data.DB')).toBe(true);
    // With bytes present, extension alone is not enough (avoids false .db matches)
    expect(isSqliteFile('readme.txt', new TextEncoder().encode('not a database!!!!'))).toBe(false);
    expect(isSqliteFile('fake.db', new TextEncoder().encode('not a database!!!!'))).toBe(false);
  });

  it('creates, edits and exports a database', async () => {
    const db = await SqliteDatabase.open();
    db.exec('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)');
    db.insertRow('people', { name: 'Ada', age: 36 });
    db.insertRow('people', { name: 'Grace', age: 45 });
    const objects = db.listObjects();
    expect(objects.map((o) => o.name)).toEqual(['people']);
    expect(objects[0].columns.map((c) => c.name)).toEqual(['id', 'name', 'age']);

    let page = db.readPage('people', 'table', 10, 0);
    expect(page.total).toBe(2);
    expect(page.rows.map((r) => r[1])).toEqual(['Ada', 'Grace']);

    db.updateCell('people', page.rowids[0], 'age', 37);
    page = db.readPage('people', 'table', 10, 0);
    expect(page.rows[0][2]).toBe(37);

    db.deleteRows('people', [page.rowids[1]]);
    page = db.readPage('people', 'table', 10, 0);
    expect(page.total).toBe(1);

    const bytes = db.export();
    expect(isSqliteFile('roundtrip.sqlite', bytes)).toBe(true);
    db.close();

    const again = await SqliteDatabase.open(bytes);
    expect(again.readPage('people', 'table', 10, 0).rows[0][1]).toBe('Ada');
    again.close();
  });

  it('formats cells for display', () => {
    expect(cellDisplay(null)).toBe('');
    expect(cellDisplay('hi')).toBe('hi');
    expect(cellDisplay(3)).toBe('3');
    expect(cellDisplay(new Uint8Array([1, 2, 3]))).toBe('[BLOB 3 B]');
  });

  it('reads a large SQL result a page at a time', async () => {
    const db = await SqliteDatabase.open();
    db.exec('CREATE TABLE t ("Patient Name" TEXT, n INTEGER)');
    db.exec("WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 20000) INSERT INTO t SELECT CASE WHEN i % 2 THEN 'P' || i END, i FROM c");

    const res = db.query('SELECT * FROM t WHERE "Patient Name" IS NOT NULL ORDER BY n DESC; -- newest first\n', 200)!;
    expect(res.columns).toEqual(['Patient Name', 'n']);
    expect(res.total).toBe(10000);
    expect(res.rows).toHaveLength(200);
    expect(res.rows[0]).toEqual(['P19999', 19999]);
    expect(res.query).not.toBeNull();
    const last = db.queryPage(res.query!, 200, 9800);
    expect(last).toHaveLength(200);
    expect(last[199]).toEqual(['P1', 1]);
    expect(db.queryPage(res.query!, 200, 10000)).toEqual([]);

    // duplicate column names survive, and a query's own LIMIT is respected
    const dup = db.query('SELECT n, n FROM t LIMIT 3')!;
    expect(dup.columns).toEqual(['n', 'n']);
    expect(dup.total).toBe(3);
    expect(dup.rows).toEqual([[1, 1], [2, 2], [3, 3]]);
    db.close();
  });

  it('runs scripts and statements that are not plain queries', async () => {
    const db = await SqliteDatabase.open();
    expect(db.query('CREATE TABLE t (a); INSERT INTO t VALUES (1), (2);')).toBeNull();
    expect(db.query('  ')).toBeNull();

    // a statement that writes runs exactly once and to the end, keeping only its first rows
    const ret = db.query('WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 6000) INSERT INTO t SELECT i FROM c RETURNING a')!;
    expect(ret.query).toBeNull();
    expect(ret.total).toBe(6000);
    expect(ret.rows).toHaveLength(5000);
    expect(db.query('SELECT COUNT(*) FROM t')!.rows).toEqual([[6002]]);

    const pragma = db.query('PRAGMA table_info(t)')!;
    expect(pragma.query).toBeNull();
    expect(pragma.rows).toHaveLength(1);

    // the result is the last statement that returns rows, even when a write follows it
    const mixed = db.query('SELECT a FROM t WHERE a = 2; DELETE FROM t WHERE a > 2;')!;
    expect(mixed.rows).toEqual([[2], [2]]);
    expect(mixed.query).toBeNull();
    expect(db.query('SELECT COUNT(*) FROM t')!.rows).toEqual([[4]]);

    expect(() => db.query('SELECT * FROM missing')).toThrow(/missing/);
    db.close();
  });
});
