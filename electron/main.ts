/**
 * Electron main process.
 *
 * Security model (see docs/ARCHITECTURE.md):
 *  - The renderer is the same sandboxed web app that runs in the browser: contextIsolation,
 *    sandbox and no Node integration. It talks to this process only through the small API
 *    in preload.ts.
 *  - The renderer never sees or names filesystem paths. Files are read/written only at paths
 *    the user picked in a native dialog or handed to the app via the OS; the renderer gets an
 *    opaque token for each.
 *  - An opened folder is one more grant: the root stays here, and the renderer names files in
 *    it by a folder id and a relative path that is checked (no '..', no absolute paths, and
 *    the real path must stay inside the root, so a symlink can't lead out of it).
 *  - The web preview's bundled page is served to a sandboxed sub-frame from fe-preview://, a
 *    separate origin with no network access and no access to the app.
 *  - App files are served from the custom app:// protocol with traversal checks and a strict
 *    CSP. Navigation away from the app and new windows are blocked; external links open in
 *    the default browser.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell, type MenuItemConstructorOptions } from 'electron';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { appendFile, copyFile, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { activateLicense, getLicenseState, refreshLicenseStatus } from './license';
import { CODE_EXTENSIONS, isCodeFileName } from '../src/core/code/languages';
import { isSafeName, safeSegments } from '../src/core/web/paths';

const APP_SCHEME = 'app';
const APP_HOST = 'editor';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
/** The web preview's own origin: bundled pages are served from here to a sandboxed sub-frame. */
const PREVIEW_SCHEME = 'fe-preview';
const PREVIEW_ORIGIN = `${PREVIEW_SCHEME}://doc`;
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const MAX_FILE_BYTES = 250 * 1024 * 1024;
/** Workbooks and databases: read as a stream / a page at a time by the renderer, so they can be large. */
const MAX_DATA_BYTES = 2 * 1024 * 1024 * 1024 - 1;
const DATA = ['xlsx', 'xlsm', 'xltx', 'csv', 'tsv', 'tab', 'sqlite', 'sqlite3', 'db', 'db3', 'sdb'];
/** Video can be much larger than a document. */
const MAX_MEDIA_BYTES = 4 * 1024 * 1024 * 1024;
const DOCUMENTS = ['docx', 'docm', 'dotx', 'doc', 'dot', 'pdf', 'odt', 'rtf', 'md', 'markdown', 'html', 'htm', 'css', 'js', 'mjs', 'txt', ...CODE_EXTENSIONS, 'xlsx', 'xlsm', 'xltx', 'csv', 'tsv', 'tab', 'sqlite', 'sqlite3', 'db', 'db3', 'sdb'];
const IMAGES = ['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'avif', 'heic', 'heif', 'jxl', 'bmp', 'tif', 'tiff', 'ico', 'svg', 'svgz', 'ai', 'psd'];
const MEDIA = [
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'asf', 'flv', 'mpg', 'mpeg', 'vob', '3gp', '3g2', 'ogv', 'ts', 'mts', 'm2ts',
  'mp3', 'm4a', 'wav', 'flac', 'ogg', 'oga', 'opus', 'aac', 'wma', 'aiff', 'aif', 'amr',
];
/** Studio project files (a zip of the timeline + its media), so as large as media */
const PROJECTS = ['fstudio'];
const OPENABLE = [...DOCUMENTS, ...IMAGES, ...MEDIA, ...PROJECTS];
/** Whether a path names a file the app opens (by extension, or a source file known by name such as Dockerfile). */
const isOpenable = (path: string) => OPENABLE.includes(extname(path).slice(1).toLowerCase()) || isCodeFileName(basename(path));

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  `frame-src 'self' blob: ${PREVIEW_SCHEME}:`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

/**
 * What a previewed page may do: run its own (inlined) scripts and styles, nothing else. The
 * sandbox gives it an opaque origin (no storage, no access to the app); default-src has no
 * network scheme, so it can't load or send anything.
 */
const PREVIEW_CSP = "sandbox allow-scripts allow-forms allow-modals; default-src data: blob: 'unsafe-inline' 'unsafe-eval'";

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true } },
]);

let mainWindow: BrowserWindow | null = null;
let dirty = false;
/** mirrors the renderer's Auto Save setting for the File menu checkbox */
let autoSave = true;
let rendererReady = false;
const pendingOpen: string[] = [];

/** token → absolute path the user granted access to */
const grants = new Map<string, string>();

function grant(path: string): string {
  for (const [token, p] of grants) if (p === path) return token;
  const token = randomUUID();
  grants.set(token, path);
  return token;
}

