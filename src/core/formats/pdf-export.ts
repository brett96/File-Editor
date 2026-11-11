import { cssLengthToPt, parseHtml } from '../dom';
import { DEFAULT_HF_DISTANCE, DEFAULT_PAGE_SETUP, pageDimensions, type Exporter, type RichDocument } from '../types';

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
    // column widths (colwidth on the first row's cells, px) → pdfmake widths in pt
    const row = t.querySelector(':scope > tbody > tr, :scope > thead > tr, :scope > tr');
    const widths: number[] = [];
    let complete = !!row;
    for (const cell of Array.from(row?.children ?? [])) {
      const span = Math.max(1, parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1);
      const w = (cell.getAttribute('colwidth') ?? '').split(',').map((v) => parseFloat(v));
      if (w.length !== span || !w.every((v) => v > 0)) complete = false;
      widths.push(...w.map((v) => v * 0.75));
    }
    if (complete && widths.length) t.setAttribute('data-pdfmake', JSON.stringify({ widths: widths.map((w) => Math.round(w * 100) / 100), exactWidths: true }));
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
  let cellWidths: number[] | null = null;
  if (n.table && typeof n.table === 'object') {
    const table = n.table as { body?: unknown[][]; widths?: unknown[]; exactWidths?: boolean };
    const cols = Math.max(0, ...(table.body ?? []).map((r) => r.length));
    if (table.exactWidths && Array.isArray(table.widths) && table.widths.length === cols) {
      // the document's own column widths (they include each cell's 4pt + 4pt padding), scaled to fit
      const outer = (table.widths as number[]).map((w) => Math.max(0, w));
      const k = Math.min(1, maxWidth / Math.max(1, outer.reduce((a, b) => a + b, 0)));
      cellWidths = outer.map((w) => w * k);
      table.widths = cellWidths.map((w) => Math.max(0.5, w - CELL_PADDING * 2));
    } else if (cols > 0) {
      table.widths = Array(cols).fill('*');
    }
    delete table.exactWidths;
  }
  for (const key of ['stack', 'text', 'ul', 'ol', 'columns']) {
    if (Array.isArray(n[key])) fixTree(n[key], maxWidth, maxHeight);
  }
  if (n.table && typeof n.table === 'object') {
    const bodyRows = (n.table as { body?: unknown[][] }).body;
    if (Array.isArray(bodyRows)) {
      const cols = Math.max(1, ...bodyRows.map((r) => r.length));
      for (const row of bodyRows) {
        if (!Array.isArray(row)) continue;
        // each cell's content gets its own column width (pdfmake keeps spanned cells as placeholders)
        row.forEach((cell, i) => {
          const span = Math.max(1, Number((cell as Node)?.colSpan) || 1);
          const width = cellWidths ? cellWidths.slice(i, i + span).reduce((a, b) => a + b, 0) - CELL_PADDING * 2 : (maxWidth / cols) * span - 10;
          fixTree(cell, Math.max(8, width), maxHeight);
        });
      }
    }
  }
}

/** pdfmake's default left / right cell padding, in pt. */
const CELL_PADDING = 4;

const PDFMAKE_PAGE_SIZE = { letter: 'LETTER', a4: 'A4', legal: 'LEGAL' } as const;

/**
 * Splits a header / footer into its page-placed pictures (drawn on every page as the page
 * background, at their position from the page corner) and the rest (its text).
 */
function splitHeaderFooter(html: string | undefined): { images: Node[]; html: string } {
  if (!html?.trim()) return { images: [], html: '' };
  const body = parseHtml(html);
  const images: Node[] = [];
  body.querySelectorAll('img[data-float-x]').forEach((img) => {
    const src = img.getAttribute('src') ?? '';
    const w = parseFloat(img.getAttribute('width') ?? '');
    const h = parseFloat(img.getAttribute('height') ?? '');
    if (/^data:image\/(png|jpe?g);/i.test(src) && w > 0 && h > 0) {
      images.push({
        image: src,
        width: w * 0.75,
        height: h * 0.75,
        absolutePosition: { x: parseFloat(img.getAttribute('data-float-x') ?? '0') * 0.75, y: parseFloat(img.getAttribute('data-float-y') ?? '0') * 0.75 },
      });
    }
    img.remove();
  });
  const text = body.textContent?.replace(/\s+/g, '') ? body.innerHTML : '';
  return { images, html: text };
}

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

  // header / footer: pictures become the page background, text the running header / footer
  const header = splitHeaderFooter(doc.header);
  const footer = splitHeaderFooter(doc.footer);
  const hfContent = (html: string) => {
    if (!html) return null;
    const c = htmlToPdfmake(prepareHtml(html), { window, removeExtraBlanks: true, defaultStyles: { p: { margin: [0, 0, 0, 0] } } });
    fixTree(c, contentWidth, contentHeight);
    return c;
  };
  const headerContent = hfContent(header.html);
  const footerContent = hfContent(footer.html);
  const background = [...header.images, ...footer.images];
  const hd = setup.headerDistance ?? DEFAULT_HF_DISTANCE;
  const fd = setup.footerDistance ?? DEFAULT_HF_DISTANCE;

  const definition = {
    content,
    ...(background.length ? { background: () => background } : {}),
    ...(headerContent ? { header: () => ({ stack: [headerContent], margin: [m.left, hd, m.right, 0] }) } : {}),
    ...(footerContent ? { footer: () => ({ stack: [footerContent], margin: [m.left, Math.max(0, m.bottom - fd - 14), m.right, 0] }) } : {}),
    pageSize: PDFMAKE_PAGE_SIZE[setup.size],
    pageOrientation: setup.orientation,
    pageMargins: [m.left, m.top, m.right, m.bottom],
    defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.3, color: '#1b1b1f' },
    info: { title: doc.title || 'Document', producer: 'File Editor', creator: 'File Editor' },
  };
  const buffer = await pdfMake.createPdf(definition).getBuffer();
  return buffer instanceof Uint8Array ? new Uint8Array(buffer) : new Uint8Array(buffer as ArrayBuffer);
}

export const exportPdf: Exporter = renderFlowPdf;
