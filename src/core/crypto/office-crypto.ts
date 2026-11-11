/**
 * MS-OFFCRYPTO password protection for Office Open XML packages (docx / xlsx / pptx).
 *
 * A password-protected OOXML file is not a ZIP: it is an OLE compound file (CFB) holding
 *   EncryptionInfo    – how the package was encrypted (binary header, or XML for "Agile")
 *   EncryptedPackage  – 8-byte little-endian plaintext size + the encrypted ZIP
 *   \x06DataSpaces/…  – fixed bookkeeping streams describing the transform
 *
 * Decryption supports
 *   • Agile    (EncryptionInfo 4.4)        AES-128/192/256-CBC, SHA-1/256/384/512
 *   • Standard (EncryptionInfo 2.2/3.2/4.2) AES-128/192/256-ECB, SHA-1, 50 000 spins
 * Encryption always writes Agile / AES-256-CBC / SHA-512 / spinCount 100 000, which is
 * what current versions of Microsoft Office write themselves.
 *
 * Runs unchanged in browsers and Node: only @noble/hashes, @noble/ciphers and cfb are
 * used (no node:crypto, no Buffer).
 */
import CFB from 'cfb';
import { cbc, ecb } from '@noble/ciphers/aes.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import { PasswordError, UnsupportedError } from '../types';

// ── constants ────────────────────────────────────────────────────────────────

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** The package is encrypted in independent 4096-byte segments (Agile). */
const SEGMENT_SIZE = 4096;
/** EncryptedPackage starts with the plaintext size as a 64-bit little-endian integer. */
const SIZE_PREFIX = 8;
const AES_BLOCK = 16;

/** Agile block keys (MS-OFFCRYPTO 2.3.4.10 – 2.3.4.14). */
const BK_VERIFIER_INPUT = Uint8Array.of(0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79);
const BK_VERIFIER_VALUE = Uint8Array.of(0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e);
const BK_KEY_VALUE = Uint8Array.of(0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6);
const BK_HMAC_KEY = Uint8Array.of(0x5f, 0xb2, 0xad, 0x01, 0x0c, 0xb9, 0xe1, 0xf6);
const BK_HMAC_VALUE = Uint8Array.of(0xa0, 0x67, 0x7f, 0x02, 0xb2, 0x2c, 0x84, 0x33);

const PASSWORD_KEY_ENCRYPTOR_URI = 'http://schemas.microsoft.com/office/2006/keyEncryptor/password';

/** Spec limit for spinCount; also protects against a hostile file pinning the CPU. */
const MAX_SPIN_COUNT = 10_000_000;
/** Office itself does not accept longer passwords. */
const MAX_PASSWORD_LENGTH = 255;

type NobleHash = typeof sha1 | typeof sha256 | typeof sha384 | typeof sha512;

const HASHES: Record<string, NobleHash> = {
  SHA1: sha1,
  'SHA-1': sha1,
  SHA256: sha256,
  'SHA-256': sha256,
  SHA384: sha384,
  'SHA-384': sha384,
  SHA512: sha512,
  'SHA-512': sha512,
};

// ── small byte helpers ───────────────────────────────────────────────────────

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u32le(value: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = value;
  b[1] = value >>> 8;
  b[2] = value >>> 16;
  b[3] = value >>> 24;
  return b;
}

function readU16(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8);
}

