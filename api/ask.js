const { handleAsk } = require('../gemini-explain');

module.exports = async function ask(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const result = await handleAsk({ method: req.method, body: req.body, headers: req.headers, ip });
  for (const [key, value] of Object.entries(result.headers || {})) res.setHeader(key, value);
  return res.status(result.status).json(result.body);
};
