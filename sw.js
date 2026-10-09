const CACHE = 'easyread-shell-v24';
const SHELL = ['./', './index.html', './style.css', './pdf-reader.css', './script.js', './app.js', './firebase-config.js', './manifest.webmanifest', './icon.svg', './pdfjs/pdf.mjs', './pdfjs/pdf.worker.mjs'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const request = event.request;
  const url = new URL(request.url);
  const isAppShell =
    request.mode === 'navigate' ||
    url.origin === self.location.origin &&
    /\.(?:html|js|css|webmanifest)$/.test(url.pathname);

  if (!isAppShell) {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request).catch(() => Response.error()))
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then(
          cached => cached || (request.mode === 'navigate' ? caches.match('./index.html') : Response.error())
        )
      )
  );
});