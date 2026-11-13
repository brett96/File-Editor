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
});
