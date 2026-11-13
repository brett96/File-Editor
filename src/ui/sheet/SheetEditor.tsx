/**
 * Spreadsheet editor (Excel / Google Sheets style) on Univer: ribbon toolbar, formula bar,
 * 400+ functions, cell formatting and number formats, merge, freeze panes, insert/delete
 * rows and columns, sheet tabs, sort, filter, find & replace, copy/paste, fill handle, undo.
 *
 * Univer (≈6 MB) is loaded only when a spreadsheet is opened. The workbook goes in and comes
 * out as a snapshot (src/core/sheet/workbook.ts); converting to and from files happens there.
 * Nothing is sent anywhere: formulas are computed in this page.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ICellData, IWorkbookData } from '../../core/sheet/workbook';
import { fitForPhone, isPhoneScreen, restoreFromPhone, type PhoneRestore } from './phone-view';
import { installSheetRibbon } from './ribbon-extras';
import { installSheetTouch } from './touch';

export interface SheetEditorHandle {
  /** The workbook as it is now, every formula written out per cell. */
  getWorkbook(): IWorkbookData | null;
  /** The active sheet's values as shown (formatted numbers, formula results), for CSV/TSV/print. */
  getActiveSheet(): { name: string; rows: string[][]; sheetCount: number } | null;
}

interface Props {
  initial: IWorkbookData;
  onChange: () => void;
  onError: (message: string) => void;
  /** Informational notices (e.g. view changes made for a phone screen). */
  onNotice?: (message: string) => void;
  /** A workbook with so many cells that it must not be copied. */
  large?: boolean;
}

type Api = import('@univerjs/presets').FUniver;

/**
 * Workbook changes arrive as "sheet.…mutation…" commands. Others (e.g. the in-cell editor's
 * document updates on every selection) and the ones Univer runs by itself (formula results,
 * layout, selection, scrolling, switching tabs) are not edits.
 */
const EDIT_MUTATION = /^sheets?[.-]/i;
const QUIET_MUTATION = /formula|calculation|auto-height|auto-width|selection|scroll|zoom|set-worksheet-activate|set-active|numfmt\.mutation\.set-numfmt-local/i;

/** The first ribbon tab is "Home", as in Excel (Univer calls it "Start"). */
function withHomeTab<T extends object>(locale: T): T {
  const ui = (locale as { ui?: { ribbon?: Record<string, unknown> } }).ui;
  if (!ui?.ribbon) return locale;
  return { ...locale, ui: { ...ui, ribbon: { ...ui.ribbon, start: 'Home' } } };
}

