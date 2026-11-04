// Chartsmith service worker: installable app shell, push notifications, tap-to-open.
// App files: network first, cached copy if offline. Market data (/api) is never cached.
const CACHE = 'chartsmith-v3';
const SHELL = ['/', '/app.js', '/style.css', '/engine.mjs', '/gridbot.mjs', '/icon.svg', '/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || /^\/(login|signup|logout|health)$/.test(u.pathname)) return;
  e.respondWith(fetch(e.request).then(r => {
    // only cache real app files, never a redirect to the sign-in page
    if (r.ok && !r.redirected && SHELL.includes(u.pathname)) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(u.pathname, copy)); }
    return r;
  }).catch(() => caches.match(u.pathname)));
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Chartsmith', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Chartsmith alert', {
    body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: d.tag || undefined, renotify: !!d.tag,
    data: { url: d.url || '/' }, timestamp: Date.now(),
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url || '/', location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (new URL(c.url).origin === location.origin) { c.postMessage({ type: 'open', url }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
