/**
 * Streaming Excel (.xlsx) reader and writer for large workbooks.
 *
 * The ordinary converter (xlsx.ts, on ExcelJS) builds a full object model of the package: for
 * a workbook with hundreds of megabytes of worksheet XML that needs several gigabytes, and a
 * single worksheet over ~500 MB of XML cannot be loaded at all (it does not fit a JS string).
 * This module reads the package entry by entry as a stream, turning cells straight into the
 * editor's snapshot, and writes it back the same way.
 *
 * Kept, like xlsx.ts: sheets (order, names, hidden state, tab colour), values, formulas with
 * cached results (shared formulas stay shared), fonts, fills, borders, alignment, number
 * formats, merged cells, column widths, row heights, hidden rows / columns, frozen panes,
 * zoom, gridlines and hyperlinks.
 */
import { ZipWriter, readZipDirectory, zipEntryString, zipEntryText, type ZipEntry } from '../zip-stream';
import { cssToArgb, excelColorToHex, parseThemeColors, type ExcelColor } from './colors';
import {
  DEFAULT_COL_WIDTH_PX,
  DEFAULT_ROW_HEIGHT_PX,
  MIN_COLS,
  MIN_ROWS,
  columnName,
  excelWidthToPx,
  newId,
  ptToPx,
  pxToExcelWidth,
  pxToPt,
  resolveStyle,
  richTextOf,
  type ICellData,
  type IStyleData,
  type IWorkbookData,
  type SheetData,
} from './workbook';

/** Worksheets past this much XML, or packages past this size, take the streaming path. */
export const STREAM_SHEET_XML_BYTES = 48 * 1024 * 1024;
export const STREAM_PACKAGE_BYTES = 24 * 1024 * 1024;
/** Workbooks with more cells than this are written by the streaming writer. */
export const STREAM_WRITE_CELLS = 250_000;
/** More cells than the editor can hold in memory at once. */
export const MAX_CELLS = 25_000_000;

const CELL_STRING = 1;
const CELL_NUMBER = 2;
const CELL_BOOLEAN = 3;
const WRAP = 3;
const BORDER_STYLES = ['', 'thin', 'hair', 'dotted', 'dashed', 'dashDot', 'dashDotDot', 'double', 'medium', 'mediumDashed', 'mediumDashDot', 'mediumDashDotDot', 'slantDashDot', 'thick'];
const H_ALIGN: Record<string, number> = { left: 1, center: 2, right: 3, justify: 4, distributed: 6, fill: 1, centerContinuous: 2 };
const H_ALIGN_OUT: Record<number, string> = { 1: 'left', 2: 'center', 3: 'right', 4: 'justify', 5: 'justify', 6: 'distributed' };
const V_ALIGN: Record<string, number> = { top: 1, center: 2, bottom: 3, justify: 2, distributed: 2 };
const V_ALIGN_OUT: Record<number, string> = { 1: 'top', 2: 'center', 3: 'bottom' };

/** Number formats Excel knows by id alone. */
const BUILTIN_FORMATS: Record<number, string> = {
  1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??', 14: 'mm-dd-yy', 15: 'd-mmm-yy', 16: 'd-mmm',
  17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yy h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
};

// ── tiny streaming XML scanner ───────────────────────────────────────────────
interface XmlHandler {
  open(name: string, attrs: string, selfClosing: boolean): void;
  close(name: string): void;
}

/**
 * Splits XML text, fed in arbitrary chunks, into open / close tag events. Text is collected
 * only while `capture` is on (the handler turns it on for the few elements it reads text of).
 */
class XmlScanner {
  capture = false;
  text = '';
  private rest = '';
  constructor(private handler: XmlHandler) {}

  push(chunk: string): void {
    const buf = this.rest ? this.rest + chunk : chunk;
    const h = this.handler;
    let i = 0;
    for (;;) {
      const lt = buf.indexOf('<', i);
      if (lt < 0) {
        if (this.capture) this.text += buf.slice(i);
        i = buf.length;
        break;
      }
      if (this.capture && lt > i) this.text += buf.slice(i, lt);
      const gt = buf.indexOf('>', lt + 1);
      if (gt < 0) {
        i = lt;
        break;
      }
      const c = buf.charCodeAt(lt + 1);
      if (c === 47 /* / */) {
        h.close(localName(buf.slice(lt + 2, gt)));
      } else if (c !== 63 /* ? */ && c !== 33 /* ! */) {
        const selfClosing = buf.charCodeAt(gt - 1) === 47;
        const end = selfClosing ? gt - 1 : gt;
        let sp = lt + 1;
        while (sp < end) {
          const ch = buf.charCodeAt(sp);
          if (ch === 32 || ch === 9 || ch === 10 || ch === 13) break;
          sp++;
        }
        h.open(localName(buf.slice(lt + 1, sp)), sp < end ? buf.slice(sp, end) : '', selfClosing);
      }
      i = gt + 1;
    }
    this.rest = i < buf.length ? buf.slice(i) : '';
  }
}

function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

/** Value of an attribute in a tag's raw attribute text (` r="A1" s="3"`), or null. */
function attr(attrs: string, name: string): string | null {
  let from = 0;
  for (;;) {
    const at = attrs.indexOf(name + '=', from);
    if (at < 0) return null;
    const before = at === 0 ? 32 : attrs.charCodeAt(at - 1);
    // a whole name, not the tail of another one (r vs xr, but r:id is found as "id" too)
    if (before === 32 || before === 9 || before === 10 || before === 13 || before === 58) {
      const quote = attrs[at + name.length + 1];
      const end = attrs.indexOf(quote, at + name.length + 2);
      if ((quote === '"' || quote === "'") && end >= 0) {
        const value = attrs.slice(at + name.length + 2, end);
        return value.indexOf('&') < 0 ? value : decodeEntities(value);
      }
    }
    from = at + name.length;
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e],
  );
}

