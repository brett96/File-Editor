/**
 * Files and pictures added to an agent message: the file on screen, files of the opened folder,
 * files from the computer, and pictures (pasted screenshots, photos). Files go into the message
 * as text; pictures as image parts, for models that can see images.
 */
import { clip, looksBinary } from '../../core/agent/edits';
import type { AgentContentPart } from '../../core/agent/protocol';

export interface Attachment {
  id: string;
  kind: 'file' | 'image';
  name: string;
  /** where it came from, shown on the chip ("src/app.ts", "screenshot") */
  where?: string;
  /** files: their text */
  text?: string;
  /** pictures: what is sent (a PNG or JPEG data URL), and a small preview */
  dataUrl?: string;
  thumb?: string;
}

/** A small preview of an attachment, kept with the message in the session. */
export interface AttachmentChip {
  kind: 'file' | 'image';
  name: string;
  thumb?: string;
}

let seq = 0;
const nextId = () => `att${Date.now().toString(36)}${(seq++).toString(36)}`;

export const IMAGE_FILE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
const WORD_FILE = /\.(docx|docm|dotx|odt|rtf|doc|dot)$/i;
/** Longest side of a picture sent to a model (most read about this much), and its most characters. */
const IMAGE_SIDE = 1568;
const IMAGE_CHARS = 1_400_000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

async function bitmap(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function draw(src: ImageBitmap | HTMLImageElement, side: number): HTMLCanvasElement {
  const w = 'naturalWidth' in src ? src.naturalWidth : src.width;
  const h = 'naturalHeight' in src ? src.naturalHeight : src.height;
  const k = Math.min(1, side / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** A picture, made small enough to send: JPEG, or PNG for screenshots that stay small. */
export async function imageAttachment(blob: Blob, name: string, where?: string): Promise<Attachment> {
  const src = await bitmap(blob);
  let dataUrl = '';
  for (const [side, q] of [[IMAGE_SIDE, 0.9], [1280, 0.85], [1024, 0.8], [768, 0.75]] as const) {
    const c = draw(src, side);
    // screenshots (sharp text) look best as PNG when that is small enough
    const png = blob.type === 'image/png' ? c.toDataURL('image/png') : '';
    dataUrl = png && png.length <= IMAGE_CHARS ? png : c.toDataURL('image/jpeg', q);
    if (dataUrl.length <= IMAGE_CHARS) break;
  }
  if (dataUrl.length > IMAGE_CHARS) throw new Error(`${name} is too large to send.`);
  const thumb = draw(src, 160).toDataURL('image/jpeg', 0.7);
  return { id: nextId(), kind: 'image', name, where, dataUrl, thumb };
}

export function fileAttachment(name: string, text: string, where?: string): Attachment {
  return { id: nextId(), kind: 'file', name, where, text };
}

/** A file picked on the computer, dropped or pasted: a picture, a document or a text file. */
export async function attachmentFromFile(file: File): Promise<Attachment> {
  if (file.type.startsWith('image/') || IMAGE_FILE.test(file.name)) return imageAttachment(file, file.name, 'from this computer');
  if (file.size > MAX_TEXT_BYTES * 4) throw new Error(`${file.name} is too large to add.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (WORD_FILE.test(file.name)) {
    const [{ openDocument }, { documentText }] = await Promise.all([import('../../core/registry'), import('../rich/agent-doc')]);
    const opened = await openDocument(file.name, bytes);
    if (opened.kind !== 'flow') throw new Error(`${file.name} can't be read as a document.`);
    return fileAttachment(file.name, (await documentText(opened.doc.html)).text, 'from this computer');
  }
  if (bytes.length > MAX_TEXT_BYTES) throw new Error(`${file.name} is too large to add (over 2 MB of text).`);
  if (looksBinary(bytes)) throw new Error(`${file.name} isn't a text file, a document or a picture, so it can't be added.`);
  return fileAttachment(file.name, new TextDecoder().decode(bytes), 'from this computer');
}

/** A fence longer than any backtick run in `text`. */
function fence(text: string): string {
  let longest = 2;
  for (const m of text.matchAll(/`{3,}/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(longest + 1);
}

/**
 * The message the model gets: the attached files' text (each cut to `budget` characters), then
 * the user's words; with pictures it becomes text plus image parts.
 */
export function composeMessage(userText: string, attachments: Attachment[], budget: number): string | AgentContentPart[] {
  const files = attachments.filter((a) => a.kind === 'file' && a.text !== undefined);
  const blocks = files.map((a) => {
    const { text, clipped } = clip(a.text!, budget);
    const f = fence(text);
    return `Attached file ${a.where && a.where !== 'from this computer' ? a.where : a.name}${clipped ? ' (the beginning; the rest was cut to fit)' : ''}:\n${f}\n${text}\n${f}`;
  });
  const text = blocks.length ? `${blocks.join('\n\n')}\n\n${userText}` : userText;
  const images = attachments.filter((a) => a.kind === 'image' && a.dataUrl);
  if (!images.length) return text;
  return [{ type: 'text', text }, ...images.map((a): AgentContentPart => ({ type: 'image_url', image_url: { url: a.dataUrl! } }))];
}

export const chipsOf = (attachments: Attachment[]): AttachmentChip[] => attachments.map((a) => ({ kind: a.kind, name: a.where && a.kind === 'file' && a.where !== 'from this computer' ? a.where : a.name, thumb: a.thumb }));
