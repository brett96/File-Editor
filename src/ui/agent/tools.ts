/**
 * What the coding agent can do: list, read and search the opened folder (or the one open
 * file), and propose edits. Nothing is changed without the user's OK (unless they turned on
 * "Apply changes without asking"); it cannot delete, rename, run anything or go online.
 *
 * Edits to a file that is open in a code tab are made in that tab (one undo step, saved like
 * any other change); edits to other files of the folder are written to the file.
 */
import { applyEdit, clip, lineDiff, looksBinary, sliceLines, type Diff } from '../../core/agent/edits';
import type { AgentToolCall, AgentToolSpec } from '../../core/agent/protocol';
import { dirOf, leafOf, safeSegments } from '../../core/web/paths';
import { IGNORED_DIRS, type OpenedFolder } from '../../platform/folders';
import type { CodeEditorAccess } from './editors';

/** What the agent is working on, as the app shell sees it right now. */
export interface AgentWorkspace {
  folder: OpenedFolder | null;
  /** the code editor of the tab on screen, if it is one */
  active: CodeEditorAccess | null;
  /** the code tab a file of the folder is open in */
  editorFor(path: string): CodeEditorAccess | null;
  /** a file of the folder is open in a tab that is not a code editor (a document, a photo…) */
  openElsewhere(path: string): boolean;
  /** the folder's file list should show a new file */
  folderChanged(dir: string): void;
  /** opens a file of the folder in a tab and resolves to its editor once it is ready (Word files the agent changes) */
  openInTab?(path: string): Promise<CodeEditorAccess | null>;
}

/** Word-style files that aren't plain text: read through the app's importers, changed in a tab. */
const WORD_FILE = /\.(docx|docm|dotx|odt|rtf|doc|dot)$/i;
const isDocument = (t: Target) => t.kind === 'editor' && t.editor.kind === 'document';

export interface EditProposal {
  path: string;
  before: string;
  after: string;
  diff: Diff;
  isNew: boolean;
}

export interface ToolActivity {
  /** short line for the chat, e.g. "Read src/App.tsx (lines 1–200)" */
  label: string;
  error?: boolean;
}

export interface ToolHost {
  ws: () => AgentWorkspace;
  /** asks the user to approve an edit; resolves to true when it is applied */
  confirm(proposal: EditProposal): Promise<boolean>;
  /** characters of one file / result the chosen model can take */
  budget: number;
}

const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_FILES = 4000;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_MATCHES = 150;
const MAX_LIST_ENTRIES = 600;

export const AGENT_TOOLS: AgentToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List the files and folders in the project. Folders end in "/". Dependency and build folders (node_modules, .git, dist…) are listed but not entered.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder to list, relative to the project root. Empty for the root.' },
          depth: { type: 'integer', description: 'How many levels to go down (1–6). Default 2.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file. Code and text come back exactly (unsaved changes in open tabs included). Word-style documents (.docx, .odt, .rtf, and documents open in the document editor) come back as text, one line per paragraph, with a note on how to change them. Long files can be read in parts with start_line / end_line.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
          start_line: { type: 'integer', description: 'First line to read (1-based).' },
          end_line: { type: 'integer', description: 'Last line to read (inclusive).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search the text of the project’s files. Returns matching lines as path:line: text.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to look for (or a regular expression when regex is true).' },
          path: { type: 'string', description: 'Only search below this folder. Empty for the whole project.' },
          regex: { type: 'boolean', description: 'Treat query as a JavaScript regular expression.' },
          case_sensitive: { type: 'boolean' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Change part of a file by replacing old_string with new_string. old_string must match the file exactly (whitespace and indentation included) and occur once, unless replace_all is true. Read the file first. In a Word-style document the formatting around the change is kept, and a newline in new_string starts a new paragraph. The user reviews the change.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string', description: 'Exact text to replace, with enough surrounding lines to be unique.' },
          new_string: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file, or replace the whole content of an existing one. Prefer edit_file for changes to part of a file. For a Word-style document (.docx, .odt, .rtf, or one open in the document editor) write the content in Markdown: it becomes headings, lists, bold, links and tables in the document. The user reviews the change.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root. Missing folders are created.' },
          content: { type: 'string', description: 'The complete new content of the file.' },
        },
        required: ['path', 'content'],
      },
    },
  },
];

// ── paths ──────────────────────────────────────────────────────────────────
type Target = { kind: 'editor'; editor: CodeEditorAccess; path: string } | { kind: 'folder'; folder: OpenedFolder; path: string };