function readU32(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

function utf16le(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[2 * i] = c & 0xff;
    out[2 * i + 1] = c >>> 8;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Truncate, or pad with `fill`, to exactly `length` bytes (MS-OFFCRYPTO uses 0x36 padding). */
function fitTo(bytes: Uint8Array, length: number, fill = 0x36): Uint8Array {
  if (bytes.length === length) return bytes;
  if (bytes.length > length) return bytes.subarray(0, length);
  const out = new Uint8Array(length).fill(fill);
  out.set(bytes);
  return out;
}

function zeroPadToBlock(bytes: Uint8Array): Uint8Array {
  const rem = bytes.length % AES_BLOCK;
  if (rem === 0) return bytes;
  const out = new Uint8Array(bytes.length + AES_BLOCK - rem);
  out.set(bytes);
  return out;
}

function base64Decode(text: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(text.replace(/\s+/g, ''));
  } catch {
    throw new UnsupportedError('The encryption information of this document is damaged (invalid base64).');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64Encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function damaged(detail: string): UnsupportedError {
  return new UnsupportedError(`This encrypted document is damaged (${detail}).`);
}

// ── AES (no PKCS#7 padding anywhere in MS-OFFCRYPTO) ─────────────────────────

function aesCbc(encrypt: boolean, key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length === 0) return new Uint8Array(0);
  if (data.length % AES_BLOCK !== 0) throw damaged('encrypted data is not block aligned');
  const cipher = cbc(key, iv, { disablePadding: true });
  return encrypt ? cipher.encrypt(data) : cipher.decrypt(data);
}

function aesEcb(encrypt: boolean, key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length === 0) return new Uint8Array(0);
  if (data.length % AES_BLOCK !== 0) throw damaged('encrypted data is not block aligned');
  const cipher = ecb(key, { disablePadding: true });
  return encrypt ? cipher.encrypt(data) : cipher.decrypt(data);
}

// ── password hashing ─────────────────────────────────────────────────────────

/**
 * H0 = H(salt ‖ password), Hi = H(LE32(i) ‖ Hi-1) for i in [0, spinCount).
 * This is the expensive part (100 000 rounds by default), so it runs over one reused
 * input buffer and writes each digest straight back into it.
 */
function spinPasswordHash(hash: NobleHash, salt: Uint8Array, password: string, spinCount: number): Uint8Array {
  const h0 = hash(concatBytes(salt, utf16le(password)));
  const buf = new Uint8Array(4 + h0.length);
  const digest = buf.subarray(4);
  digest.set(h0);
  for (let i = 0; i < spinCount; i++) {
    buf[0] = i;
    buf[1] = i >>> 8;
    buf[2] = i >>> 16;
    buf[3] = i >>> 24;
    hash.create().update(buf).digestInto(digest);
  }
  return digest.slice();
}

/** Agile: key = H(Hn ‖ blockKey), truncated / 0x36-padded to the key size. */
function agileKey(hash: NobleHash, spun: Uint8Array, blockKey: Uint8Array, keyBytes: number): Uint8Array {
  return fitTo(hash(concatBytes(spun, blockKey)), keyBytes);
}

/** Agile: IV = H(salt ‖ blockKey), truncated / 0x36-padded to the block size. */
function agileIv(hash: NobleHash, salt: Uint8Array, blockKey: Uint8Array, blockSize: number): Uint8Array {
  return fitTo(hash(concatBytes(salt, blockKey)), blockSize);
}

// ── compound file reading ────────────────────────────────────────────────────
//
// The two streams are pulled straight out of the compound file with typed-array copies.
// (cfb's own reader materialises every stream as a plain JS number[] unless it is handed a
// Node Buffer, which is far too slow and memory hungry for multi-megabyte packages. The
// cfb library is still used to *write* compound files below.)

const CFB_MAX_REGULAR_SECTOR = 0xfffffffa; // values >= this are DIFSECT/FATSECT/ENDOFCHAIN/FREESECT
const CFB_NO_STREAM = 0xffffffff;

interface CfbDirEntry {
  name: string;
  type: number; // 1 storage, 2 stream, 5 root
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
}

class CompoundFile {
  private readonly bytes: Uint8Array;
  private readonly sectorSize: number;
  private readonly miniCutoff: number;
  private readonly fat: Uint32Array;
  private readonly entries: CfbDirEntry[];
  private miniFat: Uint32Array | null = null;
  private miniStream: Uint8Array | null = null;
  private readonly miniFatStart: number;

  constructor(bytes: Uint8Array) {
    if (!isCfb(bytes) || bytes.length < 512) throw damaged('not a compound file');
    this.bytes = bytes;
    const major = readU16(bytes, 26);
    const sectorShift = readU16(bytes, 30);
    const miniShift = readU16(bytes, 32);
    if (!((major === 3 && sectorShift === 9) || (major === 4 && sectorShift === 12)) || miniShift !== 6) {
      throw damaged('unsupported compound file layout');
    }
    this.sectorSize = 1 << sectorShift;
    const dirStart = readU32(bytes, 48);
    this.miniCutoff = readU32(bytes, 56);
    this.miniFatStart = readU32(bytes, 60);
    let difatSector = readU32(bytes, 68);

    // FAT sector locations: 109 in the header, the rest in a chain of DIFAT sectors.
    const perSector = this.sectorSize >>> 2;
    const maxSectors = Math.ceil(bytes.length / this.sectorSize);
    const fatSectors: number[] = [];
    for (let i = 0; i < 109; i++) {
      const s = readU32(bytes, 76 + 4 * i);
      if (s < CFB_MAX_REGULAR_SECTOR) fatSectors.push(s);
    }
    for (let guard = 0; difatSector < CFB_MAX_REGULAR_SECTOR; guard++) {
      if (guard > maxSectors) throw damaged('compound file DIFAT loop');
      const off = this.sectorOffset(difatSector);
      if (off + this.sectorSize > bytes.length) throw damaged('compound file DIFAT out of range');
      for (let i = 0; i < perSector - 1; i++) {
        const s = readU32(bytes, off + 4 * i);
        if (s < CFB_MAX_REGULAR_SECTOR) fatSectors.push(s);
      }
      difatSector = readU32(bytes, off + this.sectorSize - 4);
    }

    this.fat = new Uint32Array(fatSectors.length * perSector);
    for (let i = 0; i < fatSectors.length; i++) {
      const off = this.sectorOffset(fatSectors[i]);
      if (off + this.sectorSize > bytes.length) throw damaged('compound file FAT out of range');
      const base = i * perSector;
      for (let j = 0; j < perSector; j++) this.fat[base + j] = readU32(bytes, off + 4 * j);
    }

    // Directory
    const dir = this.readChain(dirStart, -1);
    this.entries = [];
    for (let off = 0; off + 128 <= dir.length; off += 128) {
      const nameBytes = Math.min(Math.max(readU16(dir, off + 64) - 2, 0), 62);
      let name = '';
      for (let i = 0; i < nameBytes; i += 2) name += String.fromCharCode(readU16(dir, off + i));
      const sizeLow = readU32(dir, off + 120);
      const sizeHigh = major === 4 ? readU32(dir, off + 124) : 0; // v3 writers may leave junk here
      this.entries.push({
        name,
        type: dir[off + 66],
        left: readU32(dir, off + 68),
        right: readU32(dir, off + 72),
        child: readU32(dir, off + 76),
        start: readU32(dir, off + 116),
        size: sizeLow + sizeHigh * 0x100000000,
      });
    }
    if (this.entries.length === 0 || this.entries[0].type !== 5) throw damaged('compound file has no root entry');
  }

  private sectorOffset(sector: number): number {
    return (sector + 1) * this.sectorSize;
  }

  /** Follow a FAT chain. `size` < 0 reads until end-of-chain (used for the directory). */
  private readChain(start: number, size: number): Uint8Array {
    const { bytes, fat, sectorSize } = this;
    if (size >= 0) {
      if (size > bytes.length) throw damaged('stream is larger than the file');
      const out = new Uint8Array(size);
      let sector = start;
      for (let pos = 0; pos < size; pos += sectorSize) {
        if (sector >= fat.length) throw damaged('broken sector chain');
        const off = this.sectorOffset(sector);
        const n = Math.min(sectorSize, size - pos);
        if (off + n > bytes.length) throw damaged('stream runs past the end of the file');
        out.set(bytes.subarray(off, off + n), pos);
        sector = fat[sector];
      }
      return out;
    }
    const sectors: number[] = [];
    for (let sector = start; sector < CFB_MAX_REGULAR_SECTOR; sector = fat[sector]) {
      if (sector >= fat.length || sectors.length > fat.length) throw damaged('broken sector chain');
      sectors.push(sector);
    }
    const out = new Uint8Array(sectors.length * sectorSize);
    for (let i = 0; i < sectors.length; i++) {
      const off = this.sectorOffset(sectors[i]);
      out.set(bytes.subarray(off, Math.min(off + sectorSize, bytes.length)), i * sectorSize);
    }
    return out;
  }

  private readMini(start: number, size: number): Uint8Array {
    if (!this.miniFat || !this.miniStream) {
      const raw = this.readChain(this.miniFatStart, -1);
      const miniFat = new Uint32Array(raw.length >>> 2);
      for (let i = 0; i < miniFat.length; i++) miniFat[i] = readU32(raw, 4 * i);
      this.miniFat = miniFat;
      // The mini stream lives in the root entry's regular sector chain.
      this.miniStream = this.readChain(this.entries[0].start, -1);
    }
    const out = new Uint8Array(size);
    let sector = start;
    for (let pos = 0; pos < size; pos += 64) {
      if (sector >= this.miniFat.length) throw damaged('broken mini sector chain');
      const off = sector * 64;
      const n = Math.min(64, size - pos);
      if (off + n > this.miniStream.length) throw damaged('mini stream runs past its container');
      out.set(this.miniStream.subarray(off, off + n), pos);
      sector = this.miniFat[sector];
    }
    return out;
  }

  /** Find a stream that is a direct child of the root storage (names compare case-insensitively). */
  findRootStream(name: string): CfbDirEntry | null {
    const wanted = name.toUpperCase();
    const seen = new Set<number>();
    const stack = [this.entries[0].child];
    while (stack.length > 0) {
      const id = stack.pop() as number;
      if (id === CFB_NO_STREAM || id >= this.entries.length || seen.has(id)) continue;
      seen.add(id);
      const entry = this.entries[id];
      if (entry.type === 2 && entry.name.toUpperCase() === wanted) return entry;
      stack.push(entry.left, entry.right);
    }
    return null;
  }

  readStream(entry: CfbDirEntry): Uint8Array {
    if (entry.size === 0) return new Uint8Array(0);
    return entry.size < this.miniCutoff ? this.readMini(entry.start, entry.size) : this.readChain(entry.start, entry.size);
  }
}

// ── public detection helpers ─────────────────────────────────────────────────

/** True when the bytes start with the OLE compound file signature D0 CF 11 E0 A1 B1 1A E1. */
export function isCfb(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < CFB_MAGIC.length) return false;
  for (let i = 0; i < CFB_MAGIC.length; i++) if (bytes[i] !== CFB_MAGIC[i]) return false;
  return true;
}

