const CACHE = 'easyread-shell-v75';
const RUNTIME = 'easyread-runtime-v1';
const SHELL = ['./', './index.html', './style.css', './premium-ui.css', './pdf-reader.css', './script.js', './app.js', './firebase-config.js', './manifest.webmanifest', './icon.svg', './pdfjs/pdf.mjs', './pdfjs/pdf.worker.mjs', './pdf-text-layer.js'];
const NETWORK_WAIT_MS = 2500; // on a weak connection, show the saved copy instead of waiting

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.allSettled(SHELL.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE && key !== RUNTIME).map(key => caches.delete(key))))
      .then(() => self.registration.navigationPreload?.enable?.().catch(() => {}))
      .then(() => self.clients.claim())
  );
});

async function shellRequest(event) {
  const request = event.request;
  const cache = await caches.open(CACHE);
  // App routes such as /library are the same single page, so fall back to the saved index.html.
  const cached = (await cache.match(request, { ignoreSearch: true })) || (request.mode === 'navigate' ? await cache.match('./index.html') : undefined);
  const net = (async () => {
    const early = await event.preloadResponse;
    const response = early || await fetch(request);
    if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  })();
  net.catch(() => {});
  event.waitUntil(net.catch(() => {})); // finish refreshing the saved copy even after we answered from it
  if (!cached) {
    try { return await net; } catch { return request.mode === 'navigate' ? (await cache.match('./index.html')) || Response.error() : Response.error(); }
  }
  const slow = new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), NETWORK_WAIT_MS));
  try { return await Promise.race([net, slow]); } catch { return cached; }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME);
  const cached = await cache.match(request);
  const refresh = fetch(request).then(response => {
    if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone()).catch(() => {});
    return response;
  }).catch(() => null);
  return cached || (await refresh) || Response.error();
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const request = event.request;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin && url.pathname.startsWith('/api/')) return; // APIs go straight to the network (the app caches answers itself)

  if (request.mode === 'navigate' || (sameOrigin && /\.(?:html|js|css|webmanifest)$/.test(url.pathname) && !/^\/(?:pdfjs|vendor)\//.test(url.pathname))) {
    event.respondWith(shellRequest(event));
    return;
  }
  const heavyStatic = sameOrigin && /^\/(?:pdfjs|vendor)\//.test(url.pathname);
  const cdn = /(?:cdnjs\.cloudflare\.com|www\.gstatic\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|tessdata)/.test(url.hostname + url.pathname);
  const image = sameOrigin && /\.(?:png|svg|ico|jpg|jpeg|webp)$/.test(url.pathname);
  if (heavyStatic || cdn || image) event.respondWith(staleWhileRevalidate(request));
});
