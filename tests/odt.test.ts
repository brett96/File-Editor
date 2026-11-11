// @vitest-environment jsdom
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { exportOdt, importOdt } from '../src/core/formats/odt';
import { UnsupportedError, type PageSetup } from '../src/core/types';

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
  '<ol><li><p>First</p><ol><li><p>First.1</p></li></ol></li><li><p>Second</p></li></ol>',
  '<p>Go to <a href="https://example.com/path?q=1&amp;r=2">the site</a>.</p>',
  '<table><tbody><tr><th><p>H1</p></th><th><p>H2</p></th><th><p>H3</p></th></tr>',
  '<tr><td rowspan="2"><p>tall</p></td><td colspan="2"><p>wide</p></td></tr>',
  '<tr><td><p>b</p></td><td><p>c</p></td></tr></tbody></table>',
  `<p><img src="${PNG_1X1}" width="10" height="10" alt="dot"></p>`,
  '<div data-page-break="true"></div>',
  `<p>${UNICODE}</p>`,
  '<blockquote><p>Quoted words</p></blockquote>',
  '<pre><code>const x = 1;\n  indented\tTab</code></pre>',
  '<hr>',
  '<p>Two&nbsp;&nbsp;spaces and <code>inline code</code></p>',
].join('');

const SETUP: PageSetup = { size: 'a4', orientation: 'landscape', margins: { top: 36, right: 54, bottom: 36, left: 54 } };

function dom(html: string): HTMLElement {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
}

/** Reads the raw local-file headers of a zip: entry order and compression method. */
function zipEntries(bytes: Uint8Array): Array<{ name: string; method: number }> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Array<{ name: string; method: number }> = [];
  let o = 0;
  while (o + 30 <= bytes.length && v.getUint32(o, true) === 0x04034b50) {
    const flags = v.getUint16(o + 6, true);
    const method = v.getUint16(o + 8, true);
    const csize = v.getUint32(o + 18, true);
    const nlen = v.getUint16(o + 26, true);
    const xlen = v.getUint16(o + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(o + 30, o + 30 + nlen));
    out.push({ name, method });
    if (flags & 0x08) break; // data descriptor: sizes unknown here; the first entries are what matter
    o += 30 + nlen + xlen + csize;
  }
  return out;
}

describe('ODT export', () => {
  it('writes a valid package: mimetype first and stored, manifest, parts and pictures', async () => {
    const bytes = await exportOdt({ html: SAMPLE, title: 'Zoë’s Report', pageSetup: SETUP });
    const entries = zipEntries(bytes);
    expect(entries[0]).toEqual({ name: 'mimetype', method: 0 });
    // "mimetype" content immediately follows the 38-byte header (ODF requirement)
    expect(new TextDecoder().decode(bytes.subarray(38, 38 + 39))).toBe('application/vnd.oasis.opendocument.text');

    const zip = await JSZip.loadAsync(bytes);
    for (const name of ['META-INF/manifest.xml', 'content.xml', 'styles.xml', 'meta.xml']) {
      expect(zip.file(name), name).not.toBeNull();
    }
    const pictures = Object.keys(zip.files).filter((n) => n.startsWith('Pictures/'));
    expect(pictures).toEqual(['Pictures/image1.png']);
    const manifest = await zip.file('META-INF/manifest.xml')!.async('string');
    expect(manifest).toContain('manifest:full-path="Pictures/image1.png" manifest:media-type="image/png"');

    // every XML part is well-formed
    for (const name of ['META-INF/manifest.xml', 'content.xml', 'styles.xml', 'meta.xml']) {
      const xml = await zip.file(name)!.async('string');
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      expect(doc.getElementsByTagName('parsererror').length, name).toBe(0);
    }
    const content = await zip.file('content.xml')!.async('string');
    expect(content).toContain('<text:h text:style-name="Heading_20_1" text:outline-level="1">Main Heading</text:h>');
    expect(content).toContain('table:number-columns-spanned="2"');
    expect(content).toContain('table:number-rows-spanned="2"');
    expect(content).toContain('<table:covered-table-cell/>');
    expect(content).toContain('svg:width="0.1042in" svg:height="0.1042in"');
    expect(content).toContain('fo:break-before="page"');
    expect(content).toContain('<text:list-level-style-bullet text:level="1"');
    expect(content).toContain('<text:list-level-style-number text:level="1" style:num-suffix="." style:num-format="1"');
    expect(content).toContain('<text:s text:c="2"/>indented<text:tab/>Tab');
    const styles = await zip.file('styles.xml')!.async('string');
    expect(styles).toContain('fo:page-width="11.6929in" fo:page-height="8.2678in" style:print-orientation="landscape"');
    const meta = await zip.file('meta.xml')!.async('string');
    expect(meta).toContain('<dc:title>Zoë’s Report</dc:title>');
  });
});

