/** Save As / Convert, column-name and Protect dialogs for spreadsheets. */
import { useState } from 'react';
import { Lock } from 'lucide-react';
import { SHEET_FORMATS, SHEET_FORMAT_ORDER, type SheetFormat } from '../../core/sheet/workbook';
import type { SheetTablePlan } from '../../core/sheet/to-database';
import { Field, Modal } from '../components';
import { EMPTY_PROTECTION, ProtectionFields, validateProtection, type ProtectionDraft } from '../dialogs';

/** Save-as target that turns the workbook into a database (one table per sheet). */
export const SQLITE_TARGET = 'sqlite' as const;
export type SheetSaveTarget = SheetFormat | typeof SQLITE_TARGET;
const SQLITE_INFO = {
  label: 'SQLite database',
  ext: 'sqlite',
  canProtect: false,
  note: 'Every sheet that holds data becomes a table, with a column per sheet column. Values are saved (formula results, not formulas); formatting is not. Dates are stored as ISO text.',
};

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
  onDatabase,
  onClose,
}: {
  initialFormat: SheetFormat;
  initialName: string;
  initialProtection: ProtectionDraft;
  sheetCount: number;
  activeSheet: string;
  onSubmit: (choice: SheetExportChoice) => void;
  /** Chosen instead of onSubmit when the target is a database. */
  onDatabase: (fileName: string) => void;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<SheetSaveTarget>(initialFormat);
  const [name, setName] = useState(initialName);
  const [protection, setProtection] = useState<ProtectionDraft>(initialProtection);
  const [error, setError] = useState<string | null>(null);
  const info = format === SQLITE_TARGET ? SQLITE_INFO : SHEET_FORMATS[format];

  const submit = () => {
    if (format === SQLITE_TARGET) {
      onDatabase(`${name.trim().replace(/\.[A-Za-z0-9]+$/, '') || 'Database'}.${SQLITE_INFO.ext}`);
      return;
    }
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
            <select className="input" value={format} onChange={(e) => { setFormat(e.target.value as SheetSaveTarget); setError(null); }}>
              {SHEET_FORMAT_ORDER.map((f) => (
                <option key={f} value={f}>{SHEET_FORMATS[f].label} (.{SHEET_FORMATS[f].ext})</option>
              ))}
              <option value={SQLITE_TARGET}>{SQLITE_INFO.label} (.{SQLITE_INFO.ext})</option>
            </select>
          </Field>
        </div>
        {info.note && (
          <p className="dialog-hint">
            {info.note}
            {format !== SQLITE_TARGET && sheetCount > 1 && ` This workbook has ${sheetCount} sheets; the active sheet, "${activeSheet}", is saved.`}
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

/**
 * Asks which row names the columns for the sheets where that is not clear. Each sheet shows
 * its first rows; the person picks the heading row or "no heading row", and can retype any
 * column name.
 */
export function SheetHeadersModal({
  plans,
  namesFor,
  onSubmit,
  onClose,
}: {
  plans: SheetTablePlan[];
  /** Column names for a sheet when `row` (absolute, or null for none) is its heading row. */
  namesFor: (plan: SheetTablePlan, row: number | null) => string[];
  onSubmit: (plans: SheetTablePlan[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<SheetTablePlan[]>(plans);
  const [error, setError] = useState<string | null>(null);
  const unclear = draft.filter((p) => !p.confident);
  const update = (id: string, patch: Partial<SheetTablePlan>) => {
    setDraft((cur) => cur.map((p) => (p.sheetId === id ? { ...p, ...patch } : p)));
    setError(null);
  };
  const submit = () => {
    for (const p of unclear) {
      const names = p.columns.map((c) => c.trim().toLowerCase());
      if (names.some((n) => !n)) return setError(`Give every column of "${p.sheetName}" a name.`);
      if (new Set(names).size < names.length) return setError(`Two columns of "${p.sheetName}" have the same name.`);
    }
    onSubmit(draft.map((p) => ({ ...p, columns: p.columns.map((c) => c.trim()) })));
  };
  return (
    <Modal
      title="Column names"
      width={760}
      onClose={onClose}
      footer={
        <>
          {error && <span className="dialog-error" role="alert">{error}</span>}
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
          <button type="submit" form="sheet-headers-form" className="btn btn-primary">Create database</button>
        </>
      }
    >
      <form id="sheet-headers-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <p className="dialog-text">
          Each sheet becomes a table, and a table needs a name for every column.{' '}
          {unclear.length === 1 ? 'For this sheet it is' : `For ${unclear.length} sheets it is`} not clear which row holds the names. Pick the row, or
          type the names you want.
        </p>
        {unclear.map((p) => {
          const previewRows = p.preview;
          const dataStart = p.headerRow === null ? 0 : p.headerRow - p.firstRow + 1;
          return (
            <fieldset key={p.sheetId} className="header-pick">
              <legend>{p.sheetName}</legend>
              {p.reason && <p className="dialog-hint">{p.reason}</p>}
              <Field label="Column names come from">
                <select
                  className="input"
                  value={p.headerRow === null ? 'none' : String(p.headerRow)}
                  aria-label={`Heading row of ${p.sheetName}`}
                  onChange={(e) => {
                    const row = e.target.value === 'none' ? null : Number(e.target.value);
                    update(p.sheetId, { headerRow: row, columns: namesFor(p, row) });
                  }}
                >
                  {previewRows.slice(0, Math.min(previewRows.length, p.lastRow - p.firstRow)).map((cells, i) => (
                    <option key={i} value={p.firstRow + i}>
                      Row {p.firstRow + i + 1}: {cells.filter(Boolean).slice(0, 4).join(', ').slice(0, 70) || '(empty)'}
                    </option>
                  ))}
                  <option value="none">No heading row: every row is data</option>
                </select>
              </Field>
              <div className="header-pick-scroll">
                <table className="header-pick-table">
                  <thead>
                    <tr>
                      {p.columns.map((name, c) => (
                        <th key={c}>
                          <input
                            className="input"
                            value={name}
                            aria-label={`Name of column ${c + 1} of ${p.sheetName}`}
                            onChange={(e) => update(p.sheetId, { columns: p.columns.map((n, i) => (i === c ? e.target.value : n)) })}
                          />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((cells, r) => (
                      <tr key={r} className={r < dataStart ? 'is-skipped' : undefined} title={r < dataStart ? 'Not saved as data' : undefined}>
                        {cells.map((text, c) => (
                          <td key={c}>{text}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="dialog-hint">
                Rows {(p.headerRow === null ? p.firstRow : p.headerRow + 1) + 1}–{p.lastRow + 1} are saved to the table "{p.tableName}".
              </p>
            </fieldset>
          );
        })}
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
