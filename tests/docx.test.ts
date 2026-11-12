// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { exportDocx } from '../src/core/formats/docx-export';
import { importDocx } from '../src/core/formats/docx-import';
import { bytesToBase64, imageSize, parseDataUrl, parseHtml } from '../src/core/dom';
import type { RichDocument } from '../src/core/types';

// ── helpers ──────────────────────────────────────────────────────────────────

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

/** Builds a valid RGB PNG of the given size (solid colour). */
function makePng(width: number, height: number, rgb: [number, number, number] = [200, 30, 30]): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) raw.set(rgb, row + 1 + x * 3);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    png.set(p, off);
    off += p.length;
  }
  return png;
}

async function zipText(bytes: Uint8Array, path: string): Promise<string | null> {
  const zip = await JSZip.loadAsync(bytes);
  const f = zip.file(path);
  return f ? f.async('string') : null;
}

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml"';

async function buildDocx(parts: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/></Types>',
  );
  for (const [path, content] of Object.entries(parts)) zip.file(path, content);
  return zip.generateAsync({ type: 'uint8array' });
}

function body(html: string): HTMLElement {
  return parseHtml(html);
}

// ── round trip ───────────────────────────────────────────────────────────────

const png = makePng(40, 20);
const pngUrl = `data:image/png;base64,${bytesToBase64(png)}`;

const SAMPLE: RichDocument = {
  title: 'Round Trip Sample',
  pageSetup: { size: 'a4', orientation: 'landscape', margins: { top: 36, right: 54, bottom: 36, left: 54 } },
  html: [
    '<h1>Main Title</h1>',
    '<h2 style="text-align:center">Centred Sub</h2>',
    '<h3>Third level</h3>',
    '<p>Plain <strong>bold</strong> <em>italic</em> <u>under</u> <s>gone</s> H<sub>2</sub>O x<sup>2</sup> <code>let x</code></p>',
    '<p style="text-align:right">Right aligned <span style="color:#ff0000">red text</span> and ' +
      '<span style="font-size:18pt">big text</span> and <span style="font-family:Georgia">serif</span>.</p>',
    '<p style="text-align:justify">Justified with <mark data-color="#a0e0ff" style="background-color:#a0e0ff">marked</mark> words.</p>',
    '<p>Visit <a href="https://example.com/page?a=1&amp;b=2">the site</a> today.</p>',
    '<ul><li><p>Apple</p><ul><li><p>Green apple</p></li></ul></li><li><p>Banana</p></li></ul>',
    '<ol><li><p>First</p></li><li><p>Second</p><ol><li><p>Second-A</p></li></ol></li></ol>',
    '<ol><li><p>Restarted</p></li></ol>',
    '<table><tbody>' +
      '<tr><th><p>H1</p></th><th><p>H2</p></th><th><p>H3</p></th></tr>' +
      '<tr><td colspan="2"><p>Wide cell</p></td><td><p>C</p></td></tr>' +
      '<tr><td rowspan="2"><p>Tall</p></td><td><p>x</p></td><td><ul><li><p>in cell</p></li></ul></td></tr>' +
      '<tr><td><p>y</p></td><td><p>z</p><p>z2</p></td></tr>' +
      '</tbody></table>',
    `<p>Image: <img src="${pngUrl}" width="80" height="40" alt="red box"></p>`,
    '<div data-page-break="true"></div>',
    '<p>After the break</p>',
    '<blockquote><p>Quoted words</p></blockquote>',
    '<pre><code>line one\n  line two</code></pre>',
    '<hr>',
    '<p>End</p>',
  ].join(''),
};

