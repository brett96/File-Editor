/**
 * File access abstraction. The UI never touches the filesystem directly: it asks the host,
 * which is either the browser (file inputs, File System Access API, downloads) or the
 * Electron preload bridge (native dialogs; paths stay in the main process).
 */

import { saveNameProblem, type DocKind } from '../core/conversions';

export interface OpenedFile {
  name: string;
  /** The file's content. A File on the web, so large media is read lazily rather than up front. */
  blob: Blob;
  /** Opaque token that lets the host write back to the same file. */
  handle?: unknown;
}

export interface SaveRequest {
  suggestedName: string;
  bytes: Uint8Array;
  mime: string;
  /** Extension without dot, used for dialog filters. */
  ext: string;
  /** Every extension the format owns (jpg / jpeg); the saved name must end in one of them. Defaults to `ext`. */
  extensions?: readonly string[];
  /** The kind of document being saved, for a clearer message when the name asks for another kind of file. */
  kind?: DocKind;
  description: string;
  /** Write straight to this handle (no dialog) when possible. */
  handle?: unknown;
  /**
   * Auto-save: write to `handle` or fail. Never shows a dialog, asks for permission or falls
   * back to a download.
   */
  quiet?: boolean;
}

export interface RecentEntry {
  id: string;
  name: string;
  /** the folder's name on desktop; empty on the web (browsers don't reveal it) */
  folder: string;
}

export interface RecentFiles {
  list(): Promise<RecentEntry[]>;
  /** Re-opens a recent file (asks the browser for permission if needed). */
  open(id: string): Promise<OpenedFile>;
  clear(): Promise<void>;
  /** Takes one file off the list (the file itself is not touched). */
  remove(id: string): Promise<void>;
  /** Called when the list changes (another open, a save, a clear). */
  onChange(callback: () => void): () => void;
}

export interface SaveResult {
  name: string;
  handle?: unknown;
}

export interface FileHost {
  kind: 'web' | 'desktop';
  /** Whether files can be written back in place (true Save rather than download). */
  canSaveInPlace: boolean;
  openFiles(options: { extensions: string[]; multiple?: boolean; description?: string }): Promise<OpenedFile[]>;
  save(request: SaveRequest): Promise<SaveResult | null>;
  /** Files handed to the app by the OS (double-click, "Open with", drag onto the dock icon). */
  onOpenRequest(callback: (file: OpenedFile) => void): () => void;
  /** Commands from the native application menu (desktop only). */
  onMenuCommand(callback: (command: string) => void): () => void;
  setDirty?(dirty: boolean): void;
  setTitle?(title: string): void;
  /** Recently opened files, or null where the platform can't reopen files (older browsers). */
  recent: RecentFiles | null;
  /** Whether `handle` can be written without asking the user (auto-save). */
  canWriteSilently(handle: unknown): Promise<boolean>;
  /** Asks for write access to `handle` (web; needs a click). Resolves true when granted. */
  requestWrite(handle: unknown): Promise<boolean>;
  /** Keeps the desktop File menu's Auto Save checkbox in step. */
  setAutoSave?(on: boolean): void;
  /**
   * Keeps a copy of a file as it is now, before it is overwritten in a way that can't be
   * undone: "<name>.bak" beside it on desktop, a download in the browser. Resolves to the
   * backup's name, or null when one was already there (the oldest copy is the one to keep).
   */
  backup(handle: unknown, name: string, original: Uint8Array): Promise<string | null>;
}

/** License state reported by the desktop app's main process (electron/license.ts). */
export interface LicenseState {
  status: 'unlicensed' | 'active' | 'revoked';
  email?: string;
  keyHint?: string;
  activatedAt?: string;
  message?: string;
  purchaseUrl: string;
}

