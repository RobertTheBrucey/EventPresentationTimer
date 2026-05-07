// Service Worker — cache-first strategy for offline PWA support.
// Bump CACHE_NAME when deploying new versions to invalidate old caches.

const CACHE_NAME = 'ept-v2';

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/base.css',
  './css/display.css',
  './css/controller.css',
  './css/theme.css',
  './js/app.js',
  './js/state.js',
  './js/timer.js',
  './js/schedule.js',
  './js/webrtc.js',
  './js/pairing.js',
  './js/relay-client.js',
  './js/qrcode-lib.js',
  './js/qrcode.js',
  './js/display.js',
  './js/controller.js',
  './js/utils.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

const OFFLINE_FALLBACK = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EPTimer — Offline</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0d0d0d;color:#f0f0f0;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    min-height:100vh;gap:1rem;padding:2rem;text-align:center}
  h1{font-size:2rem}p{color:#a0a0a0}
</style>
</head><body>
<h1>EPTimer</h1>
<p>You're offline and the app hasn't been cached yet.</p>
<p>Visit the app online first to install it for offline use.</p>
</body></html>`;

// ── Install ───────────────────────────────────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate ──────────────────────────────────────────────────────────────────

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  // Skip non-GET, cross-origin, and WebSocket requests
  const { request } = event;
  if (request.method !== 'GET') return;
  if (!request.url.startsWith(self.location.origin)) return;

  // Skip relay probe requests (local LAN IPs) and cloud relay/ping paths
  if (request.url.includes(':7777')) return;
  const { pathname } = new URL(request.url);
  if (pathname === '/relay' || pathname === '/ping') return;

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Network failed and not in cache
          if (request.headers.get('accept')?.includes('text/html')) {
            return new Response(OFFLINE_FALLBACK, {
              headers: { 'Content-Type': 'text/html' },
            });
          }
          return new Response('', { status: 503 });
        });
    })
  );
});
