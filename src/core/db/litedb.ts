/**
 * LiteDB (.db) reader. LiteDB is the embedded document database used by many .NET desktop
 * apps; its files carry the text "** This is a LiteDB file **" in the first page.
 *
 * Read-only: collections come out as lists of documents, which the app loads into an
 * in-memory SQLite database (see liteDbToSqlite) so they can be browsed and queried with the
 * database editor. Nothing is written back in LiteDB's own format.
 *
 * Two on-disk layouts exist:
 *  - v4 (file version 7, LiteDB 3.x / 4.x): 4096-byte pages with a 25-byte header. Documents
 *    are found by walking each collection's `_id` index (a skip list) at its lowest level.
 *  - v5 (file version 8, LiteDB 5.x): 8192-byte pages with a 32-byte header that names the
 *    owning collection, so documents are found by scanning that collection's data pages.
 * Password-protected files (AES) are recognised and refused with a clear message.
 */
import { UnsupportedError } from '../types';

const MARKER = '** This is a LiteDB file **';
const NONE = 0xffffffff;

export type LiteValue =
  | null
  | boolean
  | number
  | string
  | bigint
  | Date
  | Uint8Array
  | LiteValue[]
  | { [key: string]: LiteValue };

export type LiteDocument = { [key: string]: LiteValue };

export interface LiteIndex {
  /** Slot in the collection's index list (0 is always `_id`). */
  slot: number;
  field: string;
  /** The indexed expression, usually `$.field`. */
  expression: string;
  unique: boolean;
  /** Positions in `documents`, in the order this index lists them (v4 files; used to check key ordering). */
  order?: number[];
}

export interface LiteCollection {
  name: string;
  documents: LiteDocument[];
  /** Each document's stored bytes (BSON), parallel to `documents`. Kept for writing the file back. */
  raw?: Uint8Array[];
  indexes?: LiteIndex[];
  /** The collection's auto-id counter. */
  sequence?: bigint;
}

export interface LiteDatabase {
  /** 4 for LiteDB 3.x/4.x files, 5 for LiteDB 5.x files. */
  version: 4 | 5;
  collections: LiteCollection[];
  /** Problems that did not stop the read (e.g. a damaged document that was skipped). */
  warnings: string[];
  /** v4 files: header values carried over when the file is written back. */
  header?: { changeId: number; userVersion: number; salt: Uint8Array };
}

function asciiAt(b: Uint8Array, off: number, text: string): boolean {
  if (b.length < off + text.length) return false;
  for (let i = 0; i < text.length; i++) if (b[off + i] !== text.charCodeAt(i)) return false;
  return true;
}

/** Which LiteDB layout the file uses, from its first 64 bytes; null when it is not LiteDB. */
export function liteDbVersion(head: Uint8Array): 4 | 5 | null {
  if (asciiAt(head, 25, MARKER)) return 4;
  if (asciiAt(head, 32, MARKER)) return 5;
  return null;
}

// ── byte helpers ─────────────────────────────────────────────────────────────
const utf8 = new TextDecoder('utf-8');