/** Shape of the API exposed by electron/preload.ts. */
export interface DesktopBridge {
  platform: string;
  version: string;
  openFiles(options: { extensions: string[]; multiple: boolean; description: string }): Promise<{ name: string; bytes: Uint8Array; token: string }[]>;
  saveFile(token: string, bytes: Uint8Array): Promise<{ name: string; token: string }>;
  saveFileAs(options: { suggestedName: string; ext: string; extensions?: string[]; description: string }, bytes: Uint8Array): Promise<{ name: string; token: string } | null>;
  onOpenFile(callback: (file: { name: string; bytes: Uint8Array; token: string }) => void): () => void;
  onMenuCommand(callback: (command: string) => void): () => void;
  onUpdateStatus?(callback: (status: UpdateStatus) => void): () => void;
  /** Same as Help → Check for Updates (used by the update banner's Retry). */
  checkForUpdates?(): void;
  installUpdate?(): void;
  setDirty(dirty: boolean): void;
  setTitle(title: string): void;
  recent?: {
    list(): Promise<RecentEntry[]>;
    open(id: string): Promise<{ name: string; bytes: Uint8Array; token: string }>;
    clear(): Promise<void>;
    remove(id: string): Promise<void>;
    onChange(callback: () => void): () => void;
  };
  setAutoSave?(on: boolean): void;
  /** Copies a granted file to "<name>.bak" beside it, unless that already exists. */
  backupFile?(token: string): Promise<string | null>;
  /** Resolves a file dropped on the window to a token so Save writes back to it. */
  openDropped?(file: File): Promise<{ name: string; bytes: Uint8Array; token: string } | null>;
  /** Desktop license activation (see electron/license.ts). */
  license: {
    get(): Promise<LicenseState>;
    activate(key: string): Promise<{ ok: true; state: LicenseState } | { ok: false; error: string; code: string }>;
  };
}

export interface UpdateStatus {
  state: 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error';
  /** the new version (for 'none', the installed one) */
  version?: string;
  percent?: number;
  /** download speed, bytes per second */
  speed?: number;
  message?: string;
  /** the user asked (Help → Check for Updates): report every outcome, not just a finished download */
  manual?: boolean;
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
    showOpenFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle>;
  }
}

/** The name chosen in a save window ends in an extension the format being written does not own. */
export class SaveNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaveNameError';
  }
}

/** Why `name` can't hold what `req` writes (wrong extension for the format), or null. */
function nameProblem(req: SaveRequest, name: string): string | null {
  const owned = [req.ext, ...(req.extensions ?? [])].map((e) => e.toLowerCase());
  if (req.kind) return saveNameProblem(req.kind, name, req.ext, owned);
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  return owned.includes(ext) ? null : `This file is being saved as ${req.description}, so its name has to end in .${req.ext}.`;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'AbortError' || err.name === 'NotAllowedError');
}

