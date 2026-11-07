// Precache everything; after that the app needs no network.
// Bump VERSION whenever any of these files changes, together with
// APP_VERSION in app.js (shown in the header).
const VERSION = 'v45';
// All apps on michaelkrisper.github.io share one origin and thus one
// CacheStorage, so the cache name carries the app's prefix and cleanup only
// touches this app's caches (plus the unprefixed 'vN' names used up to v41).
const PREFIX = 'puzzlehelfer-';
const CACHE = PREFIX + VERSION;
const LEGACY = /^v\d+$/;
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
  'core/stitch.js',
  'core/track.js',
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
      .open(CACHE)
      .then((c) => c.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => (k.startsWith(PREFIX) && k !== CACHE) || LEGACY.test(k))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
