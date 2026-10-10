const CACHE_NAME = 'classpulse-shell-v3';

const APP_SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon.svg'
];

const OFFLINE_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ClassPulse • Offline</title>
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      text-align: center;
      padding: 20px;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 16px;
      padding: 32px 24px;
      max-width: 420px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    }
    .icon { font-size: 3.2rem; margin-bottom: 12px; }
    h1 { font-size: 1.4rem; margin: 0 0 12px; font-weight: 800; color: #ffffff; }
    p { font-size: 0.95rem; color: #94a3b8; line-height: 1.5; margin: 0 0 20px; }
    button {
      background: #4f46e5;
      color: #ffffff;
      border: none;
      padding: 10px 22px;
      border-radius: 8px;
      font-weight: 700;
      cursor: pointer;
      font-size: 0.9rem;
      transition: background 0.2s;
    }
    button:hover { background: #4338ca; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">📡</div>
    <h1>ClassPulse</h1>
    <p>You are offline. Reconnect to see live class status.</p>
    <button onclick="window.location.reload()">Retry Connection</button>
  </div>
</body>
</html>`;

// 1. Install Event: Cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL);
    }).then(() => self.skipWaiting())
  );
});

// 2. Activate Event: Clean up outdated caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// 3. Fetch Event
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // CRITICAL RULE: NEVER cache /api, /uploads, /socket.io, or non-GET requests
  // Always go straight to network for zero-stale-data guarantee
  if (
    request.method !== 'GET' ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/uploads/') ||
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/healthz')
  ) {
    event.respondWith(
      fetch(request).catch(() => {
        // Return 503 JSON for failed API calls when completely offline
        if (url.pathname.startsWith('/api/')) {
          return new Response(
            JSON.stringify({ error: 'Network offline. Please reconnect.' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return Promise.reject(new Error('Network offline'));
      })
    );
    return;
  }

  // Navigation requests: Network-first, fall back to cached shell or offline page
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          const cachedIndex = await caches.match('/index.html');
          if (cachedIndex) return cachedIndex;
          return new Response(OFFLINE_PAGE_HTML, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        })
    );
    return;
  }

  // App shell and static assets: Cache-first with network fallback
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        // Fetch in background to update cache for next time
        fetch(request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              caches.open(CACHE_NAME).then((cache) => cache.put(request, networkResponse));
            }
          })
          .catch(() => {});
        return cachedResponse;
      }

      return fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
          }
          return networkResponse;
        })
        .catch(() => {
          // Fallback if needed
          return new Response('Resource offline', { status: 503 });
        });
    })
  );
});
