const CACHE_NAME = 'pivot-v1';
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
  '/common/vendor/marked.min.js',
  '/common/vendor/purify.min.js',
  '/common/vendor/highlight.min.js',
  '/common/vendor/katex.min.js',
  '/common/vendor/katex.min.css',
  '/common/vendor/github-dark.min.css'
];

// 安装阶段：预缓存核心资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// 激活阶段：清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// 拦截请求：Stale-While-Revalidate 策略
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // 仅缓存静态资源，API 请求直接透传
  if (ASSETS_TO_CACHE.includes(url.pathname) || url.pathname.startsWith('/common/vendor/')) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        const fetchPromise = fetch(event.request).then((networkResponse) => {
          // 检查响应是否有效
          if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
            return networkResponse;
          }
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
          return networkResponse;
        }).catch(() => {
          return cachedResponse; // 离线降级
        });
        return cachedResponse || fetchPromise;
      })
    );
  }
});
