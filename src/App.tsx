import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FileDown,
  FilePlus,
  FileText,
  FolderOpen,
  Lock,
  LockOpen,
  Printer,
  Save,
  ShieldCheck,
  Upload,
  Wand2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { baseName, exportFlow, FORMATS, OPEN_EXTENSIONS, openDocument, type OpenResult } from './core/registry';
import { buildPdf } from './core/pdf/apply-edits';
import type { PdfProtection } from './core/pdf/types';
import { PasswordError, UnsupportedError, type DocFormat, type FlowFormat, type RichDocument } from './core/types';
import { getHost, readDroppedFile, type OpenedFile } from './platform/host';
import { IconButton, Divider, cx } from './ui/components';
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
import { PdfEditor, type PdfEditorHandle } from './ui/pdf/PdfEditor';

type OpenDoc =
  | { kind: 'flow'; key: number; name: string; format: FlowFormat; initial: RichDocument; handle?: unknown; protection: ProtectionDraft }
  | { kind: 'pdf'; key: number; name: string; bytes: Uint8Array; handle?: unknown; protection: ProtectionDraft };

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

const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
let docKey = 1;

const BLANK: RichDocument = { html: '<p></p>', title: 'Untitled' };

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

export default function App() {
  const host = getHost();
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [dirty, setDirty] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [askPw, setAskPw] = useState<PasswordAsk | null>(null);
  const [exportOpen, setExportOpen] = useState<null | 'save-as' | 'export'>(null);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [stats, setStats] = useState<{ words: number; characters: number } | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const richRef = useRef<RichEditorHandle>(null);
  const pdfRef = useRef<PdfEditorHandle>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const toast = useCallback((text: string, kind: Toast['kind'] = 'error') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);

  const markDirty = useCallback(() => setDirty(true), []);

  // ── window title / dirty tracking ────────────────────────────────────────
  useEffect(() => {
    const title = doc ? `${dirty ? '• ' : ''}${doc.name} — Document Editor` : 'Document Editor';
    host.setTitle?.(title);
    host.setDirty?.(dirty);
  }, [doc, dirty, host]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current && host.kind === 'web') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [host]);

  const confirmDiscard = () => !dirtyRef.current || window.confirm('You have unsaved changes. Discard them?');

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
        const result = await openDocument(file.name, file.bytes, password);
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

  const openFile = async (file: OpenedFile) => {
    if (!confirmDiscard()) return;
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

  const pickAndOpen = async () => {
    try {
      const [file] = await host.openFiles({ extensions: OPEN_EXTENSIONS, description: 'Documents' });
      if (file) await openFile(file);
    } catch (err) {
      toast(errorText(err));
    }
  };

  const newDocument = () => {
    if (!confirmDiscard()) return;
    setDoc({ kind: 'flow', key: docKey++, name: 'Untitled.docx', format: 'docx', initial: { ...BLANK }, protection: EMPTY_PROTECTION });
    setDirty(false);
    setStats(null);
  };

  /** Converts any picked file into PDF bytes, for inserting its pages into the open PDF. */
  const loadAsPdf = async (file: OpenedFile): Promise<Uint8Array | null> => {
    const opened = await openWithPrompt(file);
    if (!opened) return null;
    if (opened.result.kind === 'pdf') return opened.result.bytes;
    setBusy('Converting to PDF…');
    try {
      return await exportFlow(opened.result.doc, 'pdf');
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
    const pdfProt = protectionToPdf(protection);
    const pw = protection.enabled ? protection.password : undefined;
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

  const writeOut = async (choice: ExportChoice, handle: unknown | undefined, adopt: boolean) => {
    const d = docRef.current;
    if (!d) return;
    setBusy('Saving…');
    try {
      const bytes = await render(choice.format, choice.protection);
      const info = FORMATS[choice.format];
      const res = await host.save({ suggestedName: choice.fileName, bytes, mime: info.mime, ext: info.ext, description: info.label, handle });
      if (!res) return;
      if (adopt) {
        setDoc((cur) => {
          if (!cur) return cur;
          if (cur.kind === 'flow' && choice.format !== 'pdf') {
            return { ...cur, name: res.name, format: choice.format as FlowFormat, handle: res.handle, protection: choice.protection };
          }
          if (cur.kind === 'pdf' && choice.format === 'pdf') {
            return { ...cur, name: res.name, handle: res.handle, protection: choice.protection };
          }
          return cur;
        });
        setDirty(false);
      }
      const lock = choice.protection.enabled && info.canProtect ? ' (password protected)' : '';
      toast(host.canSaveInPlace || host.kind === 'desktop' ? `Saved ${res.name}${lock}` : `Downloaded ${res.name}${lock}`, 'info');
    } catch (err) {
      toast(`Could not save: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    const d = docRef.current;
    if (!d) return;
    const format: DocFormat = d.kind === 'pdf' ? 'pdf' : d.format;
    if (d.handle && host.canSaveInPlace) {
      await writeOut({ format, fileName: d.name, protection: d.protection }, d.handle, true);
    } else if (host.kind === 'web' && !host.canSaveInPlace) {
      // browsers without the File System Access API: Save = download in the current format
      await writeOut({ format, fileName: d.name, protection: d.protection }, undefined, true);
    } else {
      setExportOpen('save-as');
    }
  };

  const print = async () => {
    const d = docRef.current;
    if (!d) return;
    setBusy('Preparing to print…');
    try {
      let url: string;
      if (d.kind === 'flow') {
        const html = await exportFlow(currentFlow()!, 'html');
        url = URL.createObjectURL(new Blob([html as BlobPart], { type: 'text/html' }));
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
      setDirty(true);
    } catch (err) {
      toast(`Could not convert: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const applySecurity = (v: ProtectionDraft) => {
    setDoc((cur) => (cur ? { ...cur, protection: v } : cur));
    setSecurityOpen(false);
    setDirty(true);
    toast(v.enabled ? 'Protection set. Save the document to apply it.' : 'Protection removed. Save the document to apply it.', 'info');
  };

  // ── shortcuts, OS file-open events, native menu ──────────────────────────
  const actions = useRef({ save, pickAndOpen, newDocument, print, saveAs: () => setExportOpen('save-as'), protect: () => setSecurityOpen(true), openFile });
  actions.current = { save, pickAndOpen, newDocument, print, saveAs: () => setExportOpen('save-as'), protect: () => setSecurityOpen(true), openFile };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        if (!docRef.current) return;
        if (e.shiftKey) actions.current.saveAs();
        else void actions.current.save();
      } else if (k === 'o') {
        e.preventDefault();
        void actions.current.pickAndOpen();
      } else if (k === 'p' && docRef.current) {
        e.preventDefault();
        void actions.current.print();
      } else if (k === 'n' && e.shiftKey === false && host.kind === 'desktop') {
        e.preventDefault();
        actions.current.newDocument();
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
    const offOpen = host.onOpenRequest((f) => void actions.current.openFile(f));
    const offMenu = host.onMenuCommand((cmd) => {
      const a = actions.current;
      if (cmd === 'new') a.newDocument();
      else if (cmd === 'open') void a.pickAndOpen();
      else if (!docRef.current) return;
      else if (cmd === 'save') void a.save();
      else if (cmd === 'save-as') a.saveAs();
      else if (cmd === 'print') void a.print();
      else if (cmd === 'protect') a.protect();
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      offOpen();
      offMenu();
    };
  }, [host]);

  // ── drag & drop documents onto the window ────────────────────────────────
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
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (file.type.startsWith('image/') && docRef.current) {
        toast(docRef.current.kind === 'pdf' ? 'Use the Insert image tool to add images to the PDF.' : 'Drop images onto the text to insert them.', 'info');
        return;
      }
      await actions.current.openFile(await readDroppedFile(file));
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
  }, []);

  const format: DocFormat | null = doc ? (doc.kind === 'pdf' ? 'pdf' : doc.format) : null;

  return (
    <div className={cx('app', `host-${host.kind}`)}>
      <header className="topbar">
        <div className="brand" aria-label="Document Editor">
          <FileText size={18} />
          <span>Document Editor</span>
        </div>
        {doc && (
          <div className="doc-name" title={doc.name}>
            {doc.protection.enabled && <Lock size={13} aria-label="Password protected" />}
            <span>{doc.name}</span>
            {dirty && <span className="dirty-dot" aria-label="Unsaved changes" />}
          </div>
        )}
        <nav className="topbar-actions" aria-label="File">
          <IconButton label="New" text onClick={newDocument}><FilePlus size={16} /></IconButton>
          <IconButton label="Open" text onClick={pickAndOpen}><FolderOpen size={16} /></IconButton>
          {doc && (
            <>
              <IconButton label={host.canSaveInPlace || host.kind === 'desktop' ? 'Save' : 'Download'} text onClick={save}><Save size={16} /></IconButton>
              <IconButton label="Save as / Convert" text onClick={() => setExportOpen('save-as')}><FileDown size={16} /></IconButton>
              <IconButton label="Protect" text active={doc.protection.enabled} onClick={() => setSecurityOpen(true)}>
                {doc.protection.enabled ? <ShieldCheck size={16} /> : <LockOpen size={16} />}
              </IconButton>
              <IconButton label="Print" onClick={print}><Printer size={16} /></IconButton>
              {doc.kind === 'pdf' && (
                <IconButton label="Convert PDF to editable document" onClick={convertPdfToFlow}><Wand2 size={16} /></IconButton>
              )}
              <Divider />
              <IconButton label="Zoom out (Ctrl -)" onClick={() => setZoom((z) => [...ZOOMS].reverse().find((v) => v < z - 0.001) ?? z)}><ZoomOut size={16} /></IconButton>
              <select className="tb-select zoom-select" aria-label="Zoom" value={String(zoom)} onChange={(e) => setZoom(parseFloat(e.target.value))}>
                {ZOOMS.map((z) => <option key={z} value={String(z)}>{Math.round(z * 100)}%</option>)}
              </select>
              <IconButton label="Zoom in (Ctrl +)" onClick={() => setZoom((z) => ZOOMS.find((v) => v > z + 0.001) ?? z)}><ZoomIn size={16} /></IconButton>
            </>
          )}
        </nav>
      </header>

      <main className="main">
        {!doc && <StartScreen onNew={newDocument} onOpen={pickAndOpen} />}
        {doc?.kind === 'flow' && (
          <RichEditor key={doc.key} ref={richRef} initial={doc.initial} zoom={zoom} onChange={markDirty} onStats={setStats} onError={toast} />
        )}
        {doc?.kind === 'pdf' && (
          <PdfEditor key={doc.key} ref={pdfRef} bytes={doc.bytes} zoom={zoom} onChange={markDirty} onError={toast} onPageCount={setPageCount} loadAsPdf={loadAsPdf} />
        )}
      </main>

      {doc && (
        <footer className="statusbar">
          <span>{format ? FORMATS[format].label : ''}</span>
          {doc.kind === 'flow' && stats && <span>{stats.words.toLocaleString()} words · {stats.characters.toLocaleString()} characters</span>}
          {doc.kind === 'pdf' && pageCount !== null && <span>{pageCount} {pageCount === 1 ? 'page' : 'pages'}</span>}
          {doc.protection.enabled && <span className="status-lock"><Lock size={12} /> Password protected</span>}
          <span className="spacer" />
          <span>{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
          <span className="status-private">Files are processed on this device only</span>
        </footer>
      )}

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <Upload size={36} />
          <p>Drop to open</p>
        </div>
      )}
      {busy && (
        <div className="busy" role="status">
          <span className="spinner" /> {busy}
        </div>
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx('toast', `toast-${t.kind}`)} onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
            {t.text}
          </div>
        ))}
      </div>

      {askPw && (
        <PasswordModal
          fileName={askPw.fileName}
          message={askPw.message}
          incorrect={askPw.incorrect}
          onClose={() => { askPw.resolve(null); setAskPw(null); }}
          onSubmit={(pw) => { askPw.resolve(pw); setAskPw(null); }}
        />
      )}
      {exportOpen && doc && format && (
        <ExportModal
          title="Save as / Convert"
          sourceKind={doc.kind}
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
      {securityOpen && doc && format && (
        <SecurityModal format={format} initial={doc.protection} onClose={() => setSecurityOpen(false)} onApply={applySecurity} />
      )}
    </div>
  );
}

function StartScreen({ onNew, onOpen }: { onNew: () => void; onOpen: () => void }) {
  return (
    <div className="start">
      <div className="start-inner">
        <h1>Document Editor</h1>
        <p className="start-lead">Create, edit, convert and password-protect documents. Everything runs on your device; no file is uploaded.</p>
        <div className="start-cards">
          <button type="button" className="start-card" onClick={onNew}>
            <FilePlus size={28} />
            <strong>Blank document</strong>
            <span>Write and format a new document</span>
          </button>
          <button type="button" className="start-card" onClick={onOpen}>
            <FolderOpen size={28} />
            <strong>Open a file</strong>
            <span>or drag one anywhere onto this window</span>
          </button>
        </div>
        <div className="start-formats">
          <h2>Supported formats</h2>
          <table>
            <tbody>
              <tr><th>Edit</th><td>Word (.docx, .doc), PDF, OpenDocument (.odt), Rich Text (.rtf), Markdown, HTML, plain text</td></tr>
              <tr><th>PDF</th><td>Edit existing text, add text, images, links, shapes and drawings; insert, delete, reorder and rotate pages; merge files</td></tr>
              <tr><th>Convert</th><td>Save any document in any of the formats above</td></tr>
              <tr><th>Protect</th><td>Open and save password-protected Word and PDF files</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
