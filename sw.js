// Brunnerschaft-Dashboard Service Worker
// Netz-zuerst mit Cache-Fallback: online immer frisch (Live-Daten!), offline/lahm die letzte Version.
const CACHE = 'brunnerschaft-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.mode !== 'navigate') return; // nur die Seite selbst — alles andere ist eingebettet
  e.respondWith((async () => {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 4500);
      const fresh = await fetch(req, { signal: ctrl.signal });
      clearTimeout(to);
      if (fresh && fresh.ok) {
        const c = await caches.open(CACHE);
        c.put('shell', fresh.clone());
      }
      return fresh;
    } catch (err) {
      const c = await caches.open(CACHE);
      const hit = await c.match('shell');
      if (hit) return hit;
      throw err;
    }
  })());
});