async function readGranted(path: string): Promise<{ name: string; bytes: Uint8Array; token: string }> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('Not a file.');
  const ext = extname(path).slice(1).toLowerCase();
  const isMedia = MEDIA.includes(ext) || PROJECTS.includes(ext);
  const isData = DATA.includes(ext);
  const limit = isMedia ? MAX_MEDIA_BYTES : isData ? MAX_DATA_BYTES : MAX_FILE_BYTES;
  if (info.size > limit) throw new Error(`This file is too large to open (limit ${isMedia ? '4 GB' : isData ? '2 GB' : '250 MB'}).`);
  const bytes = new Uint8Array(await readFile(path));
  addRecent(path);
  return { name: basename(path), bytes, token: grant(path) };
}

// ── recent files ───────────────────────────────────────────────────────────
// Kept in userData/recent-files.json. The renderer only ever sees an id, the file name and
// its folder's name; the path stays in this process like every other granted file.
const RECENT_MAX = 12;
interface Recent {
  id: string;
  path: string;
  openedAt: number;
}
let recents: Recent[] = [];
const recentStore = () => join(app.getPath('userData'), 'recent-files.json');

async function loadRecents() {
  try {
    const raw = JSON.parse(await readFile(recentStore(), 'utf8')) as unknown;
    recents = Array.isArray(raw)
      ? raw
          .filter((r): r is { path: string; openedAt?: number } => typeof r?.path === 'string' && isOpenable(r.path))
          .slice(0, RECENT_MAX)
          .map((r) => ({ id: randomUUID(), path: r.path, openedAt: Number(r.openedAt) || 0 }))
      : [];
  } catch {
    recents = [];
  }
}

function recentsChanged() {
  void writeFile(recentStore(), JSON.stringify(recents.map(({ path, openedAt }) => ({ path, openedAt })))).catch(() => undefined);
  if (app.isReady()) buildMenu();
  mainWindow?.webContents.send('recent-changed');
}

function addRecent(path: string) {
  const old = recents.find((r) => r.path === path);
  recents = [{ id: old?.id ?? randomUUID(), path, openedAt: Date.now() }, ...recents.filter((r) => r.path !== path)].slice(0, RECENT_MAX);
  try {
    app.addRecentDocument(path); // Windows jump list / macOS Dock & File ▸ Open Recent
  } catch {
    /* not supported */
  }
  recentsChanged();
}

function removeRecent(path: string) {
  recents = recents.filter((r) => r.path !== path);
  recentsChanged();
}

function clearRecents() {
  recents = [];
  try {
    app.clearRecentDocuments();
  } catch {
    /* not supported */
  }
  recentsChanged();
}

/** Renderer-safe view of the list: no paths. */
const recentList = () => recents.map((r) => ({ id: r.id, name: basename(r.path), folder: basename(dirname(r.path)) }));

// ── single instance + OS "open with" ───────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function filesFromArgv(argv: string[]): string[] {
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((a) => !a.startsWith('-') && isOpenable(a))
    .map((a) => resolve(a));
}

async function deliverOpen(path: string) {
  if (!mainWindow || !rendererReady) {
    pendingOpen.push(path);
    return;
  }
  try {
    const file = await readGranted(path);
    mainWindow.webContents.send('open-file', file);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (missing) removeRecent(path);
    dialog.showErrorBox('Could not open file', `${path}\n\n${missing ? 'The file no longer exists (it was moved, renamed or deleted).' : (err as Error).message}`);
  }
}

app.on('second-instance', (_e, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  for (const f of filesFromArgv(argv)) void deliverOpen(f);
});

app.on('open-file', (event, path) => {
  // macOS: Finder double-click / drag onto dock icon
  event.preventDefault();
  void deliverOpen(path);
});

// ── app:// protocol ────────────────────────────────────────────────────────
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
};

const APP_ROOT = join(__dirname, '..', 'dist');
const APP_ROOT_URL = pathToFileURL(APP_ROOT + sep).href;

function registerAppProtocol() {
  const root = APP_ROOT;
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const target = normalize(join(root, pathname));
    const rel = relative(root, target);
    if (rel.startsWith('..') || rel.includes(`..${sep}`) || resolve(target) !== target) {
      return new Response('Forbidden', { status: 403 });
    }
    const res = await net.fetch(pathToFileURL(target).toString());
    const headers = new Headers(res.headers);
    if (target.endsWith('.html')) headers.set('Content-Security-Policy', CSP);
    // WebAssembly streaming compilation and module workers need exact MIME types
    const mime = MIME_TYPES[extname(target).toLowerCase()];
    if (mime) headers.set('Content-Type', mime);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: res.status, headers });
  });
}

