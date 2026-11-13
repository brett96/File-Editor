import { describe, expect, it } from 'vitest';
import { liteDbTables, liteDbVersion, readLiteDb } from '../src/core/db/litedb';
import { SqliteDatabase, describeNonSqlite } from '../src/core/db/sqlite';

// ── a tiny writer for LiteDB's v4 layout (file version 7), enough to build fixtures ──
class W {
  parts: number[] = [];
  u8(v: number) { this.parts.push(v & 0xff); return this; }
  u16(v: number) { return this.u8(v).u8(v >>> 8); }
  u32(v: number) { return this.u16(v & 0xffff).u16(v >>> 16); }
  i64(v: bigint) { const b = new DataView(new ArrayBuffer(8)); b.setBigInt64(0, v, true); return this.bytes(new Uint8Array(b.buffer)); }
  f64(v: number) { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v, true); return this.bytes(new Uint8Array(b.buffer)); }
  bytes(b: ArrayLike<number>) { for (let i = 0; i < b.length; i++) this.parts.push(b[i]); return this; }
  text(s: string) { return this.bytes(new TextEncoder().encode(s)); }
  /** LiteDB string: int32 byte length + UTF-8 */
  str(s: string) { const b = new TextEncoder().encode(s); return this.u32(b.length).bytes(b); }
  addr(page: number, slot: number) { return this.u32(page).u16(slot); }
  get out() { return Uint8Array.from(this.parts); }
}

type Doc = Record<string, unknown>;
const GUID = Uint8Array.from([0xd2, 0x8a, 0x8d, 0x86, 0xb7, 0xee, 0x00, 0x47, 0x8d, 0x84, 0x18, 0x64, 0xdd, 0xa4, 0x2a, 0x78]);

function bson(doc: Doc): Uint8Array {
  const w = new W();
  for (const [k, v] of Object.entries(doc)) {
    const name = () => w.text(k).u8(0);
    if (v === null) { w.u8(0x0a); name(); }
    else if (typeof v === 'string') { w.u8(0x02); name(); const b = new TextEncoder().encode(v); w.u32(b.length + 1).bytes(b).u8(0); }
    else if (typeof v === 'boolean') { w.u8(0x08); name(); w.u8(v ? 1 : 0); }
    else if (typeof v === 'bigint') { w.u8(0x12); name(); w.i64(v); }
    else if (typeof v === 'number') { if (Number.isInteger(v)) { w.u8(0x10); name(); w.u32(v >>> 0); } else { w.u8(0x01); name(); w.f64(v); } }
    else if (v instanceof Date) { w.u8(0x09); name(); w.i64(BigInt(v.getTime())); }
    else if (v instanceof Uint8Array) { w.u8(0x05); name(); w.u32(v.length).u8(v === GUID ? 4 : 0).bytes(v); }
    else if (Array.isArray(v)) { w.u8(0x04); name(); w.bytes(bson(Object.fromEntries(v.map((x, i) => [String(i), x])))); }
    else if ((v as { $decimal?: number[] }).$decimal) { w.u8(0x13); name(); for (const n of (v as { $decimal: number[] }).$decimal) w.u32(n >>> 0); }
    else { w.u8(0x03); name(); w.bytes(bson(v as Doc)); }
  }
  const body = w.out;
  return new W().u32(body.length + 5).bytes(body).u8(0).out;
}

const NONE = 0xffffffff;
const PAGE = 4096;

function page(id: number, type: number, items: number, body: Uint8Array, next = NONE): Uint8Array {
  const out = new Uint8Array(PAGE);
  out.set(new W().u32(id).u8(type).u32(NONE).u32(next).u16(items).u16(0).out, 0);
  out.set(body, 25);
  return out;
}

