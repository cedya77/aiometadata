// Run with: node --test scripts/discoverCatalogSignature.test.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// Isolate the cache-key helper from getCache's Redis/database initialization.
const source = readFileSync(path.join(__dirname, '../addon/lib/discoverCatalogSignature.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sandbox = { exports: {}, module: { exports: {} }, require: id => {
  if (id === './getCache') {
    return { stableStringify: value => JSON.stringify(value, Object.keys(value).sort()) };
  }
  return require(id);
} };
vm.runInNewContext(compiled, sandbox);
const { applyDiscoverSignature, computeDiscoverSignature, isDiscoverCatalogId } = sandbox.module.exports;

function cacheKey(id, type, args, config) {
  const normalized = { ...args };
  if (isDiscoverCatalogId(id)) applyDiscoverSignature(normalized, config);
  return `${id}:${type}:${JSON.stringify(normalized, Object.keys(normalized).sort())}`;
}

const config = { metadata: { discover: { params: { with_keywords: '3133', with_genres: '27' } } } };

for (const type of ['movie', 'series']) {
  const id = `tmdb.discover.${type}.theme.vampire`;
  for (const pageArgs of [{}, { page: 2 }]) {
    test(`${type} page ${pageArgs.page || 1}: warmed None and omitted genre share a cache entry`, () => {
      const warmedKey = cacheKey(id, type, { ...pageArgs, genre: 'None' }, config);
      const cache = new Map([[warmedKey, { metas: [{ id: 'tt0000001' }] }]]);
      const requestKey = cacheKey(id, type, pageArgs, config);
      assert.equal(requestKey, warmedKey);
      assert.equal(cache.get(requestKey).metas.length, 1);
    });
  }
  test(`${type}: sentinel casing matches provider behavior`, () => {
    const expected = cacheKey(id, type, {}, config);
    for (const genre of ['None', 'none', 'NONE', 'nOnE', '', null, undefined]) {
      assert.equal(cacheKey(id, type, { genre }, config), expected);
    }
  });
  test(`${type}: real genres, pages and stored filters remain distinct`, () => {
    const base = cacheKey(id, type, {}, config);
    assert.notEqual(cacheKey(id, type, { genre: 'Horror' }, config), base);
    assert.notEqual(cacheKey(id, type, { page: 2 }, config), base);
    const changed = { metadata: { discover: { params: { with_keywords: '3133', with_genres: '28' } } } };
    assert.notEqual(cacheKey(id, type, {}, changed), base);
    assert.equal(config.metadata.discover.params.with_genres, '27');
  });
}

test('normalization also works with legacy or missing discover metadata', () => {
  const legacy = { metadata: { discoverParams: config.metadata.discover.params } };
  assert.equal(computeDiscoverSignature(legacy), computeDiscoverSignature(config));
  for (const catalog of [legacy, {}, undefined]) {
    const args = { genre: 'None', page: 3 };
    applyDiscoverSignature(args, catalog);
    assert.equal(Object.hasOwn(args, 'genre'), false);
    assert.equal(args.page, 3);
  }
});

test('all Discover providers share no-filter semantics; other catalogs retain their extras', () => {
  for (const provider of ['tmdb', 'tvdb', 'simkl', 'anilist', 'mal']) {
    const id = `${provider}.discover.example`;
    assert.equal(cacheKey(id, 'series', { genre: 'None' }, config), cacheKey(id, 'series', {}, config));
  }
  for (const id of ['mal.genres', 'mal.schedule', 'tmdb.trending', 'custom.example']) {
    assert.notEqual(cacheKey(id, 'series', { genre: 'None' }, config), cacheKey(id, 'series', {}, config));
  }
});
