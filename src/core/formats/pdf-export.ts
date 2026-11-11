import { cssLengthToPt, parseHtml } from '../dom';
import { DEFAULT_PAGE_SETUP, pageDimensions, type Exporter, type RichDocument } from '../types';

/**
 * Flow document → PDF. Lays the HTML out with pdfmake, which produces a real PDF with
 * selectable text, vector tables and embedded images (not a screenshot).
 *
 * Fonts: pdfmake embeds Roboto (Latin, Greek, Cyrillic). Font families chosen in the editor
 * are therefore not carried into the PDF, and scripts outside Roboto's coverage (CJK, emoji)
 * will not render — see the roadmap in docs/ARCHITECTURE.md.
 */

type Node = Record<string, unknown>;

/** Rewrites contract HTML into the dialect html-to-pdfmake understands best. */
function prepareHtml(html: string): string {
  const body = parseHtml(html);
  const doc = body.ownerDocument;

  body.querySelectorAll('div[data-page-break]').forEach((el) => {
    const p = doc.createElement('p');
    p.setAttribute('data-pdfmake', JSON.stringify({ pageBreak: 'after', text: '' }));
    el.replaceWith(p);
  });

  // TipTap wraps table-cell and list-item content in <p>; unwrap single paragraphs so
  // pdfmake doesn't add paragraph margins inside cells / bullets.
  body.querySelectorAll('td > p:only-child, th > p:only-child, li > p:only-child').forEach((p) => {
    const parent = p.parentElement!;
    const align = /text-align:\s*([a-z]+)/i.exec(p.getAttribute('style') ?? '')?.[1];
    if (align) parent.setAttribute('style', `${parent.getAttribute('style') ?? ''};text-align:${align}`);
    while (p.firstChild) parent.insertBefore(p.firstChild, p);
    p.remove();
  });

  body.querySelectorAll('[style]').forEach((el) => {
    const style = el.getAttribute('style') ?? '';
    const kept: string[] = [];
    for (const part of style.split(';')) {
      const i = part.indexOf(':');
      if (i < 0) continue;
      const prop = part.slice(0, i).trim().toLowerCase();
      const value = part.slice(i + 1).trim();
      if (prop === 'font-family') continue; // only Roboto is embedded
      if (prop === 'font-size') {
        const pt = cssLengthToPt(value);
        if (pt) kept.push(`font-size:${Math.round(pt * 100) / 100}pt`);
        continue;
      }
      if (prop === 'color' && el.tagName === 'MARK' && value === 'inherit') continue;
      kept.push(`${prop}:${value}`);
    }
    if (kept.length) el.setAttribute('style', kept.join(';'));
    else el.removeAttribute('style');
  });

  body.querySelectorAll('table').forEach((t) => {
    t.removeAttribute('style');
    t.querySelectorAll('colgroup').forEach((c) => c.remove());
  });

  // empty paragraphs are intentional blank lines
  body.querySelectorAll('p').forEach((p) => {
    if (!p.hasAttribute('data-pdfmake') && !p.textContent && !p.querySelector('img,br')) p.innerHTML = '&nbsp;';
  });
  return body.innerHTML;
}

/** Scales images to the printable width and makes tables span the page. */
function fixTree(node: unknown, maxWidth: number, maxHeight: number): void {
  if (Array.isArray(node)) {
    node.forEach((n) => fixTree(n, maxWidth, maxHeight));
    return;
  }
  if (!node || typeof node !== 'object') return;
  const n = node as Node;
  if (typeof n.image === 'string') {
    let w = typeof n.width === 'number' ? n.width * 0.75 : undefined; // px → pt
    let h = typeof n.height === 'number' ? n.height * 0.75 : undefined;
    if (w && h) {
      const k = Math.min(1, maxWidth / w, maxHeight / h);
      w *= k;
      h *= k;
      n.width = w;
      n.height = h;
    } else {
      delete n.width;
      delete n.height;
      n.fit = [maxWidth, maxHeight];
    }
  }
  if (n.table && typeof n.table === 'object') {
    const table = n.table as { body?: unknown[][]; widths?: unknown[] };
    const cols = Math.max(0, ...(table.body ?? []).map((r) => r.length));
    if (cols > 0) table.widths = Array(cols).fill('*');
  }
  for (const key of ['stack', 'text', 'ul', 'ol', 'columns']) {
    if (Array.isArray(n[key])) fixTree(n[key], maxWidth, maxHeight);
  }
  if (n.table && typeof n.table === 'object') {
    const bodyRows = (n.table as { body?: unknown[][] }).body;
    if (Array.isArray(bodyRows)) {
      const cols = Math.max(1, ...bodyRows.map((r) => r.length));
      fixTree(bodyRows, maxWidth / cols - 10, maxHeight);
    }
  }
}

