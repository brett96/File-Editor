// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { exportText, importText, htmlToPlainText } from '../src/core/formats/text';
import { exportMarkdown, importMarkdown } from '../src/core/formats/markdown';
import { exportHtml, importHtml } from '../src/core/formats/html';
import { sanitizeHtml } from '../src/core/sanitize';
import { sniffFormat, formatFromExtension } from '../src/core/registry';
import { utf8Encode } from '../src/core/dom';

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('plain text', () => {
  it('imports paragraphs and line breaks and escapes markup', async () => {
    const doc = await importText(utf8Encode('Line one\nline two\n\n<b>not bold</b> & co'));
    expect(doc.html).toBe('<p>Line one<br>line two</p><p>&lt;b&gt;not bold&lt;/b&gt; &amp; co</p>');
  });

  it('decodes UTF-16 with BOM and windows-1252 fallback', async () => {
    const u16 = new Uint8Array([0xff, 0xfe, 0x48, 0, 0xe9, 0]);
    expect((await importText(u16)).html).toBe('<p>Hé</p>');
    expect((await importText(new Uint8Array([0x63, 0x61, 0x66, 0xe9])))).toMatchObject({ html: '<p>café</p>' });
    expect((await importText(new Uint8Array([0x93, 0x68, 0x69, 0x94, 0x20, 0x96, 0x20, 0x80])))).toMatchObject({ html: '<p>“hi” – €</p>' });
  });

  it('renders lists, tables and links readably', async () => {
    const html =
      '<h1>Title</h1><p>Hello <a href="https://x.dev">site</a></p><ul><li><p>a</p><ul><li><p>b</p></li></ul></li></ul>' +
      '<ol><li><p>one</p></li><li><p>two</p></li></ol><table><tbody><tr><th><p>H1</p></th><th><p>H2</p></th></tr><tr><td><p>c1</p></td><td><p>c2</p></td></tr></tbody></table>';
    const text = htmlToPlainText(html);
    expect(text).toContain('Title');
    expect(text).toContain('Hello site (https://x.dev)');
    expect(text).toContain('- a\n  - b');
    expect(text).toContain('1. one\n2. two');
    expect(text).toContain('H1\tH2\nc1\tc2');
    expect(dec(await exportText({ html: '<p>x</p>' }))).toBe('x\n');
  });
});

describe('markdown', () => {
  it('round-trips common structures', async () => {
    const md = '# Heading\n\nSome **bold**, *italic* and [a link](https://example.com).\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```\ncode block\n```\n';
    const doc = await importMarkdown(utf8Encode(md));
    expect(doc.title).toBe('Heading');
    expect(doc.html).toContain('<h1>Heading</h1>');
    expect(doc.html).toContain('<strong>bold</strong>');
    expect(doc.html).toContain('<a href="https://example.com">a link</a>');
    expect(doc.html).toContain('<table>');
    const back = dec(await exportMarkdown(doc));
    expect(back).toContain('# Heading');
    expect(back).toContain('**bold**');
    expect(back).toContain('[a link](https://example.com)');
    expect(back).toMatch(/-\s+one/);
    expect(back).toMatch(/\|\s*A\s*\|\s*B\s*\|/);
    expect(back).toContain('```\ncode block\n```');
  });

  it('exports header-less tables and page breaks', async () => {
    const out = dec(await exportMarkdown({ html: '<table><tbody><tr><td><p>x</p></td><td><p>y</p></td></tr></tbody></table><div data-page-break="true"></div><p>z</p>' }));
    expect(out).toMatch(/\|\s*x\s*\|\s*y\s*\|/);
    expect(out).toContain('page-break-after');
  });

  it('strips raw HTML script content', async () => {
    const doc = await importMarkdown(utf8Encode('hi <script>alert(1)</script> <img src="https://evil/x.png" onerror="x()">'));
    expect(doc.html).not.toMatch(/script|onerror|evil/);
  });
});

