// Offline support. Pages and app code: network first (so updates arrive), cache as fallback.
// Icons and the Firebase SDK (versioned URLs): cache first.
// Firestore/Auth traffic is never touched; Firebase handles that with its own offline cache.
const CACHE = 'vokabelheft-v1';
const CORE = ['./', './index.html', './app.js', './firebase-config.js', './manifest.webmanifest',
              './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin && !/\.png$/.test(url.pathname)) {
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
  } else if (url.origin === location.origin || url.hostname === 'www.gstatic.com') {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    })));
  }
});
