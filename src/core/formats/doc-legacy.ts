/**
 * Legacy Microsoft Word ".doc" import / export.
 *
 * A ".doc" file in the wild is one of:
 *   • a Word 97-2003 binary document (OLE compound file with a `WordDocument` stream),
 *   • RTF saved with a .doc extension (`{\rtf…`)            → delegated to importRtf,
 *   • HTML / MHTML ("Web page") saved with a .doc extension → sanitised HTML,
 *   • a .docx (ZIP) that was renamed                         → MisnamedDocx error so the caller can re-route.
 *
 * For the binary format we follow [MS-DOC]: FIB → Clx / piece table → main-document text,
 * plus paragraph properties (PAPX FKPs: table cells/rows, heading styles, alignment, lists),
 * character properties (CHPX FKPs: bold, italic, underline, strike, size, colour, font,
 * sub/superscript, highlight, hidden), the font table, list tables, the first section's page
 * setup and the SummaryInformation title. Images, footnotes, headers/footers and text boxes
 * in binary files are not imported.
 *
 * Runs in the browser and in Node: no Buffer, no fs.
 */
import CFB from 'cfb';
import { decodeText, escapeHtml, parseHtml } from '../dom';
import { sanitizeHtml } from '../sanitize';
import { UnsupportedError, type Exporter, type Importer, type PageSetup } from '../types';
import {
  decodeCp1252,
  exportRtf,
  importRtf,
  nearestPageSetup,
  PAGE_BREAK_HTML,
  parseHyperlink,
  renderInlineRuns,
  type InlineFmt,
  type InlineRun,
} from './rtf';

/* ════════════════════════════════════════════════════════════════════════════
 * EXPORT
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * There is no practical way to write the Word 97 binary format (FIB, piece tables, FKPs,
 * stylesheets, OLE container) from JavaScript with acceptable fidelity. Instead we write RTF
 * bytes: Microsoft Word, LibreOffice and WordPad all sniff the content of a .doc file and open
 * RTF content natively, so a ".doc" produced here opens everywhere a real one would.
 */
export const exportDoc: Exporter = async (doc) => exportRtf(doc);