/** Text content as Excel means it: entities, and its own _xHHHH_ escapes for control characters. */
function xmlText(text: string): string {
  let out = text.indexOf('&') < 0 ? text : decodeEntities(text);
  if (out.indexOf('_x') >= 0) out = out.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  return out;
}

const on = (v: string | null): boolean => v !== null && v !== '0' && v !== 'false';

// ── reading ──────────────────────────────────────────────────────────────────
export interface StreamReadResult {
  workbook: IWorkbookData;
  warnings: string[];
}

export interface ReadProgress {
  /** 0–1 across the whole package. */
  fraction: number;
  /** Cells read so far. */
  cells: number;
}

function colorOf(attrs: string): ExcelColor | null {
  const rgb = attr(attrs, 'rgb');
  const theme = attr(attrs, 'theme');
  const indexed = attr(attrs, 'indexed');
  const tint = attr(attrs, 'tint');
  if (rgb === null && theme === null && indexed === null) return null;
  return {
    ...(rgb !== null ? { argb: rgb } : {}),
    ...(theme !== null ? { theme: Number(theme) } : {}),
    ...(indexed !== null ? { indexed: Number(indexed) } : {}),
    ...(tint !== null ? { tint: Number(tint) } : {}),
  };
}

/** styles.xml → one IStyleData (or null) per cell format index. */
function parseStyles(xml: string, theme: string[]): (IStyleData | null)[] {
  const numFmts = new Map<number, string>();
  const fonts: IStyleData[] = [];
  const fills: IStyleData[] = [];
  const borders: IStyleData[] = [];
  const xfs: { numFmtId: number; fontId: number; fillId: number; borderId: number; align: IStyleData }[] = [];
  let section = '';
  let cur: IStyleData | null = null;
  let side: 't' | 'b' | 'l' | 'r' | null = null;
  let pattern = '';
  let fillColor: string | null = null;
  const SIDES: Record<string, 't' | 'b' | 'l' | 'r'> = { top: 't', bottom: 'b', left: 'l', right: 'r', start: 'l', end: 'r' };

  const scanner = new XmlScanner({
    open(name, a, selfClosing) {
      switch (name) {
        case 'numFmts':
        case 'fonts':
        case 'fills':
        case 'borders':
        case 'cellXfs':
        case 'cellStyleXfs':
        case 'cellStyles':
        case 'dxfs':
          section = name;
          return;
        case 'numFmt':
          if (section === 'numFmts') numFmts.set(Number(attr(a, 'numFmtId')), attr(a, 'formatCode') ?? '');
          return;
        case 'font':
          if (section === 'fonts') {
            cur = {};
            if (selfClosing) fonts.push(cur);
          }
          return;
        case 'fill':
          if (section === 'fills') {
            cur = {};
            pattern = '';
            fillColor = null;
            if (selfClosing) fills.push(cur);
          }
          return;
        case 'border':
          if (section === 'borders') {
            cur = {};
            if (selfClosing) borders.push(cur);
          }
          return;
        case 'xf':
          if (section === 'cellXfs') {
            xfs.push({ numFmtId: Number(attr(a, 'numFmtId') ?? 0), fontId: Number(attr(a, 'fontId') ?? 0), fillId: Number(attr(a, 'fillId') ?? 0), borderId: Number(attr(a, 'borderId') ?? 0), align: {} });
          }
          return;
        case 'alignment': {
          if (section !== 'cellXfs' || !xfs.length) return;
          const st = xfs[xfs.length - 1].align;
          const h = attr(a, 'horizontal');
          const v = attr(a, 'vertical');
          const rot = attr(a, 'textRotation');
          if (h && H_ALIGN[h]) st.ht = H_ALIGN[h] as IStyleData['ht'];
          if (v && V_ALIGN[v]) st.vt = V_ALIGN[v] as IStyleData['vt'];
          if (on(attr(a, 'wrapText'))) st.tb = WRAP as IStyleData['tb'];
          if (rot === '255') st.tr = { a: 0, v: 1 };
          else if (rot && Number(rot)) st.tr = { a: Number(rot) > 90 ? 90 - Number(rot) : Number(rot) };
          return;
        }
      }
      if (!cur) return;
      if (section === 'fonts') {
        const val = attr(a, 'val');
        if (name === 'b' && val !== '0' && val !== 'false') cur.bl = 1;
        else if (name === 'i' && val !== '0' && val !== 'false') cur.it = 1;
        else if (name === 'strike' && val !== '0' && val !== 'false') cur.st = { s: 1 };
        else if (name === 'u' && val !== 'none') cur.ul = { s: 1 };
        else if (name === 'sz' && val) cur.fs = Number(val);
        else if (name === 'name' && val) cur.ff = val;
        else if (name === 'vertAlign') {
          if (val === 'superscript') cur.va = 3;
          else if (val === 'subscript') cur.va = 2;
        } else if (name === 'color') {
          const hex = excelColorToHex(colorOf(a), theme);
          if (hex && hex !== '#000000') cur.cl = { rgb: hex };
        }
      } else if (section === 'fills') {
        if (name === 'patternFill') pattern = attr(a, 'patternType') ?? '';
        else if (name === 'fgColor') fillColor = excelColorToHex(colorOf(a), theme) ?? fillColor;
        else if (name === 'bgColor' && !fillColor) fillColor = excelColorToHex(colorOf(a), theme);
      } else if (section === 'borders') {
        if (name in SIDES) {
          side = SIDES[name];
          const style = attr(a, 'style');
          const idx = style ? BORDER_STYLES.indexOf(style) : -1;
          if (idx > 0) (cur.bd ??= {})[side] = { s: idx, cl: { rgb: '#000000' } };
          else side = null;
        } else if (name === 'color' && side && cur.bd?.[side]) {
          cur.bd[side]!.cl = { rgb: excelColorToHex(colorOf(a), theme) ?? '#000000' };
        }
      }
    },
    close(name) {
      if (name === 'font' && section === 'fonts' && cur) {
        fonts.push(cur);
        cur = null;
      } else if (name === 'fill' && section === 'fills' && cur) {
        if (pattern && pattern !== 'none' && fillColor) cur.bg = { rgb: fillColor };
        fills.push(cur);
        cur = null;
      } else if (name === 'border' && section === 'borders' && cur) {
        borders.push(cur);
        cur = null;
      } else if (name in SIDES) {
        side = null;
      } else if (name === section) {
        section = '';
      }
    },
  });
  scanner.push(xml);

  return xfs.map((xf) => {
    const st: IStyleData = { ...(fonts[xf.fontId] ?? {}), ...(fills[xf.fillId] ?? {}), ...(borders[xf.borderId] ?? {}), ...xf.align };
    const format = numFmts.get(xf.numFmtId) ?? BUILTIN_FORMATS[xf.numFmtId];
    if (format && format !== 'General') st.n = { pattern: format };
    return Object.keys(st).length ? st : null;
  });
}

