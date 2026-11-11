// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { exportRtf, importRtf } from '../src/core/formats/rtf';
import type { PageSetup } from '../src/core/types';

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const UNICODE = 'Zoë — 日本語 😀';

const SAMPLE = [
  '<h1>Main Heading</h1>',
  '<h2 style="text-align: center">Centered Sub</h2>',
  '<p>Plain <strong>bold</strong> <em>italic</em> <u>under</u> <s>strike</s> H<sub>2</sub>O x<sup>2</sup></p>',
  '<p style="text-align: right"><span style="color: #ff0000">red</span> <span style="font-size: 18pt">big</span> ',
  '<span style="font-family: Georgia">serif</span> <mark data-color="#ffff00" style="background-color: #ffff00">marked</mark></p>',
  '<ul><li><p>One</p><ul><li><p>One.A</p></li></ul></li><li><p>Two</p></li></ul>',
  '<ol><li><p>First</p></li><li><p>Second</p></li></ol>',
  '<p>Go to <a href="https://example.com/path?q=1&amp;r=2">the site</a>.</p>',
  '<table><tbody><tr><th><p>H1</p></th><th><p>H2</p></th></tr><tr><td><p>a</p></td><td><p>b</p></td></tr>',
  '<tr><td colspan="2"><p>wide</p></td></tr></tbody></table>',
  `<p><img src="${PNG_1X1}" width="10" height="10" alt="dot"></p>`,
  '<div data-page-break="true"></div>',
  `<p>${UNICODE}</p>`,
  '<blockquote><p>Quoted words</p></blockquote>',
  '<pre><code>const x = 1;\n  indented</code></pre>',
].join('');

const SETUP: PageSetup = { size: 'a4', orientation: 'landscape', margins: { top: 36, right: 54, bottom: 36, left: 54 } };

function dom(html: string): HTMLElement {
  const d = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return d.body;
}

const text = (s: Uint8Array) => new TextDecoder().decode(s);
const bytes = (s: string) => new TextEncoder().encode(s);

