const test = require('node:test');
const assert = require('node:assert/strict');

process.env.HOST_NAME = process.env.HOST_NAME || 'http://localhost';
process.env.NO_CACHE = 'true';

const {
  buildMDBListItemsBySlugCacheKey,
  buildMDBListItemsCacheKey,
  buildSyntheticMDBListUnifiedCatalogId,
  normalizeMDBListItemsPayload,
  parseMDBListCatalogUrl,
  resolveMDBListUnifiedCatalogIdentity,
} = require('../../dist/utils/mdbList.js');

test('builds a synthetic unified catalog id from username and slug', () => {
  assert.equal(
    buildSyntheticMDBListUnifiedCatalogId('nobnobz', 'service-apple-tv'),
    'mdblist.nobnobz.service-apple-tv.unified'
  );
});

test('parses a public MDBList list URL and resolves unified slug identity from metadata', () => {
  assert.deepEqual(
    parseMDBListCatalogUrl('https://mdblist.com/lists/nobnobz/service-apple-tv'),
    { username: 'nobnobz', listSlug: 'service-apple-tv' }
  );

  assert.deepEqual(
    resolveMDBListUnifiedCatalogIdentity(
      {
        type: 'all',
        metadata: {
          username: 'nobnobz',
          listSlug: 'service-apple-tv',
        },
      },
      'mdblist.nobnobz.service-apple-tv.unified'
    ),
    {
      username: 'nobnobz',
      listSlug: 'service-apple-tv',
      syntheticId: 'mdblist.nobnobz.service-apple-tv.unified',
    }
  );
});

test('falls back to metadata.url for legacy mixed MDBList configs', () => {
  assert.deepEqual(
    resolveMDBListUnifiedCatalogIdentity(
      {
        type: 'all',
        metadata: {
          url: 'https://mdblist.com/lists/nobnobz/service-apple-tv',
        },
      },
      'mdblist.12345'
    ),
    {
      username: 'nobnobz',
      listSlug: 'service-apple-tv',
      syntheticId: 'mdblist.nobnobz.service-apple-tv.unified',
    }
  );
});

test('does not treat external or split catalogs as unified slug catalogs', () => {
  assert.equal(
    resolveMDBListUnifiedCatalogIdentity(
      {
        type: 'all',
        sourceUrl: 'https://api.mdblist.com/external/lists/55/items',
        metadata: {
          username: 'nobnobz',
          listSlug: 'service-apple-tv',
        },
      },
      'mdblist.nobnobz.service-apple-tv.unified'
    ),
    null
  );
});

test('preserves mixed unified array order and derives a stable local ordinal', () => {
  const items = normalizeMDBListItemsPayload([
    { id: 101, mediatype: 'show' },
    { id: 202, mediatype: 'movie' },
    { id: 303, mediatype: 'show' },
  ], 'all');

  assert.deepEqual(
    items.map(item => [item.id, item.mediatype, item._aiomOrder]),
    [
      [101, 'show', 0],
      [202, 'movie', 1],
      [303, 'show', 2],
    ]
  );
});

test('keeps legacy movie-only and series-only MDBList payload handling intact', () => {
  const payload = {
    movies: [{ id: 1, mediatype: 'movie' }],
    shows: [{ id: 2, mediatype: 'show' }],
  };

  assert.deepEqual(
    normalizeMDBListItemsPayload(payload, 'movie').map(item => item.id),
    [1]
  );
  assert.deepEqual(
    normalizeMDBListItemsPayload(payload, 'series').map(item => item.id),
    [2]
  );
  assert.deepEqual(
    normalizeMDBListItemsPayload(payload, 'all').map(item => item.id),
    [1, 2]
  );
});

test('uses a dedicated cache identity for unified slug catalogs', () => {
  const apiKeyHash = 'hash123';
  const numericCacheKey = buildMDBListItemsCacheKey(apiKeyHash, '12345', 1, 'rank', 'desc', '', true, 'all', 20);
  const splitMovieCacheKey = buildMDBListItemsCacheKey(apiKeyHash, '12345', 1, 'rank', 'desc', '', false, 'movie', 20);
  const unifiedSlugCacheKey = buildMDBListItemsBySlugCacheKey(apiKeyHash, 'nobnobz', 'service-apple-tv', 1, 'rank', 'desc', '', 20);

  assert.notEqual(unifiedSlugCacheKey, numericCacheKey);
  assert.notEqual(unifiedSlugCacheKey, splitMovieCacheKey);
  assert.match(unifiedSlugCacheKey, /items-by-slug/);
});
