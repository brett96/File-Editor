/**
 * MS-OFFCRYPTO interoperability tests.
 *
 * Oracles used here, all independent of the noble-based implementation under test:
 *   • officecrypto-tool  – third-party implementation (agile + standard, node:crypto based)
 *   • node:crypto        – small spec-level helpers below, used to check the dataIntegrity HMAC
 *                          and to produce parameter combinations officecrypto-tool cannot write
 *   • cfb                – parses the compound files we emit
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import CFB from 'cfb';
import JSZip from 'jszip';
import officeCrypto from 'officecrypto-tool';
import { beforeAll, describe, expect, it } from 'vitest';
import { decryptOffice, encryptOffice, isCfb, isOfficeEncrypted } from '../src/core/crypto/office-crypto';
import { PasswordError, UnsupportedError } from '../src/core/types';

const PASSWORD = 'correct horse battery staple';
const UNICODE_PASSWORD = 'pässwörd-密码-пароль-🔐';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Compare without letting vitest try to diff megabytes of bytes. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

async function makeZip(files: Record<string, string | Uint8Array>, compress = true): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array', compression: compress ? 'DEFLATE' : 'STORE' });
}

/** A minimal but real OOXML-shaped zip whose length is not a multiple of 16 (nor of 4096). */
async function makeSmallZip(): Promise<Uint8Array> {
  for (let filler = 0; filler < 64; filler++) {
    const zip = await makeZip({
      '[Content_Types].xml':
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
      'word/document.xml': `<w:document><w:body><w:p><w:r><w:t>Hello${'!'.repeat(filler)}</w:t></w:r></w:p></w:body></w:document>`,
    }, false);
    if (zip.length % 16 !== 0 && zip.length % 4096 !== 0) return zip;
  }
  throw new Error('could not build a zip with an unaligned length');
}

/** A real zip well over one 4096-byte segment (stored random data, so it cannot shrink). */
async function makeLargeZip(): Promise<Uint8Array> {
  for (let filler = 0; filler < 64; filler++) {
    const zip = await makeZip({ 'word/media/image1.bin': new Uint8Array(randomBytes(20000 + filler)) }, false);
    if (zip.length % 16 !== 0 && zip.length % 4096 !== 0) return zip;
  }
  throw new Error('could not build a zip with an unaligned length');
}

function readCfbStream(file: Uint8Array, path: string): Buffer | null {
  const container = CFB.read(Buffer.from(file), { type: 'buffer' });
  const entry = CFB.find(container, path);
  return entry ? Buffer.from(entry.content as Uint8Array) : null;
}

function writeCfb(streams: Record<string, Uint8Array>): Uint8Array {
  const container = CFB.utils.cfb_new();
  for (const [name, content] of Object.entries(streams)) CFB.utils.cfb_add(container, name, Buffer.from(content));
  return new Uint8Array(CFB.write(container, { type: 'buffer' }) as Buffer);
}

// ── spec-level reference helpers on node:crypto ──────────────────────────────

const BK = {
  verifierInput: Buffer.from([0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79]),
  verifierValue: Buffer.from([0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e]),
  key: Buffer.from([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]),
  hmacKey: Buffer.from([0x5f, 0xb2, 0xad, 0x01, 0x0c, 0xb9, 0xe1, 0xf6]),
  hmacValue: Buffer.from([0xa0, 0x67, 0x7f, 0x02, 0xb2, 0x2c, 0x84, 0x33]),
};

type NodeHash = 'sha1' | 'sha256' | 'sha384' | 'sha512';

function nodeHash(alg: NodeHash, ...parts: Uint8Array[]): Buffer {
  const h = createHash(alg);
  for (const p of parts) h.update(p);
  return h.digest();
}

function fit(buf: Buffer, length: number): Buffer {
  if (buf.length >= length) return buf.subarray(0, length);
  const out = Buffer.alloc(length, 0x36);
  buf.copy(out);
  return out;
}

function zeroPad(buf: Buffer, block = 16): Buffer {
  const rem = buf.length % block;
  return rem ? Buffer.concat([buf, Buffer.alloc(block - rem)]) : buf;
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}

function nodeSpin(alg: NodeHash, salt: Uint8Array, password: string, spinCount: number): Buffer {
  let h = nodeHash(alg, salt, Buffer.from(password, 'utf16le'));
  for (let i = 0; i < spinCount; i++) h = nodeHash(alg, u32(i), h);
  return h;
}

