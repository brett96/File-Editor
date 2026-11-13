/**
 * Minimal streaming ZIP reader / writer for very large Office files.
 *
 * Reading works on a Blob: only the directory and the entries that are asked for are read,
 * and each entry is inflated as a stream (the platform's DecompressionStream), so a
 * worksheet of several gigabytes of XML is never held in memory at once. Writing deflates
 * each entry as it is produced. ZIP64 directories are understood when reading.
 *
 * Runs in browsers, Electron and Node 18+ (all provide Blob and the compression streams).
 */

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  compressedSize: number;
  /** Uncompressed size. */
  size: number;
  /** Offset of the entry's local header. */
  offset: number;
}

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

async function slice(blob: Blob, start: number, end: number): Promise<DataView> {
  const buf = await blob.slice(start, end).arrayBuffer();
  return new DataView(buf);
}

const u64 = (v: DataView, at: number): number => Number(v.getBigUint64(at, true));

/** Reads the central directory. Throws when the file is not a zip archive. */
export async function readZipDirectory(blob: Blob): Promise<ZipEntry[]> {
  const tailLen = Math.min(blob.size, 65_557 + 20);
  const tail = await slice(blob, blob.size - tailLen, blob.size);
  let at = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new Error('This is not a valid zip-based Office file (no directory found).');
  let count = tail.getUint16(at + 10, true);
  let dirSize = tail.getUint32(at + 12, true);
  let dirOffset = tail.getUint32(at + 16, true);
  if ((count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) && at >= 20 && tail.getUint32(at - 20, true) === EOCD64_LOCATOR) {
    const eocd64At = u64(tail, at - 20 + 8);
    const rec = await slice(blob, eocd64At, eocd64At + 56);
    if (rec.getUint32(0, true) !== EOCD64) throw new Error('This zip file\'s directory is damaged.');
    count = u64(rec, 32);
    dirSize = u64(rec, 40);
    dirOffset = u64(rec, 48);
  }
  const dir = await slice(blob, dirOffset, dirOffset + dirSize);
  const bytes = new Uint8Array(dir.buffer);
  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= dir.byteLength; i++) {
    if (dir.getUint32(p, true) !== CENTRAL) break;
    const method = dir.getUint16(p + 10, true);
    let compressedSize = dir.getUint32(p + 20, true);
    let size = dir.getUint32(p + 24, true);
    const nameLen = dir.getUint16(p + 28, true);
    const extraLen = dir.getUint16(p + 30, true);
    const commentLen = dir.getUint16(p + 32, true);
    let offset = dir.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extra field: the values that did not fit, in this fixed order
    for (let e = p + 46 + nameLen; e + 4 <= p + 46 + nameLen + extraLen; ) {
      const id = dir.getUint16(e, true);
      const len = dir.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) {
          size = u64(dir, q);
          q += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = u64(dir, q);
          q += 8;
        }
        if (offset === 0xffffffff) offset = u64(dir, q);
      }
      e += 4 + len;
    }
    entries.push({ name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function dataRange(blob: Blob, entry: ZipEntry): Promise<Blob> {
  const head = await slice(blob, entry.offset, entry.offset + 30);
  if (head.byteLength < 30 || head.getUint32(0, true) !== LOCAL) throw new Error(`The zip entry ${entry.name} is damaged.`);
  const start = entry.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  return blob.slice(start, start + entry.compressedSize);
}

/** The entry's content as a stream of decompressed chunks. */
export async function zipEntryStream(blob: Blob, entry: ZipEntry): Promise<ReadableStream<Uint8Array>> {
  const data = await dataRange(blob, entry);
  if (entry.method === 0) return data.stream() as ReadableStream<Uint8Array>;
  if (entry.method !== 8) throw new Error(`The zip entry ${entry.name} uses an unsupported compression method.`);
  return (data.stream() as ReadableStream<Uint8Array>).pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
}

/** Decoded text chunks of an entry (UTF-8), for streaming XML parsers. */
export async function* zipEntryText(blob: Blob, entry: ZipEntry): AsyncGenerator<string> {
  const reader = (await zipEntryStream(blob, entry)).getReader();
  const decoder = new TextDecoder('utf-8');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) yield text;
    }
    const rest = decoder.decode();
    if (rest) yield rest;
  } finally {
    reader.releaseLock();
  }
}

