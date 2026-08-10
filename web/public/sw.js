/**
 * Voice Keyboard service worker — offline app shell.
 *
 * The cache version is stamped at build time (see scripts/sw-version.ts and
 * the stamp-sw-cache-version Vite plugin): the __SW_CACHE_VERSION__ sentinel
 * below is replaced with a hash of the build output, so every deploy that
 * changes any asset also changes CACHE. On activate, old voicekb-* caches are
 * deleted, which is what frees clients that were stuck on a stale shell.
 *
 * Strategy: precache the index at install; navigation requests are
 * network-first so a new deploy is picked up immediately, falling back to the
 * cached shell when offline. Hashed Vite assets are immutable and stay
 * cache-first. BLE itself obviously needs the dongle and does not work
 * offline, but the shell loads.
 */
const CACHE = 'voicekb-__SW_CACHE_VERSION__';
const CACHE_PREFIX = 'voicekb-';
const BASE = self.registration.scope;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new URL('./', BASE).href))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) return;

  // Navigation requests: network first, fall back to cached shell offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match(new URL('./', BASE).href))),
    );
    return;
  }

  // Same-origin assets: cache first, populate on miss.
  if (request.url.startsWith(self.location.origin)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
