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

self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch (err) { d = { title: 'Brunnerschaft', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Brunnerschaft', {
    body: d.body || '', tag: d.tag || 'brun', icon: 'icon.png', badge: 'icon.png',
    data: { url: d.url || './' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.navigate(e.notification.data.url); return c.focus(); } }
    return clients.openWindow(e.notification.data.url);
  }));
});