/** One collection whose documents live in data page 4 (and extend pages from 5 on). */
function buildV4(collection: string, docs: Doc[], opts: { password?: boolean } = {}): Uint8Array {
  const header = new W().text('** This is a LiteDB file **').u8(7).u16(1).u32(NONE).u32(0).u16(0);
  header.bytes(new Uint8Array(20).fill(opts.password ? 9 : 0)).bytes(new Uint8Array(16)).u8(1).str(collection).u32(2);
  const pages: Uint8Array[] = [page(0, 1, 1, header.out), new Uint8Array(PAGE)];

  const col = new W().str(collection).i64(BigInt(docs.length)).u32(NONE).str('_id=$._id').u8(1).addr(3, 0).addr(3, 1).u32(NONE);
  pages.push(page(2, 2, 1, col.out));

  // index: head (slot 0) → one node per document (slots 2…) → tail (slot 1)
  const index = new W();
  const node = (slot: number, key: () => void, keyLen: number, data: [number, number], next: [number, number]) => {
    index.u16(slot).u8(1).u8(0).addr(NONE, 0xffff).addr(NONE, 0xffff).u16(keyLen);
    key();
    index.addr(...data).addr(NONE, 0xffff).addr(...next);
  };
  node(0, () => index.u8(0), 0, [NONE, 0xffff], docs.length ? [3, 2] : [3, 1]);
  node(1, () => index.u8(14), 0, [NONE, 0xffff], [NONE, 0xffff]);
  docs.forEach((_d, i) => node(2 + i, () => index.u8(2).u32(i + 1), 4, [4, i], i + 1 < docs.length ? [3, 3 + i] : [3, 1]));
  pages.push(page(3, 3, docs.length + 2, index.out));

  const data = new W();
  const extend: Uint8Array[] = [];
  docs.forEach((d, i) => {
    const bytes = bson(d);
    if (bytes.length > 1500) {
      // large document: all of it goes to a chain of extend pages
      const first = 5 + extend.length;
      const chunks: Uint8Array[] = [];
      for (let o = 0; o < bytes.length; o += 4000) chunks.push(bytes.subarray(o, o + 4000));
      chunks.forEach((c, k) => extend.push(page(first + k, 5, c.length, c, k + 1 < chunks.length ? first + k + 1 : NONE)));
      data.u16(i).u32(first).u16(0);
    } else {
      data.u16(i).u32(NONE).u16(bytes.length).bytes(bytes);
    }
  });
  pages.push(page(4, 4, docs.length, data.out), ...extend);
  const out = new Uint8Array(pages.length * PAGE);
  pages.forEach((p, i) => out.set(p, i * PAGE));
  return out;
}

const DOCS: Doc[] = [
  {
    _id: GUID,
    caseNo: 'SA-1',
    count: 42,
    millis: 1771008413264n,
    ratio: 0.5,
    open: true,
    notes: null,
    when: new Date(Date.UTC(2026, 1, 13, 12, 0, 0)),
    tags: ['a', 'b'],
    address: { city: 'Zürich', zip: 8001 },
    price: { $decimal: [12345, 0, 0, 2 << 16] },
    blob: Uint8Array.from([1, 2, 3]),
  },
  { _id: 2, caseNo: 'SA-2', long: 'x'.repeat(9000), count: 2.5, extra: 'only here' },
  { _id: 3, caseNo: 'SA-3', open: false },
];