// ── opened folders ─────────────────────────────────────────────────────────
/** folder id → the real path of a folder the user picked */
const folderRoots = new Map<string, string>();
/** Files the web preview may read without opening them (a page's stylesheets, scripts, images). */
const MAX_PREVIEW_READ_BYTES = 64 * 1024 * 1024;

/**
 * The absolute path of `rel` inside `root`, or an error. `rel` must be a clean relative path
 * (checked by safeSegments), and what it resolves to on disk — following symlinks, for the
 * deepest part that exists — must still be inside the root.
 */
async function pathInside(root: string, rel: unknown): Promise<string> {
  const parts = safeSegments(rel);
  if (!parts) throw new Error('That is not a path inside the folder.');
  const target = join(root, ...parts);
  let existing = target;
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch {
      const up = dirname(existing);
      if (up === existing) throw new Error('That is not a path inside the folder.');
      existing = up;
    }
  }
  const back = relative(root, existing);
  if (back === '..' || back.startsWith(`..${sep}`) || resolve(root, back) !== existing) throw new Error('That is not a path inside the folder.');
  return target;
}

function folderRoot(id: unknown): string {
  const root = folderRoots.get(String(id));
  if (!root) throw new Error('This folder is no longer open.');
  return root;
}

/** A file's bytes for the preview, or null when it is missing, not a file or too large. */
async function peek(path: string): Promise<Uint8Array | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_PREVIEW_READ_BYTES) return null;
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

// ── web preview documents ──────────────────────────────────────────────────
/** preview id → the bundled page (one per open code tab; the oldest goes when there are too many) */
const previews = new Map<string, string>();
const MAX_PREVIEWS = 24;
const MAX_PREVIEW_CHARS = 256 * 1024 * 1024;

function registerPreviewProtocol() {
  protocol.handle(PREVIEW_SCHEME, (request) => {
    const url = new URL(request.url);
    const html = url.host === 'doc' ? previews.get(decodeURIComponent(url.pathname.slice(1))) : undefined;
    if (html === undefined) return new Response('Not found', { status: 404 });
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': PREVIEW_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  });
}

// ── window ─────────────────────────────────────────────────────────────────
function isAppUrl(url: string): boolean {
  if (DEV_URL) return url.startsWith(DEV_URL);
  return url.startsWith(APP_ORIGIN + '/');
}

function openExternalSafely(url: string) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') void shell.openExternal(u.toString());
  } catch {
    /* ignore malformed */
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: windowTitle(),
    backgroundColor: '#eef0f4',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  const wc = mainWindow.webContents;
  wc.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) {
      e.preventDefault();
      openExternalSafely(url);
    }
  });
  wc.on('will-redirect', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('blob:')) openExternalSafely(url);
    return { action: 'deny' };
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.on('did-start-loading', () => {
    rendererReady = false;
  });
  wc.on('did-finish-load', () => {
    rendererReady = true;
    const queued = pendingOpen.splice(0);
    for (const f of queued) void deliverOpen(f);
  });

  mainWindow.on('close', (e) => {
    if (!dirty || !mainWindow) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Discard changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'You have unsaved changes.',
      detail: 'Close anyway and lose them?',
    });
    if (choice === 1) e.preventDefault();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(DEV_URL ?? `${APP_ORIGIN}/index.html`);
}