/** True for a compound file that carries both an EncryptionInfo and an EncryptedPackage stream. */
export function isOfficeEncrypted(bytes: Uint8Array): boolean {
  if (!isCfb(bytes)) return false;
  try {
    const file = new CompoundFile(bytes);
    return file.findRootStream('EncryptionInfo') !== null && file.findRootStream('EncryptedPackage') !== null;
  } catch {
    return false;
  }
}

// ── package (EncryptedPackage stream) helpers ────────────────────────────────

function readPackageSize(encryptedPackage: Uint8Array): number {
  if (encryptedPackage.length < SIZE_PREFIX) throw damaged('EncryptedPackage is too short');
  const size = readU32(encryptedPackage, 0) + readU32(encryptedPackage, 4) * 0x100000000;
  if (size > encryptedPackage.length - SIZE_PREFIX) throw damaged('EncryptedPackage is truncated');
  return size;
}

/** Cut the decrypted (block padded) data down to the size recorded in the stream prefix. */
function trimPackage(plain: Uint8Array, size: number): Uint8Array {
  if (size > plain.length) throw damaged('EncryptedPackage is truncated');
  return size === plain.length ? plain : plain.slice(0, size);
}

// ── Agile encryption (EncryptionInfo 4.4) ────────────────────────────────────

