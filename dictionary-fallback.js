const MAX_MEANINGS = 6;
const REQUEST_TIMEOUT_MS = 4500;

function cleanText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function uniqueMeanings(meanings) {
  const seen = new Set();
  return meanings.filter(item => {
    const key = String(item.partOfSpeech || '') + '|' + String(item.definition || '').toLowerCase();
    if (!item.definition || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_MEANINGS);
}

async function fetchJson(url, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'EasyRead/1.0 dictionary lookup' }, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function fromDictionaryApi(data, requestedWord) {
  if (!Array.isArray(data)) return null;
  const meanings = [];
  const synonyms = new Set();
  const antonyms = new Set();
  let phonetic = '';
  for (const entry of data) {
    if (!phonetic && entry?.phonetic) phonetic = cleanText(entry.phonetic);
    if (!phonetic && Array.isArray(entry?.phonetics)) {
      const item = entry.phonetics.find(value => value?.text);
      if (item?.text) phonetic = cleanText(item.text);
    }
    for (const meaning of entry?.meanings || []) {
      const partOfSpeech = cleanText(meaning?.partOfSpeech) || 'unknown';
      for (const item of meaning?.definitions || []) {
        const definition = cleanText(item?.definition);
        const example = cleanText(item?.example);
        for (const value of item?.synonyms || []) if (cleanText(value)) synonyms.add(cleanText(value));
        for (const value of item?.antonyms || []) if (cleanText(value)) antonyms.add(cleanText(value));
        if (definition) meanings.push({ partOfSpeech, definition, example });
      }
    }
  }
  if (!meanings.length) return null;
  return { word: cleanText(data[0]?.word) || requestedWord, phonetic, meanings: uniqueMeanings(meanings), synonyms: [...synonyms].slice(0, 8), antonyms: [...antonyms].slice(0, 8), source: 'Dictionary API' };
}

function fromWiktionary(data, requestedWord) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.en)) return null;
  const meanings = [];
  let phonetic = '';
  for (const entry of data.en) {
    const partOfSpeech = cleanText(entry?.partOfSpeech) || 'unknown';
    for (const item of entry?.definitions || []) {
      const definition = cleanText(item?.definition);
      const parsedExamples = Array.isArray(item?.parsedExamples) ? item.parsedExamples : [];
      const rawExamples = Array.isArray(item?.examples) ? item.examples : [];
      const example = cleanText(parsedExamples[0]?.example || parsedExamples[0]?.text || rawExamples[0]);
      if (definition) meanings.push({ partOfSpeech, definition, example });
    }
  }
  if (!meanings.length) return null;
  return { word: requestedWord, phonetic, meanings: uniqueMeanings(meanings), source: 'Wiktionary' };
}

async function lookupRemoteDictionary(word, signal) {
  const encoded = encodeURIComponent(word.replace(/_/g, ' '));
  const dictionaryApi = await fetchJson('https://api.dictionaryapi.dev/api/v2/entries/en/' + encoded, signal).catch(() => null);
  const first = fromDictionaryApi(dictionaryApi, word);
  if (first) return first;
  const wiktionary = await fetchJson('https://en.wiktionary.org/api/rest_v1/page/definition/' + encoded, signal).catch(() => null);
  return fromWiktionary(wiktionary, word);
}

module.exports = { lookupRemoteDictionary };