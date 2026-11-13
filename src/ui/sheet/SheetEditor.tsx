/**
 * Spreadsheet editor (Excel / Google Sheets style) on Univer: ribbon toolbar, formula bar,
 * 400+ functions, cell formatting and number formats, merge, freeze panes, insert/delete
 * rows and columns, sheet tabs, sort, filter, find & replace, copy/paste, fill handle, undo.
 *
 * Univer (≈6 MB) is loaded only when a spreadsheet is opened. The workbook goes in and comes
 * out as a snapshot (src/core/sheet/workbook.ts); converting to and from files happens there.
 * Nothing is sent anywhere: formulas are computed in this page.
 *
 * Large sheets: commands that take a while on many rows (filtering, sorting, replacing,
 * inserting or deleting rows, undo) run behind a spinner, and a large workbook is saved from
 * the cells as the editor holds them instead of from a second copy of all of them.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ICellData, IWorkbookData, SheetData } from '../../core/sheet/workbook';
import { BusyPill, useBusy } from '../components';
import { textWidth } from '../db/columns';
import { fitCandidates, fittedWidth } from './auto-fit';
import { fitForPhone, isPhoneScreen, restoreFromPhone, type PhoneRestore } from './phone-view';
import { installSheetRibbon } from './ribbon-extras';
import { installSheetTouch } from './touch';

export interface SheetEditorHandle {
  /** The workbook as it is now, every formula written out per cell. A copy: safe to change. */
  getWorkbook(): IWorkbookData | null;
  /**
   * The workbook as the editor holds it, without copying its cells: for large workbooks,
   * where a second copy would not fit in memory. Read-only. `formulaOf` gives the formula of
   * a cell that only refers to a shared one.
   */
  getLiveWorkbook(): { workbook: IWorkbookData; formulaOf: (sheetId: string, row: number, column: number) => string | null } | null;
  /** The active sheet's values as shown (formatted numbers, formula results), for CSV/TSV/print. */
  getActiveSheet(): { name: string; rows: string[][]; sheetCount: number } | null;
  /** True when no sheet holds a value or a formula. */
  isEmpty(): boolean;
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

const AUTO_WIDTH_COMMAND = 'sheet.command.set-col-auto-width';
/** A sheet with at least this many cells in its used area gets a spinner for slow commands. */
const BUSY_SHEET_CELLS = 150_000;

/**
 * What to show while a command runs, for the commands that go through every row of a large
 * sheet. Null for everything else (typing, formatting, selecting stay instant).
 */
export function slowCommandLabel(id: string): string | null {
  if (!/^(sheet|univer|ui)\./.test(id) || /close-filter-panel|\.mutation\./.test(id)) return null;
  if (/filter/.test(id)) return 'Filtering…';
  if (/sort/.test(id)) return 'Sorting…';
  if (/replace/.test(id)) return 'Replacing…';
  if (/command\.(undo|redo)$/.test(id)) return id.endsWith('undo') ? 'Undoing…' : 'Redoing…';
  if (/command\.(remove|insert|delete|move)-(row|col|range)|command\.(paste|auto-fill|refill|clear-selection)|set-col-auto-width/.test(id)) return 'Working…';
  return null;
}

/** The first ribbon tab is "Home", as in Excel (Univer calls it "Start"). */
function withHomeTab<T extends object>(locale: T): T {
  const ui = (locale as { ui?: { ribbon?: Record<string, unknown> } }).ui;
  if (!ui?.ribbon) return locale;
  return { ...locale, ui: { ...ui, ribbon: { ...ui.ribbon, start: 'Home' } } };
}

interface CommandService {
  executeCommand(id: string, params?: unknown, options?: unknown): Promise<unknown>;
}