interface AgileCipherParams {
  hash: NobleHash;
  saltSize: number;
  blockSize: number;
  keyBytes: number;
  hashSize: number;
  salt: Uint8Array;
}

interface AgileInfo {
  keyData: AgileCipherParams;
  key: AgileCipherParams & {
    spinCount: number;
    encryptedVerifierHashInput: Uint8Array;
    encryptedVerifierHashValue: Uint8Array;
    encryptedKeyValue: Uint8Array;
  };
}

type XmlAttrs = Record<string, string>;

const XML_START_TAG = /<(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/g;
const XML_ATTR = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(text: string): XmlAttrs {
  const attrs: XmlAttrs = {};
  for (const m of text.matchAll(XML_ATTR)) attrs[m[1]] = m[2] ?? m[3] ?? '';
  return attrs;
}

function intAttr(attrs: XmlAttrs, name: string): number {
  const value = Number(attrs[name]);
  if (!Number.isInteger(value) || value < 0) throw damaged(`bad ${name} in EncryptionInfo`);
  return value;
}

function parseCipherParams(attrs: XmlAttrs): AgileCipherParams {
  const cipher = attrs.cipherAlgorithm;
  if (cipher !== 'AES') {
    throw new UnsupportedError(`This document is encrypted with an unsupported cipher (${cipher ?? 'unknown'}).`);
  }
  const chaining = attrs.cipherChaining;
  if (chaining !== 'ChainingModeCBC') {
    throw new UnsupportedError(`This document is encrypted with an unsupported cipher mode (${chaining ?? 'unknown'}).`);
  }
  const hash = HASHES[(attrs.hashAlgorithm ?? '').toUpperCase()];
  if (!hash) {
    throw new UnsupportedError(
      `This document is encrypted with an unsupported hash algorithm (${attrs.hashAlgorithm ?? 'unknown'}).`,
    );
  }
  const keyBits = intAttr(attrs, 'keyBits');
  if (keyBits !== 128 && keyBits !== 192 && keyBits !== 256) {
    throw new UnsupportedError(`This document is encrypted with an unsupported AES key size (${keyBits} bits).`);
  }
  const blockSize = intAttr(attrs, 'blockSize');
  if (blockSize !== AES_BLOCK) throw damaged(`AES block size ${blockSize}`);
  const hashSize = intAttr(attrs, 'hashSize');
  if (hashSize < 1 || hashSize > hash.outputLen) throw damaged(`hash size ${hashSize}`);
  const saltSize = intAttr(attrs, 'saltSize');
  if (saltSize < 1 || saltSize > 65536) throw damaged(`salt size ${saltSize}`);
  if (attrs.saltValue === undefined) throw damaged('missing salt');
  return { hash, saltSize, blockSize, keyBytes: keyBits / 8, hashSize, salt: base64Decode(attrs.saltValue) };
}

function parseAgileInfo(encryptionInfo: Uint8Array): AgileInfo {
  const xml = new TextDecoder('utf-8').decode(encryptionInfo.subarray(8));
  let keyDataAttrs: XmlAttrs | null = null;
  let keyAttrs: XmlAttrs | null = null;
  let encryptorUri = '';
  let sawEncryptor = false;
  for (const m of xml.matchAll(XML_START_TAG)) {
    const local = m[1];
    if (local === 'keyData' && !keyDataAttrs) {
      keyDataAttrs = parseAttrs(m[2]);
    } else if (local === 'keyEncryptor') {
      sawEncryptor = true;
      encryptorUri = parseAttrs(m[2]).uri ?? '';
    } else if (local === 'encryptedKey' && !keyAttrs && encryptorUri === PASSWORD_KEY_ENCRYPTOR_URI) {
      keyAttrs = parseAttrs(m[2]);
    }
  }
  if (!keyDataAttrs) throw damaged('EncryptionInfo has no keyData');
  if (!keyAttrs) {
    if (sawEncryptor) {
      throw new UnsupportedError(
        'This document is protected with a certificate rather than a password, which is not supported.',
      );
    }
    throw damaged('EncryptionInfo has no key encryptor');
  }
  const spinCount = intAttr(keyAttrs, 'spinCount');
  if (spinCount > MAX_SPIN_COUNT) throw damaged(`spin count ${spinCount}`);
  for (const name of ['encryptedVerifierHashInput', 'encryptedVerifierHashValue', 'encryptedKeyValue']) {
    if (keyAttrs[name] === undefined) throw damaged(`missing ${name}`);
  }
  return {
    keyData: parseCipherParams(keyDataAttrs),
    key: {
      ...parseCipherParams(keyAttrs),
      spinCount,
      encryptedVerifierHashInput: base64Decode(keyAttrs.encryptedVerifierHashInput),
      encryptedVerifierHashValue: base64Decode(keyAttrs.encryptedVerifierHashValue),
      encryptedKeyValue: base64Decode(keyAttrs.encryptedKeyValue),
    },
  };
}

function decryptAgile(encryptionInfo: Uint8Array, encryptedPackage: Uint8Array, password: string): Uint8Array {
  const { keyData, key } = parseAgileInfo(encryptionInfo);

  // One spin loop serves all three password-derived keys; they differ only in the final block key.
  const spun = spinPasswordHash(key.hash, key.salt, password, key.spinCount);
  const keyIv = fitTo(key.salt, key.blockSize);

  const verifierInput = aesCbc(
    false,
    agileKey(key.hash, spun, BK_VERIFIER_INPUT, key.keyBytes),
    keyIv,
    key.encryptedVerifierHashInput,
  );
  const verifierValue = aesCbc(
    false,
    agileKey(key.hash, spun, BK_VERIFIER_VALUE, key.keyBytes),
    keyIv,
    key.encryptedVerifierHashValue,
  );
  // Both values were zero padded to the block size before encryption.
  const expected = key.hash(verifierInput.subarray(0, Math.min(key.saltSize, verifierInput.length)));
  if (
    verifierValue.length < key.hashSize ||
    !bytesEqual(expected.subarray(0, key.hashSize), verifierValue.subarray(0, key.hashSize))
  ) {
    throw new PasswordError('password-incorrect');
  }

  const packageKey = aesCbc(
    false,
    agileKey(key.hash, spun, BK_KEY_VALUE, key.keyBytes),
    keyIv,
    key.encryptedKeyValue,
  );
  if (packageKey.length < keyData.keyBytes) throw damaged('package key is too short');
  const secret = packageKey.subarray(0, keyData.keyBytes);

  const size = readPackageSize(encryptedPackage);
  const data = encryptedPackage.subarray(SIZE_PREFIX);
  // Only whole cipher blocks can hold data; ignore any stray trailing bytes.
  const usable = data.length - (data.length % AES_BLOCK);
  const plain = new Uint8Array(usable);
  for (let off = 0, segment = 0; off < usable; off += SEGMENT_SIZE, segment++) {
    const iv = agileIv(keyData.hash, keyData.salt, u32le(segment), keyData.blockSize);
    plain.set(aesCbc(false, secret, iv, data.subarray(off, Math.min(off + SEGMENT_SIZE, usable))), off);
  }
  return trimPackage(plain, size);
}

// ── Standard encryption (EncryptionInfo 2.2 / 3.2 / 4.2, Office 2007) ────────

const STANDARD_SPIN_COUNT = 50000;
const FLAG_CRYPTOAPI = 0x04;
const FLAG_EXTERNAL = 0x10;
const FLAG_AES = 0x20;
const ALG_AES_128 = 0x660e;
const ALG_AES_192 = 0x660f;
const ALG_AES_256 = 0x6610;
const ALG_RC4 = 0x6801;
const ALG_HASH_SHA1 = 0x8004;

function standardKey(password: string, salt: Uint8Array, keyBytes: number): Uint8Array {
  const spun = spinPasswordHash(sha1, salt, password, STANDARD_SPIN_COUNT);
  const hFinal = sha1(concatBytes(spun, u32le(0)));
  // CryptDeriveKey style expansion (MS-OFFCRYPTO 2.3.4.7).
  const derive = (fill: number): Uint8Array => {
    const buf = new Uint8Array(64).fill(fill);
    for (let i = 0; i < hFinal.length; i++) buf[i] ^= hFinal[i];
    return sha1(buf);
  };
  return concatBytes(derive(0x36), derive(0x5c)).subarray(0, keyBytes);
}

function decryptStandard(encryptionInfo: Uint8Array, encryptedPackage: Uint8Array, password: string): Uint8Array {
  if (encryptionInfo.length < 12) throw damaged('EncryptionInfo is too short');
  const flags = readU32(encryptionInfo, 4);
  const headerSize = readU32(encryptionInfo, 8);
  const header = 12;
  const verifier = header + headerSize;
  if (headerSize < 32 || verifier + 4 + 16 + 16 + 4 + 32 > encryptionInfo.length) {
    throw damaged('EncryptionInfo is too short');
  }
  if (flags & FLAG_EXTERNAL) {
    throw new UnsupportedError('This document uses an external encryption provider, which is not supported.');
  }
  const algId = readU32(encryptionInfo, header + 8);
  const algIdHash = readU32(encryptionInfo, header + 12);
  const keySize = readU32(encryptionInfo, header + 16);
  if (algId === ALG_RC4 || !(flags & FLAG_AES) || !(flags & FLAG_CRYPTOAPI)) {
    throw new UnsupportedError('This document is encrypted with RC4, which is not supported.');
  }
  let keyBytes: number;
  switch (algId) {
    case ALG_AES_128:
      keyBytes = 16;
      break;
    case ALG_AES_192:
      keyBytes = 24;
      break;
    case ALG_AES_256:
      keyBytes = 32;
      break;
    case 0:
      keyBytes = keySize === 0 ? 16 : keySize / 8;
      break;
    default:
      throw new UnsupportedError(
        `This document is encrypted with an unsupported algorithm (0x${algId.toString(16)}).`,
      );
  }
  if ((keyBytes !== 16 && keyBytes !== 24 && keyBytes !== 32) || (keySize !== 0 && keySize !== keyBytes * 8)) {
    throw new UnsupportedError(`This document is encrypted with an unsupported AES key size (${keySize} bits).`);
  }
  if (algIdHash !== ALG_HASH_SHA1 && algIdHash !== 0) {
    throw new UnsupportedError(
      `This document is encrypted with an unsupported hash algorithm (0x${algIdHash.toString(16)}).`,
    );
  }
  const saltSize = readU32(encryptionInfo, verifier);
  if (saltSize !== 16) throw damaged(`salt size ${saltSize}`);
  const salt = encryptionInfo.subarray(verifier + 4, verifier + 20);
  const encryptedVerifier = encryptionInfo.subarray(verifier + 20, verifier + 36);
  const verifierHashSize = readU32(encryptionInfo, verifier + 36);
  const encryptedVerifierHash = encryptionInfo.subarray(verifier + 40, verifier + 72);
  if (verifierHashSize !== sha1.outputLen) throw damaged(`verifier hash size ${verifierHashSize}`);

  const key = standardKey(password, salt, keyBytes);
  const expected = sha1(aesEcb(false, key, encryptedVerifier));
  const actual = aesEcb(false, key, encryptedVerifierHash).subarray(0, verifierHashSize);
  if (!bytesEqual(expected, actual)) throw new PasswordError('password-incorrect');

  const size = readPackageSize(encryptedPackage);
  const data = encryptedPackage.subarray(SIZE_PREFIX);
  const usable = data.length - (data.length % AES_BLOCK);
  return trimPackage(aesEcb(false, key, data.subarray(0, usable)), size);
}

// ── decrypt ──────────────────────────────────────────────────────────────────

/**
 * Decrypt a password-protected OOXML file and return the inner ZIP package.
 * @throws PasswordError('password-incorrect') when the password does not match
 * @throws UnsupportedError for schemes we cannot read (RC4, Extensible, certificates, …) or damaged files
 */
export async function decryptOffice(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  if (!isCfb(bytes)) throw new UnsupportedError('This file is not a password-protected Office document.');
  const file = new CompoundFile(bytes);
  const infoEntry = file.findRootStream('EncryptionInfo');
  const packageEntry = file.findRootStream('EncryptedPackage');
  if (!infoEntry || !packageEntry) {
    throw new UnsupportedError(
      'This file is not a password-protected Office Open XML document (legacy binary Office encryption is not supported).',
    );
  }
  const encryptionInfo = file.readStream(infoEntry);
  if (encryptionInfo.length < 8) throw damaged('EncryptionInfo is too short');
  const major = readU16(encryptionInfo, 0);
  const minor = readU16(encryptionInfo, 2);

  if (major === 4 && minor === 4) {
    return decryptAgile(encryptionInfo, file.readStream(packageEntry), password);
  }
  if (minor === 2 && (major === 2 || major === 3 || major === 4)) {
    return decryptStandard(encryptionInfo, file.readStream(packageEntry), password);
  }
  if (minor === 3 && (major === 3 || major === 4)) {
    throw new UnsupportedError('This document uses Extensible encryption, which is not supported.');
  }
  if (major === 1 && minor === 1) {
    throw new UnsupportedError('This document is encrypted with RC4, which is not supported.');
  }
  throw new UnsupportedError(`This document uses an unknown encryption scheme (version ${major}.${minor}).`);
}

// ── encrypt ──────────────────────────────────────────────────────────────────

const ENCRYPT_HASH = sha512;
const ENCRYPT_HASH_NAME = 'SHA512';
const ENCRYPT_HASH_SIZE = 64;
const ENCRYPT_KEY_BYTES = 32;
const ENCRYPT_SALT_SIZE = 16;
const ENCRYPT_SPIN_COUNT = 100000;

/** UNICODE-LP-P4: byte length, UTF-16LE text, zero padding to a 4-byte boundary. */
function unicodeLpP4(text: string): Uint8Array {
  const data = utf16le(text);
  const out = new Uint8Array(4 + data.length + ((4 - (data.length % 4)) % 4));
  out.set(u32le(data.length));
  out.set(data, 4);
  return out;
}

/** Reader / updater / writer version 1.0 (each: UInt16 major, UInt16 minor). */
function versionTriple(): Uint8Array {
  return concatBytes(u32le(1), u32le(1), u32le(1));
}

/** \x06DataSpaces/Version – DataSpaceVersionInfo (MS-OFFCRYPTO 2.1.5). */
function dataSpaceVersion(): Uint8Array {
  return concatBytes(unicodeLpP4('Microsoft.Container.DataSpaces'), versionTriple());
}

/** \x06DataSpaces/DataSpaceMap – one entry mapping the EncryptedPackage stream (2.1.6). */
function dataSpaceMap(): Uint8Array {
  const component = concatBytes(u32le(0), unicodeLpP4('EncryptedPackage')); // 0 = stream
  const dataSpaceName = unicodeLpP4('StrongEncryptionDataSpace');
  const entryLength = 4 + 4 + component.length + dataSpaceName.length;
  return concatBytes(u32le(8), u32le(1), u32le(entryLength), u32le(1), component, dataSpaceName);
}

/** \x06DataSpaces/DataSpaceInfo/StrongEncryptionDataSpace – DataSpaceDefinition (2.1.7). */
function dataSpaceDefinition(): Uint8Array {
  return concatBytes(u32le(8), u32le(1), unicodeLpP4('StrongEncryptionTransform'));
}

/** \x06DataSpaces/TransformInfo/StrongEncryptionTransform/\x06Primary (2.1.8, 2.1.9, 2.3.4.3). */
function transformPrimary(): Uint8Array {
  const transformId = unicodeLpP4('{FF9A3F03-56EF-4613-BDD5-5A41C1D07246}');
  const transformName = unicodeLpP4('Microsoft.Container.EncryptionTransform');
  return concatBytes(
    u32le(4 + 4 + transformId.length), // TransformLength: bytes before TransformName
    u32le(1), // TransformType
    transformId,
    transformName,
    versionTriple(),
    // EncryptionTransformInfo: empty EncryptionName, EncryptionBlockSize 0, CipherMode 0, Reserved 4
    u32le(0),
    u32le(0),
    u32le(0),
    u32le(4),
  );
}

function buildEncryptionInfoXml(fields: {
  keyDataSalt: Uint8Array;
  encryptedHmacKey: Uint8Array;
  encryptedHmacValue: Uint8Array;
  keySalt: Uint8Array;
  encryptedVerifierHashInput: Uint8Array;
  encryptedVerifierHashValue: Uint8Array;
  encryptedKeyValue: Uint8Array;
}): string {
  const common =
    `saltSize="${ENCRYPT_SALT_SIZE}" blockSize="${AES_BLOCK}" keyBits="${ENCRYPT_KEY_BYTES * 8}" ` +
    `hashSize="${ENCRYPT_HASH_SIZE}" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" ` +
    `hashAlgorithm="${ENCRYPT_HASH_NAME}"`;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    '<encryption xmlns="http://schemas.microsoft.com/office/2006/encryption" ' +
    'xmlns:p="http://schemas.microsoft.com/office/2006/keyEncryptor/password" ' +
    'xmlns:c="http://schemas.microsoft.com/office/2006/keyEncryptor/certificate">' +
    `<keyData ${common} saltValue="${base64Encode(fields.keyDataSalt)}"/>` +
    `<dataIntegrity encryptedHmacKey="${base64Encode(fields.encryptedHmacKey)}" ` +
    `encryptedHmacValue="${base64Encode(fields.encryptedHmacValue)}"/>` +
    '<keyEncryptors>' +
    `<keyEncryptor uri="${PASSWORD_KEY_ENCRYPTOR_URI}">` +
    `<p:encryptedKey spinCount="${ENCRYPT_SPIN_COUNT}" ${common} saltValue="${base64Encode(fields.keySalt)}" ` +
    `encryptedVerifierHashInput="${base64Encode(fields.encryptedVerifierHashInput)}" ` +
    `encryptedVerifierHashValue="${base64Encode(fields.encryptedVerifierHashValue)}" ` +
    `encryptedKeyValue="${base64Encode(fields.encryptedKeyValue)}"/>` +
    '</keyEncryptor>' +
    '</keyEncryptors>' +
    '</encryption>'
  );
}

