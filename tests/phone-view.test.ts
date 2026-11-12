import { describe, expect, it } from 'vitest';
import { NO_FREEZE, fitForPhone, restoreFromPhone } from '../src/ui/sheet/phone-view';
import { blankWorkbook, type IWorkbookData } from '../src/core/sheet/workbook';

function workbook(freeze: { xSplit: number; ySplit: number }, colA: number): IWorkbookData {
  const wb = blankWorkbook();
  const s = wb.sheets[wb.sheetOrder[0]];
  s.freeze = { ...freeze, startColumn: freeze.xSplit, startRow: freeze.ySplit };
  s.columnData = { 0: { w: colA } };
  s.cellData = { 0: { 0: { v: 'x' } } };
  s.zoomRatio = 1;
  return wb;
}

describe('phone view', () => {
  it('unfreezes a wide first column but keeps a short frozen header row', () => {
    const wb = workbook({ xSplit: 1, ySplit: 1 }, 271);
    const { restore, unfroze } = fitForPhone(wb, 412, 700);
    const s = wb.sheets[wb.sheetOrder[0]];
    expect(unfroze).toBe(true);
    expect(s.freeze).toMatchObject({ xSplit: 0, ySplit: 1, startRow: 1 });
    expect(s.zoomRatio).toBeGreaterThanOrEqual(0.7);
    expect(s.zoomRatio).toBeLessThan(1);
    // saving puts the file's own freeze and zoom back
    const snap = structuredClone(wb);
    restoreFromPhone(snap, restore);
    expect(snap.sheets[snap.sheetOrder[0]].freeze).toMatchObject({ xSplit: 1, ySplit: 1 });
    expect(snap.sheets[snap.sheetOrder[0]].zoomRatio).toBe(1);
  });

  it('keeps a narrow frozen column', () => {
    const wb = workbook({ xSplit: 1, ySplit: 0 }, 80);
    const { unfroze } = fitForPhone(wb, 412, 700);
    expect(unfroze).toBe(false);
    expect(wb.sheets[wb.sheetOrder[0]].freeze).toMatchObject({ xSplit: 1 });
  });

  it("keeps a freeze the person changed on the phone", () => {
    const wb = workbook({ xSplit: 2, ySplit: 0 }, 300);
    const { restore } = fitForPhone(wb, 412, 700);
    expect(wb.sheets[wb.sheetOrder[0]].freeze).toEqual(NO_FREEZE);
    const snap = structuredClone(wb);
    snap.sheets[snap.sheetOrder[0]].freeze = { xSplit: 0, ySplit: 3, startColumn: 0, startRow: 3 };
    restoreFromPhone(snap, restore);
    expect(snap.sheets[snap.sheetOrder[0]].freeze).toMatchObject({ xSplit: 0, ySplit: 3 });
  });
});
