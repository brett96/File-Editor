import { useState } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import { FORMATS, FORMAT_ORDER } from '../core/registry';
import type { PdfPermissions, PdfProtection } from '../core/pdf/types';
import type { DocFormat } from '../core/types';
import { Field, Modal } from './components';

export function PasswordModal({
  fileName,
  message,
  incorrect,
  onSubmit,
  onClose,
}: {
  fileName: string;
  message: string;
  incorrect: boolean;
  onSubmit: (password: string) => void;
  onClose: () => void;
}) {
  const [pw, setPw] = useState('');
  return (
    <Modal
      title="Password required"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
          <button type="submit" form="pw-form" className="btn btn-primary" disabled={!pw}>Unlock</button>
        </>
      }
    >
      <form id="pw-form" onSubmit={(e) => { e.preventDefault(); if (pw) onSubmit(pw); }}>
        <div className="dialog-file"><Lock size={16} /> <strong>{fileName}</strong></div>
        <p className="dialog-text">{message}</p>
        <Field label="Password">
          <input className="input" type="password" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} data-autofocus />
        </Field>
        {incorrect && <p className="dialog-error" role="alert">That password is not correct. Passwords are case-sensitive.</p>}
        <p className="dialog-hint">The password is only used on this device to decrypt the file. It is never uploaded or stored.</p>
      </form>
    </Modal>
  );
}

export interface ProtectionDraft {
  enabled: boolean;
  password: string;
  confirm: string;
  /** PDF only */
  ownerPassword: string;
  permissions: PdfPermissions;
  /** PDF only: protect editing but let anyone open */
  restrictOnly: boolean;
}

export const EMPTY_PROTECTION: ProtectionDraft = {
  enabled: false,
  password: '',
  confirm: '',
  ownerPassword: '',
  permissions: { printing: true, modifying: true, copying: true, annotating: true },
  restrictOnly: false,
};

export function protectionFromPdf(p: PdfProtection | null | undefined): ProtectionDraft {
  if (!p) return EMPTY_PROTECTION;
  return {
    enabled: true,
    password: p.userPassword,
    confirm: p.userPassword,
    ownerPassword: p.ownerPassword && p.ownerPassword !== p.userPassword ? p.ownerPassword : '',
    permissions: { ...EMPTY_PROTECTION.permissions, ...p.permissions },
    restrictOnly: !p.userPassword,
  };
}

export function protectionToPdf(d: ProtectionDraft): PdfProtection | null {
  if (!d.enabled) return null;
  if (d.restrictOnly) return { userPassword: '', ownerPassword: d.ownerPassword || d.password, permissions: d.permissions };
  return { userPassword: d.password, ownerPassword: d.ownerPassword || d.password, permissions: d.permissions };
}

export function validateProtection(d: ProtectionDraft, format: DocFormat): string | null {
  if (!d.enabled) return null;
  if (format === 'pdf' && d.restrictOnly) {
    if (!(d.ownerPassword || d.password)) return 'Enter a permissions password.';
    return null;
  }
  if (!d.password) return 'Enter a password.';
  if (d.password.length > 255) return 'Passwords can be at most 255 characters.';
  if (d.password !== d.confirm) return 'The passwords do not match.';
  return null;
}

