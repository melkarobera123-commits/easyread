const { lookupWordnet } = require('../dictionary');
const { lookupRemoteDictionary } = require('../dictionary-fallback');

module.exports = async function definition(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

  const rawWord = Array.isArray(req.query?.word) ? req.query.word[0] : req.query?.word;
  const word = String(rawWord || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!/^[a-z][a-z0-9_'’\-]{0,59}$/.test(word)) return res.status(400).json({ error: 'Enter a valid word.' });

  try {
    const localResult = await lookupWordnet(word);
    if (localResult) {
      localResult.source = 'WordNet';
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000');
      return res.status(200).json(localResult);
    }

    const remoteResult = await lookupRemoteDictionary(word);
    if (remoteResult) {
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
      return res.status(200).json(remoteResult);
    }

    return res.status(404).json({ error: 'No definition was found in the local or fallback dictionaries.' });
  } catch (error) {
    console.error('Dictionary lookup failed:', error);
    return res.status(500).json({ error: 'Dictionary lookup is temporarily unavailable.' });
  }
};