describe('LiteDB', () => {
  it('recognises the two layouts by their header', () => {
    const v4 = buildV4('cases', []);
    expect(liteDbVersion(v4.subarray(0, 64))).toBe(4);
    const v5 = new Uint8Array(64);
    v5.set(new TextEncoder().encode('** This is a LiteDB file **'), 32);
    expect(liteDbVersion(v5)).toBe(5);
    expect(liteDbVersion(new TextEncoder().encode('SQLite format 3\0' + ' '.repeat(60)))).toBeNull();
  });

  it('reads documents by walking the _id index, including ones that span extend pages', () => {
    const db = readLiteDb(buildV4('cases', DOCS));
    expect(db.version).toBe(4);
    expect(db.warnings).toEqual([]);
    expect(db.collections.map((c) => c.name)).toEqual(['cases']);
    const [a, b, c] = db.collections[0].documents;
    expect(a._id).toBe('868d8ad2-eeb7-4700-8d84-1864dda42a78');
    expect(a).toMatchObject({ caseNo: 'SA-1', count: 42, millis: 1771008413264, ratio: 0.5, open: true, notes: null, tags: ['a', 'b'], address: { city: 'Zürich', zip: 8001 }, price: 123.45 });
    expect((a.when as Date).toISOString()).toBe('2026-02-13T12:00:00.000Z');
    expect([...(a.blob as Uint8Array)]).toEqual([1, 2, 3]);
    expect((b.long as string).length).toBe(9000);
    expect(b.extra).toBe('only here');
    expect(c).toEqual({ _id: 3, caseNo: 'SA-3', open: false });
  });

  it('turns collections into tables that load into SQLite', async () => {
    const tables = liteDbTables(readLiteDb(buildV4('cases', DOCS)));
    expect(tables).toHaveLength(1);
    const cols = Object.fromEntries(tables[0].columns.map((c) => [c.name, c.type]));
    expect(cols).toMatchObject({ _id: 'TEXT', caseNo: 'TEXT', count: 'REAL', millis: 'INTEGER', open: 'INTEGER', when: 'TEXT', tags: 'TEXT', address: 'TEXT', price: 'REAL', blob: 'BLOB', extra: 'TEXT' });
    const db = await SqliteDatabase.open();
    for (const t of tables) db.importTable(t.name, t.columns, t.rows);
    expect(db.listObjects().map((o) => o.name)).toEqual(['cases']);
    const page = db.readPage('cases', 'table', 10, 0);
    expect(page.total).toBe(3);
    const r = db.exec(`SELECT caseNo, json_extract(address, '$.city'), "when", open FROM cases ORDER BY caseNo`)!;
    expect(r.rows[0]).toEqual(['SA-1', 'Zürich', '2026-02-13T12:00:00.000Z', 1]);
    expect(r.rows[2]).toEqual(['SA-3', null, null, 0]);
    // the import is an ordinary, editable SQLite database
    db.updateCell('cases', page.rowids[0], 'caseNo', 'SA-1b');
    const again = await SqliteDatabase.open(db.export());
    expect(again.exec('SELECT caseNo FROM cases ORDER BY rowid')!.rows[0][0]).toBe('SA-1b');
    db.close();
    again.close();
  });

  it('handles an empty collection and refuses encrypted files', () => {
    const empty = readLiteDb(buildV4('nothing', []));
    expect(empty.collections).toEqual([{ name: 'nothing', documents: [] }]);
    expect(liteDbTables(empty)[0]).toEqual({ name: 'nothing', columns: [], rows: [] });
    expect(() => readLiteDb(buildV4('cases', DOCS, { password: true }))).toThrow(/password protected/);
    expect(() => readLiteDb(new Uint8Array(100))).toThrow(/not a LiteDB/);
  });

  it('reports a damaged collection instead of failing the whole file', () => {
    const bytes = buildV4('cases', DOCS);
    bytes.fill(0xee, 4 * PAGE + 25, 4 * PAGE + 200); // wreck the data page
    const db = readLiteDb(bytes);
    expect(db.collections[0].name).toBe('cases');
    expect(db.warnings.join(' ')).toMatch(/cases/);
  });

  it('names common non-SQLite .db files', () => {
    const access = new Uint8Array(64);
    access.set(new TextEncoder().encode('Standard Jet DB'), 4);
    expect(describeNonSqlite(access)).toMatch(/Access/);
    expect(describeNonSqlite(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]))).toMatch(/compound/);
    expect(describeNonSqlite(new Uint8Array(64))).toBeNull();
  });
});

