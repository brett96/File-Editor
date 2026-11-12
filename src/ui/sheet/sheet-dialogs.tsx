/** Save As / Convert and Protect dialogs for spreadsheets. */
import { useState } from 'react';
import { Lock } from 'lucide-react';
import { SHEET_FORMATS, SHEET_FORMAT_ORDER, type SheetFormat } from '../../core/sheet/workbook';
import { Field, Modal } from '../components';
import { EMPTY_PROTECTION, ProtectionFields, validateProtection, type ProtectionDraft } from '../dialogs';

export interface SheetExportChoice {
  format: SheetFormat;
  fileName: string;
  protection: ProtectionDraft;
}

export function SheetExportModal({
  initialFormat,
  initialName,
  initialProtection,
  sheetCount,
  activeSheet,
  onSubmit,
  onClose,
}: {
  initialFormat: SheetFormat;
  initialName: string;
  initialProtection: ProtectionDraft;
  sheetCount: number;
  activeSheet: string;
  onSubmit: (choice: SheetExportChoice) => void;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<SheetFormat>(initialFormat);
  const [name, setName] = useState(initialName);
  const [protection, setProtection] = useState<ProtectionDraft>(initialProtection);
  const [error, setError] = useState<string | null>(null);
  const info = SHEET_FORMATS[format];

  const submit = () => {
    const err = info.canProtect ? validateProtection(protection, 'docx') : null;
    if (err) return setError(err);
    const base = name.trim().replace(/\.[A-Za-z0-9]+$/, '') || 'Spreadsheet';
    onSubmit({ format, fileName: `${base}.${info.ext}`, protection: info.canProtect ? protection : EMPTY_PROTECTION });
  };

  return (
    <Modal
      title="Save as / Convert"
      width={520}
      onClose={onClose}
      footer={
        <>
          {error && <span className="dialog-error" role="alert">{error}</span>}
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
          <button type="submit" form="sheet-export-form" className="btn btn-primary">Save</button>
        </>
      }
    >
      <form id="sheet-export-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="grid-2">
          <Field label="File name">
            <div className="input-suffix">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
              <span>.{info.ext}</span>
            </div>
          </Field>
          <Field label="Format">
            <select className="input" value={format} onChange={(e) => { setFormat(e.target.value as SheetFormat); setError(null); }}>
              {SHEET_FORMAT_ORDER.map((f) => (
                <option key={f} value={f}>{SHEET_FORMATS[f].label} (.{SHEET_FORMATS[f].ext})</option>
              ))}
            </select>
          </Field>
        </div>
        {info.note && (
          <p className="dialog-hint">
            {info.note}
            {sheetCount > 1 && ` This workbook has ${sheetCount} sheets; the active sheet, "${activeSheet}", is saved.`}
          </p>
        )}
        {info.canProtect ? (
          <ProtectionFields format="docx" officeApp="Excel" value={protection} onChange={(v) => { setProtection(v); setError(null); }} />
        ) : (
          <p className="dialog-hint"><Lock size={12} /> Password protection is available when saving as an Excel workbook (.xlsx).</p>
        )}
      </form>
    </Modal>
  );
}

export function SheetSecurityModal({
  format,
  initial,
  onApply,
  onClose,
}: {
  format: SheetFormat;
  initial: ProtectionDraft;
  onApply: (v: ProtectionDraft) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState<ProtectionDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const can = SHEET_FORMATS[format].canProtect;
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
                const err = validateProtection(value, 'docx');
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
              ? 'This workbook is protected. Change the password, or untick the box to remove protection.'
              : 'Choose a password. It is applied the next time you save.'}
          </p>
          <ProtectionFields format="docx" officeApp="Excel" value={value} onChange={(v) => { setValue(v); setError(null); }} />
        </>
      ) : (
        <p className="dialog-text">
          {SHEET_FORMATS[format].label} files cannot carry a password. Use <strong>Save as</strong> and choose Excel workbook (.xlsx) to save a protected copy.
        </p>
      )}
    </Modal>
  );
}