const PDFMAKE_PAGE_SIZE = { letter: 'LETTER', a4: 'A4', legal: 'LEGAL' } as const;

let enginePromise: Promise<{ pdfMake: any; htmlToPdfmake: any }> | null = null;

function loadEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const [pm, vfs, h2p]: any[] = await Promise.all([
        import('pdfmake/build/pdfmake'),
        import('pdfmake/build/vfs_fonts'),
        // @ts-expect-error — no type declarations
        import('html-to-pdfmake'),
      ]);
      const pdfMake = pm.default ?? pm;
      const fonts = vfs.default ?? vfs;
      pdfMake.addVirtualFileSystem(fonts.pdfMake?.vfs ?? fonts.vfs ?? fonts);
      return { pdfMake, htmlToPdfmake: h2p.default ?? h2p };
    })();
  }
  return enginePromise;
}

export async function renderFlowPdf(doc: RichDocument): Promise<Uint8Array> {
  const { pdfMake, htmlToPdfmake } = await loadEngine();
  const setup = doc.pageSetup ?? DEFAULT_PAGE_SETUP;
  const { width, height } = pageDimensions(setup);
  const m = setup.margins;
  const contentWidth = width - m.left - m.right;
  const contentHeight = height - m.top - m.bottom;

  const content = htmlToPdfmake(prepareHtml(doc.html), {
    window,
    removeExtraBlanks: true,
    defaultStyles: {
      h1: { fontSize: 20, bold: true, marginTop: 12, marginBottom: 6 },
      h2: { fontSize: 16, bold: true, marginTop: 10, marginBottom: 5 },
      h3: { fontSize: 13, bold: true, marginTop: 8, marginBottom: 4 },
      h4: { fontSize: 11, bold: true, marginTop: 6, marginBottom: 4 },
      h5: { fontSize: 11, bold: true, marginTop: 6, marginBottom: 4 },
      h6: { fontSize: 11, bold: true, italics: true, marginTop: 6, marginBottom: 4 },
      p: { margin: [0, 0, 0, 8] },
      a: { color: '#1a56db', decoration: 'underline' },
      blockquote: { margin: [18, 4, 0, 8], color: '#50535e', italics: true },
      pre: { fontSize: 9.5, background: '#f3f4f7', preserveLeadingSpaces: true, margin: [0, 4, 0, 8] },
      code: { fontSize: 9.5, background: '#f3f4f7' },
      th: { bold: true, fillColor: '#f0f1f5' },
      ul: { marginBottom: 8 },
      ol: { marginBottom: 8 },
      li: { marginLeft: 0 },
      table: { marginBottom: 8 },
    },
  });
  fixTree(content, contentWidth, contentHeight);

  const definition = {
    content,
    pageSize: PDFMAKE_PAGE_SIZE[setup.size],
    pageOrientation: setup.orientation,
    pageMargins: [m.left, m.top, m.right, m.bottom],
    defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.3, color: '#1b1b1f' },
    info: { title: doc.title || 'Document', producer: 'Document Editor', creator: 'Document Editor' },
  };
  const buffer = await pdfMake.createPdf(definition).getBuffer();
  return buffer instanceof Uint8Array ? new Uint8Array(buffer) : new Uint8Array(buffer as ArrayBuffer);
}

export const exportPdf: Exporter = renderFlowPdf;
