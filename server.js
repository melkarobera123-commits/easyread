const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body);
}
function bodyOf(req) {
  return new Promise((resolve, reject) => { let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 1000000) req.destroy(); }); req.on('end', () => resolve(body)); req.on('error', reject); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/ai' && req.method === 'POST') {
    if (!process.env.OPENAI_API_KEY) return send(res, 503, JSON.stringify({ error: 'Set OPENAI_API_KEY before starting the server.' }));
    try {
      const input = JSON.parse(await bodyOf(req));
      const response = await fetch(baseUrl + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model, messages: [{ role: 'user', content: String(input.prompt || '').slice(0, 16000) }], temperature: .2 }) });
      const data = await response.json();
      if (!response.ok) return send(res, response.status, JSON.stringify({ error: data.error?.message || 'AI request failed.' }));
      return send(res, 200, JSON.stringify({ text: data.choices?.[0]?.message?.content || '' }));
    } catch (error) { return send(res, 500, JSON.stringify({ error: error.message })); }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, JSON.stringify({ error: 'Method not allowed.' }));
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + path.sep)) return send(res, 403, JSON.stringify({ error: 'Forbidden.' }));
  fs.readFile(file, (error, data) => error ? send(res, 404, JSON.stringify({ error: 'Not found.' })) : send(res, 200, data, types[path.extname(file)] || 'application/octet-stream'));
});

server.listen(port, () => console.log(`EasyRead running at http://localhost:${port}`));