import { decodeText, escapeHtml, utf8Encode } from '../dom';
import { sanitizeHtml } from '../sanitize';
import { DEFAULT_PAGE_SETUP, pageDimensions, type Exporter, type Importer } from '../types';

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
  body { font-family: Calibri, "Segoe UI", Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #1b1b1f; }
  h1 { font-size: 20pt; margin: 18pt 0 6pt; } h2 { font-size: 16pt; margin: 14pt 0 5pt; }
  h3 { font-size: 13pt; margin: 12pt 0 4pt; } h4, h5, h6 { font-size: 11pt; margin: 10pt 0 4pt; }
  p { margin: 0 0 8pt; }
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

export const exportHtml: Exporter = async (doc) => {
  const setup = doc.pageSetup ?? DEFAULT_PAGE_SETUP;
  const { width } = pageDimensions(setup);
  const m = setup.margins;
  const page = `
  @page { size: ${setup.size} ${setup.orientation}; margin: ${m.top}pt ${m.right}pt ${m.bottom}pt ${m.left}pt; }
  @media screen { body { max-width: ${Math.round(width - m.left - m.right)}pt; margin: 32px auto; padding: 0 24px; } }`;
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
${doc.html}
</body>
</html>
`;
  return utf8Encode(out);
};