describe('docx export', () => {
  it('produces a well-formed package', async () => {
    const bytes = await exportDocx(SAMPLE);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes[0]).toBe(0x50); // PK
    expect(bytes[1]).toBe(0x4b);
    const zip = await JSZip.loadAsync(bytes);
    for (const part of ['word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'docProps/core.xml', '[Content_Types].xml']) {
      expect(zip.file(part), part).not.toBeNull();
    }
    const doc = (await zipText(bytes, 'word/document.xml'))!;
    expect(doc).toContain('<w:tbl>');
    expect(doc).toContain('w:gridSpan w:val="2"');
    expect(doc).toContain('w:vMerge w:val="restart"');
    expect(doc).toContain('w:pStyle w:val="Heading1"');
    expect(doc).toContain('w:numPr');
    expect(doc).toContain('w:hyperlink');
    expect(doc).toContain('w:drawing');
    expect(doc).toContain('w:pageBreakBefore');
    expect(doc).toMatch(/w:orient="landscape"/);
    const media = Object.keys(zip.files).filter((p) => p.startsWith('word/media/'));
    expect(media.length).toBe(1);
    const numbering = (await zipText(bytes, 'word/numbering.xml'))!;
    expect(numbering).toContain('w:numFmt w:val="bullet"');
    expect(numbering).toContain('w:numFmt w:val="decimal"');
    const core = (await zipText(bytes, 'docProps/core.xml'))!;
    expect(core).toContain('Round Trip Sample');
    // landscape A4 = 841.89 x 595.28 pt
    expect(doc).toMatch(/w:pgSz w:w="16838" w:h="11906"/);
  });

  it('exports an empty document and skips undecodable images', async () => {
    const empty = await exportDocx({ html: '' });
    expect((await zipText(empty, 'word/document.xml'))!).toContain('<w:body>');
    const bad = await exportDocx({ html: '<p>a<img src="data:image/png;base64,AAAA">b<img src="https://x/y.png"></p>' });
    const doc = (await zipText(bad, 'word/document.xml'))!;
    expect(doc).not.toContain('w:drawing');
    const back = await importDocx(bad);
    expect(back.html).toBe('<p>ab</p>');
  });

  it('scales large images down to the text width', async () => {
    const big = `data:image/png;base64,${bytesToBase64(makePng(2000, 1000))}`;
    const out = await importDocx(await exportDocx({ html: `<p><img src="${big}"></p>` }));
    const img = body(out.html).querySelector('img')!;
    // letter portrait, 1in margins → 6.5in = 624px
    expect(Number(img.getAttribute('width'))).toBe(624);
    expect(Number(img.getAttribute('height'))).toBe(312);
  });
});

