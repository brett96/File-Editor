import { decodeText, escapeHtml, parseHtml, utf8Encode } from '../dom';
import { sanitizeHtml } from '../sanitize';
import { DEFAULT_HF_DISTANCE, DEFAULT_PAGE_SETUP, pageDimensions, type Exporter, type Importer } from '../types';

export const importHtml: Importer = async (bytes) => {
  let source = decodeText(bytes);
  // honour <meta charset> for non-UTF-8 legacy pages
  const charset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(source.slice(0, 2048))?.[1]?.toLowerCase();
  if (charset && charset !== 'utf-8' && charset !== 'utf8') {
    try {
      source = new TextDecoder(charset).decode(bytes);
    } catch {
      /* unknown label — keep the default decoding */
    }
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1]?.trim();
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(source);
  const html = sanitizeHtml(bodyMatch ? bodyMatch[1] : source);
  return { html: html || '<p></p>', title: title ? decodeEntities(title) : undefined };
};

function decodeEntities(s: string): string {
  const doc = new DOMParser().parseFromString(`<body>${s}</body>`, 'text/html');
  return doc.body.textContent ?? s;
}

/** CSS shared by the standalone HTML export so the file looks like the editor page. */
export const DOCUMENT_CSS = `
  body { font-family: Calibri, "Segoe UI", Arial, sans-serif; font-size: 11pt; line-height: 1.32; color: #1b1b1f; }
  h1 { font-size: 20pt; margin: 18pt 0 4pt; } h2 { font-size: 16pt; margin: 14pt 0 4pt; }
  h3 { font-size: 14pt; margin: 12pt 0 4pt; } h4 { font-size: 12pt; margin: 10pt 0 4pt; }
  h5 { font-size: 11pt; margin: 10pt 0 4pt; } h6 { font-size: 10pt; margin: 10pt 0 4pt; }
  p { margin: 0 0 8pt; }
  p, h1, h2, h3, h4, h5, h6 { position: relative; }
  img[data-float-x] { position: absolute; max-width: none; }
  img[data-behind] { z-index: -1; }
  p:empty::before, h1:empty::before, h2:empty::before, h3:empty::before { content: "\\200b"; }
  blockquote { margin: 8pt 0 8pt 18pt; padding-left: 10pt; border-left: 3px solid #c9ccd6; color: #50535e; }
  pre { background: #f3f4f7; padding: 8pt; border-radius: 4px; font-family: Consolas, "Courier New", monospace; font-size: 10pt; white-space: pre-wrap; }
  code { font-family: Consolas, "Courier New", monospace; background: #f3f4f7; padding: 0 2px; border-radius: 3px; }
  table { border-collapse: collapse; margin: 8pt 0; width: 100%; }
  th, td { border: 1px solid #b9bcc7; padding: 4pt 6pt; vertical-align: top; }
  th { background: #f0f1f5; text-align: left; }
  img { max-width: 100%; height: auto; }
  a { color: #1a56db; }
  hr { border: 0; border-top: 1px solid #b9bcc7; margin: 12pt 0; }
  div[data-page-break] { break-after: page; page-break-after: always; height: 0; }
`;

/**
 * Column widths travel as colwidth on the cells (as in the editor); a standalone page needs them
 * as a <colgroup> and a fixed table width.
 */
function addColgroups(html: string): string {
  if (!/\bcolwidth=/.test(html)) return html;
  const root = parseHtml(html);
  for (const table of Array.from(root.querySelectorAll('table'))) {
    if (table.querySelector(':scope > colgroup')) continue;
    const firstRow = table.querySelector(':scope > tbody > tr, :scope > thead > tr, :scope > tr');
    if (!firstRow) continue;
    const widths: number[] = [];
    let complete = true;
    for (const cell of Array.from(firstRow.children)) {
      const span = Math.max(1, parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1);
      const w = (cell.getAttribute('colwidth') ?? '').split(',').map((v) => parseFloat(v));
      if (w.length !== span || !w.every((v) => v > 0)) complete = false;
      widths.push(...w);
    }
    if (!complete) continue;
    const colgroup = root.ownerDocument.createElement('colgroup');
    for (const w of widths) {
      const col = root.ownerDocument.createElement('col');
      col.setAttribute('style', `width: ${w}px`);
      colgroup.appendChild(col);
    }
    table.insertBefore(colgroup, table.firstChild);
    table.setAttribute('style', `width: ${widths.reduce((a, b) => a + b, 0)}px; table-layout: fixed`);
  }
  return root.innerHTML;
}