function cleanPath(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function resolveTarget(ws: AgentWorkspace, raw: unknown): Target | { error: string } {
  const path = cleanPath(raw);
  const active = ws.active;
  // the file on screen, when it isn't part of the folder, is named by its file name
  if (active && !active.folderId && (path === active.name || (!ws.folder && path.endsWith(`/${active.name}`)))) return { kind: 'editor', editor: active, path: active.name };
  if (!ws.folder) {
    return { error: active ? `Only the open file "${active.name}" is available. Ask the user to open its folder (Open ▸ Open folder) to work across files.` : 'No file or folder is open.' };
  }
  if (!path || !safeSegments(path)) return { error: `"${String(raw)}" is not a path inside the project. Use a path relative to the project root, like src/index.ts.` };
  const editor = ws.editorFor(path);
  return editor ? { kind: 'editor', editor, path } : { kind: 'folder', folder: ws.folder, path };
}

const decoder = new TextDecoder('utf-8');

/** A file's text, or null when it does not exist; an error for binary or huge files. */
async function readText(t: Target): Promise<{ text: string; bom: boolean; closedDocument?: boolean; outline?: [number, string][] } | null | { error: string }> {
  if (t.kind === 'editor') return { text: t.editor.getText(), bom: false };
  const blob = await t.folder.read(t.path);
  if (!blob) return null;
  if (blob.size > MAX_READ_BYTES) return { error: `${t.path} is too large to read (${Math.round(blob.size / 1024 / 1024)} MB).` };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (WORD_FILE.test(t.path)) {
    // a Word / OpenDocument / RTF file that isn't open: its text, one line per paragraph
    const [{ openDocument }, { documentText }] = await Promise.all([import('../../core/registry'), import('../rich/agent-doc')]);
    try {
      const opened = await openDocument(leafOf(t.path), bytes);
      if (opened.kind !== 'flow') return { error: `${t.path} can't be read as a document.` };
      const { text, outline } = await documentText(opened.doc.html);
      return { text, bom: false, closedDocument: true, outline };
    } catch (err) {
      return { error: `${t.path} couldn't be read: ${err instanceof Error ? err.message : 'unknown error'}` };
    }
  }
  if (looksBinary(bytes)) return { error: `${t.path} is not a text file.` };
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  return { text: decoder.decode(bytes), bom };
}

async function writeText(ws: AgentWorkspace, t: Target, text: string, isNew: boolean, bom: boolean): Promise<void> {
  if (t.kind === 'editor') {
    t.editor.setText(text);
    return;
  }
  const body = new TextEncoder().encode(text);
  const bytes = bom ? new Uint8Array([0xef, 0xbb, 0xbf, ...body]) : body;
  if (isNew) {
    // make the folders above it, then the file
    const dirs: string[] = [];
    for (let d = dirOf(t.path); d; d = dirOf(d)) dirs.unshift(d);
    for (const d of dirs) await t.folder.createDir(d).catch(() => undefined);
    await t.folder.createFile(t.path, bytes);
    ws.folderChanged(dirOf(t.path));
    return;
  }
  if (!t.folder.write) throw new Error('This folder was opened read-only.');
  await t.folder.write(t.path, bytes);
}

// ── running a call ─────────────────────────────────────────────────────────
function parseArgs(call: AgentToolCall): Record<string, unknown> | { __error: string } {
  const raw = call.function.arguments?.trim() || '{}';
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { __error: 'Arguments must be a JSON object.' };
  } catch {
    return { __error: 'The arguments were not valid JSON. Send them again as one JSON object.' };
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const int = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number.isFinite(Number(v)) ? Math.floor(Number(v)) : undefined);

/** Runs one tool call. `result` goes back to the model; `activity` is shown in the chat. */
export async function runTool(call: AgentToolCall, host: ToolHost): Promise<{ result: string; activity: ToolActivity }> {
  const args = parseArgs(call);
  const fail = (label: string, msg: string) => ({ result: `Error: ${msg}`, activity: { label, error: true } });
  if ('__error' in args) return fail(`${call.function.name}: bad arguments`, String(args.__error));
  const ws = host.ws();
  try {
    switch (call.function.name) {
      case 'list_files':
        return await listFiles(ws, cleanPath(args.path), int(args.depth));
      case 'read_file':
        return await readFile(ws, args.path, int(args.start_line), int(args.end_line), host.budget);
      case 'search_files':
        return await searchFiles(ws, str(args.query), cleanPath(args.path), args.regex === true, args.case_sensitive === true);
      case 'edit_file':
        return await editFile(ws, host, args.path, str(args.old_string), str(args.new_string), args.replace_all === true);
      case 'write_file':
        return await writeFile(ws, host, args.path, str(args.content));
      default:
        return fail(`Unknown tool ${call.function.name}`, `There is no tool called ${call.function.name}. Use list_files, read_file, search_files, edit_file or write_file.`);
    }
  } catch (err) {
    return fail(`${call.function.name} failed`, err instanceof Error ? err.message : 'It did not work.');
  }
}

async function listFiles(ws: AgentWorkspace, path: string, depth = 2) {
  if (!ws.folder) {
    const label = 'Listed files';
    return { result: ws.active ? `Only one file is open (no folder): ${ws.active.name}` : 'Nothing is open.', activity: { label } };
  }
  if (path && !safeSegments(path)) return { result: `Error: "${path}" is not a folder in the project.`, activity: { label: `List ${path}`, error: true } };
  const folder = ws.folder;
  const levels = Math.max(1, Math.min(6, depth));
  const out: string[] = [];
  let truncated = false;
  const walk = async (dir: string, level: number, indent: string) => {
    const entries = await folder.list(dir);
    for (const e of entries) {
      if (out.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }
      if (e.kind === 'dir') {
        const skip = e.ignored;
        out.push(`${indent}${e.name}/${skip ? ' (not listed)' : ''}`);
        if (!skip && level < levels) await walk(e.path, level + 1, `${indent}  `);
      } else out.push(`${indent}${e.name}`);
    }
  };
  await walk(path, 1, '');
  const where = path || folder.name;
  const text = out.length ? out.join('\n') : '(empty)';
  return { result: `${where}/\n${text}${truncated ? `\n[… more entries not shown; list a subfolder]` : ''}`, activity: { label: `Listed ${path || 'the project'}` } };
}

/** How a document reads and changes, for the model (added to read_file's answer). */
function documentNote(t: Target, closedOutline?: [number, string][]): string {
  const ed = t.kind === 'editor' ? t.editor : null;
  const outline = ed?.outline?.() ?? closedOutline ?? [];
  const styles = outline.length ? ` Paragraph styles: ${outline.slice(0, 60).map(([l, s]) => `line ${l + 1} ${s}`).join(', ')}${outline.length > 60 ? ', …' : ''}.` : '';
  return (
    `This is a ${ed?.format ?? 'Word-style document'}${ed ? '' : ' (not open; changing it opens it in a tab)'}: one line per paragraph.${styles} ` +
    'edit_file replaces text and keeps the formatting around it; a newline in new_string starts a new paragraph. ' +
    'write_file replaces the whole document: write it in Markdown (# headings, - lists, **bold**, tables).'
  );
}

async function readFile(ws: AgentWorkspace, rawPath: unknown, start: number | undefined, end: number | undefined, budget: number) {
  const t = resolveTarget(ws, rawPath);
  const label = `Read ${cleanPath(rawPath) || 'file'}`;
  if ('error' in t) return { result: `Error: ${t.error}`, activity: { label, error: true } };
  const got = await readText(t);
  if (!got) return { result: `Error: ${t.path} does not exist.`, activity: { label, error: true } };
  if ('error' in got) return { result: `Error: ${got.error}`, activity: { label, error: true } };
  const part = sliceLines(got.text, start, end);
  const { text, clipped } = clip(part.text, budget);
  const shownTo = clipped ? part.from + text.split('\n').length - 1 : part.to;
  const range = part.from === 1 && shownTo === part.total ? '' : ` (lines ${part.from}–${shownTo})`;
  let head = `${t.path}: ${part.total} lines${range ? `, showing lines ${part.from}–${shownTo}` : ''}${t.kind === 'editor' ? ' (open in the editor, unsaved changes included)' : ''}`;
  if (isDocument(t) || ('closedDocument' in got && got.closedDocument)) head += `\n${documentNote(t, 'outline' in got ? got.outline : undefined)}`;
  const more = clipped ? `\n[… cut here to fit; read on with start_line=${shownTo + 1}]` : '';
  return { result: `${head}\n\n${text}${more}`, activity: { label: `Read ${t.path}${range}` } };
}

function matcher(query: string, regex: boolean, caseSensitive: boolean): ((line: string) => boolean) | { error: string } {
  if (!query) return { error: 'query is empty.' };
  if (regex) {
    try {
      const re = new RegExp(query, caseSensitive ? '' : 'i');
      return (line) => re.test(line);
    } catch (err) {
      return { error: `Not a valid regular expression: ${err instanceof Error ? err.message : query}` };
    }
  }
  const q = caseSensitive ? query : query.toLowerCase();
  return (line) => (caseSensitive ? line : line.toLowerCase()).includes(q);
}

async function searchFiles(ws: AgentWorkspace, query: string, under: string, regex: boolean, caseSensitive: boolean) {
  const label = `Searched for “${query.length > 40 ? `${query.slice(0, 37)}…` : query}”`;
  const test = matcher(query, regex, caseSensitive);
  if (typeof test !== 'function') return { result: `Error: ${test.error}`, activity: { label, error: true } };
  const hits: string[] = [];
  const scan = (path: string, text: string) => {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && hits.length < MAX_MATCHES; i++) {
      if (test(lines[i])) {
        const line = lines[i].trim();
        hits.push(`${path}:${i + 1}: ${line.length > 200 ? `${line.slice(0, 200)}…` : line}`);
      }
    }
  };
  if (!ws.folder) {
    if (!ws.active) return { result: 'Error: nothing is open.', activity: { label, error: true } };
    scan(ws.active.name, ws.active.getText());
  } else {
    if (under && !safeSegments(under)) return { result: `Error: "${under}" is not a folder in the project.`, activity: { label, error: true } };
    const folder = ws.folder;
    const queue = [under];
    let files = 0;
    while (queue.length && hits.length < MAX_MATCHES && files < MAX_SEARCH_FILES) {
      const dir = queue.shift()!;
      const entries = await folder.list(dir).catch(() => []);
      for (const e of entries) {
        if (hits.length >= MAX_MATCHES || files >= MAX_SEARCH_FILES) break;
        if (e.kind === 'dir') {
          if (!e.ignored && !IGNORED_DIRS.includes(e.name)) queue.push(e.path);
          continue;
        }
        files++;
        const open = ws.editorFor(e.path);
        if (open) {
          scan(e.path, open.getText());
          continue;
        }
        const blob = await folder.read(e.path);
        if (!blob || blob.size > MAX_SEARCH_FILE_BYTES) continue;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (!looksBinary(bytes)) scan(e.path, decoder.decode(bytes));
      }
    }
  }
  const more = hits.length >= MAX_MATCHES ? `\n[… stopped at ${MAX_MATCHES} matches; search more narrowly]` : '';
  return {
    result: hits.length ? hits.join('\n') + more : 'No matches.',
    activity: { label: `${label}: ${hits.length >= MAX_MATCHES ? `${MAX_MATCHES}+` : hits.length} match${hits.length === 1 ? '' : 'es'}` },
  };
}

