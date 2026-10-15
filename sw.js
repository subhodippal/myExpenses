// Service worker: caches the app files so it opens offline once installed.
// Only runs when hosted (http/https), e.g. on GitHub Pages — browsers don't allow it on file://.
// Files are fetched network-first, so edits show up on the next online visit; bump CACHE if you add/rename files.
const CACHE = 'my-expenses-v86';
const FILES = [
  './',
  './index.html',
  './styles.css',
  './config.js',
  './db.js',
  './sync.js',
  './export.js',
  './import.js',
  './app.js',
  './vendor/supabase.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only handle our own files; Supabase API calls always go to the network.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Network first (so updates show up), fall back to cache when offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() =>
        caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html')),
      ),
  );
});
