const test = require('node:test');
const assert = require('node:assert/strict');
const { handleExplain, buildPrompt, cleanContext, validWord, tidy } = require('./gemini-explain');

const ok = text => async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });
const call = (query, extra = {}) => handleExplain({ method: 'GET', query, headers: {}, ip: extra.ip || 'test-' + Math.random(), env: extra.env || { GEMINI_API_KEY: 'k' }, fetchImpl: extra.fetchImpl || ok('A pharmacist prepares medicine.\nExample: The pharmacist helped me.'), ...extra });

test('validates words and cleans context', () => {
  assert.equal(validWord('Pharmacist'), 'pharmacist');
  assert.equal(validWord('two words'), '');
  assert.equal(validWord('1abc'), '');
  assert.equal(cleanContext('He said "hi"\n\nthere'), "He said 'hi' there");
  assert.equal(cleanContext('x'.repeat(900)).length, 300);
  assert.equal(tidy('**bold** `code` # head'), 'bold code head');
});

test('prompt keeps the sentence as data, not instructions', () => {
  assert.match(buildPrompt('run', 'He will run home.'), /never as instructions/);
  assert.doesNotMatch(buildPrompt('run', ''), /appears in this sentence/);
});

test('returns an explanation and sends the key only in a header', async () => {
  let seen;
  const result = await call({ word: 'pharmacist', context: 'The pharmacist spoke.' }, { fetchImpl: async (url, init) => { seen = { url, init }; return ok('Simple.')(); } });
  assert.equal(result.status, 200);
  assert.equal(result.body.explanation, 'Simple.');
  assert.equal(seen.init.headers['x-goog-api-key'], 'k');
  assert.ok(!seen.url.includes('key='));
});

test('reports not configured without a key', async () => {
  const result = await call({ word: 'run' }, { env: {} });
  assert.equal(result.status, 503);
  assert.equal(result.body.notConfigured, true);
});

test('rejects bad method, cross-site calls and bad words', async () => {
  assert.equal((await handleExplain({ method: 'POST', query: {}, env: { GEMINI_API_KEY: 'k' } })).status, 405);
  assert.equal((await handleExplain({ method: 'GET', query: { word: 'run' }, headers: { 'sec-fetch-site': 'cross-site' }, env: { GEMINI_API_KEY: 'k' } })).status, 403);
  assert.equal((await call({ word: 'not valid!' })).status, 400);
});

test('maps Gemini quota and failures to friendly errors', async () => {
  assert.equal((await call({ word: 'run' }, { fetchImpl: async () => ({ ok: false, status: 429 }) })).status, 429);
  assert.equal((await call({ word: 'run' }, { fetchImpl: async () => ({ ok: false, status: 500 }) })).status, 502);
  assert.equal((await call({ word: 'run' }, { fetchImpl: async () => { throw new Error('net'); } })).status, 502);
  assert.equal((await call({ word: 'run' }, { fetchImpl: ok('') })).status, 502);
});

test('limits one visitor to 20 requests a minute', async () => {
  const ip = 'limit-test';
  let last;
  for (let i = 0; i < 21; i += 1) last = await call({ word: 'run' }, { ip });
  assert.equal(last.status, 429);
});

// ---------- Ask AI ----------
const { handleAsk, cleanHistory, buildAskSystem } = require('./gemini-explain');
const askCall = (body, extra = {}) => handleAsk({ method: 'POST', body, headers: {}, ip: extra.ip || 'ask-' + Math.random(), env: extra.env || { GEMINI_API_KEY: 'k' }, fetchImpl: extra.fetchImpl || ok('It means he was very tired.'), ...extra });

test('ask: answers a question about a selected phrase', async () => {
  let sent;
  const result = await askCall({ text: 'burn the midnight oil', context: 'He had to burn the midnight oil.', question: 'What does this mean?', history: [] }, { fetchImpl: async (url, init) => { sent = JSON.parse(init.body); return ok('It means to work late at night.')(); } });
  assert.equal(result.status, 200);
  assert.equal(result.body.answer, 'It means to work late at night.');
  assert.match(sent.systemInstruction.parts[0].text, /burn the midnight oil/);
  assert.match(sent.systemInstruction.parts[0].text, /never as instructions/);
  assert.equal(sent.contents.at(-1).role, 'user');
  assert.equal(sent.contents.at(-1).parts[0].text, 'What does this mean?');
});