/**
 * Password-protect an OOXML package (the ZIP bytes of a .docx/.xlsx/.pptx).
 * Returns an OLE compound file using Agile encryption (AES-256-CBC, SHA-512, 100 000 spins).
 */
export async function encryptOffice(packageBytes: Uint8Array, password: string): Promise<Uint8Array> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('A password is required to protect a document.');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`The password must be at most ${MAX_PASSWORD_LENGTH} characters long.`);
  }

  const hash = ENCRYPT_HASH;
  const packageKey = randomBytes(ENCRYPT_KEY_BYTES);
  const keyDataSalt = randomBytes(ENCRYPT_SALT_SIZE);
  const keySalt = randomBytes(ENCRYPT_SALT_SIZE);

  // EncryptedPackage: 64-bit size, then 4096-byte segments, each AES-CBC encrypted with its own IV.
  const size = packageBytes.length;
  const paddedSize = size + ((AES_BLOCK - (size % AES_BLOCK)) % AES_BLOCK);
  const encryptedPackage = new Uint8Array(SIZE_PREFIX + paddedSize);
  encryptedPackage.set(u32le(size >>> 0), 0);
  encryptedPackage.set(u32le(Math.floor(size / 0x100000000)), 4);
  for (let off = 0, segment = 0; off < size; off += SEGMENT_SIZE, segment++) {
    const iv = agileIv(hash, keyDataSalt, u32le(segment), AES_BLOCK);
    const chunk = zeroPadToBlock(packageBytes.subarray(off, Math.min(off + SEGMENT_SIZE, size)));
    encryptedPackage.set(aesCbc(true, packageKey, iv, chunk), SIZE_PREFIX + off);
  }

  // Data integrity: HMAC over the whole EncryptedPackage stream (size prefix included).
  const hmacKey = randomBytes(ENCRYPT_HASH_SIZE);
  const encryptedHmacKey = aesCbc(true, packageKey, agileIv(hash, keyDataSalt, BK_HMAC_KEY, AES_BLOCK), hmacKey);
  const hmacValue = hmac(hash, hmacKey, encryptedPackage);
  const encryptedHmacValue = aesCbc(
    true,
    packageKey,
    agileIv(hash, keyDataSalt, BK_HMAC_VALUE, AES_BLOCK),
    zeroPadToBlock(hmacValue),
  );

  // Password key encryptor.
  const spun = spinPasswordHash(hash, keySalt, password, ENCRYPT_SPIN_COUNT);
  const verifierInput = randomBytes(ENCRYPT_SALT_SIZE);
  const encryptedVerifierHashInput = aesCbc(
    true,
    agileKey(hash, spun, BK_VERIFIER_INPUT, ENCRYPT_KEY_BYTES),
    keySalt,
    zeroPadToBlock(verifierInput),
  );
  const encryptedVerifierHashValue = aesCbc(
    true,
    agileKey(hash, spun, BK_VERIFIER_VALUE, ENCRYPT_KEY_BYTES),
    keySalt,
    zeroPadToBlock(hash(verifierInput)),
  );
  const encryptedKeyValue = aesCbc(
    true,
    agileKey(hash, spun, BK_KEY_VALUE, ENCRYPT_KEY_BYTES),
    keySalt,
    packageKey,
  );

  const xml = buildEncryptionInfoXml({
    keyDataSalt,
    encryptedHmacKey,
    encryptedHmacValue,
    keySalt,
    encryptedVerifierHashInput,
    encryptedVerifierHashValue,
    encryptedKeyValue,
  });
  // Version 4.4, flags 0x40 (fAgile), then the XML descriptor.
  const encryptionInfo = concatBytes(
    Uint8Array.of(0x04, 0x00, 0x04, 0x00, 0x40, 0x00, 0x00, 0x00),
    new TextEncoder().encode(xml),
  );

  const container = CFB.utils.cfb_new();
  const add = (path: string, content: Uint8Array): void => {
    CFB.utils.cfb_add(container, path, content);
  };
  add('/\u0006DataSpaces/Version', dataSpaceVersion());
  add('/\u0006DataSpaces/DataSpaceMap', dataSpaceMap());
  add('/\u0006DataSpaces/DataSpaceInfo/StrongEncryptionDataSpace', dataSpaceDefinition());
  add('/\u0006DataSpaces/TransformInfo/StrongEncryptionTransform/\u0006Primary', transformPrimary());
  add('/EncryptionInfo', encryptionInfo);
  add('/EncryptedPackage', encryptedPackage);

  const written: unknown = CFB.write(container, { type: 'array' });
  // cfb returns a Node Buffer under Node and a Uint8Array / number[] elsewhere; always hand
  // back a plain Uint8Array that owns exactly its own bytes.
  const out =
    written instanceof Uint8Array ? new Uint8Array(written) : Uint8Array.from(written as ArrayLike<number>);
  removeSeedStream(out);
  return out;
}

