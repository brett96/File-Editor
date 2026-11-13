/**
 * Writes a LiteDB v4 file (storage version 7, LiteDB 3.x / 4.x) back from the tables it was
 * opened as, so the program that owns the database can keep using it.
 *
 * How edits map back to documents:
 *  - A row is matched to its original document by `_id`. A row that was not touched keeps
 *    the document's original bytes, so nothing about it can change by accident.
 *  - In an edited row only the changed fields are re-encoded, each in the type the field had
 *    (a date stays a date, a Guid a Guid, a 64-bit integer 64-bit). A value that no longer
 *    fits its old type (text typed into a number) is stored as what it now is.
 *  - New rows take each field's usual type in that collection; a missing `_id` is generated
 *    in the collection's own id type.
 *
 * The file is rebuilt compactly: header, then for every collection its page, data pages,
 * extend pages (documents larger than a page) and one skip list per index. The layout
 * rules — page free-space accounting, index node links, key ordering — follow LiteDB 4 and
 * were checked against files it wrote. Before a file is declared writable, every index's
 * stored order is compared with the order this module would produce (see checkWritable): a
 * database that sorts differently is opened as a copy instead.
 */
import { decodeBson, readLiteDb, toCell, type LiteCell, type LiteCollection, type LiteDatabase, type LiteIndex, type LiteValue } from './litedb';

const PAGE = 4096;
const PAGE_HEADER = 25;
const AVAILABLE = PAGE - PAGE_HEADER;
const NONE = 0xffffffff;
const EMPTY_ADDR: Addr = [NONE, 0xffff];
const MAX_LEVELS = 32;
const MAX_KEY_BYTES = 512;
const MARKER = '** This is a LiteDB file **';
const PAGE_TYPE = { header: 1, collection: 2, index: 3, data: 4, extend: 5 } as const;

type Addr = [page: number, slot: number];

// BSON element types as stored in documents
const T = { double: 0x01, string: 0x02, document: 0x03, array: 0x04, binary: 0x05, objectId: 0x07, boolean: 0x08, dateTime: 0x09, null: 0x0a, int32: 0x10, int64: 0x12, decimal: 0x13, min: 0xff, max: 0x7f } as const;
/** Pseudo type for a Guid (binary subtype 4), so type hints can tell it from other binary data. */
const T_GUID = 0x105;

// ── bytes ────────────────────────────────────────────────────────────────────
const utf8 = new TextEncoder();