function pickWithInput(extensions: string[], multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.accept = extensions.map((e) => '.' + e).join(',');
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

let lastDownloadUrl: string | null = null;

function download(bytes: Uint8Array, name: string, mime: string): void {
  // Mobile browsers (Firefox for Android, Samsung Internet…) read the blob only after the
  // person confirms the download sheet, which can take longer than any fixed delay. Keep the
  // URL alive until the next download replaces it, instead of revoking it on a timer.
  if (lastDownloadUrl) URL.revokeObjectURL(lastDownloadUrl);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  lastDownloadUrl = url;
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // removing the anchor in the same task cancels the download in some mobile browsers
  setTimeout(() => a.remove(), 0);
}

// ── web: recent files are FileSystemFileHandles kept in IndexedDB ─────────────
type PermissionHandle = FileSystemFileHandle & {
  queryPermission?(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
};

interface StoredRecent {
  id: string;
  name: string;
  handle: FileSystemFileHandle;
  openedAt: number;
}

const RECENT_MAX = 12;
const recentListeners = new Set<() => void>();

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('file-editor', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('recent', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function recentTx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await idb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction('recent', mode);
      const req = fn(tx.objectStore('recent'));
      let result: T | undefined;
      if (req) req.onsuccess = () => (result = req.result);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function storedRecents(): Promise<StoredRecent[]> {
  const all = ((await recentTx<StoredRecent[]>('readonly', (s) => s.getAll() as IDBRequest<StoredRecent[]>)) ?? []).filter((r) => r?.handle);
  return all.sort((a, b) => b.openedAt - a.openedAt);
}

/** Adds (or moves to the top) a file the user opened or saved through a FileSystemFileHandle. */
export async function rememberRecent(handle: unknown): Promise<void> {
  if (!(typeof FileSystemFileHandle !== 'undefined' && handle instanceof FileSystemFileHandle) || typeof indexedDB === 'undefined') return;
  try {
    const all = await storedRecents();
    let same: StoredRecent | undefined;
    for (const r of all) if (await r.handle.isSameEntry(handle).catch(() => false)) same = r;
    const entry: StoredRecent = { id: same?.id ?? `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, name: handle.name, handle, openedAt: Date.now() };
    const drop = all.filter((r) => r.id !== entry.id).slice(RECENT_MAX - 1);
    await recentTx('readwrite', (s) => {
      s.put(entry);
      for (const d of drop) s.delete(d.id);
    });
    recentListeners.forEach((l) => l());
  } catch {
    /* private mode, storage blocked: recents are a convenience */
  }
}

function webRecent(): RecentFiles {
  return {
    async list() {
      return (await storedRecents()).map((r) => ({ id: r.id, name: r.name, folder: '' }));
    },
    async open(id) {
      const r = (await storedRecents()).find((x) => x.id === id);
      if (!r) throw new Error('That file is no longer in the recent list.');
      const h = r.handle as PermissionHandle;
      // read+write in one prompt, so Save and auto-save then work without asking again
      let perm = (await h.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
      if (perm !== 'granted') perm = (await h.requestPermission?.({ mode: 'readwrite' }).catch(() => 'denied' as PermissionState)) ?? 'denied';
      if (perm !== 'granted') {
        const read = (await h.queryPermission?.({ mode: 'read' })) ?? 'denied';
        if (read !== 'granted') throw new Error(`The browser did not allow access to ${r.name}.`);
      }
      let file: File;
      try {
        file = await h.getFile();
      } catch {
        await recentTx('readwrite', (s) => s.delete(id));
        recentListeners.forEach((l) => l());
        throw new Error(`${r.name} can't be found any more (it was moved, renamed or deleted).`);
      }
      void rememberRecent(h);
      return { name: file.name, blob: file, handle: h };
    },
    async clear() {
      await recentTx('readwrite', (s) => s.clear());
      recentListeners.forEach((l) => l());
    },
    async remove(id) {
      await recentTx('readwrite', (s) => s.delete(id));
      recentListeners.forEach((l) => l());
    },
    onChange(cb) {
      recentListeners.add(cb);
      return () => recentListeners.delete(cb);
    },
  };
}

function createWebHost(): FileHost {
  const fsAccess = typeof window.showOpenFilePicker === 'function' && typeof window.showSaveFilePicker === 'function' && window.isSecureContext;
  return {
    kind: 'web',
    canSaveInPlace: fsAccess,
    recent: fsAccess && typeof indexedDB !== 'undefined' ? webRecent() : null,
    async canWriteSilently(handle) {
      if (!fsAccess || !(handle instanceof FileSystemFileHandle)) return false;
      const h = handle as PermissionHandle;
      return ((await h.queryPermission?.({ mode: 'readwrite' }).catch(() => 'denied')) ?? 'granted') === 'granted';
    },
    async requestWrite(handle) {
      if (!fsAccess || !(handle instanceof FileSystemFileHandle)) return false;
      const h = handle as PermissionHandle;
      const now = (await h.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
      if (now === 'granted') return true;
      return ((await h.requestPermission?.({ mode: 'readwrite' }).catch(() => 'denied')) ?? 'denied') === 'granted';
    },
    async backup(_handle, name, original) {
      download(original, `${name}.bak`, 'application/octet-stream');
      return `${name}.bak`;
    },
    async openFiles({ extensions, multiple = false, description = 'Documents' }) {
      if (fsAccess) {
        try {
          const handles = await window.showOpenFilePicker!({
            multiple,
            types: [{ description, accept: { 'application/octet-stream': extensions.map((e) => '.' + e) } }],
          });
          return Promise.all(
            handles.map(async (handle) => {
              const file = await handle.getFile();
              void rememberRecent(handle);
              return { name: file.name, blob: file, handle };
            }),
          );
        } catch (err) {
          if (isAbort(err)) return [];
          // fall through to the classic input on any other failure
        }
      }
      const files = await pickWithInput(extensions, multiple);
      return files.map((f) => ({ name: f.name, blob: f }));
    },
    async save(req) {
      const write = async (handle: FileSystemFileHandle) => {
        const writable = await handle.createWritable();
        await writable.write(req.bytes as unknown as FileSystemWriteChunkType);
        await writable.close();
        return { name: handle.name, handle };
      };
      if (req.quiet) {
        if (!fsAccess || !(req.handle instanceof FileSystemFileHandle)) throw new Error('This file has no location to save to.');
        return write(req.handle);
      }
      if (fsAccess) {
        try {
          if (req.handle) return await write(req.handle as FileSystemFileHandle);
          const owned = [...new Set([req.ext, ...(req.extensions ?? [])])];
          const handle = await window.showSaveFilePicker!({
            suggestedName: req.suggestedName,
            // only this format's extensions: a workbook is never written into "name.mp4"
            excludeAcceptAllOption: true,
            types: [{ description: req.description, accept: { [req.mime]: owned.map((e) => '.' + e) } }],
          });
          const problem = nameProblem(req, handle.name);
          if (problem) {
            // the picker has already made an empty file under that name: take it away again
            await (handle as FileSystemFileHandle & { remove?: () => Promise<void> }).remove?.().catch(() => undefined);
            throw new SaveNameError(problem);
          }
          const res = await write(handle);
          void rememberRecent(handle);
          return res;
        } catch (err) {
          if (isAbort(err)) return null;
          if (err instanceof SaveNameError) throw err;
          // e.g. permission revoked — fall back to a download
        }
      }
      download(req.bytes, req.suggestedName, req.mime);
      return { name: req.suggestedName };
    },
    onOpenRequest() {
      return () => {};
    },
    onMenuCommand() {
      return () => {};
    },
    setTitle(title) {
      document.title = title;
    },
  };
}

function createDesktopHost(bridge: DesktopBridge): FileHost {
  return {
    kind: 'desktop',
    canSaveInPlace: true,
    async openFiles({ extensions, multiple = false, description = 'Documents' }) {
      const files = await bridge.openFiles({ extensions, multiple, description });
      return files.map((f) => ({ name: f.name, blob: new Blob([f.bytes as BlobPart]), handle: f.token }));
    },
    recent: bridge.recent
      ? {
          list: () => bridge.recent!.list(),
          open: async (id) => {
            const f = await bridge.recent!.open(id);
            return { name: f.name, blob: new Blob([f.bytes as BlobPart]), handle: f.token };
          },
          clear: () => bridge.recent!.clear(),
          remove: (id) => bridge.recent!.remove(id),
          onChange: (cb) => bridge.recent!.onChange(cb),
        }
      : null,
    canWriteSilently: async (handle) => typeof handle === 'string',
    requestWrite: async (handle) => typeof handle === 'string',
    setAutoSave: (on) => bridge.setAutoSave?.(on),
    async backup(handle, name, original) {
      if (typeof handle === 'string' && bridge.backupFile) return bridge.backupFile(handle);
      download(original, `${name}.bak`, 'application/octet-stream');
      return `${name}.bak`;
    },
    async save(req) {
      if (req.quiet && typeof req.handle !== 'string') throw new Error('This file has no location to save to.');
      const res = typeof req.handle === 'string'
        ? await bridge.saveFile(req.handle, req.bytes)
        : await bridge.saveFileAs({ suggestedName: req.suggestedName, ext: req.ext, extensions: [...new Set([req.ext, ...(req.extensions ?? [])])], description: req.description }, req.bytes);
      return res ? { name: res.name, handle: res.token } : null;
    },
    onOpenRequest(callback) {
      return bridge.onOpenFile((f) => callback({ name: f.name, blob: new Blob([f.bytes as BlobPart]), handle: f.token }));
    },
    onMenuCommand: (callback) => bridge.onMenuCommand(callback),
    setDirty: (d) => bridge.setDirty(d),
    setTitle: (t) => bridge.setTitle(t),
  };
}

let host: FileHost | null = null;

export function getHost(): FileHost {
  if (!host) host = window.desktop ? createDesktopHost(window.desktop) : createWebHost();
  return host;
}

/**
 * Reads a File (drag-and-drop / paste) into an OpenedFile. `handle` is the promise from
 * DataTransferItem.getAsFileSystemHandle() (Chrome/Edge), which must be requested during the
 * drop event; with it, Save writes back to the dropped file.
 */
export async function readDroppedFile(file: File, handle?: Promise<FileSystemHandle | null> | null): Promise<OpenedFile> {
  // desktop: the preload resolves a real dropped file to a writable token (page code can't
  // fabricate one: a File built in script has no path)
  const dropped = await window.desktop?.openDropped?.(file).catch(() => null);
  if (dropped) return { name: dropped.name, blob: new Blob([dropped.bytes as BlobPart]), handle: dropped.token };
  const h = await handle?.catch(() => null);
  if (h && h.kind === 'file' && typeof window.showSaveFilePicker === 'function') {
    void rememberRecent(h);
    return { name: file.name, blob: file, handle: h };
  }
  return { name: file.name, blob: file };
}

export async function fileBytes(file: OpenedFile): Promise<Uint8Array> {
  return new Uint8Array(await file.blob.arrayBuffer());
}

/** The desktop app's license API, or null in the browser (licenses are desktop-only). */
export function licenseBridge(): DesktopBridge['license'] | null {
  return typeof window !== 'undefined' ? window.desktop?.license ?? null : null;
}