/** Floating images keep their position as data attributes; a standalone page needs it as CSS. */
function placeFloatingImages(html: string): string {
  html = addColgroups(html);
  return html.replace(/<img\b[^>]*\bdata-float-x="(-?[\d.]+)"[^>]*>/g, (tag) => {
    const x = /data-float-x="(-?[\d.]+)"/.exec(tag)?.[1] ?? '0';
    const y = /data-float-y="(-?[\d.]+)"/.exec(tag)?.[1] ?? '0';
    return tag.replace(/^<img\b/, `<img style="left:${x}px; top:${y}px"`);
  });
}

export const exportHtml: Exporter = async (doc) => {
  const setup = doc.pageSetup ?? DEFAULT_PAGE_SETUP;
  const { width, height } = pageDimensions(setup);
  const m = setup.margins;
  const hasHf = !!(doc.header?.trim() || doc.footer?.trim());
  let page: string;
  let body: string;
  if (!hasHf) {
    page = `
  @page { size: ${setup.size} ${setup.orientation}; margin: ${m.top}pt ${m.right}pt ${m.bottom}pt ${m.left}pt; }
  @media screen { body { max-width: ${Math.round(width - m.left - m.right)}pt; margin: 32px auto; padding: 0 24px; } }`;
    body = placeFloatingImages(doc.html);
  } else {
    // Headers / footers are page-sized layers (pictures in them are placed from the page corner).
    // When printing they are position:fixed, which repeats them on every page; the page margins
    // become a table header / footer row, which also repeats on every page.
    const hd = setup.headerDistance ?? DEFAULT_HF_DISTANCE;
    const fd = setup.footerDistance ?? DEFAULT_HF_DISTANCE;
    page = `
  @page { size: ${setup.size} ${setup.orientation}; margin: 0; }
  body { margin: 0; }
  .sheet { position: relative; width: ${width}pt; min-height: ${height}pt; background: #fff; }
  .page-header, .page-footer { position: absolute; left: 0; width: ${width}pt; height: ${height}pt; overflow: hidden; z-index: 0; }
  .page-header { top: 0; }
  .page-footer { bottom: 0; display: flex; flex-direction: column; justify-content: flex-end; }
  .page-header .hf-content { margin: 0 ${m.right}pt 0 ${m.left}pt; padding-top: ${hd}pt; }
  .page-footer .hf-content { margin: 0 ${m.right}pt 0 ${m.left}pt; padding-bottom: ${fd}pt; }
  .page-header p, .page-header h1, .page-header h2, .page-header h3, .page-header h4, .page-header h5, .page-header h6,
  .page-footer p, .page-footer h1, .page-footer h2, .page-footer h3, .page-footer h4, .page-footer h5, .page-footer h6 { position: static; }
  table.page-frame { position: relative; z-index: 1; width: 100%; margin: 0; border-collapse: collapse; table-layout: fixed; }
  table.page-frame > * > tr > td { border: 0; padding: 0 ${m.right}pt 0 ${m.left}pt; vertical-align: top; }
  table.page-frame > thead > tr > td { height: ${m.top}pt; padding: 0; }
  table.page-frame > tfoot > tr > td { height: ${m.bottom}pt; padding: 0; }
  @media screen {
    html { background: #e9eaee; }
    .sheet { margin: 32px auto; box-shadow: 0 2px 12px rgb(0 0 0 / 18%); }
  }
  @media print {
    .page-header, .page-footer { position: fixed; }
  }`;
    body = `<div class="sheet">
<div class="page-header"><div class="hf-content">${placeFloatingImages(doc.header ?? '')}</div></div>
<div class="page-footer"><div class="hf-content">${placeFloatingImages(doc.footer ?? '')}</div></div>
<table class="page-frame"><thead><tr><td></td></tr></thead><tfoot><tr><td></td></tr></tfoot><tbody><tr><td>
${placeFloatingImages(doc.html)}
</td></tr></tbody></table>
</div>`;
  }
  const out = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(doc.title || 'Document')}</title>
<style>${DOCUMENT_CSS}${page}
</style>
</head>
<body>
${body}
</body>
</html>
`;
  return utf8Encode(out);
};