describe('docx round trip', () => {
  it('preserves structure and formatting', async () => {
    const back = await importDocx(await exportDocx(SAMPLE));
    const b = body(back.html);

    // metadata & page setup
    expect(back.title).toBe('Round Trip Sample');
    expect(back.pageSetup).toEqual({
      size: 'a4',
      orientation: 'landscape',
      margins: { top: 36, right: 54, bottom: 36, left: 54 },
    });

    // headings
    expect(b.querySelector('h1')!.textContent).toBe('Main Title');
    expect(b.querySelector('h2')!.textContent).toBe('Centred Sub');
    expect(b.querySelector('h2')!.getAttribute('style')).toBe('text-align:center');
    expect(b.querySelector('h3')!.textContent).toBe('Third level');
    expect(b.querySelector('h1 strong')).toBeNull(); // heading bold comes from the style

    // inline formatting
    const p1 = b.querySelectorAll('p')[0];
    expect(p1.querySelector('strong')!.textContent).toBe('bold');
    expect(p1.querySelector('em')!.textContent).toBe('italic');
    expect(p1.querySelector('u')!.textContent).toBe('under');
    expect(p1.querySelector('s')!.textContent).toBe('gone');
    expect(p1.querySelector('sub')!.textContent).toBe('2');
    expect(p1.querySelector('sup')!.textContent).toBe('2');
    expect(p1.querySelector('code')!.textContent).toBe('let x');
    expect(p1.textContent).toBe('Plain bold italic under gone H2O x2 let x');
    expect(p1.querySelector('span')).toBeNull(); // no redundant font/size spans

    // colour, size, font, alignment
    const right = Array.from(b.querySelectorAll('p')).find((p) => p.textContent!.startsWith('Right aligned'))!;
    expect(right.getAttribute('style')).toBe('text-align:right');
    const spans = Array.from(right.querySelectorAll('span'));
    expect(spans.find((s) => s.textContent === 'red text')!.getAttribute('style')).toBe('color:#ff0000');
    expect(spans.find((s) => s.textContent === 'big text')!.getAttribute('style')).toBe('font-size:18pt');
    expect(spans.find((s) => s.textContent === 'serif')!.getAttribute('style')).toBe('font-family:Georgia');
    const just = Array.from(b.querySelectorAll('p')).find((p) => p.textContent!.startsWith('Justified'))!;
    expect(just.getAttribute('style')).toBe('text-align:justify');
    const mark = just.querySelector('mark')!;
    expect(mark.textContent).toBe('marked');
    expect(mark.getAttribute('data-color')).toBe('#a0e0ff');

    // link
    const a = b.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/page?a=1&b=2');
    expect(a.textContent).toBe('the site');
    expect(a.querySelector('span,u')).toBeNull(); // hyperlink character style is not inlined

    // lists
    const ul = b.querySelector(':scope > ul')!;
    expect(ul.children.length).toBe(2);
    expect(ul.children[0].querySelector(':scope > p')!.textContent).toBe('Apple');
    expect(ul.children[0].querySelector(':scope > ul > li > p')!.textContent).toBe('Green apple');
    expect(ul.children[1].textContent).toBe('Banana');
    const ols = b.querySelectorAll(':scope > ol');
    expect(ols.length).toBe(2);
    expect(ols[0].children.length).toBe(2);
    expect(ols[0].children[1].querySelector(':scope > ol > li')!.textContent).toBe('Second-A');
    expect(ols[1].textContent).toBe('Restarted');
    expect(ols[1].hasAttribute('start')).toBe(false); // separate <ol> restarts at 1

    // table
    const table = b.querySelector('table')!;
    const rows = table.querySelectorAll('tr');
    expect(rows.length).toBe(4);
    expect(Array.from(rows[0].children).map((c) => c.tagName)).toEqual(['TH', 'TH', 'TH']);
    expect(rows[0].querySelector('strong')).toBeNull();
    expect(rows[1].children[0].getAttribute('colspan')).toBe('2');
    expect(rows[1].children[0].textContent).toBe('Wide cell');
    expect(rows[2].children[0].getAttribute('rowspan')).toBe('2');
    expect(rows[2].querySelector('ul li')!.textContent).toBe('in cell');
    expect(rows[3].children.length).toBe(2);
    expect(rows[3].children[1].querySelectorAll('p').length).toBe(2);

    // image
    const img = b.querySelector('img')!;
    expect(img.getAttribute('width')).toBe('80');
    expect(img.getAttribute('height')).toBe('40');
    expect(img.getAttribute('alt')).toBe('red box');
    const data = parseDataUrl(img.getAttribute('src')!)!;
    expect(data.mime).toBe('image/png');
    expect(imageSize(data.bytes)).toEqual({ width: 40, height: 20 });

    // page break position
    const blocks = Array.from(b.children);
    const brIdx = blocks.findIndex((el) => el.getAttribute('data-page-break') === 'true');
    expect(brIdx).toBeGreaterThan(0);
    expect(blocks[brIdx - 1].querySelector('img')).not.toBeNull();
    expect(blocks[brIdx + 1].textContent).toBe('After the break');
    expect(b.querySelectorAll('[data-page-break]').length).toBe(1);

    // quote, code block, rule
    expect(b.querySelector('blockquote p')!.textContent).toBe('Quoted words');
    expect(b.querySelector('pre code')!.textContent).toBe('line one\n  line two');
    expect(b.querySelector('hr')).not.toBeNull();
    expect(blocks[blocks.length - 1].textContent).toBe('End');
  });

  it('is stable on a second round trip', async () => {
    const once = await importDocx(await exportDocx(SAMPLE));
    const twice = await importDocx(await exportDocx(once));
    expect(twice.html).toBe(once.html);
  });
});

