const fs = require('fs');
const path = require('path');
const wordnet = require('wordnet-db');
const fsp = fs.promises;

const partsOfSpeech = [{ code: 'n', name: 'noun' }, { code: 'v', name: 'verb' }, { code: 'a', name: 'adjective' }, { code: 'r', name: 'adverb' }];
const wordnetIndexes = new Map();
const irregularForms = new Map(Object.entries({
  children: ['child'], people: ['person'], men: ['man'], women: ['woman'], feet: ['foot'], teeth: ['tooth'], mice: ['mouse'], geese: ['goose'], oxen: ['ox'], indices: ['index'], matrices: ['matrix'], vertices: ['vertex'], analyses: ['analysis'], bases: ['basis'], crises: ['crisis'], theses: ['thesis'], hypotheses: ['hypothesis'], phenomena: ['phenomenon'], criteria: ['criterion'], stimuli: ['stimulus'], fungi: ['fungus'], cacti: ['cactus'], alumni: ['alumnus'], data: ['datum'], media: ['medium'],
  am: ['be'], are: ['be'], is: ['be'], was: ['be'], were: ['be'], been: ['be'], being: ['be'], went: ['go'], gone: ['go'], did: ['do'], does: ['do'], done: ['do'], had: ['have'], has: ['have'], having: ['have'], got: ['get'], gotten: ['get'], made: ['make'], took: ['take'], taken: ['take'], gave: ['give'], given: ['give'], saw: ['see'], seen: ['see'], said: ['say'], told: ['tell'], thought: ['think'], knew: ['know'], known: ['know'], found: ['find'], felt: ['feel'], left: ['leave'], kept: ['keep'], began: ['begin'], begun: ['begin'], became: ['become'], brought: ['bring'], bought: ['buy'], caught: ['catch'], chose: ['choose'], chosen: ['choose'], came: ['come'], ran: ['run'], written: ['write'], wrote: ['write'], read: ['read'], ate: ['eat'], eaten: ['eat'], spoke: ['speak'], spoken: ['speak'], drove: ['drive'], driven: ['drive'], fell: ['fall'], fallen: ['fall'], flew: ['fly'], forgotten: ['forget'], grew: ['grow'], grown: ['grow'], held: ['hold'], led: ['lead'], lost: ['lose'], met: ['meet'], paid: ['pay'], rode: ['ride'], risen: ['rise'], sent: ['send'], sang: ['sing'], sung: ['sing'], sat: ['sit'], slept: ['sleep'], spent: ['spend'], stood: ['stand'], swam: ['swim'], taught: ['teach'], thrown: ['throw'], understood: ['understand'], wore: ['wear'], worn: ['wear'], won: ['win']
}));
const morphologyRules = {
  n: [['s', ''], ['ses', 's'], ['xes', 'x'], ['zes', 'z'], ['ches', 'ch'], ['shes', 'sh'], ['men', 'man'], ['ies', 'y'], ['ves', 'f'], ['ves', 'fe']],
  v: [['s', ''], ['ies', 'y'], ['es', 'e'], ['es', ''], ['ed', 'e'], ['ed', ''], ['ing', 'e'], ['ing', '']],
  a: [['er', ''], ['est', ''], ['er', 'e'], ['est', 'e']],
  r: []
};

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

function morphologyCandidates(word, pos) {
  const normalized = String(word || '').toLowerCase().replace(/[’']/g, "'").replace(/_+/g, '_');
  const possessiveBase = normalized.replace(/(?:'s|s')$/, '');
  const hyphenBase = normalized.replace(/-/g, '_');
  const candidates = [normalized, possessiveBase, hyphenBase, ...(irregularForms.get(normalized) || [])];
  for (const [suffix, replacement] of morphologyRules[pos.code]) {
    if (word.length > suffix.length && word.endsWith(suffix)) candidates.push(word.slice(0, -suffix.length) + replacement);
  }
  for (const candidate of [...candidates]) {
    if (/(.)\1$/.test(candidate)) candidates.push(candidate.slice(0, -1));
  }
  return [...new Set(candidates)];
}

async function readWordnetGloss(pos, offset) {
  const name = pos.code === 'a' ? 'adj' : pos.code === 'r' ? 'adv' : pos.code === 'n' ? 'noun' : 'verb';
  const handle = await fsp.open(path.join(wordnet.path, `data.${name}`), 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, Number(offset));
    const record = buffer.toString('utf8', 0, bytesRead).split('\n', 1)[0];
    const beforeGloss = record.slice(0, record.indexOf('|')).trim().split(/\s+/);
    const wordCount = parseInt(beforeGloss[3], 16) || 0;
    const synonyms = [];
    for (let index = 0; index < wordCount; index += 1) {
      const lemma = beforeGloss[4 + index * 2];
      if (lemma) synonyms.push(lemma.replace(/_/g, ' '));
    }
    const gloss = record.slice(record.indexOf('|') + 1).trim();
    if (!gloss) return null;
    const pieces = gloss.split('; "');
    const definition = pieces[0].trim();
    const example = pieces.length > 1 ? ('"' + pieces.slice(1).join('; "')).replace(/"$/, '').trim() : '';
    return definition ? { definition, example, synonyms } : null;
  } finally { await handle.close(); }
}

async function lookupWordnet(word) {
  const primaryMeanings = [], additionalMeanings = [], seen = new Set();
  for (const pos of partsOfSpeech) {
    let line = null;
    for (const candidate of morphologyCandidates(word, pos)) {
      line = await findWordnetEntry(pos, candidate);
      if (line) break;
    }
    if (!line) continue;
    const posMeanings = [];
    const fields = line.trim().split(/\s+/), offsetStart = 6 + Number(fields[3]);
    for (const offset of fields.slice(offsetStart, offsetStart + 8)) {
      const gloss = await readWordnetGloss(pos, offset);
      if (gloss?.definition && !seen.has(gloss.definition)) {
        seen.add(gloss.definition);
        posMeanings.push({ partOfSpeech: pos.name, definition: gloss.definition, example: gloss.example || '', synonyms: gloss.synonyms || [] });
      }
    }
    if (posMeanings.length) {
      primaryMeanings.push(posMeanings[0]);
      additionalMeanings.push(...posMeanings.slice(1));
    }
  }
  const meanings = [...primaryMeanings, ...additionalMeanings].slice(0, 6);
  return meanings.length ? { word: word.replace(/_/g, ' '), phonetic: '', meanings } : null;
}

module.exports = { lookupWordnet };