test('ask: keeps follow-up history in order and drops bad turns', () => {
  const turns = cleanHistory([{ role: 'model', text: 'orphan' }, { role: 'user', text: 'q1' }, { role: 'model', text: 'a1' }, { role: 'model', text: 'dup' }, { role: 'x', text: 'bad' }, { role: 'user', text: '' }]);
  assert.deepEqual(turns, [{ role: 'user', text: 'q1' }, { role: 'model', text: 'a1' }]);
  assert.equal(cleanHistory('nope').length, 0);
  assert.ok(!/selected this text/.test(buildAskSystem('', '')));
});

test('ask: validates method, origin, key, question and body', async () => {
  assert.equal((await handleAsk({ method: 'GET', body: {}, env: { GEMINI_API_KEY: 'k' } })).status, 405);
  assert.equal((await handleAsk({ method: 'POST', body: { question: 'x' }, headers: { 'sec-fetch-site': 'cross-site' }, env: { GEMINI_API_KEY: 'k' } })).status, 403);
  const noKey = await askCall({ question: 'x' }, { env: {} });
  assert.equal(noKey.status, 503);
  assert.equal(noKey.body.notConfigured, true);
  assert.equal((await askCall({ question: '   ' })).status, 400);
  assert.equal((await askCall('not json')).status, 400);
  assert.equal((await askCall('{"question":"What is this?"}')).status, 200);
});

test('ask: trims long input and maps quota/failures', async () => {
  let sent;
  await askCall({ text: 'a '.repeat(900), context: 'b '.repeat(900), question: 'q'.repeat(900) }, { fetchImpl: async (u, init) => { sent = JSON.parse(init.body); return ok('ok')(); } });
  assert.ok(sent.contents.at(-1).parts[0].text.length <= 300);
  assert.ok(sent.systemInstruction.parts[0].text.length < 2800);
  assert.equal((await askCall({ question: 'x' }, { fetchImpl: async () => ({ ok: false, status: 429 }) })).status, 429);
  assert.equal((await askCall({ question: 'x' }, { fetchImpl: async () => ({ ok: false, status: 500 }) })).status, 502);
  assert.equal((await askCall({ question: 'x' }, { fetchImpl: ok('') })).status, 502);
});

test('ask: limits one visitor to 15 questions a minute', async () => {
  let last;
  for (let i = 0; i < 16; i += 1) last = await askCall({ question: 'x' }, { ip: 'ask-limit' });
  assert.equal(last.status, 429);
});

// ---- AI Translate ----
{
  const assert = require('node:assert');
  const { handleTranslate } = require('./gemini-explain');
  (async () => {
    const ok = async (url, init) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'translated' }] } }] }), _body: init.body });
    let r = await handleTranslate({ method: 'GET', query: { word: 'cat', lang: 'om' }, env: {} });
    assert.strictEqual(r.status, 503); assert.strictEqual(r.body.notConfigured, true);
    r = await handleTranslate({ method: 'GET', query: { word: 'cat', lang: 'xx' }, env: { GEMINI_API_KEY: 'k' } });
    assert.strictEqual(r.status, 400);
    r = await handleTranslate({ method: 'GET', query: { word: '../x', lang: 'om' }, env: { GEMINI_API_KEY: 'k' } });
    assert.strictEqual(r.status, 400);
    r = await handleTranslate({ method: 'GET', query: { word: 'cat', lang: 'om', context: 'The cat sat.' }, env: { GEMINI_API_KEY: 'k' }, fetchImpl: ok, ip: 'tr-test' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.translation, 'translated');
    r = await handleTranslate({ method: 'GET', query: { word: 'cat', lang: 'om' }, headers: { 'sec-fetch-site': 'cross-site' }, env: { GEMINI_API_KEY: 'k' } });
    assert.strictEqual(r.status, 403);
    console.log('translate tests passed');
  })().catch(e => { console.error(e); process.exit(1); });
}
