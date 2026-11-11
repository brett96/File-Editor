import { decodeText, escapeHtml, parseHtml, utf8Encode } from '../dom';
import type { Exporter, Importer } from '../types';

export const importText: Importer = async (bytes) => {
  const text = decodeText(bytes).replace(/\r\n?/g, '\n');
  // Blank lines separate paragraphs; single newlines inside a paragraph become line breaks.
  const paragraphs = text.split(/\n{2,}/);
  const html = paragraphs
    .map((p) => {
      const lines = p.split('\n').map((l) => escapeHtml(l.replace(/\t/g, '    ')));
      return `<p>${lines.join('<br>')}</p>`;
    })
    .join('');
  return { html: html || '<p></p>' };
};

const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'li', 'tr', 'div', 'hr', 'table', 'ul', 'ol']);

/** Block-aware plain-text rendering of contract HTML. */
export function htmlToPlainText(html: string): string {
  const body = parseHtml(html);
  const out: string[] = [];
  const rowStack: string[][] = [];
  let line = '';

  const flush = (blank = false) => {
    if (line.trim() || blank) out.push(line.replace(/[ \t]+$/g, ''));
    line = '';
  };

  const walk = (node: Node, listStack: { ordered: boolean; n: number }[]) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        line += (child.textContent ?? '').replace(/\s+/g, ' ');
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (tag === 'br') {
        out.push(line);
        line = '';
        continue;
      }
      if (tag === 'hr') {
        flush();
        out.push('----------------------------------------', '');
        continue;
      }
      if (tag === 'img') {
        const alt = el.getAttribute('alt');
        line += alt ? `[image: ${alt}]` : '[image]';
        continue;
      }
      if (tag === 'pre') {
        flush();
        out.push(...(el.textContent ?? '').replace(/\n$/, '').split('\n'), '');
        continue;
      }
      if (tag === 'div' && el.getAttribute('data-page-break') === 'true') {
        flush();
        out.push('\f');
        continue;
      }
      if (tag === 'ul' || tag === 'ol') {
        flush();
        walk(el, [...listStack, { ordered: tag === 'ol', n: 0 }]);
        if (listStack.length === 0) out.push('');
        continue;
      }
      if (tag === 'li') {
        flush();
        const top = listStack[listStack.length - 1];
        const indent = '  '.repeat(Math.max(0, listStack.length - 1));
        line = indent + (top?.ordered ? `${++top.n}. ` : '- ');
        walk(el, listStack);
        flush();
        continue;
      }
      if (tag === 'td' || tag === 'th') {
        // collect everything the cell emits and fold it into a single tab-separated field
        const mark = out.length;
        line = '';
        walk(el, []);
        flush();
        const cell = out.splice(mark).filter((l) => l.trim()).join(' ').trim();
        rowStack[rowStack.length - 1]?.push(cell);
        continue;
      }
      if (tag === 'tr') {
        flush();
        rowStack.push([]);
        walk(el, listStack);
        line = rowStack.pop()!.join('\t');
        flush(true);
        continue;
      }
      if (tag === 'table') {
        flush();
        walk(el, listStack);
        out.push('');
        continue;
      }
      if (BLOCKS.has(tag)) {
        // a paragraph directly inside a list item continues the "- " / "1. " marker line
        if (!/^\s*(-|\d+\.)\s$/.test(line)) flush();
        walk(el, listStack);
        flush();
        if (listStack.length === 0 && !el.closest('td,th')) out.push('');
        continue;
      }
      if (tag === 'a') {
        const href = el.getAttribute('href');
        const text = el.textContent ?? '';
        walk(el, listStack);
        if (href && href !== text && !href.startsWith('#')) line += ` (${href})`;
        continue;
      }
      walk(el, listStack);
    }
  };

  walk(body, []);
  flush();
  // collapse runs of blank lines, trim the tail
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/g, '');
  return text + '\n';
}

export const exportText: Exporter = async (doc) => utf8Encode(htmlToPlainText(doc.html));
