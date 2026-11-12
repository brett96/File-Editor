/**
 * File access abstraction. The UI never touches the filesystem directly: it asks the host,
 * which is either the browser (file inputs, File System Access API, downloads) or the
 * Electron preload bridge (native dialogs; paths stay in the main process).
 */

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
  description: string;
  /** Write straight to this handle (no dialog) when possible. */
  handle?: unknown;
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
  saveFileAs(options: { suggestedName: string; ext: string; description: string }, bytes: Uint8Array): Promise<{ name: string; token: string } | null>;
  onOpenFile(callback: (file: { name: string; bytes: Uint8Array; token: string }) => void): () => void;
  onMenuCommand(callback: (command: string) => void): () => void;
  setDirty(dirty: boolean): void;
  setTitle(title: string): void;
  /** Desktop license activation (see electron/license.ts). */
  license: {
    get(): Promise<LicenseState>;
    activate(key: string): Promise<{ ok: true; state: LicenseState } | { ok: false; error: string; code: string }>;
  };
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
    showOpenFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle>;
  }
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

function createWebHost(): FileHost {
  const fsAccess = typeof window.showOpenFilePicker === 'function' && typeof window.showSaveFilePicker === 'function' && window.isSecureContext;
  return {
    kind: 'web',
    canSaveInPlace: fsAccess,
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
      if (fsAccess) {
        try {
          if (req.handle) return await write(req.handle as FileSystemFileHandle);
          const handle = await window.showSaveFilePicker!({
            suggestedName: req.suggestedName,
            types: [{ description: req.description, accept: { [req.mime]: ['.' + req.ext] } }],
          });
          return await write(handle);
        } catch (err) {
          if (isAbort(err)) return null;
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
    async save(req) {
      const res = typeof req.handle === 'string'
        ? await bridge.saveFile(req.handle, req.bytes)
        : await bridge.saveFileAs({ suggestedName: req.suggestedName, ext: req.ext, description: req.description }, req.bytes);
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

/** Reads a File (drag-and-drop / paste) into an OpenedFile. */
export async function readDroppedFile(file: File): Promise<OpenedFile> {
  return { name: file.name, blob: file };
}

export async function fileBytes(file: OpenedFile): Promise<Uint8Array> {
  return new Uint8Array(await file.blob.arrayBuffer());
}

/** The desktop app's license API, or null in the browser (licenses are desktop-only). */
export function licenseBridge(): DesktopBridge['license'] | null {
  return typeof window !== 'undefined' ? window.desktop?.license ?? null : null;
}
