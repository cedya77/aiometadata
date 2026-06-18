const test = require('node:test');
const assert = require('node:assert/strict');
const { filterByExcludedOriginalLanguages } = require('./original-language-filters');

test('filters TMDB items with excluded original languages', () => {
  const items = [
    { id: 1, original_language: 'en' },
    { id: 2, original_language: 'hi' },
    { id: 3, original_language: 'id' },
    { id: 4, original_language: 'fr' },
    { id: 5 },
  ];

  const filtered = filterByExcludedOriginalLanguages(items, ['hi', 'id']);

  assert.deepEqual(filtered.map(item => item.id), [1, 4, 5]);
});

test('normalizes excluded original language codes before filtering', () => {
  const items = [
    { id: 1, original_language: 'JA' },
    { id: 2, original_language: 'ko' },
    { id: 3, original_language: 'es' },
  ];

  const filtered = filterByExcludedOriginalLanguages(items, [' ja ', 'KO', '', '  ']);

  assert.deepEqual(filtered.map(item => item.id), [3]);
});