// ── import of hand-written OOXML ─────────────────────────────────────────────

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W_NS}>
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Cambria" w:hAnsi="Cambria"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Kop1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:sz w:val="56"/></w:rPr></w:style>
  <w:style w:type="character" w:styleId="Emph"><w:name w:val="My Emphasis"/><w:rPr><w:i/></w:rPr></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W_NS}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="%1."/></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="5"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://rel.example/a" TargetMode="External"/>
  <Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pic.png"/>
  <Relationship Id="rIdEmf" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/old.emf"/>
</Relationships>`;

const CORE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Hand &amp; Made</dc:title></cp:coreProperties>`;

const DOC = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W_NS} xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" mc:Ignorable="wps">
<w:body>
  <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Doc Title</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Kop1"/></w:pPr><w:r><w:t>Dutch heading</w:t></w:r></w:p>
  <w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>Outline heading</w:t></w:r></w:p>
  <w:p><w:pPr><w:jc w:val="both"/></w:pPr>
    <w:r><w:t xml:space="preserve">See </w:t></w:r>
    <w:r><w:fldChar w:fldCharType="begin"/></w:r>
    <w:r><w:instrText xml:space="preserve"> HYPERLINK "https://field.example/x?y=1" \\o "tip" </w:instrText></w:r>
    <w:r><w:fldChar w:fldCharType="separate"/></w:r>
    <w:r><w:rPr><w:b/></w:rPr><w:t>field link</w:t></w:r>
    <w:r><w:fldChar w:fldCharType="end"/></w:r>
    <w:r><w:t xml:space="preserve"> and </w:t></w:r>
    <w:hyperlink r:id="rIdLink"><w:r><w:t>rel link</w:t></w:r></w:hyperlink>
    <w:r><w:t xml:space="preserve"> and </w:t></w:r>
    <w:hyperlink w:anchor="sec2"><w:r><w:t>anchor</w:t></w:r></w:hyperlink>
    <w:r><w:t>.</w:t></w:r>
  </w:p>
  <w:p>
    <w:r><w:t xml:space="preserve">Kept </w:t></w:r>
    <w:ins w:id="1" w:author="A"><w:r><w:t>inserted</w:t></w:r></w:ins>
    <w:del w:id="2" w:author="A"><w:r><w:delText>deleted</w:delText></w:r></w:del>
    <w:r><w:t xml:space="preserve"> </w:t></w:r>
    <w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>hi</w:t></w:r>
    <w:r><w:rPr><w:shd w:val="clear" w:color="auto" w:fill="00FF00"/></w:rPr><w:t>sh</w:t></w:r>
    <w:r><w:rPr><w:color w:val="auto"/><w:sz w:val="24"/><w:rFonts w:ascii="Cambria"/></w:rPr><w:t xml:space="preserve"> plain</w:t></w:r>
    <w:r><w:rPr><w:rStyle w:val="Emph"/></w:rPr><w:t xml:space="preserve"> styled</w:t></w:r>
    <w:r><w:tab/><w:t>a&lt;b&amp;c</w:t><w:sym w:font="Symbol" w:char="F0B7"/><w:noBreakHyphen/><w:t>x</w:t></w:r>
    <w:r><w:lastRenderedPageBreak/><w:t xml:space="preserve"> </w:t></w:r>
    <w:r><w:footnoteReference w:id="1"/></w:r>
  </w:p>
  <w:p>
    <w:r><w:t xml:space="preserve">Alt: </w:t></w:r>
    <mc:AlternateContent>
      <mc:Choice Requires="wps"><w:r><w:t>choice</w:t></w:r></mc:Choice>
      <mc:Fallback><w:r><w:t>fallback</w:t></w:r></mc:Fallback>
    </mc:AlternateContent>
    <mc:AlternateContent>
      <mc:Choice Requires="unknownNs"><w:r><w:t>nope</w:t></w:r></mc:Choice>
      <mc:Fallback><w:r><w:t>-fb</w:t></w:r></mc:Fallback>
    </mc:AlternateContent>
  </w:p>
  <w:p><w:r><w:t>Before</w:t></w:r><w:r><w:br w:type="page"/></w:r><w:r><w:t>After</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>one</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>bullet</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>two</w:t></w:r></w:p>
  <w:tbl>
    <w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
    <w:tr><w:trPr><w:tblHeader/></w:trPr>
      <w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>
      <w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>BC</w:t></w:r></w:p></w:tc>
    </w:tr>
    <w:tr>
      <w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>merged</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>b1</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>c1</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>inner</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/>
      </w:tc>
    </w:tr>
    <w:tr>
      <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>
      <w:tc><w:p><w:r><w:t>b2</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>c2</w:t></w:r></w:p></w:tc>
    </w:tr>
  </w:tbl>
  <w:p>
    <w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr id="1" name="P" descr="pic &quot;alt&quot;"/>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>
        <pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill>
      </pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>
    <w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr id="2" name="E"/>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>
        <pic:blipFill><a:blip r:embed="rIdEmf"/></pic:blipFill>
      </pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>
    <w:r><w:pict><v:shape style="width:30pt;height:15pt"><v:imagedata r:id="rIdImg"/></v:shape></w:pict></w:r>
  </w:p>
  <w:p><w:r><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>In a text box</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>
  <w:p><w:r><w:t>Last</w:t></w:r><w:unknownThing><w:r><w:t>skipped</w:t></w:r></w:unknownThing></w:p>
  <w:sectPr><w:pgSz w:w="12240" w:h="20160"/><w:pgMar w:top="1440" w:right="1080" w:bottom="720" w:left="1800"/></w:sectPr>