async function propose(ws: AgentWorkspace, host: ToolHost, t: Target, before: string | null, after: string, apply: (isNew: boolean) => Promise<void>) {
  const isNew = before === null;
  if (t.kind === 'folder' && ws.openElsewhere(t.path)) {
    return { result: `Error: ${t.path} is open in a tab the agent can't edit (a PDF, picture, spreadsheet…). Ask the user to close that tab first.`, activity: { label: `Couldn't change ${t.path}`, error: true } };
  }
  if (t.kind === 'folder' && !t.folder.canWrite) {
    return { result: 'Error: this folder was opened read-only, so files cannot be changed.', activity: { label: `Couldn't change ${t.path}`, error: true } };
  }
  const diff = lineDiff(before ?? '', after);
  const ok = await host.confirm({ path: t.path, before: before ?? '', after, diff, isNew });
  if (!ok) return { result: `The user rejected this change to ${t.path}. Ask what they would like instead, or continue without it.`, activity: { label: `Change to ${t.path} rejected` } };
  await apply(isNew);
  const where = t.kind === 'editor' ? ' in its open tab (unsaved until the user saves)' : '';
  return {
    result: `${isNew ? 'Created' : 'Changed'} ${t.path}${where}: +${diff.added} −${diff.removed} lines.`,
    activity: { label: `${isNew ? 'Created' : 'Changed'} ${t.path} (+${diff.added} −${diff.removed})` },
  };
}