class Bytes {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  length = 0;
  private grow(n: number): void {
    if (this.length + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number): this {
    this.grow(1);
    this.buf[this.length++] = v & 0xff;
    return this;
  }
  u16(v: number): this {
    this.grow(2);
    this.view.setUint16(this.length, v, true);
    this.length += 2;
    return this;
  }
  u32(v: number): this {
    this.grow(4);
    this.view.setUint32(this.length, v >>> 0, true);
    this.length += 4;
    return this;
  }
  i32(v: number): this {
    this.grow(4);
    this.view.setInt32(this.length, v, true);
    this.length += 4;
    return this;
  }
  i64(v: bigint): this {
    this.grow(8);
    this.view.setBigInt64(this.length, BigInt.asIntN(64, v), true);
    this.length += 8;
    return this;
  }
  f64(v: number): this {
    this.grow(8);
    this.view.setFloat64(this.length, v, true);
    this.length += 8;
    return this;
  }
  bytes(b: Uint8Array): this {
    this.grow(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
    return this;
  }
  /** LiteDB's own string form: int32 byte length, then UTF-8. */
  str(s: string): this {
    const b = utf8.encode(s);
    return this.i32(b.length).bytes(b);
  }
  addr(a: Addr): this {
    return this.u32(a[0]).u16(a[1]);
  }
  out(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

// ── documents as lists of raw elements ───────────────────────────────────────
interface Element {
  name: string;
  /** BSON type byte. */
  type: number;
  /** The value's bytes exactly as stored. */
  value: Uint8Array;
}

const decoder = new TextDecoder('utf-8');

function elementSize(view: DataView, bytes: Uint8Array, type: number, at: number): number {
  switch (type) {
    case T.double:
    case T.dateTime:
    case T.int64:
      return 8;
    case T.string:
      return 4 + view.getInt32(at, true);
    case T.document:
    case T.array:
      return view.getInt32(at, true);
    case T.binary:
      return 5 + view.getInt32(at, true);
    case T.objectId:
      return 12;
    case T.boolean:
      return 1;
    case T.null:
    case 0x06:
    case T.min:
    case T.max:
      return 0;
    case T.int32:
      return 4;
    case T.decimal:
      return 16;
    default:
      throw new Error(`Unknown value type 0x${type.toString(16)} at ${at} of ${bytes.length}.`);
  }
}

/** Top-level elements of a stored document, each with its untouched value bytes. */
export function splitDocument(raw: Uint8Array): Element[] {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const end = view.getInt32(0, true) - 1;
  const out: Element[] = [];
  let p = 4;
  while (p < end) {
    const type = raw[p++];
    if (type === 0) break;
    let z = p;
    while (z < raw.length && raw[z] !== 0) z++;
    const name = decoder.decode(raw.subarray(p, z));
    p = z + 1;
    const size = elementSize(view, raw, type, p);
    out.push({ name, type, value: raw.subarray(p, p + size) });
    p += size;
  }
  return out;
}

function joinDocument(elements: Element[]): Uint8Array {
  const b = new Bytes();
  b.i32(0);
  for (const e of elements) b.u8(e.type).bytes(utf8.encode(e.name)).u8(0).bytes(e.value);
  b.u8(0);
  const out = b.out();
  new DataView(out.buffer).setInt32(0, out.length, true);
  return out;
}

const hintOf = (e: Element): number => (e.type === T.binary && e.value[4] === 4 && e.value.length === 21 ? T_GUID : e.type);

// ── values → BSON ────────────────────────────────────────────────────────────
const GUID_TEXT = /^\{?([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})\}?$/i;

/** .NET's Guid.ToByteArray() layout from its text form, or null. */
function guidBytes(text: string): Uint8Array | null {
  const m = GUID_TEXT.exec(text.trim());
  if (!m) return null;
  const hex = m.slice(1).join('');
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
  return Uint8Array.from([b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6], ...b.subarray(8)]);
}

/** A .NET System.Decimal (lo, mid, hi, flags) from plain decimal text, or null when it does not fit. */
function decimalBytes(text: string): Uint8Array | null {
  const m = /^\s*(-?)(\d+)(?:\.(\d+))?\s*$/.exec(text);
  if (!m) return null;
  let frac = (m[3] ?? '').replace(/0+$/, '');
  if (frac.length > 28) frac = frac.slice(0, 28);
  const mantissa = BigInt(m[2] + frac);
  if (mantissa >= 1n << 96n) return null;
  const b = new Bytes();
  b.u32(Number(mantissa & 0xffffffffn)).u32(Number((mantissa >> 32n) & 0xffffffffn)).u32(Number((mantissa >> 64n) & 0xffffffffn));
  b.u32(((frac.length << 16) | (m[1] && mantissa !== 0n ? 0x80000000 : 0)) >>> 0);
  return b.out();
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

function stringValue(text: string): Uint8Array {
  const b = utf8.encode(text);
  return new Bytes().i32(b.length + 1).bytes(b).u8(0).out();
}

/** A JSON value as a BSON element (used for nested documents / arrays that were edited). */
function jsonElement(name: string, v: unknown): Element {
  if (v === null || v === undefined) return { name, type: T.null, value: new Uint8Array(0) };
  if (typeof v === 'boolean') return { name, type: T.boolean, value: Uint8Array.of(v ? 1 : 0) };
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= INT32_MIN && v <= INT32_MAX) return { name, type: T.int32, value: new Bytes().i32(v).out() };
    if (Number.isSafeInteger(v)) return { name, type: T.int64, value: new Bytes().i64(BigInt(v)).out() };
    return { name, type: T.double, value: new Bytes().f64(v).out() };
  }
  if (typeof v === 'string') return { name, type: T.string, value: stringValue(v) };
  if (Array.isArray(v)) return { name, type: T.array, value: joinDocument(v.map((x, i) => jsonElement(String(i), x))) };
  return { name, type: T.document, value: joinDocument(Object.entries(v as Record<string, unknown>).map(([k, x]) => jsonElement(k, x))) };
}

/** A cell stored as whatever it is, with no type to aim for. */
function inferElement(name: string, cell: Exclude<LiteCell, null>): Element {
  if (cell instanceof Uint8Array) return { name, type: T.binary, value: new Bytes().i32(cell.length).u8(0).bytes(cell).out() };
  return jsonElement(name, cell);
}

/**
 * Encodes a table cell as a document field of type `hint` when the value fits that type,
 * otherwise as what the value is. `fit` is false in the second case.
 */
function encodeCell(name: string, cell: LiteCell, hint: number | undefined): { element: Element; fit: boolean } {
  if (cell === null) return { element: { name, type: T.null, value: new Uint8Array(0) }, fit: true };
  const text = cell instanceof Uint8Array ? null : String(cell);
  const num = typeof cell === 'number' ? cell : text !== null && /^\s*-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?\s*$/i.test(text) ? Number(text) : NaN;
  const ok = (type: number, value: Uint8Array) => ({ element: { name, type, value }, fit: true });
  switch (hint) {
    case T.string:
      if (text !== null) return ok(T.string, stringValue(text));
      break;
    case T.int32:
      if (Number.isInteger(num) && num >= INT32_MIN && num <= INT32_MAX) return ok(T.int32, new Bytes().i32(num).out());
      break;
    case T.int64:
      if (text !== null && /^\s*-?\d+\s*$/.test(text)) return ok(T.int64, new Bytes().i64(BigInt(text.trim())).out());
      break;
    case T.double:
      if (!Number.isNaN(num)) return ok(T.double, new Bytes().f64(num).out());
      break;
    case T.boolean: {
      const t = text?.trim().toLowerCase();
      if (t === '1' || t === 'true') return ok(T.boolean, Uint8Array.of(1));
      if (t === '0' || t === 'false') return ok(T.boolean, Uint8Array.of(0));
      break;
    }
    case T.dateTime: {
      const ms = text === null ? NaN : Date.parse(/^\d{4}-\d{2}-\d{2} \d/.test(text) ? text.replace(' ', 'T') : text);
      if (!Number.isNaN(ms)) return ok(T.dateTime, new Bytes().i64(BigInt(ms)).out());
      break;
    }
    case T_GUID: {
      const g = text === null ? null : guidBytes(text);
      if (g) return ok(T.binary, new Bytes().i32(16).u8(4).bytes(g).out());
      break;
    }
    case T.objectId:
      if (text !== null && /^[0-9a-f]{24}$/i.test(text.trim())) return ok(T.objectId, Uint8Array.from(text.trim().match(/../g)!.map((h) => parseInt(h, 16))));
      break;
    case T.decimal: {
      const d = text === null ? null : decimalBytes(typeof cell === 'number' ? cell.toFixed(Math.min(20, Math.max(0, (String(cell).split('.')[1] ?? '').length))) : text);
      if (d) return ok(T.decimal, d);
      break;
    }
    case T.document:
    case T.array:
      if (text !== null) {
        try {
          const parsed: unknown = JSON.parse(text);
          const isArray = Array.isArray(parsed);
          if (parsed && typeof parsed === 'object' && isArray === (hint === T.array)) return { element: jsonElement(name, parsed), fit: true };
        } catch {
          /* not JSON any more: stored as text below */
        }
      }
      break;
    case T.binary:
      if (cell instanceof Uint8Array) return { element: inferElement(name, cell), fit: true };
      break;
  }
  return { element: inferElement(name, cell), fit: hint === undefined || hint === T.null };
}

// ── index keys ───────────────────────────────────────────────────────────────
/** LiteDB's own value types, in the order it sorts values of different types. */
const K = { min: 0, null: 1, int32: 2, int64: 3, double: 4, decimal: 5, string: 6, document: 7, array: 8, binary: 9, objectId: 10, guid: 11, boolean: 12, dateTime: 13, max: 14 } as const;
/** .NET ticks at 1970-01-01. */
const EPOCH_TICKS = 621355968000000000n;

interface Key {
  type: number;
  /** Bytes after the type byte in an index node. */
  bytes: Uint8Array;
  /** What keys of this type are compared by. */
  sort: number | bigint | string | Uint8Array | null;
}

const NULL_KEY: Key = { type: K.null, bytes: new Uint8Array(0), sort: null };

function decimalNumber(value: Uint8Array): number {
  const v = new DataView(value.buffer, value.byteOffset, 16);
  const mantissa = (BigInt(v.getUint32(8, true)) << 64n) | (BigInt(v.getUint32(4, true)) << 32n) | BigInt(v.getUint32(0, true));
  const flags = v.getUint32(12, true);
  return (Number(mantissa) / 10 ** ((flags >>> 16) & 0xff)) * (flags & 0x80000000 ? -1 : 1);
}

function keyOf(e: Element | undefined): Key {
  if (!e) return NULL_KEY;
  const v = e.value;
  const view = new DataView(v.buffer, v.byteOffset, v.byteLength);
  switch (e.type) {
    case T.null:
    case 0x06:
      return NULL_KEY;
    case T.int32:
      return { type: K.int32, bytes: v, sort: view.getInt32(0, true) };
    case T.int64:
      return { type: K.int64, bytes: v, sort: Number(view.getBigInt64(0, true)) };
    case T.double:
      return { type: K.double, bytes: v, sort: view.getFloat64(0, true) };
    case T.decimal:
      return { type: K.decimal, bytes: v, sort: decimalNumber(v) };
    case T.string: {
      const bytes = v.subarray(4, v.length - 1);
      return { type: K.string, bytes, sort: decoder.decode(bytes) };
    }
    case T.boolean:
      return { type: K.boolean, bytes: v, sort: v[0] };
    case T.dateTime: {
      const ms = view.getBigInt64(0, true);
      return { type: K.dateTime, bytes: new Bytes().i64(ms * 10000n + EPOCH_TICKS).out(), sort: ms };
    }
    case T.objectId:
      return { type: K.objectId, bytes: v, sort: v };
    case T.binary:
      if (v[4] === 4 && v.length === 21) return { type: K.guid, bytes: v.subarray(5), sort: v.subarray(5) };
      return { type: K.binary, bytes: v.subarray(5), sort: v.subarray(5) };
    case T.min:
      return { type: K.min, bytes: new Uint8Array(0), sort: null };
    case T.max:
      return { type: K.max, bytes: new Uint8Array(0), sort: null };
    default:
      throw new Error('Documents and arrays cannot be index keys here.');
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length - b.length;
}

/** .NET Guid.CompareTo on ToByteArray() bytes: three little-endian groups, then eight bytes in order. */
function compareGuid(a: Uint8Array, b: Uint8Array): number {
  for (const i of [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15]) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

export type TextOrder = 'culture' | 'ordinal';
const collator = new Intl.Collator('en', { sensitivity: 'variant', caseFirst: 'lower' });

function compareText(a: string, b: string, order: TextOrder): number {
  if (order === 'culture') {
    const c = collator.compare(a, b);
    if (c) return c;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

const isNumber = (t: number) => t === K.int32 || t === K.int64 || t === K.double || t === K.decimal;

function compareKeys(a: Key, b: Key, order: TextOrder): number {
  if (a.type !== b.type) {
    if (isNumber(a.type) && isNumber(b.type)) return (a.sort as number) < (b.sort as number) ? -1 : (a.sort as number) > (b.sort as number) ? 1 : 0;
    return a.type - b.type;
  }
  switch (a.type) {
    case K.string:
      return compareText(a.sort as string, b.sort as string, order);
    case K.guid:
      return compareGuid(a.sort as Uint8Array, b.sort as Uint8Array);
    case K.binary:
    case K.objectId:
      return compareBytes(a.sort as Uint8Array, b.sort as Uint8Array);
    case K.null:
    case K.min:
    case K.max:
      return 0;
    default:
      return (a.sort as number | bigint) < (b.sort as number | bigint) ? -1 : (a.sort as number | bigint) > (b.sort as number | bigint) ? 1 : 0;
  }
}

/** The field path of a plain `$.a.b` index expression, or null for anything fancier. */
function expressionPath(expression: string): string[] | null {
  const m = /^\$((?:\.[A-Za-z_][\w-]*)+)$/.exec(expression.trim());
  return m ? m[1].slice(1).split('.') : null;
}

function keyAt(elements: Element[], path: string[]): Key {
  let list = elements;
  for (let i = 0; i < path.length; i++) {
    const e = list.find((x) => x.name === path[i]);
    if (i === path.length - 1) return keyOf(e);
    if (!e || e.type !== T.document) return NULL_KEY;
    list = splitDocument(e.value);
  }
  return NULL_KEY;
}

// ── can this file be written back? ───────────────────────────────────────────
export interface LiteWriteContext {
  header: { changeId: number; userVersion: number; salt: Uint8Array };
  textOrder: TextOrder;
  collections: Map<string, ContextCollection>;
}

interface ContextCollection {
  indexes: LiteIndex[];
  sequence: bigint;
  /** Columns the collection was shown with, in order. */
  columns: string[];
  /** Original documents by the text of their `_id` cell. */
  docs: Map<string, { raw: Uint8Array; cells: LiteCell[] }>;
  /** Each field's usual type. */
  fieldTypes: Map<string, number>;
}

const idKey = (cell: LiteCell): string => (cell instanceof Uint8Array ? `b:${Array.from(cell).join(',')}` : `${typeof cell}:${String(cell)}`);

function cellsEqual(a: LiteCell, b: LiteCell): boolean {
  if (a instanceof Uint8Array || b instanceof Uint8Array) return a instanceof Uint8Array && b instanceof Uint8Array && compareBytes(a, b) === 0;
  return a === b;
}

/**
 * Checks that the file can be rewritten faithfully and prepares what that needs. Returns a
 * reason instead when it can't (the caller then opens the database as a copy).
 */
export function prepareWriteBack(db: LiteDatabase): { context: LiteWriteContext } | { reason: string } {
  if (db.version !== 4 || !db.header) return { reason: 'it is a LiteDB 5 file, which File Editor can read but not write' };
  if (db.warnings.length) return { reason: 'part of it could not be read' };
  const split: Element[][][] = [];
  for (const col of db.collections) {
    if (!col.raw || !col.indexes || col.raw.length !== col.documents.length) return { reason: `the collection "${col.name}" could not be read completely` };
    try {
      split.push(col.raw.map(splitDocument));
    } catch {
      return { reason: `a document in "${col.name}" uses a value type File Editor does not know` };
    }
    for (const index of col.indexes) {
      if (!expressionPath(index.expression)) return { reason: `the index "${index.field}" of "${col.name}" uses an expression (${index.expression})` };
      if (!index.order) return { reason: `the index "${index.field}" of "${col.name}" could not be read` };
    }
  }

  // Does this module sort every index the way the file does? Text order is the open question.
  const sortedBy = (order: TextOrder): string | null => {
    for (let c = 0; c < db.collections.length; c++) {
      const col = db.collections[c];
      for (const index of col.indexes!) {
        const path = expressionPath(index.expression)!;
        let prev: Key | null = null;
        for (const pos of index.order!) {
          let key: Key;
          try {
            key = keyAt(split[c][pos], path);
          } catch {
            return `"${index.field}" of "${col.name}" indexes nested values`;
          }
          if (prev && compareKeys(prev, key, order) > 0) return `"${index.field}" of "${col.name}"`;
          prev = key;
        }
      }
    }
    return null;
  };
  const culture = sortedBy('culture');
  const ordinal = culture === null ? null : sortedBy('ordinal');
  if (culture !== null && ordinal !== null) return { reason: `its index ${culture} is sorted in a way File Editor cannot reproduce` };

  const collections = new Map<string, ContextCollection>();
  db.collections.forEach((col, c) => {
    const columns: string[] = [];
    const seen = new Set<string>();
    const counts = new Map<string, Map<number, number>>();
    for (const elements of split[c]) {
      for (const e of elements) {
        if (!seen.has(e.name)) {
          seen.add(e.name);
          columns.push(e.name);
        }
        if (e.type === T.null) continue;
        const byType = counts.get(e.name) ?? new Map<number, number>();
        byType.set(hintOf(e), (byType.get(hintOf(e)) ?? 0) + 1);
        counts.set(e.name, byType);
      }
    }
    const fieldTypes = new Map<string, number>();
    for (const [name, byType] of counts) fieldTypes.set(name, [...byType].sort((a, b) => b[1] - a[1])[0][0]);
    const docs = new Map<string, { raw: Uint8Array; cells: LiteCell[] }>();
    col.documents.forEach((doc, i) => {
      const cells = columns.map((name) => toCell(doc[name] as LiteValue | undefined));
      docs.set(idKey(toCell(doc._id as LiteValue | undefined)), { raw: col.raw![i], cells });
    });
    collections.set(col.name, { indexes: col.indexes!, sequence: col.sequence ?? BigInt(col.documents.length), columns, docs, fieldTypes });
  });
  return { context: { header: db.header, textOrder: culture === null ? 'culture' : 'ordinal', collections } };
}

// ── tables → documents ───────────────────────────────────────────────────────
export interface WriteTable {
  name: string;
  columns: string[];
  rowids: number[];
  rows: LiteCell[][];
}

export interface WriteResult {
  bytes: Uint8Array;
  /** `_id` values generated for rows that had none (to be written into the table). */
  assignedIds: { table: string; rowid: number; value: string | number }[];
  /** Values stored in a different type than the field had before. */
  retyped: number;
  documents: number;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function newGuidText(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function newObjectIdText(): string {
  const b = randomBytes(12);
  new DataView(b.buffer).setUint32(0, Math.floor(Date.now() / 1000), false);
  return toHex(b);
}

const COLLECTION_NAME = /^[A-Za-z_][\w-]{0,59}$/;

interface BuiltCollection {
  name: string;
  indexes: LiteIndex[];
  sequence: bigint;
  docs: { raw: Uint8Array; elements: Element[] }[];
}

function buildDocuments(ctx: LiteWriteContext, table: WriteTable, result: Pick<WriteResult, 'assignedIds' | 'retyped'>): BuiltCollection {
  if (!COLLECTION_NAME.test(table.name)) {
    throw new Error(`"${table.name}" cannot be a LiteDB collection name (use letters, digits, _ or -, starting with a letter).`);
  }
  const original = ctx.collections.get(table.name);
  const idCol = table.columns.indexOf('_id');
  if (idCol < 0) throw new Error(`The table "${table.name}" has no _id column, which every LiteDB document needs.`);
  if (new Set(table.columns).size < table.columns.length) throw new Error(`Two columns of "${table.name}" have the same name.`);
  const types = original?.fieldTypes ?? new Map<string, number>();
  const idType = types.get('_id');
  // original column position for each current column (-1 for a column added since)
  const wasAt = table.columns.map((name) => original?.columns.indexOf(name) ?? -1);
  const dropped = original ? original.columns.filter((name) => !table.columns.includes(name)) : [];

  let nextInt = 0n;
  if (idType === T.int32 || idType === T.int64) {
    for (const row of table.rows) if (typeof row[idCol] === 'number') nextInt = BigInt(Math.max(Number(nextInt), Math.trunc(row[idCol] as number)));
    if (original && original.sequence > nextInt) nextInt = original.sequence;
  }

  const seen = new Set<string>();
  const docs: BuiltCollection['docs'] = [];
  table.rows.forEach((row, r) => {
    let id = row[idCol];
    let generatedType: number | undefined;
    if (id === null) {
      const value: string | number = idType === T_GUID ? newGuidText() : idType === T.int32 || idType === T.int64 ? Number(++nextInt) : newObjectIdText();
      if (typeof value === 'string' && idType !== T_GUID) generatedType = T.objectId;
      result.assignedIds.push({ table: table.name, rowid: table.rowids[r], value });
      id = value;
      row = row.map((cell, c) => (c === idCol ? value : cell));
    }
    const key = idKey(id);
    if (seen.has(key)) throw new Error(`Two rows of "${table.name}" have the same _id (${String(id)}). Every _id must be different.`);
    seen.add(key);

    const before = original?.docs.get(key);
    if (before && !dropped.length && row.every((cell, c) => (wasAt[c] < 0 ? cell === null : cellsEqual(cell, before.cells[wasAt[c]])))) {
      docs.push({ raw: before.raw, elements: splitDocument(before.raw) });
      return;
    }
    let elements: Element[];
    if (before) {
      // an edited document: untouched fields keep their bytes
      elements = splitDocument(before.raw).filter((e) => !dropped.includes(e.name));
      row.forEach((cell, c) => {
        const name = table.columns[c];
        if (wasAt[c] >= 0 && cellsEqual(cell, before.cells[wasAt[c]])) return;
        const at = elements.findIndex((e) => e.name === name);
        const old = at >= 0 ? elements[at] : undefined;
        if (!old && cell === null) return;
        const { element, fit } = encodeCell(name, cell, old && old.type !== T.null ? hintOf(old) : types.get(name));
        if (!fit) result.retyped++;
        if (at >= 0) elements[at] = element;
        else elements.push(element);
      });
    } else {
      elements = [];
      row.forEach((cell, c) => {
        if (cell === null) return;
        const { element, fit } = encodeCell(table.columns[c], cell, types.get(table.columns[c]) ?? (c === idCol ? generatedType : undefined));
        if (!fit) result.retyped++;
        elements.push(element);
      });
      // _id first, as LiteDB writes it
      elements.sort((a, b) => Number(b.name === '_id') - Number(a.name === '_id'));
    }
    docs.push({ raw: joinDocument(elements), elements });
  });
  // the collection's counter moves on with every document added
  let added = 0;
  for (const key of seen) if (!original?.docs.has(key)) added++;
  const counted = (original?.sequence ?? 0n) + BigInt(added);
  const sequence = nextInt > counted ? nextInt : counted;
  return { name: table.name, indexes: original?.indexes ?? [{ slot: 0, field: '_id', expression: '$._id', unique: true }], sequence, docs };
}

// ── pages ────────────────────────────────────────────────────────────────────
class PageSet {
  pages: Uint8Array[] = [];
  /** Reserves a page id; the page is filled in later. */
  allocate(): number {
    this.pages.push(new Uint8Array(0));
    return this.pages.length - 1;
  }
  set(id: number, type: number, items: number, freeBytes: number, body: Uint8Array, prev = NONE, next = NONE): void {
    if (body.length > AVAILABLE) throw new Error('A page overflowed while writing the database.');
    const page = new Uint8Array(PAGE);
    const v = new DataView(page.buffer);
    v.setUint32(0, id, true);
    page[4] = type;
    v.setUint32(5, prev, true);
    v.setUint32(9, next, true);
    v.setUint16(13, items, true);
    v.setUint16(15, freeBytes, true);
    page.set(body, PAGE_HEADER);
    this.pages[id] = page;
  }
}

/** Skip-list height for a new node: 1, and one more for every coin flip that comes up heads. */
function makeLevels(seed: { v: number }): number {
  let levels = 1;
  for (;;) {
    // xorshift: any decent spread of heights keeps lookups fast
    seed.v ^= seed.v << 13;
    seed.v ^= seed.v >>> 17;
    seed.v ^= seed.v << 5;
    if ((seed.v & 1) === 0 || levels >= MAX_LEVELS) return levels;
    levels++;
  }
}

interface Node {
  key: Key;
  levels: number;
  data: Addr;
  at: Addr;
  prev: Addr[];
  next: Addr[];
  /** Index nodes of the same document, chained from the _id index on. */
  prevNode: Addr;
  nextNode: Addr;
  doc: number;
}

const nodeLength = (n: Pick<Node, 'key' | 'levels'>): number => 25 + n.key.bytes.length + n.levels * 12;

function writeCollection(pages: PageSet, col: BuiltCollection, order: TextOrder): number {
  const pageId = pages.allocate();

  // documents → data pages (and extend pages for the ones larger than a page)
  const dataAt: Addr[] = [];
  let body = new Bytes();
  let slots = 0;
  let current = -1;
  const flush = () => {
    if (current < 0) return;
    pages.set(current, PAGE_TYPE.data, slots, AVAILABLE - body.length, body.out());
    current = -1;
  };
  for (const doc of col.docs) {
    const big = doc.raw.length + 8 > AVAILABLE;
    const need = big ? 8 : doc.raw.length + 8;
    if (current < 0 || body.length + need > AVAILABLE || slots >= 0xfff0) {
      flush();
      current = pages.allocate();
      body = new Bytes();
      slots = 0;
    }
    let extend = NONE;
    if (big) {
      const count = Math.ceil(doc.raw.length / AVAILABLE);
      const ids = Array.from({ length: count }, () => pages.allocate());
      ids.forEach((id, i) => {
        const part = doc.raw.subarray(i * AVAILABLE, (i + 1) * AVAILABLE);
        pages.set(id, PAGE_TYPE.extend, part.length, AVAILABLE - part.length, part, i ? ids[i - 1] : NONE, i + 1 < count ? ids[i + 1] : NONE);
      });
      extend = ids[0];
    }
    body.u16(slots).u32(extend).u16(big ? 0 : doc.raw.length);
    if (!big) body.bytes(doc.raw);
    dataAt.push([current, slots]);
    slots++;
  }
  flush();

  // one skip list per index
  const seed = { v: 0x9e3779b9 ^ col.docs.length };
  const heads: { head: Addr; tail: Addr; maxLevel: number }[] = [];
  const perDoc: Node[][] = col.docs.map(() => []);
  const layouts: { id: number; nodes: Node[]; used: number }[][] = [];
  for (const index of col.indexes) {
    const path = expressionPath(index.expression);
    if (!path) throw new Error(`The index "${index.field}" of "${col.name}" uses an expression File Editor cannot write.`);
    const nodes: Node[] = col.docs.map((doc, i) => {
      let key: Key;
      try {
        key = keyAt(doc.elements, path);
      } catch {
        throw new Error(`"${index.field}" is indexed in "${col.name}", so it must hold a single value in every document (not a list or nested document).`);
      }
      if (key.bytes.length > MAX_KEY_BYTES) throw new Error(`"${index.field}" is indexed in "${col.name}", so its values must be shorter than ${MAX_KEY_BYTES} bytes.`);
      if (index.slot === 0 && (key.type === K.null || key.type === K.min || key.type === K.max)) throw new Error(`A document in "${col.name}" has no _id.`);
      return { key, levels: makeLevels(seed), data: dataAt[i], at: EMPTY_ADDR, prev: [], next: [], prevNode: EMPTY_ADDR, nextNode: EMPTY_ADDR, doc: i };
    });
    nodes.sort((a, b) => compareKeys(a.key, b.key, order) || a.doc - b.doc);
    if (index.unique) {
      for (let i = 1; i < nodes.length; i++) {
        if (compareKeys(nodes[i - 1].key, nodes[i].key, order) === 0 && nodes[i].key.type !== K.null) {
          throw new Error(`"${index.field}" must be different in every document of "${col.name}", but a value appears twice (${String(nodes[i].key.sort)}).`);
        }
      }
    }
    const sentinel = (type: number): Node => ({
      key: { type, bytes: new Uint8Array(0), sort: null },
      levels: MAX_LEVELS,
      data: EMPTY_ADDR,
      at: EMPTY_ADDR,
      prev: new Array<Addr>(MAX_LEVELS).fill(EMPTY_ADDR),
      next: new Array<Addr>(MAX_LEVELS).fill(EMPTY_ADDR),
      prevNode: EMPTY_ADDR,
      nextNode: EMPTY_ADDR,
      doc: -1,
    });
    const head = sentinel(K.min);
    const tail = sentinel(K.max);

    // place nodes on pages, in key order (head and tail lead the first page)
    const layout: { id: number; nodes: Node[]; used: number }[] = [];
    const place = (n: Node) => {
      let page = layout[layout.length - 1];
      if (!page || page.used + nodeLength(n) > AVAILABLE) {
        page = { id: pages.allocate(), nodes: [], used: 0 };
        layout.push(page);
      }
      n.at = [page.id, page.nodes.length];
      page.nodes.push(n);
      page.used += nodeLength(n);
    };
    place(head);
    place(tail);
    nodes.forEach(place);

    // links: level 0 runs head → every node → tail; higher levels start at the head and
    // simply end, as LiteDB leaves them
    let maxLevel = 1;
    for (const n of nodes) {
      n.prev = new Array<Addr>(n.levels).fill(EMPTY_ADDR);
      n.next = new Array<Addr>(n.levels).fill(EMPTY_ADDR);
      if (n.levels > maxLevel) maxLevel = n.levels;
    }
    for (let level = 0; level < maxLevel; level++) {
      let last = head;
      for (const n of nodes) {
        if (n.levels <= level) continue;
        last.next[level] = n.at;
        n.prev[level] = last.at;
        last = n;
      }
      if (level === 0) {
        last.next[0] = tail.at;
        tail.prev[0] = last.at;
      }
    }
    for (const n of nodes) perDoc[n.doc].push(n);
    heads.push({ head: head.at, tail: tail.at, maxLevel });
    // pages are written once the per-document chains are known (below)
    layouts.push(layout);
  }
  for (const chain of perDoc) {
    for (let i = 0; i < chain.length; i++) {
      if (i > 0) chain[i].prevNode = chain[i - 1].at;
      if (i + 1 < chain.length) chain[i].nextNode = chain[i + 1].at;
    }
  }
  col.indexes.forEach((index, i) => {
    for (const page of layouts[i]) {
      const b = new Bytes();
      for (const n of page.nodes) {
        b.u16(n.at[1]).u8(n.levels).u8(index.slot).addr(n.prevNode).addr(n.nextNode).u16(n.key.bytes.length).u8(n.key.type).bytes(n.key.bytes).addr(n.data);
        for (let level = 0; level < n.levels; level++) b.addr(n.prev[level]).addr(n.next[level]);
      }
      pages.set(page.id, PAGE_TYPE.index, page.nodes.length, AVAILABLE - b.length, b.out());
    }
  });

  // the collection page: name, counters, 16 index slots, and a footer of index heights + sequence
  const b = new Bytes();
  b.str(col.name).i64(BigInt(col.docs.length)).u32(NONE);
  const maxLevels = new Uint8Array(16).fill(1);
  for (let slot = 0; slot < 16; slot++) {
    const i = col.indexes.findIndex((x) => x.slot === slot);
    if (i < 0) {
      b.str('').u8(0).addr(EMPTY_ADDR).addr([0, 0]).u32(NONE);
      continue;
    }
    const index = col.indexes[i];
    b.str(`${index.field}=${index.expression}`).u8(index.unique ? 1 : 0).addr(heads[i].head).addr(heads[i].tail).u32(NONE);
    maxLevels[slot] = heads[i].maxLevel;
  }
  if (b.length > AVAILABLE - 24) throw new Error(`The collection "${col.name}" has too many or too long index definitions to write.`);
  const page = new Uint8Array(AVAILABLE);
  page.set(b.out());
  page.set(maxLevels, AVAILABLE - 24);
  new DataView(page.buffer).setBigInt64(AVAILABLE - 8, col.sequence, true);
  pages.set(pageId, PAGE_TYPE.collection, 1, 0, page);
  return pageId;
}

/** Builds the whole file from the current tables. Throws with a plain message when the data can't be a LiteDB database. */
export function writeLiteDb(ctx: LiteWriteContext, tables: WriteTable[]): WriteResult {
  if (tables.length > 255) throw new Error('A LiteDB database holds at most 255 collections.');
  const result: WriteResult = { bytes: new Uint8Array(0), assignedIds: [], retyped: 0, documents: 0 };
  const built = tables.map((t) => buildDocuments(ctx, t, result));

  const pages = new PageSet();
  pages.allocate(); // header
  pages.allocate(); // page 1 is reserved for file locks and stays empty
  const directory: { name: string; page: number }[] = [];
  for (const col of built) {
    directory.push({ name: col.name, page: writeCollection(pages, col, ctx.textOrder) });
    result.documents += col.docs.length;
  }

  const h = new Bytes();
  h.bytes(utf8.encode(MARKER)).u8(7).u16((ctx.header.changeId + 1) & 0xffff).u32(NONE).u32(pages.pages.length - 1).u16(ctx.header.userVersion);
  h.bytes(new Uint8Array(20)).bytes(ctx.header.salt).u8(directory.length);
  for (const d of directory) h.str(d.name).u32(d.page);
  if (h.length > AVAILABLE - 1) throw new Error('The collection names do not fit in the database header. Use fewer or shorter names.');
  pages.set(0, PAGE_TYPE.header, 1, 0, h.out());
  pages.pages[1] = new Uint8Array(PAGE);

  const bytes = new Uint8Array(pages.pages.length * PAGE);
  pages.pages.forEach((p, i) => bytes.set(p, i * PAGE));

  // Read the result back before anyone depends on it.
  const check = readLiteDb(bytes);
  const problem =
    check.warnings[0] ??
    (check.collections.length !== built.length ? 'collections are missing' : null) ??
    check.collections.map((c, i) => (c.documents.length !== built[i].docs.length || c.indexes?.some((x) => x.order?.length !== c.documents.length) ? `"${c.name}" did not read back completely` : null)).find(Boolean);
  if (problem) throw new Error(`The database could not be written safely (${problem}). Nothing was saved.`);
  result.bytes = bytes;
  return result;
}

/** The tables a LiteDB database is shown as, with the stored bytes decoded (for tests and tools). */
export function documentsOf(col: LiteCollection): ReturnType<typeof decodeBson>[] {
  return (col.raw ?? []).map(decodeBson);
}