/** The whole entry as text; only for the small parts of a package (workbook.xml, styles…). */
export async function zipEntryString(blob: Blob, entry: ZipEntry): Promise<string> {
  let out = '';
  for await (const chunk of zipEntryText(blob, entry)) out += chunk;
  return out;
}

// ── writing ──────────────────────────────────────────────────────────────────
let crcTable: Uint32Array | null = null;

function crc32(crc: number, data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  const t = crcTable;
  let c = crc;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return c;
}

const LIMIT = 0xffffffff;

/**
 * Builds a zip archive entry by entry. Each entry's text is deflated as it is fed in, so
 * only the compressed bytes accumulate in memory.
 */
export class ZipWriter {
  private parts: Uint8Array[] = [];
  private offset = 0;
  private directory: { name: Uint8Array; crc: number; compressedSize: number; size: number; offset: number }[] = [];
  private encoder = new TextEncoder();

  /** Adds an entry from text chunks (a string, or an iterable that yields them). */
  async add(name: string, content: string | Iterable<string> | AsyncIterable<string>): Promise<void> {
    const compressor = new CompressionStream('deflate-raw');
    const writer = (compressor.writable as WritableStream<Uint8Array>).getWriter();
    const compressed: Uint8Array[] = [];
    let compressedSize = 0;
    const drained = (async () => {
      const reader = (compressor.readable as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        compressed.push(value);
        compressedSize += value.length;
      }
    })();
    let crc = 0xffffffff;
    let size = 0;
    const feed = async (text: string) => {
      if (!text) return;
      const bytes = this.encoder.encode(text);
      crc = crc32(crc, bytes);
      size += bytes.length;
      await writer.write(bytes);
    };
    if (typeof content === 'string') await feed(content);
    else for await (const chunk of content as AsyncIterable<string>) await feed(chunk);
    await writer.close();
    await drained;
    crc = (crc ^ 0xffffffff) >>> 0;
    if (size >= LIMIT || compressedSize >= LIMIT || this.offset >= LIMIT) throw new Error('This workbook is too large to save as one .xlsx file (over 4 GB of data). Split it into smaller workbooks.');

    const nameBytes = this.encoder.encode(name);
    const header = new Uint8Array(30 + nameBytes.length);
    const v = new DataView(header.buffer);
    v.setUint32(0, LOCAL, true);
    v.setUint16(4, 20, true); // version needed
    v.setUint16(6, 0x0800, true); // UTF-8 names
    v.setUint16(8, 8, true); // deflate
    v.setUint16(10, 0, true); // time
    v.setUint16(12, 0x21, true); // date: 1980-01-01
    v.setUint32(14, crc, true);
    v.setUint32(18, compressedSize, true);
    v.setUint32(22, size, true);
    v.setUint16(26, nameBytes.length, true);
    header.set(nameBytes, 30);
    this.directory.push({ name: nameBytes, crc, compressedSize, size, offset: this.offset });
    this.parts.push(header, ...compressed);
    this.offset += header.length + compressedSize;
  }

  /** Writes the directory and returns the archive. */
  finish(): Uint8Array {
    const dirStart = this.offset;
    let dirSize = 0;
    for (const e of this.directory) {
      const rec = new Uint8Array(46 + e.name.length);
      const v = new DataView(rec.buffer);
      v.setUint32(0, CENTRAL, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 20, true);
      v.setUint16(8, 0x0800, true);
      v.setUint16(10, 8, true);
      v.setUint16(12, 0, true);
      v.setUint16(14, 0x21, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.compressedSize, true);
      v.setUint32(24, e.size, true);
      v.setUint16(28, e.name.length, true);
      v.setUint32(42, e.offset, true);
      rec.set(e.name, 46);
      this.parts.push(rec);
      dirSize += rec.length;
    }
    if (dirStart + dirSize >= LIMIT || this.directory.length >= 0xffff) throw new Error('This workbook is too large to save as one .xlsx file (over 4 GB of data). Split it into smaller workbooks.');
    const end = new Uint8Array(22);
    const v = new DataView(end.buffer);
    v.setUint32(0, EOCD, true);
    v.setUint16(8, this.directory.length, true);
    v.setUint16(10, this.directory.length, true);
    v.setUint32(12, dirSize, true);
    v.setUint32(16, dirStart, true);
    this.parts.push(end);
    const out = new Uint8Array(dirStart + dirSize + 22);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    this.parts = [];
    return out;
  }
}
