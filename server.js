const http = require('http');
const fs = require('fs');
const path = require('path');
const { lookupWordnet } = require('./dictionary');

const root = __dirname;
const port = Number(process.env.PORT || 8080);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
function send(res, status, body, type = 'application/json') {
  const csp = ["default-src 'self'", "script-src 'self' https://cdnjs.cloudflare.com https://www.gstatic.com", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com", "font-src 'self' https://fonts.gstatic.com data:", "img-src 'self' data: blob: https://*.googleusercontent.com https://*.firebasestorage.app https://firebasestorage.googleapis.com", "connect-src 'self' https://api.dictionaryapi.dev https://en.wiktionary.org https://api.datamuse.com https://api.mymemory.translated.net https://*.googleapis.com https://*.firebaseio.com https://*.firebasestorage.app https://firebasestorage.googleapis.com wss://*.firebaseio.com", "worker-src 'self' blob: https://cdnjs.cloudflare.com", "frame-src https://*.firebaseapp.com https://accounts.google.com https://*.google.com", "object-src 'none'", "base-uri 'self'", "form-action 'self'"].join('; ');
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'geolocation=(), camera=(), microphone=()', 'Content-Security-Policy': csp }); res.end(body);
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, JSON.stringify({ error: 'Method not allowed.' }));
  if (url.pathname === '/api/definition') {
    const word = (url.searchParams.get('word') || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (!/^[a-z0-9][a-z0-9_-]{0,59}$/.test(word)) return send(res, 400, JSON.stringify({ error: 'Enter a valid word.' }));
    return lookupWordnet(word).then(result => send(res, result ? 200 : 404, JSON.stringify(result || { error: 'No local definition found.' }))).catch(error => {
      console.error('Local dictionary lookup failed:', error);
      send(res, 500, JSON.stringify({ error: 'Local dictionary is unavailable.' }));
    });
  }
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + path.sep)) return send(res, 403, JSON.stringify({ error: 'Forbidden.' }));
  fs.readFile(file, (error, data) => error ? send(res, 404, JSON.stringify({ error: 'Not found.' })) : send(res, 200, data, types[path.extname(file)] || 'application/octet-stream'));
});

server.listen(port, () => console.log(`EasyRead running at http://localhost:${port}`));