/* ════════════════════════════════════════════════════════════════════════════
 * IMPORT — sniffing
 * ════════════════════════════════════════════════════════════════════════════ */

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWithBytes(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

function misnamedDocx(): Error {
  const err = new Error('This file is actually a .docx (ZIP) file.');
  err.name = 'MisnamedDocx';
  return err;
}

export const importDoc: Importer = async (bytes) => {
  if (startsWithBytes(bytes, CFB_MAGIC)) return importWordBinary(bytes);
  if (startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWithBytes(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    throw misnamedDocx();
  }
  // skip BOM + whitespace for the text sniffs
  let start = 0;
  if (startsWithBytes(bytes, [0xef, 0xbb, 0xbf])) start = 3;
  while (start < bytes.length && start < 64 && (bytes[start] === 0x20 || bytes[start] === 0x09 || bytes[start] === 0x0d || bytes[start] === 0x0a)) start++;
  if (startsWithBytes(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66], start)) return importRtf(bytes.subarray(start));

  const head = decodeText(bytes.subarray(0, 4096)).replace(/^﻿/, '').trimStart();
  const lower = head.toLowerCase();
  if (/^(mime-version:|content-type:\s*multipart\/|from:|subject:|date:|x-[a-z-]+:)/i.test(head) && /content-type:/i.test(head)) {
    return importMhtml(bytes);
  }
  if (
    lower.startsWith('<html') ||
    lower.startsWith('<!doctype') ||
    (lower.startsWith('<?xml') && lower.includes('<html')) ||
    lower.startsWith('<head') ||
    lower.startsWith('<body')
  ) {
    return importHtmlDoc(decodeHtmlBytes(bytes));
  }
  // plain text saved as .doc: accept it if it really looks like text
  const sample = bytes.subarray(0, 4096);
  if (sample.length && !sample.some((b) => b === 0)) {
    const text = decodeAuto(bytes);
    const html = text
      .replace(/\r\n?/g, '\n')
      .split(/\n/)
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join('');
    return { html: html || '<p></p>' };
  }
  throw new Error('This file is not a Word document this app can read.');
};

/* ════════════════════════════════════════════════════════════════════════════
 * IMPORT — HTML / MHTML saved as .doc
 * ════════════════════════════════════════════════════════════════════════════ */

function decodeHtmlBytes(bytes: Uint8Array): string {
  let source = decodeAuto(bytes);
  const charset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(source.slice(0, 4096))?.[1]?.toLowerCase();
  if (charset && charset !== 'utf-8' && charset !== 'utf8' && !(bytes[0] === 0xff || bytes[0] === 0xfe || bytes[0] === 0xef)) {
    try {
      source = decodeLabel(charset, bytes);
    } catch {
      /* unknown label: keep the default decoding */
    }
  }
  return source;
}

function importHtmlDoc(source: string, resources?: Map<string, string>): { html: string; title?: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1];
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(source);
  let inner = bodyMatch ? bodyMatch[1] : source;
  // Word's conditional comments: keep the "downlevel-revealed" content, drop the markers
  inner = inner.replace(/<!\[(?:end)?if[^\]]*\]>/gi, '');
  if (resources && resources.size) {
    // MHTML: point images at their embedded parts (as data: URLs)
    const body = parseHtml(inner);
    for (const img of Array.from(body.querySelectorAll('img'))) {
      const src = img.getAttribute('src') ?? '';
      const hit = resources.get(src) ?? resources.get(src.replace(/^cid:/i, 'cid:')) ?? resources.get(src.replace(/^.*\//, ''));
      if (hit) img.setAttribute('src', hit);
    }
    // VML image fallbacks (<v:imagedata src=…>) are dropped by the sanitiser; recover them as <img>
    inner = body.innerHTML;
  }
  const html = sanitizeHtml(inner);
  let cleanTitle: string | undefined;
  if (title) {
    cleanTitle = (parseHtml(title).textContent ?? '').replace(/\s+/g, ' ').trim() || undefined;
  }
  return { html: html.trim() || '<p></p>', title: cleanTitle };
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

function decodeQuotedPrintable(text: string): Uint8Array {
  const s = text.replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x3d /* = */ && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) {
      out.push(parseInt(s.substr(i + 1, 2), 16));
      i += 2;
    } else {
      out.push(c & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function decodeBase64(text: string): Uint8Array {
  const bin = atob(text.replace(/[^A-Za-z0-9+/=]/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface MimePart {
  headers: Record<string, string>;
  body: string;
}

function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

function splitHeaderBody(s: string): [string, string] {
  const m = /\r?\n\r?\n/.exec(s);
  if (!m) return [s, ''];
  return [s.slice(0, m.index), s.slice(m.index + m[0].length)];
}

function decodePart(part: MimePart): Uint8Array {
  const enc = (part.headers['content-transfer-encoding'] ?? '').toLowerCase();
  if (enc === 'base64') return decodeBase64(part.body);
  if (enc === 'quoted-printable') return decodeQuotedPrintable(part.body);
  const out = new Uint8Array(part.body.length);
  for (let i = 0; i < part.body.length; i++) out[i] = part.body.charCodeAt(i) & 0xff;
  return out;
}

function partCharset(part: MimePart): string | null {
  return /charset\s*=\s*"?([\w-]+)"?/i.exec(part.headers['content-type'] ?? '')?.[1]?.toLowerCase() ?? null;
}

async function importMhtml(bytes: Uint8Array) {
  // MIME is byte-oriented: work on a latin1 view so each char is one byte
  const raw = latin1(bytes);
  const [headBlock, rest] = splitHeaderBody(raw);
  const headers = parseHeaders(headBlock);
  const ctype = headers['content-type'] ?? '';
  const boundary = /boundary\s*=\s*"?([^";\r\n]+)"?/i.exec(ctype)?.[1];
  const parts: MimePart[] = [];
  if (boundary) {
    const chunks = rest.split(`--${boundary}`);
    for (const chunk of chunks.slice(1)) {
      if (chunk.startsWith('--')) break;
      const [h, b] = splitHeaderBody(chunk.replace(/^\r?\n/, ''));
      parts.push({ headers: parseHeaders(h), body: b });
    }
  } else {
    parts.push({ headers, body: rest });
  }
  const htmlPart = parts.find((p) => /text\/html/i.test(p.headers['content-type'] ?? '')) ?? parts[0];
  if (!htmlPart) return { html: '<p></p>' };

  const resources = new Map<string, string>();
  for (const p of parts) {
    const type = (p.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(png|jpe?g|gif|bmp|webp)$/.test(type)) continue;
    const data = decodePart(p);
    let b64 = '';
    for (let i = 0; i < data.length; i += 0x8000) b64 += String.fromCharCode(...data.subarray(i, i + 0x8000));
    const url = `data:${type};base64,${btoa(b64)}`;
    const loc = p.headers['content-location'];
    if (loc) {
      resources.set(loc, url);
      resources.set(loc.replace(/^.*\//, ''), url);
    }
    const cid = p.headers['content-id'];
    if (cid) resources.set(`cid:${cid.replace(/^<|>$/g, '')}`, url);
  }

  const htmlBytes = decodePart(htmlPart);
  let charset = partCharset(htmlPart) ?? 'utf-8';
  let source: string;
  try {
    source = decodeLabel(charset, htmlBytes);
  } catch {
    charset = 'windows-1252';
    source = decodeCp1252(htmlBytes);
  }
  return importHtmlDoc(source, resources);
}

/* ════════════════════════════════════════════════════════════════════════════
 * IMPORT — Word 97-2003 binary
 * ════════════════════════════════════════════════════════════════════════════ */

type Bytes = Uint8Array;

function u8(b: Bytes, o: number): number {
  return o < b.length ? b[o] : 0;
}
function u16(b: Bytes, o: number): number {
  return o + 1 < b.length ? b[o] | (b[o + 1] << 8) : 0;
}
function i16(b: Bytes, o: number): number {
  const v = u16(b, o);
  return v & 0x8000 ? v - 0x10000 : v;
}
function u32(b: Bytes, o: number): number {
  return o + 3 < b.length ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : 0;
}
function i32(b: Bytes, o: number): number {
  return u32(b, o) | 0;
}

function toBytes(content: unknown): Bytes {
  if (content instanceof Uint8Array) return content;
  if (Array.isArray(content)) return Uint8Array.from(content as number[]);
  return new Uint8Array(0);
}

const cp1252 = { decode: decodeCp1252 };

/** TextDecoder, except that the windows-1252 family is decoded by hand (see decodeCp1252). */
function decodeLabel(label: string, bytes: Uint8Array): string {
  if (/^(windows-1252|cp1252|x-cp1252|iso-8859-1|iso8859-1|latin1|l1|us-ascii|ascii)$/i.test(label)) return decodeCp1252(bytes);
  return new TextDecoder(label).decode(bytes);
}

/** UTF-8 / UTF-16 (BOM) aware decoding with a windows-1252 fallback. */
function decodeAuto(bytes: Uint8Array): string {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xef && bytes[1] === 0xbb)) {
    return decodeText(bytes);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return decodeCp1252(bytes);
  }
}

/** Sprm operand length (MS-DOC 2.2.5.1). `o` points at the operand. */
function sprmOperandSize(sprm: number, b: Bytes, o: number): number {
  switch (sprm >> 13) {
    case 0:
    case 1:
      return 1;
    case 2:
    case 4:
    case 5:
      return 2;
    case 3:
      return 4;
    case 7:
      return 3;
    default:
      // variable length
      if (sprm === 0xd608 || sprm === 0xd606) return 2 + Math.max(0, u16(b, o) - 1); // sprmTDefTable(10)
      if (sprm === 0xc615) {
        // sprmPChgTabs
        const cb = u8(b, o);
        if (cb !== 255) return 1 + cb;
        const del = u8(b, o + 1);
        const add = u8(b, o + 2 + del * 4);
        return 1 + 1 + del * 4 + 1 + add * 3;
      }
      return 1 + u8(b, o);
  }
}

interface Sprm {
  op: number;
  /** operand offset */
  at: number;
  size: number;
}

function* sprms(b: Bytes, start: number, end: number): Generator<Sprm> {
  let o = start;
  while (o + 2 <= end) {
    const op = u16(b, o);
    o += 2;
    const size = sprmOperandSize(op, b, o);
    if (o + size > end + 1) return;
    yield { op, at: o, size };
    o += size;
  }
}

interface Piece {
  cpStart: number;
  cpEnd: number;
  fc: number;
  compressed: boolean;
}

interface Chp {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  vert?: '' | 'sub' | 'super';
  color?: string | null;
  highlight?: string | null;
  hps?: number;
  ftc?: number;
  hidden?: boolean;
  deleted?: boolean;
  special?: boolean;
}

interface Pap {
  istd: number;
  inTable: boolean;
  ttp: boolean;
  itap: number;
  jc: number;
  ilfo: number;
  ilvl: number;
  outline: number;
}

interface Run<T> {
  fcStart: number;
  fcEnd: number;
  props: T;
}

const ICO: Array<string | null> = [
  null, '000000', '0000ff', '00ffff', '00ff00', 'ff00ff', 'ff0000', 'ffff00', 'ffffff',
  '000080', '008080', '008000', '800080', '800000', '808000', '808080', 'c0c0c0',
];

function toggle(v: number): boolean {
  // 0 off, 1 on, 0x80 = "same as style" (assume off), 0x81 = "opposite of style" (assume on)
  return v === 1 || v === 0x81;
}

function parseChpx(b: Bytes, start: number, end: number): Chp {
  const c: Chp = {};
  for (const s of sprms(b, start, end)) {
    const v = u8(b, s.at);
    switch (s.op) {
      case 0x0835:
        c.bold = toggle(v);
        break;
      case 0x0836:
        c.italic = toggle(v);
        break;
      case 0x0837:
      case 0x2a53: // sprmCFDStrike
        c.strike = toggle(v);
        break;
      case 0x2a3e:
        c.underline = v !== 0;
        break;
      case 0x4a43:
        c.hps = u16(b, s.at);
        break;
      case 0x2a48:
        c.vert = v === 1 ? 'super' : v === 2 ? 'sub' : '';
        break;
      case 0x2a42:
        c.color = ICO[v] ?? null;
        break;
      case 0x6870: {
        const auto = u8(b, s.at + 3);
        c.color = auto === 0xff ? null : [u8(b, s.at), u8(b, s.at + 1), u8(b, s.at + 2)].map((x) => x.toString(16).padStart(2, '0')).join('');
        break;
      }
      case 0x2a0c:
        c.highlight = ICO[v] ?? null;
        break;
      case 0x4a4f: // sprmCRgFtc0 (ASCII font)
        c.ftc = u16(b, s.at);
        break;
      case 0x083c: // sprmCFVanish
        c.hidden = toggle(v);
        break;
      case 0x0800: // sprmCFRMarkDel
        c.deleted = toggle(v);
        break;
      case 0x0855: // sprmCFSpec
        c.special = toggle(v);
        break;
    }
  }
  return c;
}

function parsePapx(b: Bytes, start: number, end: number): Pap {
  const p: Pap = { istd: u16(b, start), inTable: false, ttp: false, itap: 0, jc: 0, ilfo: 0, ilvl: 0, outline: 9 };
  for (const s of sprms(b, start + 2, end)) {
    const v = u8(b, s.at);
    switch (s.op) {
      case 0x2416:
        p.inTable = v !== 0;
        break;
      case 0x2417:
        p.ttp = v !== 0;
        break;
      case 0x244c: // sprmPFInnerTtp
        if (v) p.ttp = true;
        break;
      case 0x6649: // sprmPItap
        p.itap = u32(b, s.at);
        if (p.itap > 0) p.inTable = true;
        break;
      case 0x2403: // sprmPJc80
      case 0x2461: // sprmPJc
        p.jc = v;
        break;
      case 0x460b: // sprmPIlfo
        p.ilfo = i16(b, s.at);
        break;
      case 0x260a: // sprmPIlvl
        p.ilvl = v;
        break;
      case 0x2640: // sprmPOutLvl
        p.outline = v;
        break;
    }
  }
  return p;
}

/** Reads every run of a PlcBteChpx / PlcBtePapx into a sorted list. */
function readFkpRuns<T>(
  wd: Bytes,
  table: Bytes,
  fcPlc: number,
  lcbPlc: number,
  papx: boolean,
  parse: (b: Bytes, start: number, end: number) => T,
  empty: () => T,
): Array<Run<T>> {
  const runs: Array<Run<T>> = [];
  if (!lcbPlc || fcPlc + lcbPlc > table.length) return runs;
  const n = Math.floor((lcbPlc - 4) / 8);
  for (let i = 0; i < n; i++) {
    const pn = u32(table, fcPlc + (n + 1) * 4 + i * 4) & 0x3fffff;
    const base = pn * 512;
    if (base + 512 > wd.length) continue;
    const fkp = wd.subarray(base, base + 512);
    const crun = fkp[511];
    for (let k = 0; k < crun; k++) {
      const fcStart = u32(fkp, k * 4);
      const fcEnd = u32(fkp, (k + 1) * 4);
      let props: T;
      if (papx) {
        const bOff = fkp[(crun + 1) * 4 + k * 13] * 2;
        if (!bOff) props = empty();
        else {
          let cb = fkp[bOff];
          let start = bOff + 1;
          let len: number;
          if (cb === 0) {
            cb = fkp[bOff + 1];
            start = bOff + 2;
            len = cb * 2;
          } else {
            len = cb * 2 - 1;
          }
          props = parse(fkp, start, Math.min(512, start + len));
        }
      } else {
        const bOff = fkp[(crun + 1) * 4 + k] * 2;
        if (!bOff) props = empty();
        else {
          const cb = fkp[bOff];
          props = parse(fkp, bOff + 1, Math.min(512, bOff + 1 + cb));
        }
      }
      runs.push({ fcStart, fcEnd, props });
    }
  }
  runs.sort((a, b) => a.fcStart - b.fcStart);
  return runs;
}

function findRun<T>(runs: Array<Run<T>>, fc: number): T | null {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = runs[mid];
    if (fc < r.fcStart) hi = mid - 1;
    else if (fc >= r.fcEnd) lo = mid + 1;
    else return r.props;
  }
  return null;
}

/** sti (built-in style id) of each style in the stylesheet, by istd. */
function readStyleSti(table: Bytes, fc: number, lcb: number): number[] {
  const out: number[] = [];
  if (!lcb || fc + lcb > table.length) return out;
  const end = fc + lcb;
  const cbStshi = u16(table, fc);
  const cstd = u16(table, fc + 2);
  let o = fc + 2 + cbStshi;
  for (let i = 0; i < cstd && o + 2 <= end; i++) {
    const cbStd = u16(table, o);
    o += 2;
    out.push(cbStd ? u16(table, o) & 0x0fff : -1);
    o += cbStd;
  }
  return out;
}

function readFontNames(table: Bytes, fc: number, lcb: number): string[] {
  const out: string[] = [];
  if (!lcb || fc + lcb > table.length) return out;
  const end = fc + lcb;
  let o = fc;
  let count = u16(table, o);
  o += 2;
  if (count === 0xffff) {
    count = u16(table, o);
    o += 2;
  }
  o += 2; // cbExtra
  for (let i = 0; i < count && o < end; i++) {
    const cch = u8(table, o);
    const ffn = o + 1;
    let name = '';
    for (let k = ffn + 39; k + 1 < ffn + cch && k + 1 < end; k += 2) {
      const ch = u16(table, k);
      if (!ch) break;
      name += String.fromCharCode(ch);
    }
    out.push(name);
    o = ffn + cch;
  }
  return out;
}

/** ilfo (1-based) → per-level "ordered" flags. */
function readLists(table: Bytes, fib: Bytes): Map<number, boolean[]> {
  const result = new Map<number, boolean[]>();
  const fcLst = u32(fib, 0x2e2);
  const lcbLst = u32(fib, 0x2e6);
  const fcLfo = u32(fib, 0x2ea);
  const lcbLfo = u32(fib, 0x2ee);
  if (!lcbLst || !lcbLfo || fcLst + lcbLst > table.length || fcLfo + lcbLfo > table.length) return result;
  const lists = new Map<number, boolean[]>();
  try {
    const cLst = i16(table, fcLst);
    let o = fcLst + 2;
    const lstfs: Array<{ lsid: number; simple: boolean }> = [];
    for (let i = 0; i < cLst; i++) {
      lstfs.push({ lsid: i32(table, o), simple: (u8(table, o + 26) & 0x01) !== 0 });
      o += 28;
    }
    for (const l of lstfs) {
      const levels: boolean[] = [];
      const count = l.simple ? 1 : 9;
      for (let k = 0; k < count; k++) {
        const nfc = u8(table, o + 4);
        const cbChpx = u8(table, o + 24);
        const cbPapx = u8(table, o + 25);
        levels.push(nfc !== 23 && nfc !== 255);
        o += 28 + cbPapx + cbChpx;
        const cch = u16(table, o);
        o += 2 + cch * 2;
      }
      lists.set(l.lsid, levels);
    }
    const lfoMac = i32(table, fcLfo);
    for (let i = 0; i < lfoMac; i++) {
      const lsid = i32(table, fcLfo + 4 + i * 16);
      const levels = lists.get(lsid);
      if (levels) result.set(i + 1, levels);
    }
  } catch {
    /* malformed list tables: lists become bullets */
  }
  return result;
}

function readPageSetup(wd: Bytes, table: Bytes, fib: Bytes): PageSetup | undefined {
  const fc = u32(fib, 0xca);
  const lcb = u32(fib, 0xce);
  if (lcb < 16 || fc + lcb > table.length) return undefined;
  const n = Math.floor((lcb - 4) / 16);
  if (n < 1) return undefined;
  const fcSepx = i32(table, fc + (n + 1) * 4 + 2);
  let w = 12240;
  let h = 15840;
  let l = 1800;
  let r = 1800;
  let t = 1440;
  let bm = 1440;
  let landscape = false;
  if (fcSepx > 0 && fcSepx + 2 < wd.length) {
    const cb = i16(wd, fcSepx);
    for (const s of sprms(wd, fcSepx + 2, Math.min(wd.length, fcSepx + 2 + cb))) {
      switch (s.op) {
        case 0xb01f:
          w = u16(wd, s.at);
          break;
        case 0xb020:
          h = u16(wd, s.at);
          break;
        case 0xb021:
          l = u16(wd, s.at);
          break;
        case 0xb022:
          r = u16(wd, s.at);
          break;
        case 0x9023:
          t = Math.abs(i16(wd, s.at));
          break;
        case 0x9024:
          bm = Math.abs(i16(wd, s.at));
          break;
        case 0x301d:
          landscape = u8(wd, s.at) === 2;
          break;
      }
    }
  } else return undefined;
  return nearestPageSetup(w / 20, h / 20, { top: t / 20, right: r / 20, bottom: bm / 20, left: l / 20 }, landscape && w >= h);
}

/** Title from the \x05SummaryInformation property set. */
function readTitle(container: CFB.CFB$Container): string | undefined {
  const entry = CFB.find(container, '\u0005SummaryInformation');
  if (!entry) return undefined;
  const b = toBytes(entry.content);
  if (b.length < 48 || u16(b, 0) !== 0xfffe) return undefined;
  const sec = u32(b, 44);
  const count = u32(b, sec + 4);
  let codepage = 1252;
  let titleAt = -1;
  for (let i = 0; i < count && i < 256; i++) {
    const pid = u32(b, sec + 8 + i * 8);
    const off = u32(b, sec + 12 + i * 8);
    if (pid === 1) codepage = u16(b, sec + off + 4);
    else if (pid === 2) titleAt = sec + off;
  }
  if (titleAt < 0) return undefined;
  const type = u32(b, titleAt);
  const len = u32(b, titleAt + 4);
  let text = '';
  if (type === 0x1e) {
    const raw = b.subarray(titleAt + 8, titleAt + 8 + len);
    const label = codepage === 1200 ? 'utf-16le' : codepage === 65001 ? 'utf-8' : codepage === 1252 ? 'windows-1252' : `windows-${codepage}`;
    try {
      text = decodeLabel(label, raw);
    } catch {
      text = cp1252.decode(raw);
    }
  } else if (type === 0x1f) {
    text = new TextDecoder('utf-16le').decode(b.subarray(titleAt + 8, titleAt + 8 + len * 2));
  }
  text = text.replace(/\u0000+$/g, '').trim();
  return text || undefined;
}

interface Para {
  chars: Array<{ ch: string; chp: Chp }>;
  pap: Pap;
  /** the character that ended the paragraph: \r, \x07 (cell / row mark) or '' (end of text) */
  end: string;
}

type DocBlock = { t: 'para'; para: Para } | { t: 'break' } | { t: 'table'; rows: Para[][][] };

async function importWordBinary(bytes: Uint8Array) {
  let container: CFB.CFB$Container;
  try {
    container = CFB.read(bytes, { type: 'array' });
  } catch {
    throw new Error('This .doc file is damaged (invalid compound file).');
  }
  const wdEntry = CFB.find(container, 'WordDocument');
  if (!wdEntry) {
    if (CFB.find(container, 'EncryptionInfo') || CFB.find(container, 'EncryptedPackage')) {
      // an encrypted OOXML package wearing a .doc extension
      throw misnamedDocx();
    }
    throw new Error('This compound file is not a Word document (no WordDocument stream).');
  }
  const wd = toBytes(wdEntry.content);
  if (wd.length < 0x200 || u16(wd, 0) !== 0xa5ec) throw new Error('This .doc file is damaged (bad Word header).');
  const nFib = u16(wd, 2);
  const flags = u16(wd, 0x0a);
  if (flags & 0x0100) {
    throw new UnsupportedError('Password-protected legacy .doc files are not supported yet. Open it in Word and re-save as .docx.');
  }
  if (nFib < 0x00c1 && nFib !== 0) {
    throw new UnsupportedError('Word 6.0/95 documents are not supported. Open it in Word and re-save as .docx.');
  }
  const tableName = flags & 0x0200 ? '1Table' : '0Table';
  const table = toBytes(CFB.find(container, tableName)?.content);
  const fib = wd;

  const ccpText = Math.max(0, i32(fib, 0x4c));
  const fcClx = u32(fib, 0x1a2);
  const lcbClx = u32(fib, 0x1a6);

  /* ── piece table ── */
  const pieces: Piece[] = [];
  if (lcbClx && table.length >= fcClx + lcbClx) {
    let o = fcClx;
    const end = fcClx + lcbClx;
    while (o < end) {
      const clxt = table[o];
      if (clxt === 0x01) {
        o += 3 + Math.max(0, i16(table, o + 1));
      } else if (clxt === 0x02) {
        const lcb = u32(table, o + 1);
        const plc = o + 5;
        const n = Math.floor((lcb - 4) / 12);
        for (let i = 0; i < n; i++) {
          const cpStart = u32(table, plc + i * 4);
          const cpEnd = u32(table, plc + (i + 1) * 4);
          const pcd = plc + (n + 1) * 4 + i * 8;
          const fcRaw = u32(table, pcd + 2);
          const compressed = (fcRaw & 0x40000000) !== 0;
          const fc = fcRaw & 0x3fffffff;
          pieces.push({ cpStart, cpEnd, fc: compressed ? fc / 2 : fc, compressed });
        }
        break;
      } else {
        break;
      }
    }
  }
  if (!pieces.length) {
    // no Clx: one contiguous run of text at fcMin
    const fcMin = u32(fib, 0x18);
    const unicode = (flags & 0x1000) !== 0; // fExtChar
    pieces.push({ cpStart: 0, cpEnd: ccpText, fc: fcMin, compressed: !unicode });
  }

  /* ── formatting tables ── */
  const chpRuns = readFkpRuns<Chp>(wd, table, u32(fib, 0xfa), u32(fib, 0xfe), false, parseChpx, () => ({}));
  const papRuns = readFkpRuns<Pap>(wd, table, u32(fib, 0x102), u32(fib, 0x106), true, parsePapx, () => ({
    istd: 0, inTable: false, ttp: false, itap: 0, jc: 0, ilfo: 0, ilvl: 0, outline: 9,
  }));
  const stis = readStyleSti(table, u32(fib, 0xa2), u32(fib, 0xa6));
  const fonts = readFontNames(table, u32(fib, 0x112), u32(fib, 0x116));
  const lists = readLists(table, fib);
  const hasPap = papRuns.length > 0;

  /* ── text with per-character properties ── */
  interface Ch {
    ch: number;
    fc: number;
  }
  const chars: Ch[] = [];
  for (const p of pieces) {
    if (p.cpStart >= ccpText) continue;
    const end = Math.min(p.cpEnd, ccpText);
    for (let cp = p.cpStart; cp < end; cp++) {
      const k = cp - p.cpStart;
      if (p.compressed) {
        const fc = p.fc + k;
        if (fc >= wd.length) break;
        chars.push({ ch: -1 - wd[fc], fc }); // negative = cp1252 byte, decoded below
      } else {
        const fc = p.fc + k * 2;
        if (fc + 1 >= wd.length) break;
        chars.push({ ch: u16(wd, fc), fc });
      }
    }
  }
  // decode compressed bytes through cp1252 (0x80–0x9F map to typographic characters)
  const byteMap: string[] = [];
  for (let i = 0; i < 256; i++) byteMap[i] = cp1252.decode(Uint8Array.of(i));

  const emptyPap: Pap = { istd: 0, inTable: false, ttp: false, itap: 0, jc: 0, ilfo: 0, ilvl: 0, outline: 9 };
  const blocks: DocBlock[] = [];
  let cur: Para['chars'] = [];
  let afterBreak = false;
  // field state: stack of { phase, code }
  const fields: Array<{ phase: 'code' | 'result'; code: string; link: string | null }> = [];
  const linkOf = () => {
    for (let i = fields.length - 1; i >= 0; i--) if (fields[i].phase === 'result' && fields[i].link) return fields[i].link;
    return null;
  };
  const paras: Array<{ para: Para; links: Array<string | null> }> = [];
  let curLinks: Array<string | null> = [];

  const endPara = (endCh: string, fc: number) => {
    const pap = (hasPap ? findRun(papRuns, fc) : null) ?? emptyPap;
    const para: Para = { chars: cur, pap, end: endCh };
    if (afterBreak && !cur.length && endCh === '\r') {
      afterBreak = false;
      cur = [];
      curLinks = [];
      return;
    }
    afterBreak = false;
    paras.push({ para, links: curLinks });
    blocks.push({ t: 'para', para });
    cur = [];
    curLinks = [];
  };

  const linkByPara = new Map<Para, Array<string | null>>();

  for (const { ch: raw, fc } of chars) {
    const ch = raw < 0 ? byteMap[-1 - raw].charCodeAt(0) : raw;
    // field characters
    if (ch === 0x13) {
      fields.push({ phase: 'code', code: '', link: null });
      continue;
    }
    if (ch === 0x14) {
      const f = fields[fields.length - 1];
      if (f) {
        f.phase = 'result';
        f.link = parseHyperlink(f.code);
      }
      continue;
    }
    if (ch === 0x15) {
      fields.pop();
      continue;
    }
    const inCode = fields.some((f) => f.phase === 'code');
    if (inCode) {
      const f = [...fields].reverse().find((x) => x.phase === 'code')!;
      if (ch >= 0x20 || ch === 0x09) f.code += String.fromCharCode(ch);
      continue;
    }
    if (ch === 0x0d) {
      endPara('\r', fc);
      continue;
    }
    if (ch === 0x07) {
      endPara('\x07', fc);
      continue;
    }
    if (ch === 0x0c) {
      if (cur.length) endPara('\r', fc);
      blocks.push({ t: 'break' });
      afterBreak = true;
      continue;
    }
    const chp = findRun(chpRuns, fc) ?? {};
    if (chp.hidden || chp.deleted) continue;
    let s: string;
    if (ch === 0x0b) s = '\n';
    else if (ch === 0x09) s = '\t';
    else if (ch === 0x1e) s = '‑';
    else if (ch === 0x1f) continue;
    else if (ch < 0x20) continue; // 0x01 pictures, 0x02 footnote refs, 0x05 annotations, 0x08 drawings, …
    else if (chp.special && (ch === 0x28 || ch === 0x29)) continue; // symbol placeholders
    else s = String.fromCharCode(ch);
    cur.push({ ch: s, chp });
    curLinks.push(linkOf());
  }
  if (cur.length) endPara('', chars.length ? chars[chars.length - 1].fc : 0);
  for (const p of paras) linkByPara.set(p.para, p.links);

  /* ── tables ── */
  const grouped: DocBlock[] = [];
  let rows: Para[][][] = [];
  let row: Para[][] = [];
  let cell: Para[] = [];
  let prevWasCellMark = false;
  const flushTable = () => {
    if (cell.length) row.push(cell);
    if (row.length) rows.push(row);
    if (rows.length) grouped.push({ t: 'table', rows });
    rows = [];
    row = [];
    cell = [];
    prevWasCellMark = false;
  };
  for (const b of blocks) {
    if (b.t !== 'para') {
      flushTable();
      grouped.push(b);
      continue;
    }
    const p = b.para;
    const inTable = hasPap ? p.pap.inTable : p.end === '\x07' || cell.length > 0;
    if (!inTable) {
      flushTable();
      grouped.push(b);
      continue;
    }
    if (hasPap) {
      if (p.pap.ttp && p.pap.itap <= 1) {
        // row end mark
        if (cell.length) row.push(cell);
        if (row.length) rows.push(row);
        row = [];
        cell = [];
        continue;
      }
      if (p.pap.itap > 1 && p.pap.ttp) continue; // nested row mark: nested tables are flattened
      cell.push(p);
      if (p.end === '\x07' && p.pap.itap <= 1) {
        row.push(cell);
        cell = [];
      }
    } else {
      // heuristic without paragraph properties: a cell mark right after a cell mark ends the row
      if (p.end === '\x07' && !p.chars.length && prevWasCellMark && !cell.length) {
        if (row.length) rows.push(row);
        row = [];
        prevWasCellMark = false;
        continue;
      }
      cell.push(p);
      if (p.end === '\x07') {
        row.push(cell);
        cell = [];
        prevWasCellMark = true;
      } else prevWasCellMark = false;
    }
  }
  flushTable();

  /* ── render ── */
  // document-default size / font: the most common explicit values (weighted by characters)
  const sizeCount = new Map<number, number>();
  const fontCount = new Map<number, number>();
  let total = 0;
  for (const p of paras) {
    for (const c of p.para.chars) {
      total++;
      if (c.chp.hps) sizeCount.set(c.chp.hps, (sizeCount.get(c.chp.hps) ?? 0) + 1);
      if (c.chp.ftc !== undefined) fontCount.set(c.chp.ftc, (fontCount.get(c.chp.ftc) ?? 0) + 1);
    }
  }
  const dominant = (m: Map<number, number>) => {
    let best: number | null = null;
    let n = 0;
    for (const [k, v] of m) if (v > n) [best, n] = [k, v];
    return best !== null && n * 2 > total ? best : null;
  };
  const defaultHps = dominant(sizeCount);
  const defaultFtc = dominant(fontCount);

  const headingLevel = (pap: Pap): number => {
    const sti = stis[pap.istd] ?? -1;
    if (sti >= 1 && sti <= 9) return Math.min(6, sti);
    if (pap.outline >= 0 && pap.outline <= 5) return pap.outline + 1;
    return 0;
  };

  const paraInline = (para: Para, heading: number): string => {
    const linksOf = linkByPara.get(para) ?? [];
    const runs: InlineRun[] = [];
    para.chars.forEach((c, i) => {
      const link = linksOf[i] ?? null;
      if (c.ch === '\n') {
        runs.push({ html: '<br>', link });
        return;
      }
      const chp = c.chp;
      const fmt: InlineFmt = {
        bold: heading ? false : !!chp.bold,
        italic: !!chp.italic,
        underline: !!chp.underline,
        strike: !!chp.strike,
        vert: chp.vert ?? '',
        color: chp.color ?? null,
        highlight: chp.highlight ?? null,
        font: chp.ftc !== undefined && chp.ftc !== defaultFtc ? fonts[chp.ftc] || null : null,
        size: chp.hps && chp.hps !== defaultHps && !heading ? chp.hps / 2 : null,
      };
      runs.push({ text: c.ch, fmt, link });
    });
    return renderInlineRuns(runs);
  };

  const alignAttr = (pap: Pap) => {
    const a = pap.jc === 1 ? 'center' : pap.jc === 2 ? 'right' : pap.jc === 3 || pap.jc === 4 ? 'justify' : '';
    return a ? ` style="text-align: ${a}"` : '';
  };

  const paraHtml = (para: Para): string => {
    const h = headingLevel(para.pap);
    if (h) return `<h${h}${alignAttr(para.pap)}>${paraInline(para, h)}</h${h}>`;
    return `<p${alignAttr(para.pap)}>${paraInline(para, 0)}</p>`;
  };

  const renderSeq = (seq: DocBlock[], top: boolean): string => {
    let html = '';
    for (let i = 0; i < seq.length; ) {
      const b = seq[i];
      if (b.t === 'break') {
        if (top && html) html += PAGE_BREAK_HTML;
        i++;
        continue;
      }
      if (b.t === 'table') {
        html += '<table><tbody>';
        for (const r of b.rows) {
          html += '<tr>';
          for (const c of r) {
            html += `<td>${c.map((p) => paraHtml(p)).join('') || '<p></p>'}</td>`;
          }
          html += '</tr>';
        }
        html += '</tbody></table>';
        i++;
        continue;
      }
      const p = b.para;
      if (p.pap.ilfo > 0 && !headingLevel(p.pap)) {
        // a run of list paragraphs → nested <ul>/<ol>
        const stack: Array<{ tag: string; level: number }> = [];
        let out = '';
        while (i < seq.length) {
          const n = seq[i];
          if (n.t !== 'para' || n.para.pap.ilfo <= 0 || headingLevel(n.para.pap)) break;
          const levels = lists.get(n.para.pap.ilfo);
          const level = Math.min(8, n.para.pap.ilvl);
          const ordered = levels ? levels[Math.min(level, levels.length - 1)] : false;
          const tag = ordered ? 'ol' : 'ul';
          while (stack.length && stack[stack.length - 1].level > level) out += `</li></${stack.pop()!.tag}>`;
          const topEntry = stack[stack.length - 1];
          if (topEntry && topEntry.level === level) {
            if (topEntry.tag !== tag) {
              out += `</li></${stack.pop()!.tag}><${tag}>`;
              stack.push({ tag, level });
            } else out += '</li>';
          } else {
            out += `<${tag}>`;
            stack.push({ tag, level });
          }
          out += `<li>${paraHtml(n.para)}`;
          i++;
        }
        while (stack.length) out += `</li></${stack.pop()!.tag}>`;
        html += out;
        continue;
      }
      html += paraHtml(p);
      i++;
    }
    return html;
  };

  // trailing empty paragraph Word always writes
  while (grouped.length) {
    const last = grouped[grouped.length - 1];
    if ((last.t === 'para' && !last.para.chars.length) || last.t === 'break') grouped.pop();
    else break;
  }
  const html = renderSeq(grouped, true);

  return {
    html: html || '<p></p>',
    title: readTitle(container),
    pageSetup: readPageSetup(wd, table, fib),
  };
}
