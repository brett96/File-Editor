// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { exportDoc, importDoc } from '../src/core/formats/doc-legacy';
import { UnsupportedError } from '../src/core/types';

/**
 * Fixtures were produced by Microsoft Word 16 (COM automation, SaveAs2 wdFormatDocument = 0):
 *  - sample.doc: Heading 1, bold / italic / underline / 16pt runs, non-ASCII text, a HYPERLINK
 *    field, a 2×2 table, a bullet list, a numbered list, a manual page break, a centred
 *    paragraph and the Title document property "Legacy Fixture".
 *  - encrypted.doc: the same kind of file saved with the password "secret" (RC4 CryptoAPI).
 */
const fixture = (name: string) => new Uint8Array(readFileSync(join(process.cwd(), 'tests', 'fixtures', name)));
const bytes = (s: string) => new TextEncoder().encode(s);

function dom(html: string): HTMLElement {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
}

describe('legacy .doc (Word 97-2003 binary)', () => {
  it('imports text, paragraphs, tables, fields, lists and character formatting from a real Word file', async () => {
    const doc = await importDoc(fixture('sample.doc'));
    const body = dom(doc.html);
    expect(doc.title).toBe('Legacy Fixture');
    expect(doc.pageSetup).toEqual({ size: 'letter', orientation: 'portrait', margins: { top: 72, right: 72, bottom: 72, left: 72 } });

    expect(body.querySelector('h1')?.innerHTML).toBe('Legacy Heading');
    const p = body.querySelectorAll(':scope > p');
    expect(p[0].innerHTML).toBe(
      'Plain text with <strong>bold words</strong> and <em>italic</em> and <u>underlined</u> and <span style="font-size: 16pt">big</span>.',
    );
    expect(p[1].textContent).toBe('Zoë — café 日本語 naïve');

    const a = body.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/');
    expect(a.textContent).toBe('Example Site');
    expect(p[2].textContent).toBe('Visit Example Site today.');
    expect(doc.html).not.toContain('HYPERLINK');

    const rows = body.querySelectorAll('table tr');
    expect(rows.length).toBe(2);
    expect(Array.from(rows[0].querySelectorAll('td')).map((c) => c.textContent)).toEqual(['Name', 'Value']);
    expect(Array.from(rows[1].querySelectorAll('td')).map((c) => c.textContent)).toEqual(['Alpha', '1']);
    expect(body.querySelector('table')?.nextElementSibling?.textContent).toBe('After table.');

    expect(Array.from(body.querySelectorAll('ul > li')).map((li) => li.textContent)).toEqual(['First bullet', 'Second bullet']);
    expect(Array.from(body.querySelectorAll('ol > li')).map((li) => li.textContent)).toEqual(['Step one', 'Step two']);

    const brk = body.querySelector('div[data-page-break="true"]')!;
    expect(brk.previousElementSibling?.textContent).toBe('Before break');
    expect(brk.nextElementSibling?.textContent).toBe('Second page');
    const last = body.lastElementChild!;
    expect(last.outerHTML).toBe('<p style="text-align: center">Centered</p>');
    // no control characters leak through
    expect(/[\u0000-\u0008\u000b-\u001f]/.test(doc.html)).toBe(false);
  });

  it('refuses password-protected files with a clear error', async () => {
    const err = await importDoc(fixture('encrypted.doc')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedError);
    expect((err as Error).message).toBe(
      'Password-protected legacy .doc files are not supported yet. Open it in Word and re-save as .docx.',
    );
  });
});

describe('.doc files that are really something else', () => {
  it('delegates RTF content to the RTF importer', async () => {
    const doc = await importDoc(bytes('{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Hello {\\b world}\\par}'));
    expect(doc.html).toBe('<p>Hello <strong>world</strong></p>');
  });

  it('sanitises HTML saved as .doc', async () => {
    const html =
      '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><title>Web Doc</title><style>p{color:red}</style>' +
      '<script>alert(1)</script></head><body onload="evil()"><p class=MsoNormal onclick="x()">Hi <b>there</b><o:p></o:p></p>' +
      '<script>bad()</script><img src="http://example.com/x.png" alt="remote"></body></html>';
    const doc = await importDoc(bytes(html));
    expect(doc.title).toBe('Web Doc');
    expect(doc.html).toContain('<p>Hi <b>there</b></p>');
    expect(doc.html).not.toMatch(/script|alert|onclick|onload|evil|color:red|http:/);
  });

  it('extracts the HTML part of an MHTML (single file web page) .doc', async () => {
    const mhtml = [
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="----=_NextPart_01"',
      '',
      '------=_NextPart_01',
      'Content-Location: file:///C:/doc.htm',
      'Content-Transfer-Encoding: quoted-printable',
      'Content-Type: text/html; charset="windows-1252"',
      '',
      '<html><head><title>MHT</title></head><body><p>Caf=E9 =93quoted=94 text that is long enough to be wrapped by the q=',
      'p encoder</p><img src=3D"doc_files/image001.png"></body></html>',
      '',
      '------=_NextPart_01',
      'Content-Location: file:///C:/doc_files/image001.png',
      'Content-Transfer-Encoding: base64',
      'Content-Type: image/png',
      '',
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      '',
      '------=_NextPart_01--',
      '',
    ].join('\r\n');
    const doc = await importDoc(bytes(mhtml));
    expect(doc.title).toBe('MHT');
    const body = dom(doc.html);
    expect(body.querySelector('p')?.textContent).toBe('Café “quoted” text that is long enough to be wrapped by the qp encoder');
    expect(body.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
  });

  it('flags a renamed .docx so the caller can re-route it', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document/>');
    const err = await importDoc(await zip.generateAsync({ type: 'uint8array' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('MisnamedDocx');
    expect((err as Error).message).toBe('This file is actually a .docx (ZIP) file.');
  });
});

describe('.doc export', () => {
  it('writes Word-compatible RTF bytes that read back', async () => {
    const out = await exportDoc({ html: '<h1>Title</h1><p>Body <strong>bold</strong></p>', title: 'T' });
    expect(new TextDecoder().decode(out.subarray(0, 6))).toBe('{\\rtf1');
    const back = await importDoc(out);
    expect(back.html).toBe('<h1>Title</h1><p>Body <strong>bold</strong></p>');
    expect(back.title).toBe('T');
  });
});
