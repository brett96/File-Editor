import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TabActiveContext } from './ui/tab-active';
import {
  Database,
  FileCode,
  Plus,
  X,
  FileDown,
  FilePlus,
  Film,
  Image as ImageIcon,
  FileText,
  FolderOpen,
  Sheet as SheetIcon,
  Lock,
  LockOpen,
  Printer,
  Save,
  ShieldCheck,
  Upload,
  RefreshCw,
  Download,
  AlertTriangle,
  History,
  CircleHelp,
  BookOpen,
  Wand2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { baseName, exportFlow, FORMATS, OPEN_EXTENSIONS, openDocument, type OpenResult } from './core/registry';
import { buildPdf } from './core/pdf/apply-edits';
import type { PdfProtection } from './core/pdf/types';
import { PasswordError, UnsupportedError, isCodeFormat, type CodeLanguage, type DocFormat, type FlowFormat, type RichDocument } from './core/types';
import { escapeHtml, utf8Encode } from './core/dom';
import { fileBytes, getHost, readDroppedFile, type OpenedFile, type RecentEntry, type UpdateStatus } from './platform/host';
import {
  LICENSE_PURCHASE_URL,
  detectDesktopOs,
  fetchLatestInstallers,
  installersForOs,
  startInstallerDownload,
  type InstallerOption,
} from './platform/desktop-download';
import { IconButton, Divider, Modal, cx, Popover, MenuItem } from './ui/components';
import {
  EMPTY_PROTECTION,
  ExportModal,
  PasswordModal,
  SecurityModal,
  protectionFromPdf,
  protectionToPdf,
  type ExportChoice,
  type ProtectionDraft,
} from './ui/dialogs';
import { RichEditor, type RichEditorHandle } from './ui/rich/RichEditor';
import { LicenseDialog } from './ui/license/LicenseDialog';
import { PdfEditor, type PdfEditorHandle } from './ui/pdf/PdfEditor';
import { ImageEditor, type ImageEditorHandle } from './ui/image/ImageEditor';
import type { ProImageEditorHandle } from './ui/pro-image/ProImageEditor';
import type { ProDocument } from './core/pro-image/document';
import type { StudioHandle } from './ui/studio/StudioEditor';
import type { StudioExportChoice } from './ui/studio/StudioExport';
import type { Project as StudioProject } from './core/studio/model';
import { VideoEditor, formatTime, rotatedSize, type VideoEditorHandle } from './ui/video/VideoEditor';
import { CodeEditor, type CodeEditorHandle } from './ui/code/CodeEditor';
import { ImageExportModal, MediaExportModal, ProgressModal, type ImageExportChoice, type MediaExportChoice } from './ui/media-dialogs';
import { CONTAINERS, IMAGE_FORMATS, MEDIA_EXTENSIONS_ALL, IMAGE_EXTENSIONS_ALL, sniffMedia, type ContainerFormat, type ImageFormat } from './core/media/media-formats';
import type { DecodedImage } from './core/media/image-codecs';
import type { MediaInfo } from './core/media/video-engine';
import { createPixels, type Pixels } from './core/media/image-ops';
import { SHEET_EXTENSIONS, SHEET_FORMATS, blankWorkbook, sheetFormatFromName, usedRange, type IWorkbookData, type SheetFormat } from './core/sheet/workbook';
import { SheetEditor, type SheetEditorHandle } from './ui/sheet/SheetEditor';
import { SheetExportModal, SheetHeadersModal, SheetSecurityModal, type SheetExportChoice } from './ui/sheet/sheet-dialogs';
import { columnsFromRow, type SheetTablePlan } from './core/sheet/to-database';
import { DB_EXTENSIONS, dbFormatFromName, isSqliteFile, type DbFormat, type SqliteDatabase } from './core/db/sqlite';
import { DbEditor, type DbEditorHandle } from './ui/db/DbEditor';

// Pro editors are desktop-only and loaded on demand, so the web build never downloads them.
const ProImageEditor = lazy(() => import('./ui/pro-image/ProImageEditor').then((m) => ({ default: m.ProImageEditor })));
// the user guide is loaded the first time it is opened
const HelpGuide = lazy(() => import('./ui/help/HelpGuide'));

/** The guide page F1 opens for each kind of file. */
const GUIDE_FOR_KIND: Record<string, string> = {
  flow: 'documents',
  code: 'documents',
  pdf: 'pdf',
  sheet: 'spreadsheets',
  database: 'databases',
  image: 'photo-quick',
  proimage: 'photo-pro',
  media: 'video-quick',
  studio: 'studio',
};

/** `#help` or `#help/<section>` in the address opens the guide (shareable links). */
function helpFromHash(): { section: string | null } | null {
  try {
    const m = /^#help(?:\/([\w-]+))?$/.exec(location.hash);
    return m ? { section: m[1] ?? null } : null;
  } catch {
    return null;
  }
}

const StudioEditor = lazy(() => import('./ui/studio/StudioEditor').then((m) => ({ default: m.StudioEditor })));
const StudioExportModal = lazy(() => import('./ui/studio/StudioExport').then((m) => ({ default: m.StudioExportModal })));

const ALL_OPEN_EXTENSIONS = [...new Set([...OPEN_EXTENSIONS, ...SHEET_EXTENSIONS, ...DB_EXTENSIONS, ...IMAGE_EXTENSIONS_ALL, ...MEDIA_EXTENSIONS_ALL])];

type MediaDoc = { kind: 'media'; key: number; name: string; blob: Blob; info: MediaInfo; container: ContainerFormat; handle?: unknown; protection: ProtectionDraft };

type OpenDoc =
  | { kind: 'flow'; key: number; name: string; format: FlowFormat; initial: RichDocument; handle?: unknown; protection: ProtectionDraft }
  | { kind: 'code'; key: number; name: string; format: CodeLanguage; language: CodeLanguage; text: string; handle?: unknown; protection: ProtectionDraft }
  | { kind: 'pdf'; key: number; name: string; bytes: Uint8Array; handle?: unknown; protection: ProtectionDraft }
  | { kind: 'image'; key: number; name: string; decoded: DecodedImage; format: ImageFormat; handle?: unknown; protection: ProtectionDraft }
  /** desktop pro photo editor: a layered document (format: what Save writes without asking) */
  | { kind: 'proimage'; key: number; name: string; doc: ProDocument; format: ImageFormat | 'psd'; handle?: unknown; protection: ProtectionDraft }
  | MediaDoc
  /** origin: the file Studio was opened from (null for a .fstudio project); handle: the project file */
  | { kind: 'studio'; key: number; name: string; project: StudioProject; blobs: Map<string, Blob>; origin: MediaDoc | null; protection: ProtectionDraft; handle?: unknown }
  | { kind: 'sheet'; key: number; name: string; format: SheetFormat; workbook: IWorkbookData; /** too big to re-save after every edit */ large?: boolean; handle?: unknown; protection: ProtectionDraft }
  | { kind: 'database'; key: number; name: string; format: DbFormat; db: SqliteDatabase; /** too big to re-save after every edit */ large?: boolean; handle?: unknown; protection: ProtectionDraft };

const PRIMARY_SWITCH: Array<DocFormat | 'image'> = ['docx', 'txt', 'html', 'css', 'js', 'pdf', 'image'];
const SECONDARY_SWITCH: FlowFormat[] = ['odt', 'rtf', 'md', 'doc'];
const SHEET_SWITCH: SheetFormat[] = ['xlsx', 'csv', 'tsv'];
type SwitchTarget = DocFormat | 'image' | SheetFormat;
const isSheetFormat = (t: SwitchTarget): t is SheetFormat => (SHEET_SWITCH as string[]).includes(t);

async function codeToRich(language: CodeLanguage, text: string): Promise<RichDocument> {
  if (language === 'html') {
    const { importHtml } = await import('./core/formats/html');
    return importHtml(utf8Encode(text));
  }
  // Keep source intact as plain paragraphs (txt / Word) or a code block for other rich formats
  const { importText } = await import('./core/formats/text');
  return importText(utf8Encode(text));
}

function blankCanvasImage(): DecodedImage {
  const pixels = createPixels(800, 600);
  pixels.data.fill(255);
  return { pixels, format: 'png', warnings: [] };
}

/** Workbooks with more filled cells than this are saved on demand rather than after every edit. */
const LARGE_SHEET_CELLS = 400_000;
const LARGE_DB_BYTES = 48 * 1024 * 1024;

interface Progress {
  title: string;
  phase: string;
  progress: number;
  cancel?: () => void;
}

/** Best output container for a media file we opened (by its extension). */
function containerFor(name: string, hasVideo: boolean): ContainerFormat {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const hit = (Object.keys(CONTAINERS) as ContainerFormat[]).find((c) => c !== 'gif' && CONTAINERS[c].extensions.includes(ext));
  if (hit && (CONTAINERS[hit].kind === 'video') === hasVideo) return hit;
  return hasVideo ? 'mp4' : 'mp3';
}

interface PasswordAsk {
  fileName: string;
  message: string;
  incorrect: boolean;
  resolve: (pw: string | null) => void;
}

interface Toast {
  id: number;
  kind: 'error' | 'info';
  text: string;
}

const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/**
 * Zoom at which the widest page fills the editor's scroll area. Pages are measured from the
 * DOM (PDF pages and the document sheet both size themselves in CSS px at the current zoom).
 */
function fitWidthZoom(current: number, root: ParentNode | null): number {
  const ws = (root ?? document).querySelector<HTMLElement>('.editor-root .workspace');
  if (!ws) return 1;
  const cs = getComputedStyle(ws);
  const avail = ws.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  let base = 816; // a Letter page at 100 %
  const pdfPage = ws.querySelector<HTMLElement>('.pdf-page');
  const sheet = ws.querySelector<HTMLElement>('.page-sheet');
  if (pdfPage) base = pdfPage.offsetWidth / current;
  else if (sheet) base = parseFloat(sheet.style.width) || base; // its width is unzoomed (CSS zoom)
  return Math.max(0.1, Math.min(4, Math.floor((avail / base) * 100) / 100));
}
let docKey = 1;

const BLANK: RichDocument = { html: '<p></p>', title: 'Untitled' };

/** "1.4 MB/s" for the update download. */
function formatSpeed(bytesPerSecond: number): string {
  const mb = bytesPerSecond / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
}

/** Resolves after the browser has painted pending UI (e.g. a busy indicator). */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  // workers (ffmpeg.wasm) reject with plain strings
  if (typeof err === 'string' && err.trim()) return err;
  return 'Something went wrong.';
}

// ── tabs ─────────────────────────────────────────────────────────────────
/** What a new tab starts with. */
type TabStart = { kind: 'open'; file: OpenedFile } | { kind: 'new' } | { kind: 'new-sheet' };

/** What the tab bar and window title show for a tab. */
interface TabInfo {
  name: string;
  dirty: boolean;
  locked: boolean;
  kind: OpenDoc['kind'] | null;
}

/** Commands the app shell (menus, shortcuts) sends to the active tab. */
interface TabApi {
  save(): Promise<void>;
  saveAs(): void;
  print(): Promise<void>;
  protect(): void;
  /** stops playback etc. when the tab goes to the background */
  pause(): void;
}

interface TabProps {
  id: number;
  active: boolean;
  start: TabStart;
  toast: (text: string, kind?: Toast['kind']) => void;
  autoSave: boolean;
  onToggleAutoSave: () => void;
  /** where the active tab puts its toolbar buttons (Save, Print, zoom…) in the top bar */
  actionsSlot: HTMLElement | null;
  onInfo: (id: number, info: TabInfo) => void;
  /** the file couldn't be opened (or the password prompt was cancelled): close this tab */
  onEmpty: (id: number) => void;
  register: (id: number, api: TabApi | null) => void;
}

/**
 * One open file: its editor, status bar, save logic and dialogs. Every tab stays mounted while
 * it is open (inactive tabs are hidden), so switching tabs keeps undo history, selection and
 * scroll position.
 */