/** A closed Word file the agent is about to change: open it in a tab and work there. */
async function openForChange(ws: AgentWorkspace, t: Target): Promise<Target | { error: string }> {
  if (t.kind !== 'folder' || !WORD_FILE.test(t.path)) return t;
  if (!ws.openInTab) return { error: `${t.path} has to be open in a tab to be changed. Ask the user to open it.` };
  const editor = await ws.openInTab(t.path);
  return editor ? { kind: 'editor', editor, path: t.path } : { error: `${t.path} couldn't be opened for editing.` };
}

async function editFile(ws: AgentWorkspace, host: ToolHost, rawPath: unknown, oldString: string, newString: string, replaceAll: boolean) {
  const label = `Edit ${cleanPath(rawPath) || 'file'}`;
  const found = resolveTarget(ws, rawPath);
  if ('error' in found) return { result: `Error: ${found.error}`, activity: { label, error: true } };
  if (found.kind === 'folder' && WORD_FILE.test(found.path) && !(await found.folder.read(found.path))) {
    return { result: `Error: ${found.path} does not exist. Use write_file to create it.`, activity: { label, error: true } };
  }
  const t = await openForChange(ws, found);
  if ('error' in t) return { result: `Error: ${t.error}`, activity: { label, error: true } };
  const got = await readText(t);
  if (!got) return { result: `Error: ${t.path} does not exist. Use write_file to create it.`, activity: { label, error: true } };
  if ('error' in got) return { result: `Error: ${got.error}`, activity: { label, error: true } };
  const edited = applyEdit(got.text, oldString, newString, replaceAll);
  if ('error' in edited) {
    const hint = isDocument(t) && found.kind === 'folder' ? ' It is now open in a tab: read it again (the text may differ slightly from the closed file) and retry.' : '';
    return { result: `Error: ${edited.error}${hint}`, activity: { label: `Edit to ${t.path} didn't match`, error: true } };
  }
  if (isDocument(t) && t.kind === 'editor') {
    const ed = t.editor;
    return propose(ws, host, t, got.text, edited.text, async () => {
      const res = ed.editText?.(oldString, newString, replaceAll);
      if (!res || 'error' in res) throw new Error(res && 'error' in res ? res.error : 'The document could not be changed.');
    });
  }
  return propose(ws, host, t, got.text, edited.text, (isNew) => writeText(ws, t, edited.text, isNew, got.bom));
}