describe('html', () => {
  it('imports body and title, sanitising dangerous content', async () => {
    const src = `<!doctype html><html><head><title>My &amp; Doc</title><style>p{color:red}</style></head><body>
      <p style="color: red; position: fixed; text-align: center" onclick="x()">Hi</p>
      <a href="javascript:alert(1)">bad</a><a href="https://ok.com">good</a>
      <iframe src="https://x"></iframe><img src="data:image/png;base64,AAAA" width="10"><img src="http://remote/x.png" alt="remote">
      <div>inline only</div><section><p>kept</p></section></body></html>`;
    const doc = await importHtml(utf8Encode(src));
    expect(doc.title).toBe('My & Doc');
    expect(doc.html).toContain('<p style="color: red; text-align: center">Hi</p>');
    expect(doc.html).not.toMatch(/onclick|javascript|iframe|position|<style|remote\/x/);
    expect(doc.html).toContain('<a href="https://ok.com">good</a>');
    expect(doc.html).toContain('<a>bad</a>');
    expect(doc.html).toContain('<img src="data:image/png;base64,AAAA" width="10">');
    expect(doc.html).toContain('[image: remote]');
    expect(doc.html).toContain('<p>inline only</p>');
    expect(doc.html).toContain('<p>kept</p>');
  });

  it('exports a standalone page with page setup', async () => {
    const out = dec(await exportHtml({ html: '<p>x</p>', title: 'T <1>', pageSetup: { size: 'a4', orientation: 'landscape', margins: { top: 36, right: 36, bottom: 36, left: 36 } } }));
    expect(out).toContain('<title>T &lt;1&gt;</title>');
    expect(out).toContain('@page { size: a4 landscape; margin: 36pt 36pt 36pt 36pt; }');
    expect(out).toContain('<p>x</p>');
  });

  it('keeps page breaks and highlight colours through the sanitiser', () => {
    const html = sanitizeHtml('<div data-page-break="true"></div><p><mark data-color="#ff0" style="background-color:#ff0; color: inherit">m</mark></p>');
    expect(html).toBe('<div data-page-break="true"></div><p><mark data-color="#ff0" style="background-color: #ff0; color: inherit">m</mark></p>');
  });
});

describe('format sniffing', () => {
  it('detects by content before extension', async () => {
    expect((await sniffFormat('x.docx', utf8Encode('%PDF-1.7\n'))).format).toBe('pdf');
    expect((await sniffFormat('x.doc', utf8Encode('{\\rtf1\\ansi hi}'))).format).toBe('rtf');
    expect((await sniffFormat('notes', utf8Encode('hello'))).format).toBe('txt');
    expect((await sniffFormat('page', utf8Encode('<!DOCTYPE html><p>x'))).format).toBe('html');
    expect((await sniffFormat('a.md', utf8Encode('# hi'))).format).toBe('md');

    const docx = new JSZip();
    docx.file('word/document.xml', '<w:document/>');
    expect((await sniffFormat('renamed.doc', await docx.generateAsync({ type: 'uint8array' }))).format).toBe('docx');

    const odt = new JSZip();
    odt.file('mimetype', 'application/vnd.oasis.opendocument.text');
    expect((await sniffFormat('a.odt', await odt.generateAsync({ type: 'uint8array' }))).format).toBe('odt');

    const xlsx = new JSZip();
    xlsx.file('xl/workbook.xml', '<x/>');
    const s = await sniffFormat('a.xlsx', await xlsx.generateAsync({ type: 'uint8array' }));
    expect(s.format).toBeNull();
    expect(s.unsupported).toMatch(/Spreadsheets/);

    const bogus = await sniffFormat('fake.pdf', utf8Encode('not a pdf'));
    expect(bogus.format).toBeNull();
  });

  it('maps extensions', () => {
    expect(formatFromExtension('A.DOCX')).toBe('docx');
    expect(formatFromExtension('notes.markdown')).toBe('md');
    expect(formatFromExtension('x.htm')).toBe('html');
    expect(formatFromExtension('x.zip')).toBeNull();
  });
});

describe('flow → PDF', () => {
  it('typesets a document with pdfmake', async () => {
    const { renderFlowPdf } = await import('../src/core/formats/pdf-export');
    // (images are covered in the browser check: pdfmake's PNG decoder needs Web Workers, which jsdom lacks)
    const bytes = await renderFlowPdf({
      title: 'Report',
      html: `<h1>Report</h1><p style="text-align: center">Hello <strong>world</strong> <a href="https://e.com">link</a></p>
        <ul><li><p>a</p></li></ul><table><tbody><tr><th><p>h</p></th></tr><tr><td><p>c</p></td></tr></tbody></table>
        <div data-page-break="true"></div><p>Second page</p>`,
      pageSetup: { size: 'a4', orientation: 'portrait', margins: { top: 72, right: 72, bottom: 72, left: 72 } },
    });
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
    const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = lib.getDocument({ data: bytes.slice(), verbosity: 0 });
    const doc = await task.promise;
    expect(doc.numPages).toBe(2);
    const p1 = await doc.getPage(1);
    const text = (await p1.getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ');
    expect(text).toContain('Report');
    expect(text).toContain('world');
    expect(Math.round(p1.getViewport({ scale: 1 }).width)).toBe(595);
    const links = (await p1.getAnnotations()).filter((a) => a.subtype === 'Link');
    expect(links[0]?.url).toBe('https://e.com/');
    const p2 = await doc.getPage(2);
    expect((await p2.getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ')).toContain('Second page');
    await task.destroy();
  });
});
