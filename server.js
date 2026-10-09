const http = require('http');
const fs = require('fs');
const path = require('path');
const { lookupWordnet } = require('./dictionary');
const { lookupRemoteDictionary } = require('./dictionary-fallback');
const { handleExplain } = require('./gemini-explain');

const root = __dirname;
const port = Number(process.env.PORT || 8080);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
function send(res, status, body, type = 'application/json') {
  const csp = ["default-src 'self'", "script-src 'self' https://cdnjs.cloudflare.com https://www.gstatic.com", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com", "font-src 'self' https://fonts.gstatic.com data:", "img-src 'self' data: blob: https://*.googleusercontent.com https://*.firebasestorage.app https://firebasestorage.googleapis.com", "media-src 'self' https://api.dictionaryapi.dev", "connect-src 'self' https://api.dictionaryapi.dev https://en.wiktionary.org https://api.datamuse.com https://api.mymemory.translated.net https://*.googleapis.com https://*.firebaseio.com https://*.firebasestorage.app https://firebasestorage.googleapis.com wss://*.firebaseio.com", "worker-src 'self' blob: https://cdnjs.cloudflare.com", "frame-src https://*.firebaseapp.com https://accounts.google.com https://*.google.com", "object-src 'none'", "base-uri 'self'", "form-action 'self'"].join('; ');
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'geolocation=(), camera=(), microphone=()', 'Content-Security-Policy': csp }); res.end(body);
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, JSON.stringify({ error: 'Method not allowed.' }));
  if (url.pathname === '/api/explain') {
    const query = Object.fromEntries(url.searchParams.entries());
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    return handleExplain({ method: req.method, query, headers: req.headers, ip }).then(result => {
      res.writeHead(result.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        ...result.headers
      });
      res.end(JSON.stringify(result.body));
    }).catch(error => {
      console.error('AI explanation failed:', error);
      send(res, 500, JSON.stringify({ error: 'AI explanation is temporarily unavailable.' }));
    });
  }
  if (url.pathname === '/api/definition') {
    const word = (url.searchParams.get('word') || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (!/^[a-z][a-z0-9_'’\-]{0,59}$/.test(word)) return send(res, 400, JSON.stringify({ error: 'Enter a valid word.' }));
    return lookupWordnet(word).then(async localResult => {
      if (localResult) { localResult.source = 'WordNet'; return send(res, 200, JSON.stringify(localResult)); }
      const remoteResult = await lookupRemoteDictionary(word);
      return send(res, remoteResult ? 200 : 404, JSON.stringify(remoteResult || { error: 'No definition was found in the local or fallback dictionaries.' }));
    }).catch(error => {
      console.error('Dictionary lookup failed:', error);
      send(res, 500, JSON.stringify({ error: 'Dictionary lookup is temporarily unavailable.' }));
    });
  }
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + path.sep)) return send(res, 403, JSON.stringify({ error: 'Forbidden.' }));
  fs.readFile(file, (error, data) => error ? send(res, 404, JSON.stringify({ error: 'Not found.' })) : send(res, 200, data, types[path.extname(file)] || 'application/octet-stream'));
});

server.listen(port, () => console.log(`EasyRead running at http://localhost:${port}`));
