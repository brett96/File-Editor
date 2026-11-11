/**
 * Lazy pdf.js loader. In the browser / Electron renderer the parser runs in a web worker and
 * loads its character maps, standard fonts and WASM image decoders from /pdfjs/ (copied from
 * node_modules by scripts/copy-pdfjs-assets.mjs). Under Node (tests) pdf.js falls back to its
 * built-in in-process worker.
 */
import type * as PdfJs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';

let libPromise: Promise<typeof PdfJs> | null = null;

const inBrowser = typeof window !== 'undefined' && typeof Worker !== 'undefined';

export function loadPdfjs(): Promise<typeof PdfJs> {
  if (!libPromise) {
    libPromise = (async () => {
      if (inBrowser) {
        const [lib, worker] = await Promise.all([
          import('pdfjs-dist'),
          import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
        ]);
        lib.GlobalWorkerOptions.workerSrc = worker.default;
        return lib;
      }
      return (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as typeof PdfJs;
    })();
  }
  return libPromise;
}

function assetBase(): string | null {
  if (!inBrowser) return null;
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return new URL(base + 'pdfjs/', document.baseURI).href;
}

export interface OpenedPdf {
  doc: PDFDocumentProxy;
  close(): Promise<void>;
}

/** Opens (already decrypted) PDF bytes for rendering / text extraction. The input is copied. */
export async function openPdf(bytes: Uint8Array, password?: string): Promise<OpenedPdf> {
  const lib = await loadPdfjs();
  const assets = assetBase();
  const task: PDFDocumentLoadingTask = lib.getDocument({
    data: bytes.slice(),
    password,
    verbosity: 0,
    ...(assets
      ? {
          cMapUrl: assets + 'cmaps/',
          cMapPacked: true,
          standardFontDataUrl: assets + 'standard_fonts/',
          wasmUrl: assets + 'wasm/',
          iccUrl: assets + 'iccs/',
        }
      : {}),
  });
  const doc = await task.promise;
  return { doc, close: () => task.destroy() };
}
