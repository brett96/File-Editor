import JSZip from 'jszip';
import { isCfb, isOfficeEncrypted, decryptOffice, encryptOffice } from './crypto/office-crypto';
import { pdfLockState, protectPdf, unlockPdf } from './crypto/pdf-crypto';
import type { PdfProtection } from './pdf/types';
import { CODE_EXTENSIONS, isCodeFileName, languageLabel } from './code/languages';
import { PasswordError, UnsupportedError, isCodeFormat, type CodeFormat, type DocFormat, type FlowFormat, type RichDocument } from './types';

export interface FormatInfo {
  id: DocFormat;
  label: string;
  /** Preferred extension, without the dot. */
  ext: string;
  extensions: string[];
  mime: string;
  /** Whether the format can carry password protection on save. */
  canProtect: boolean;
  note?: string;
}

export const FORMATS: Record<DocFormat, FormatInfo> = {
  docx: {
    id: 'docx', label: 'Word document', ext: 'docx', extensions: ['docx', 'docm', 'dotx'],
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', canProtect: true,
  },
  pdf: { id: 'pdf', label: 'PDF', ext: 'pdf', extensions: ['pdf'], mime: 'application/pdf', canProtect: true },
  odt: {
    id: 'odt', label: 'OpenDocument text', ext: 'odt', extensions: ['odt'],
    mime: 'application/vnd.oasis.opendocument.text', canProtect: false,
  },
  rtf: { id: 'rtf', label: 'Rich Text Format', ext: 'rtf', extensions: ['rtf'], mime: 'application/rtf', canProtect: false },
  doc: {
    id: 'doc', label: 'Word 97-2003 document', ext: 'doc', extensions: ['doc', 'dot'], mime: 'application/msword', canProtect: false,
    note: 'Saved as Word-compatible rich text inside a .doc file. Opening legacy .doc files imports text, not full formatting.',
  },
  md: { id: 'md', label: 'Markdown', ext: 'md', extensions: ['md', 'markdown', 'mdown'], mime: 'text/markdown', canProtect: false },
  html: { id: 'html', label: 'HTML', ext: 'html', extensions: ['html', 'htm', 'xhtml'], mime: 'text/html', canProtect: false },
  css: { id: 'css', label: 'CSS stylesheet', ext: 'css', extensions: ['css'], mime: 'text/css', canProtect: false },
  js: { id: 'js', label: 'JavaScript', ext: 'js', extensions: ['js', 'mjs'], mime: 'text/javascript', canProtect: false },
  txt: { id: 'txt', label: 'Plain text', ext: 'txt', extensions: ['txt', 'text', 'log'], mime: 'text/plain', canProtect: false },
  // any other programming or configuration language: saved under the file's own extension
  code: { id: 'code', label: 'Source code', ext: 'txt', extensions: CODE_EXTENSIONS, mime: 'text/plain', canProtect: false },
};

export const FORMAT_ORDER: DocFormat[] = ['docx', 'pdf', 'odt', 'rtf', 'doc', 'md', 'html', 'css', 'js', 'txt', 'code'];

export const OPEN_EXTENSIONS: string[] = FORMAT_ORDER.flatMap((f) => FORMATS[f].extensions);

export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export function baseName(name: string): string {
  return name.replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]+$/, '');
}

export function formatFromExtension(name: string): DocFormat | null {
  const ext = extensionOf(name);
  // Dockerfile, Makefile, .env.local: source files known by name rather than extension
  return FORMAT_ORDER.find((f) => FORMATS[f].extensions.includes(ext)) ?? (isCodeFileName(name) ? 'code' : null);
}