</w:body>
</w:document>`;

describe('docx import of hand-written OOXML', () => {
  it('handles constructs the exporter never emits', async () => {
    const bytes = await buildDocx({
      'word/document.xml': DOC,
      'word/styles.xml': STYLES,
      'word/numbering.xml': NUMBERING,
      'word/_rels/document.xml.rels': RELS,
      'word/media/pic.png': png,
      'word/media/old.emf': new Uint8Array([1, 0, 0, 0, 0x20, 0x45, 0x4d, 0x46]),
      'docProps/core.xml': CORE,
    });
    const out = await importDocx(bytes);
    const b = body(out.html);

    expect(out.title).toBe('Hand & Made');
    expect(out.pageSetup).toEqual({
      size: 'legal',
      orientation: 'portrait',
      margins: { top: 72, right: 54, bottom: 36, left: 90 },
    });

    const h1s = b.querySelectorAll('h1');
    expect(Array.from(h1s).map((h) => h.textContent)).toEqual(['Doc Title', 'Dutch heading']);
    // heading sizes that differ from the editor's own heading look are kept
    expect((h1s[0].querySelector('span') as HTMLElement).style.fontSize).toBe('28pt');
    expect((h1s[1].querySelector('span') as HTMLElement).style.fontSize).toBe('16pt');
    expect(b.querySelector('h3')!.textContent).toBe('Outline heading');

    // jc=both, complex HYPERLINK field, rel link, anchor link
    const links = b.querySelector('p[style^="text-align:justify"]')!;
    expect(links).not.toBeNull();
    const anchors = Array.from(links.querySelectorAll('a'));
    expect(anchors.map((a) => a.getAttribute('href'))).toEqual([
      'https://field.example/x?y=1',
      'https://rel.example/a',
      '#sec2',
    ]);
    expect(anchors[0].querySelector('strong')!.textContent).toBe('field link');
    expect(links.textContent).toBe('See field link and rel link and anchor.');
    expect(links.textContent).not.toContain('HYPERLINK');

    // tracked changes, highlight, shading, defaults, char style, tab/sym/escapes
    const rev = Array.from(b.querySelectorAll('p')).find((p) => p.textContent!.startsWith('Kept'))!;
    expect(rev.textContent).toContain('Kept inserted');
    expect(rev.textContent).not.toContain('deleted');
    const marks = rev.querySelectorAll('mark');
    expect(marks[0].textContent).toBe('hi');
    expect(marks[0].getAttribute('data-color')).toBe('#ffff00');
    expect(marks[1].textContent).toBe('sh');
    expect(marks[1].getAttribute('data-color')).toBe('#00ff00');
    // the document's own default font/size (Cambria 12pt) differs from the editor's, so it is kept;
    // automatic colour never produces a colour
    const span = rev.querySelector('span') as HTMLElement;
    expect(span.style.fontFamily).toBe('Cambria');
    expect(span.style.fontSize).toBe('12pt');
    expect(rev.querySelector('span[style*="color"]')).toBeNull();
    expect(rev.querySelector('em')!.textContent).toBe(' styled');
    expect(rev.textContent).toContain('    a<b&c•‑x');
    expect(rev.innerHTML).toContain('a&lt;b&amp;c');

    // mc:AlternateContent: exactly one branch
    const alt = Array.from(b.querySelectorAll('p')).find((p) => p.textContent!.startsWith('Alt'))!;
    expect(alt.textContent).toBe('Alt: choice-fb');

    // page break splits the paragraph
    const blocks = Array.from(b.children);
    const i = blocks.findIndex((el) => el.textContent === 'Before');
    expect(blocks[i + 1].getAttribute('data-page-break')).toBe('true');
    expect(blocks[i + 2].textContent).toBe('After');

    // list: lowerRoman with nested bullet, merged into one list
    const ol = b.querySelector(':scope > ol')!;
    expect(ol.getAttribute('type')).toBe('i');
    expect(ol.children.length).toBe(2);
    expect(ol.children[0].querySelector('ul > li')!.textContent).toBe('bullet');
    expect(ol.children[1].textContent).toBe('two');

    // table: header row, gridSpan, vMerge, nested table
    const table = b.querySelector(':scope > table')!;
    const rows = table.querySelectorAll(':scope > tbody > tr');
    expect(rows.length).toBe(3);
    expect(Array.from(rows[0].children).map((c) => c.tagName)).toEqual(['TH', 'TH']);
    expect(rows[0].children[1].getAttribute('colspan')).toBe('2');
    expect(rows[1].children[0].getAttribute('rowspan')).toBe('2');
    expect(rows[1].children[0].textContent).toBe('merged');
    expect(rows[2].children.length).toBe(2);
    expect(rows[2].textContent).toBe('b2c2');
    expect(rows[1].querySelector(':scope table td')!.textContent).toBe('inner');

    // images: DrawingML (EMU → px), EMF skipped, VML imagedata
    const imgs = b.querySelectorAll('img');
    expect(imgs.length).toBe(2);
    expect(imgs[0].getAttribute('width')).toBe('100');
    expect(imgs[0].getAttribute('height')).toBe('50');
    expect(imgs[0].getAttribute('alt')).toBe('pic "alt"');
    expect(imgs[0].getAttribute('src')!.startsWith('data:image/png;base64,')).toBe(true);
    expect(imgs[1].getAttribute('width')).toBe('40');
    expect(imgs[1].getAttribute('height')).toBe('20');
    expect(out.html).not.toContain('emf');

    // text box content follows as its own paragraph; unknown elements skipped
    expect(Array.from(b.querySelectorAll('p')).some((p) => p.textContent === 'In a text box')).toBe(true);
    expect(blocks[blocks.length - 1].textContent).toBe('Last');
  });

  it('throws a clear error without word/document.xml', async () => {
    const bytes = await buildDocx({ 'word/styles.xml': STYLES });
    await expect(importDocx(bytes)).rejects.toThrow(/word\/document\.xml/);
    await expect(importDocx(new Uint8Array([1, 2, 3]))).rejects.toThrow(/DOCX/);
  });

  it('works without styles, numbering or rels parts', async () => {
    const bytes = await buildDocx({
      'word/document.xml': `<w:document ${W_NS}><w:body><w:p><w:r><w:t>Only text</w:t></w:r></w:p></w:body></w:document>`,
    });
    const out = await importDocx(bytes);
    // no styles part: Word's own defaults apply (Times New Roman 10pt, single spacing, no gap)
    expect(out.html).toBe('<p style="margin-bottom:0pt; line-height:1.22"><span style="font-family:Times New Roman; font-size:10pt">Only text</span></p>');
    expect(out.pageSetup!.size).toBe('letter');
    expect(out.title).toBeUndefined();
  });
});
