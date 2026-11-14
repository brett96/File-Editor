/**
 * Opened folders. A folder is worked with through this one interface whether it is a
 * FileSystemDirectoryHandle (Chrome / Edge), a root the desktop main process granted (the
 * renderer names only a folder id and a relative path), or a list of files held in memory
 * (browsers without the File System Access API hand over a folder's files once, read-only).
 */
import { dirOf, isSafeName, joinPath, leafOf, safeSegments } from '../core/web/paths';
import { rememberRecent, type DesktopBridge, type OpenedFile } from './host';

export interface FolderEntry {
  name: string;
  /** relative to the folder root, '/'-separated */
  path: string;
  kind: 'file' | 'dir';
  /** dependency and tool folders (node_modules, .git…): shown dimmed, never searched */
  ignored?: boolean;
}

export interface OpenedFolder {
  id: string;
  name: string;
  /** false when the folder was handed over as a read-only list of files */
  canWrite: boolean;
  /** Deleting moves to the recycle bin / Trash (desktop) rather than removing for good. */
  removesToTrash?: boolean;
  /** The entries directly inside `path` ('' is the root): folders first, then files, by name. */
  list(path: string): Promise<FolderEntry[]>;
  /** Opens a file for editing; Save writes back to it. */
  open(path: string): Promise<OpenedFile>;
  /** Reads a file's content without opening it (the web preview); null when it does not exist. */
  read(path: string): Promise<Blob | null>;
  createFile(path: string, content?: Uint8Array): Promise<void>;
  createDir(path: string): Promise<void>;
  /** Renames the entry at `path` in place; resolves to its new path. */
  rename(path: string, newName: string): Promise<string>;
  /** Deletes a file or folder (the desktop app moves it to the recycle bin / Trash). */
  remove(path: string): Promise<void>;
}

/** Folders that hold dependencies, build output or tool state rather than the project's own files. */
export const IGNORED_DIRS = ['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', 'target', '.idea', '.vs'];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortEntries(entries: FolderEntry[]): FolderEntry[] {
  return entries.sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'dir' ? -1 : 1));
}

function entry(dir: string, name: string, kind: 'file' | 'dir'): FolderEntry {
  return { name, path: joinPath(dir, name), kind, ...(kind === 'dir' && IGNORED_DIRS.includes(name) ? { ignored: true } : {}) };
}

function segments(path: string): string[] {
  const parts = safeSegments(path);
  if (!parts) throw new Error('That is not a path inside the folder.');
  return parts;
}

function checkName(name: string): string {
  if (!isSafeName(name)) throw new Error(`"${name}" can't be used as a name (it is empty or contains \\ / : * ? " < > |).`);
  return name;
}

let folderSeq = 1;

// ── File System Access API ──────────────────────────────────────────────────
type DirHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemHandle>;
  requestPermission?(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
};
type MovableFile = FileSystemFileHandle & { move?(name: string): Promise<void> };

export function handleFolder(root: FileSystemDirectoryHandle, canWrite: boolean): OpenedFolder {
  const id = `w${folderSeq++}`;
  const dirAt = async (path: string, create = false): Promise<DirHandle> => {
    let dir = root as DirHandle;
    for (const part of segments(path)) dir = (await dir.getDirectoryHandle(part, { create })) as DirHandle;
    return dir;
  };
  const folder: OpenedFolder = {
    id,
    name: root.name,
    canWrite,
    async list(path) {
      const dir = await dirAt(path);
      const out: FolderEntry[] = [];
      for await (const h of dir.values()) out.push(entry(path, h.name, h.kind === 'directory' ? 'dir' : 'file'));
      return sortEntries(out);
    },
    async open(path) {
      const handle = await (await dirAt(dirOf(path))).getFileHandle(leafOf(path));
      const file = await handle.getFile();
      void rememberRecent(handle);
      return { name: file.name, blob: file, handle, folder: { folder, path } };
    },
    async read(path) {
      try {
        return await (await (await dirAt(dirOf(path))).getFileHandle(leafOf(path))).getFile();
      } catch {
        return null;
      }
    },
    async createFile(path, content) {
      const dir = await dirAt(dirOf(path));
      const name = checkName(leafOf(path));
      const exists = await dir.getFileHandle(name).then(() => true, () => false);
      if (exists) throw new Error(`${name} already exists.`);
      const handle = await dir.getFileHandle(name, { create: true });
      const w = await handle.createWritable();
      if (content?.length) await w.write(content as unknown as FileSystemWriteChunkType);
      await w.close();
    },
    async createDir(path) {
      const dir = await dirAt(dirOf(path));
      const name = checkName(leafOf(path));
      const exists = await dir.getDirectoryHandle(name).then(() => true, () => false);
      if (exists) throw new Error(`${name} already exists.`);
      await dir.getDirectoryHandle(name, { create: true });
    },
    async rename(path, newName) {
      const dir = await dirAt(dirOf(path));
      const name = checkName(newName);
      const taken = (await dir.getFileHandle(name).then(() => true, () => false)) || (await dir.getDirectoryHandle(name).then(() => true, () => false));
      if (taken) throw new Error(`${name} already exists.`);
      const handle = (await dir.getFileHandle(leafOf(path)).catch(() => null)) as MovableFile | null;
      if (!handle) throw new Error('This browser can rename files but not folders. Rename the folder in your file manager, then press Refresh.');
      if (!handle.move) throw new Error('This browser cannot rename files in place. Rename it in your file manager, then press Refresh.');
      await handle.move(name);
      return joinPath(dirOf(path), name);
    },
    async remove(path) {
      await (await dirAt(dirOf(path))).removeEntry(leafOf(path), { recursive: true });
    },
  };
  return folder;
}

