const { handleExplain } = require('../gemini-explain');

module.exports = async function explain(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const result = await handleExplain({ method: req.method, query: req.query || {}, headers: req.headers, ip });
  for (const [key, value] of Object.entries(result.headers || {})) res.setHeader(key, value);
  return res.status(result.status).json(result.body);
};
