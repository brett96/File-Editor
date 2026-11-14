/**
 * Which kinds of file each kind of open document can be saved as.
 *
 * A file's type decides the editor it opens in, and each editor can write a fixed set of
 * formats: a spreadsheet can become another spreadsheet format, a database or a document
 * table, but never a video; a photo can become another image, a PDF or a picture in a Word
 * document, but never a spreadsheet. The save dialogs only offer what is in this table, and
 * the last check is here too: a file name whose extension is not one the chosen format owns
 * (typed into the system's save window, say "budget.mp4" for a workbook) is refused, so a file
 * is never written with an extension that lies about what is inside it.
 */
import { DB_EXTENSIONS } from './db/sqlite';
import { CONTAINERS, IMAGE_FORMATS, type ContainerFormat } from './media/media-formats';
import { FORMATS, FORMAT_ORDER, extensionOf } from './registry';
import { SHEET_EXTENSIONS, SHEET_FORMATS, SHEET_FORMAT_ORDER } from './sheet/workbook';

/** The kinds of open document (one per editor). */
export type DocKind = 'flow' | 'code' | 'pdf' | 'sheet' | 'database' | 'image' | 'proimage' | 'media' | 'studio' | 'vector' | 'slides';

/** Families of file formats. */
export type FileFamily = 'document' | 'pdf' | 'spreadsheet' | 'database' | 'image' | 'video' | 'audio' | 'project' | 'presentation' | 'archive';

const FAMILY_LABEL: Record<FileFamily, string> = {
  document: 'a document',
  pdf: 'a PDF',
  spreadsheet: 'a spreadsheet',
  database: 'a database',
  image: 'an image',
  video: 'a video',
  audio: 'an audio file',
  project: 'a Studio project',
  presentation: 'a presentation',
  archive: 'a ZIP archive',
};

const KIND_LABEL: Record<DocKind, string> = {
  flow: 'A document',
  code: 'A code file',
  pdf: 'A PDF',
  sheet: 'A spreadsheet',
  database: 'A database',
  image: 'A photo',
  proimage: 'A photo',
  media: 'A video or audio file',
  studio: 'A Studio project',
  vector: 'A drawing',
  slides: 'A presentation',
};

/**
 * What each kind can be written as. Documents and spreadsheets convert into each other (text
 * and tables carry over); photos go into a Word document as a picture on a page.
 */
const TARGETS: Record<DocKind, FileFamily[]> = {
  flow: ['document', 'pdf', 'spreadsheet'],
  code: ['document', 'pdf', 'spreadsheet'],
  pdf: ['pdf', 'document'],
  sheet: ['spreadsheet', 'database', 'document', 'pdf'],
  database: ['database'],
  image: ['image', 'pdf', 'document'],
  proimage: ['image', 'pdf', 'document'],
  // image: an animated GIF, or one frame saved as a picture
  media: ['video', 'audio', 'image'],
  studio: ['video', 'audio', 'project'],
  // a drawing is written as SVG / Illustrator (vector images), a PDF, or a picture of an artboard
  vector: ['image', 'pdf'],
  // archive: every slide as a picture, zipped
  slides: ['presentation', 'pdf', 'archive'],
};

/** The only document format a photo can become: a Word document holding the picture. */
const IMAGE_DOCUMENT_EXTENSIONS = ['docx'];

let familyByExt: Map<string, FileFamily[]> | null = null;