// ── menu ───────────────────────────────────────────────────────────────────
function send(command: string) {
  mainWindow?.webContents.send('menu', command);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
        { label: 'New Spreadsheet', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('new-spreadsheet') },
        { label: 'New Database', click: () => send('new-database') },
        { label: 'New Drawing', click: () => send('new-drawing') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('open-folder') },
        {
          label: 'Open Recent',
          submenu: recents.length
            ? [
                ...recents.map((r, i): MenuItemConstructorOptions => ({
                  label: `${i < 9 ? `&${i + 1}  ` : ''}${basename(r.path).replace(/&/g, '&&')}`,
                  sublabel: dirname(r.path),
                  toolTip: r.path,
                  click: () => void deliverOpen(r.path),
                })),
                { type: 'separator' },
                {
                  label: 'Remove from List',
                  submenu: recents.map((r): MenuItemConstructorOptions => ({
                    label: basename(r.path).replace(/&/g, '&&'),
                    sublabel: dirname(r.path),
                    toolTip: r.path,
                    click: () => removeRecent(r.path),
                  })),
                },
                { label: 'Clear Recently Opened', click: () => clearRecents() },
              ]
            : [{ label: 'No recent files', enabled: false }],
        },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Save As / Convert…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-as') },
        { label: 'Auto Save', type: 'checkbox', checked: autoSave, click: () => send('toggle-autosave') },
        { label: 'Password Protection…', click: () => send('protect') },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => send('print') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        ...(!app.isPackaged ? [{ type: 'separator' as const }, { role: 'reload' as const }, { role: 'toggleDevTools' as const }] : []),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'User Guide', accelerator: 'F1', click: () => send('help:context') },
        { label: 'Studio Guide', click: () => send('help:studio') },
        { label: 'Pro Photo Guide', click: () => send('help:photo-pro') },
        { label: 'Vector Studio Guide', click: () => send('help:vector') },
        { label: 'Keyboard Shortcuts', click: () => send('help:shortcuts') },
        { type: 'separator' },
        { label: licensed ? 'View License Info…' : 'Enter License Key…', click: () => send('license') },
        { label: 'Check for Updates…', click: () => void checkForUpdates(true) },
        {
          label: 'Show Update Log',
          click: async () => {
            const file = updateLogPath();
            const exists = await stat(file).then(() => true, () => false);
            if (exists) shell.showItemInFolder(file);
            else void dialog.showMessageBox({ type: 'info', title: 'Update Log', message: 'Nothing has been logged yet.', detail: file });
          },
        },
        { type: 'separator' },
        {
          label: 'About File Editor',
          click: async () => {
            const lic = await getLicenseState().catch(() => null);
            const licensed = lic?.status === 'active' ? `Licensed to ${lic.email} (key ${lic.keyHint}).` : 'Not activated.';
            void dialog.showMessageBox({
              type: 'info',
              title: 'About',
              message: `File Editor ${app.getVersion()}`,
              detail: `Documents are processed locally on this computer and are never uploaded.\n\n${licensed}`,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Help menu says "View License Info…" once this computer holds an active license. */
let licensed = false;
/** Last title from the renderer (without the unlicensed marker). */
let titleBase = 'File Editor';

function windowTitle(): string {
  const base = titleBase.replace(/\s*\(UNLICENSED\)\s*$/i, '').trimEnd() || 'File Editor';
  return licensed ? base : `${base} (UNLICENSED)`;
}

function applyWindowTitle() {
  mainWindow?.setTitle(windowTitle().slice(0, 200));
}

async function refreshLicenseMenu() {
  const state = await getLicenseState().catch(() => null);
  const now = state?.status === 'active';
  const wasLicensed = licensed;
  if (now !== licensed) {
    licensed = now;
    if (app.isReady()) buildMenu();
  }
  applyWindowTitle();
  // Tell the renderer when an active license goes away (refund / revoke) so it can update UI.
  if (wasLicensed && !now && state) {
    mainWindow?.webContents.send('license-changed', state);
  }
}

/** Server check-in for an activated license; updates the Help menu and window title if status changed. */
async function checkLicenseInBackground() {
  await refreshLicenseStatus(true).catch(() => undefined);
  await refreshLicenseMenu();
}

// ── IPC ────────────────────────────────────────────────────────────────────
function assertSender(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  const url = e.senderFrame?.url ?? '';
  if (!mainWindow || e.sender !== mainWindow.webContents || !isAppUrl(url)) throw new Error('Unauthorized IPC sender');
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error('Expected binary data.');
}

function registerIpc() {
  ipcMain.handle('open-files', async (e, opts: { extensions?: string[]; multiple?: boolean; description?: string }) => {
    assertSender(e);
    const extensions = (opts?.extensions ?? OPENABLE).filter((x) => /^[a-z0-9]{1,10}$/i.test(x));
    const res = await dialog.showOpenDialog(mainWindow!, {
      properties: opts?.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: String(opts?.description ?? 'Documents').slice(0, 60), extensions }, { name: 'All files', extensions: ['*'] }],
    });
    if (res.canceled) return [];
    return Promise.all(res.filePaths.map(readGranted));
  });

  ipcMain.handle('save-file', async (e, token: string, data: unknown) => {
    assertSender(e);
    const path = grants.get(String(token));
    if (!path) throw new Error('This file can no longer be written. Use Save As.');
    await writeFile(path, toBytes(data));
    return { name: basename(path), token };
  });

  // "<file>.bak" beside a granted file, made once: the copy from before the first overwrite is the one worth keeping
  ipcMain.handle('backup-file', async (e, token: unknown) => {
    assertSender(e);
    const path = grants.get(String(token));
    if (!path) throw new Error('This file can no longer be read.');
    try {
      await copyFile(path, `${path}.bak`, fsConstants.COPYFILE_EXCL);
      return `${basename(path)}.bak`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw err;
    }
  });

  ipcMain.handle('save-file-as', async (e, opts: { suggestedName?: string; ext?: string; description?: string }, data: unknown) => {
    assertSender(e);
    const ext = /^[a-z0-9]{1,10}$/i.test(opts?.ext ?? '') ? opts.ext! : 'bin';
    const name = basename(String(opts?.suggestedName ?? `Document.${ext}`)).replace(/[<>:"|?*\u0000-\u001f]/g, '_');
    // every extension the format owns (jpg / jpeg): the file is never written under another one
    const extra = Array.isArray((opts as { extensions?: unknown })?.extensions) ? ((opts as { extensions: unknown[] }).extensions.filter((x) => typeof x === 'string') as string[]) : [];
    const owned = [...new Set([ext, ...extra].filter((x) => /^[a-z0-9]{1,10}$/i.test(x)).map((x) => x.toLowerCase()))];
    const description = String(opts?.description ?? ext.toUpperCase()).slice(0, 60);
    let defaultPath = join(app.getPath('documents'), name);
    for (;;) {
      const res = await dialog.showSaveDialog(mainWindow!, { defaultPath, filters: [{ name: description, extensions: owned }] });
      if (res.canceled || !res.filePath) return null;
      const typed = extname(res.filePath).slice(1).toLowerCase();
      if (owned.includes(typed)) {
        await writeFile(res.filePath, toBytes(data));
        addRecent(res.filePath);
        return { name: basename(res.filePath), token: grant(res.filePath) };
      }
      // "budget.mp4" for a workbook: say why not, and ask again with the right extension
      await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        title: 'Save As',
        message: `This file is being saved as ${description}, so its name has to end in .${ext}.`,
        detail: `"${basename(res.filePath)}" ends in ${typed ? `.${typed}` : 'no extension'}. To save in another format, cancel and pick the format under Save As / Convert.`,
      });
      defaultPath = join(dirname(res.filePath), `${basename(res.filePath, extname(res.filePath))}.${ext}`);
    }
  });

  // a file dropped on the window (path resolved by the preload from the real File object)
  ipcMain.handle('open-dropped', async (e, path: unknown) => {
    assertSender(e);
    if (typeof path !== 'string' || !path) return null;
    const full = resolve(path);
    if (!isOpenable(full)) return null;
    return readGranted(full);
  });

  // ── folders: the renderer names a folder id and a relative path, never a real one ──
  ipcMain.handle('folder-pick', async (e) => {
    assertSender(e);
    const res = await dialog.showOpenDialog(mainWindow!, { title: 'Open Folder', properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths[0]) return null;
    const root = await realpath(res.filePaths[0]);
    for (const [id, p] of folderRoots) if (p === root) return { id, name: basename(root) || root };
    const id = randomUUID();
    folderRoots.set(id, root);
    return { id, name: basename(root) || root };
  });

  ipcMain.handle('folder-list', async (e, id: unknown, rel: unknown) => {
    assertSender(e);
    const dir = await pathInside(folderRoot(id), rel);
    const entries = await readdir(dir, { withFileTypes: true });
    const out: { name: string; kind: 'file' | 'dir' }[] = [];
    for (const d of entries) {
      let kind: 'file' | 'dir' | null = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : null;
      if (d.isSymbolicLink()) {
        // shown as what it points at; opening it is refused if that is outside the folder
        kind = await stat(join(dir, d.name)).then((s) => (s.isDirectory() ? 'dir' : s.isFile() ? 'file' : null), () => null);
      }
      if (kind) out.push({ name: d.name, kind });
    }
    return out;
  });

  ipcMain.handle('folder-open', async (e, id: unknown, rel: unknown) => {
    assertSender(e);
    return readGranted(await pathInside(folderRoot(id), rel));
  });

  ipcMain.handle('folder-read', async (e, id: unknown, rel: unknown) => {
    assertSender(e);
    return peek(await pathInside(folderRoot(id), rel));
  });

  ipcMain.handle('folder-create-file', async (e, id: unknown, rel: unknown, data: unknown) => {
    assertSender(e);
    const path = await pathInside(folderRoot(id), rel);
    if (!isSafeName(basename(path))) throw new Error('That name cannot be used.');
    // wx: never overwrite something that is already there
    await writeFile(path, toBytes(data), { flag: 'wx' }).catch((err) => {
      throw (err as NodeJS.ErrnoException).code === 'EEXIST' ? new Error(`${basename(path)} already exists.`) : err;
    });
  });

  ipcMain.handle('folder-create-dir', async (e, id: unknown, rel: unknown) => {
    assertSender(e);
    const path = await pathInside(folderRoot(id), rel);
    if (!isSafeName(basename(path))) throw new Error('That name cannot be used.');
    await mkdir(path).catch((err) => {
      throw (err as NodeJS.ErrnoException).code === 'EEXIST' ? new Error(`${basename(path)} already exists.`) : err;
    });
  });

  ipcMain.handle('folder-rename', async (e, id: unknown, rel: unknown, newName: unknown) => {
    assertSender(e);
    const root = folderRoot(id);
    const from = await pathInside(root, rel);
    if (from === root || typeof newName !== 'string' || !isSafeName(newName)) throw new Error('That name cannot be used.');
    const to = join(dirname(from), newName);
    const taken = await stat(to).then(() => true, () => false);
    // on a case-insensitive disk "readme.md" → "README.md" finds itself
    if (taken && from.toLowerCase() !== to.toLowerCase()) throw new Error(`${newName} already exists.`);
    await rename(from, to);
    // a file that is open keeps saving to where it now is
    for (const [token, p] of grants) {
      if (p === from) grants.set(token, to);
      else if (p.startsWith(from + sep)) grants.set(token, to + p.slice(from.length));
    }
    return relative(root, to).split(sep).join('/');
  });

  ipcMain.handle('folder-remove', async (e, id: unknown, rel: unknown) => {
    assertSender(e);
    const root = folderRoot(id);
    const path = await pathInside(root, rel);
    if (path === root) throw new Error('The opened folder itself cannot be deleted from here.');
    // the recycle bin / Trash, so a slip can be undone
    await shell.trashItem(path);
  });

  // a page opened on its own: its preview may read the files beside it (same directory or below)
  ipcMain.handle('sibling-read', async (e, token: unknown, rel: unknown) => {
    assertSender(e);
    const path = grants.get(String(token));
    if (!path) return null;
    try {
      return await peek(await pathInside(await realpath(dirname(path)), rel));
    } catch {
      return null;
    }
  });

  // ── web preview: the renderer hands over a bundled page and gets the URL it is served at ──
  ipcMain.handle('preview-set', (e, id: unknown, html: unknown) => {
    assertSender(e);
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id) || typeof html !== 'string' || html.length > MAX_PREVIEW_CHARS) throw new Error('Invalid preview.');
    previews.delete(id);
    previews.set(id, html);
    while (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value!);
    return `${PREVIEW_ORIGIN}/${id}`;
  });

  ipcMain.on('preview-clear', (e, id: unknown) => {
    try {
      assertSender(e);
      previews.delete(String(id));
    } catch {
      /* ignore */
    }
  });

  ipcMain.handle('recent-list', (e) => {
    assertSender(e);
    return recentList();
  });

  ipcMain.handle('recent-open', async (e, id: unknown) => {
    assertSender(e);
    const r = recents.find((x) => x.id === id);
    if (!r) throw new Error('That file is no longer in the recent list.');
    try {
      return await readGranted(r.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        removeRecent(r.path);
        throw new Error(`${basename(r.path)} no longer exists (it was moved, renamed or deleted).`);
      }
      throw err;
    }
  });

  ipcMain.handle('recent-clear', (e) => {
    assertSender(e);
    clearRecents();
  });

  ipcMain.handle('recent-remove', (e, id: unknown) => {
    assertSender(e);
    const r = recents.find((x) => x.id === id);
    if (r) removeRecent(r.path);
  });

  ipcMain.on('set-autosave', (e, value: unknown) => {
    try {
      assertSender(e);
      if (autoSave !== !!value) {
        autoSave = !!value;
        buildMenu();
      }
    } catch {
      /* ignore */
    }
  });

  // license: activation talks to the license server from this process only (see license.ts)
  ipcMain.handle('license-get', async (e) => {
    assertSender(e);
    // Force a server check when the dialog opens so a refund/revoke is reflected immediately.
    await refreshLicenseStatus(true).catch(() => undefined);
    void refreshLicenseMenu();
    return getLicenseState();
  });

  ipcMain.handle('license-activate', async (e, key: unknown) => {
    assertSender(e);
    const res = await activateLicense(typeof key === 'string' ? key.slice(0, 100) : '');
    void refreshLicenseMenu();
    return res;
  });

  ipcMain.on('set-dirty', (e, value: boolean) => {
    try {
      assertSender(e);
      dirty = !!value;
      mainWindow?.setDocumentEdited?.(dirty);
    } catch {
      /* ignore */
    }
  });

  ipcMain.on('set-title', (e, title: string) => {
    try {
      assertSender(e);
      titleBase = String(title).slice(0, 200);
      applyWindowTitle();
    } catch {
      /* ignore */
    }
  });
}

// ── auto-update ────────────────────────────────────────────────────────────
/**
 * Checks GitHub Releases (build.publish in package.json) at launch and every few hours. A newer
 * version downloads in the background; electron-updater verifies the download's SHA-512 against
 * the release's latest.yml and, on Windows, its code signature against the running app's
 * publisher before installing. When it is ready the app shows "Restart to update"; otherwise it
 * installs silently the next time the app quits.
 */
const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;
const UPDATE_LOG_MAX_BYTES = 512 * 1024;

type UpdateState = 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error';
interface UpdateStatus {
  state: UpdateState;
  /** the new version (or, for 'none', the installed one) */
  version?: string;
  percent?: number;
  /** bytes per second while downloading */
  speed?: number;
  message?: string;
  /** true when the user asked (Help → Check for Updates), so the window reports every outcome */
  manual?: boolean;
}

type Updater = import('electron-updater').AppUpdater;
let updater: Updater | null = null;
let updaterLoadError: string | null = null;
let updateStatus: UpdateStatus | null = null;
/** the current check was started from the menu */
let manualCheck = false;

function updateLogPath() {
  return join(app.getPath('userData'), 'logs', 'updater.log');
}

/** Appends to <userData>/logs/updater.log (restarted when it grows past UPDATE_LOG_MAX_BYTES). */
function logUpdate(level: string, ...args: unknown[]) {
  const text = args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${text}\n`;
  void (async () => {
    try {
      const file = updateLogPath();
      await mkdir(dirname(file), { recursive: true });
      const size = await stat(file).then((s) => s.size, () => 0);
      if (size > UPDATE_LOG_MAX_BYTES) await writeFile(file, line);
      else await appendFile(file, line);
    } catch {
      /* logging must never break updates */
    }
  })();
}

function setUpdateStatus(status: UpdateStatus) {
  updateStatus = status;
  mainWindow?.webContents.send('update-status', status);
}

/** First line of an error, without electron-updater's long HTTP dumps. */
function updateErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  const first = raw.split('\n')[0].trim();
  if (/ENOTFOUND|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ENETUNREACH/i.test(raw)) return 'No internet connection.';
  return first.length > 240 ? `${first.slice(0, 240)}…` : first;
}

/**
 * electron-updater is CommonJS and defines `autoUpdater` as a lazy getter, which Node's ESM
 * interop cannot see as a named export: `(await import('electron-updater')).autoUpdater` is
 * undefined in the packaged app (that silently disabled updates in 0.1.1). Read it from the
 * module itself (`default`) when the named export is missing.
 */
async function loadUpdater(): Promise<Updater> {
  const mod = (await import('electron-updater')) as typeof import('electron-updater') & { default?: typeof import('electron-updater') };
  const u = mod.autoUpdater ?? mod.default?.autoUpdater;
  if (!u) throw new Error('electron-updater did not export autoUpdater');
  return u;
}

async function startAutoUpdates() {
  try {
    updater = await loadUpdater();
  } catch (err) {
    updaterLoadError = updateErrorText(err);
    logUpdate('error', 'Could not load the updater:', err);
    return;
  }
  const u = updater;
  u.logger = {
    info: (...a: unknown[]) => logUpdate('info', ...a),
    warn: (...a: unknown[]) => logUpdate('warn', ...a),
    error: (...a: unknown[]) => logUpdate('error', ...a),
    debug: () => undefined,
  };
  u.autoDownload = true;
  u.autoInstallOnAppQuit = true;
  u.allowPrerelease = false;
  logUpdate('info', `File Editor ${app.getVersion()} started (${process.platform}-${process.arch})`);
  u.on('checking-for-update', () => setUpdateStatus({ state: 'checking', manual: manualCheck }));
  u.on('update-not-available', () => {
    setUpdateStatus({ state: 'none', version: app.getVersion(), manual: manualCheck });
    manualCheck = false;
  });
  u.on('update-available', (info) => setUpdateStatus({ state: 'available', version: info.version, percent: 0, manual: manualCheck }));
  u.on('download-progress', (p) =>
    setUpdateStatus({
      state: 'downloading',
      version: updateStatus?.version,
      percent: Math.max(0, Math.min(100, Math.round(p.percent))),
      speed: p.bytesPerSecond,
      manual: manualCheck,
    }),
  );
  u.on('update-downloaded', (info) => {
    setUpdateStatus({ state: 'ready', version: info.version, manual: manualCheck });
    manualCheck = false;
  });
  u.on('error', (err) => {
    setUpdateStatus({ state: 'error', message: updateErrorText(err), manual: manualCheck });
    manualCheck = false;
  });
  void checkForUpdates(false);
  setInterval(() => void checkForUpdates(false), UPDATE_INTERVAL_MS);
}

/** Help → Check for Updates (manual) and the periodic background check. */
async function checkForUpdates(manual: boolean) {
  // Same cadence as updates: re-check activated licenses so a refund/revoke lands here.
  void checkLicenseInBackground();

  if (manual && !app.isPackaged) {
    void dialog.showMessageBox({ type: 'info', title: 'Check for Updates', message: 'Updates are only checked in the installed app.', detail: `This is a development build (${app.getVersion()}).` });
    return;
  }
  if (!updater) {
    if (manual) setUpdateStatus({ state: 'error', message: updaterLoadError ?? 'The updater is still starting. Try again in a moment.', manual: true });
    return;
  }
  const busy = updateStatus?.state === 'checking' || updateStatus?.state === 'available' || updateStatus?.state === 'downloading';
  if (busy || updateStatus?.state === 'ready') {
    // already under way (or downloaded): show where it is instead of starting another check
    if (manual) {
      manualCheck = manualCheck || busy;
      setUpdateStatus({ ...updateStatus!, manual: true });
    }
    return;
  }
  manualCheck = manual;
  try {
    const result = await updater.checkForUpdates();
    // null means updates are disabled for this build (no app-update.yml)
    if (!result && manual) setUpdateStatus({ state: 'error', message: 'This copy of the app is not set up to receive updates.', manual: true });
  } catch (err) {
    // the 'error' event has already reported it; this only stops an unhandled rejection
    logUpdate('error', 'Update check failed:', err);
  }
}

function registerUpdateIpc() {
  ipcMain.handle('update-status-get', (e) => {
    assertSender(e);
    return updateStatus;
  });
  ipcMain.on('update-check', (e) => {
    try {
      assertSender(e);
    } catch {
      return;
    }
    void checkForUpdates(true);
  });
  ipcMain.on('install-update', (e) => {
    try {
      assertSender(e);
    } catch {
      return;
    }
    if (!updater || updateStatus?.state !== 'ready') return;
    dirty = false; // the renderer already confirmed unsaved changes
    logUpdate('info', `Installing ${updateStatus.version} now`);
    // isSilent=false shows the installer's progress on Windows; isForceRunAfter relaunches the app
    updater.quitAndInstall(false, true);
  });
}

// ── startup ────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // deny every permission prompt (camera, mic, notifications, geolocation…) — none are needed
  // Local fonts are the one exception: Vector Studio reads an installed font's outlines to convert text to paths.
  const isAppOrigin = (url: string) => (DEV_URL ? url.startsWith(DEV_URL) : url.startsWith(APP_ORIGIN + '/'));
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb((perm as string) === 'local-fonts' && isAppOrigin(wc.getURL())));
  session.defaultSession.setPermissionCheckHandler((_wc, perm, origin) => (perm as string) === 'local-fonts' && isAppOrigin(origin + '/'));
  // never fetch anything from the network except the dev server
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url;
    // file: is only allowed for the bundled app files the app:// handler reads
    // a previewed page loads only as a sub-frame of the app (never as the window itself)
    const preview = u.startsWith(PREVIEW_ORIGIN + '/') && details.resourceType === 'subFrame';
    const ok = preview || u.startsWith(APP_ORIGIN) || u.startsWith(APP_ROOT_URL) || u.startsWith('blob:') || u.startsWith('data:') || u.startsWith('devtools:') || (DEV_URL ? u.startsWith(DEV_URL) || u.startsWith(DEV_URL.replace('http', 'ws')) : false);
    cb({ cancel: !ok });
  });

  registerAppProtocol();
  registerPreviewProtocol();
  registerIpc();
  registerUpdateIpc();
  await loadRecents();
  buildMenu();
  pendingOpen.push(...filesFromArgv(process.argv));
  createWindow();

  // Local license file → Help menu / window title immediately; server check-ins ride with update checks.
  void refreshLicenseMenu();
  if (app.isPackaged) void startAutoUpdates();
  else setTimeout(() => void checkLicenseInBackground(), 15_000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
});
