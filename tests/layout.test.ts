// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { exportDocx } from '../src/core/formats/docx-export';
import { importDocx } from '../src/core/formats/docx-import';
import { exportHtml } from '../src/core/formats/html';
import { parseHtml } from '../src/core/dom';
import { sanitizeHtml } from '../src/core/sanitize';

/** Smallest valid PNG (1×1, transparent). */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const roundTrip = async (html: string) => (await importDocx(await exportDocx({ html }))).html;

describe('page-layout fidelity (DOCX)', () => {
  it('keeps column widths, cell borders, shading, vertical alignment and row heights', async () => {
    const html =
      '<table><tbody><tr style="height:40px">' +
      '<td colwidth="200" style="background-color:#44546a; border-top:none; border-right:none; border-bottom:3px solid #44546a; border-left:none; vertical-align:middle"><p>A</p></td>' +
      '<td colwidth="100" style="border-top:1px solid #808080; border-right:none; border-bottom:none; border-left:none"><p>B</p></td>' +
      '</tr></tbody></table>';
    const b = parseHtml(await roundTrip(html));
    const [a, c] = Array.from(b.querySelectorAll('td'));
    expect(a.getAttribute('colwidth')).toBe('200');
    expect(c.getAttribute('colwidth')).toBe('100');
    const as = a.getAttribute('style')!;
    expect(as).toContain('background-color:#44546a');
    expect(as).toContain('border-bottom:3px solid #44546a');
    expect(as).toContain('border-top:none');
    expect(as).toContain('vertical-align:middle');
    expect(c.getAttribute('style')).toContain('border-top:1px solid #808080');
    expect(b.querySelector('tr')!.getAttribute('style')).toBe('height:40px');
  });

  it('reads borders and colours however the browser serialised them', async () => {
    // what the editor's getHTML() produces once the browser has normalised the inline styles
    const html =
      '<table><tbody><tr>' +
      '<td style="background-color: rgb(255, 255, 0); border-width: 1px; border-style: solid; border-color: rgb(0, 0, 0); vertical-align: middle;"><p>A</p></td>' +
      '<td style="border-top: none; border-right: 2px dashed rgb(128, 128, 128); border-bottom: medium; border-left: 0px solid red;"><p>B</p></td>' +
      '</tr></tbody></table>';
    const [a, c] = Array.from(parseHtml(await roundTrip(html)).querySelectorAll('td'));
    const as = a.getAttribute('style')!;
    expect(as).toContain('background-color:#ffff00');
    for (const side of ['top', 'right', 'bottom', 'left']) expect(as).toContain(`border-${side}:1px solid #000000`);
    expect(as).toContain('vertical-align:middle');
    const cs = c.getAttribute('style')!;
    expect(cs).toContain('border-top:none');
    expect(cs).toContain('border-right:2px dashed #808080');
    expect(cs).toContain('border-left:none');
  });

  it('keeps paragraph spacing, line height, indent and shading', async () => {
    const html = '<p style="line-height:2.44; margin-top:12pt; margin-bottom:0pt; margin-left:36pt; background-color:#ffff00">X</p>';
    const p = parseHtml(await roundTrip(html)).querySelector('p')!;
    const style = p.getAttribute('style')!;
    for (const part of ['line-height:2.44', 'margin-top:12pt', 'margin-bottom:0pt', 'margin-left:36pt', 'background-color:#ffff00']) {
      expect(style).toContain(part);
    }
  });

  it('round-trips plain text and headings without adding formatting', async () => {
    const html = '<h1>Title</h1><p>Body text</p><h2>Section</h2><p>More</p>';
    expect(await roundTrip(html)).toBe(html);
  });

  it('keeps floating drawings (ink) floating, with their position', async () => {
    const html = `<p>Signed here<img src="${PNG}" width="40" height="20" data-float-x="15" data-float-y="-10" data-ink="true" alt="Drawing"></p>`;
    const img = parseHtml(await roundTrip(html)).querySelector('img')!;
    expect(img.getAttribute('data-float-x')).toBe('15');
    expect(img.getAttribute('data-float-y')).toBe('-10');
    expect(img.getAttribute('data-ink')).toBe('true');
    expect(img.getAttribute('width')).toBe('40');
  });

  it('gives tables their column widths in the HTML export (printing)', async () => {
    const out = new TextDecoder().decode(
      await exportHtml({ html: '<table><tbody><tr><td colwidth="16"><p>a</p></td><td colspan="2" colwidth="2,84"><p>b</p></td></tr></tbody></table>' }),
    );
    expect(out).toContain('<colgroup><col style="width: 16px"><col style="width: 2px"><col style="width: 84px"></colgroup>');
    expect(out).toContain('<table style="width: 102px; table-layout: fixed">');
  });

  it('positions floating images in the HTML export (printing)', async () => {
    const out = new TextDecoder().decode(await exportHtml({ html: `<p>x<img src="${PNG}" width="4" height="4" data-float-x="12" data-float-y="-3"></p>` }));
    expect(out).toContain('<img style="left:12px; top:-3px"');
  });
});

describe('sanitizer and the layout contract', () => {
  it('keeps layout styles where they belong and drops them elsewhere', () => {
    const html = sanitizeHtml(
      '<table><tbody><tr style="height:30px"><td colwidth="120" style="border-top:1px solid #808080; vertical-align:middle; background-color:#eee; position:fixed">x</td></tr></tbody></table>' +
        '<p style="line-height:1.5; margin-left:36pt; margin-top:url(x)">p</p><span style="border-top:1px solid red">s</span>' +
        `<img src="${PNG}" data-float-x="5" data-float-y="abc" data-ink="true">`,
    );
    const b = parseHtml(html);
    const td = b.querySelector('td')!;
    expect(td.getAttribute('colwidth')).toBe('120');
    expect(td.getAttribute('style')).toBe('border-top: 1px solid #808080; vertical-align: middle; background-color: #eee');
    expect(b.querySelector('tr')!.getAttribute('style')).toBe('height: 30px');
    expect(b.querySelector('p')!.getAttribute('style')).toBe('line-height: 1.5; margin-left: 36pt');
    expect(b.querySelector('span')!.getAttribute('style')).toBeNull();
    // a half-valid position is dropped entirely
    const img = b.querySelector('img')!;
    expect(img.hasAttribute('data-float-x')).toBe(false);
    expect(img.hasAttribute('data-float-y')).toBe(false);
  });
});
