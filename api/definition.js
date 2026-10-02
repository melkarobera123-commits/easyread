const { lookupWordnet } = require('../dictionary');

module.exports = async function definition(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

  const rawWord = Array.isArray(req.query?.word) ? req.query.word[0] : req.query?.word;
  const word = String(rawWord || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!/^[a-z0-9][a-z0-9_-]{0,59}$/.test(word)) return res.status(400).json({ error: 'Enter a valid word.' });

  try {
    const result = await lookupWordnet(word);
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(result ? 200 : 404).json(result || { error: 'No local definition found.' });
  } catch (error) {
    console.error('WordNet lookup failed:', error);
    return res.status(500).json({ error: 'Local WordNet dictionary is unavailable.' });
  }
};