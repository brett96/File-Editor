/**
 * Where a bundled preview page is shown from.
 *
 * A frame filled through `srcdoc` (or a blob: URL) inherits the app's Content-Security-Policy,
 * which allows no inline scripts, so a previewed page's JavaScript would never run in the
 * built app. The page is therefore served from a real URL that carries its own policy:
 *  - desktop: the main process keeps the document and serves it from fe-preview://;
 *  - web (production): the page is put in Cache Storage and a small service worker, scoped to
 *    `__preview__/` only, answers the frame's navigation from it;
 *  - development server (no CSP) and anything else: `srcdoc` in a sandboxed frame.
 * Either way the document is sandboxed (opaque origin, no access to the app or its storage)
 * and its policy names no network source: the preview is offline.
 */

/** The response headers of a previewed page (the desktop main process sends the same policy). */
export const PREVIEW_CSP = "sandbox allow-scripts allow-forms allow-modals; default-src data: blob: 'unsafe-inline' 'unsafe-eval'";

const CACHE_NAME = 'fe-preview';

export type PreviewTarget = { url: string } | { srcDoc: string };

let version = 0;
let worker: Promise<boolean> | null = null;

function base(): string {
  return (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');
}

/** Registers the preview service worker once; resolves false where it can't be used. */
function previewWorker(): Promise<boolean> {
  if (!worker) {
    worker = (async () => {
      if (!import.meta.env.PROD || window.desktop || !('serviceWorker' in navigator) || typeof caches === 'undefined' || !window.isSecureContext) return false;
      try {
        const reg = await navigator.serviceWorker.register(`${base()}preview-sw.js`, { scope: `${base()}__preview__/` });
        if (reg.active) return true;
        const sw = reg.installing ?? reg.waiting;
        if (!sw) return false;
        return await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 8000);
          sw.addEventListener('statechange', () => {
            if (sw.state === 'activated') {
              clearTimeout(timer);
              resolve(true);
            } else if (sw.state === 'redundant') {
              clearTimeout(timer);
              resolve(false);
            }
          });
        });
      } catch {
        return false;
      }
    })();
  }
  return worker;
}

/** Makes `html` available to a frame; `id` names the tab's preview (letters, digits, - and _). */
export async function publishPreview(id: string, html: string): Promise<PreviewTarget> {
  const v = ++version;
  try {
    const desktop = window.desktop?.preview;
    if (desktop) return { url: `${await desktop.set(id, html)}?v=${v}` };
    if (await previewWorker()) {
      const url = new URL(`${base()}__preview__/${id}`, location.href).href;
      const cache = await caches.open(CACHE_NAME);
      await cache.put(
        url,
        new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PREVIEW_CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
        }),
      );
      return { url: `${url}?v=${v}` };
    }
  } catch {
    /* fall back to srcdoc */
  }
  return { srcDoc: html };
}

/** Forgets a tab's preview document (the tab was closed). */
export function disposePreview(id: string): void {
  try {
    window.desktop?.preview?.clear(id);
    if (worker && typeof caches !== 'undefined') {
      void worker.then((ok) => ok && caches.open(CACHE_NAME).then((c) => c.delete(new URL(`${base()}__preview__/${id}`, location.href).href))).catch(() => undefined);
    }
  } catch {
    /* nothing to clean up */
  }
}