export function ProtectionFields({
  format,
  value,
  onChange,
  officeApp = 'Word',
}: {
  format: DocFormat;
  value: ProtectionDraft;
  onChange: (v: ProtectionDraft) => void;
  /** Which Office app asks for the password (Office encryption is the same for Word and Excel). */
  officeApp?: 'Word' | 'Excel' | 'PowerPoint';
}) {
  const set = (patch: Partial<ProtectionDraft>) => onChange({ ...value, ...patch });
  const isPdf = format === 'pdf';
  return (
    <div className="protect-box">
      <label className="check">
        <input type="checkbox" checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <ShieldCheck size={16} /> Protect with a password
      </label>
      {value.enabled && (
        <div className="protect-fields">
          {isPdf && (
            <div className="segmented" role="radiogroup" aria-label="Protection type">
              <button type="button" role="radio" aria-checked={!value.restrictOnly} className={!value.restrictOnly ? 'is-active' : ''} onClick={() => set({ restrictOnly: false })}>
                Require password to open
              </button>
              <button type="button" role="radio" aria-checked={value.restrictOnly} className={value.restrictOnly ? 'is-active' : ''} onClick={() => set({ restrictOnly: true })}>
                Restrict editing only
              </button>
            </div>
          )}
          {!(isPdf && value.restrictOnly) && (
            <div className="grid-2">
              <Field label="Password">
                <input className="input" type="password" autoComplete="new-password" value={value.password} onChange={(e) => set({ password: e.target.value })} />
              </Field>
              <Field label="Confirm password">
                <input className="input" type="password" autoComplete="new-password" value={value.confirm} onChange={(e) => set({ confirm: e.target.value })} />
              </Field>
            </div>
          )}
          {isPdf && (
            <>
              <Field
                label={value.restrictOnly ? 'Permissions password' : 'Permissions password (optional)'}
                hint={value.restrictOnly ? 'Anyone can open the PDF; this password is needed to lift the restrictions below.' : 'Lets you change the restrictions later. Defaults to the open password.'}
              >
                <input className="input" type="password" autoComplete="new-password" value={value.ownerPassword} onChange={(e) => set({ ownerPassword: e.target.value })} />
              </Field>
              <div className="perm-grid">
                {(
                  [
                    ['printing', 'Allow printing'],
                    ['copying', 'Allow copying text and images'],
                    ['modifying', 'Allow editing and page changes'],
                    ['annotating', 'Allow comments and form filling'],
                  ] as [keyof PdfPermissions, string][]
                ).map(([k, label]) => (
                  <label key={k} className="check">
                    <input type="checkbox" checked={value.permissions[k]} onChange={(e) => set({ permissions: { ...value.permissions, [k]: e.target.checked } })} />
                    {label}
                  </label>
                ))}
              </div>
              <p className="dialog-hint">Encrypted with AES-256. Restrictions are honoured by standard PDF readers.</p>
            </>
          )}
          {format === 'docx' && <p className="dialog-hint">Uses Microsoft Office's standard encryption (AES-256). {officeApp} asks for this password when opening.</p>}
          <p className="dialog-hint dialog-warn">There is no way to recover a forgotten password.</p>
        </div>
      )}
    </div>
  );
}

export interface ExportChoice {
  format: DocFormat;
  fileName: string;
  protection: ProtectionDraft;
}

export function ExportModal({
  title,
  sourceKind,
  initialFormat,
  initialName,
  codeExt,
  initialProtection,
  onSubmit,
  onClose,
}: {
  title: string;
  sourceKind: 'flow' | 'pdf';
  initialFormat: DocFormat;
  initialName: string;
  /** For a source-code file (format 'code'): the extension it keeps, without the dot. */
  codeExt?: string;
  initialProtection: ProtectionDraft;
  onSubmit: (choice: ExportChoice) => void;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<DocFormat>(initialFormat);
  const [name, setName] = useState(initialName);
  const [protection, setProtection] = useState<ProtectionDraft>(initialProtection);
  const [error, setError] = useState<string | null>(null);
  const info = FORMATS[format];
  // source code keeps the extension it came with (.py, .ts); only that file's own tab offers it
  const extOf = (f: DocFormat) => (f === 'code' ? codeExt || FORMATS.code.ext : FORMATS[f].ext);
  const ext = extOf(format);

  let note: string | undefined = info.note;
  if (sourceKind === 'pdf' && format !== 'pdf') {
    note = 'Converting a PDF to an editable format rebuilds paragraphs from the text on each page. Images and complex layouts are not carried over.';
  } else if (sourceKind === 'flow' && format === 'txt') {
    note = 'Plain text keeps the words only; formatting, images and tables are flattened.';
  } else if (sourceKind === 'flow' && format === 'md') {
    note = 'Markdown keeps headings, lists, links, tables and emphasis. Colours, fonts and alignment are dropped.';
  } else if (sourceKind === 'flow' && format === 'pdf') {
    note = 'Text is typeset with the built-in Roboto font; other fonts are substituted.';
  }

  const submit = () => {
    const err = info.canProtect ? validateProtection(protection, format) : null;
    if (err) {
      setError(err);
      return;
    }
    const base = name.trim().replace(/\.[A-Za-z0-9]+$/, '') || 'Document';
    onSubmit({ format, fileName: `${base}.${ext}`, protection: info.canProtect ? protection : EMPTY_PROTECTION });
  };

  return (
    <Modal
      title={title}
      width={520}
      onClose={onClose}
      footer={
        <>
          {error && <span className="dialog-error" role="alert">{error}</span>}
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
          <button type="submit" form="export-form" className="btn btn-primary">Save</button>
        </>
      }
    >
      <form id="export-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="grid-2">
          <Field label="File name">
            <div className="input-suffix">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
              <span>.{ext}</span>
            </div>
          </Field>
          <Field label="Format">
            <select className="input" value={format} onChange={(e) => { setFormat(e.target.value as DocFormat); setError(null); }}>
              {FORMAT_ORDER.filter((f) => f !== 'code' || initialFormat === 'code').map((f) => (
                <option key={f} value={f}>{FORMATS[f].label} (.{extOf(f)})</option>
              ))}
            </select>
          </Field>
        </div>
        {note && <p className="dialog-hint">{note}</p>}
        {info.canProtect ? (
          <ProtectionFields format={format} value={protection} onChange={(v) => { setProtection(v); setError(null); }} />
        ) : (
          <p className="dialog-hint"><Lock size={12} /> Password protection is available when saving as Word (.docx) or PDF.</p>
        )}
      </form>
    </Modal>
  );
}

export function SecurityModal({
  format,
  initial,
  onApply,
  onClose,
}: {
  format: DocFormat;
  initial: ProtectionDraft;
  onApply: (v: ProtectionDraft) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState<ProtectionDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const can = FORMATS[format].canProtect;
  return (
    <Modal
      title="Password protection"
      width={520}
      onClose={onClose}
      footer={
        <>
          {error && <span className="dialog-error" role="alert">{error}</span>}
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
          {can && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                const err = validateProtection(value, format);
                if (err) setError(err);
                else onApply(value);
              }}
            >
              Apply
            </button>
          )}
        </>
      }
    >
      {can ? (
        <>
          <p className="dialog-text">
            {initial.enabled
              ? 'This document is protected. Change the password, or untick the box to remove protection.'
              : 'Choose a password. It is applied the next time you save.'}
          </p>
          <ProtectionFields format={format} value={value} onChange={(v) => { setValue(v); setError(null); }} />
        </>
      ) : (
        <p className="dialog-text">
          {FORMATS[format].label} files cannot carry a password. Use <strong>Save as</strong> and choose Word (.docx) or PDF to save a protected copy.
        </p>
      )}
    </Modal>
  );
}
