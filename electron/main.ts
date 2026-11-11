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
 *  - App files are served from the custom app:// protocol with traversal checks and a strict
 *    CSP. Navigation away from the app and new windows are blocked; external links open in
 *    the default browser.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell, type MenuItemConstructorOptions } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const APP_SCHEME = 'app';
const APP_HOST = 'editor';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const MAX_FILE_BYTES = 250 * 1024 * 1024;
/** Video can be much larger than a document. */
const MAX_MEDIA_BYTES = 4 * 1024 * 1024 * 1024;
const DOCUMENTS = ['docx', 'docm', 'dotx', 'doc', 'dot', 'pdf', 'odt', 'rtf', 'md', 'markdown', 'html', 'htm', 'txt'];
const IMAGES = ['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'avif', 'heic', 'heif', 'jxl', 'bmp', 'tif', 'tiff', 'ico', 'svg'];
const MEDIA = [
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'asf', 'flv', 'mpg', 'mpeg', 'vob', '3gp', '3g2', 'ogv', 'ts', 'mts', 'm2ts',
  'mp3', 'm4a', 'wav', 'flac', 'ogg', 'oga', 'opus', 'aac', 'wma', 'aiff', 'aif', 'amr',
];
const OPENABLE = [...DOCUMENTS, ...IMAGES, ...MEDIA];

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let mainWindow: BrowserWindow | null = null;
let dirty = false;
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
  const isMedia = MEDIA.includes(extname(path).slice(1).toLowerCase());
  const limit = isMedia ? MAX_MEDIA_BYTES : MAX_FILE_BYTES;
  if (info.size > limit) throw new Error(`This file is too large to open (limit ${isMedia ? '4 GB' : '250 MB'}).`);
  const bytes = new Uint8Array(await readFile(path));
  return { name: basename(path), bytes, token: grant(path) };
}

// ── single instance + OS "open with" ───────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function filesFromArgv(argv: string[]): string[] {
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((a) => !a.startsWith('-') && OPENABLE.includes(extname(a).slice(1).toLowerCase()))
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
    dialog.showErrorBox('Could not open file', `${path}\n\n${(err as Error).message}`);
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
    title: 'File Editor',
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
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Save As / Convert…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-as') },
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
        {
          label: 'About File Editor',
          click: () =>
            void dialog.showMessageBox({
              type: 'info',
              title: 'About',
              message: `File Editor ${app.getVersion()}`,
              detail: 'Documents are processed locally on this computer and are never uploaded.',
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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

  ipcMain.handle('save-file-as', async (e, opts: { suggestedName?: string; ext?: string; description?: string }, data: unknown) => {
    assertSender(e);
    const ext = /^[a-z0-9]{1,10}$/i.test(opts?.ext ?? '') ? opts.ext! : 'bin';
    const name = basename(String(opts?.suggestedName ?? `Document.${ext}`)).replace(/[<>:"|?*\u0000-\u001f]/g, '_');
    const res = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: join(app.getPath('documents'), name),
      filters: [{ name: String(opts?.description ?? ext.toUpperCase()).slice(0, 60), extensions: [ext] }],
    });
    if (res.canceled || !res.filePath) return null;
    await writeFile(res.filePath, toBytes(data));
    return { name: basename(res.filePath), token: grant(res.filePath) };
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
      mainWindow?.setTitle(String(title).slice(0, 200));
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

function sendUpdateStatus(status: { state: 'available' | 'downloading' | 'ready' | 'error'; version?: string; percent?: number }) {
  mainWindow?.webContents.send('update-status', status);
}

async function startAutoUpdates() {
  let updater: typeof import('electron-updater').autoUpdater;
  try {
    ({ autoUpdater: updater } = await import('electron-updater'));
  } catch {
    return; // updater not bundled
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.on('update-available', (info) => sendUpdateStatus({ state: 'available', version: info.version }));
  updater.on('download-progress', (p) => sendUpdateStatus({ state: 'downloading', percent: Math.round(p.percent) }));
  updater.on('update-downloaded', (info) => sendUpdateStatus({ state: 'ready', version: info.version }));
  updater.on('error', () => sendUpdateStatus({ state: 'error' }));
  ipcMain.on('install-update', (e) => {
    try {
      assertSender(e);
    } catch {
      return;
    }
    dirty = false; // the renderer already confirmed unsaved changes
    // isSilent=false shows the installer's progress on Windows; isForceRunAfter relaunches the app
    updater.quitAndInstall(false, true);
  });
  const check = () => updater.checkForUpdates().catch(() => undefined);
  void check();
  setInterval(check, UPDATE_INTERVAL_MS);
}

// ── startup ────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // deny every permission prompt (camera, mic, notifications, geolocation…) — none are needed
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // never fetch anything from the network except the dev server
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url;
    // file: is only allowed for the bundled app files the app:// handler reads
    const ok = u.startsWith(APP_ORIGIN) || u.startsWith(APP_ROOT_URL) || u.startsWith('blob:') || u.startsWith('data:') || u.startsWith('devtools:') || (DEV_URL ? u.startsWith(DEV_URL) || u.startsWith(DEV_URL.replace('http', 'ws')) : false);
    cb({ cancel: !ok });
  });

  registerAppProtocol();
  registerIpc();
  buildMenu();
  pendingOpen.push(...filesFromArgv(process.argv));
  createWindow();

  if (app.isPackaged) void startAutoUpdates();

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