function startsWith(bytes: Uint8Array, ascii: string, offset = 0): boolean {
  if (bytes.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  return true;
}

function pdfHeaderOffset(bytes: Uint8Array): number {
  // The spec allows junk before %PDF- within the first 1024 bytes.
  const limit = Math.min(bytes.length - 5, 1024);
  for (let i = 0; i <= limit; i++) if (startsWith(bytes, '%PDF-', i)) return i;
  return -1;
}

async function sniffZip(bytes: Uint8Array): Promise<DocFormat | 'other-office' | null> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return null;
  }
  if (zip.file('word/document.xml')) return 'docx';
  const mimetype = await zip.file('mimetype')?.async('string');
  if (mimetype?.trim() === 'application/vnd.oasis.opendocument.text' || mimetype?.includes('opendocument.text')) return 'odt';
  if (zip.file('xl/workbook.xml') || zip.file('ppt/presentation.xml') || mimetype?.includes('opendocument')) return 'other-office';
  if (zip.file('content.xml') && zip.file('META-INF/manifest.xml')) return 'odt';
  return null;
}

export interface Sniffed {
  format: DocFormat | null;
  /** Office file wrapped in an encrypted container. */
  officeEncrypted: boolean;
  unsupported?: string;
}

/** Identifies a file by its content first and its extension second. */
export async function sniffFormat(name: string, bytes: Uint8Array): Promise<Sniffed> {
  if (pdfHeaderOffset(bytes) >= 0) return { format: 'pdf', officeEncrypted: false };
  if (isCfb(bytes)) {
    if (isOfficeEncrypted(bytes)) return { format: 'docx', officeEncrypted: true };
    return { format: 'doc', officeEncrypted: false };
  }
  if (startsWith(bytes, 'PK')) {
    const z = await sniffZip(bytes);
    if (z === 'other-office') {
      return { format: null, officeEncrypted: false, unsupported: 'Spreadsheets and presentations open in their own editors: this file was not recognised as an Excel (.xlsx) or PowerPoint (.pptx) file.' };
    }
    if (z) return { format: z, officeEncrypted: false };
  }
  if (startsWith(bytes, '{\\rtf')) return { format: 'rtf', officeEncrypted: false };
  const byExt = formatFromExtension(name);
  // a source-code name on a binary file (a .ts video the media sniffer did not recognise)
  if (byExt === 'code' && bytes.subarray(0, 4096).some((b) => b === 0)) {
    return { format: null, officeEncrypted: false, unsupported: 'This file is not text, so it cannot be opened as source code.' };
  }
  if (byExt && byExt !== 'pdf' && byExt !== 'docx' && byExt !== 'odt') return { format: byExt, officeEncrypted: false };
  if (byExt) {
    return { format: null, officeEncrypted: false, unsupported: `This file has a .${extensionOf(name)} extension but its content is not a valid ${FORMATS[byExt].label}.` };
  }
  // unknown extension: accept anything that looks like text
  const head = bytes.subarray(0, 4096);
  const binary = head.some((b) => b === 0);
  if (!binary) {
    const text = new TextDecoder('utf-8').decode(head).trimStart().toLowerCase();
    if (text.startsWith('<!doctype html') || text.startsWith('<html')) return { format: 'html', officeEncrypted: false };
    return { format: 'txt', officeEncrypted: false };
  }
  return { format: null, officeEncrypted: false, unsupported: 'This file type is not supported.' };
}

export type OpenResult =
  | { kind: 'flow'; format: FlowFormat; doc: RichDocument; wasProtected: boolean }
  /** language: what to call it ("TypeScript", "HTML"); highlighting is chosen from the file name */
  | { kind: 'code'; format: CodeFormat; language: string; text: string; wasProtected: boolean }
  | { kind: 'pdf'; bytes: Uint8Array; wasProtected: boolean };

async function importFlow(format: FlowFormat, bytes: Uint8Array): Promise<RichDocument> {
  switch (format) {
    case 'docx':
      return (await import('./formats/docx-import')).importDocx(bytes);
    case 'odt':
      return (await import('./formats/odt')).importOdt(bytes);
    case 'rtf':
      return (await import('./formats/rtf')).importRtf(bytes);
    case 'doc':
      return (await import('./formats/doc-legacy')).importDoc(bytes);
    case 'md':
      return (await import('./formats/markdown')).importMarkdown(bytes);
    case 'html':
      return (await import('./formats/html')).importHtml(bytes);
    case 'txt':
    case 'css':
    case 'js':
    case 'code':
      return (await import('./formats/text')).importText(bytes);
  }
}

