const CACHE_NAME = 'pivot-v0.0.12';
const ASSETS_TO_CACHE = [
  '/',
  '/chat/chat.html',
  '/chat/chat.css',
  '/chat/config.js',
  '/chat/ui.js',
  '/chat/auth.js',
  '/chat/rag.js',
  '/chat/admin.js',
  '/chat/users.js',
  '/chat/models.js',
  '/chat/stats.js',
  '/chat/extra.js',
  '/chat/render.js',
  '/chat/engine.js',
  '/chat/sidebar.js',
  '/chat/app.js',
  '/common/logo.png',
  '/common/styles/theme.css',
  '/common/vendor/marked.min.js',
  '/common/vendor/purify.min.js',
  '/common/vendor/highlight.min.js',
  '/common/vendor/katex.min.js',
  '/common/vendor/katex.min.css',
  '/common/vendor/github-dark.min.css'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => Promise.all(
      cacheNames.map((cache) => {
        if (cache !== CACHE_NAME) return caches.delete(cache);
        return undefined;
      })
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const shouldCache = ASSETS_TO_CACHE.includes(url.pathname) || url.pathname.startsWith('/common/vendor/');
  if (!shouldCache) return;

  if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/chat/chat.html') {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
        return networkResponse;
      }).catch(() => cachedResponse);
      return cachedResponse || fetchPromise;
    })
  );
});