// ── in memory ───────────────────────────────────────────────────────────────
/**
 * A folder kept in memory: what `<input webkitdirectory>` hands over (read-only: the browser
 * gave copies, so saving a file downloads it), and the development hook's test folders.
 */
export function memoryFolder(name: string, files: Map<string, Blob>, canWrite: boolean): OpenedFolder {
  const id = `m${folderSeq++}`;
  const dirs = new Set<string>();
  const addDirs = (path: string) => {
    for (let d = dirOf(path); d; d = dirOf(d)) dirs.add(d);
  };
  for (const path of files.keys()) addDirs(path);
  const readOnly = () => {
    if (!canWrite) throw new Error('This browser opened the folder read-only. Use Chrome or Edge, or the desktop app, to change its files.');
  };
  const folder: OpenedFolder = {
    id,
    name,
    canWrite,
    async list(path) {
      segments(path);
      const out: FolderEntry[] = [];
      for (const d of dirs) if (dirOf(d) === path) out.push(entry(path, leafOf(d), 'dir'));
      for (const f of files.keys()) if (dirOf(f) === path) out.push(entry(path, leafOf(f), 'file'));
      return sortEntries(out);
    },
    async open(path) {
      const blob = files.get(path);
      if (!blob) throw new Error(`${leafOf(path)} is no longer in the folder.`);
      return { name: leafOf(path), blob, folder: { folder, path } };
    },
    async read(path) {
      return files.get(path) ?? null;
    },
    async createFile(path, content) {
      readOnly();
      segments(path);
      checkName(leafOf(path));
      if (files.has(path) || dirs.has(path)) throw new Error(`${leafOf(path)} already exists.`);
      files.set(path, new Blob([(content ?? new Uint8Array()) as BlobPart]));
      addDirs(path);
    },
    async createDir(path) {
      readOnly();
      segments(path);
      checkName(leafOf(path));
      if (files.has(path) || dirs.has(path)) throw new Error(`${leafOf(path)} already exists.`);
      dirs.add(path);
      addDirs(path);
    },
    async rename(path, newName) {
      readOnly();
      const to = joinPath(dirOf(path), checkName(newName));
      if (files.has(to) || dirs.has(to)) throw new Error(`${newName} already exists.`);
      const move = (from: string) => (from === path ? to : to + from.slice(path.length));
      for (const [f, blob] of [...files]) {
        if (f === path || f.startsWith(`${path}/`)) {
          files.delete(f);
          files.set(move(f), blob);
        }
      }
      for (const d of [...dirs]) {
        if (d === path || d.startsWith(`${path}/`)) {
          dirs.delete(d);
          dirs.add(move(d));
        }
      }
      return to;
    },
    async remove(path) {
      readOnly();
      for (const f of [...files.keys()]) if (f === path || f.startsWith(`${path}/`)) files.delete(f);
      for (const d of [...dirs]) if (d === path || d.startsWith(`${path}/`)) dirs.delete(d);
    },
  };
  return folder;
}

/** The files of an `<input type="file" webkitdirectory>` pick, as a read-only folder. */
export function folderFromFileList(list: File[]): OpenedFolder | null {
  if (!list.length) return null;
  const files = new Map<string, Blob>();
  let root = '';
  for (const f of list) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const parts = rel.split('/');
    if (parts.length > 1) root = parts.shift()!;
    const path = parts.join('/');
    if (safeSegments(path) && path) files.set(path, f);
  }
  return memoryFolder(root || 'Folder', files, false);
}

function pickDirectoryWithInput(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.style.display = 'none';
    let done = false;
    const finish = (files: File[]) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

/** Asks for a folder in the browser. Resolves to null when the picker was cancelled. */
export async function pickWebFolder(): Promise<OpenedFolder | null> {
  const picker = (window as Window & { showDirectoryPicker?: (o?: unknown) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
  if (typeof picker === 'function' && window.isSecureContext) {
    try {
      const handle = await picker.call(window, { mode: 'readwrite' });
      return handleFolder(handle, true);
    } catch (err) {
      if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return null;
      // SecurityError and friends: fall through to the classic input
    }
  }
  return folderFromFileList(await pickDirectoryWithInput());
}

/** A folder dropped on the window (Chrome / Edge give its handle); asks for write access once. */
export async function droppedFolder(handle: FileSystemDirectoryHandle): Promise<OpenedFolder> {
  const h = handle as DirHandle;
  const perm = (await h.requestPermission?.({ mode: 'readwrite' }).catch(() => 'denied' as PermissionState)) ?? 'denied';
  return handleFolder(handle, perm === 'granted');
}

// ── desktop ─────────────────────────────────────────────────────────────────
export function desktopFolder(bridge: NonNullable<DesktopBridge['folder']>, id: string, name: string): OpenedFolder {
  const folder: OpenedFolder = {
    id,
    name,
    canWrite: true,
    removesToTrash: true,
    list: async (path) => sortEntries((await bridge.list(id, path)).map((e) => entry(path, e.name, e.kind))),
    async open(path) {
      const f = await bridge.open(id, path);
      return { name: f.name, blob: new Blob([f.bytes as BlobPart]), handle: f.token, folder: { folder, path } };
    },
    async read(path) {
      const bytes = await bridge.read(id, path).catch(() => null);
      return bytes ? new Blob([bytes as BlobPart]) : null;
    },
    createFile: (path, content) => bridge.createFile(id, path, content ?? new Uint8Array()),
    createDir: (path) => bridge.createDir(id, path),
    rename: (path, newName) => bridge.rename(id, path, checkName(newName)),
    remove: (path) => bridge.remove(id, path),
  };
  return folder;
}
