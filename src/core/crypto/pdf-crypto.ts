import { PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { PasswordError } from '../types';
import type { PdfProtection } from '../pdf/types';

export type PdfLockState =
  /** Not encrypted. */
  | 'none'
  /** Needs a password just to open. */
  | 'open-password'
  /** Opens without a password, but the author restricted editing/printing with a permissions password. */
  | 'permissions-password';

function hasEncryptMarker(bytes: Uint8Array): boolean {
  // The /Encrypt key lives in the trailer or in the (uncompressed) cross-reference stream
  // dictionary, so a plain byte scan is a reliable and cheap pre-check.
  const needle = [0x2f, 0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74]; // "/Encrypt"
  outer: for (let i = bytes.length - needle.length; i >= 0; i--) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

export async function pdfLockState(bytes: Uint8Array): Promise<PdfLockState> {
  if (!hasEncryptMarker(bytes)) return 'none';
  const probe = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (!probe.isEncrypted) return 'none';
  try {
    await PDFDocument.load(bytes, { password: '', updateMetadata: false });
    return 'permissions-password';
  } catch {
    return 'open-password';
  }
}

/**
 * Decrypts a protected PDF with the password the user supplied and returns plain PDF bytes.
 * For files that only carry a permissions (owner) password, that password is required —
 * the restrictions the author set are not bypassed.
 */
export async function unlockPdf(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const state = await pdfLockState(bytes);
  if (state === 'none') return bytes;
  if (state === 'permissions-password' && password === '') {
    throw new PasswordError('password-required', 'This PDF is restricted with a permissions password. Enter it to unlock editing.');
  }
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { password, updateMetadata: false });
  } catch (err) {
    throw new PasswordError('password-incorrect');
  }
  stripEncryptionLeftovers(doc);
  return doc.save();
}

/**
 * After a decrypting load, pdf-lib still holds the source file's cross-reference stream
 * object(s) and its encryption dictionary as ordinary objects. Written back out, the stale
 * XRef stream (which names /Encrypt) makes readers treat the plain file as encrypted, so
 * both are removed before saving.
 */
function stripEncryptionLeftovers(doc: PDFDocument): void {
  const XREF = PDFName.of('XRef');
  const STANDARD = PDFName.of('Standard');
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : (obj as { dict?: unknown }).dict instanceof PDFDict ? ((obj as { dict?: unknown }).dict as PDFDict) : null;
    if (!dict) continue;
    const isXref = dict.get(PDFName.of('Type')) === XREF;
    const isEncryptDict =
      dict.get(PDFName.of('Filter')) === STANDARD && dict.has(PDFName.of('O')) && dict.has(PDFName.of('U')) && dict.has(PDFName.of('P'));
    if (isXref || isEncryptDict) doc.context.delete(ref);
  }
}

export async function protectPdf(bytes: Uint8Array, protection: PdfProtection): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const owner = protection.ownerPassword || protection.userPassword;
  if (!owner) throw new Error('A password is required to protect the document.');
  const p = protection.permissions ?? {};
  doc.encrypt({
    userPassword: protection.userPassword,
    ownerPassword: owner,
    permissions: {
      printing: p.printing === false ? false : 'highResolution',
      modifying: p.modifying !== false,
      copying: p.copying !== false,
      annotating: p.annotating !== false,
      fillingForms: p.annotating !== false,
      contentAccessibility: true,
      documentAssembly: p.modifying !== false,
    },
  });
  return doc.save();
}