export const SheetEditor = forwardRef<SheetEditorHandle, Props>(function SheetEditor({ initial, onChange, onError, onNotice, large }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const [loading, setLoading] = useState(true);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onNoticeRef = useRef(onNotice);
  onNoticeRef.current = onNotice;
  const phoneRestore = useRef<PhoneRestore | null>(null);

  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | null = null;
    (async () => {
      try {
        const [presets, core, sort, filter, find, enCore, enSort, enFilter, enFind] = await Promise.all([
          import('@univerjs/presets'),
          import('@univerjs/preset-sheets-core'),
          import('@univerjs/preset-sheets-sort'),
          import('@univerjs/preset-sheets-filter'),
          import('@univerjs/preset-sheets-find-replace'),
          import('@univerjs/preset-sheets-core/locales/en-US'),
          import('@univerjs/preset-sheets-sort/locales/en-US'),
          import('@univerjs/preset-sheets-filter/locales/en-US'),
          import('@univerjs/preset-sheets-find-replace/locales/en-US'),
          import('@univerjs/preset-sheets-core/lib/index.css'),
          import('@univerjs/preset-sheets-sort/lib/index.css'),
          import('@univerjs/preset-sheets-filter/lib/index.css'),
          import('@univerjs/preset-sheets-find-replace/lib/index.css'),
        ]);
        if (disposed || !host.current) return;
        const phone = isPhoneScreen();
        // Univer takes ownership of (and mutates) the snapshot it is given. A large workbook
        // is handed over as it is: a second copy of millions of cells would not fit in memory.
        const snapshot = large ? initial : structuredClone(initial);
        if (phone) {
          const { restore, unfroze } = fitForPhone(snapshot, host.current.clientWidth, host.current.clientHeight);
          phoneRestore.current = restore;
          if (unfroze) onNoticeRef.current?.('Frozen columns or rows are unfrozen on this screen so you can scroll through the sheet. The file keeps them when you save.');
        }
        const dark = window.matchMedia?.('(prefers-color-scheme: dark)');
        const { LocaleType, mergeLocales, createUniver } = presets;
        const { univer, univerAPI } = createUniver({
          locale: LocaleType.EN_US,
          locales: { [LocaleType.EN_US]: withHomeTab(mergeLocales(enCore.default, enSort.default, enFilter.default, enFind.default)) },
          darkMode: !!dark?.matches,
          presets: [
            core.UniverSheetsCorePreset({
              container: host.current,
              header: true,
              formulaBar: true,
              // phones: keep the sheet tabs; selection statistics, footer menus and the zoom
              // slider crowd them out (pinch to zoom instead)
              footer: phone ? { sheetBar: true, statisticBar: false, menus: false, zoomSlider: false } : { menus: true },
              ...(phone ? { ribbonType: 'simple' as const } : {}),
            }),
            sort.UniverSheetsSortPreset(),
            filter.UniverSheetsFilterPreset(),
            find.UniverSheetsFindReplacePreset(),
          ],
        });
        installSheetRibbon(univerAPI, (m) => onNoticeRef.current?.(m));
        univerAPI.createWorkbook(snapshot);
        api.current = univerAPI;
        const removeTouch = phone
          ? installSheetTouch(host.current, {
              getZoom: () => univerAPI.getActiveWorkbook()?.getActiveSheet().getZoom() ?? 1,
              setZoom: (z) => void univerAPI.getActiveWorkbook()?.getActiveSheet().zoom(z),
            })
          : null;

        const onScheme = (e: MediaQueryListEvent) => univerAPI.toggleDarkMode(e.matches);
        dark?.addEventListener?.('change', onScheme);
        // Ignore the burst of layout/formula mutations Univer runs while it loads the file.
        let ready = false;
        const readyTimer = setTimeout(() => (ready = true), 800);
        const sub = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (e) => {
          if (!ready || e.type !== 2 || (e.options as { onlyLocal?: boolean } | undefined)?.onlyLocal) return;
          if (!EDIT_MUTATION.test(e.id) || QUIET_MUTATION.test(e.id)) return;
          onChangeRef.current();
        });
        dispose = () => {
          clearTimeout(readyTimer);
          removeTouch?.();
          dark?.removeEventListener?.('change', onScheme);
          sub.dispose();
          api.current = null;
          univer.dispose();
        };
        if (disposed) dispose();
        else setLoading(false);
      } catch (err) {
        console.error(err);
        onErrorRef.current(`The spreadsheet editor could not start: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => {
      disposed = true;
      dispose?.();
    };
    // The editor is keyed by document; `initial` is only read on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    getWorkbook() {
      const wbApi = api.current?.getActiveWorkbook();
      if (!wbApi) return null;
      const snap = wbApi.save();
      // Cells filled from a neighbour keep only a reference to the original formula (si);
      // ask Univer for each one's own formula so files carry it per cell.
      for (const ws of wbApi.getSheets()) {
        const sheet = snap.sheets[ws.getSheetId()];
        for (const [r, row] of Object.entries(sheet?.cellData ?? {})) {
          for (const [c, cell] of Object.entries((row ?? {}) as Record<string, ICellData>)) {
            if (cell && cell.si && !cell.f) {
              const f = ws.getRange(Number(r), Number(c)).getFormula();
              if (f) cell.f = f;
            }
          }
        }
      }
      return restoreFromPhone(snap, phoneRestore.current);
    },
    getActiveSheet() {
      const wbApi = api.current?.getActiveWorkbook();
      const ws = wbApi?.getActiveSheet();
      if (!wbApi || !ws) return null;
      const lastRow = ws.getLastRow();
      const lastCol = ws.getLastColumn();
      const rows = lastRow < 0 || lastCol < 0 ? [] : ws.getRange(0, 0, lastRow + 1, lastCol + 1).getDisplayValues();
      return { name: ws.getSheetName(), rows, sheetCount: wbApi.getSheets().length };
    },
  }));

  return (
    <div className="sheet-editor">
      {loading && (
        <div className="sheet-loading" role="status">
          <span className="spinner" /> Loading the spreadsheet editor…
        </div>
      )}
      <div ref={host} className="sheet-host" />
    </div>
  );
});