class Reader {
  private view: DataView;
  constructor(
    private bytes: Uint8Array,
    public pos = 0,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get length(): number {
    return this.bytes.length;
  }
  private need(n: number): void {
    if (n < 0 || this.pos + n > this.bytes.length) throw new Error('Unexpected end of data.');
  }
  u8(): number {
    this.need(1);
    return this.bytes[this.pos++];
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i64(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  take(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  text(n: number): string {
    return utf8.decode(this.take(n));
  }
  /** Zero-terminated UTF-8 (BSON element names). */
  cstring(): string {
    let end = this.pos;
    while (end < this.bytes.length && this.bytes[end] !== 0) end++;
    if (end >= this.bytes.length) throw new Error('Unterminated name.');
    const s = utf8.decode(this.bytes.subarray(this.pos, end));
    this.pos = end + 1;
    return s;
  }
}

const safeInt = (v: bigint): number | bigint => (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const hex = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += HEX[b[i]];
  return s;
};

/** A .NET Guid from its ToByteArray() layout (first three groups little-endian). */
function guidText(b: Uint8Array): string {
  const h = (i: number) => HEX[b[i]];
  return `${h(3)}${h(2)}${h(1)}${h(0)}-${h(5)}${h(4)}-${h(7)}${h(6)}-${h(8)}${h(9)}-${h(10)}${h(11)}${h(12)}${h(13)}${h(14)}${h(15)}`;
}

/** A .NET System.Decimal (lo, mid, hi, flags as four little-endian int32) as a number or exact text. */
function decimalValue(b: Uint8Array): number | string {
  const v = new DataView(b.buffer, b.byteOffset, 16);
  const mantissa = (BigInt(v.getUint32(8, true)) << 64n) | (BigInt(v.getUint32(4, true)) << 32n) | BigInt(v.getUint32(0, true));
  const flags = v.getUint32(12, true);
  const scale = (flags >>> 16) & 0xff;
  const negative = (flags & 0x80000000) !== 0;
  let digits = mantissa.toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, '0');
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '');
  }
  const text = `${negative && mantissa !== 0n ? '-' : ''}${digits}`;
  const n = Number(text);
  // keep the exact digits when a double would round them
  return Number.isFinite(n) && String(n) === text ? n : text;
}

/** Milliseconds since 1970 (UTC); out-of-range values (DateTime.MinValue/MaxValue) are clamped. */
function dateValue(ms: bigint): Date {
  const n = Number(ms);
  return new Date(Math.max(-8.64e15, Math.min(8.64e15, n)));
}

// ── BSON (documents, as both layouts store them) ─────────────────────────────
const MAX_DEPTH = 64;

export function decodeBson(bytes: Uint8Array): LiteDocument {
  return readBsonDocument(new Reader(bytes));
}

function readBsonDocument(r: Reader, depth = 0): LiteDocument {
  if (depth > MAX_DEPTH) throw new Error('Document is nested too deeply.');
  const start = r.pos;
  const length = r.i32();
  if (length < 5 || start + length > r.length) throw new Error('Bad document length.');
  const end = start + length - 1;
  const doc: LiteDocument = {};
  while (r.pos < end) {
    const type = r.u8();
    if (type === 0) break;
    const name = r.cstring();
    doc[name] = readBsonElement(r, type, depth);
  }
  r.pos = start + length;
  return doc;
}

function readBsonElement(r: Reader, type: number, depth: number): LiteValue {
  switch (type) {
    case 0x01:
      return r.f64();
    case 0x02: {
      const n = r.i32();
      if (n < 1) throw new Error('Bad string length.');
      const s = r.text(n - 1);
      r.pos += 1; // terminator
      return s;
    }
    case 0x03:
      return readBsonDocument(r, depth + 1);
    case 0x04: {
      const obj = readBsonDocument(r, depth + 1);
      return Object.values(obj);
    }
    case 0x05: {
      const n = r.i32();
      const subtype = r.u8();
      const data = r.take(n);
      // LiteDB writes Guid values as binary subtype 4
      if (subtype === 0x04 && n === 16) return guidText(data);
      return data.slice();
    }
    case 0x07:
      return hex(r.take(12));
    case 0x08:
      return r.u8() !== 0;
    case 0x09:
      return dateValue(r.i64());
    case 0x0a:
    case 0x06:
      return null;
    case 0x10:
      return r.i32();
    case 0x12:
      return safeInt(r.i64());
    case 0x13:
      return decimalValue(r.take(16));
    case 0xff:
      return '$minValue';
    case 0x7f:
      return '$maxValue';
    default:
      throw new Error(`Unknown value type 0x${type.toString(16)}.`);
  }
}

// ── v4 ───────────────────────────────────────────────────────────────────────
const V4_PAGE = 4096;
const V4_HEADER = 25;
const V4 = { collection: 2, index: 3, data: 4, extend: 5 } as const;

interface V4Page {
  type: number;
  next: number;
  items: number;
  body: Reader;
}

function readV4(bytes: Uint8Array): LiteDatabase {
  const pageCount = Math.floor(bytes.length / V4_PAGE);
  const pageAt = (id: number): V4Page => {
    if (id >= pageCount) throw new Error(`Page ${id} is outside the file.`);
    const r = new Reader(bytes.subarray(id * V4_PAGE, (id + 1) * V4_PAGE));
    r.pos = 4;
    const type = r.u8();
    r.pos = 9;
    const next = r.u32();
    const items = r.u16();
    r.pos = V4_HEADER;
    return { type, next, items, body: r };
  };

  const header = new Reader(bytes.subarray(0, V4_PAGE), V4_HEADER + MARKER.length);
  const fileVersion = header.u8();
  if (fileVersion !== 7) throw new UnsupportedError(`This LiteDB file uses storage version ${fileVersion}, which File Editor can't read (it reads LiteDB 3, 4 and 5 files).`);
  const changeId = header.u16();
  header.pos += 4 + 4; // free-page list, last page
  const userVersion = header.u16();
  const passwordHash = header.take(20);
  if (passwordHash.some((b) => b !== 0)) {
    throw new UnsupportedError('This LiteDB database is password protected (encrypted), so its contents can\'t be read here. Open it in the app that created it and export the data.');
  }
  const salt = header.take(16).slice();
  const collectionCount = header.u8();
  const directory: { name: string; page: number }[] = [];
  for (let i = 0; i < collectionCount; i++) {
    const name = header.text(header.i32());
    directory.push({ name, page: header.u32() });
  }

  const warnings: string[] = [];

  /** Data blocks of a page, by slot number. */
  const blockCache = new Map<number, Map<number, { extend: number; data: Uint8Array }>>();
  const dataBlocks = (pageId: number) => {
    let blocks = blockCache.get(pageId);
    if (!blocks) {
      blocks = new Map();
      const page = pageAt(pageId);
      if (page.type !== V4.data) throw new Error(`Page ${pageId} is not a data page.`);
      for (let i = 0; i < page.items; i++) {
        const slot = page.body.u16();
        const extend = page.body.u32();
        const size = page.body.u16();
        blocks.set(slot, { extend, data: page.body.take(size) });
      }
      blockCache.set(pageId, blocks);
      if (blockCache.size > 64) blockCache.delete(blockCache.keys().next().value as number);
    }
    return blocks;
  };

  const documentBytes = (pageId: number, slot: number): Uint8Array => {
    const block = dataBlocks(pageId).get(slot);
    if (!block) throw new Error(`Missing data block ${pageId}:${slot}.`);
    let data = block.data;
    if (block.extend !== NONE) {
      // a document larger than a page continues in a chain of extend pages
      const parts: Uint8Array[] = [block.data];
      let total = block.data.length;
      const seen = new Set<number>();
      for (let id = block.extend; id !== NONE; ) {
        if (seen.has(id)) throw new Error('Extend pages form a loop.');
        seen.add(id);
        const page = pageAt(id);
        if (page.type !== V4.extend) throw new Error(`Page ${id} is not an extend page.`);
        const part = page.body.take(page.items);
        parts.push(part);
        total += part.length;
        id = page.next;
      }
      data = new Uint8Array(total);
      let o = 0;
      for (const p of parts) {
        data.set(p, o);
        o += p.length;
      }
    }
    return data;
  };

  /** Index nodes of a page: slot → [data block address, next node at level 0]. */
  const nodeCache = new Map<number, Map<number, { dataPage: number; dataSlot: number; nextPage: number; nextSlot: number }>>();
  const indexNodes = (pageId: number) => {
    let nodes = nodeCache.get(pageId);
    if (!nodes) {
      nodes = new Map();
      const page = pageAt(pageId);
      if (page.type !== V4.index) throw new Error(`Page ${pageId} is not an index page.`);
      const r = page.body;
      for (let i = 0; i < page.items; i++) {
        const slot = r.u16();
        const levels = r.u8();
        r.pos += 1 + 6 + 6; // slot in the collection's index list, prev/next node in page order
        const keyLength = r.u16();
        skipIndexKey(r, keyLength);
        const dataPage = r.u32();
        const dataSlot = r.u16();
        let nextPage = NONE;
        let nextSlot = 0;
        for (let level = 0; level < levels; level++) {
          r.pos += 6; // prev at this level
          const np = r.u32();
          const ns = r.u16();
          if (level === 0) {
            nextPage = np;
            nextSlot = ns;
          }
        }
        nodes.set(slot, { dataPage, dataSlot, nextPage, nextSlot });
      }
      nodeCache.set(pageId, nodes);
      if (nodeCache.size > 64) nodeCache.delete(nodeCache.keys().next().value as number);
    }
    return nodes;
  };

  const collections: LiteCollection[] = [];
  for (const entry of directory) {
    const documents: LiteDocument[] = [];
    const raw: Uint8Array[] = [];
    const indexes: LiteIndex[] = [];
    let sequence = 0n;
    let expected = 0;
    try {
      const page = pageAt(entry.page);
      if (page.type !== V4.collection) throw new Error('its collection page is missing');
      const r = page.body;
      r.text(r.i32()); // collection name
      expected = Number(r.i64());
      r.pos += 4; // free data page list
      const heads: { page: number; slot: number }[] = [];
      for (let slot = 0; slot < 16; slot++) {
        const def = r.text(r.i32()); // "field=expression"
        const unique = r.u8() !== 0;
        const headPage = r.u32();
        const headSlot = r.u16();
        r.pos += 6 + 4; // tail node, free index page list
        if (!def) continue;
        const eq = def.indexOf('=');
        indexes.push({ slot, field: eq < 0 ? def : def.slice(0, eq), expression: eq < 0 ? `$.${def}` : def.slice(eq + 1), unique });
        heads.push({ page: headPage, slot: headSlot });
      }
      sequence = new Reader(bytes.subarray(entry.page * V4_PAGE, (entry.page + 1) * V4_PAGE), V4_PAGE - 8).i64();
      if (!indexes.length || indexes[0].slot !== 0) throw new Error('its _id index is missing');

      const limit = pageCount * 256; // more nodes than could fit in the file means a loop
      /** Data block addresses in the order an index lists them (its lowest level). */
      const walk = (head: { page: number; slot: number }): [number, number][] => {
        const out: [number, number][] = [];
        let nodePage = head.page;
        let nodeSlot = head.slot;
        for (let steps = 0; nodePage !== NONE && steps < limit; steps++) {
          const node = indexNodes(nodePage).get(nodeSlot);
          if (!node) throw new Error(`index node ${nodePage}:${nodeSlot} is missing`);
          // the list's head and tail are sentinels that point at no document
          if (node.dataPage !== NONE) out.push([node.dataPage, node.dataSlot]);
          nodePage = node.nextPage;
          nodeSlot = node.nextSlot;
        }
        return out;
      };

      let skipped = 0;
      const position = new Map<string, number>();
      for (const [dataPage, dataSlot] of walk(heads[0])) {
        try {
          const data = documentBytes(dataPage, dataSlot);
          documents.push(readBsonDocument(new Reader(data)));
          raw.push(data);
          position.set(`${dataPage}:${dataSlot}`, documents.length - 1);
        } catch {
          skipped++;
        }
      }
      for (let i = 1; i < indexes.length; i++) {
        try {
          const order = walk(heads[i]).map(([p, s]) => position.get(`${p}:${s}`));
          if (order.length === documents.length && order.every((o) => o !== undefined)) indexes[i].order = order as number[];
        } catch {
          /* a damaged secondary index: the documents are still readable */
        }
      }
      indexes[0].order = documents.map((_d, i) => i);
      if (skipped) warnings.push(`${skipped} damaged document${skipped === 1 ? '' : 's'} in "${entry.name}" could not be read`);
      if (!skipped && expected !== documents.length) warnings.push(`"${entry.name}" lists ${expected} documents but ${documents.length} were found`);
    } catch (err) {
      warnings.push(`"${entry.name}" could not be read completely (${err instanceof Error ? err.message : 'damaged'})`);
    }
    collections.push({ name: entry.name, documents, raw, indexes, sequence });
  }
  return { version: 4, collections, warnings, header: { changeId, userVersion, salt } };
}

/** Skips an index key (see LiteDB's ByteReader.ReadBsonValue). `length` only matters for text and binary keys. */
function skipIndexKey(r: Reader, length: number): void {
  const type = r.u8();
  switch (type) {
    case 0: // MinValue
    case 1: // Null
    case 14: // MaxValue
      return;
    case 2: // Int32
      r.pos += 4;
      return;
    case 3: // Int64
    case 4: // Double
    case 13: // DateTime
      r.pos += 8;
      return;
    case 5: // Decimal
    case 11: // Guid
      r.pos += 16;
      return;
    case 6: // String
    case 9: // Binary
      r.pos += length;
      return;
    case 7: // Document
    case 8: // Array
      r.take(r.i32() - 4);
      return;
    case 10: // ObjectId
      r.pos += 12;
      return;
    case 12: // Boolean
      r.pos += 1;
      return;
    default:
      throw new Error(`unknown index key type ${type}`);
  }
}

// ── v5 ───────────────────────────────────────────────────────────────────────
const V5_PAGE = 8192;
const V5_HEADER = 32;
const V5_DATA = 4;
const V5_COLLECTIONS_AT = 192;

function readV5(bytes: Uint8Array): LiteDatabase {
  const pageCount = Math.floor(bytes.length / V5_PAGE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fileVersion = bytes[V5_HEADER + MARKER.length];
  if (fileVersion !== 8) throw new UnsupportedError(`This LiteDB file uses storage version ${fileVersion}, which File Editor can't read (it reads LiteDB 3, 4 and 5 files).`);

  const warnings: string[] = [];
  const directory = readBsonDocument(new Reader(bytes.subarray(0, V5_PAGE), V5_COLLECTIONS_AT));
  const byPage = new Map<number, LiteCollection>();
  const collections: LiteCollection[] = [];
  for (const [name, page] of Object.entries(directory)) {
    if (typeof page !== 'number') continue;
    const col: LiteCollection = { name, documents: [] };
    byPage.set(page, col);
    collections.push(col);
  }

  /** One slot of a data page: the block's bytes, or null for a free slot. */
  const block = (pageId: number, slot: number): Uint8Array | null => {
    if (pageId >= pageCount) return null;
    const base = pageId * V5_PAGE;
    const at = base + V5_PAGE - (slot + 1) * 4;
    const position = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    if (!position || !length || position < V5_HEADER || position + length > V5_PAGE) return null;
    return bytes.subarray(base + position, base + position + length);
  };

  const skipped = new Map<LiteCollection, number>();
  for (let id = 1; id < pageCount; id++) {
    const base = id * V5_PAGE;
    if (bytes[base + 4] !== V5_DATA) continue;
    const col = byPage.get(view.getUint32(base + 19, true));
    if (!col) continue;
    const highest = bytes[base + 30];
    if (highest === 0xff) continue;
    for (let slot = 0; slot <= highest; slot++) {
      const first = block(id, slot);
      // byte 0 marks a continuation of a document that starts in another block
      if (!first || first.length < 6 || first[0] !== 0) continue;
      try {
        const parts: Uint8Array[] = [];
        let total = 0;
        let cur: Uint8Array | null = first;
        for (let hops = 0; cur; hops++) {
          if (hops > pageCount * 255) throw new Error('loop');
          parts.push(cur.subarray(6));
          total += cur.length - 6;
          const nextPage = new DataView(cur.buffer, cur.byteOffset, 6).getUint32(1, true);
          if (nextPage === NONE) break;
          cur = block(nextPage, cur[5]);
          if (!cur) throw new Error('missing block');
        }
        let data = parts[0];
        if (parts.length > 1) {
          data = new Uint8Array(total);
          let o = 0;
          for (const p of parts) {
            data.set(p, o);
            o += p.length;
          }
        }
        col.documents.push(readBsonDocument(new Reader(data)));
      } catch {
        skipped.set(col, (skipped.get(col) ?? 0) + 1);
      }
    }
  }
  for (const [col, n] of skipped) warnings.push(`${n} damaged document${n === 1 ? '' : 's'} in "${col.name}" could not be read`);
  return { version: 5, collections, warnings };
}

/** Reads every collection of a LiteDB file. Throws UnsupportedError for encrypted files. */
export function readLiteDb(bytes: Uint8Array): LiteDatabase {
  const version = liteDbVersion(bytes.subarray(0, 64));
  if (version === 4) return readV4(bytes);
  if (version === 5) return readV5(bytes);
  throw new Error('This file is not a LiteDB database.');
}

// ── documents → table rows ───────────────────────────────────────────────────
export type LiteCell = string | number | null | Uint8Array;

export interface LiteTable {
  name: string;
  columns: { name: string; type: 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' }[];
  rows: LiteCell[][];
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `base64:${btoaBytes(value)}`;
  return value;
}

function btoaBytes(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function toCell(v: LiteValue | undefined): LiteCell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (v instanceof Uint8Array) return v;
  // nested documents and arrays: JSON, which SQLite's json_extract() can query
  return JSON.stringify(v, jsonReplacer);
}

/**
 * One table per collection: a column for every top-level field (in first-seen order), nested
 * documents and arrays as JSON text, dates as ISO 8601 text, booleans as 0/1.
 */
export function liteDbTables(db: LiteDatabase): LiteTable[] {
  return db.collections.map((col) => {
    const index = new Map<string, number>();
    const kinds: Set<string>[] = [];
    for (const doc of col.documents) {
      for (const key of Object.keys(doc)) {
        if (!index.has(key)) {
          index.set(key, index.size);
          kinds.push(new Set());
        }
      }
    }
    const rows = col.documents.map((doc) => {
      const row: LiteCell[] = new Array(index.size).fill(null);
      for (const [key, value] of Object.entries(doc)) {
        const i = index.get(key)!;
        const cell = toCell(value);
        row[i] = cell;
        if (cell === null) continue;
        kinds[i].add(cell instanceof Uint8Array ? 'BLOB' : typeof cell === 'string' ? 'TEXT' : Number.isInteger(cell) ? 'INTEGER' : 'REAL');
      }
      return row;
    });
    const columns = [...index.keys()].map((name, i) => {
      const k = kinds[i];
      const type = k.size === 1 ? ([...k][0] as LiteTable['columns'][number]['type']) : k.size === 2 && k.has('INTEGER') && k.has('REAL') ? 'REAL' : k.has('BLOB') && k.size === 1 ? 'BLOB' : 'TEXT';
      return { name, type };
    });
    // an empty collection still needs the one field every document has
    return { name: col.name, columns: columns.length ? columns : [{ name: '_id', type: 'TEXT' as const }], rows };
  });
}
