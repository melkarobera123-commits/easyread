const MAX_MEANINGS = 6;\nconst REQUEST_TIMEOUT_MS = 4500;\n\nfunction cleanText(value) {\n  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();\n}\n\nfunction uniqueMeanings(meanings) {\n  const seen = new Set();\n  return meanings.filter(item => {\n    const key = String(item.partOfSpeech || '') + '|' + String(item.definition || '').toLowerCase();\n    if (!item.definition || seen.has(key)) return false;\n    seen.add(key);\n    return true;\n  }).slice(0, MAX_MEANINGS);\n}\n\nasync function fetchJson(url, signal) {\n  const controller = new AbortController();\n  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);\n  const onAbort = () => controller.abort();\n  signal?.addEventListener('abort', onAbort, { once: true });\n  try {\n    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });\n    if (!response.ok) return null;\n    return await response.json();\n  } finally {\n    clearTimeout(timer);\n    signal?.removeEventListener('abort', onAbort);\n  }\n}\n\nfunction fromDictionaryApi(data, requestedWord) {\n  if (!Array.isArray(data)) return null;\n  const meanings = [];\n  let phonetic = '';\n  for (const entry of data) {\n    if (!phonetic && entry?.phonetic) phonetic = cleanText(entry.phonetic);\n    if (!phonetic && Array.isArray(entry?.phonetics)) {\n      const item = entry.phonetics.find(value => value?.text);\n      if (item?.text) phonetic = cleanText(item.text);\n    }\n    for (const meaning of entry?.meanings || []) {\n      const partOfSpeech = cleanText(meaning?.partOfSpeech) || 'unknown';\n      for (const item of meaning?.definitions || []) {\n        const definition = cleanText(item?.definition);\n        const example = cleanText(item?.example);\n        if (definition) meanings.push({ partOfSpeech, definition, example });\n      }\n    }\n  }\n  if (!meanings.length) return null;\n  return { word: cleanText(data[0]?.word) || requestedWord, phonetic, meanings: uniqueMeanings(meanings), source: 'Dictionary API' };\n}\n\nfunction fromWiktionary(data, requestedWord) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.en)) return null;
  const meanings = [];
  let phonetic = '';

  for (const entry of data.en) {
    const partOfSpeech = cleanText(entry?.partOfSpeech) || 'unknown';
    for (const item of entry?.definitions || []) {
      const definition = cleanText(item?.definition);
      const parsedExamples = Array.isArray(item?.parsedExamples) ? item.parsedExamples : [];
      const rawExamples = Array.isArray(item?.examples) ? item.examples : [];
      const example = cleanText(
        parsedExamples[0]?.example ||
        parsedExamples[0]?.text ||
        rawExamples[0]
      );
      if (definition) meanings.push({ partOfSpeech, definition, example });
    }
  }

  if (!meanings.length) return null;
  return {
    word: requestedWord,
    phonetic,
    meanings: uniqueMeanings(meanings),
    source: 'Wiktionary'
  };
}

async function lookupRemoteDictionary(word, signal) {\n  const encoded = encodeURIComponent(word.replace(/_/g, ' '));\n  const dictionaryApi = await fetchJson('https://api.dictionaryapi.dev/api/v2/entries/en/' + encoded, signal).catch(() => null);\n  const first = fromDictionaryApi(dictionaryApi, word);\n  if (first) return first;\n  const wiktionary = await fetchJson('https://en.wiktionary.org/api/rest_v1/page/definition/' + encoded, signal).catch(() => null);\n  return fromWiktionary(wiktionary, word);\n}\n\nmodule.exports = { lookupRemoteDictionary };