describe('ODT round trip', () => {
  it('preserves structure and formatting', async () => {
    const doc = await importOdt(await exportOdt({ html: SAMPLE, title: 'Zoë’s Report', pageSetup: SETUP }));
    const body = dom(doc.html);

    expect(doc.title).toBe('Zoë’s Report');
    expect(doc.pageSetup).toEqual(SETUP);

    expect(body.querySelector('h1')?.innerHTML).toBe('Main Heading');
    const h2 = body.querySelector('h2')!;
    expect(h2.innerHTML).toBe('Centered Sub');
    expect(h2.getAttribute('style')).toBe('text-align: center');

    const p1 = body.querySelectorAll('p')[0];
    expect(p1.innerHTML).toBe('Plain <strong>bold</strong> <em>italic</em> <u>under</u> <s>strike</s> H<sub>2</sub>O x<sup>2</sup>');

    const p2 = body.querySelectorAll('p')[1];
    expect(p2.getAttribute('style')).toBe('text-align: right');
    expect(p2.innerHTML).toBe(
      '<span style="color: #ff0000">red</span> <span style="font-size: 18pt">big</span> <span style="font-family: Georgia">serif</span> ' +
        '<mark data-color="#ffff00" style="background-color: #ffff00">marked</mark>',
    );

    const ul = body.querySelector(':scope > ul')!;
    expect(ul.children.length).toBe(2);
    expect(ul.querySelector(':scope > li > ul > li')?.textContent).toBe('One.A');
    const ol = body.querySelector(':scope > ol')!;
    expect(ol.children.length).toBe(2);
    expect(ol.querySelector(':scope > li > ol > li')?.textContent).toBe('First.1');
    expect(ol.children[1].textContent).toBe('Second');

    const a = body.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/path?q=1&r=2');
    expect(a.innerHTML).toBe('the site');

    const rows = body.querySelectorAll('table tr');
    expect(rows.length).toBe(3);
    expect(Array.from(rows[0].children).map((c) => `${c.tagName}:${c.textContent}`)).toEqual(['TH:H1', 'TH:H2', 'TH:H3']);
    expect(rows[1].children.length).toBe(2);
    expect(rows[1].children[0].getAttribute('rowspan')).toBe('2');
    expect(rows[1].children[1].getAttribute('colspan')).toBe('2');
    expect(Array.from(rows[2].children).map((c) => c.textContent)).toEqual(['b', 'c']);

    const img = body.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(PNG_1X1);
    expect(img.getAttribute('width')).toBe('10');
    expect(img.getAttribute('height')).toBe('10');
    expect(img.getAttribute('alt')).toBe('dot');

    const brk = body.querySelector('div[data-page-break="true"]')!;
    expect(brk.nextElementSibling?.textContent).toBe(UNICODE);

    expect(body.querySelector('blockquote')?.innerHTML).toBe('<p>Quoted words</p>');
    expect(body.querySelector('pre code')?.textContent).toBe('const x = 1;\n  indented\tTab');
    expect(body.querySelector('hr')).not.toBeNull();
    const last = body.lastElementChild!;
    expect(last.innerHTML).toBe('Two&nbsp;&nbsp;spaces and <code>inline code</code>');
    expect(last.textContent).toBe('Two  spaces and inline code');
  });

  it('round-trips an empty document', async () => {
    const doc = await importOdt(await exportOdt({ html: '' }));
    expect(doc.html).toBe('<p></p>');
  });
});

