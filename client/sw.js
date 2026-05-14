/**
 * Pivot Service Worker
 * Policy: cache stable vendor assets only. App HTML/CSS/JS and API traffic always use network.
 */
const SW_POLICY = 'vendor-only';
const SW_VERSION = 'pivot-sw-vendor-only-v2';
const CACHE_PREFIX = 'pivot-';
const VENDOR_CACHE = `${CACHE_PREFIX}vendor-${SW_VERSION}`;

const VENDOR_ASSETS = [
  '/common/logo.png',
  '/favicon.png',
  '/common/vendor/marked.min.js',
  '/common/vendor/purify.min.js',
  '/common/vendor/highlight.min.js',
  '/common/vendor/katex.min.js',
  '/common/vendor/katex.min.css',
  '/common/vendor/github-dark.min.css'
];

const isVendorAsset = (pathname) => VENDOR_ASSETS.includes(pathname) || pathname.startsWith('/common/vendor/');

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(VENDOR_CACHE);
    await Promise.allSettled(VENDOR_ASSETS.map((asset) => cache.add(new Request(asset, { cache: 'reload' }))));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== VENDOR_CACHE)
        .map((name) => caches.delete(name))
    );
    await self.clients.claim();
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    clients.forEach((client) => client.postMessage({ type: 'PIVOT_SW_READY', version: SW_VERSION, policy: SW_POLICY }));
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (event.data?.type === 'CLEAR_PIVOT_CACHES') {
    event.waitUntil((async () => {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.filter((name) => name.startsWith(CACHE_PREFIX)).map((name) => caches.delete(name)));
      event.source?.postMessage({ type: 'PIVOT_CACHES_CLEARED' });
    })());
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') return;

  if (!isVendorAsset(url.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(VENDOR_CACHE);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response && response.status === 200 && response.type === 'basic') {
      cache.put(event.request, response.clone());
    }
    return response;
  })());
});
