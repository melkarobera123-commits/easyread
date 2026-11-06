const { handleExplain } = require('../gemini-explain');

function normalizeQuery(req) {
  if (req && req.query && typeof req.query === 'object' && !Array.isArray(req.query)) return req.query;
  const raw = typeof req?.url === 'string' ? req.url : '';
  if (!raw) return {};
  const url = new URL(raw, 'http://localhost');
  const query = {};
  for (const [key, value] of url.searchParams.entries()) {
    const current = query[key];
    if (current === undefined) query[key] = value;
    else if (Array.isArray(current)) current.push(value);
    else query[key] = [current, value];
  }
  return query;
}

module.exports = async function explain(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const query = normalizeQuery(req);
  const result = await handleExplain({ method: req.method, query, headers: req.headers, ip });
  for (const [key, value] of Object.entries(result.headers || {})) res.setHeader(key, value);
  return res.status(result.status).json(result.body);
};