export const SheetEditor = forwardRef<SheetEditorHandle, Props>(function SheetEditor({ initial, onChange, onError, onNotice, large }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const [loading, setLoading] = useState(true);
  const busy = useBusy();
  const runBusy = useRef(busy.run);
  runBusy.current = busy.run;
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

        /** Whether the sheet on screen is big enough for commands on it to take a while. */
        const bigSheet = (): boolean => {
          try {
            const ws = univerAPI.getActiveWorkbook()?.getActiveSheet();
            return !!ws && (ws.getLastRow() + 1) * (ws.getLastColumn() + 1) >= BUSY_SHEET_CELLS;
          } catch {
            return false;
          }
        };
        const whenBig = (label: string, fn: () => void) => {
          if (bigSheet()) void runBusy.current(label, fn);
          else fn();
        };

        /**
         * Fits columns to the widest value anywhere in them (the grid's own auto-fit measures
         * only the rows on screen). Returns false when there was nothing to do.
         */
        const autoFitColumns = (params: { ranges?: { startColumn: number; endColumn: number }[] } | undefined): boolean => {
          const wbApi = univerAPI.getActiveWorkbook();
          const ws = wbApi?.getActiveSheet();
          if (!wbApi || !ws) return false;
          const ranges = params?.ranges?.length ? params.ranges : (ws.getSelection()?.getActiveRangeList() ?? []).map((r) => ({ startColumn: r.getColumn(), endColumn: r.getLastColumn() }));
          const columns = new Set<number>();
          const last = Math.max(0, ws.getLastColumn());
          for (const r of ranges) for (let c = r.startColumn; c <= Math.min(r.endColumn, last) && columns.size < 512; c++) columns.add(c);
          if (!columns.size) return false;
          const model = ws.getSheet();
          const candidates = fitCandidates(wbApi.getWorkbook().getSnapshot(), model.getSnapshot().cellData as Record<number, Record<number, ICellData>>, [...columns]);
          const floor = model.getSnapshot().defaultColumnWidth ?? 88;
          for (const [column, list] of candidates) {
            if (model.getColVisible && !model.getColVisible(column)) continue;
            const width = fittedWidth(
              list,
              (c) => {
                try {
                  return String(ws.getRange(c.row, column).getDisplayValue() ?? c.text);
                } catch {
                  return c.text;
                }
              },
              textWidth,
            );
            // as the grid does: a fitted column is never narrower than the default width
            if (width !== null) ws.setColumnWidth(column, Math.max(floor, width));
          }
          return true;
        };

        // Commands that go through every row of a large sheet (filter, sort, replace…) block
        // the page while they run. They are started one frame late, behind a spinner that
        // has already been painted; whoever asked for the command still gets its result.
        const commands = (univer as unknown as { __getInjector(): { get(token: unknown): CommandService } }).__getInjector().get(presets.ICommandService);
        const execute = commands.executeCommand.bind(commands);
        commands.executeCommand = (id, params, options) => {
          if (id === AUTO_WIDTH_COMMAND) {
            const fit = () => {
              try {
                return autoFitColumns(params as never);
              } catch (err) {
                console.error(err);
                return false;
              }
            };
            return bigSheet() ? runBusy.current('Fitting the column…', fit) : Promise.resolve(fit());
          }
          const label = slowCommandLabel(id);
          if (!label || !bigSheet()) return execute(id, params, options);
          return runBusy.current(label, () => execute(id, params, options));
        };

        installSheetRibbon(univerAPI, (m) => onNoticeRef.current?.(m), whenBig);
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

  /** The snapshot the editor works on: its sheets hold the live cells (nothing is copied). */
  const liveSnapshot = (): IWorkbookData | null => {
    const wbApi = api.current?.getActiveWorkbook();
    if (!wbApi) return null;
    const snap = wbApi.getWorkbook().getSnapshot();
    const sheets: Record<string, SheetData> = {};
    // a shallow copy of each sheet: the view settings can be put back without touching the editor's
    for (const ws of wbApi.getSheets()) sheets[ws.getSheetId()] = { ...(ws.getSheet().getSnapshot() as unknown as SheetData) };
    return { ...snap, sheets } as IWorkbookData;
  };

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
    getLiveWorkbook() {
      const wbApi = api.current?.getActiveWorkbook();
      const snap = liveSnapshot();
      if (!wbApi || !snap) return null;
      const bySheet = new Map(wbApi.getSheets().map((ws) => [ws.getSheetId(), ws]));
      return {
        workbook: restoreFromPhone(snap, phoneRestore.current),
        formulaOf: (sheetId, row, column) => bySheet.get(sheetId)?.getRange(row, column).getFormula() || null,
      };
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
    isEmpty() {
      const snap = liveSnapshot();
      if (!snap) return false;
      for (const id in snap.sheets) {
        const cells = snap.sheets[id]?.cellData ?? {};
        for (const r in cells) {
          const row = cells[r] as Record<string, ICellData> | undefined;
          for (const c in row) {
            const cell = row[c];
            if (cell && ((cell.v !== undefined && cell.v !== null && cell.v !== '') || cell.f || cell.si || cell.p)) return false;
          }
        }
      }
      return true;
    },
  }));

  return (
    <div className="sheet-editor">
      {loading && (
        <div className="sheet-loading" role="status">
          <span className="spinner" /> Loading the spreadsheet editor…
        </div>
      )}
      <BusyPill label={busy.label} delayed />
      <div ref={host} className="sheet-host" />
    </div>
  );
});
