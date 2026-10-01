const http = require('http');
const fs = require('fs');
const path = require('path');
const wordnet = require('wordnet-db');
const fsp = fs.promises;

const root = __dirname;
const port = Number(process.env.PORT || 8080);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const partsOfSpeech = [{ code: 'n', name: 'noun' }, { code: 'v', name: 'verb' }, { code: 'a', name: 'adjective' }, { code: 'r', name: 'adverb' }];
const wordnetIndexes = new Map();

function getWordnetIndex(pos) {
  if (!wordnetIndexes.has(pos.code)) {
    const file = path.join(wordnet.path, `index.${pos.code === 'a' ? 'adj' : pos.code === 'r' ? 'adv' : pos.code === 'n' ? 'noun' : 'verb'}`);
    wordnetIndexes.set(pos.code, fsp.readFile(file, 'utf8').then(text => {
      const offsets = [];
      let start = 0;
      while (start < text.length) {
        const end = text.indexOf('\n', start);
        const lineEnd = end < 0 ? text.length : end;
        if (/^\S+ [nvar] \d+ \d+ /.test(text.slice(start, lineEnd))) offsets.push(start);
        start = lineEnd + 1;
      }
      return { text, offsets: Uint32Array.from(offsets) };
    }).catch(error => { wordnetIndexes.delete(pos.code); throw error; }));
  }
  return wordnetIndexes.get(pos.code);
}

async function findWordnetEntry(pos, word) {
  const { text, offsets } = await getWordnetIndex(pos);
  let low = 0, high = offsets.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const start = offsets[middle], newline = text.indexOf('\n', start), line = text.slice(start, newline < 0 ? text.length : newline);
    const key = line.slice(0, line.indexOf(' '));
    if (key === word) return line;
    if (key < word) low = middle + 1;
    else high = middle - 1;
  }
  return null;
}

async function readWordnetGloss(pos, offset) {
  const name = pos.code === 'a' ? 'adj' : pos.code === 'r' ? 'adv' : pos.code === 'n' ? 'noun' : 'verb';
  const handle = await fsp.open(path.join(wordnet.path, `data.${name}`), 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, Number(offset));
    const record = buffer.toString('utf8', 0, bytesRead).split('\n', 1)[0];
    const gloss = record.slice(record.indexOf('|') + 1).trim();
    return gloss ? gloss.split('; "')[0].trim() : '';
  } finally { await handle.close(); }
}

async function lookupWordnet(word) {
  const meanings = [];
  for (const pos of partsOfSpeech) {
    const line = await findWordnetEntry(pos, word);
    if (!line) continue;
    const fields = line.trim().split(/\s+/), offsetStart = 6 + Number(fields[3]);
    for (const offset of fields.slice(offsetStart, offsetStart + 3)) {
      const definition = await readWordnetGloss(pos, offset);
      if (definition && !meanings.some(item => item.definition === definition)) meanings.push({ partOfSpeech: pos.name, definition, example: '' });
      if (meanings.length === 3) return { word: word.replace(/_/g, ' '), phonetic: '', meanings };
    }
  }
  return meanings.length ? { word: word.replace(/_/g, ' '), phonetic: '', meanings } : null;
}

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