function families(): Map<string, FileFamily[]> {
  if (familyByExt) return familyByExt;
  const map = new Map<string, FileFamily[]>();
  const add = (ext: string, family: FileFamily) => {
    const list = map.get(ext) ?? [];
    if (!list.includes(family)) list.push(family);
    map.set(ext, list);
  };
  for (const f of FORMAT_ORDER) for (const ext of FORMATS[f].extensions) add(ext, f === 'pdf' ? 'pdf' : 'document');
  for (const ext of SHEET_EXTENSIONS) add(ext, 'spreadsheet');
  for (const ext of DB_EXTENSIONS) add(ext, 'database');
  for (const info of Object.values(IMAGE_FORMATS)) for (const ext of info.extensions) add(ext, 'image');
  add('psd', 'image');
  add('ai', 'image');
  for (const id of Object.keys(CONTAINERS) as ContainerFormat[]) {
    // an animated GIF is written by the video editor but is an image file
    if (id === 'gif') continue;
    for (const ext of CONTAINERS[id].extensions) add(ext, CONTAINERS[id].kind);
  }
  add('fstudio', 'project');
  for (const ext of ['pptx', 'ppsx', 'potx', 'pptm']) add(ext, 'presentation');
  add('zip', 'archive');
  familyByExt = map;
  return map;
}

/** The families a file extension (without the dot) belongs to; empty when it is not one File Editor knows. */
export function familiesOfExtension(ext: string): FileFamily[] {
  return families().get(ext.toLowerCase()) ?? [];
}

/** Whether a document of `kind` can be saved with the extension `ext` (no dot). */
export function canSaveAs(kind: DocKind, ext: string): boolean {
  const e = ext.toLowerCase();
  const allowed = TARGETS[kind];
  return familiesOfExtension(e).some((family) => {
    if (!allowed.includes(family)) return false;
    if (family === 'document' && (kind === 'image' || kind === 'proimage')) return IMAGE_DOCUMENT_EXTENSIONS.includes(e);
    return true;
  });
}

/**
 * Every extension the format that `ext` belongs to can be saved under (jpg and jpeg are one
 * format). Word and Excel files keep to their one extension: .docm and .xlsm promise macros.
 */
export function ownedExtensions(ext: string): string[] {
  const e = ext.toLowerCase();
  if (e === 'docx' || e === 'doc' || e === 'xlsx' || e === 'pdf' || e === 'psd' || e === 'ai' || e === 'fstudio') return [e];
  if ((DB_EXTENSIONS as readonly string[]).includes(e)) return [...DB_EXTENSIONS];
  // source code keeps the one extension it has: main.py is never offered as main.rb
  if (FORMATS.code.extensions.includes(e)) return [e];
  for (const f of FORMAT_ORDER) if (FORMATS[f].extensions.includes(e)) return [...FORMATS[f].extensions];
  for (const f of SHEET_FORMAT_ORDER) if (SHEET_FORMATS[f].extensions.includes(e)) return [...SHEET_FORMATS[f].extensions];
  for (const info of Object.values(IMAGE_FORMATS)) if (info.extensions.includes(e)) return [...info.extensions];
  for (const info of Object.values(CONTAINERS)) if (info.extensions.includes(e)) return [...info.extensions];
  return [e];
}

function listFamilies(list: FileFamily[]): string {
  const names = list.map((f) => FAMILY_LABEL[f]);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0];
}

/**
 * Why `fileName` can't be used to save a document of `kind` in the format whose extension is
 * `formatExt`, or null when it can. The name must end in an extension the format owns
 * (`formatExtensions`, e.g. jpg / jpeg), which also has to be one the kind can become.
 */
export function saveNameProblem(kind: DocKind, fileName: string, formatExt: string, formatExtensions: readonly string[] = [formatExt]): string | null {
  const ext = extensionOf(fileName);
  const owned = [formatExt, ...formatExtensions].map((e) => e.toLowerCase());
  if (owned.includes(ext) && canSaveAs(kind, ext)) return null;
  const typed = ext ? `.${ext}` : 'no extension';
  const target = familiesOfExtension(ext);
  if (ext && target.length && !canSaveAs(kind, ext)) {
    return `${KIND_LABEL[kind]} can't be saved as ${FAMILY_LABEL[target[0]]} (${typed}). It can be saved as ${listFamilies(TARGETS[kind])}: pick the format under Save as.`;
  }
  if (!canSaveAs(kind, formatExt)) return `${KIND_LABEL[kind]} can't be saved as a .${formatExt} file.`;
  return `This file is being saved as .${formatExt}, so its name has to end in .${formatExt} (it ends in ${typed}). To save in another format, pick it under Save as.`;
}
