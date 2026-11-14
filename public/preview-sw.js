/*
 * Service worker for the code editor's web preview (browser build only).
 *
 * It is registered with the scope `__preview__/` and does one thing: answer a preview frame's
 * navigation with the bundled page the editor put in Cache Storage. That page is stored with
 * its own Content-Security-Policy (sandboxed, offline), which a frame filled through `srcdoc`
 * could not have: it would inherit the app's policy and its scripts would not run.
 * Nothing else is cached or intercepted; the app itself is never served from here.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.includes('/__preview__/')) return;
  event.respondWith(
    caches
      .open('fe-preview')
      .then((cache) => cache.match(event.request, { ignoreSearch: true }))
      .then(
        (hit) =>
          hit ||
          new Response('This preview is no longer available. Switch back to the editor to rebuild it.', {
            status: 404,
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': 'sandbox' },
          }),
      ),
  );
});