async function writeFile(ws: AgentWorkspace, host: ToolHost, rawPath: unknown, content: string) {
  const label = `Write ${cleanPath(rawPath) || 'file'}`;
  const found = resolveTarget(ws, rawPath);
  if ('error' in found) return { result: `Error: ${found.error}`, activity: { label, error: true } };
  const exists = found.kind === 'editor' || !!(await found.folder.read(found.path));
  // a new Word / OpenDocument / RTF file: made from the Markdown content, in that format
  if (!exists && found.kind === 'folder' && WORD_FILE.test(found.path)) {
    const folder = found.folder;
    return propose(ws, host, found, null, content, async () => {
      const [{ importMarkdown }, { exportFlow, formatFromExtension }] = await Promise.all([import('../../core/formats/markdown'), import('../../core/registry')]);
      const format = formatFromExtension(found.path);
      if (!format) throw new Error(`Files like ${found.path} can't be created.`);
      const doc = await importMarkdown(new TextEncoder().encode(content));
      const bytes = await exportFlow(doc, format);
      const dirs: string[] = [];
      for (let d = dirOf(found.path); d; d = dirOf(d)) dirs.unshift(d);
      for (const d of dirs) await folder.createDir(d).catch(() => undefined);
      await folder.createFile(found.path, bytes);
      ws.folderChanged(dirOf(found.path));
    });
  }
  const t = exists ? await openForChange(ws, found) : found;
  if ('error' in t) return { result: `Error: ${t.error}`, activity: { label, error: true } };
  const got = await readText(t);
  if (got && 'error' in got) return { result: `Error: ${got.error}`, activity: { label, error: true } };
  if (got && got.text === content) return { result: `${t.path} already has exactly this content.`, activity: { label: `${t.path} unchanged` } };
  if (isDocument(t) && t.kind === 'editor') {
    const ed = t.editor;
    // the review shows the document's text against the Markdown it is replaced with
    return propose(ws, host, t, got ? got.text : null, content, async () => {
      if (!ed.writeMarkdown) throw new Error('The document could not be replaced.');
      await ed.writeMarkdown(content);
    });
  }
  return propose(ws, host, t, got ? got.text : null, content, (isNew) => writeText(ws, t, content, isNew, got ? got.bom : false));
}