/** "B12" → [row, col] (0-based); col is -1 when the reference has no letters. */
function parseRef(ref: string): [number, number] {
  let col = 0;
  let i = 0;
  for (; i < ref.length; i++) {
    const ch = ref.charCodeAt(i);
    if (ch >= 65 && ch <= 90) col = col * 26 + ch - 64;
    else if (ch >= 97 && ch <= 122) col = col * 26 + ch - 96;
    else if (ch !== 36) break;
  }
  let row = 0;
  for (; i < ref.length; i++) {
    const ch = ref.charCodeAt(i);
    if (ch >= 48 && ch <= 57) row = row * 10 + ch - 48;
  }
  return [row - 1, col - 1];
}

function relsOf(xml: string): Map<string, { target: string; external: boolean }> {
  const out = new Map<string, { target: string; external: boolean }>();
  new XmlScanner({
    open(name, a) {
      if (name === 'Relationship') out.set(attr(a, 'Id') ?? '', { target: attr(a, 'Target') ?? '', external: attr(a, 'TargetMode') === 'External' });
    },
    close() {},
  }).push(xml);
  return out;
}

/** Resolves a relationship target against the part that owns the .rels file. */
function resolvePart(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/** Whether a package is big enough that it should be read with the streaming reader. */
export async function needsStreamRead(blob: Blob): Promise<boolean> {
  if (blob.size >= STREAM_PACKAGE_BYTES) return true;
  try {
    const entries = await readZipDirectory(blob);
    return entries.some((e) => /^xl\/(worksheets\/[^/]+\.xml|sharedStrings\.xml)$/i.test(e.name) && e.size >= STREAM_SHEET_XML_BYTES);
  } catch {
    return false;
  }
}

/** Reads an .xlsx package (already decrypted) without building it in memory first. */
export async function readXlsxStream(blob: Blob, name = 'Workbook', onProgress?: (p: ReadProgress) => void): Promise<StreamReadResult> {
  let entries: ZipEntry[];
  try {
    entries = await readZipDirectory(blob);
  } catch (err) {
    throw new Error(`This Excel file could not be read (${err instanceof Error ? err.message : 'unknown error'}). It may be damaged or in an older format (.xls).`);
  }
  const byName = new Map(entries.map((e) => [e.name.replace(/^\//, ''), e]));
  const find = (path: string) => byName.get(path) ?? entries.find((e) => e.name.toLowerCase() === path.toLowerCase());
  const text = async (path: string): Promise<string | null> => {
    const e = find(path);
    return e ? zipEntryString(blob, e) : null;
  };

  const workbookPath = (() => {
    const e = find('xl/workbook.xml');
    return e ? e.name : null;
  })();
  if (!workbookPath) throw new Error('This Excel file could not be read (it has no workbook part). It may be damaged or in an older format (.xls).');
  const workbookXml = (await text(workbookPath))!;
  const rels = relsOf((await text('xl/_rels/workbook.xml.rels')) ?? '');
  const warnings = new Set<string>();

  const sheetList: { name: string; state: string; path: string }[] = [];
  new XmlScanner({
    open(tag, a) {
      if (tag === 'sheet') {
        const rel = rels.get(attr(a, 'id') ?? '');
        if (rel) sheetList.push({ name: attr(a, 'name') ?? `Sheet${sheetList.length + 1}`, state: attr(a, 'state') ?? 'visible', path: resolvePart(workbookPath, rel.target) });
      } else if (tag === 'definedName') {
        warnings.add('Named ranges (formulas that use them may show errors)');
      }
    },
    close() {},
  }).push(workbookXml);
  if (!sheetList.length) throw new Error('This workbook has no sheets.');

  const theme = parseThemeColors(await text('xl/theme/theme1.xml'));
  const xfStyles = parseStyles((await text('xl/styles.xml')) ?? '', theme);
  const styles: Record<string, IStyleData> = {};
  const styleIds: (string | null | undefined)[] = [];
  const styleKeys = new Map<string, string>();
  const styleIdOf = (xf: number): string | null => {
    let id = styleIds[xf];
    if (id === undefined) {
      const st = xfStyles[xf];
      if (!st) id = null;
      else {
        const key = JSON.stringify(st);
        id = styleKeys.get(key) ?? null;
        if (!id) {
          id = `s${styleKeys.size + 1}`;
          styleKeys.set(key, id);
          styles[id] = st;
        }
      }
      styleIds[xf] = id;
    }
    return id;
  };

  for (const e of entries) {
    if (/^xl\/media\//i.test(e.name)) warnings.add('Pictures');
    else if (/^xl\/charts\//i.test(e.name)) warnings.add('Charts');
    else if (/^xl\/comments/i.test(e.name)) warnings.add('Comments / notes');
    else if (/^xl\/pivotTables\//i.test(e.name)) warnings.add('Pivot tables');
    else if (/vbaProject\.bin$/i.test(e.name)) warnings.add('Macros (saved as a macro-free .xlsx)');
  }

  const sstEntry = find('xl/sharedStrings.xml');
  const sheetEntries = sheetList.map((s) => find(s.path));
  const totalBytes = Math.max(1, (sstEntry?.size ?? 0) + sheetEntries.reduce((n, e) => n + (e?.size ?? 0), 0));
  let doneBytes = 0;
  let cellCount = 0;
  let lastReport = 0;
  const report = (chunkChars: number) => {
    doneBytes += chunkChars;
    const now = Date.now();
    if (onProgress && now - lastReport > 120) {
      lastReport = now;
      onProgress({ fraction: Math.min(0.999, doneBytes / totalBytes), cells: cellCount });
    }
  };

  // shared strings
  const strings: string[] = [];
  if (sstEntry) {
    let acc = '';
    let inSi = false;
    let phonetic = 0;
    const scanner: XmlScanner = new XmlScanner({
      open(tag, _a, selfClosing) {
        if (tag === 'si') {
          inSi = true;
          acc = '';
          if (selfClosing) strings.push('');
        } else if (tag === 'rPh') {
          if (!selfClosing) phonetic++;
        } else if (tag === 't' && inSi && !phonetic && !selfClosing) {
          scanner.capture = true;
          scanner.text = '';
        }
      },
      close(tag) {
        if (tag === 't' && scanner.capture) {
          acc += scanner.text;
          scanner.capture = false;
        } else if (tag === 'rPh') phonetic = Math.max(0, phonetic - 1);
        else if (tag === 'si') {
          strings.push(xmlText(acc));
          inSi = false;
        }
      },
    });
    for await (const chunk of zipEntryText(blob, sstEntry)) {
      scanner.push(chunk);
      report(chunk.length);
    }
  }

  const sheets: Record<string, SheetData> = {};
  const order: string[] = [];
  let sharedSeq = 0;

  for (let si = 0; si < sheetList.length; si++) {
    const info = sheetList[si];
    const entry = sheetEntries[si];
    if (!entry) continue;
    const id = newId('sheet');
    const cellData: Record<number, Record<number, ICellData>> = {};
    const rowData: Record<number, { h?: number; hd?: 0 | 1; ia?: 0 | 1 }> = {};
    const columnData: Record<number, { w?: number; hd?: 0 | 1 }> = {};
    const merges: { startRow: number; startColumn: number; endRow: number; endColumn: number }[] = [];
    const links: { ref: string; rid: string }[] = [];
    const sharedIds = new Map<string, string>();
    let lastRow = 0;
    let lastCol = 0;
    let defaultColWidth = 64;
    let defaultRowHeight = 20;
    let tabColor: string | null = null;
    let freeze: { xSplit: number; ySplit: number } | null = null;
    let zoom = 1;
    let gridlines = true;
    let firstView = true;

    // parser state
    let rowIndex = -1;
    let row: Record<number, ICellData> | null = null;
    let colIndex = -1;
    let cType = '';
    let cStyle: string | null = null;
    let cValue: string | null = null;
    let cFormula: string | null = null;
    let cShared: string | null = null;
    let inCell = false;
    let inInline = false;
    let capturing: 'v' | 'f' | 't' | null = null;

    const finishCell = () => {
      const out: ICellData = {};
      if (cValue !== null) {
        switch (cType) {
          case 's':
            out.v = strings[Number(cValue)] ?? '';
            out.t = CELL_STRING;
            break;
          case 'str':
          case 'inlineStr':
          case 'e':
            out.v = xmlText(cValue);
            out.t = CELL_STRING;
            break;
          case 'b':
            out.v = cValue === '1' || cValue === 'true' ? 1 : 0;
            out.t = CELL_BOOLEAN;
            break;
          case 'd': {
            const ms = Date.parse(cValue);
            if (Number.isNaN(ms)) {
              out.v = cValue;
              out.t = CELL_STRING;
            } else {
              out.v = Math.round(((ms - Date.UTC(1899, 11, 30)) / 86_400_000) * 1e10) / 1e10;
              out.t = CELL_NUMBER;
            }
            break;
          }
          default: {
            const n = Number(cValue);
            if (cValue !== '' && !Number.isNaN(n)) {
              out.v = n;
              out.t = CELL_NUMBER;
            }
          }
        }
      }
      if (cFormula !== null || cShared !== null) {
        // a formula's cached result has no type of its own in the snapshot (as in xlsx.ts)
        delete out.t;
        if (cFormula) out.f = `=${xmlText(cFormula)}`;
        if (cShared !== null) {
          // shared formulas: the first cell carries the text, the rest only the shared id
          let sid = sharedIds.get(cShared);
          if (!sid) {
            sid = `sf${(sharedSeq++).toString(36)}`;
            sharedIds.set(cShared, sid);
          }
          out.si = sid;
        }
      }
      if (cStyle !== null) out.s = cStyle;
      if (out.v === undefined && !out.f && !out.si && !out.s) return;
      if (!row) row = cellData[rowIndex] = {};
      row[colIndex] = out;
      cellCount++;
      if (cellCount > MAX_CELLS) {
        throw new Error(`This workbook has more than ${(MAX_CELLS / 1e6).toFixed(0)} million filled cells, which is more than File Editor can hold in memory. Split it into smaller workbooks, or export the sheets you need as CSV.`);
      }
      if (rowIndex > lastRow) lastRow = rowIndex;
      if (colIndex > lastCol) lastCol = colIndex;
    };

    const scanner: XmlScanner = new XmlScanner({
      open(tag, a, selfClosing) {
        switch (tag) {
          case 'c': {
            const ref = attr(a, 'r');
            if (ref) colIndex = parseRef(ref)[1];
            else colIndex++;
            cType = attr(a, 't') ?? '';
            const s = attr(a, 's');
            // format 0 is the workbook default: no style of its own (as in xlsx.ts)
            cStyle = s === null || s === '0' ? null : styleIdOf(Number(s));
            cValue = null;
            cFormula = null;
            cShared = null;
            inCell = true;
            if (selfClosing) {
              finishCell();
              inCell = false;
            }
            return;
          }
          case 'v':
            if (inCell && !selfClosing) {
              capturing = 'v';
              scanner.capture = true;
              scanner.text = '';
            }
            return;
          case 'f':
            if (!inCell) return;
            if (attr(a, 't') === 'shared') cShared = attr(a, 'si') ?? '0';
            else if (attr(a, 't') === 'array') warnings.add('Array formulas (kept as ordinary formulas)');
            if (!selfClosing) {
              capturing = 'f';
              scanner.capture = true;
              scanner.text = '';
            }
            return;
          case 'is':
            inInline = inCell;
            return;
          case 't':
            if (inInline && !selfClosing) {
              capturing = 't';
              scanner.capture = true;
              scanner.text = '';
            }
            return;
          case 'row': {
            const r = attr(a, 'r');
            rowIndex = r ? Number(r) - 1 : rowIndex + 1;
            row = null;
            colIndex = -1;
            const entryRow: { h?: number; hd?: 0 | 1; ia?: 0 | 1 } = {};
            const ht = attr(a, 'ht');
            if (ht && on(attr(a, 'customHeight'))) {
              entryRow.h = ptToPx(Number(ht));
              entryRow.ia = 0;
            }
            if (on(attr(a, 'hidden'))) entryRow.hd = 1;
            if (entryRow.h !== undefined || entryRow.hd) rowData[rowIndex] = entryRow;
            return;
          }
          case 'col': {
            const min = Number(attr(a, 'min') ?? 1);
            const max = Math.min(16_384, Number(attr(a, 'max') ?? min));
            const width = attr(a, 'width');
            const hidden = on(attr(a, 'hidden'));
            // "every remaining column" is a default, not thousands of column entries
            if (max - min > 2000) {
              if (width && !hidden) defaultColWidth = excelWidthToPx(Number(width));
              return;
            }
            for (let c = min - 1; c < max; c++) {
              const e: { w?: number; hd?: 0 | 1 } = {};
              if (width) e.w = excelWidthToPx(Number(width));
              if (hidden) e.hd = 1;
              if (e.w !== undefined || e.hd) columnData[c] = e;
            }
            return;
          }
          case 'sheetFormatPr': {
            const h = attr(a, 'defaultRowHeight');
            const w = attr(a, 'defaultColWidth');
            if (h) defaultRowHeight = ptToPx(Number(h));
            if (w) defaultColWidth = excelWidthToPx(Number(w));
            return;
          }
          case 'sheetView': {
            if (!firstView) return;
            if (attr(a, 'showGridLines') === '0' || attr(a, 'showGridLines') === 'false') gridlines = false;
            const z = attr(a, 'zoomScale');
            if (z) zoom = Math.min(4, Math.max(0.1, Number(z) / 100));
            if (selfClosing) firstView = false;
            return;
          }
          case 'pane': {
            if (!firstView) return;
            const state = attr(a, 'state');
            const x = Number(attr(a, 'xSplit') ?? 0);
            const y = Number(attr(a, 'ySplit') ?? 0);
            if ((state === 'frozen' || state === 'frozenSplit') && (x > 0 || y > 0)) freeze = { xSplit: x, ySplit: y };
            return;
          }
          case 'tabColor':
            tabColor = excelColorToHex(colorOf(a), theme);
            return;
          case 'mergeCell': {
            const ref = attr(a, 'ref');
            if (!ref) return;
            const [from, to] = ref.split(':');
            const [r1, c1] = parseRef(from);
            const [r2, c2] = parseRef(to ?? from);
            merges.push({ startRow: r1, startColumn: c1, endRow: r2, endColumn: c2 });
            return;
          }
          case 'hyperlink': {
            const ref = attr(a, 'ref');
            const rid = attr(a, 'id');
            if (ref && rid) links.push({ ref, rid });
            return;
          }
          case 'conditionalFormatting':
            warnings.add('Conditional formatting');
            return;
          case 'dataValidation':
            warnings.add('Data validation (drop-down lists)');
            return;
        }
      },
      close(tag) {
        if (capturing && tag === capturing) {
          if (capturing === 'v') cValue = scanner.text;
          else if (capturing === 'f') cFormula = scanner.text;
          else cValue = (cValue ?? '') + scanner.text;
          scanner.capture = false;
          capturing = null;
        } else if (tag === 'c') {
          if (inCell) finishCell();
          inCell = false;
          inInline = false;
        } else if (tag === 'is') {
          inInline = false;
        } else if (tag === 'sheetView') {
          firstView = false;
        }
      },
    });
    for await (const chunk of zipEntryText(blob, entry)) {
      scanner.push(chunk);
      report(chunk.length);
    }

    // cells covered by a merge belong to its top-left cell
    for (const m of merges) {
      lastRow = Math.max(lastRow, m.endRow);
      lastCol = Math.max(lastCol, m.endColumn);
      if ((m.endRow - m.startRow + 1) * (m.endColumn - m.startColumn + 1) > 50_000) continue;
      for (let r = m.startRow; r <= m.endRow; r++) {
        const cells = cellData[r];
        if (!cells) continue;
        for (let c = m.startColumn; c <= m.endColumn; c++) if (r !== m.startRow || c !== m.startColumn) delete cells[c];
      }
    }

    if (links.length) {
      const relPath = entry.name.replace(/([^/]+)$/, '_rels/$1.rels');
      const sheetRels = relsOf((await text(relPath)) ?? '');
      for (const l of links) {
        const target = sheetRels.get(l.rid);
        if (!target?.external) continue;
        const [r, c] = parseRef(l.ref.split(':')[0]);
        const cell = cellData[r]?.[c];
        if (cell) cell.custom = { ...(cell.custom ?? {}), hyperlink: target.target };
      }
    }

    const fz = freeze as { xSplit: number; ySplit: number } | null;
    sheets[id] = {
      id,
      name: info.name,
      hidden: info.state === 'veryHidden' ? 2 : info.state === 'hidden' ? 1 : 0,
      ...(tabColor ? { tabColor } : {}),
      rowCount: Math.min(1_048_576, Math.max(MIN_ROWS, lastRow + 100)),
      columnCount: Math.min(16_384, Math.max(MIN_COLS, lastCol + 10)),
      defaultColumnWidth: defaultColWidth,
      defaultRowHeight,
      cellData,
      rowData,
      columnData,
      mergeData: merges,
      ...(fz ? { freeze: { xSplit: fz.xSplit, ySplit: fz.ySplit, startColumn: fz.xSplit, startRow: fz.ySplit } } : {}),
      zoomRatio: zoom,
      showGridlines: gridlines ? 1 : 0,
    };
    order.push(id);
  }
  if (!order.length) throw new Error('This workbook has no sheets.');
  onProgress?.({ fraction: 1, cells: cellCount });

  return {
    workbook: {
      id: newId('workbook'),
      name,
      appVersion: '1.0.0',
      locale: 'enUS' as IWorkbookData['locale'],
      styles,
      sheetOrder: order,
      sheets,
    },
    warnings: [...warnings],
  };
}

// ── writing ──────────────────────────────────────────────────────────────────
// eslint-disable-next-line no-control-regex
const NEEDS_ESCAPE = /[&<>"\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

function esc(text: string): string {
  if (!NEEDS_ESCAPE.test(text)) return text;
  // eslint-disable-next-line no-control-regex
  return text.replace(/[&<>"\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return `_x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`;
    }
  });
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** Number of cells that hold something, stopping early once past `limit`. */
export function countCells(data: IWorkbookData, limit = Infinity): number {
  let n = 0;
  for (const id of data.sheetOrder) {
    const cells = data.sheets[id]?.cellData;
    if (!cells) continue;
    for (const r in cells) {
      const row = cells[r];
      if (!row) continue;
      for (const _c in row) n++;
      if (n > limit) return n;
    }
  }
  return n;
}

class StyleTable {
  private fonts = new Map<string, number>([['<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>', 0]]);
  private fills = new Map<string, number>([
    ['<fill><patternFill patternType="none"/></fill>', 0],
    ['<fill><patternFill patternType="gray125"/></fill>', 1],
  ]);
  private borders = new Map<string, number>([['<border><left/><right/><top/><bottom/><diagonal/></border>', 0]]);
  private formats = new Map<string, number>();
  private xfs = new Map<string, number>([['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>', 0]]);
  private byStyle = new Map<string | IStyleData, number>();

  private static intern(map: Map<string, number>, xml: string): number {
    let id = map.get(xml);
    if (id === undefined) {
      id = map.size;
      map.set(xml, id);
    }
    return id;
  }

  /** Cell format index for a style (id or inline object); 0 for none. */
  indexOf(wb: Pick<IWorkbookData, 'styles'>, s: ICellData['s']): number {
    if (!s) return 0;
    let idx = this.byStyle.get(s as string | IStyleData);
    if (idx !== undefined) return idx;
    const st = resolveStyle(wb, s);
    idx = st ? this.add(st) : 0;
    this.byStyle.set(s as string | IStyleData, idx);
    return idx;
  }

  private add(st: IStyleData): number {
    const color = cssToArgb(st.cl?.rgb ?? null);
    const font =
      '<font>' +
      (st.bl ? '<b/>' : '') +
      (st.it ? '<i/>' : '') +
      (st.st?.s ? '<strike/>' : '') +
      (st.ul?.s ? '<u/>' : '') +
      (st.va === 3 ? '<vertAlign val="superscript"/>' : st.va === 2 ? '<vertAlign val="subscript"/>' : '') +
      `<sz val="${Number(st.fs) || 11}"/>` +
      (color ? `<color rgb="${color}"/>` : '') +
      `<name val="${esc(String(st.ff || 'Calibri'))}"/><family val="2"/></font>`;
    const fontId = StyleTable.intern(this.fonts, font);

    const bg = cssToArgb(st.bg?.rgb ?? null);
    const fillId = bg ? StyleTable.intern(this.fills, `<fill><patternFill patternType="solid"><fgColor rgb="${bg}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;

    let borderId = 0;
    if (st.bd) {
      const sideXml = (tag: string, key: 't' | 'b' | 'l' | 'r') => {
        const e = st.bd![key];
        const style = e?.s ? BORDER_STYLES[e.s] : '';
        return style ? `<${tag} style="${style}"><color rgb="${cssToArgb(e!.cl?.rgb ?? null) ?? 'FF000000'}"/></${tag}>` : `<${tag}/>`;
      };
      borderId = StyleTable.intern(this.borders, `<border>${sideXml('left', 'l')}${sideXml('right', 'r')}${sideXml('top', 't')}${sideXml('bottom', 'b')}<diagonal/></border>`);
    }

    let numFmtId = 0;
    const pattern = st.n?.pattern;
    if (pattern && pattern !== 'General') {
      const builtin = Object.entries(BUILTIN_FORMATS).find(([, code]) => code === pattern);
      if (builtin) numFmtId = Number(builtin[0]);
      else {
        let id = this.formats.get(pattern);
        if (id === undefined) {
          id = 164 + this.formats.size;
          this.formats.set(pattern, id);
        }
        numFmtId = id;
      }
    }

    const al =
      (st.ht && H_ALIGN_OUT[st.ht] ? ` horizontal="${H_ALIGN_OUT[st.ht]}"` : '') +
      (st.vt && V_ALIGN_OUT[st.vt] ? ` vertical="${V_ALIGN_OUT[st.vt]}"` : '') +
      (st.tb === WRAP ? ' wrapText="1"' : '') +
      (st.tr?.v ? ' textRotation="255"' : st.tr?.a ? ` textRotation="${st.tr.a < 0 ? 90 - Math.max(-90, st.tr.a) : Math.min(90, st.tr.a)}"` : '');
    const xf =
      `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"` +
      (numFmtId ? ' applyNumberFormat="1"' : '') +
      (fontId ? ' applyFont="1"' : '') +
      (fillId ? ' applyFill="1"' : '') +
      (borderId ? ' applyBorder="1"' : '') +
      (al ? ` applyAlignment="1"><alignment${al}/></xf>` : '/>');
    return StyleTable.intern(this.xfs, xf);
  }

  xml(): string {
    const list = (tag: string, map: Map<string, number>) => `<${tag} count="${map.size}">${[...map.keys()].join('')}</${tag}>`;
    const formats = this.formats.size
      ? `<numFmts count="${this.formats.size}">${[...this.formats].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`).join('')}</numFmts>`
      : '';
    return (
      `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">${formats}${list('fonts', this.fonts)}${list('fills', this.fills)}${list('borders', this.borders)}` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `${list('cellXfs', this.xfs)}<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
    );
  }
}

/** Writes the workbook as an .xlsx package (unencrypted), a block of rows at a time. */
export async function writeXlsxStream(data: IWorkbookData, onProgress?: (fraction: number) => void): Promise<Uint8Array> {
  const zip = new ZipWriter();
  const styleTable = new StyleTable();
  const strings = new Map<string, number>();
  let stringRefs = 0;
  const used = new Set<string>();
  const sheetIds = data.sheetOrder.filter((id) => data.sheets[id]);
  const total = Math.max(1, countCells(data));
  let done = 0;
  const sheetMeta: { name: string; state: string }[] = [];
  const sheetHasRels: boolean[] = [];

  for (let n = 0; n < sheetIds.length; n++) {
    const sheet = data.sheets[sheetIds[n]]!;
    // Excel sheet names: ≤ 31 chars, unique, none of : \ / ? * [ ]
    let name = (sheet.name || 'Sheet').replace(/[:\\/?*[\]]/g, '_').slice(0, 31) || 'Sheet';
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${name.slice(0, 27)} (${i})`;
    used.add(name.toLowerCase());
    sheetMeta.push({ name, state: sheet.hidden === 2 ? 'veryHidden' : sheet.hidden === 1 ? 'hidden' : 'visible' });
    const links: { ref: string; url: string }[] = [];

    const generate = async function* (): AsyncGenerator<string> {
      const defaultCol = sheet.defaultColumnWidth ?? DEFAULT_COL_WIDTH_PX;
      const defaultRow = sheet.defaultRowHeight ?? DEFAULT_ROW_HEIGHT_PX;
      const tab = cssToArgb(sheet.tabColor ?? null);
      const freeze = sheet.freeze && (sheet.freeze.xSplit > 0 || sheet.freeze.ySplit > 0) ? sheet.freeze : null;
      const zoom = Math.round((sheet.zoomRatio ?? 1) * 100);
      let head = `${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`;
      if (tab) head += `<sheetPr><tabColor rgb="${tab}"/></sheetPr>`;
      head += `<sheetViews><sheetView workbookViewId="0"${sheet.showGridlines === 0 ? ' showGridLines="0"' : ''}${zoom !== 100 ? ` zoomScale="${zoom}"` : ''}`;
      if (freeze) {
        const pane = freeze.xSplit > 0 && freeze.ySplit > 0 ? 'bottomRight' : freeze.ySplit > 0 ? 'bottomLeft' : 'topRight';
        head +=
          `><pane${freeze.xSplit > 0 ? ` xSplit="${freeze.xSplit}"` : ''}${freeze.ySplit > 0 ? ` ySplit="${freeze.ySplit}"` : ''}` +
          ` topLeftCell="${columnName(freeze.xSplit)}${freeze.ySplit + 1}" activePane="${pane}" state="frozen"/></sheetView>`;
      } else head += '/>';
      head += `</sheetViews><sheetFormatPr defaultRowHeight="${pxToPt(defaultRow)}" defaultColWidth="${pxToExcelWidth(defaultCol)}" customHeight="1"/>`;
      let cols = '';
      for (const c in sheet.columnData ?? {}) {
        const col = sheet.columnData![c];
        if (!col) continue;
        const custom = col.w && Math.abs(col.w - defaultCol) > 0.5;
        if (!custom && !col.hd) continue;
        cols += `<col min="${Number(c) + 1}" max="${Number(c) + 1}" width="${pxToExcelWidth(col.w ?? defaultCol)}"${custom ? ' customWidth="1"' : ''}${col.hd ? ' hidden="1"' : ''}/>`;
      }
      if (cols) head += `<cols>${cols}</cols>`;
      yield `${head}<sheetData>`;

      const cellData = sheet.cellData ?? {};
      const rowData = sheet.rowData ?? {};
      // integer-like keys enumerate in ascending order
      const rowKeys: number[] = [];
      for (const r in cellData) rowKeys.push(Number(r));
      let extra = false;
      for (const r in rowData) {
        const rd = rowData[r];
        if (rd && (rd.hd || (rd.h && rd.ia !== 1)) && !(r in cellData)) {
          rowKeys.push(Number(r));
          extra = true;
        }
      }
      if (extra) rowKeys.sort((a, b) => a - b);

      let buf = '';
      for (const r of rowKeys) {
        const rd = rowData[r];
        let rowXml = `<row r="${r + 1}"`;
        if (rd?.h && rd.ia !== 1 && Math.abs(rd.h - defaultRow) > 0.5) rowXml += ` ht="${pxToPt(rd.h)}" customHeight="1"`;
        if (rd?.hd) rowXml += ' hidden="1"';
        rowXml += '>';
        const cells = cellData[r];
        if (cells) {
          for (const c in cells) {
            const cell = cells[c];
            if (!cell) continue;
            done++;
            const ref = columnName(Number(c)) + (r + 1);
            const s = styleTable.indexOf(data, cell.s);
            const sAttr = s ? ` s="${s}"` : '';
            const rich = cell.p ? richTextOf(cell) : null;
            const v = rich ?? cell.v;
            const link = (cell.custom as { hyperlink?: unknown } | undefined)?.hyperlink;
            if (typeof link === 'string' && /^(https?:|mailto:)/i.test(link)) links.push({ ref, url: link });
            if (cell.f) {
              const f = esc(cell.f.replace(/^=/, ''));
              if (typeof v === 'number') rowXml += `<c r="${ref}"${sAttr}><f>${f}</f><v>${v}</v></c>`;
              else if (typeof v === 'boolean') rowXml += `<c r="${ref}"${sAttr} t="b"><f>${f}</f><v>${v ? 1 : 0}</v></c>`;
              else if (typeof v === 'string') rowXml += `<c r="${ref}"${sAttr} t="str"><f>${f}</f><v>${esc(v)}</v></c>`;
              else rowXml += `<c r="${ref}"${sAttr}><f>${f}</f></c>`;
            } else if (v !== null && v !== undefined && v !== '') {
              if (cell.t === CELL_BOOLEAN) {
                rowXml += `<c r="${ref}"${sAttr} t="b"><v>${v === true || v === 1 || v === '1' || v === 'TRUE' ? 1 : 0}</v></c>`;
              } else if ((cell.t === CELL_NUMBER || (typeof v === 'number' && cell.t !== CELL_STRING && cell.t !== 4)) && Number.isFinite(Number(v))) {
                rowXml += `<c r="${ref}"${sAttr}><v>${Number(v)}</v></c>`;
              } else {
                const text = String(v);
                let idx = strings.get(text);
                if (idx === undefined) {
                  idx = strings.size;
                  strings.set(text, idx);
                }
                stringRefs++;
                rowXml += `<c r="${ref}"${sAttr} t="s"><v>${idx}</v></c>`;
              }
            } else if (s) {
              rowXml += `<c r="${ref}"${sAttr}/>`;
            }
          }
        }
        buf += rowXml + '</row>';
        if (buf.length > 1 << 20) {
          yield buf;
          buf = '';
          onProgress?.(Math.min(0.98, done / total));
        }
      }
      let tail = `${buf}</sheetData>`;
      const merges = (sheet.mergeData ?? []).filter((m) => m.endRow > m.startRow || m.endColumn > m.startColumn);
      if (merges.length) {
        tail += `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${columnName(m.startColumn)}${m.startRow + 1}:${columnName(m.endColumn)}${m.endRow + 1}"/>`).join('')}</mergeCells>`;
      }
      if (links.length) tail += `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rId${i + 1}"/>`).join('')}</hyperlinks>`;
      yield `${tail}</worksheet>`;
    };

    await zip.add(`xl/worksheets/sheet${n + 1}.xml`, generate());
    sheetHasRels.push(links.length > 0);
    if (links.length) {
      await zip.add(
        `xl/worksheets/_rels/sheet${n + 1}.xml.rels`,
        `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">${links.map((l, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/hyperlink" Target="${esc(l.url)}" TargetMode="External"/>`).join('')}</Relationships>`,
      );
    }
  }
  if (!sheetMeta.length) {
    sheetMeta.push({ name: 'Sheet1', state: 'visible' });
    await zip.add('xl/worksheets/sheet1.xml', `${XML_HEAD}<worksheet xmlns="${NS_MAIN}"><sheetData/></worksheet>`);
  }

  const sharedStrings = function* (): Generator<string> {
    yield `${XML_HEAD}<sst xmlns="${NS_MAIN}" count="${stringRefs}" uniqueCount="${strings.size}">`;
    let buf = '';
    for (const text of strings.keys()) {
      buf += /^\s|\s$|\n/.test(text) ? `<si><t xml:space="preserve">${esc(text)}</t></si>` : `<si><t>${esc(text)}</t></si>`;
      if (buf.length > 1 << 20) {
        yield buf;
        buf = '';
      }
    }
    yield `${buf}</sst>`;
  };
  await zip.add('xl/sharedStrings.xml', sharedStrings());
  await zip.add('xl/styles.xml', styleTable.xml());
  await zip.add(
    'xl/workbook.xml',
    `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><bookViews><workbookView/></bookViews><sheets>` +
      sheetMeta.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.state !== 'visible' ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`).join('') +
      '</sheets><calcPr calcId="0" fullCalcOnLoad="1"/></workbook>',
  );
  await zip.add(
    'xl/_rels/workbook.xml.rels',
    `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
      sheetMeta.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheetMeta.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId${sheetMeta.length + 2}" Type="${NS_REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
  );
  await zip.add('_rels/.rels', `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  await zip.add(
    '[Content_Types].xml',
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheetMeta.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
  );
  onProgress?.(1);
  return zip.finish();
}
