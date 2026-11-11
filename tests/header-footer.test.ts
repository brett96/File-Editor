// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { exportDocx } from '../src/core/formats/docx-export';
import { importDocx } from '../src/core/formats/docx-import';
import { exportHtml } from '../src/core/formats/html';
import { parseHtml } from '../src/core/dom';

/** Smallest valid PNG (1×1, transparent). */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG = `data:image/png;base64,${PNG_B64}`;

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DRAW =
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

describe('headers and footers (DOCX)', () => {
  it('round-trips header and footer text, page-placed pictures and distances', async () => {
    const doc = {
      html: '<p>Body</p>',
      header: `<p style="text-align:right">Confidential<img src="${PNG}" width="200" height="50" data-float-x="48" data-float-y="-20" data-behind="true" alt="Band"></p>`,
      footer: '<p>Page footer</p>',
      pageSetup: { size: 'letter' as const, orientation: 'portrait' as const, margins: { top: 72, right: 72, bottom: 72, left: 72 }, headerDistance: 14.4, footerDistance: 30 },
    };
    const out = await importDocx(await exportDocx(doc));
    const header = parseHtml(out.header ?? '');
    expect(header.textContent).toContain('Confidential');
    const img = header.querySelector('img')!;
    expect(img.getAttribute('data-float-x')).toBe('48');
    expect(img.getAttribute('data-float-y')).toBe('-20');
    expect(img.getAttribute('data-behind')).toBe('true');
    expect(img.getAttribute('width')).toBe('200');
    expect(parseHtml(out.footer ?? '').textContent).toContain('Page footer');
    expect(out.pageSetup?.headerDistance).toBe(14.4);
    expect(out.pageSetup?.footerDistance).toBe(30);
    expect(parseHtml(out.html).textContent).toBe('Body');
  });

  it('writes no header or footer when there is none', async () => {
    const out = await importDocx(await exportDocx({ html: '<p>Only body</p>' }));
    expect(out.header).toBeUndefined();
    expect(out.footer).toBeUndefined();
  });

  it('places a Word header picture anchored to the column and paragraph on the page', async () => {
    // picture 0.5in right of the left margin and 0.25in above the header paragraph
    const anchor =
      '<w:drawing><wp:anchor behindDoc="1" simplePos="0" relativeHeight="1" locked="0" layoutInCell="1" allowOverlap="1">' +
      '<wp:simplePos x="0" y="0"/>' +
      '<wp:positionH relativeFrom="column"><wp:posOffset>457200</wp:posOffset></wp:positionH>' +
      '<wp:positionV relativeFrom="paragraph"><wp:posOffset>-228600</wp:posOffset></wp:positionV>' +
      '<wp:extent cx="952500" cy="476250"/><wp:wrapNone/><wp:docPr id="1" name="Logo"/>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
      '<pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm></pic:spPr>' +
      '</pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing>';
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    zip.file(
      'word/document.xml',
      `<w:document ${W}><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p>` +
        '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="12240" w:h="15840"/>' +
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720"/></w:sectPr></w:body></w:document>',
    );
    zip.file('word/_rels/document.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdH" Type="${REL}/header" Target="header1.xml"/></Relationships>`);
    zip.file('word/header1.xml', `<w:hdr ${W} ${DRAW}><w:p><w:r><w:t>Acme</w:t></w:r><w:r>${anchor}</w:r></w:p></w:hdr>`);
    zip.file('word/_rels/header1.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="${REL}/image" Target="media/logo.png"/></Relationships>`);
    zip.file('word/media/logo.png', PNG_B64, { base64: true });
    const out = await importDocx(await zip.generateAsync({ type: 'uint8array' }));
    const img = parseHtml(out.header ?? '').querySelector('img')!;
    // left margin 96px + 48px; header paragraph at 48px − 24px
    expect(img.getAttribute('data-float-x')).toBe('144');
    expect(img.getAttribute('data-float-y')).toBe('24');
    expect(img.getAttribute('width')).toBe('100');
    expect(img.getAttribute('data-behind')).toBe('true');
    expect(out.header).toContain('Acme');
  });

  it('prints the header on the page (HTML export)', async () => {
    const html = new TextDecoder().decode(
      await exportHtml({ html: '<p>Body</p>', header: `<p>Head<img src="${PNG}" width="10" height="10" data-float-x="5" data-float-y="6"></p>`, footer: '<p>Foot</p>' }),
    );
    expect(html).toContain('class="page-header"');
    expect(html).toContain('class="page-footer"');
    expect(html).toContain('Head');
    expect(html).toContain('<img style="left:5px; top:6px"');
  });
});