describe('ODT import of foreign documents', () => {
  const NS =
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
    'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
    'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"';

  async function build(content: string, styles: string): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
    zip.file(
      'META-INF/manifest.xml',
      '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>',
    );
    zip.file('content.xml', `<?xml version="1.0"?><office:document-content ${NS}>${content}</office:document-content>`);
    zip.file('styles.xml', `<?xml version="1.0"?><office:document-styles ${NS}>${styles}</office:document-styles>`);
    return zip.generateAsync({ type: 'uint8array' });
  }

  it('resolves named-style inheritance, list styles and percentages (LibreOffice-style input)', async () => {
    const styles =
      '<office:font-face-decls><style:font-face style:name="Liberation Serif" svg:font-family="&apos;Liberation Serif&apos;"/>' +
      '<style:font-face style:name="DejaVu Sans Mono" svg:font-family="&apos;DejaVu Sans Mono&apos;"/></office:font-face-decls>' +
      '<office:styles>' +
      '<style:default-style style:family="paragraph"><style:text-properties style:font-name="Liberation Serif" fo:font-size="12pt"/></style:default-style>' +
      '<style:style style:name="Standard" style:family="paragraph"/>' +
      '<style:style style:name="Emph" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>' +
      '<style:style style:name="StrongEmph" style:family="text" style:parent-style-name="Emph"><style:text-properties fo:font-weight="bold"/></style:style>' +
      '<style:style style:name="Big" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:font-size="150%"/></style:style>' +
      '<text:list-style style:name="Numbering_20_123"><text:list-level-style-number text:level="1" style:num-format="1" text:start-value="3"/>' +
      '<text:list-level-style-bullet text:level="2" text:bullet-char="•"/></text:list-style>' +
      '</office:styles>' +
      '<office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21.001cm" fo:page-height="29.7cm" ' +
      'fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/></style:page-layout></office:automatic-styles>' +
      '<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles>';
    const content =
      '<office:automatic-styles>' +
      '<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Big"><style:paragraph-properties fo:text-align="center" fo:break-before="page"/></style:style>' +
      '<style:style style:name="T1" style:family="text" style:parent-style-name="StrongEmph"><style:text-properties fo:color="#00ff00" style:font-name="DejaVu Sans Mono"/></style:style>' +
      '</office:automatic-styles>' +
      '<office:body><office:text>' +
      '<text:sequence-decls><text:sequence-decl text:display-outline-level="0" text:name="Table"/></text:sequence-decls>' +
      '<text:p text:style-name="Standard">First<text:soft-page-break/> <text:span text:style-name="T1">styled</text:span><text:tab/>x<text:line-break/>y</text:p>' +
      '<text:p text:style-name="P1">Big centred</text:p>' +
      '<text:list text:style-name="Numbering_20_123"><text:list-item><text:p>three</text:p>' +
      '<text:list><text:list-item><text:p>nested bullet</text:p></text:list-item></text:list></text:list-item></text:list>' +
      '<table:table><table:table-column table:number-columns-repeated="2"/>' +
      '<table:table-row><table:table-cell table:number-columns-spanned="2"><text:p>span</text:p></table:table-cell><table:covered-table-cell/></table:table-row>' +
      '<table:table-row><table:table-cell><text:p>l</text:p></table:table-cell><table:table-cell><text:p>r</text:p></table:table-cell></table:table-row>' +
      '</table:table>' +
      '</office:text></office:body>';
    const doc = await importOdt(await build(content, styles));
    const body = dom(doc.html);
    expect(doc.pageSetup?.size).toBe('a4');
    expect(doc.pageSetup?.margins.left).toBeCloseTo(56.69, 1);
    const p = body.querySelectorAll(':scope > p');
    expect(p[0].innerHTML).toBe(
      'First <strong><em><span style="color: #00ff00; font-family: DejaVu Sans Mono">styled</span></em></strong>\tx<br>y',
    );
    expect(body.children[1].tagName).toBe('DIV'); // page break before the centred paragraph
    expect(p[1].getAttribute('style')).toBe('text-align: center');
    expect(p[1].innerHTML).toBe('<span style="font-size: 18pt">Big centred</span>');
    const ol = body.querySelector('ol')!;
    expect(ol.getAttribute('start')).toBe('3');
    expect(ol.querySelector('li > ul > li')?.textContent).toBe('nested bullet');
    const cells = body.querySelectorAll('td');
    expect(cells.length).toBe(3);
    expect(cells[0].getAttribute('colspan')).toBe('2');
  });

  it('refuses encrypted packages', async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
    zip.file(
      'META-INF/manifest.xml',
      '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">' +
        '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"><manifest:encryption-data manifest:checksum-type="SHA1/1K" manifest:checksum="x"/></manifest:file-entry>' +
        '</manifest:manifest>',
    );
    zip.file('content.xml', 'garbage');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await expect(importOdt(bytes)).rejects.toBeInstanceOf(UnsupportedError);
    await expect(importOdt(bytes)).rejects.toThrow('Password-protected ODT files are not supported yet.');
  });
});

describe('ODT import of a real Word file', () => {
  // tests/fixtures/word-sample.odt: tests/fixtures/sample.doc re-saved by Word 16 as OpenDocument Text.
  it('reads Word-generated ODT (Normal body style, empty page-break carrier paragraph)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const doc = await importOdt(new Uint8Array(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'word-sample.odt'))));
    expect(doc.title).toBe('Legacy Fixture');
    expect(doc.pageSetup).toEqual({ size: 'letter', orientation: 'portrait', margins: { top: 72, right: 72, bottom: 72, left: 72 } });
    expect(doc.html).toBe(
      '<h1>Legacy Heading</h1><p>Plain text with <strong>bold words</strong> and <em>italic</em> and <u>underlined</u> and ' +
        '<span style="font-size: 16pt">big</span>.</p><p>Zoë — café <span style="font-family: MS Gothic">日本語</span> naïve</p>' +
        '<p>Visit <a href="https://example.com/">Example Site</a> today.</p><table><tbody><tr><td><p>Name</p></td><td><p>Value</p></td></tr>' +
        '<tr><td><p>Alpha</p></td><td><p>1</p></td></tr></tbody></table><p>After table.</p><ul><li><p>First bullet</p></li>' +
        '<li><p>Second bullet</p></li></ul><ol><li><p>Step one</p></li><li><p>Step two</p></li></ol><p>Before break</p>' +
        '<div data-page-break="true"></div><p>Second page</p><p style="text-align: center">Centered</p>',
    );
  });
});
