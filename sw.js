// Precache everything; after that the app needs no network.
// Bump VERSION whenever any of these files changes, together with
// APP_VERSION in app.js (shown in the header).
const VERSION = 'v35';
const FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'worker.js',
  'core/geom.js',
  'core/piece.js',
  'core/segment.js',
  'core/reference.js',
  'core/match.js',
  'core/fit.js',
  'core/board.js',
  'core/knn.js',
  'core/gpu.js',
  'core/feature.js',
  'core/pipeline.js',
  'vendor/opencv.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
