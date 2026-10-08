const test = require('node:test');
const assert = require('node:assert/strict');
const { lookupWordnet } = require('./dictionary');

test('WordNet resolves irregular forms', async () => {
  const result = await lookupWordnet('children');
  assert.ok(result);
  assert.ok(result.meanings.length > 0);
  assert.equal(result.word, 'children');
});

test('WordNet resolves common inflected verbs', async () => {
  const result = await lookupWordnet('running');
  assert.ok(result);
  assert.ok(result.meanings.length > 0);
});

test('WordNet exposes more than one useful sense when available', async () => {
  const result = await lookupWordnet('read');
  assert.ok(result);
  assert.ok(result.meanings.length >= 1);
  assert.ok(result.meanings.every(item => item.definition));
});