function nodeAes(mode: 'cbc' | 'ecb', encrypt: boolean, key: Buffer, iv: Buffer | null, data: Buffer): Buffer {
  const name = `aes-${key.length * 8}-${mode}`;
  const cipher = encrypt ? createCipheriv(name, key, iv) : createDecipheriv(name, key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function attr(xml: string, element: string, name: string): string {
  const tag = new RegExp(`<${element}\\s[^>]*>`).exec(xml);
  if (!tag) throw new Error(`no <${element}> in EncryptionInfo`);
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(tag[0]);
  if (!value) throw new Error(`no ${name} on <${element}>`);
  return value[1];
}

/**
 * Recompute the dataIntegrity HMAC of an agile-encrypted file with node:crypto and compare it
 * with the encrypted value stored in EncryptionInfo. This is the check Office performs on open.
 */
function agileIntegrityHolds(file: Uint8Array, password: string): boolean {
  const info = readCfbStream(file, '/EncryptionInfo');
  const encryptedPackage = readCfbStream(file, '/EncryptedPackage');
  if (!info || !encryptedPackage) throw new Error('not an encrypted package');
  expect([...info.subarray(0, 8)]).toEqual([4, 0, 4, 0, 0x40, 0, 0, 0]);
  const xml = info.subarray(8).toString('utf8');

  const keyHash = attr(xml, 'p:encryptedKey', 'hashAlgorithm').toLowerCase() as NodeHash;
  const keySalt = Buffer.from(attr(xml, 'p:encryptedKey', 'saltValue'), 'base64');
  const keyBytes = Number(attr(xml, 'p:encryptedKey', 'keyBits')) / 8;
  const spun = nodeSpin(keyHash, keySalt, password, Number(attr(xml, 'p:encryptedKey', 'spinCount')));
  const dataHash = attr(xml, 'keyData', 'hashAlgorithm').toLowerCase() as NodeHash;
  const dataSalt = Buffer.from(attr(xml, 'keyData', 'saltValue'), 'base64');
  const hashSize = Number(attr(xml, 'keyData', 'hashSize'));
  const packageKey = nodeAes(
    'cbc',
    false,
    fit(nodeHash(keyHash, spun, BK.key), keyBytes),
    keySalt,
    Buffer.from(attr(xml, 'p:encryptedKey', 'encryptedKeyValue'), 'base64'),
  ).subarray(0, Number(attr(xml, 'keyData', 'keyBits')) / 8);

  const hmacKey = nodeAes(
    'cbc',
    false,
    packageKey,
    fit(nodeHash(dataHash, dataSalt, BK.hmacKey), 16),
    Buffer.from(attr(xml, 'dataIntegrity', 'encryptedHmacKey'), 'base64'),
  ).subarray(0, hashSize);
  const storedHmac = nodeAes(
    'cbc',
    false,
    packageKey,
    fit(nodeHash(dataHash, dataSalt, BK.hmacValue), 16),
    Buffer.from(attr(xml, 'dataIntegrity', 'encryptedHmacValue'), 'base64'),
  ).subarray(0, hashSize);
  const actualHmac = createHmac(dataHash, hmacKey).update(encryptedPackage).digest();
  return actualHmac.equals(storedHmac);
}

interface AgileOptions {
  hash: NodeHash;
  keyBits: 128 | 192 | 256;
  spinCount: number;
}

/** Agile encryption written from the spec with node:crypto, for parameter sets the oracle cannot produce. */
function nodeAgileEncrypt(data: Uint8Array, password: string, o: AgileOptions): Uint8Array {
  const hashName = o.hash.toUpperCase();
  const hashSize = createHash(o.hash).digest().length;
  const keyBytes = o.keyBits / 8;
  const packageKey = randomBytes(keyBytes);
  const dataSalt = randomBytes(16);
  const keySalt = randomBytes(16);

  const chunks: Buffer[] = [Buffer.alloc(8)];
  chunks[0].writeUInt32LE(data.length, 0);
  for (let off = 0, i = 0; off < data.length; off += 4096, i++) {
    const iv = fit(nodeHash(o.hash, dataSalt, u32(i)), 16);
    chunks.push(nodeAes('cbc', true, packageKey, iv, zeroPad(Buffer.from(data.subarray(off, off + 4096)))));
  }
  const encryptedPackage = Buffer.concat(chunks);

  const hmacKey = randomBytes(hashSize);
  const encryptedHmacKey = nodeAes(
    'cbc', true, packageKey, fit(nodeHash(o.hash, dataSalt, BK.hmacKey), 16), zeroPad(hmacKey));
  const encryptedHmacValue = nodeAes(
    'cbc', true, packageKey, fit(nodeHash(o.hash, dataSalt, BK.hmacValue), 16),
    zeroPad(createHmac(o.hash, hmacKey).update(encryptedPackage).digest()));

  const spun = nodeSpin(o.hash, keySalt, password, o.spinCount);
  const derive = (blockKey: Buffer): Buffer => fit(nodeHash(o.hash, spun, blockKey), keyBytes);
  const verifierInput = randomBytes(16);
  const b64 = (b: Buffer): string => b.toString('base64');
  const common =
    `saltSize="16" blockSize="16" keyBits="${o.keyBits}" hashSize="${hashSize}" cipherAlgorithm="AES" ` +
    `cipherChaining="ChainingModeCBC" hashAlgorithm="${hashName}"`;
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    '<encryption xmlns="http://schemas.microsoft.com/office/2006/encryption" ' +
    'xmlns:p="http://schemas.microsoft.com/office/2006/keyEncryptor/password">' +
    `<keyData ${common} saltValue="${b64(dataSalt)}"/>` +
    `<dataIntegrity encryptedHmacKey="${b64(encryptedHmacKey)}" encryptedHmacValue="${b64(encryptedHmacValue)}"/>` +
    '<keyEncryptors><keyEncryptor uri="http://schemas.microsoft.com/office/2006/keyEncryptor/password">' +
    `<p:encryptedKey spinCount="${o.spinCount}" ${common} saltValue="${b64(keySalt)}" ` +
    `encryptedVerifierHashInput="${b64(nodeAes('cbc', true, derive(BK.verifierInput), keySalt, verifierInput))}" ` +
    `encryptedVerifierHashValue="${b64(nodeAes('cbc', true, derive(BK.verifierValue), keySalt, zeroPad(nodeHash(o.hash, verifierInput))))}" ` +
    `encryptedKeyValue="${b64(nodeAes('cbc', true, derive(BK.key), keySalt, zeroPad(packageKey)))}"/>` +
    '</keyEncryptor></keyEncryptors></encryption>';

  return writeCfb({
    EncryptionInfo: Buffer.concat([Buffer.from([4, 0, 4, 0, 0x40, 0, 0, 0]), Buffer.from(xml, 'utf8')]),
    EncryptedPackage: encryptedPackage,
  });
}

/** Standard (Office 2007) encryption written from the spec with node:crypto, for any AES key size. */
function nodeStandardEncrypt(data: Uint8Array, password: string, keyBits: 128 | 192 | 256): Uint8Array {
  const salt = randomBytes(16);
  const hFinal = nodeHash('sha1', nodeSpin('sha1', salt, password, 50000), u32(0));
  const derive = (fill: number): Buffer => {
    const buf = Buffer.alloc(64, fill);
    for (let i = 0; i < hFinal.length; i++) buf[i] ^= hFinal[i];
    return nodeHash('sha1', buf);
  };
  const key = Buffer.concat([derive(0x36), derive(0x5c)]).subarray(0, keyBits / 8);

  const verifier = randomBytes(16);
  const provider = Buffer.from('Microsoft Enhanced RSA and AES Cryptographic Provider\0', 'utf16le');
  const algId = { 128: 0x660e, 192: 0x660f, 256: 0x6610 }[keyBits];
  const header = Buffer.concat([
    u32(0x24), u32(0), u32(algId), u32(0x8004), u32(keyBits), u32(0x18), u32(0), u32(0), provider,
  ]);
  const info = Buffer.concat([
    Buffer.from([3, 0, 2, 0]), u32(0x24), u32(header.length), header,
    u32(16), salt, nodeAes('ecb', true, key, null, verifier),
    u32(20), nodeAes('ecb', true, key, null, zeroPad(nodeHash('sha1', verifier))),
  ]);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(data.length, 0);
  return writeCfb({
    EncryptionInfo: info,
    EncryptedPackage: Buffer.concat([size, nodeAes('ecb', true, key, null, zeroPad(Buffer.from(data)))]),
  });
}

// ── tests ────────────────────────────────────────────────────────────────────

let smallZip: Uint8Array;
let largeZip: Uint8Array;

beforeAll(async () => {
  smallZip = await makeSmallZip();
  largeZip = await makeLargeZip();
});

describe('test payloads', () => {
  it('are real zips with awkward lengths', async () => {
    expect([...smallZip.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(smallZip.length % 16).not.toBe(0);
    expect(smallZip.length).toBeLessThan(4096);
    expect(largeZip.length).toBeGreaterThan(4096);
    expect(largeZip.length % 16).not.toBe(0);
    expect(largeZip.length % 4096).not.toBe(0);
    expect(Object.keys((await JSZip.loadAsync(smallZip)).files)).toContain('word/document.xml');
  });
});

describe('detection', () => {
  it('isCfb checks the compound file signature', () => {
    expect(isCfb(Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).toBe(true);
    expect(isCfb(Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a))).toBe(false);
    expect(isCfb(new Uint8Array(0))).toBe(false);
    expect(isCfb(smallZip)).toBe(false);
  });

  it('isOfficeEncrypted is false for a plain zip, random bytes and unrelated compound files', () => {
    expect(isOfficeEncrypted(smallZip)).toBe(false);
    expect(isOfficeEncrypted(new Uint8Array(randomBytes(2048)))).toBe(false);
    expect(isOfficeEncrypted(new Uint8Array(0))).toBe(false);
    // Signature only, garbage after it.
    const fake = new Uint8Array(randomBytes(2048));
    fake.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(isOfficeEncrypted(fake)).toBe(false);
    // A valid compound file without the encryption streams (e.g. a legacy .doc).
    const plainCfb = writeCfb({ WordDocument: new Uint8Array(randomBytes(5000)) });
    expect(isCfb(plainCfb)).toBe(true);
    expect(isOfficeEncrypted(plainCfb)).toBe(false);
    // Only one of the two streams.
    expect(isOfficeEncrypted(writeCfb({ EncryptionInfo: new Uint8Array(64) }))).toBe(false);
  });

  it('isOfficeEncrypted is true for encrypted packages from either implementation', async () => {
    expect(isOfficeEncrypted(await encryptOffice(smallZip, PASSWORD))).toBe(true);
    expect(isOfficeEncrypted(new Uint8Array(officeCrypto.encrypt(Buffer.from(smallZip), { password: PASSWORD })))).toBe(true);
    expect(
      isOfficeEncrypted(
        new Uint8Array(officeCrypto.encrypt(Buffer.from(smallZip), { password: PASSWORD, type: 'standard' })),
      ),
    ).toBe(true);
  });
});

describe('encryptOffice → officecrypto-tool', () => {
  it.each([
    ['small zip', () => smallZip, PASSWORD],
    ['zip larger than one segment', () => largeZip, PASSWORD],
    ['non-ASCII password', () => largeZip, UNICODE_PASSWORD],
  ])('oracle decrypts our output: %s', async (_label, payload, password) => {
    const encrypted = await encryptOffice(payload(), password);
    expect(encrypted).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(encrypted)).toBe(false);
    expect(isCfb(encrypted)).toBe(true);
    expect(officeCrypto.isEncrypted(Buffer.from(encrypted))).toBe(true);
    const decrypted = await officeCrypto.decrypt(Buffer.from(encrypted), { password });
    expect(sameBytes(decrypted, payload())).toBe(true);
  });

  it('oracle rejects our output with the wrong password', async () => {
    const encrypted = await encryptOffice(smallZip, PASSWORD);
    await expect(officeCrypto.decrypt(Buffer.from(encrypted), { password: 'wrong' })).rejects.toThrow(/password/i);
  });

  it('uses fresh salts and keys on every call', async () => {
    const a = await encryptOffice(smallZip, PASSWORD);
    const b = await encryptOffice(smallZip, PASSWORD);
    expect(sameBytes(a, b)).toBe(false);
    expect(sameBytes(readCfbStream(a, '/EncryptedPackage')!, readCfbStream(b, '/EncryptedPackage')!)).toBe(false);
  });
});

describe('officecrypto-tool → decryptOffice', () => {
  it.each([
    ['small zip', () => smallZip, PASSWORD],
    ['zip larger than one segment', () => largeZip, PASSWORD],
    ['non-ASCII password', () => largeZip, UNICODE_PASSWORD],
  ])('agile (oracle default): %s', async (_label, payload, password) => {
    const encrypted = officeCrypto.encrypt(Buffer.from(payload()), { password });
    const decrypted = await decryptOffice(new Uint8Array(encrypted), password);
    expect(decrypted).toBeInstanceOf(Uint8Array);
    expect(sameBytes(decrypted, payload())).toBe(true);
  });

  it.each([
    ['small zip', () => smallZip, PASSWORD],
    ['zip larger than one segment', () => largeZip, PASSWORD],
    ['non-ASCII password', () => smallZip, UNICODE_PASSWORD],
  ])('standard (Office 2007 style): %s', async (_label, payload, password) => {
    const encrypted = officeCrypto.encrypt(Buffer.from(payload()), { password, type: 'standard' });
    const decrypted = await decryptOffice(new Uint8Array(encrypted), password);
    expect(sameBytes(decrypted, payload())).toBe(true);
  });

  it('accepts a Node Buffer as input too', async () => {
    const encrypted = officeCrypto.encrypt(Buffer.from(smallZip), { password: PASSWORD });
    expect(sameBytes(await decryptOffice(encrypted, PASSWORD), smallZip)).toBe(true);
  });
});

describe('encryptOffice → decryptOffice', () => {
  it('round-trips a zip whose length is not a multiple of 16 or 4096, with a non-ASCII password', async () => {
    const encrypted = await encryptOffice(smallZip, UNICODE_PASSWORD);
    const decrypted = await decryptOffice(encrypted, UNICODE_PASSWORD);
    expect(sameBytes(decrypted, smallZip)).toBe(true);
    expect(Object.keys((await JSZip.loadAsync(decrypted)).files)).toContain('word/document.xml');
  });

  it('round-trips a zip larger than 4096 bytes, with a non-ASCII password', async () => {
    const encrypted = await encryptOffice(largeZip, UNICODE_PASSWORD);
    expect(sameBytes(await decryptOffice(encrypted, UNICODE_PASSWORD), largeZip)).toBe(true);
  });

  it.each([0, 1, 15, 16, 17, 4095, 4096, 4097, 8192, 12289])('round-trips %i bytes', async (length) => {
    const payload = new Uint8Array(randomBytes(length));
    const encrypted = await encryptOffice(payload, PASSWORD);
    const decrypted = await decryptOffice(encrypted, PASSWORD);
    expect(decrypted.length).toBe(length);
    expect(sameBytes(decrypted, payload)).toBe(true);
  });

  it('round-trips an 8 MB package (compound file needs DIFAT sectors)', async () => {
    const payload = new Uint8Array(randomBytes(8 * 1024 * 1024 + 123));
    const encrypted = await encryptOffice(payload, PASSWORD);
    expect(isOfficeEncrypted(encrypted)).toBe(true);
    expect(sameBytes(await decryptOffice(encrypted, PASSWORD), payload)).toBe(true);
    // …and the third-party reader agrees with the container we wrote.
    expect(sameBytes(readCfbStream(encrypted, '/EncryptedPackage')!.subarray(0, 4), Uint8Array.of(123, 0, 128, 0))).toBe(true);
  });

  it('does not modify its input', async () => {
    const copy = smallZip.slice();
    const encrypted = await encryptOffice(smallZip, PASSWORD);
    const encryptedCopy = encrypted.slice();
    await decryptOffice(encrypted, PASSWORD);
    expect(sameBytes(smallZip, copy)).toBe(true);
    expect(sameBytes(encrypted, encryptedCopy)).toBe(true);
  });

  it('rejects an empty or over-long password when encrypting', async () => {
    await expect(encryptOffice(smallZip, '')).rejects.toThrow(/password/i);
    await expect(encryptOffice(smallZip, 'x'.repeat(256))).rejects.toThrow(/255/);
  });

  it('derives the key in well under a second', async () => {
    await encryptOffice(smallZip, PASSWORD); // warm up
    const start = performance.now();
    const encrypted = await encryptOffice(smallZip, PASSWORD);
    const encryptMs = performance.now() - start;
    const mid = performance.now();
    await decryptOffice(encrypted, PASSWORD);
    const decryptMs = performance.now() - mid;
    expect(encryptMs).toBeLessThan(2000);
    expect(decryptMs).toBeLessThan(2000);
  });
});

describe('wrong password', () => {
  async function expectIncorrect(file: Uint8Array, password: string): Promise<void> {
    const error = await decryptOffice(file, password).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PasswordError);
    expect((error as PasswordError).code).toBe('password-incorrect');
  }

  it('our agile output', async () => {
    const encrypted = await encryptOffice(smallZip, PASSWORD);
    await expectIncorrect(encrypted, 'wrong');
    await expectIncorrect(encrypted, '');
    await expectIncorrect(encrypted, PASSWORD + ' ');
    await expectIncorrect(encrypted, PASSWORD.toUpperCase());
  });

  it('oracle agile output', async () => {
    await expectIncorrect(new Uint8Array(officeCrypto.encrypt(Buffer.from(smallZip), { password: PASSWORD })), 'wrong');
  });

  it('oracle standard output', async () => {
    await expectIncorrect(
      new Uint8Array(officeCrypto.encrypt(Buffer.from(smallZip), { password: PASSWORD, type: 'standard' })),
      'wrong',
    );
  });
});

describe('agile dataIntegrity (HMAC), checked with node:crypto', () => {
  it('the checker accepts officecrypto-tool output and notices tampering', () => {
    const encrypted = new Uint8Array(officeCrypto.encrypt(Buffer.from(largeZip), { password: PASSWORD }));
    expect(agileIntegrityHolds(encrypted, PASSWORD)).toBe(true);
  });

  it.each([
    ['small zip', () => smallZip, PASSWORD],
    ['zip larger than one segment', () => largeZip, UNICODE_PASSWORD],
  ])('our output carries a valid HMAC: %s', async (_label, payload, password) => {
    const encrypted = await encryptOffice(payload(), password);
    expect(agileIntegrityHolds(encrypted, password)).toBe(true);

    // Flip one ciphertext bit: the stored HMAC must no longer match.
    const container = CFB.read(Buffer.from(encrypted), { type: 'buffer' });
    const pkg = CFB.find(container, '/EncryptedPackage')!;
    (pkg.content as Uint8Array)[20] ^= 1;
    const tampered = new Uint8Array(CFB.write(container, { type: 'buffer' }) as Buffer);
    expect(agileIntegrityHolds(tampered, password)).toBe(false);
  });
});

describe('container layout written by encryptOffice', () => {
  it('declares Agile AES-256-CBC / SHA-512 / 100000 spins with 16-byte salts', async () => {
    const encrypted = await encryptOffice(smallZip, PASSWORD);
    const info = readCfbStream(encrypted, '/EncryptionInfo')!;
    expect([...info.subarray(0, 8)]).toEqual([4, 0, 4, 0, 0x40, 0, 0, 0]);
    const xml = info.subarray(8).toString('utf8');
    for (const element of ['keyData', 'p:encryptedKey']) {
      expect(attr(xml, element, 'cipherAlgorithm')).toBe('AES');
      expect(attr(xml, element, 'cipherChaining')).toBe('ChainingModeCBC');
      expect(attr(xml, element, 'hashAlgorithm')).toBe('SHA512');
      expect(attr(xml, element, 'keyBits')).toBe('256');
      expect(attr(xml, element, 'hashSize')).toBe('64');
      expect(attr(xml, element, 'blockSize')).toBe('16');
      expect(attr(xml, element, 'saltSize')).toBe('16');
      expect(Buffer.from(attr(xml, element, 'saltValue'), 'base64')).toHaveLength(16);
    }
    expect(attr(xml, 'p:encryptedKey', 'spinCount')).toBe('100000');
    expect(Buffer.from(attr(xml, 'p:encryptedKey', 'encryptedVerifierHashInput'), 'base64')).toHaveLength(16);
    expect(Buffer.from(attr(xml, 'p:encryptedKey', 'encryptedVerifierHashValue'), 'base64')).toHaveLength(64);
    expect(Buffer.from(attr(xml, 'p:encryptedKey', 'encryptedKeyValue'), 'base64')).toHaveLength(32);
    expect(Buffer.from(attr(xml, 'dataIntegrity', 'encryptedHmacKey'), 'base64')).toHaveLength(64);
    expect(Buffer.from(attr(xml, 'dataIntegrity', 'encryptedHmacValue'), 'base64')).toHaveLength(64);
    expect(attr(xml, 'keyData', 'saltValue')).not.toBe(attr(xml, 'p:encryptedKey', 'saltValue'));
  });

  it('prefixes EncryptedPackage with the 64-bit plaintext size and pads to the AES block', async () => {
    const encrypted = await encryptOffice(largeZip, PASSWORD);
    const pkg = readCfbStream(encrypted, '/EncryptedPackage')!;
    expect(pkg.readUInt32LE(0)).toBe(largeZip.length);
    expect(pkg.readUInt32LE(4)).toBe(0);
    expect(pkg.length).toBe(8 + Math.ceil(largeZip.length / 16) * 16);
  });

  it('contains the \\x06DataSpaces streams and nothing else', async () => {
    const encrypted = await encryptOffice(smallZip, PASSWORD);
    const container = CFB.read(Buffer.from(encrypted), { type: 'buffer' });
    const streams = container.FullPaths.filter((_p, i) => container.FileIndex[i].type === 2)
      .map((p) => p.replace(/^Root Entry\//, ''))
      .sort();
    expect(streams).toEqual(
      [
        '\u0006DataSpaces/DataSpaceInfo/StrongEncryptionDataSpace',
        '\u0006DataSpaces/DataSpaceMap',
        '\u0006DataSpaces/TransformInfo/StrongEncryptionTransform/\u0006Primary',
        '\u0006DataSpaces/Version',
        'EncryptedPackage',
        'EncryptionInfo',
      ].sort(),
    );

    const utf16 = (s: string): Buffer => Buffer.from(s, 'utf16le');
    const lp = (s: string): Buffer => {
      const body = utf16(s);
      return Buffer.concat([u32(body.length), body, Buffer.alloc((4 - (body.length % 4)) % 4)]);
    };
    const version = readCfbStream(encrypted, '/\u0006DataSpaces/Version')!;
    expect(version).toHaveLength(76);
    expect(version.equals(Buffer.concat([lp('Microsoft.Container.DataSpaces'), u32(1), u32(1), u32(1)]))).toBe(true);

    const map = readCfbStream(encrypted, '/\u0006DataSpaces/DataSpaceMap')!;
    expect(map).toHaveLength(112);
    expect(
      map.equals(
        Buffer.concat([
          u32(8), u32(1), u32(0x68), u32(1), u32(0), lp('EncryptedPackage'), lp('StrongEncryptionDataSpace'),
        ]),
      ),
    ).toBe(true);

    const definition = readCfbStream(encrypted, '/\u0006DataSpaces/DataSpaceInfo/StrongEncryptionDataSpace')!;
    expect(definition).toHaveLength(64);
    expect(definition.equals(Buffer.concat([u32(8), u32(1), lp('StrongEncryptionTransform')]))).toBe(true);

    const primary = readCfbStream(
      encrypted,
      '/\u0006DataSpaces/TransformInfo/StrongEncryptionTransform/\u0006Primary',
    )!;
    expect(primary).toHaveLength(200);
    expect(
      primary.equals(
        Buffer.concat([
          u32(0x58), u32(1), lp('{FF9A3F03-56EF-4613-BDD5-5A41C1D07246}'),
          lp('Microsoft.Container.EncryptionTransform'), u32(1), u32(1), u32(1),
          u32(0), u32(0), u32(0), u32(4),
        ]),
      ),
    ).toBe(true);
  });
});

describe('decryptOffice parameter coverage (files built with node:crypto)', () => {
  it.each<[string, AgileOptions]>([
    ['AES-128 / SHA-1 (Office 2010 defaults)', { hash: 'sha1', keyBits: 128, spinCount: 100000 }],
    ['AES-256 / SHA-512 (Office 2013+ defaults)', { hash: 'sha512', keyBits: 256, spinCount: 100000 }],
    ['AES-192 / SHA-384', { hash: 'sha384', keyBits: 192, spinCount: 5000 }],
    ['AES-256 / SHA-256', { hash: 'sha256', keyBits: 256, spinCount: 1 }],
    ['AES-128 / SHA-512, spinCount 0', { hash: 'sha512', keyBits: 128, spinCount: 0 }],
  ])('agile %s', async (_label, options) => {
    const encrypted = nodeAgileEncrypt(largeZip, UNICODE_PASSWORD, options);
    expect(sameBytes(await decryptOffice(encrypted, UNICODE_PASSWORD), largeZip)).toBe(true);
    await expect(decryptOffice(encrypted, 'wrong')).rejects.toBeInstanceOf(PasswordError);
  });

  it.each<[128 | 192 | 256]>([[128], [192], [256]])('standard AES-%i', async (keyBits) => {
    const encrypted = nodeStandardEncrypt(largeZip, UNICODE_PASSWORD, keyBits);
    expect(sameBytes(await decryptOffice(encrypted, UNICODE_PASSWORD), largeZip)).toBe(true);
    await expect(decryptOffice(encrypted, 'wrong')).rejects.toBeInstanceOf(PasswordError);
  });
});

describe('unsupported or malformed input', () => {
  async function expectUnsupported(file: Uint8Array, pattern: RegExp): Promise<void> {
    const error = await decryptOffice(file, PASSWORD).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UnsupportedError);
    expect((error as Error).message).toMatch(pattern);
  }

  it('a plain zip', async () => {
    await expectUnsupported(smallZip, /not a password-protected/i);
  });

  it('a compound file without the encryption streams', async () => {
    await expectUnsupported(writeCfb({ WordDocument: new Uint8Array(5000) }), /not a password-protected/i);
  });

  it('Extensible encryption (version 4.3)', async () => {
    const file = writeCfb({
      EncryptionInfo: Buffer.concat([Buffer.from([4, 0, 3, 0]), Buffer.alloc(200)]),
      EncryptedPackage: Buffer.alloc(64),
    });
    expect(isOfficeEncrypted(file)).toBe(true);
    await expectUnsupported(file, /extensible/i);
  });

  it('RC4 CryptoAPI encryption', async () => {
    const provider = Buffer.from('Microsoft Enhanced Cryptographic Provider v1.0\0', 'utf16le');
    const header = Buffer.concat([u32(0x04), u32(0), u32(0x6801), u32(0x8004), u32(128), u32(1), u32(0), u32(0), provider]);
    const file = writeCfb({
      EncryptionInfo: Buffer.concat([
        Buffer.from([3, 0, 2, 0]), u32(0x04), u32(header.length), header,
        u32(16), Buffer.alloc(16), Buffer.alloc(16), u32(20), Buffer.alloc(32),
      ]),
      EncryptedPackage: Buffer.alloc(64),
    });
    await expectUnsupported(file, /RC4/);
  });

  it('an unknown EncryptionInfo version', async () => {
    const file = writeCfb({
      EncryptionInfo: Buffer.concat([Buffer.from([9, 0, 9, 0]), Buffer.alloc(64)]),
      EncryptedPackage: Buffer.alloc(64),
    });
    await expectUnsupported(file, /9\.9/);
  });

  it('agile with a certificate key encryptor only', async () => {
    const xml =
      '<encryption xmlns="http://schemas.microsoft.com/office/2006/encryption" ' +
      'xmlns:c="http://schemas.microsoft.com/office/2006/keyEncryptor/certificate">' +
      '<keyData saltSize="16" blockSize="16" keyBits="256" hashSize="64" cipherAlgorithm="AES" ' +
      'cipherChaining="ChainingModeCBC" hashAlgorithm="SHA512" saltValue="AAAAAAAAAAAAAAAAAAAAAA=="/>' +
      '<keyEncryptors><keyEncryptor uri="http://schemas.microsoft.com/office/2006/keyEncryptor/certificate">' +
      '<c:encryptedKey encryptedKeyValue="AAAA" x509Certificate="AAAA" certVerifier="AAAA"/>' +
      '</keyEncryptor></keyEncryptors></encryption>';
    const file = writeCfb({
      EncryptionInfo: Buffer.concat([Buffer.from([4, 0, 4, 0, 0x40, 0, 0, 0]), Buffer.from(xml)]),
      EncryptedPackage: Buffer.alloc(64),
    });
    await expectUnsupported(file, /certificate/i);
  });

  it('a truncated encrypted file fails cleanly instead of returning garbage', async () => {
    const encrypted = await encryptOffice(largeZip, PASSWORD);
    const error = await decryptOffice(encrypted.subarray(0, encrypted.length - 4096), PASSWORD).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
  });
});