/**
 * cfb puts a 4-byte marker stream named "\x01Sh33tJ5" into every container it writes (it is
 * re-added on write even after cfb_del). Office never writes such a stream, so unlink it from
 * the finished file: it sorts first among the root's children, which makes it directory entry 1
 * with the rest of the root's children hanging off its right-sibling pointer.
 *
 * The file is only touched when it looks exactly as expected; otherwise it is left alone
 * (the marker stream is harmless, merely untidy).
 */
function removeSeedStream(file: Uint8Array): void {
  const SECTOR = 512;
  const SEED_NAME = '\u0001Sh33tJ5';
  if (file.length < 3 * SECTOR || readU16(file, 30) !== 9) return;
  const dirOffset = (readU32(file, 48) + 1) * SECTOR;
  const entry = dirOffset + 128;
  if (entry + 128 > file.length) return;

  if (readU32(file, dirOffset + 76) !== 1) return; // root's child must be the seed entry
  if (readU16(file, entry + 64) !== 2 * (SEED_NAME.length + 1) || file[entry + 66] !== 2) return;
  for (let i = 0; i < SEED_NAME.length; i++) {
    if (readU16(file, entry + 2 * i) !== SEED_NAME.charCodeAt(i)) return;
  }
  const left = readU32(file, entry + 68);
  const right = readU32(file, entry + 72);
  const child = readU32(file, entry + 76);
  const miniSector = readU32(file, entry + 116);
  const size = readU32(file, entry + 120);
  if (left !== CFB_NO_STREAM || child !== CFB_NO_STREAM || size === 0 || size > 64) return;

  const miniFatOffset = (readU32(file, 60) + 1) * SECTOR + 4 * miniSector;
  const miniStreamOffset = (readU32(file, dirOffset + 116) + 1) * SECTOR + 64 * miniSector;
  if (miniSector >= SECTOR / 4 || miniFatOffset + 4 > file.length || miniStreamOffset + 64 > file.length) return;
  if (readU32(file, miniFatOffset) !== 0xfffffffe) return; // single mini sector, end of chain

  // Root now points at what used to be the seed's right sibling.
  file.set(u32le(right), dirOffset + 76);
  // Turn the directory entry into an unallocated one.
  file.fill(0, entry, entry + 128);
  file.fill(0xff, entry + 68, entry + 80);
  // Release its mini sector.
  file.fill(0xff, miniFatOffset, miniFatOffset + 4);
  file.fill(0, miniStreamOffset, miniStreamOffset + 64);
}
