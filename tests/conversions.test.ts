import { describe, expect, it } from 'vitest';
import { canSaveAs, familiesOfExtension, ownedExtensions, saveNameProblem } from '../src/core/conversions';
import { fitCandidates, fittedWidth, cellFont } from '../src/ui/sheet/auto-fit';
import type { ICellData } from '../src/core/sheet/workbook';

describe('which kinds of file a document can become', () => {
  it('keeps every kind to the formats its editor can write', () => {
    // a spreadsheet: other spreadsheet formats, a database, a document table — never media
    expect(canSaveAs('sheet', 'xlsx')).toBe(true);
    expect(canSaveAs('sheet', 'csv')).toBe(true);
    expect(canSaveAs('sheet', 'sqlite')).toBe(true);
    expect(canSaveAs('sheet', 'docx')).toBe(true);
    expect(canSaveAs('sheet', 'mp4')).toBe(false);
    expect(canSaveAs('sheet', 'png')).toBe(false);
    expect(canSaveAs('sheet', 'mp3')).toBe(false);
    // photos: images, PDF, and a Word document holding the picture — nothing else
    expect(canSaveAs('image', 'jpeg')).toBe(true);
    expect(canSaveAs('image', 'pdf')).toBe(true);
    expect(canSaveAs('image', 'docx')).toBe(true);
    expect(canSaveAs('image', 'txt')).toBe(false);
    expect(canSaveAs('image', 'xlsx')).toBe(false);
    expect(canSaveAs('image', 'sqlite')).toBe(false);
    expect(canSaveAs('proimage', 'psd')).toBe(true);
    expect(canSaveAs('proimage', 'csv')).toBe(false);
    // video and audio
    expect(canSaveAs('media', 'mp4')).toBe(true);
    expect(canSaveAs('media', 'mp3')).toBe(true);
    expect(canSaveAs('media', 'gif')).toBe(true);
    expect(canSaveAs('media', 'xlsx')).toBe(false);
    expect(canSaveAs('media', 'db')).toBe(false);
    expect(canSaveAs('media', 'docx')).toBe(false);
    expect(canSaveAs('studio', 'fstudio')).toBe(true);
    expect(canSaveAs('studio', 'csv')).toBe(false);
    // documents and databases
    expect(canSaveAs('flow', 'pdf')).toBe(true);
    expect(canSaveAs('flow', 'xlsx')).toBe(true);
    expect(canSaveAs('flow', 'mp4')).toBe(false);
    expect(canSaveAs('pdf', 'docx')).toBe(true);
    expect(canSaveAs('pdf', 'xlsx')).toBe(false);
    expect(canSaveAs('database', 'db3')).toBe(true);
    expect(canSaveAs('database', 'xlsx')).toBe(false);
    expect(canSaveAs('sheet', 'exe')).toBe(false);
  });

  it('knows what family an extension belongs to', () => {
    expect(familiesOfExtension('XLSX')).toEqual(['spreadsheet']);
    expect(familiesOfExtension('mp4')).toEqual(['video']);
    expect(familiesOfExtension('gif')).toEqual(['image']);
    expect(familiesOfExtension('zzz')).toEqual([]);
  });

  it('lists the extensions a format owns', () => {
    expect(ownedExtensions('jpg').sort()).toEqual(ownedExtensions('jpeg').sort());
    expect(ownedExtensions('jpg')).toContain('jpeg');
    expect(ownedExtensions('xlsx')).toEqual(['xlsx']);
    expect(ownedExtensions('docx')).toEqual(['docx']);
    expect(ownedExtensions('sqlite')).toContain('db');
    expect(ownedExtensions('html')).toContain('htm');
  });

  it('refuses a name with the wrong extension and says why', () => {
    expect(saveNameProblem('sheet', 'budget.xlsx', 'xlsx')).toBeNull();
    expect(saveNameProblem('image', 'photo.JPEG', 'jpg', ownedExtensions('jpg'))).toBeNull();
    expect(saveNameProblem('database', 'app.db', 'sqlite', ownedExtensions('sqlite'))).toBeNull();
    expect(saveNameProblem('sheet', 'budget.mp4', 'xlsx')).toMatch(/A spreadsheet can't be saved as a video \(\.mp4\)/);
    expect(saveNameProblem('image', 'photo.xlsx', 'png')).toMatch(/A photo can't be saved as a spreadsheet/);
    expect(saveNameProblem('media', 'clip.sqlite', 'mp4')).toMatch(/can't be saved as a database/);
    // a format the kind could take, but not the one being written
    expect(saveNameProblem('sheet', 'budget.csv', 'xlsx')).toMatch(/has to end in \.xlsx/);
    expect(saveNameProblem('sheet', 'budget', 'xlsx')).toMatch(/no extension/);
    expect(saveNameProblem('flow', 'notes.unknown', 'docx')).toMatch(/has to end in \.docx/);
  });
});

describe('spreadsheet column auto-fit', () => {
  const cells: Record<number, Record<number, ICellData>> = {};
  for (let r = 0; r < 5000; r++) cells[r] = { 0: { v: `row ${r}`, t: 1 }, 1: { v: r, t: 2 } };
  cells[4321][0] = { v: 'the one very long value far below the first screen', t: 1 };
  cells[77][0] = { v: 'BIG', t: 1, s: 'big' };
  cells[900][1] = { v: 46037, t: 2, s: 'date' };
  cells[3][2] = { v: 'two\nlines of different length', t: 1 };
  const wb = { styles: { big: { fs: 48, bl: 1 as const }, date: { n: { pattern: 'dddd, mmmm d, yyyy' } } } };

  it('finds the widest candidates anywhere in the column', () => {
    const found = fitCandidates(wb, cells, [0, 1, 2, 9]);
    const texts = found.get(0)!.map((c) => c.text);
    expect(texts).toContain('the one very long value far below the first screen');
    // a short value in a large font is a candidate too
    expect(texts).toContain('BIG');
    expect(found.get(0)!.find((c) => c.text === 'BIG')!.style?.fs).toBe(48);
    // numbers: the longest per cell format (the date's text on screen is longer than its serial)
    const numbers = found.get(1)!;
    expect(numbers.every((c) => c.numeric)).toBe(true);
    expect(numbers.map((c) => c.row).sort((a, b) => a - b)).toEqual([900, 1000]);
    expect(found.get(9)).toEqual([]);
  });

  it('measures what a cell shows, in its own font', () => {
    const measure = (text: string, font: string) => text.length * (font.includes('48pt') ? 30 : 7);
    const found = fitCandidates(wb, cells, [0, 1, 2]);
    expect(fittedWidth(found.get(0)!, (c) => c.text, measure)).toBe(50 * 7 + 10);
    // the formatted date decides the width of the number column
    expect(fittedWidth(found.get(1)!, (c) => (c.row === 900 ? 'Thursday, January 15, 2026' : c.text), measure)).toBe(26 * 7 + 10);
    // the widest line of a wrapped value, not its whole length
    expect(fittedWidth(found.get(2)!, (c) => c.text, measure)).toBe('lines of different length'.length * 7 + 10);
    expect(fittedWidth([], (c) => c.text, measure)).toBeNull();
    expect(cellFont({ bl: 1, it: 1, fs: 14, ff: 'Georgia' })).toBe('italic bold 14pt "Georgia", Arial, sans-serif');
    expect(cellFont(null)).toBe('11pt Arial, sans-serif');
  });

  it('saves presentations as PowerPoint, PDF or a ZIP of pictures only', () => {
    expect(canSaveAs('slides', 'pptx')).toBe(true);
    expect(canSaveAs('slides', 'ppsx')).toBe(true);
    expect(canSaveAs('slides', 'pdf')).toBe(true);
    expect(canSaveAs('slides', 'zip')).toBe(true);
    expect(canSaveAs('slides', 'docx')).toBe(false);
    expect(canSaveAs('flow', 'pptx')).toBe(false);
    expect(familiesOfExtension('pptx')).toEqual(['presentation']);
  });
});
