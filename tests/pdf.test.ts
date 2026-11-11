import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { buildPdf, fitToCharset, pageGeometry } from '../src/core/pdf/apply-edits';
import { pdfLockState, protectPdf, unlockPdf } from '../src/core/crypto/pdf-crypto';
import { newId, type PdfSession } from '../src/core/pdf/types';
import { PasswordError } from '../src/core/types';

// 1x1 red PNG
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

async function samplePdf(pages = 3, rotate = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Original page ${i + 1}`, { x: 72, y: 700, size: 18, font });
    if (rotate) p.setRotation({ type: 'degrees', angle: rotate } as never);
  }
  doc.setTitle('Sample');
  return doc.save();
}

async function pdfjs() {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

async function readPages(bytes: Uint8Array, password?: string) {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: bytes.slice(), password, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const out: { text: string; width: number; height: number; rotate: number; links: string[] }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const annots = await page.getAnnotations();
    const vp = page.getViewport({ scale: 1 });
    out.push({
      text: tc.items.map((it) => ('str' in it ? it.str : '')).join(' '),
      width: vp.width,
      height: vp.height,
      rotate: page.rotate,
      links: annots.filter((a) => a.subtype === 'Link').map((a) => a.url as string),
    });
  }
  await task.destroy();
  return out;
}

function sessionFor(bytes: Uint8Array, n: number): PdfSession {
  return {
    sources: [{ id: 's1', bytes }],
    pages: Array.from({ length: n }, (_, i) => ({
      id: newId('p'),
      sourceId: 's1',
      sourcePage: i,
      width: 612,
      height: 792,
      rotation: 0 as const,
      objects: [],
    })),
  };
}

describe('pageGeometry', () => {
  it('maps view space into user space for each rotation', () => {
    const box = { x: 10, y: 20, width: 600, height: 800 };
    const g0 = pageGeometry(box, 0);
    expect(g0.matrix).toEqual([1, 0, 0, 1, 10, 20]);
    expect([g0.viewWidth, g0.viewHeight]).toEqual([600, 800]);
    const g90 = pageGeometry(box, 90);
    expect([g90.viewWidth, g90.viewHeight]).toEqual([800, 600]);
    expect(pageGeometry(box, -90).rotation).toBe(270);
    expect(pageGeometry(box, 450).rotation).toBe(90);
  });
});

describe('fitToCharset', () => {
  it('keeps WinAnsi text and substitutes the rest', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const cs = new Set(font.getCharacterSet());
    expect(fitToCharset('Café — “ok” €5', cs)).toBe('Café — “ok” €5');
    expect(fitToCharset('a→b 日本', cs)).toBe('a->b ??');
  });
});

describe('buildPdf', () => {
  it('edits in place: adds text, image, shapes and a link', async () => {
    const src = await samplePdf(2);
    const session = sessionFor(src, 2);
    session.pages[0].objects.push(
      { id: 'a', type: 'text', x: 72, y: 200, text: 'Added line one\nAdded line two', fontSize: 14, fontFamily: 'Helvetica', bold: true, italic: false, color: '#cc0000' },
      { id: 'b', type: 'image', x: 300, y: 300, width: 50, height: 50, dataUrl: PNG },
      { id: 'c', type: 'rect', x: 72, y: 400, width: 100, height: 40, stroke: '#0000ff', fill: null, strokeWidth: 2 },
      { id: 'd', type: 'ellipse', x: 200, y: 400, width: 100, height: 40, stroke: null, fill: '#00aa00', strokeWidth: 1 },
      { id: 'e', type: 'line', x1: 72, y1: 500, x2: 300, y2: 520, stroke: '#000000', strokeWidth: 1.5 },
      { id: 'f', type: 'highlight', x: 72, y: 80, width: 150, height: 20, color: '#ffe066' },
      { id: 'g', type: 'ink', points: [[10, 10], [20, 30], [40, 35]], stroke: '#111111', strokeWidth: 2 },
      { id: 'h', type: 'link', x: 72, y: 600, width: 120, height: 20, url: 'https://example.com/a' },
      { id: 'i', type: 'text', x: 72, y: 640, text: 'Linked text', fontSize: 12, fontFamily: 'Times', bold: false, italic: true, color: '#1a56db', url: 'example.org' },
    );
    const out = await buildPdf(session);
    const pages = await readPages(out);
    expect(pages).toHaveLength(2);
    expect(pages[0].text).toContain('Original page 1');
    expect(pages[0].text).toContain('Added line one');
    expect(pages[0].text).toContain('Added line two');
    expect(pages[0].links).toEqual(['https://example.com/a', 'https://example.org/']);
    expect(pages[1].text).toContain('Original page 2');
    // in-place path keeps document metadata
    expect((await PDFDocument.load(out)).getTitle()).toBe('Sample');
  });

  it('reorders, deletes, duplicates, rotates and inserts blank pages and pages from another PDF', async () => {
    const a = await samplePdf(3);
    const other = await PDFDocument.create();
    other.addPage([400, 300]).drawText('Other doc', { x: 20, y: 150, size: 12 });
    const b = await other.save();
    const s = sessionFor(a, 3);
    s.sources.push({ id: 's2', bytes: b });
    const [p1, p2, p3] = s.pages;
    s.pages = [
      p3,
      { id: 'blank', sourceId: null, sourcePage: 0, width: 595, height: 842, rotation: 0, objects: [{ id: 't', type: 'text', x: 50, y: 50, text: 'On blank', fontSize: 12, fontFamily: 'Courier', bold: false, italic: false, color: '#000000' }] },
      { ...p1, rotation: 90 },
      { id: 'x', sourceId: 's2', sourcePage: 0, width: 400, height: 300, rotation: 0, objects: [] },
      { ...p1, id: 'dup', rotation: 0 },
    ];
    void p2;
    const out = await buildPdf(s);
    const pages = await readPages(out);
    expect(pages.map((p) => p.text.replace(/\s+/g, ' ').trim())).toEqual(['Original page 3', 'On blank', 'Original page 1', 'Other doc', 'Original page 1']);
    expect(pages[1].width).toBeCloseTo(595);
    expect(pages[2].rotate).toBe(90);
    expect(pages[2].width).toBeCloseTo(792);
    expect(pages[3].width).toBeCloseTo(400);
    expect(pages[4].rotate).toBe(0);
  });

  it('draws objects upright on pages with an intrinsic rotation', async () => {
    const src = await samplePdf(1, 90);
    const s = sessionFor(src, 1);
    s.pages[0].width = 792;
    s.pages[0].height = 612;
    s.pages[0].objects.push({ id: 'a', type: 'text', x: 100, y: 100, text: 'Upright', fontSize: 20, fontFamily: 'Helvetica', bold: false, italic: false, color: '#000000' });
    const out = await buildPdf(s);
    const lib = await pdfjs();
    const task = lib.getDocument({ data: out.slice(), verbosity: 0 });
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const item = tc.items.find((it) => 'str' in it && it.str === 'Upright') as { transform: number[] };
    const tx = lib.Util.transform(vp.transform, item.transform);
    // baseline origin lands where the model said (x=100, y≈100+0.9465*20), text runs left→right
    expect(tx[4]).toBeCloseTo(100, 0);
    expect(tx[5]).toBeCloseTo(100 + 0.9465 * 20, 0);
    expect(Math.abs(tx[1])).toBeLessThan(0.01);
    expect(tx[0]).toBeGreaterThan(0);
    await task.destroy();
  });

  it('saves with password protection that other readers honour', async () => {
    const src = await samplePdf(1);
    const out = await buildPdf(sessionFor(src, 1), { protection: { userPassword: 'open-me', ownerPassword: 'owner-me' } });
    expect(await pdfLockState(out)).toBe('open-password');
    await expect(readPages(out)).rejects.toThrow();
    await expect(readPages(out, 'wrong')).rejects.toThrow();
    const pages = await readPages(out, 'open-me');
    expect(pages[0].text).toContain('Original page 1');
  });
});

describe('pdf-crypto', () => {
  it('reports unencrypted files', async () => {
    expect(await pdfLockState(await samplePdf(1))).toBe('none');
  });

  it('unlocks with the user password and yields a plain PDF', async () => {
    const locked = await protectPdf(await samplePdf(2), { userPassword: 'sésame 🔑' });
    expect(await pdfLockState(locked)).toBe('open-password');
    await expect(unlockPdf(locked, 'nope')).rejects.toMatchObject({ code: 'password-incorrect' });
    await expect(unlockPdf(locked, '')).rejects.toBeInstanceOf(PasswordError);
    const plain = await unlockPdf(locked, 'sésame 🔑');
    expect(await pdfLockState(plain)).toBe('none');
    const pages = await readPages(plain);
    expect(pages.map((p) => p.text.trim())).toEqual(['Original page 1', 'Original page 2']);
  });

  it('requires the permissions password for owner-restricted files', async () => {
    const locked = await protectPdf(await samplePdf(1), { userPassword: '', ownerPassword: 'boss', permissions: { modifying: false } });
    expect(await pdfLockState(locked)).toBe('permissions-password');
    await expect(unlockPdf(locked, '')).rejects.toMatchObject({ code: 'password-required' });
    await expect(unlockPdf(locked, 'guess')).rejects.toMatchObject({ code: 'password-incorrect' });
    const plain = await unlockPdf(locked, 'boss');
    expect(await pdfLockState(plain)).toBe('none');
  });

  it('opens legacy RC4 and AES-128 encrypted files', async () => {
    for (const algorithm of ['RC4-128', 'AES-128'] as const) {
      const doc = await PDFDocument.load(await samplePdf(1));
      doc.encrypt({ userPassword: 'pw', ownerPassword: 'pw2', algorithm, allowWeakCryptography: true } as never);
      const locked = await doc.save();
      const plain = await unlockPdf(locked, 'pw');
      expect((await readPages(plain))[0].text).toContain('Original page 1');
    }
  });
});
