import { escapeHtml } from '../dom';
import { openPdf } from '../pdf/pdfjs';
import type { PageSetup, PageSize, RichDocument } from '../types';
import { PAGE_SIZES } from '../types';

/**
 * PDF → flow document. A PDF stores positioned glyphs, not paragraphs, so this reconstructs
 * reading order heuristically: glyph runs → lines → paragraphs, with headings guessed from
 * font size and bullets from leading glyphs. Images, tables and multi-column layouts are not
 * reconstructed. Good for getting the text of a PDF into an editable / convertible form.
 */

interface Run {
  str: string;
  x: number;
  y: number; // top-origin baseline
  w: number;
  size: number;
}

interface Line {
  y: number;
  x: number;
  size: number;
  text: string;
}

function nearestPageSize(w: number, h: number): { size: PageSize; orientation: 'portrait' | 'landscape' } {
  const landscape = w > h;
  const [pw, ph] = landscape ? [h, w] : [w, h];
  let best: PageSize = 'letter';
  let bestD = Infinity;
  for (const [name, s] of Object.entries(PAGE_SIZES) as [PageSize, { width: number; height: number }][]) {
    const d = Math.abs(s.width - pw) + Math.abs(s.height - ph);
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return { size: best, orientation: landscape ? 'landscape' : 'portrait' };
}

function buildLines(runs: Run[]): Line[] {
  runs.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Run[][] = [];
  for (const r of runs) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].y - r.y) <= Math.max(last[0].size, r.size) * 0.45) last.push(r);
    else lines.push([r]);
  }
  return lines
    .map((items) => {
      items.sort((a, b) => a.x - b.x);
      let text = '';
      let end = items[0].x;
      for (const it of items) {
        const gap = it.x - end;
        if (text && gap > it.size * 0.18 && !text.endsWith(' ') && !it.str.startsWith(' ')) text += ' ';
        text += it.str;
        end = it.x + it.w;
      }
      const size = Math.max(...items.map((i) => i.size));
      return { y: items[0].y, x: items[0].x, size, text: text.replace(/\s+/g, ' ').trim() };
    })
    .filter((l) => l.text);
}

const BULLET = /^([•◦▪■●○·‣⁃\-–*])\s+(.*)$/;
const NUMBERED = /^(\d{1,3}|[a-zA-Z])[.)]\s+(.*)$/;

export async function importPdfAsFlow(bytes: Uint8Array): Promise<RichDocument> {
  const { doc, close } = await openPdf(bytes);
  try {
    const pages: Line[][] = [];
    let firstSize: { w: number; h: number } | null = null;
    const sizeWeights = new Map<number, number>();

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      if (!firstSize) firstSize = { w: vp.width, h: vp.height };
      const tc = await page.getTextContent();
      const runs: Run[] = [];
      for (const item of tc.items) {
        if (!('str' in item) || !item.str) continue;
        const t = item.transform as number[];
        const [a, b, c, d, e, f] = vp.transform as number[];
        // text matrix → viewport space
        const x = a * t[4] + c * t[5] + e;
        const y = b * t[4] + d * t[5] + f;
        const size = Math.hypot(t[2], t[3]) || item.height || 10;
        runs.push({ str: item.str, x, y, w: item.width, size: Math.round(size * 2) / 2 });
        sizeWeights.set(Math.round(size * 2) / 2, (sizeWeights.get(Math.round(size * 2) / 2) ?? 0) + item.str.length);
      }
      pages.push(buildLines(runs));
      page.cleanup();
    }

    let bodySize = 11;
    let top = 0;
    for (const [size, weight] of sizeWeights) {
      if (weight > top) {
        top = weight;
        bodySize = size;
      }
    }

    const html: string[] = [];
    pages.forEach((lines, pageIndex) => {
      if (pageIndex > 0) html.push('<div data-page-break="true"></div>');
      let para: string[] = [];
      let list: 'ul' | 'ol' | null = null;
      let prev: Line | null = null;

      const closeList = () => {
        if (list) html.push(`</${list}>`);
        list = null;
      };
      const flush = () => {
        if (!para.length) return;
        const text = para.join(' ');
        para = [];
        const size = prev?.size ?? bodySize;
        const ratio = size / bodySize;
        const short = text.length < 120;
        const bullet = BULLET.exec(text);
        const numbered = !bullet ? NUMBERED.exec(text) : null;
        if (bullet || numbered) {
          const kind = bullet ? 'ul' : 'ol';
          if (list !== kind) {
            closeList();
            html.push(`<${kind}>`);
            list = kind;
          }
          html.push(`<li><p>${escapeHtml((bullet ?? numbered)![2])}</p></li>`);
          return;
        }
        closeList();
        const tag = short && ratio >= 1.6 ? 'h1' : short && ratio >= 1.3 ? 'h2' : short && ratio >= 1.12 ? 'h3' : 'p';
        html.push(`<${tag}>${escapeHtml(text)}</${tag}>`);
      };

      for (const line of lines) {
        if (prev) {
          const gap = line.y - prev.y;
          const newPara =
            gap > Math.max(prev.size, line.size) * 1.75 ||
            Math.abs(line.size - prev.size) > 0.75 ||
            BULLET.test(line.text) ||
            NUMBERED.test(line.text) ||
            line.x - prev.x > line.size * 1.2; // first-line indent
          if (newPara) flush();
        }
        // re-join words hyphenated across lines
        const last = para[para.length - 1];
        if (last && /[A-Za-z]-$/.test(last) && /^[a-z]/.test(line.text)) {
          para[para.length - 1] = last.slice(0, -1) + line.text;
        } else {
          para.push(line.text);
        }
        prev = line;
      }
      flush();
      closeList();
    });

    const meta = await doc.getMetadata().catch(() => null);
    const title = (meta?.info as { Title?: string } | undefined)?.Title || undefined;
    const ps = firstSize ? nearestPageSize(firstSize.w, firstSize.h) : { size: 'letter' as PageSize, orientation: 'portrait' as const };
    const pageSetup: PageSetup = { ...ps, margins: { top: 72, right: 72, bottom: 72, left: 72 } };
    return { html: html.join('') || '<p></p>', title, pageSetup };
  } finally {
    await close();
  }
}