/**
 * Opens any supported file. Throws PasswordError('password-required') when a password is
 * needed and none was given, PasswordError('password-incorrect') when it is wrong.
 */
export async function openDocument(name: string, bytes: Uint8Array, password?: string): Promise<OpenResult> {
  const sniffed = await sniffFormat(name, bytes);
  if (!sniffed.format) throw new UnsupportedError(sniffed.unsupported ?? 'This file type is not supported.');

  if (sniffed.format === 'pdf') {
    const offset = pdfHeaderOffset(bytes);
    const pdfBytes = offset > 0 ? bytes.subarray(offset) : bytes;
    const state = await pdfLockState(pdfBytes);
    if (state === 'none') return { kind: 'pdf', bytes: pdfBytes, wasProtected: false };
    if (password === undefined || (state === 'permissions-password' && password === '')) {
      throw new PasswordError(
        'password-required',
        state === 'open-password'
          ? 'This PDF is password protected. Enter the password to open it.'
          : 'This PDF opens freely but its author restricted editing with a permissions password. Enter that password to unlock it.',
      );
    }
    return { kind: 'pdf', bytes: await unlockPdf(pdfBytes, password), wasProtected: true };
  }

  if (sniffed.officeEncrypted) {
    if (password === undefined) {
      throw new PasswordError('password-required', 'This document is password protected. Enter the password to open it.');
    }
    const inner = await decryptOffice(bytes, password);
    const innerFormat = await sniffZip(inner);
    if (innerFormat !== 'docx') {
      throw new UnsupportedError('The password is correct, but this protected file is a spreadsheet or presentation, which is not supported yet.');
    }
    return { kind: 'flow', format: 'docx', doc: await importFlow('docx', inner), wasProtected: true };
  }

  let format = sniffed.format;
  // HTML / CSS / JS open as raw source so scripts and styles are not stripped.
  if (isCodeFormat(format)) {
    const { decodeText } = await import('./dom');
    return { kind: 'code', format, language: languageLabel(format === 'code' ? name : `x.${format}`), text: decodeText(bytes), wasProtected: false };
  }
  let doc: RichDocument;
  try {
    doc = await importFlow(format, bytes);
  } catch (err) {
    if (format === 'doc' && err instanceof Error && err.name === 'MisnamedDocx') {
      format = 'docx';
      doc = await importFlow('docx', bytes);
    } else {
      throw err;
    }
  }
  if (!doc.title) doc.title = baseName(name);
  return { kind: 'flow', format, doc, wasProtected: false };
}

export interface ExportOptions {
  /** Password for DOCX (open password). */
  password?: string;
  /** Protection for PDF output. */
  pdfProtection?: PdfProtection | null;
}

/** Serialises a flow document to any supported format. */
export async function exportFlow(doc: RichDocument, format: DocFormat, options: ExportOptions = {}): Promise<Uint8Array> {
  switch (format) {
    case 'docx': {
      const bytes = await (await import('./formats/docx-export')).exportDocx(doc);
      return options.password ? encryptOffice(bytes, options.password) : bytes;
    }
    case 'pdf': {
      const bytes = await (await import('./formats/pdf-export')).exportPdf(doc);
      return options.pdfProtection ? protectPdf(bytes, options.pdfProtection) : bytes;
    }
    case 'odt':
      return (await import('./formats/odt')).exportOdt(doc);
    case 'rtf':
      return (await import('./formats/rtf')).exportRtf(doc);
    case 'doc':
      return (await import('./formats/doc-legacy')).exportDoc(doc);
    case 'md':
      return (await import('./formats/markdown')).exportMarkdown(doc);
    case 'html':
      return (await import('./formats/html')).exportHtml(doc);
    case 'txt':
    case 'css':
    case 'js':
    case 'code':
      return (await import('./formats/text')).exportText(doc);
  }
}
