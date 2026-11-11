import { marked } from 'marked';
import TurndownService from 'turndown';
// @ts-expect-error — no bundled types
import { gfm } from 'turndown-plugin-gfm';
import { decodeText, utf8Encode } from '../dom';
import { sanitizeHtml } from '../sanitize';
import type { Exporter, Importer } from '../types';

export const importMarkdown: Importer = async (bytes) => {
  const source = decodeText(bytes);
  const html = await marked.parse(source, { gfm: true, breaks: false, async: true });
  const m = /^\s*#\s+(.+?)\s*$/m.exec(source);
  return { html: sanitizeHtml(html) || '<p></p>', title: m?.[1] };
};

let turndown: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (turndown) return turndown;
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    hr: '---',
  });
  td.use(gfm);
  td.addRule('underline', { filter: ['u'], replacement: (content) => (content ? `<u>${content}</u>` : '') });
  // Tables: turndown-plugin-gfm only converts tables whose first row is a header row. The editor
  // allows header-less tables, so cells inside <p> wrappers are flattened and a header is forced.
  td.addRule('cellParagraph', {
    filter: (node) => node.nodeName === 'P' && !!node.parentElement && /^(TD|TH)$/.test(node.parentElement.nodeName),
    replacement: (content, node) => (node.nextElementSibling ? content + '<br>' : content),
  });
  turndown = td;
  return td;
}

function ensureHeaderRows(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('table').forEach((table) => {
    const firstRow = table.querySelector('tr');
    if (!firstRow) return;
    const cells = Array.from(firstRow.children);
    if (cells.every((c) => c.tagName === 'TH')) return;
    for (const c of cells) {
      const th = doc.createElement('th');
      for (const a of Array.from(c.attributes)) th.setAttribute(a.name, a.value);
      while (c.firstChild) th.appendChild(c.firstChild);
      c.replaceWith(th);
    }
  });
  return doc.body.innerHTML;
}

// Turndown drops empty elements before custom rules run, so page breaks travel as a token.
const PAGE_BREAK_TOKEN = 'PAGEBREAKTOKEN7F3A';

export function htmlToMarkdown(html: string): string {
  const prepared = ensureHeaderRows(html).replace(/<div[^>]*data-page-break[^>]*><\/div>/g, `<p>${PAGE_BREAK_TOKEN}</p>`);
  const md = getTurndown().turndown(prepared);
  return md.split(PAGE_BREAK_TOKEN).join('<div style="page-break-after: always"></div>').trim() + '\n';
}

export const exportMarkdown: Exporter = async (doc) => utf8Encode(htmlToMarkdown(doc.html));