describe('RTF export', () => {
  it('writes a well-formed RTF 1 document with tables, pictures and page setup', async () => {
    const rtf = text(await exportRtf({ html: SAMPLE, title: 'Zoë’s Report', pageSetup: SETUP }));
    expect(rtf.startsWith('{\\rtf1\\ansi\\ansicpg1252')).toBe(true);
    // balanced braces (ignoring escaped ones)
    let depth = 0;
    const stripped = rtf.replace(/\\[\\{}]/g, '');
    for (const ch of stripped) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
    expect(rtf).toMatch(/\{\\fonttbl\{\\f0\\fswiss\\fcharset0 Calibri;\}/);
    expect(rtf).toContain('Georgia;');
    expect(rtf).toMatch(/\{\\colortbl;[^}]*\\red255\\green0\\blue0;/);
    expect(rtf).toContain('\\outlinelevel0');
    expect(rtf).toContain('{\\field{\\*\\fldinst{HYPERLINK "https://example.com/path?q=1&r=2"}}');
    expect(rtf).toMatch(/\\trowd.*\\cellx\d+/);
    expect(rtf).toContain('\\row');
    expect(rtf).toMatch(/\{\\pict\\pngblip\\picw1\\pich1\\picwgoal150\\pichgoal150\n89504e47/);
    expect(rtf).toContain('\\pagebb');
    expect(rtf).toContain('\\paperw16838\\paperh11906');
    expect(rtf).toContain('\\margl1080\\margr1080\\margt720\\margb720\\landscape');
    expect(rtf).toContain('{\\info{\\title Zo\\u235?\\u8217?s Report}}');
    // non-ASCII as \uN? with surrogate pairs as two signed escapes
    expect(rtf).toContain('Zo\\u235? \\u8212? \\u26085?\\u26412?\\u-30050? \\u-10179?\\u-8704?');
    // RTF is 7-bit clean
    expect(/[^\x00-\x7f]/.test(rtf)).toBe(false);
  });

  it('escapes backslashes and braces', async () => {
    const rtf = text(await exportRtf({ html: '<p>a\\b {c}</p>' }));
    expect(rtf).toContain('a\\\\b \\{c\\}');
    const back = await importRtf(bytes(rtf));
    expect(back.html).toBe('<p>a\\b {c}</p>');
  });
});

describe('RTF round trip', () => {
  it('preserves structure and formatting', async () => {
    const rtf = await exportRtf({ html: SAMPLE, title: 'Zoë’s Report', pageSetup: SETUP });
    const doc = await importRtf(rtf);
    const body = dom(doc.html);

    expect(doc.title).toBe('Zoë’s Report');
    expect(doc.pageSetup).toEqual(SETUP);

    expect(body.querySelector('h1')?.textContent).toBe('Main Heading');
    expect(body.querySelector('h1')?.innerHTML).toBe('Main Heading'); // no redundant bold/size
    const h2 = body.querySelector('h2')!;
    expect(h2.textContent).toBe('Centered Sub');
    expect(h2.getAttribute('style')).toBe('text-align: center');

    const p1 = body.querySelectorAll('p')[0];
    expect(p1.querySelector('strong')?.textContent).toBe('bold');
    expect(p1.querySelector('em')?.textContent).toBe('italic');
    expect(p1.querySelector('u')?.textContent).toBe('under');
    expect(p1.querySelector('s')?.textContent).toBe('strike');
    expect(p1.querySelector('sub')?.textContent).toBe('2');
    expect(p1.querySelector('sup')?.textContent).toBe('2');
    expect(p1.querySelector('span')).toBeNull(); // default font / size suppressed

    const p2 = body.querySelectorAll('p')[1];
    expect(p2.getAttribute('style')).toBe('text-align: right');
    expect(p2.innerHTML).toContain('<span style="color: #ff0000">red</span>');
    expect(p2.innerHTML).toContain('<span style="font-size: 18pt">big</span>');
    expect(p2.innerHTML).toContain('<span style="font-family: Georgia">serif</span>');
    expect(p2.innerHTML).toContain('<mark data-color="#ffff00" style="background-color: #ffff00">marked</mark>');

    // nested bullet list + numbered list
    const ul = body.querySelector(':scope > ul')!;
    expect(ul.children.length).toBe(2);
    expect(ul.querySelector(':scope > li > ul > li')?.textContent).toBe('One.A');
    expect(ul.children[1].textContent).toBe('Two');
    const ol = body.querySelector(':scope > ol')!;
    expect(Array.from(ol.children).map((li) => li.textContent)).toEqual(['First', 'Second']);

    const a = body.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/path?q=1&r=2');
    expect(a.textContent).toBe('the site');
    expect(a.innerHTML).toBe('the site'); // link colour / underline not duplicated

    const table = body.querySelector('table')!;
    const rows = table.querySelectorAll('tr');
    expect(rows.length).toBe(3);
    expect(Array.from(rows[0].children).map((c) => c.tagName)).toEqual(['TH', 'TH']);
    expect(rows[1].textContent).toBe('ab');
    expect(rows[2].children.length).toBe(1);
    expect(rows[2].children[0].getAttribute('colspan')).toBe('2');

    const img = body.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(PNG_1X1);
    expect(img.getAttribute('width')).toBe('10');
    expect(img.getAttribute('height')).toBe('10');

    const brk = body.querySelector('div[data-page-break="true"]')!;
    expect(brk).not.toBeNull();
    expect(brk.nextElementSibling?.textContent).toBe(UNICODE);

    expect(body.querySelector('blockquote')?.textContent).toBe('Quoted words');
    expect(body.querySelector('pre code')?.textContent).toBe('const x = 1;\n  indented');
  });

  it('round-trips an empty document', async () => {
    const doc = await importRtf(await exportRtf({ html: '' }));
    expect(doc.html).toBe('<p></p>');
  });
});

describe('RTF import of Word-style input', () => {
  const WORD_RTF = String.raw`{\rtf1\adeflang1025\ansi\ansicpg1252\uc1\adeff31507\deff0\stshfdbch31505\stshfloch31506\deflang1033\deflangfe1033
{\fonttbl{\f0\fbidi \froman\fcharset0\fprq2{\*\panose 02020603050405020304}Times New Roman;}{\f1\fbidi \fswiss\fcharset0\fprq2{\*\panose 020b0604020202020204}Arial;}
{\f2\fbidi \fmodern\fcharset0\fprq1 Courier New;}}
{\colortbl;\red0\green0\blue0;\red255\green0\blue0;\red5\green99\blue193;\red255\green255\blue0;}
{\*\defchp \fs24\lang1033 }{\*\defpap \ql \li0\ri0\sa160\sl259\slmult1 }
{\stylesheet{\ql \li0\ri0\sa160\widctlpar\f0\fs24\lang1033 \snext0 \sqformat \spriority0 Normal;}
{\s1\ql \keepn\outlinelevel0\b\f1\fs32 \sbasedon0 \snext0 heading 1;}{\*\cs10 \additive \sunhideused Default Paragraph Font;}}
{\*\generator Microsoft Word 16.0;}{\info{\title Caf\'e9 Notes}{\author Somebody}{\operator Somebody}{\creatim\yr2024\mo1\dy2}}
{\*\xmlnstbl {\xmlns1 http://schemas.microsoft.com/office/word/2003/wordml}}
\paperw11906\paperh16838\margl1440\margr1440\margt1440\margb1440\gutter0\ltrsect
\widowctrl\ftnbj\aenddoc\trackmoves0\trackformatting1\donotembedsysfont1\formshade
{\*\pnseclvl1\pnucrm\pnstart1\pnindent720\pnhang {\pntxta .}}
\pard\plain \s1\ql \keepn\outlinelevel0\b\f1\fs32 {\rtlch \ltrch\insrsid1 Caf\'e9 heading}\par
\pard\plain \ql \li0\ri0\sa160\f0\fs24 {Normal text with \b bold\b0 , {\i italic}, {\cf2 red}, an em dash @EMDASH@ here, and \'93quotes\'94.}\par
\pard\plain \qc \f0\fs24 {\fs36 Big centered}\line second line\par
\pard\plain \f0\fs24 See {\field{\*\fldinst {HYPERLINK "https://example.org/a b" }}{\fldrslt {\cf3\ul example.org}}} now.\par
\pard\plain \f0\fs24 {\highlight4 marked} and {\f2 code-ish} text\tab tabbed\par
\trowd \irow0\irowband0\ts11\trgaph108\trleft-108\trbrdrt\brdrs\brdrw10 \cellx3000\cellx6000
\pard\plain \intbl \f0\fs24 {A1}\cell {B1}\cell \row
\trowd \irow1\irowband1\trgaph108\trleft-108\cellx3000\cellx6000
\pard\plain \intbl \f0\fs24 {A2}\cell {B2 \u-10179?\u-8704?}\cell \row
\pard\plain \f0\fs24 {\listtext\pard\plain \f3\fs20 \'b7\tab}\ls1\ilvl0\li720\fi-360 Bullet item\par
{\listtext\pard\plain 1.\tab}\li720\fi-360 Numbered item\par
\pard\plain \f0\fs24 \page After break\par
{\*\themedata 504b0304}
{\pict\wmetafile8\picw10\pich10 0100090000}
\pard\plain \f0\fs24 {\v hidden}visible{\header ignored header}\par
}`.replace('@EMDASH@', '\\' + 'u8212?'); // (kept out of the raw template: some transforms cook \uXXXX there)

  it('parses fonts, colours, code pages, unicode, fields, tables and lists', async () => {
    const doc = await importRtf(bytes(WORD_RTF));
    const body = dom(doc.html);
    expect(doc.title).toBe('Café Notes');
    expect(doc.pageSetup).toEqual({ size: 'a4', orientation: 'portrait', margins: { top: 72, right: 72, bottom: 72, left: 72 } });

    expect(body.querySelector('h1')?.innerHTML).toBe('Café heading');
    const p = body.querySelectorAll('p');
    expect(p[0].innerHTML).toBe(
      'Normal text with <strong>bold</strong>, <em>italic</em>, <span style="color: #ff0000">red</span>, an em dash — here, and “quotes”.',
    );
    expect(p[1].getAttribute('style')).toBe('text-align: center');
    expect(p[1].innerHTML).toBe('<span style="font-size: 18pt">Big centered</span><br>second line');

    const a = body.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.org/a b');
    expect(a.innerHTML).toBe('example.org');
    expect(a.parentElement!.textContent).toBe('See example.org now.');

    expect(p[3].innerHTML).toBe(
      '<mark data-color="#ffff00" style="background-color: #ffff00">marked</mark> and <span style="font-family: Courier New">code-ish</span> text\ttabbed',
    );

    const rows = body.querySelectorAll('table tr');
    expect(rows.length).toBe(2);
    expect(Array.from(rows[0].querySelectorAll('td')).map((c) => c.textContent)).toEqual(['A1', 'B1']);
    expect(Array.from(rows[1].querySelectorAll('td')).map((c) => c.textContent)).toEqual(['A2', 'B2 😀']);

    expect(body.querySelector('ul > li')?.textContent).toBe('Bullet item');
    expect(body.querySelector('ol > li')?.textContent).toBe('Numbered item');
    expect(doc.html).not.toContain('·');

    const brk = body.querySelector('div[data-page-break="true"]')!;
    expect(brk.nextElementSibling?.textContent).toBe('After break');
    expect(body.lastElementChild?.textContent).toBe('visible');
    expect(doc.html).not.toMatch(/hidden|ignored|Somebody|schemas|504b/);
  });

  it('honours \\ucN skip counts, \\bin and non-1252 code pages', async () => {
    const binPayload = '{\\*\\blob\\bin4 \u0000}{\u0000}';
    const src = `{\\rtf1\\ansi\\ansicpg1251\\deff0{\\fonttbl{\\f0 Arial;}}\\uc2 A\\u1078\\'e6\\'e6 B\\uc0\\u1078 C ${binPayload}\\'e6\\par}`;
    const doc = await importRtf(bytes(src));
    expect(doc.html).toBe('<p>Aж BжC ж</p>');
  });

  it('rejects non-RTF input', async () => {
    await expect(importRtf(bytes('hello'))).rejects.toThrow(/RTF/);
  });
});

describe('RTF import of a real Word file', () => {
  // tests/fixtures/word-sample.rtf: tests/fixtures/sample.doc re-saved by Word 16 as RTF (wdFormatRTF);
  // the theme / latent-style / data-store / rsid destinations were stripped to keep the fixture small.
  it('reads Word-generated RTF', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const doc = await importRtf(new Uint8Array(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'word-sample.rtf'))));
    expect(doc.title).toBe('Legacy Fixture');
    expect(doc.html).toBe(WORD_SAMPLE_HTML);
  });
});

const WORD_SAMPLE_HTML =
  '<h1>Legacy Heading</h1><p>Plain text with <strong>bold words</strong> and <em>italic</em> and <u>underlined</u> and ' +
  '<span style="font-size: 16pt">big</span>.</p><p>Zoë — café <span style="font-family: MS Gothic">日本語</span> naïve</p>' +
  '<p>Visit <a href="https://example.com/">Example Site</a> today.</p><table><tbody><tr><td><p>Name</p></td><td><p>Value</p></td></tr>' +
  '<tr><td><p>Alpha</p></td><td><p>1</p></td></tr></tbody></table><p>After table.</p><ul><li><p>First bullet</p></li>' +
  '<li><p>Second bullet</p></li></ul><ol><li><p>Step one</p></li><li><p>Step two</p></li></ol><p>Before break</p>' +
  '<div data-page-break="true"></div><p>Second page</p><p style="text-align: center">Centered</p>';