function DocumentTab({ id: tabId, active, start, toast, autoSave, onToggleAutoSave, actionsSlot, onInfo, onEmpty, register }: TabProps) {
  const host = getHost();
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [dirty, setDirty] = useState(false);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const [busy, setBusy] = useState<string | null>(null);
  const [askPw, setAskPw] = useState<PasswordAsk | null>(null);
  const [exportOpen, setExportOpen] = useState<null | 'save-as' | 'export'>(null);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [stats, setStats] = useState<{ words: number; characters: number } | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [frameExport, setFrameExport] = useState<{ pixels: Pixels; name: string } | null>(null);
  const [imageStatus, setImageStatus] = useState<{ width: number; height: number } | null>(null);
  const richRef = useRef<RichEditorHandle>(null);
  const codeRef = useRef<CodeEditorHandle>(null);
  const pdfRef = useRef<PdfEditorHandle>(null);
  const imageRef = useRef<ImageEditorHandle>(null);
  const proImageRef = useRef<ProImageEditorHandle>(null);
  const videoRef = useRef<VideoEditorHandle>(null);
  const studioRef = useRef<StudioHandle>(null);
  const sheetRef = useRef<SheetEditorHandle>(null);
  const dbRef = useRef<DbEditorHandle>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const activeRef = useRef(active);
  activeRef.current = active;
  const paneRef = useRef<HTMLDivElement>(null);

  // On phone-sized screens, open PDFs and documents at "fit width" instead of 100 % (a Letter
  // page is 816 px wide, about twice a phone). PDF pages appear asynchronously, so wait for one.
  const docKind = doc?.kind;
  const docKeyValue = doc?.key;
  useEffect(() => {
    if ((docKind !== 'pdf' && docKind !== 'flow') || window.innerWidth >= 900 || !activeRef.current) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      const ready = paneRef.current?.querySelector(docKind === 'pdf' ? '.editor-root .pdf-page' : '.editor-root .page-sheet');
      if (ready || tries > 40) {
        clearInterval(timer);
        if (ready) setZoom(fitWidthZoom(zoomRef.current, paneRef.current));
      }
    }, 100);
    return () => clearInterval(timer);
  }, [docKind, docKeyValue]);

  /** bumps on every change; a save only marks the file clean if nothing changed meanwhile */
  const editSeq = useRef(0);
  const autoSaveKick = useRef<() => void>(() => undefined);
  const markDirty = useCallback(() => {
    editSeq.current++;
    setDirty(true);
    autoSaveKick.current();
  }, []);
  const markClean = (seq: number) => {
    if (editSeq.current === seq) setDirty(false);
  };

  // ── report name / unsaved state to the tab bar and window title ──────────
  const docName = doc?.name ?? '';
  const docLocked = !!doc?.protection.enabled;
  useEffect(() => {
    // while the file is still opening, the tab keeps the name it was created with
    if (!docName) return;
    onInfo(tabId, { name: docName, dirty, locked: docLocked, kind: docKind ?? null });
  }, [onInfo, tabId, docName, dirty, docLocked, docKind]);

  // a tab sent to the background stops playing (Studio, the video editor, previews)
  useEffect(() => {
    if (active) return;
    studioRef.current?.stop();
    paneRef.current?.querySelectorAll('video, audio').forEach((m) => (m as HTMLMediaElement).pause());
  }, [active]);

  // ── open what the tab was created for (once; StrictMode runs effects twice) ──
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      if (start.kind === 'new') return newDocument();
      if (start.kind === 'new-sheet') return newSpreadsheet();
      await openFile(start.file);
      // let React apply the opened document before looking for it
      await new Promise((r) => setTimeout(r, 0));
      // the file couldn't be opened (an error was shown) or the password prompt was cancelled
      if (!docRef.current) onEmpty(tabId);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── passwords ────────────────────────────────────────────────────────────
  const requestPassword = (fileName: string, message: string, incorrect: boolean) =>
    new Promise<string | null>((resolve) => setAskPw({ fileName, message, incorrect, resolve }));

  /** Opens a file, prompting for a password as many times as needed. Returns null if cancelled. */
  const openWithPrompt = async (file: OpenedFile): Promise<{ result: OpenResult; password?: string } | null> => {
    let password: string | undefined;
    let incorrect = false;
    let message = '';
    for (;;) {
      try {
        setBusy(`Opening ${file.name}…`);
        const result = await openDocument(file.name, await fileBytes(file), password);
        return { result, password };
      } catch (err) {
        if (!(err instanceof PasswordError)) throw err;
        if (err.code === 'password-required') message = err.message;
        incorrect = err.code === 'password-incorrect';
        setBusy(null);
        const pw = await requestPassword(file.name, message || 'This document is password protected.', incorrect);
        if (pw === null) return null;
        password = pw;
      } finally {
        setBusy(null);
      }
    }
  };

  /** Opens photos, video and audio. Returns false when the file is not media. */
  const openMedia = async (file: OpenedFile): Promise<boolean> => {
    const head = new Uint8Array(await file.blob.slice(0, 4096).arrayBuffer());
    const kind = sniffMedia(file.name, head);
    if (!kind) return false;
    if (kind.kind === 'image') {
      setBusy(`Opening ${file.name}…`);
      try {
        const { decodeImage } = await import('./core/media/image-codecs');
        const decoded = await decodeImage(file.blob, file.name);
        const writable = IMAGE_FORMATS[decoded.format].canWrite;
        setDoc({ kind: 'image', key: docKey++, name: file.name, decoded, format: decoded.format, handle: writable ? file.handle : undefined, protection: EMPTY_PROTECTION });
        setImageStatus(null);
        setDirty(false);
      } finally {
        setBusy(null);
      }
      return true;
    }
    const { probeMedia } = await import('./core/media/video-engine');
    let blob: Blob = file.blob;
    let name = file.name;
    let handle = file.handle;
    if (handle !== undefined && host.kind === 'web') {
      // Saving in place rewrites the file this Blob reads from (lazily), which would break
      // playback and later saves; keep the editing copy in memory. Very large files are
      // edited from disk and saved with Save as instead.
      if (blob.size <= 1024 * 1024 * 1024) blob = new Blob([await blob.arrayBuffer()], { type: blob.type });
      else handle = undefined;
    }
    let info: MediaInfo | null = null;
    if (!kind.ffmpegOnly) {
      setBusy(`Opening ${file.name}…`);
      try {
        info = await probeMedia(blob);
        if (!info.decodable) info = null;
      } catch {
        info = null;
      } finally {
        setBusy(null);
      }
    }
    if (!info) {
      // Phones run out of memory converting big files in the browser (ffmpeg holds the whole
      // file plus its output in WebAssembly memory); refuse early with a useful message.
      const phone = window.matchMedia?.('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
      if (phone && blob.size > 150 * 1024 * 1024) {
        throw new Error("This video uses a format your phone's browser can't edit directly, and it is too large to convert on a phone. Open it on a computer, or convert it to MP4 first.");
      }
      // a container or codec the browser can't read: convert it once with ffmpeg
      const { normalizeForEditing, FfmpegCancelled } = await import('./core/media/ffmpeg-engine');
      const ctrl = new AbortController();
      setProgress({ title: `Preparing ${file.name}`, phase: 'Loading the converter', progress: 0, cancel: () => ctrl.abort() });
      try {
        const out = await normalizeForEditing(blob, kind.ext, kind.kind, (p) => setProgress((cur) => cur && { ...cur, phase: 'Converting for editing', progress: p }), ctrl.signal);
        blob = out.blob;
        name = `${baseName(file.name)}.${out.ext}`;
        handle = undefined;
        info = await probeMedia(blob);
        toast(`Converted to ${out.ext.toUpperCase()} for editing. Use Save as to choose the final format (including .${kind.ext}).`, 'info');
      } catch (err) {
        if (err instanceof FfmpegCancelled) return true;
        throw err;
      } finally {
        setProgress(null);
      }
    }
    if (!info.hasVideo && !info.hasAudio) throw new Error('This file contains no playable video or sound (it may be empty or damaged).');
    setDoc({ kind: 'media', key: docKey++, name, blob, info, container: containerFor(file.name, info.hasVideo), handle, protection: EMPTY_PROTECTION });
    setDirty(false);
    return true;
  };

  /** Opens Excel / CSV / TSV files. Returns false when the file is not a spreadsheet. */
  const openSheet = async (file: OpenedFile): Promise<boolean> => {
    const format = sheetFormatFromName(file.name);
    if (!format) return false;
    // Large workbooks are read from the file as a stream; only small ones are loaded whole.
    let blob: Blob = file.blob;
    let password: string | undefined;
    if (format === 'xlsx') {
      const { isCfb, isOfficeEncrypted, decryptOffice } = await import('./core/crypto/office-crypto');
      const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
      if (isCfb(head)) {
        const packed = await fileBytes(file);
        if (isOfficeEncrypted(packed)) {
          let incorrect = false;
          for (;;) {
            const pw = await requestPassword(file.name, 'This workbook is password protected.', incorrect);
            if (pw === null) return true;
            setBusy(`Opening ${file.name}…`);
            try {
              blob = new Blob([(await decryptOffice(packed, pw)) as BlobPart]);
              password = pw;
              break;
            } catch (err) {
              if (!(err instanceof PasswordError)) throw err;
              incorrect = true;
            } finally {
              setBusy(null);
            }
          }
        }
      }
    }
    setBusy(`Opening ${file.name}…`);
    try {
      await nextPaint();
      let workbook: IWorkbookData;
      let warnings: string[] = [];
      let cells = 0;
      if (format === 'xlsx') {
        const stream = await import('./core/sheet/xlsx-stream');
        if (await stream.needsStreamRead(blob)) {
          setBusy(null);
          const mb = (blob.size / 1024 / 1024).toFixed(0);
          setProgress({ title: `Opening ${file.name}`, phase: `Reading ${mb} MB`, progress: 0 });
          try {
            ({ workbook, warnings } = await stream.readXlsxStream(blob, baseName(file.name), (p) =>
              setProgress((cur) => cur && { ...cur, phase: `Reading ${mb} MB · ${p.cells.toLocaleString()} cells`, progress: p.fraction }),
            ));
            setProgress((cur) => cur && { ...cur, phase: 'Preparing the grid', progress: 1 });
            await nextPaint();
          } finally {
            setProgress(null);
          }
        } else {
          const { readXlsx } = await import('./core/sheet/xlsx');
          ({ workbook, warnings } = await readXlsx(new Uint8Array(await blob.arrayBuffer()), baseName(file.name)));
        }
        cells = stream.countCells(workbook, LARGE_SHEET_CELLS);
      } else {
        const { readDelimited } = await import('./core/sheet/csv');
        workbook = readDelimited(await fileBytes(file), file.name, format === 'tsv' ? '\t' : undefined);
        const first = workbook.sheets[workbook.sheetOrder[0]];
        cells = Object.keys(first?.cellData ?? {}).length * Math.max(1, (first?.columnCount ?? 31) - 5);
      }
      // .xlsm / .xltx are saved as plain .xlsx (macros are not kept)
      const ext = file.name.split('.').pop()?.toLowerCase();
      const keepsName = ext === SHEET_FORMATS[format].ext;
      setDoc({
        kind: 'sheet',
        key: docKey++,
        name: keepsName ? file.name : `${baseName(file.name)}.${SHEET_FORMATS[format].ext}`,
        format,
        workbook,
        large: cells > LARGE_SHEET_CELLS,
        handle: keepsName ? file.handle : undefined,
        protection: password ? { ...EMPTY_PROTECTION, enabled: true, password, confirm: password } : EMPTY_PROTECTION,
      });
      setDirty(false);
      if (cells > LARGE_SHEET_CELLS) toast('This is a large workbook, so auto-save is paused for it: press Save (Ctrl+S) to write your changes.', 'info');
      if (password) toast('Unlocked. The password will be kept when you save — change it under Protect.', 'info');
      if (ext === 'xlsm') warnings.push('Macros (saved as a macro-free .xlsx)');
      if (warnings.length) toast(`Opened. Not shown and not kept when saved: ${warnings.join(', ')}.`, 'info');
    } finally {
      setBusy(null);
    }
    return true;
  };

  /** Photoshop files: layered in the desktop pro editor. Returns false when the file is not a PSD. */
  const openPsd = async (file: OpenedFile): Promise<boolean> => {
    if (!/\.(psd|psb)$/i.test(file.name)) return false;
    if (host.kind !== 'desktop') throw new Error('Photoshop (.psd) files open in the File Editor desktop app, which has the pro photo editor with layers.');
    setBusy(`Opening ${file.name}…`);
    try {
      await nextPaint();
      const { readPsdDocument } = await import('./core/pro-image/psd');
      const { doc: pdoc, warnings } = readPsdDocument(await fileBytes(file));
      setDoc({ kind: 'proimage', key: docKey++, name: file.name, doc: pdoc, format: 'psd', handle: file.handle, protection: EMPTY_PROTECTION });
      setDirty(false);
      if (warnings.length) toast(`Opened. Not editable here: ${warnings.join(', ')}.`, 'info');
    } finally {
      setBusy(null);
    }
    return true;
  };

  /** Studio projects (.fstudio). Returns false when the file is not one. */
  const openProject = async (file: OpenedFile): Promise<boolean> => {
    if (!/\.fstudio$/i.test(file.name)) return false;
    if (host.kind !== 'desktop') throw new Error('Studio projects (.fstudio) open in the File Editor desktop app.');
    setBusy(`Opening ${file.name}…`);
    try {
      await nextPaint();
      const { readProjectFile } = await import('./core/studio/project-file');
      const { project, blobs } = await readProjectFile(await fileBytes(file));
      setDoc({ kind: 'studio', key: docKey++, name: file.name, project, blobs, origin: null, handle: file.handle, protection: EMPTY_PROTECTION });
      setDirty(false);
    } finally {
      setBusy(null);
    }
    return true;
  };

  /** Opens SQLite and LiteDB databases (.sqlite, .db, …). Returns false when the file is not a database. */
  const openDatabase = async (file: OpenedFile): Promise<boolean> => {
    const head = new Uint8Array(await file.blob.slice(0, 64).arrayBuffer());
    const byExt = dbFormatFromName(file.name);
    const { liteDbVersion } = await import('./core/db/litedb');
    const lite = liteDbVersion(head);
    // Known DB extensions always attempt open (sql.js validates the header). Magic catches renamed files.
    if (!byExt && !lite && !isSqliteFile(file.name, head)) return false;
    const format = byExt ?? 'sqlite';
    setBusy(`Opening ${file.name}…`);
    try {
      await nextPaint();
      const { SqliteDatabase } = await import('./core/db/sqlite');
      const bytes = await fileBytes(file);
      if (lite) {
        // LiteDB (.NET document database): read-only import, shown as SQLite tables
        const { readLiteDb, liteDbTables } = await import('./core/db/litedb');
        const source = readLiteDb(bytes);
        const db = await SqliteDatabase.open();
        try {
          for (const t of liteDbTables(source)) db.importTable(t.name, t.columns, t.rows);
        } catch (err) {
          db.close();
          throw err;
        }
        setDoc({ kind: 'database', key: docKey++, name: `${baseName(file.name)}.sqlite`, format: 'sqlite', db, protection: EMPTY_PROTECTION });
        setDirty(false);
        const docs = source.collections.reduce((n, c) => n + c.documents.length, 0);
        toast(
          `Opened a LiteDB database: ${source.collections.length} ${source.collections.length === 1 ? 'collection' : 'collections'}, ${docs.toLocaleString()} documents, shown as tables. ` +
            `This is a copy: saving writes a SQLite file and ${file.name} is not changed.${source.warnings.length ? ` Note: ${source.warnings.join('; ')}.` : ''}`,
          'info',
        );
        return true;
      }
      const db = await SqliteDatabase.open(bytes);
      // a SQLite file is saved back where it came from, whatever its extension
      setDoc({ kind: 'database', key: docKey++, name: file.name, format, db, large: bytes.byteLength > LARGE_DB_BYTES, handle: file.handle, protection: EMPTY_PROTECTION });
      setDirty(false);
    } finally {
      setBusy(null);
    }
    return true;
  };

  const openFile = async (file: OpenedFile) => {
    try {
      if (await openProject(file)) return;
      if (await openPsd(file)) return;
      if (await openDatabase(file)) return;
      if (await openSheet(file)) return;
      if (await openMedia(file)) return;
    } catch (err) {
      toast(`Could not open ${file.name}: ${errorText(err)}`);
      return;
    }
    try {
      const opened = await openWithPrompt(file);
      if (!opened) return;
      const { result, password } = opened;
      if (result.kind === 'pdf') {
        // keep the protection the file had, as Word/Acrobat do; the user can change it in Protect.
        const protection = result.wasProtected && password !== undefined
          ? protectionFromPdf({ userPassword: password, ownerPassword: password })
          : EMPTY_PROTECTION;
        setDoc({ kind: 'pdf', key: docKey++, name: file.name, bytes: result.bytes, handle: file.handle, protection });
        setPageCount(null);
      } else if (result.kind === 'code') {
        const sameFormat = FORMATS[result.format].extensions.includes(file.name.split('.').pop()?.toLowerCase() ?? '');
        setDoc({
          kind: 'code',
          key: docKey++,
          name: sameFormat ? file.name : `${baseName(file.name)}.${FORMATS[result.format].ext}`,
          format: result.format,
          language: result.language,
          text: result.text,
          handle: sameFormat ? file.handle : undefined,
          protection: EMPTY_PROTECTION,
        });
      } else {
        const sameFormat = FORMATS[result.format].extensions.includes(file.name.split('.').pop()?.toLowerCase() ?? '');
        const protection: ProtectionDraft = result.wasProtected && password
          ? { ...EMPTY_PROTECTION, enabled: true, password, confirm: password }
          : EMPTY_PROTECTION;
        setDoc({
          kind: 'flow',
          key: docKey++,
          name: sameFormat ? file.name : `${baseName(file.name)}.${FORMATS[result.format].ext}`,
          format: result.format,
          initial: result.doc,
          handle: sameFormat ? file.handle : undefined,
          protection,
        });
        setStats(null);
      }
      setDirty(false);
      if (result.wasProtected) toast('Unlocked. The password will be kept when you save — change it under Protect.', 'info');
    } catch (err) {
      toast(err instanceof UnsupportedError ? err.message : `Could not open ${file.name}: ${errorText(err)}`);
    }
  };

  const newDocument = () => {
    setDoc({ kind: 'flow', key: docKey++, name: 'Untitled.docx', format: 'docx', initial: { ...BLANK }, protection: EMPTY_PROTECTION });
    setDirty(false);
    setStats(null);
  };

  /** Desktop: move the open photo between the quick editor and the layered pro editor. */
  const switchPhotoWorkspace = async (to: 'quick' | 'pro') => {
    const d = docRef.current;
    if (!d) return;
    if (to === 'pro' && d.kind === 'image') {
      const px = imageRef.current?.getPixels();
      if (!px) return;
      const { newDocument: newProDocument } = await import('./core/pro-image/document');
      setDoc({ kind: 'proimage', key: docKey++, name: d.name, doc: newProDocument(px), format: d.format, handle: d.handle, protection: EMPTY_PROTECTION });
      return;
    }
    if (to === 'quick' && d.kind === 'proimage') {
      const pro = proImageRef.current;
      if (!pro) return;
      const layers = pro.getDocument().layers.length;
      if (layers > 1 && !window.confirm(`The quick editor works on a single image, so the ${layers} layers will be flattened. Continue?`)) return;
      const px = pro.getPixels();
      const fmt: ImageFormat = d.format === 'psd' ? 'png' : d.format;
      setDoc({
        kind: 'image',
        key: docKey++,
        name: d.format === 'psd' ? `${baseName(d.name)}.png` : d.name,
        decoded: { pixels: px, format: fmt, warnings: [] },
        format: fmt,
        handle: d.format === 'psd' ? undefined : d.handle,
        protection: EMPTY_PROTECTION,
      });
      if (layers > 1 || d.format === 'psd') markDirty();
    }
  };

  /** Desktop: move the open video / audio file between the quick editor and the multi-track Studio. */
  const switchVideoWorkspace = async (to: 'quick' | 'studio') => {
    const d = docRef.current;
    if (!d) return;
    if (to === 'studio' && d.kind === 'media') {
      if (dirtyRef.current && !window.confirm('Changes made in Quick edit (trim, crop, filters…) are not carried into Studio. Open the original file in Studio?')) return;
      const { projectFromSource } = await import('./core/studio/build');
      const id = 'S0';
      const project = projectFromSource({
        id,
        name: d.name,
        kind: d.info.hasVideo ? 'video' : 'audio',
        duration: d.info.duration,
        width: d.info.width,
        height: d.info.height,
        hasAudio: d.info.hasAudio,
        fps: d.info.fps,
      });
      setDoc({ kind: 'studio', key: docKey++, name: d.name, project, blobs: new Map([[id, d.blob]]), origin: d, protection: EMPTY_PROTECTION });
      setDirty(false);
      return;
    }
    if (to === 'quick' && d.kind === 'studio' && d.origin) {
      if (dirtyRef.current && !window.confirm('Quick edit works on the original file only, so your Studio timeline, effects and mix will be discarded. Export first to keep them. Continue?')) return;
      studioRef.current?.stop();
      setDoc({ ...d.origin, key: docKey++ });
      setDirty(false);
    }
  };

  const newSpreadsheet = () => {
    setDoc({ kind: 'sheet', key: docKey++, name: 'Untitled.xlsx', format: 'xlsx', workbook: blankWorkbook('Untitled'), protection: EMPTY_PROTECTION });
    setDirty(false);
  };

  /** Converts any picked file into PDF bytes, for inserting its pages into the open PDF. */
  const loadAsPdf = async (file: OpenedFile): Promise<Uint8Array | null> => {
    const opened = await openWithPrompt(file);
    if (!opened) return null;
    if (opened.result.kind === 'pdf') return opened.result.bytes;
    setBusy('Converting to PDF…');
    try {
      if (opened.result.kind === 'code') {
        const rich = await codeToRich(opened.result.language, opened.result.text);
        return await exportFlow(rich, 'pdf');
      }
      return await exportFlow(opened.result.doc, 'pdf');
    } finally {
      setBusy(null);
    }
  };

  /** Changes the open document's format / kind from the status-bar switcher. */
  const switchFormat = async (target: SwitchTarget) => {
    const d = docRef.current;
    if (!d || (d.kind !== 'flow' && d.kind !== 'code' && d.kind !== 'sheet')) return;
    if (target === d.format) return;
    const title = baseName(d.name);

    if (target === 'image') {
      setDoc({
        kind: 'image',
        key: docKey++,
        name: `${title}.png`,
        decoded: blankCanvasImage(),
        format: 'png',
        protection: EMPTY_PROTECTION,
      });
      markDirty();
      setImageStatus({ width: 800, height: 600 });
      return;
    }

    // ── to a spreadsheet format ──
    if (isSheetFormat(target)) {
      const info = SHEET_FORMATS[target];
      if (d.kind === 'sheet') {
        // same workbook, different file format (the editor keeps its state)
        setDoc((cur) =>
          cur?.kind === 'sheet'
            ? { ...cur, format: target, name: `${baseName(cur.name)}.${info.ext}`, handle: undefined, protection: info.canProtect ? cur.protection : EMPTY_PROTECTION }
            : cur,
        );
        markDirty();
        const active = sheetRef.current?.getActiveSheet();
        if (!info.canProtect && active && active.sheetCount > 1) {
          toast(`${info.label} holds one sheet: saving writes the active sheet only. The other sheets stay here until you close the file.`, 'info');
        }
        return;
      }
      setBusy('Switching format…');
      try {
        await nextPaint();
        const { htmlToWorkbook, plainTextToWorkbook } = await import('./core/sheet/convert');
        let workbook: IWorkbookData;
        if (d.kind === 'code') {
          const text = codeRef.current?.getText() ?? d.text;
          // source code: one line per row (a CSS rule's semicolons aren't columns)
          workbook = d.language === 'html' ? htmlToWorkbook(text, title) : plainTextToWorkbook(text, title, false);
        } else if (d.format === 'txt') {
          const tmp = document.createElement('div');
          tmp.innerHTML = currentFlow()!.html;
          workbook = plainTextToWorkbook((tmp.innerText || tmp.textContent || '').replace(/\u00a0/g, ' '), title);
        } else {
          workbook = htmlToWorkbook(currentFlow()!.html, title);
        }
        setDoc({ kind: 'sheet', key: docKey++, name: `${title}.${info.ext}`, format: target, workbook, protection: EMPTY_PROTECTION });
        // an untouched blank document becomes an untouched blank spreadsheet
        const empty = workbook.sheetOrder.every((id) => usedRange(workbook.sheets[id]).lastRow < 0);
        setDirty(dirtyRef.current || !empty);
      } catch (err) {
        toast(`Could not switch format: ${errorText(err)}`);
      } finally {
        setBusy(null);
      }
      return;
    }

    // ── from a spreadsheet to a document format: the active sheet becomes a table ──
    let fromSheet: { rich: RichDocument; text: string } | null = null;
    if (d.kind === 'sheet') {
      const active = sheetRef.current?.getActiveSheet();
      if (!active) return;
      const { rowsToDocumentHtml, rowsToText } = await import('./core/sheet/convert');
      fromSheet = { rich: { html: rowsToDocumentHtml(active.rows), title }, text: rowsToText(active.rows) };
      if (active.sheetCount > 1) toast(`Converted the sheet "${active.name}". Other sheets are not included.`, 'info');
    }
    const richOf = async (): Promise<RichDocument> => {
      if (fromSheet) return fromSheet.rich;
      if (d.kind === 'flow') return currentFlow()!;
      if (d.kind === 'code') return { ...(await codeToRich(d.language, codeRef.current?.getText() ?? d.text)), title };
      throw new Error('Nothing to convert.');
    };

    if (target === 'pdf') {
      setBusy('Converting to PDF…');
      try {
        await nextPaint();
        const bytes = await exportFlow(await richOf(), 'pdf');
        setDoc({ kind: 'pdf', key: docKey++, name: `${title}.pdf`, bytes, protection: EMPTY_PROTECTION });
        markDirty();
        setPageCount(null);
      } catch (err) {
        toast(`Could not convert: ${errorText(err)}`);
      } finally {
        setBusy(null);
      }
      return;
    }

    if (isCodeFormat(target)) {
      setBusy('Switching format…');
      try {
        await nextPaint();
        let text = '';
        if (d.kind === 'code') {
          // Keep the source when switching among html/css/js (or renaming the language)
          text = codeRef.current?.getText() ?? d.text;
        } else if (target === 'html') {
          text = new TextDecoder().decode(await exportFlow(await richOf(), 'html'));
        } else if (fromSheet) {
          text = fromSheet.text;
        } else {
          // Word/rich → css/js: take plain text from the document so content isn't lost
          const tmp = document.createElement('div');
          tmp.innerHTML = currentFlow()!.html;
          text = (tmp.innerText || tmp.textContent || '').replace(/\u00a0/g, ' ');
        }
        setDoc({
          kind: 'code',
          key: docKey++,
          name: `${title}.${FORMATS[target].ext}`,
          format: target,
          language: target,
          text,
          handle: undefined,
          protection: EMPTY_PROTECTION,
        });
        markDirty();
      } catch (err) {
        toast(`Could not switch format: ${errorText(err)}`);
      } finally {
        setBusy(null);
      }
      return;
    }

    // Rich flow formats (docx / txt / odt / rtf / md / doc)
    if (d.kind === 'flow') {
      setDoc((cur) => {
        if (!cur || cur.kind !== 'flow') return cur;
        return {
          ...cur,
          format: target,
          name: `${baseName(cur.name)}.${FORMATS[target].ext}`,
          handle: undefined,
        };
      });
      markDirty();
      return;
    }

    setBusy('Switching format…');
    try {
      await nextPaint();
      setDoc({
        kind: 'flow',
        key: docKey++,
        name: `${title}.${FORMATS[target].ext}`,
        format: target,
        initial: await richOf(),
        protection: EMPTY_PROTECTION,
      });
      markDirty();
      setStats(null);
    } catch (err) {
      toast(`Could not switch format: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  // ── saving ───────────────────────────────────────────────────────────────
  const currentFlow = (): RichDocument | null => {
    const d = docRef.current;
    if (d?.kind !== 'flow') return null;
    const rd = richRef.current?.getDocument() ?? d.initial;
    return { ...rd, title: baseName(d.name) };
  };

  const pdfBytes = async (protection: PdfProtection | null) => {
    const d = docRef.current;
    const session = pdfRef.current?.getSession();
    if (!d || !session) throw new Error('Nothing to save.');
    return buildPdf(session, { title: baseName(d.name), protection });
  };

  const render = async (format: DocFormat, protection: ProtectionDraft): Promise<Uint8Array> => {
    const d = docRef.current!;
    if (d.kind === 'image' || d.kind === 'proimage' || d.kind === 'media' || d.kind === 'studio' || d.kind === 'sheet' || d.kind === 'database') throw new Error('Use the image, video, spreadsheet or database save dialog.');
    const pdfProt = protectionToPdf(protection);
    const pw = protection.enabled ? protection.password : undefined;
    if (d.kind === 'code') {
      const text = codeRef.current?.getText() ?? d.text;
      if (isCodeFormat(format) || format === 'txt') return utf8Encode(text);
      const rich = await codeToRich(d.language, text);
      return exportFlow({ ...rich, title: baseName(d.name) }, format, {
        password: format === 'docx' ? pw : undefined,
        pdfProtection: format === 'pdf' ? pdfProt : null,
      });
    }
    if (d.kind === 'flow') {
      const flow = currentFlow()!;
      return exportFlow(flow, format, { password: format === 'docx' ? pw : undefined, pdfProtection: format === 'pdf' ? pdfProt : null });
    }
    if (format === 'pdf') return pdfBytes(pdfProt);
    // PDF → editable format: rebuild from the edited PDF so added text is included
    const plain = await pdfBytes(null);
    const { importPdfAsFlow } = await import('./core/formats/pdf-import');
    const flow = await importPdfAsFlow(plain);
    return exportFlow({ ...flow, title: baseName(d.name) }, format, { password: format === 'docx' ? pw : undefined });
  };

  const writeOut = async (choice: ExportChoice, handle: unknown | undefined, adopt: boolean, quiet = false) => {
    const d = docRef.current;
    if (!d) return;
    const seq = editSeq.current;
    if (!quiet) setBusy('Saving…');
    try {
      // let "Saving…" paint before building/encrypting the file, which can hold the main
      // thread for seconds on a phone and otherwise looks like the page has frozen
      await nextPaint();
      const bytes = await render(choice.format, choice.protection);
      const info = FORMATS[choice.format];
      const res = await host.save({ suggestedName: choice.fileName, bytes, mime: info.mime, ext: info.ext, description: info.label, handle, quiet });
      if (!res) return;
      if (adopt && quiet) {
        markClean(seq);
      } else if (adopt) {
        if (d.kind === 'flow' && isCodeFormat(choice.format)) {
          setDoc({
            kind: 'code',
            key: docKey++,
            name: res.name,
            format: choice.format,
            language: choice.format,
            text: new TextDecoder().decode(bytes),
            handle: res.handle,
            protection: choice.protection,
          });
        } else if (d.kind === 'code' && !isCodeFormat(choice.format) && choice.format !== 'pdf') {
          const rich = await codeToRich(d.language, codeRef.current?.getText() ?? d.text);
          setDoc({
            kind: 'flow',
            key: docKey++,
            name: res.name,
            format: choice.format as FlowFormat,
            initial: rich,
            handle: res.handle,
            protection: choice.protection,
          });
        } else {
          setDoc((cur) => {
            if (!cur) return cur;
            if (cur.kind === 'flow' && choice.format !== 'pdf' && !isCodeFormat(choice.format)) {
              return { ...cur, name: res.name, format: choice.format as FlowFormat, handle: res.handle, protection: choice.protection };
            }
            if (cur.kind === 'code' && isCodeFormat(choice.format)) {
              return {
                ...cur,
                name: res.name,
                format: choice.format,
                language: choice.format,
                text: codeRef.current?.getText() ?? cur.text,
                handle: res.handle,
                protection: choice.protection,
              };
            }
            if (cur.kind === 'pdf' && choice.format === 'pdf') {
              return { ...cur, name: res.name, handle: res.handle, protection: choice.protection };
            }
            return cur;
          });
        }
        markClean(seq);
      }
      if (quiet) return;
      const lock = choice.protection.enabled && info.canProtect ? ' (password protected)' : '';
      toast(host.canSaveInPlace || host.kind === 'desktop' ? `Saved ${res.name}${lock}` : `Downloaded ${res.name}${lock}`, 'info');
    } catch (err) {
      if (quiet) throw err;
      toast(`Could not save: ${errorText(err)}`);
    } finally {
      if (!quiet) setBusy(null);
    }
  };

  // ── images ───────────────────────────────────────────────────────────────
  const encodeChoice = async (px: Pixels, c: ImageExportChoice, title: string): Promise<{ bytes: Uint8Array; mime: string; ext: string; label: string }> => {
    const codecs = await import('./core/media/image-codecs');
    const src = c.scale !== 1 ? codecs.resizePixels(px, px.width * c.scale, px.height * c.scale) : px;
    if (c.format === 'pdf') return { bytes: await codecs.imageToPdf(src, title, c.quality), mime: 'application/pdf', ext: 'pdf', label: 'PDF' };
    if (c.format === 'psd') throw new Error('Use the pro photo editor to save Photoshop files.');
    const info = IMAGE_FORMATS[c.format];
    return { bytes: await codecs.encodeImage(src, c.format, { quality: c.quality, lossless: c.lossless, background: c.background }), mime: info.mime, ext: info.ext, label: info.label };
  };

  const saveImage = async (c: ImageExportChoice, handle: unknown | undefined, adopt: boolean, pixels?: Pixels, quiet = false) => {
    const d = docRef.current;
    const pro = d?.kind === 'proimage' && !pixels ? proImageRef.current : null;
    const seq = editSeq.current;
    if (!quiet) setBusy('Saving…');
    try {
      await nextPaint();
      let out: { bytes: Uint8Array; mime: string; ext: string; label: string };
      if (c.format === 'psd') {
        if (!pro) throw new Error('Layered Photoshop files are saved from the pro photo editor.');
        out = { bytes: pro.getPsd(), mime: 'image/vnd.adobe.photoshop', ext: 'psd', label: 'Photoshop document' };
      } else {
        const px = pixels ?? (pro ? pro.getPixels() : imageRef.current?.getPixels());
        if (!px) return;
        out = await encodeChoice(px, c, baseName(c.fileName));
      }
      const res = await host.save({ suggestedName: c.fileName, bytes: out.bytes, mime: out.mime, ext: out.ext, description: out.label, handle, quiet });
      if (!res) return;
      if (adopt && d?.kind === 'image' && c.format !== 'pdf' && c.format !== 'psd') {
        if (!quiet) setDoc((cur) => (cur && cur.kind === 'image' ? { ...cur, name: res.name, format: c.format as ImageFormat, handle: res.handle } : cur));
        markClean(seq);
      }
      if (adopt && d?.kind === 'proimage' && c.format !== 'pdf') {
        // keep the editor (and its undo history) mounted: same key, new file details
        if (!quiet) setDoc((cur) => (cur && cur.kind === 'proimage' ? { ...cur, name: res.name, format: c.format as ImageFormat | 'psd', handle: res.handle } : cur));
        const layers = pro?.getDocument().layers.length ?? 1;
        if (c.format === 'psd' || layers === 1) markClean(seq);
        else if (!quiet) toast('Saved a flattened copy. Save as Photoshop (.psd) to keep the layers.', 'info');
      }
      if (quiet) return;
      toast(`${host.canSaveInPlace || host.kind === 'desktop' ? 'Saved' : 'Downloaded'} ${res.name} (${(out.bytes.length / 1024).toFixed(0)} KB)`, 'info');
    } catch (err) {
      if (quiet) throw err;
      toast(`Could not save: ${errorText(err)}`);
    } finally {
      if (!quiet) setBusy(null);
    }
  };

  // ── video / audio ────────────────────────────────────────────────────────
  /** `handle` set: write back to the opened file (Save); otherwise ask where (Save As). */
  const saveMedia = async (c: MediaExportChoice, handle?: unknown) => {
    const d = docRef.current;
    if (d?.kind !== 'media' || !videoRef.current) return;
    const seq = editSeq.current;
    const edits = videoRef.current.getEdits();
    const ctrl = new AbortController();
    const info = CONTAINERS[c.container];
    setProgress({ title: `Saving ${c.fileName}`, phase: 'Starting', progress: 0, cancel: () => ctrl.abort() });
    try {
      const { exportMedia, ExportCancelled } = await import('./core/media/video-engine');
      let bytes: Uint8Array;
      try {
        bytes = await exportMedia(d.blob, edits, d.info, c, (p) => setProgress((cur) => cur && { ...cur, phase: p.phase, progress: p.progress }), ctrl.signal);
      } catch (err) {
        if (err instanceof ExportCancelled || ctrl.signal.aborted) {
          toast('Export cancelled.', 'info');
          return;
        }
        throw err;
      }
      setProgress(null);
      const res = await host.save({ suggestedName: c.fileName, bytes, mime: info.mime, ext: info.ext, description: info.label, handle });
      if (!res) return;
      // the file now holds the edits; later saves still render from the original in memory
      if (res.handle !== undefined && (handle !== undefined || res.name.split('.').pop()?.toLowerCase() === info.ext)) {
        setDoc((cur) => (cur && cur.kind === 'media' ? { ...cur, name: res.name, container: c.container, handle: res.handle } : cur));
      }
      markClean(seq);
      toast(`${host.canSaveInPlace || host.kind === 'desktop' ? 'Saved' : 'Downloaded'} ${res.name} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`, 'info');
    } catch (err) {
      toast(`Could not save: ${errorText(err)}`);
    } finally {
      setProgress(null);
    }
  };

  /** Saves the Studio project file (.fstudio): in place with `handle`, else asks where. */
  const saveStudioProject = async (handle: unknown | undefined, quiet = false, fileName?: string) => {
    const d = docRef.current;
    const studio = studioRef.current;
    if (d?.kind !== 'studio' || !studio) return;
    const seq = editSeq.current;
    if (!quiet) setBusy('Saving project…');
    try {
      const [{ writeProjectFile, PROJECT_EXT, PROJECT_MIME }, media] = await Promise.all([import('./core/studio/project-file'), studio.getMedia()]);
      const bytes = await writeProjectFile(studio.getProject(), media.blobs);
      const res = await host.save({
        suggestedName: fileName ?? `${baseName(d.name)}.${PROJECT_EXT}`,
        bytes,
        mime: PROJECT_MIME,
        ext: PROJECT_EXT,
        description: 'File Editor Studio project',
        handle,
        quiet,
      });
      if (!res) return;
      if (!quiet) setDoc((cur) => (cur && cur.kind === 'studio' ? { ...cur, name: res.name, handle: res.handle } : cur));
      markClean(seq);
      if (!quiet) toast(`${host.kind === 'desktop' || host.canSaveInPlace ? 'Saved' : 'Downloaded'} ${res.name} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`, 'info');
    } catch (err) {
      if (quiet) throw err;
      toast(`Could not save the project: ${errorText(err)}`);
    } finally {
      if (!quiet) setBusy(null);
    }
  };

  const saveStudio = async (c: StudioExportChoice) => {
    if (c.container === 'project') {
      await saveStudioProject(undefined, false, c.fileName);
      return;
    }
    const d = docRef.current;
    const studio = studioRef.current;
    if (d?.kind !== 'studio' || !studio) return;
    studio.stop();
    const ctrl = new AbortController();
    const info = CONTAINERS[c.container];
    setProgress({ title: `Exporting ${c.fileName}`, phase: 'Preparing media', progress: 0, cancel: () => ctrl.abort() });
    try {
      const { exportStudio, StudioCancelled } = await import('./core/studio/export');
      const media = await studio.getMedia();
      let result: Awaited<ReturnType<typeof exportStudio>>;
      try {
        result = await exportStudio(studio.getProject(), media.blobs, media.buffers, { ...c, container: c.container }, (phase, progress) => setProgress((cur) => cur && { ...cur, phase, progress }), ctrl.signal);
      } catch (err) {
        if (err instanceof StudioCancelled || ctrl.signal.aborted) {
          toast('Export cancelled.', 'info');
          return;
        }
        throw err;
      }
      setProgress(null);
      const res = await host.save({ suggestedName: c.fileName, bytes: result.bytes, mime: info.mime, ext: info.ext, description: info.label });
      if (!res) return;
      const lufs = result.loudness !== null && Number.isFinite(result.loudness) ? ` · ${result.loudness.toFixed(1)} LUFS` : '';
      toast(`Exported ${res.name} (${(result.bytes.length / 1024 / 1024).toFixed(1)} MB${lufs})`, 'info');
    } catch (err) {
      toast(`Could not export: ${errorText(err)}`);
    } finally {
      setProgress(null);
    }
  };

  // ── databases ────────────────────────────────────────────────────────────
  const saveDatabase = async (handle: unknown | undefined, adopt: boolean, quiet = false, fileName?: string) => {
    const d = docRef.current;
    if (d?.kind !== 'database' || !dbRef.current) return;
    const seq = editSeq.current;
    if (!quiet) setBusy('Saving…');
    try {
      await nextPaint();
      const bytes = dbRef.current.export();
      const name = fileName ?? d.name;
      const ext = (name.split('.').pop()?.toLowerCase() as DbFormat | undefined) && (DB_EXTENSIONS as readonly string[]).includes(name.split('.').pop()!.toLowerCase())
        ? (name.split('.').pop()!.toLowerCase() as DbFormat)
        : d.format;
      const res = await host.save({
        suggestedName: name.endsWith(`.${ext}`) ? name : `${baseName(name)}.${ext}`,
        bytes,
        mime: 'application/vnd.sqlite3',
        ext,
        description: 'SQLite database',
        handle,
        quiet,
      });
      if (!res) return;
      if (adopt) {
        if (!quiet) setDoc((cur) => (cur && cur.kind === 'database' ? { ...cur, name: res.name, format: ext, handle: res.handle } : cur));
        markClean(seq);
      }
      if (!quiet) toast(`${host.canSaveInPlace || host.kind === 'desktop' ? 'Saved' : 'Downloaded'} ${res.name}`, 'info');
    } catch (err) {
      if (quiet) throw err;
      toast(`Could not save: ${errorText(err)}`);
    } finally {
      if (!quiet) setBusy(null);
    }
  };

  // ── spreadsheets ─────────────────────────────────────────────────────────
  const saveSheet = async (c: SheetExportChoice, handle: unknown | undefined, adopt: boolean, quiet = false) => {
    const d = docRef.current;
    if (d?.kind !== 'sheet' || !sheetRef.current) return;
    const seq = editSeq.current;
    if (!quiet) setBusy('Saving…');
    try {
      await nextPaint();
      const info = SHEET_FORMATS[c.format];
      let bytes: Uint8Array;
      let note = '';
      if (c.format === 'xlsx') {
        const wb = sheetRef.current.getWorkbook();
        if (!wb) throw new Error('The spreadsheet is still loading.');
        const stream = await import('./core/sheet/xlsx-stream');
        if (stream.countCells(wb, stream.STREAM_WRITE_CELLS) > stream.STREAM_WRITE_CELLS) {
          // large workbook: written a block of rows at a time
          if (!quiet) {
            setBusy(null);
            setProgress({ title: `Saving ${c.fileName}`, phase: 'Writing the workbook', progress: 0 });
          }
          try {
            bytes = await stream.writeXlsxStream({ ...wb, name: baseName(c.fileName) }, (f) => !quiet && setProgress((cur) => cur && { ...cur, progress: f }));
          } finally {
            if (!quiet) setProgress(null);
          }
        } else {
          const { writeXlsx } = await import('./core/sheet/xlsx');
          bytes = await writeXlsx({ ...wb, name: baseName(c.fileName) });
        }
        if (c.protection.enabled && c.protection.password) {
          const { encryptOffice } = await import('./core/crypto/office-crypto');
          bytes = await encryptOffice(bytes, c.protection.password);
        }
      } else {
        const active = sheetRef.current.getActiveSheet();
        if (!active) throw new Error('The spreadsheet is still loading.');
        const { writeDelimited } = await import('./core/sheet/csv');
        bytes = writeDelimited(active.rows, c.format === 'tsv' ? '\t' : ',');
        if (active.sheetCount > 1) note = ` (sheet "${active.name}" only)`;
      }
      const res = await host.save({ suggestedName: c.fileName, bytes, mime: info.mime, ext: info.ext, description: info.label, handle, quiet });
      if (!res) return;
      if (adopt) {
        if (!quiet) setDoc((cur) => (cur && cur.kind === 'sheet' ? { ...cur, name: res.name, format: c.format, handle: res.handle, protection: c.protection } : cur));
        markClean(seq);
      }
      if (quiet) return;
      const lock = c.protection.enabled && info.canProtect ? ' (password protected)' : '';
      toast(`${host.canSaveInPlace || host.kind === 'desktop' ? 'Saved' : 'Downloaded'} ${res.name}${lock}${note}`, 'info');
    } catch (err) {
      if (quiet) throw err;
      toast(`Could not save: ${errorText(err)}`);
    } finally {
      if (!quiet) setBusy(null);
    }
  };

  // ── spreadsheet → database (each sheet becomes a table) ──────────────────
  const [headerAsk, setHeaderAsk] = useState<{ workbook: IWorkbookData; plans: SheetTablePlan[]; fileName: string } | null>(null);

  const startSheetToDatabase = async (fileName: string) => {
    const d = docRef.current;
    if (d?.kind !== 'sheet' || !sheetRef.current) return;
    setBusy('Reading the sheets…');
    try {
      await nextPaint();
      const workbook = sheetRef.current.getWorkbook();
      if (!workbook) throw new Error('The spreadsheet is still loading.');
      const { planTables } = await import('./core/sheet/to-database');
      const plans = planTables(workbook);
      if (!plans.length) throw new Error('This workbook has no data to put in a database.');
      setBusy(null);
      // a sheet whose heading row is a guess: ask before using it
      if (plans.some((p) => !p.confident)) setHeaderAsk({ workbook, plans, fileName });
      else await sheetToDatabase(workbook, plans, fileName);
    } catch (err) {
      toast(`Could not convert: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const sheetToDatabase = async (workbook: IWorkbookData, plans: SheetTablePlan[], fileName: string) => {
    setBusy('Creating the database…');
    try {
      await nextPaint();
      const [{ buildTable }, { SqliteDatabase }] = await Promise.all([import('./core/sheet/to-database'), import('./core/db/sqlite')]);
      const db = await SqliteDatabase.open();
      let rows = 0;
      let bytes: Uint8Array;
      try {
        for (const plan of plans) {
          const table = buildTable(workbook, plan);
          db.importTable(table.name, table.columns, table.rows);
          rows += table.rows.length;
          await nextPaint();
        }
        bytes = db.export();
      } catch (err) {
        db.close();
        throw err;
      }
      setBusy(null);
      const res = await host.save({ suggestedName: fileName, bytes, mime: 'application/vnd.sqlite3', ext: 'sqlite', description: 'SQLite database' });
      if (!res) {
        db.close();
        return;
      }
      // carry on in the database editor, on the file that was just written
      setDoc({ kind: 'database', key: docKey++, name: res.name, format: 'sqlite', db, large: bytes.byteLength > LARGE_DB_BYTES, handle: res.handle, protection: EMPTY_PROTECTION });
      setDirty(false);
      toast(`${host.canSaveInPlace || host.kind === 'desktop' ? 'Saved' : 'Downloaded'} ${res.name}: ${plans.length} ${plans.length === 1 ? 'table' : 'tables'}, ${rows.toLocaleString()} rows.`, 'info');
    } catch (err) {
      toast(`Could not convert: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  /**
   * Writes the open file back to where it came from, in its own format. Returns false when it
   * has no such place (a new file, a converted one, or a format that can't be written).
   */
  const saveInPlace = async (quiet: boolean): Promise<boolean> => {
    const d = docRef.current;
    if (!d || d.handle === undefined || (host.kind === 'web' && !host.canSaveInPlace)) return false;
    const img = { quality: 92, lossless: false, background: '#ffffff', scale: 1 };
    switch (d.kind) {
      case 'sheet':
        await saveSheet({ format: d.format, fileName: d.name, protection: d.protection }, d.handle, true, quiet);
        return true;
      case 'database':
        await saveDatabase(d.handle, true, quiet);
        return true;
      case 'studio':
        await saveStudioProject(d.handle, quiet);
        return true;
      case 'media':
        // re-encodes, so never in the background
        if (quiet || !CONTAINERS[d.container]) return false;
        await saveMedia({ fileName: d.name, container: d.container, quality: 4, width: null, height: null, fps: null }, d.handle);
        return true;
      case 'proimage': {
        const layers = proImageRef.current?.getDocument().layers.length ?? 1;
        // layers are kept only in .psd: flattening into a JPEG/PNG needs an explicit Save As
        if (d.format !== 'psd' && (layers > 1 || !IMAGE_FORMATS[d.format].canWrite)) return false;
        await saveImage({ ...img, format: d.format as ImageExportChoice['format'], fileName: d.name }, d.handle, true, undefined, quiet);
        return true;
      }
      case 'image':
        if (!IMAGE_FORMATS[d.format].canWrite) return false;
        await saveImage({ ...img, format: d.format as ImageExportChoice['format'], fileName: d.name }, d.handle, true, undefined, quiet);
        return true;
      default: {
        const format: DocFormat = d.kind === 'pdf' ? 'pdf' : d.format;
        await writeOut({ format, fileName: d.name, protection: d.protection }, d.handle, true, quiet);
        return true;
      }
    }
  };

  const save = async () => {
    const d = docRef.current;
    if (!d) return;
    clearTimeout(autoTimer.current);
    if (d.handle !== undefined && (host.kind === 'desktop' || host.canSaveInPlace)) {
      // web: the browser asks once per file for permission to change it
      if (host.kind === 'web' && !(await host.requestWrite(d.handle))) {
        toast('The browser did not allow saving to this file. Use Save as to save a copy.');
        return;
      }
      if (await saveInPlace(false)) {
        setAutoStatus(null);
        return;
      }
    }
    // no file to write back to
    if (d.kind === 'studio') {
      await saveStudioProject(undefined);
      return;
    }
    if (host.kind === 'web' && !host.canSaveInPlace) {
      // browsers without the File System Access API: Save = download in the current format
      if (d.kind === 'sheet') return saveSheet({ format: d.format, fileName: d.name, protection: d.protection }, undefined, true);
      if (d.kind === 'database') return saveDatabase(undefined, true);
      if (d.kind === 'image' && IMAGE_FORMATS[d.format].canWrite) {
        return saveImage({ format: d.format as ImageExportChoice['format'], fileName: d.name, quality: 92, lossless: false, background: '#ffffff', scale: 1 }, undefined, true);
      }
      if (d.kind === 'flow' || d.kind === 'code' || d.kind === 'pdf') {
        return writeOut({ format: d.kind === 'pdf' ? 'pdf' : d.format, fileName: d.name, protection: d.protection }, undefined, true);
      }
    }
    if (d.kind === 'database') {
      await saveDatabase(undefined, true);
      return;
    }
    setExportOpen('save-as');
  };

  // ── auto-save (the on/off setting is app-wide; see App) ──────────────────
  const autoSaveRef = useRef(autoSave);
  autoSaveRef.current = autoSave;
  const [autoStatus, setAutoStatus] = useState<{ state: 'saving' | 'saved' | 'error' | 'blocked'; text: string } | null>(null);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autoBusy = useRef(false);
  const progressRef = useRef(progress);
  progressRef.current = progress;

  /** Why the open file can't be saved automatically right now, or null if it can. */
  const autoSaveBlocker = (d: OpenDoc): string | null => {
    if (d.kind === 'media') return 'Video and audio are re-encoded when saved, so they are saved when you press Save.';
    if ((d.kind === 'sheet' || d.kind === 'database') && d.large) return `This ${d.kind === 'sheet' ? 'workbook' : 'database'} is large, so it is saved when you press Save rather than after every edit.`;
    if (host.kind === 'web' && !host.canSaveInPlace) return 'Auto-save needs the desktop app or a browser that can save files in place (Chrome, Edge).';
    if (d.handle === undefined) return 'Save once to choose a file; after that, changes are saved automatically.';
    if (d.kind === 'image' && !IMAGE_FORMATS[d.format].canWrite) return `${IMAGE_FORMATS[d.format].label} can't be written. Save as another format to turn on auto-save.`;
    if (d.kind === 'proimage' && d.format !== 'psd' && (proImageRef.current?.getDocument().layers.length ?? 1) > 1) return 'Save as Photoshop (.psd) to auto-save the layers.';
    return null;
  };

  const runAutoSave = async () => {
    const d = docRef.current;
    if (!autoSaveRef.current || !d || !dirtyRef.current) return;
    if (autoBusy.current || progressRef.current) {
      scheduleAutoSave(1500);
      return;
    }
    const blocker = autoSaveBlocker(d);
    if (blocker) {
      setAutoStatus({ state: 'blocked', text: blocker });
      return;
    }
    if (!(await host.canWriteSilently(d.handle))) {
      setAutoStatus({ state: 'blocked', text: 'Press Save once to let the browser save this file automatically.' });
      return;
    }
    autoBusy.current = true;
    setAutoStatus({ state: 'saving', text: 'Saving…' });
    try {
      const done = await saveInPlace(true);
      if (docRef.current?.key !== d.key) return;
      if (done) setAutoStatus({ state: 'saved', text: `Auto-saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` });
      else setAutoStatus(null);
    } catch (err) {
      if (docRef.current?.key === d.key) setAutoStatus({ state: 'error', text: `Auto-save failed: ${errorText(err)}` });
    } finally {
      autoBusy.current = false;
    }
  };
  const runAutoSaveRef = useRef(runAutoSave);
  runAutoSaveRef.current = runAutoSave;

  function scheduleAutoSave(ms?: number) {
    clearTimeout(autoTimer.current);
    if (!autoSaveRef.current || !docRef.current) return;
    // Studio projects carry their media, so give edits a little longer to settle
    const delay = ms ?? (docRef.current.kind === 'studio' ? 4000 : 1500);
    autoTimer.current = setTimeout(() => void runAutoSaveRef.current(), delay);
  }
  autoSaveKick.current = () => scheduleAutoSave();

  useEffect(() => {
    if (!autoSave) {
      clearTimeout(autoTimer.current);
      setAutoStatus(null);
    } else if (dirtyRef.current) scheduleAutoSave(300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSave]);

  // closing the tab stops a pending auto-save
  useEffect(() => () => clearTimeout(autoTimer.current), []);

  // a new file starts with a clean slate
  const openKey = doc?.key;
  useEffect(() => {
    clearTimeout(autoTimer.current);
    setAutoStatus(null);
  }, [openKey]);

  // Free the in-memory SQLite database when the tab closes or another file replaces it
  useEffect(() => {
    if (doc?.kind !== 'database') return;
    const live = doc.db;
    return () => {
      try {
        live.close();
      } catch {
        /* already closed */
      }
    };
  }, [doc?.kind === 'database' ? doc.key : null]);

  const print = async () => {
    const d = docRef.current;
    if (!d) return;
    setBusy('Preparing to print…');
    try {
      let url: string;
      if (d.kind === 'database') throw new Error('Databases cannot be printed. Export a query result or open a spreadsheet instead.');
      if (d.kind === 'media' || d.kind === 'studio') throw new Error('Video and audio cannot be printed. Save a frame as an image to print it.');
      if (d.kind === 'image' || d.kind === 'proimage') {
        const px = d.kind === 'proimage' ? proImageRef.current!.getPixels() : imageRef.current!.getPixels();
        const { pixelsToCanvas } = await import('./core/media/image-codecs');
        const dataUrl = pixelsToCanvas(px).toDataURL('image/png');
        const html = `<!doctype html><html><head><title>${baseName(d.name)}</title><style>@page{margin:12mm}html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center}img{max-width:100%;max-height:100vh;object-fit:contain}</style></head><body><img src="${dataUrl}"></body></html>`;
        url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      } else if (d.kind === 'flow') {
        const html = await exportFlow(currentFlow()!, 'html');
        url = URL.createObjectURL(new Blob([html as BlobPart], { type: 'text/html' }));
      } else if (d.kind === 'sheet') {
        const active = sheetRef.current?.getActiveSheet();
        if (!active) throw new Error('The spreadsheet is still loading.');
        const rows = active.rows.map((r) => `<tr>${r.map((v) => `<td>${escapeHtml(v)}</td>`).join('')}</tr>`).join('');
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(active.name)}</title><style>@page{margin:12mm}body{font:10pt Calibri,Arial,sans-serif}table{border-collapse:collapse}td{border:1px solid #bbb;padding:2px 6px;white-space:pre-wrap;vertical-align:top}h1{font-size:12pt;margin:0 0 8px}</style></head><body><h1>${escapeHtml(baseName(d.name))} — ${escapeHtml(active.name)}</h1><table>${rows}</table></body></html>`;
        url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      } else if (d.kind === 'code') {
        const text = codeRef.current?.getText() ?? d.text;
        const html = d.language === 'html'
          ? text
          : `<!doctype html><html><head><meta charset="utf-8"><title>${baseName(d.name)}</title><style>pre{white-space:pre-wrap;font:12pt/1.4 Consolas,monospace}</style></head><body><pre>${escapeHtml(text)}</pre></body></html>`;
        url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      } else {
        url = URL.createObjectURL(new Blob([(await pdfBytes(null)) as BlobPart], { type: 'application/pdf' }));
      }
      const frame = document.createElement('iframe');
      frame.className = 'print-frame';
      frame.src = url;
      frame.onload = () => {
        setTimeout(() => {
          try {
            frame.contentWindow?.focus();
            frame.contentWindow?.print();
          } catch {
            window.open(url, '_blank', 'noopener');
          }
          setTimeout(() => {
            frame.remove();
            URL.revokeObjectURL(url);
          }, 60_000);
        }, 250);
      };
      document.body.appendChild(frame);
    } catch (err) {
      toast(`Could not print: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  /** Turns the open PDF into an editable flow document (reflowed text). */
  const convertPdfToFlow = async () => {
    const d = docRef.current;
    if (d?.kind !== 'pdf') return;
    if (!window.confirm('Convert this PDF into an editable document? Text is reflowed into paragraphs; images and exact layout are not kept. The PDF file itself is not changed.')) return;
    setBusy('Converting…');
    try {
      const { importPdfAsFlow } = await import('./core/formats/pdf-import');
      const flow = await importPdfAsFlow(await pdfBytes(null));
      setDoc({ kind: 'flow', key: docKey++, name: `${baseName(d.name)}.docx`, format: 'docx', initial: flow, protection: EMPTY_PROTECTION });
      markDirty();
    } catch (err) {
      toast(`Could not convert: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const frameName = (t: number) => `${baseName(docRef.current?.name ?? 'video')}-frame-${formatTime(t).replace(/[:.]/g, '-')}`;
  const onSaveFrame = (pixels: Pixels, t: number) => setFrameExport({ pixels, name: frameName(t) });
  const onEditFrame = (pixels: Pixels, t: number) => {
    if (dirtyRef.current && !window.confirm('Open this frame in the image editor? Your unsaved video edits will be lost.')) return;
    setDoc({ kind: 'image', key: docKey++, name: `${frameName(t)}.png`, decoded: { pixels, format: 'png', warnings: [] }, format: 'png', protection: EMPTY_PROTECTION });
    markDirty();
  };

  const applySecurity = (v: ProtectionDraft) => {
    setDoc((cur) => (cur ? { ...cur, protection: v } : cur));
    setSecurityOpen(false);
    markDirty();
    toast(v.enabled ? 'Protection set. Save the document to apply it.' : 'Protection removed. Save the document to apply it.', 'info');
  };

  // ── commands from the app shell (menus, shortcuts) ───────────────────────
  const actions = useRef<TabApi>(null!);
  actions.current = {
    save,
    saveAs: () => setExportOpen('save-as'),
    print,
    protect: () => setSecurityOpen(true),
    pause: () => studioRef.current?.stop(),
  };
  useEffect(() => {
    // stable wrappers, so the shell always reaches the latest closures
    register(tabId, {
      save: () => actions.current.save(),
      saveAs: () => actions.current.saveAs(),
      print: () => actions.current.print(),
      protect: () => actions.current.protect(),
      pause: () => actions.current.pause(),
    });
    return () => register(tabId, null);
  }, [register, tabId]);

  // this tab's shortcuts (Ctrl+O / Ctrl+N / tab switching are the shell's)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!activeRef.current || !docRef.current || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        if (e.shiftKey) actions.current.saveAs();
        else void actions.current.save();
      } else if (k === 'p') {
        e.preventDefault();
        void actions.current.print();
      } else if (docRef.current.kind === 'sheet') {
        // the spreadsheet has its own zoom (bottom right) and shortcuts
      } else if (k === '=' || k === '+') {
        e.preventDefault();
        setZoom((z) => ZOOMS.find((v) => v > z + 0.001) ?? z);
      } else if (k === '-') {
        e.preventDefault();
        setZoom((z) => [...ZOOMS].reverse().find((v) => v < z - 0.001) ?? z);
      } else if (k === '0') {
        e.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const format: DocFormat | null = doc
    ? doc.kind === 'pdf'
      ? 'pdf'
      : doc.kind === 'flow' || doc.kind === 'code'
        ? doc.format
        : null
    : null;
  const isMediaDoc = doc?.kind === 'image' || doc?.kind === 'proimage' || doc?.kind === 'media' || doc?.kind === 'studio';
  const isDatabase = doc?.kind === 'database';
  const canSwitchFormat = doc?.kind === 'flow' || doc?.kind === 'code' || doc?.kind === 'sheet';
  const currentFormat: SwitchTarget | null = doc?.kind === 'sheet' ? doc.format : format;
  const formatLabel = format
    ? FORMATS[format].label
    : doc?.kind === 'sheet'
      ? SHEET_FORMATS[doc.format].label
      : doc?.kind === 'database'
      ? 'SQLite database'
      : doc?.kind === 'proimage'
      ? doc.format === 'psd' ? 'Photoshop document' : `${IMAGE_FORMATS[doc.format].label} · layers`
      : doc?.kind === 'image'
      ? `${IMAGE_FORMATS[doc.format].label} image`
      : doc?.kind === 'studio'
      ? 'Studio project'
      : doc?.kind === 'media'
        ? doc.info.hasVideo
          ? 'Video'
          : 'Audio'
        : '';

  const docActions = doc && (
    <>
      <IconButton label={host.canSaveInPlace || host.kind === 'desktop' ? 'Save' : 'Download'} text onClick={save}><Save size={16} /></IconButton>
      <IconButton label={isDatabase ? 'Save as' : 'Save as / Convert'} text onClick={() => (isDatabase ? void saveDatabase(undefined, true) : setExportOpen('save-as'))}><FileDown size={16} /></IconButton>
      {!isMediaDoc && !isDatabase && (
        <IconButton label="Protect" text active={doc.protection.enabled} onClick={() => setSecurityOpen(true)}>
          {doc.protection.enabled ? <ShieldCheck size={16} /> : <LockOpen size={16} />}
        </IconButton>
      )}
      {doc.kind !== 'media' && doc.kind !== 'studio' && doc.kind !== 'database' && <IconButton label="Print" onClick={print}><Printer size={16} /></IconButton>}
      {doc.kind === 'pdf' && (
        <IconButton label="Convert PDF to editable document" onClick={convertPdfToFlow}><Wand2 size={16} /></IconButton>
      )}
      {!isMediaDoc && !isDatabase && doc.kind !== 'code' && doc.kind !== 'sheet' && (
        <>
          <Divider />
          <IconButton label="Zoom out (Ctrl -)" onClick={() => setZoom((z) => [...ZOOMS].reverse().find((v) => v < z - 0.001) ?? z)}><ZoomOut size={16} /></IconButton>
          <select
            className="tb-select zoom-select"
            aria-label="Zoom"
            value={String(zoom)}
            onChange={(e) => setZoom(e.target.value === 'fit' ? fitWidthZoom(zoom, paneRef.current) : parseFloat(e.target.value))}
          >
            <option value="fit">Fit width</option>
            {!ZOOMS.includes(zoom) && <option value={String(zoom)}>{Math.round(zoom * 100)}%</option>}
            {ZOOMS.map((z) => <option key={z} value={String(z)}>{Math.round(z * 100)}%</option>)}
          </select>
          <IconButton label="Zoom in (Ctrl +)" onClick={() => setZoom((z) => ZOOMS.find((v) => v > z + 0.001) ?? z)}><ZoomIn size={16} /></IconButton>
        </>
      )}
    </>
  );

  return (
    <div className="tab-pane" ref={paneRef} hidden={!active}>
      <TabActiveContext.Provider value={activeRef}>
      {active && actionsSlot && docActions && createPortal(docActions, actionsSlot)}
      <main className="main">
        {doc?.kind === 'sheet' && <SheetEditor key={doc.key} ref={sheetRef} initial={doc.workbook} large={doc.large} onChange={markDirty} onError={toast} onNotice={(m) => toast(m, 'info')} />}
        {doc?.kind === 'database' && <DbEditor key={doc.key} ref={dbRef} db={doc.db} onChange={markDirty} onError={toast} />}
        {doc?.kind === 'flow' && (
          <RichEditor key={doc.key} ref={richRef} initial={doc.initial} zoom={zoom} onZoom={setZoom} onChange={markDirty} onStats={setStats} onPageCount={setPageCount} onError={toast} />
        )}
        {doc?.kind === 'code' && (
          <CodeEditor key={doc.key} ref={codeRef} initialText={doc.text} language={doc.language} onChange={markDirty} />
        )}
        {doc?.kind === 'pdf' && (
          <PdfEditor key={doc.key} ref={pdfRef} bytes={doc.bytes} zoom={zoom} onZoom={setZoom} onChange={markDirty} onError={toast} onPageCount={setPageCount} loadAsPdf={loadAsPdf} />
        )}
        {doc?.kind === 'proimage' && (
          <Suspense fallback={<div className="busy" role="status"><span className="spinner" /> Loading the pro editor…</div>}>
            <ProImageEditor key={doc.key} ref={proImageRef} initial={doc.doc} onChange={markDirty} onError={toast} onStatus={setImageStatus} />
          </Suspense>
        )}
        {doc?.kind === 'image' && (
          <ImageEditor key={doc.key} ref={imageRef} initial={doc.decoded} onChange={markDirty} onError={toast} onStatus={setImageStatus} />
        )}
        {doc?.kind === 'studio' && (
          <Suspense fallback={<div className="busy" role="status"><span className="spinner" /> Loading Studio…</div>}>
            <StudioEditor key={doc.key} ref={studioRef} initial={doc.project} blobs={doc.blobs} onChange={markDirty} onError={toast} />
          </Suspense>
        )}
        {doc?.kind === 'media' && (
          <VideoEditor key={doc.key} ref={videoRef} blob={doc.blob} info={doc.info} onChange={markDirty} onError={toast} onSaveFrame={onSaveFrame} onEditFrame={onEditFrame} />
        )}
      </main>

      {doc && (
        <footer className="statusbar">
          {canSwitchFormat ? (
            <Popover
              label="Change format"
              text
              button={<span className="format-switch-label">{formatLabel}</span>}
            >
              {(close) => (
                <div className="format-menu">
                  {PRIMARY_SWITCH.map((id) => {
                    const label = id === 'image' ? 'Blank canvas (PNG)' : FORMATS[id].label;
                    const hint = id === 'image' ? '800×600' : `.${FORMATS[id].ext}`;
                    const active = id !== 'image' && currentFormat === id;
                    return (
                      <MenuItem
                        key={id}
                        hint={hint}
                        disabled={active}
                        onClick={() => {
                          close();
                          void switchFormat(id);
                        }}
                      >
                        {label}
                      </MenuItem>
                    );
                  })}
                  <div className="format-menu-sep" role="separator" />
                  <div className="format-menu-group">Spreadsheets</div>
                  {SHEET_SWITCH.map((id) => (
                    <MenuItem
                      key={id}
                      hint={`.${SHEET_FORMATS[id].ext}`}
                      disabled={currentFormat === id}
                      onClick={() => {
                        close();
                        void switchFormat(id);
                      }}
                    >
                      {SHEET_FORMATS[id].label}
                    </MenuItem>
                  ))}
                  <div className="format-menu-sep" role="separator" />
                  <div className="format-menu-group">More formats</div>
                  {SECONDARY_SWITCH.map((id) => (
                    <MenuItem
                      key={id}
                      hint={`.${FORMATS[id].ext}`}
                      disabled={currentFormat === id}
                      onClick={() => {
                        close();
                        void switchFormat(id);
                      }}
                    >
                      {FORMATS[id].label}
                    </MenuItem>
                  ))}
                </div>
              )}
            </Popover>
          ) : (
            <span>{formatLabel}</span>
          )}
          {doc.kind === 'code' && <span>{doc.language.toUpperCase()}</span>}
          {host.kind === 'desktop' && (doc.kind === 'image' || doc.kind === 'proimage') && (
            <div className="workspace-switch" role="radiogroup" aria-label="Photo workspace">
              <button type="button" role="radio" aria-checked={doc.kind === 'image'} className={doc.kind === 'image' ? 'is-active' : ''} onClick={() => void switchPhotoWorkspace('quick')} title="Crop, adjust, filters, text and drawing on one image">Quick edit</button>
              <button type="button" role="radio" aria-checked={doc.kind === 'proimage'} className={doc.kind === 'proimage' ? 'is-active' : ''} onClick={() => void switchPhotoWorkspace('pro')} title="Layers, masks, adjustment layers, selections, brushes, filters, Photoshop files">Pro</button>
            </div>
          )}
          {host.kind === 'desktop' && (doc.kind === 'media' || (doc.kind === 'studio' && doc.origin)) && (
            <div className="workspace-switch" role="radiogroup" aria-label="Video and audio workspace">
              <button type="button" role="radio" aria-checked={doc.kind === 'media'} className={doc.kind === 'media' ? 'is-active' : ''} onClick={() => void switchVideoWorkspace('quick')} title="Trim, crop, rotate, filters and format conversion of one file">Quick edit</button>
              <button type="button" role="radio" aria-checked={doc.kind === 'studio'} className={doc.kind === 'studio' ? 'is-active' : ''} onClick={() => void switchVideoWorkspace('studio')} title="Multi-track timeline, keyframes, titles, compositing, colour grading, green screen, mixing console, loudness and waveform editing">Studio</button>
            </div>
          )}
          {(doc.kind === 'image' || doc.kind === 'proimage') && imageStatus && <span>{imageStatus.width} × {imageStatus.height} px</span>}
          {doc.kind === 'media' && <span>{formatTime(doc.info.duration, false)}{doc.info.hasVideo ? ` · ${doc.info.width} × ${doc.info.height}` : ''}{doc.info.fps ? ` · ${Math.round(doc.info.fps)} fps` : ''}</span>}
          {doc.kind === 'flow' && stats && <span>{stats.words.toLocaleString()} words · {stats.characters.toLocaleString()} characters</span>}
          {(doc.kind === 'flow' || doc.kind === 'pdf') && pageCount !== null && <span>{pageCount} {pageCount === 1 ? 'page' : 'pages'}</span>}
          {doc.protection.enabled && <span className="status-lock"><Lock size={12} /> Password protected</span>}
          <span className="spacer" />
          <span className={cx('save-state', autoStatus?.state === 'error' && 'is-error')} title={autoStatus?.text} role="status">
            {autoStatus?.state === 'saving' ? 'Saving…' : autoStatus?.state === 'error' ? 'Auto-save failed' : dirty ? 'Unsaved changes' : autoStatus?.state === 'saved' ? autoStatus.text : 'All changes saved'}
          </span>
          <button
            type="button"
            className={cx('autosave-toggle', autoSave && 'is-on', autoSave && autoStatus?.state === 'blocked' && 'is-blocked')}
            aria-pressed={autoSave}
            title={autoSave ? (autoStatus?.state === 'blocked' || autoStatus?.state === 'error' ? autoStatus.text : 'Changes are saved to the file automatically. Click to turn off.') : 'Auto-save is off. Click to save changes automatically.'}
            onClick={onToggleAutoSave}
          >
            Auto-save {autoSave ? 'on' : 'off'}
          </button>
          {autoSave && autoStatus?.state === 'blocked' && dirty && <span className="autosave-hint">{autoStatus.text}</span>}
        </footer>
      )}

      {busy && (
        <div className="busy" role="status">
          <span className="spinner" /> {busy}
        </div>
      )}
      {askPw && (
        <PasswordModal
          fileName={askPw.fileName}
          message={askPw.message}
          incorrect={askPw.incorrect}
          onClose={() => { askPw.resolve(null); setAskPw(null); }}
          onSubmit={(pw) => { askPw.resolve(pw); setAskPw(null); }}
        />
      )}
      {exportOpen && doc?.kind === 'proimage' && (
        <ImageExportModal
          allowPsd
          // layered work defaults to .psd so Save As never flattens it by surprise
          initialFormat="psd"
          initialName={baseName(doc.name)}
          width={imageStatus?.width ?? doc.doc.width}
          height={imageStatus?.height ?? doc.doc.height}
          onClose={() => setExportOpen(null)}
          onSubmit={(c) => {
            setExportOpen(null);
            void saveImage(c, undefined, true);
          }}
        />
      )}
      {exportOpen && doc?.kind === 'image' && (
        <ImageExportModal
          initialFormat={IMAGE_FORMATS[doc.format].canWrite ? (doc.format as ImageExportChoice['format']) : 'jpeg'}
          initialName={baseName(doc.name)}
          width={imageStatus?.width ?? doc.decoded.pixels.width}
          height={imageStatus?.height ?? doc.decoded.pixels.height}
          onClose={() => setExportOpen(null)}
          onSubmit={(c) => {
            setExportOpen(null);
            void saveImage(c, undefined, true);
          }}
        />
      )}
      {exportOpen && doc?.kind === 'studio' && (() => {
        const sp = studioRef.current?.getProject() ?? doc.project;
        return (
          <Suspense fallback={null}>
            <StudioExportModal
              hasVideo={sp.tracks.some((t) => t.kind === 'video' && t.clips.length > 0)}
              width={sp.width}
              height={sp.height}
              fps={sp.fps}
              loudnessTarget={sp.master.loudnessTarget}
              initialName={baseName(doc.name)}
              initialContainer={doc.origin?.container ?? 'mp4'}
              onClose={() => setExportOpen(null)}
              onSubmit={(c) => {
                setExportOpen(null);
                void saveStudio(c);
              }}
            />
          </Suspense>
        );
      })()}
      {exportOpen && doc?.kind === 'media' && (() => {
        const e = videoRef.current?.getEdits();
        const r = e ? rotatedSize(doc.info, e) : { width: doc.info.width, height: doc.info.height };
        return (
          <MediaExportModal
            info={doc.info}
            outWidth={Math.round(e?.crop?.width ?? r.width)}
            outHeight={Math.round(e?.crop?.height ?? r.height)}
            initialContainer={doc.container}
            initialName={baseName(doc.name)}
            onClose={() => setExportOpen(null)}
            onSubmit={(c) => {
              setExportOpen(null);
              void saveMedia(c);
            }}
          />
        );
      })()}
      {frameExport && (
        <ImageExportModal
          title="Save frame as image"
          initialFormat="png"
          initialName={frameExport.name}
          width={frameExport.pixels.width}
          height={frameExport.pixels.height}
          onClose={() => setFrameExport(null)}
          onSubmit={(c) => {
            const px = frameExport.pixels;
            setFrameExport(null);
            void saveImage(c, undefined, false, px);
          }}
        />
      )}
      {progress && <ProgressModal title={progress.title} phase={progress.phase} progress={progress.progress} onCancel={progress.cancel} />}
      {exportOpen && doc && format && (doc.kind === 'flow' || doc.kind === 'code' || doc.kind === 'pdf') && (
        <ExportModal
          title="Save as / Convert"
          sourceKind={doc.kind === 'pdf' ? 'pdf' : 'flow'}
          initialFormat={format}
          initialName={baseName(doc.name)}
          initialProtection={doc.protection}
          onClose={() => setExportOpen(null)}
          onSubmit={(choice) => {
            setExportOpen(null);
            const sameKind = doc.kind === 'pdf' ? choice.format === 'pdf' : choice.format !== 'pdf';
            void writeOut(choice, undefined, sameKind);
          }}
        />
      )}
      {exportOpen && doc?.kind === 'sheet' && (() => {
        const active = sheetRef.current?.getActiveSheet();
        return (
          <SheetExportModal
            initialFormat={doc.format}
            initialName={baseName(doc.name)}
            initialProtection={doc.protection}
            sheetCount={active?.sheetCount ?? 1}
            activeSheet={active?.name ?? 'Sheet1'}
            onClose={() => setExportOpen(null)}
            onSubmit={(c) => {
              setExportOpen(null);
              void saveSheet(c, undefined, true);
            }}
            onDatabase={(fileName) => {
              setExportOpen(null);
              void startSheetToDatabase(fileName);
            }}
          />
        );
      })()}
      {headerAsk && doc?.kind === 'sheet' && (
        <SheetHeadersModal
          plans={headerAsk.plans}
          namesFor={(plan, row) => columnsFromRow(headerAsk.workbook, plan, row)}
          onClose={() => setHeaderAsk(null)}
          onSubmit={(plans) => {
            const ask = headerAsk;
            setHeaderAsk(null);
            void sheetToDatabase(ask.workbook, plans, ask.fileName);
          }}
        />
      )}
      {securityOpen && doc?.kind === 'sheet' && (
        <SheetSecurityModal format={doc.format} initial={doc.protection} onClose={() => setSecurityOpen(false)} onApply={applySecurity} />
      )}
      {securityOpen && doc && format && (doc.kind === 'flow' || doc.kind === 'code' || doc.kind === 'pdf') && (
        <SecurityModal format={format} initial={doc.protection} onClose={() => setSecurityOpen(false)} onApply={applySecurity} />
      )}
      </TabActiveContext.Provider>
    </div>
  );
}

// ── the app shell: tabs, home screen, menus, drag & drop, updates ────────
interface TabEntry {
  id: number;
  start: TabStart;
  info: TabInfo;
}

let tabSeq = 1;

function tabIcon(kind: TabInfo['kind']) {
  switch (kind) {
    case 'sheet':
      return <SheetIcon size={14} />;
    case 'database':
      return <Database size={14} />;
    case 'image':
    case 'proimage':
      return <ImageIcon size={14} />;
    case 'media':
    case 'studio':
      return <Film size={14} />;
    case 'code':
      return <FileCode size={14} />;
    default:
      return <FileText size={14} />;
  }
}

const startName = (start: TabStart) => (start.kind === 'open' ? start.file.name : start.kind === 'new-sheet' ? 'Untitled.xlsx' : 'Untitled.docx');

export default function App() {
  const host = getHost();
  const [tabs, setTabs] = useState<TabEntry[]>([]);
  /** the tab on screen; null shows the home screen (open tabs stay open behind it) */
  const [activeId, setActiveId] = useState<number | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const apis = useRef(new Map<number, TabApi>());
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [help, setHelp] = useState<{ section: string | null } | null>(helpFromHash);
  useEffect(() => {
    const onHelp = (e: Event) => setHelp({ section: (e as CustomEvent<string | null>).detail ?? null });
    const onHash = () => {
      const h = helpFromHash();
      if (h) setHelp(h);
    };
    window.addEventListener('fe:help', onHelp);
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('fe:help', onHelp);
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
  const [dragging, setDragging] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  /** the update state the user closed the banner on (it comes back for a new state or a manual check) */
  const [updateDismissed, setUpdateDismissed] = useState<UpdateStatus['state'] | null>(null);
  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const anyDirty = tabs.some((t) => t.info.dirty);
  const anyDirtyRef = useRef(anyDirty);
  anyDirtyRef.current = anyDirty;

  const toast = useCallback((text: string, kind: Toast['kind'] = 'error') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : Math.min(12000, Math.max(3500, text.length * 45)));
  }, []);

  // ── tabs ──────────────────────────────────────────────────────────────────
  const activate = (id: number | null) => {
    const cur = activeIdRef.current;
    if (cur !== null && cur !== id) apis.current.get(cur)?.pause();
    setActiveId(id);
  };

  const openTab = (start: TabStart) => {
    const id = tabSeq++;
    setTabs((ts) => [...ts, { id, start, info: { name: startName(start), dirty: false, locked: false, kind: null } }]);
    activate(id);
  };

  const closeTab = useCallback((id: number, force = false) => {
    const all = tabsRef.current;
    const i = all.findIndex((t) => t.id === id);
    if (i < 0) return;
    const t = all[i];
    if (!force && t.info.dirty && !window.confirm(`Close ${t.info.name}? Your unsaved changes will be lost.`)) return;
    const rest = all.filter((x) => x.id !== id);
    tabsRef.current = rest;
    setTabs(rest);
    if (activeIdRef.current === id) setActiveId((rest[i] ?? rest[i - 1])?.id ?? null);
  }, []);

  const onInfo = useCallback((id: number, info: TabInfo) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, info } : t)));
  }, []);
  const onEmpty = useCallback((id: number) => closeTab(id, true), [closeTab]);
  const register = useCallback((id: number, api: TabApi | null) => {
    if (api) apis.current.set(id, api);
    else apis.current.delete(id);
  }, []);

  const openFile = (file: OpenedFile) => openTab({ kind: 'open', file });
  const newDocument = () => openTab({ kind: 'new' });
  const newSpreadsheet = () => openTab({ kind: 'new-sheet' });

  const pickAndOpen = async () => {
    try {
      const extensions = host.kind === 'desktop' ? [...ALL_OPEN_EXTENSIONS, 'psd', 'fstudio'] : ALL_OPEN_EXTENSIONS;
      const files = await host.openFiles({ extensions, multiple: true, description: 'Documents, spreadsheets, databases, images, video & audio' });
      files.forEach(openFile);
    } catch (err) {
      toast(errorText(err));
    }
  };

  // ── window title / unsaved changes ───────────────────────────────────────
  const activeInfo = activeTab?.info;
  useEffect(() => {
    host.setTitle?.(activeInfo ? `${activeInfo.dirty ? '• ' : ''}${activeInfo.name} — File Editor` : 'File Editor');
  }, [activeInfo, host]);

  useEffect(() => {
    // desktop: the window asks before closing with unsaved changes in any tab
    host.setDirty?.(anyDirty);
  }, [anyDirty, host]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (anyDirtyRef.current && host.kind === 'web') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [host]);

  // ── auto-save setting (each tab saves its own file) ──────────────────────
  const [autoSave, setAutoSave] = useState(() => {
    try {
      return localStorage.getItem('fe.autosave') !== 'off';
    } catch {
      return true;
    }
  });
  const toggleAutoSave = useCallback(() => setAutoSave((v) => !v), []);
  useEffect(() => {
    try {
      localStorage.setItem('fe.autosave', autoSave ? 'on' : 'off');
    } catch {
      /* storage blocked */
    }
    host.setAutoSave?.(autoSave);
  }, [autoSave, host]);

  // ── recent files ─────────────────────────────────────────────────────────
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  useEffect(() => {
    const r = host.recent;
    if (!r) return;
    const load = () => void r.list().then(setRecents, () => setRecents([]));
    load();
    return r.onChange(load);
  }, [host]);
  const openRecent = async (id: string) => {
    try {
      openFile(await host.recent!.open(id));
    } catch (err) {
      toast(errorText(err));
    }
  };
  const removeRecent = (id: string) => {
    setRecents((rs) => rs.filter((r) => r.id !== id));
    void host.recent?.remove(id).catch(() => undefined);
  };

  // ── desktop updates: a newer version downloads in the background (with progress); offer to
  // restart into it. Help → Check for Updates also reports "checking", "up to date" and errors.
  useEffect(() => {
    const off = window.desktop?.onUpdateStatus?.((st) => {
      if (st.manual) setUpdateDismissed(null);
      if (st.state === 'none') {
        if (st.manual) toast(`You're up to date — File Editor ${st.version ?? ''} is the latest version.`, 'info');
        setUpdate(null);
        return;
      }
      // background checks stay quiet until there is something to download; their errors are only logged
      if ((st.state === 'checking' || st.state === 'error') && !st.manual) {
        setUpdate((cur) => (cur?.state === 'ready' ? cur : null));
        return;
      }
      setUpdate(st);
    });
    return () => off?.();
  }, [toast]);

  // ── shortcuts, OS file-open events, native menu ──────────────────────────
  const shell = useRef({ pickAndOpen, newDocument, newSpreadsheet, openFile, closeTab, activate });
  shell.current = { pickAndOpen, newDocument, newSpreadsheet, openFile, closeTab, activate };

  useEffect(() => {
    const cycle = (step: number) => {
      const ts = tabsRef.current;
      if (!ts.length) return;
      const i = ts.findIndex((t) => t.id === activeIdRef.current);
      const next = i < 0 ? (step > 0 ? 0 : ts.length - 1) : (i + step + ts.length) % ts.length;
      shell.current.activate(ts[next].id);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F1' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // opens the guide at the page for the kind of file in front of you
        e.preventDefault();
        const kind = tabsRef.current.find((t) => t.id === activeIdRef.current)?.info.kind ?? null;
        setHelp((h) => h ?? { section: kind ? GUIDE_FOR_KIND[kind] : null });
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'o') {
        e.preventDefault();
        void shell.current.pickAndOpen();
      } else if (k === 'n' && !e.shiftKey && host.kind === 'desktop') {
        e.preventDefault();
        shell.current.newDocument();
      } else if (host.kind === 'desktop' && k === 'w' && !e.shiftKey) {
        // browsers keep Ctrl+W (it closes the browser tab), so only the desktop app takes it
        e.preventDefault();
        if (activeIdRef.current !== null) shell.current.closeTab(activeIdRef.current);
      } else if (host.kind === 'desktop' && k === 'tab') {
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
      } else if (host.kind === 'desktop' && (k === 'pagedown' || k === 'pageup')) {
        e.preventDefault();
        cycle(k === 'pagedown' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', onKey);
    const offOpen = host.onOpenRequest((f) => shell.current.openFile(f));
    const offMenu = host.onMenuCommand((cmd) => {
      const s = shell.current;
      if (cmd === 'new') s.newDocument();
      else if (cmd === 'new-spreadsheet') s.newSpreadsheet();
      else if (cmd === 'open') void s.pickAndOpen();
      else if (cmd === 'license') setLicenseOpen(true);
      else if (cmd === 'toggle-autosave') setAutoSave((v) => !v);
      else if (cmd === 'help' || cmd === 'help:context') {
        const kind = tabsRef.current.find((t) => t.id === activeIdRef.current)?.info.kind ?? null;
        setHelp({ section: cmd === 'help:context' && kind ? GUIDE_FOR_KIND[kind] : null });
      } else if (cmd.startsWith('help:')) setHelp({ section: cmd.slice(5) });
      else {
        const api = activeIdRef.current !== null ? apis.current.get(activeIdRef.current) : undefined;
        if (!api) return;
        if (cmd === 'save') void api.save();
        else if (cmd === 'save-as') api.saveAs();
        else if (cmd === 'print') void api.print();
        else if (cmd === 'protect') api.protect();
      }
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      offOpen();
      offMenu();
    };
  }, [host]);

  // ── drag & drop files onto the window: each opens in its own tab ─────────
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const isDocDrop = (e: DragEvent) => hasFiles(e) && !(e.target as HTMLElement)?.closest?.('.ProseMirror');
    const onEnter = (e: DragEvent) => {
      if (!isDocDrop(e)) return;
      depth++;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      depth = 0;
      setDragging(false);
      if (!hasFiles(e)) return;
      // never let the browser navigate to a dropped file (that would lose unsaved work)
      e.preventDefault();
      // drops on the text are handled by the editor itself (images are embedded)
      if ((e.target as HTMLElement)?.closest?.('.ProseMirror')) return;
      // file handles must be requested during the drop event (Chrome/Edge): they let Save write back
      type HandleItem = DataTransferItem & { getAsFileSystemHandle?(): Promise<FileSystemHandle | null> };
      const items = Array.from(e.dataTransfer?.items ?? []).filter((i) => i.kind === 'file') as HandleItem[];
      const dropped = items.length
        ? items.map((item) => ({ file: item.getAsFile(), handleP: host.kind === 'web' && host.canSaveInPlace ? (item.getAsFileSystemHandle?.() ?? null) : null }))
        : Array.from(e.dataTransfer?.files ?? []).map((file) => ({ file, handleP: null }));
      for (const { file, handleP } of dropped) {
        if (file) shell.current.openFile(await readDroppedFile(file, handleP));
      }
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [host]);

  return (
    <div className={cx('app', `host-${host.kind}`)}>
      <header className="topbar">
        <button
          type="button"
          className={cx('brand', activeId === null && 'is-home')}
          onClick={() => activate(null)}
          title={tabs.length ? 'Home (your open files stay open)' : 'Home'}
          aria-label="File Editor home"
        >
          <FileText size={18} />
          <span>File Editor</span>
        </button>
        <nav className="topbar-actions" aria-label="File">
          <IconButton label="New" text onClick={newDocument}><FilePlus size={16} /></IconButton>
          <IconButton label="Open" text onClick={pickAndOpen}><FolderOpen size={16} /></IconButton>
          {host.recent && (
            <Popover label="Open recent" text align="left" button={<><History size={16} /><span>Recent</span></>}>
              {(close) => (
                <div className="format-menu recent-menu" role="menu" aria-label="Recent files">
                  {recents.length === 0 && <div className="menu-empty">No recent files yet</div>}
                  {recents.map((r) => (
                    <div key={r.id} className="recent-row">
                      <MenuItem hint={r.folder || undefined} onClick={() => { close(); void openRecent(r.id); }}>
                        {r.name}
                      </MenuItem>
                      <button
                        type="button"
                        className="recent-remove"
                        title="Remove from recent files"
                        aria-label={`Remove ${r.name} from recent files`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => removeRecent(r.id)}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  {recents.length > 0 && (
                    <>
                      <div className="menu-sep" role="separator" />
                      <MenuItem onClick={() => { close(); void host.recent!.clear(); }}>Clear recent files</MenuItem>
                    </>
                  )}
                </div>
              )}
            </Popover>
          )}
          {/* the active tab's own buttons (Save, Print, zoom…) are rendered here */}
          <span className="topbar-doc-actions" ref={setActionsSlot} />
          <Popover label="Help" text align="right" button={<><CircleHelp size={16} /><span>Help</span></>}>
            {(close) => {
              const item = (label: string, section: string | null, hint?: string) => (
                <MenuItem key={label} hint={hint} onClick={() => { close(); setHelp({ section }); }}>{label}</MenuItem>
              );
              return (
                <div className="format-menu help-menu" role="menu" aria-label="Help">
                  {item('User guide', null, 'F1')}
                  <div className="menu-sep" role="separator" />
                  {item('Opening, saving & auto-save', 'saving')}
                  {item('Documents & PDFs', 'documents')}
                  {item('Photos', 'photo-quick')}
                  {item('Video & audio', 'video-quick')}
                  {item('Studio: video & sound editing', 'studio', host.kind === 'desktop' ? undefined : 'Desktop app')}
                  {item('Studio: keyframe animation', 'studio-keyframes')}
                  {item('Studio: mixing console', 'studio-mixer')}
                  {item('Pro Photo: layers & masks', 'photo-pro', host.kind === 'desktop' ? undefined : 'Desktop app')}
                  <div className="menu-sep" role="separator" />
                  {item('Keyboard shortcuts', 'shortcuts')}
                  {item('Troubleshooting', 'troubleshooting')}
                  {host.kind === 'desktop' && (
                    <>
                      <div className="menu-sep" role="separator" />
                      <MenuItem onClick={() => { close(); setLicenseOpen(true); }}>License…</MenuItem>
                      <MenuItem onClick={() => { close(); window.desktop?.checkForUpdates?.(); }}>Check for updates</MenuItem>
                    </>
                  )}
                </div>
              );
            }}
          </Popover>
        </nav>
      </header>

      {tabs.length > 0 && (
        <div className="tabbar" role="tablist" aria-label="Open files">
          {tabs.map((t) => (
            <div
              key={t.id}
              role="tab"
              tabIndex={0}
              aria-selected={t.id === activeId}
              className={cx('tab', t.id === activeId && 'is-active', t.info.dirty && 'is-dirty')}
              title={t.info.name}
              onClick={() => activate(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  activate(t.id);
                }
              }}
              onMouseDown={(e) => {
                // middle-click closes (and must not start the browser's auto-scroll)
                if (e.button === 1) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(t.id);
                }
              }}
            >
              <span className="tab-icon">{tabIcon(t.info.kind)}</span>
              {t.info.locked && <Lock size={12} aria-label="Password protected" />}
              <span className="tab-name">{t.info.name}</span>
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${t.info.name}`}
                title={t.info.dirty ? 'Unsaved changes. Close' : 'Close'}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                <span className="tab-dirty" aria-hidden />
                <X size={13} />
              </button>
            </div>
          ))}
          <button type="button" className="tab-new" title="New document" aria-label="New document" onClick={newDocument}>
            <Plus size={15} />
          </button>
        </div>
      )}

      {activeId === null && (
        <main className="main">
          <StartScreen
            onNew={newDocument}
            onOpen={pickAndOpen}
            recents={host.recent ? recents : null}
            onOpenRecent={(id) => void openRecent(id)}
            onRemoveRecent={removeRecent}
            openTabs={tabs.map((t) => ({ id: t.id, name: t.info.name, dirty: t.info.dirty, kind: t.info.kind }))}
            onShowTab={activate}
            onHelp={() => setHelp({ section: null })}
            showDesktopDownload={host.kind === 'web'}
            onToast={toast}
          />
        </main>
      )}
      {tabs.map((t) => (
        <DocumentTab
          key={t.id}
          id={t.id}
          active={t.id === activeId}
          start={t.start}
          toast={toast}
          autoSave={autoSave}
          onToggleAutoSave={toggleAutoSave}
          actionsSlot={actionsSlot}
          onInfo={onInfo}
          onEmpty={onEmpty}
          register={register}
        />
      ))}

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <Upload size={36} />
          <p>Drop to open</p>
        </div>
      )}
      {update && update.state !== 'ready' && updateDismissed !== update.state && (
        <div className={cx('update-banner', update.state === 'error' && 'update-error')} role={update.state === 'error' ? 'alert' : 'status'}>
          {update.state === 'checking' && (
            <>
              <span className="spinner" />
              <span>Checking for updates…</span>
            </>
          )}
          {(update.state === 'available' || update.state === 'downloading') && (
            <>
              <Download size={16} />
              <div className="update-progress">
                <span>
                  Downloading version {update.version ?? 'update'}… {update.percent ?? 0}%
                  {update.speed ? <span className="update-speed"> · {formatSpeed(update.speed)}</span> : null}
                </span>
                <progress max={100} value={update.percent ?? 0} aria-label="Update download progress" />
              </div>
            </>
          )}
          {update.state === 'error' && (
            <>
              <AlertTriangle size={16} />
              <span className="update-message">Couldn't update: {update.message ?? 'unknown error'}</span>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => window.desktop?.checkForUpdates?.()}>
                Retry
              </button>
            </>
          )}
          <button
            type="button"
            className="btn btn-text"
            onClick={() => setUpdateDismissed(update.state)}
            title={update.state === 'downloading' || update.state === 'available' ? 'The download continues in the background' : undefined}
          >
            {update.state === 'error' ? 'Close' : 'Hide'}
          </button>
        </div>
      )}
      {update?.state === 'ready' && updateDismissed !== 'ready' && (
        <div className="update-banner" role="status">
          <RefreshCw size={16} />
          <span>Version {update.version} is ready to install.</span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              if (anyDirtyRef.current && !window.confirm('Restart now? Unsaved changes in your open files will be lost.')) return;
              window.desktop?.installUpdate?.();
            }}
          >
            Restart now
          </button>
          <button type="button" className="btn btn-text" onClick={() => setUpdateDismissed('ready')} title="It will install the next time you close the app">
            Later
          </button>
        </div>
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx('toast', `toast-${t.kind}`)} onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
            {t.text}
          </div>
        ))}
      </div>
      {licenseOpen && host.kind === 'desktop' && <LicenseDialog onClose={() => setLicenseOpen(false)} />}
      {help && (
        <Suspense fallback={<div className="busy" role="status"><span className="spinner" /> Opening the guide…</div>}>
          <HelpGuide section={help.section} desktop={host.kind === 'desktop'} onClose={() => setHelp(null)} />
        </Suspense>
      )}
    </div>
  );
}

function StartScreen({
  onNew,
  onOpen,
  recents,
  onOpenRecent,
  onRemoveRecent,
  openTabs,
  onShowTab,
  onHelp,
  showDesktopDownload,
  onToast,
}: {
  onNew: () => void;
  onOpen: () => void;
  recents: RecentEntry[] | null;
  onOpenRecent: (id: string) => void;
  onRemoveRecent: (id: string) => void;
  openTabs: { id: number; name: string; dirty: boolean; kind: TabInfo['kind'] }[];
  onShowTab: (id: number) => void;
  onHelp: () => void;
  showDesktopDownload: boolean;
  onToast: (text: string, kind?: 'error' | 'info') => void;
}) {
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [installerChoices, setInstallerChoices] = useState<{ version: string; options: InstallerOption[] } | null>(null);

  const downloadDesktop = async () => {
    if (downloadBusy) return;
    setDownloadBusy(true);
    try {
      const latest = await fetchLatestInstallers();
      const os = detectDesktopOs();
      const options = installersForOs(latest, os);
      if (!options.length) {
        onToast(os === 'mac' ? 'No macOS installer is in the latest release yet.' : os === 'windows' ? 'No Windows installer is in the latest release yet.' : 'No desktop installers are in the latest release yet.', 'error');
        return;
      }
      if (options.length === 1) {
        startInstallerDownload(options[0].url);
        onToast(`Downloading File Editor ${latest.version}…`, 'info');
        return;
      }
      setInstallerChoices({ version: latest.version, options });
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Could not look up the desktop download.', 'error');
    } finally {
      setDownloadBusy(false);
    }
  };

  const os = showDesktopDownload ? detectDesktopOs() : 'other';
  const downloadLabel =
    os === 'mac' ? 'Download for Mac' : os === 'windows' ? 'Download for Windows' : 'Download desktop app';

  return (
    <div className="start">
      <div className="start-inner">
        <h1>File Editor</h1>
        <p className="start-lead">Create, edit, convert and protect documents, spreadsheets, photos, video and audio. Everything runs on your device; no file is uploaded.</p>
        <div className="start-actions">
          <button type="button" className="start-guide" onClick={onHelp}>
            <BookOpen size={16} /> New here? Read the user guide <span>F1</span>
          </button>
          {showDesktopDownload && (
            <button
              type="button"
              className="start-guide start-download"
              onClick={() => void downloadDesktop()}
              disabled={downloadBusy}
              title="Install the desktop app for Auto-save, native menus, Studio, Pro photo tools and offline use"
            >
              <Download size={16} />
              {downloadBusy ? 'Checking…' : downloadLabel}
            </button>
          )}
        </div>
        <div className="start-cards">
          <button type="button" className="start-card" onClick={onNew}>
            <FilePlus size={28} />
            <strong>Blank document</strong>
            <span>Starts as Word (.docx) — use the format label in the status bar to switch to a spreadsheet (Excel, CSV), text, HTML, CSS, JS, PDF or a blank canvas</span>
          </button>
          <button type="button" className="start-card" onClick={onOpen}>
            <FolderOpen size={28} />
            <strong>Open a file</strong>
            <span>Documents, spreadsheets, photos, video or audio — or drag one onto this window</span>
          </button>
        </div>
        {openTabs.length > 0 && (
          <div className="start-recent start-open">
            <h2><FileText size={15} /> Open files</h2>
            <ul>
              {openTabs.map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => onShowTab(t.id)}>
                    <span className="start-recent-icon">{tabIcon(t.kind)}</span>
                    <span className="start-recent-name">{t.name}</span>
                    {t.dirty && <span className="start-recent-folder">Unsaved changes</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {recents && recents.length > 0 && (
          <div className="start-recent">
            <h2><History size={15} /> Recent files</h2>
            <ul>
              {recents.slice(0, 8).map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => onOpenRecent(r.id)}>
                    <span className="start-recent-name">{r.name}</span>
                    {r.folder && <span className="start-recent-folder">{r.folder}</span>}
                  </button>
                  <button
                    type="button"
                    className="recent-remove"
                    title="Remove from recent files"
                    aria-label={`Remove ${r.name} from recent files`}
                    onClick={() => onRemoveRecent(r.id)}
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="start-formats">
          <h2>Supported formats</h2>
          <table>
            <tbody>
              <tr><th>Edit</th><td>Word (.docx, .doc), PDF, OpenDocument (.odt), Rich Text (.rtf), Markdown, HTML, CSS, JavaScript, plain text</td></tr>
              <tr><th><SheetIcon size={14} /> Spreadsheets</th><td>Excel (.xlsx, .xlsm), CSV, TSV — formulas (400+ functions), formatting, number formats, merge, freeze panes, sort, filter, find &amp; replace, multiple sheets</td></tr>
              <tr><th><Database size={14} /> Databases</th><td>SQLite (.sqlite, .sqlite3, .db, .db3) — browse tables and views, edit cells, add or delete rows, run SQL; everything stays on this device</td></tr>
              <tr><th>PDF</th><td>Edit existing text, add text, images, links, shapes and drawings; insert, delete, reorder and rotate pages; merge files</td></tr>
              <tr><th><ImageIcon size={14} /> Photos</th><td>JPEG, PNG, WebP, AVIF, HEIC (iPhone), JPEG XL, GIF, TIFF, BMP, ICO, SVG — crop, rotate, resize, adjust colour, filters, text, drawing, redact faces or plates</td></tr>
              <tr><th><Film size={14} /> Video &amp; audio</th><td>MP4, MOV, WebM, MKV, AVI, WMV, FLV, MPEG, 3GP, MP3, M4A, WAV, FLAC, OGG and more — trim, crop, rotate, resize, colour, text, fades, volume, extract sound, GIFs</td></tr>
              <tr><th>Convert</th><td>Save any file in any format of its kind: documents ↔ documents, photo ↔ photo (or PDF), video ↔ video ↔ audio</td></tr>
              <tr><th>Protect</th><td>Open and save password-protected Word, Excel and PDF files</td></tr>
            </tbody>
          </table>
        </div>
        {showDesktopDownload && (
          <p className="start-license">
            Need a license for the desktop app?{' '}
            <a href={LICENSE_PURCHASE_URL} target="_blank" rel="noopener noreferrer">
              Purchase a license
            </a>
          </p>
        )}
      </div>
      {installerChoices && (
        <Modal
          title={`Download File Editor ${installerChoices.version}`}
          onClose={() => setInstallerChoices(null)}
          width={440}
          footer={
            <>
              <span className="spacer" />
              <button type="button" className="btn btn-text" onClick={() => setInstallerChoices(null)}>
                Cancel
              </button>
            </>
          }
        >
          <p className="dialog-text">Choose which installer to download:</p>
          <div className="installer-choices">
            {installerChoices.options.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className="installer-choice"
                onClick={() => {
                  startInstallerDownload(opt.url);
                  setInstallerChoices(null);
                  onToast(`Downloading ${opt.label}…`, 'info');
                }}
              >
                <Download size={18} />
                <span>
                  <strong>{opt.label}</strong>
                  <span className="installer-choice-hint">{opt.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
