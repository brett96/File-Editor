import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { openPdf, type OpenedPdf } from '../../core/pdf/pdfjs';
import type { PdfSource } from '../../core/pdf/types';

/** Shared cache of opened pdf.js documents, one per source. */
export class PdfSourceCache {
  private docs = new Map<string, Promise<OpenedPdf>>();

  get(source: PdfSource): Promise<PDFDocumentProxy> {
    let p = this.docs.get(source.id);
    if (!p) {
      p = openPdf(source.bytes);
      this.docs.set(source.id, p);
    }
    return p.then((o) => o.doc);
  }

  async page(source: PdfSource, index: number): Promise<PDFPageProxy> {
    return (await this.get(source)).getPage(index + 1);
  }

  async dispose(): Promise<void> {
    const all = [...this.docs.values()];
    this.docs.clear();
    await Promise.all(all.map((p) => p.then((o) => o.close()).catch(() => undefined)));
  }
}

export interface TextRun {
  /** view-space rectangle, points */
  x: number;
  y: number;
  width: number;
  height: number;
  baseline: number;
  fontSize: number;
  text: string;
  family: 'serif' | 'sans-serif' | 'monospace';
  bold: boolean;
  italic: boolean;
}

/** Maps a pdf.js font name / CSS family to the closest standard PDF font traits. */
export function classifyPdfFont(fontName: string, fontFamily: string): Pick<TextRun, 'family' | 'bold' | 'italic'> {
  const raw = `${fontName} ${fontFamily}`.toLowerCase().replace(/[+_,-]+/g, ' ');
  const italic = /\b(italic|oblique|ital)\b/.test(raw);
  // "semibold" / "demibold" count as bold for Standard-14 substitution
  const bold = /\b(bold|black|heavy|semibold|semi bold|demibold|demi bold|extrabold|extra bold)\b/.test(raw);
  const family: TextRun['family'] =
    /\b(mono|courier|consolas|menlo|monaco|lucida console|andale mono|source code)\b/.test(raw) ? 'monospace'
    : /\b(serif|times|georgia|garamond|palatino|cambria|constantia|bookman|century|roman)\b/.test(raw)
        && !/\bsans\b/.test(raw) ? 'serif'
    : 'sans-serif';
  return { family, bold, italic };
}

/** Extracts positioned text runs in view space (intrinsic rotation applied, scale 1). */
export async function extractTextRuns(page: PDFPageProxy): Promise<TextRun[]> {
  const { Util } = await import('pdfjs-dist');
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const runs: TextRun[] = [];
  for (const item of tc.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const tx = Util.transform(vp.transform, item.transform) as number[];
    // only horizontal (upright) text can be re-typed in place
    if (Math.abs(tx[1]) > 0.01 || Math.abs(tx[2]) > 0.01 || tx[0] <= 0) continue;
    const style = tc.styles[item.fontName];
    const size = Math.hypot(tx[2], tx[3]) || Math.abs(tx[3]);
    const ascent = style?.ascent && style.ascent > 0 ? style.ascent : 0.8;
    const descent = style?.descent && style.descent < 0 ? style.descent : -0.2;
    const classified = classifyPdfFont(item.fontName ?? '', style?.fontFamily ?? '');
    const width = item.width * (vp.scale || 1);
    runs.push({
      x: tx[4],
      y: tx[5] - size * ascent,
      width,
      height: size * (ascent - descent),
      baseline: tx[5],
      fontSize: Math.round(size * 10) / 10,
      text: item.str,
      family: classified.family,
      bold: classified.bold,
      italic: classified.italic,
    });
  }
  return runs;
}

interface Props {
  cache: PdfSourceCache;
  source: PdfSource | null;
  pageIndex: number;
  /** CSS px per point */
  scale: number;
  width: number;
  height: number;
  className?: string;
  /** Called with the canvas once a render completes (used for colour sampling). */
  onRendered?: (canvas: HTMLCanvasElement) => void;
  /** Only render once scrolled into view. */
  lazy?: boolean;
}

/** Renders one PDF page (or a blank sheet) into a canvas at the given scale. */
export function PageCanvas({ cache, source, pageIndex, scale, width, height, className, onRendered, lazy = true }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(!lazy);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!lazy || visible) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [lazy, visible]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !visible) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const pxW = Math.max(1, Math.floor(width * scale * dpr));
    const pxH = Math.max(1, Math.floor(height * scale * dpr));
    if (!source) {
      canvas.width = pxW;
      canvas.height = pxH;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, pxW, pxH);
      onRendered?.(canvas);
      return;
    }
    let cancelled = false;
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    (async () => {
      try {
        const page = await cache.page(source, pageIndex);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: scale * dpr });
        // render offscreen, then swap, so the old image stays visible while zooming
        const off = document.createElement('canvas');
        off.width = Math.floor(viewport.width);
        off.height = Math.floor(viewport.height);
        task = page.render({ canvas: off, viewport });
        await task.promise;
        if (cancelled) return;
        canvas.width = off.width;
        canvas.height = off.height;
        canvas.getContext('2d')!.drawImage(off, 0, 0);
        setFailed(false);
        onRendered?.(canvas);
      } catch (err) {
        if (!cancelled && (err as { name?: string })?.name !== 'RenderingCancelledException') setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, source, pageIndex, scale, width, height, visible]);

  return (
    <>
      <canvas ref={ref} className={className} style={{ width: width * scale, height: height * scale }} aria-hidden="true" />
      {failed && <div className="page-error">This page could not be rendered.</div>}
    </>
  );
}
