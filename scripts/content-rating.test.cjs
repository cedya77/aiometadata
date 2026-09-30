const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createRequire } = require('node:module');
const { runInThisContext } = require('node:vm');
const ts = require('typescript');

const compilerOptions = { module: 'CommonJS', moduleResolution: 'node', target: 'ES2022', ignoreDeprecations: '6.0' };
require('ts-node').register({ skipProject: true, transpileOnly: true, compilerOptions });
const ratings = require('../addon/utils/contentRating.ts');
const { passesAgeRating } = require('../addon/utils/ageRating.ts');
const profiles = require('../addon/lib/jellyfin/profiles.ts');
const nl = { language: 'en-US', contentRatingCountry: 'NL' };
const copy = value => JSON.parse(JSON.stringify(value));

function classify(config = nl, type = 'series', sources = { tmdb: { us: 'TV-MA', local: '16' } }) {
  return ratings.resolveContentRating(config, type, sources);
}

function metadata(extras = classify(), type = 'series') {
  return { id: 'tmdb:123', type, name: 'Fixture', app_extras: extras, links: [{ name: 'Drama', category: 'Genres', url: '/drama' }] };
}

// Execute the actual module with isolated dependencies, without loading the
// application's provider clients, Redis connection or configuration database.
function loadIsolated(path, stubs) {
  const filename = resolve(__dirname, '..', path);
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const requireDependency = name => Object.hasOwn(stubs, name) ? stubs[name] : localRequire(name);
  runInThisContext(`(function(require, module, exports) { ${code}\n})`, { filename })(requireDependency, module, module.exports);
  return module.exports;
}

test('an explicit rating country is independent of the metadata language', () => {
  assert.equal(ratings.getContentRatingCountry({ language: 'es-ES', contentRatingCountry: 'NL' }), 'NL');
  assert.equal(ratings.getContentRatingCountry({ language: 'de-DE', contentRatingCountry: 'auto' }), 'DE');
  assert.equal(ratings.getContentRatingCountry({ language: 'en' }), 'US');
  assert.equal(ratings.contentRatingCacheKey(nl), ratings.contentRatingCacheKey({ ...nl, language: 'es-ES' }));
  assert.notEqual(ratings.contentRatingCacheKey(nl), ratings.contentRatingCacheKey({ ...nl, contentRatingCountry: 'DE' }));
});

test('local TVDB ratings take precedence over US TMDB fallback, while filters retain the US value', () => {
  const result = classify(nl, 'series', { tmdb: { us: 'TV-MA' }, tvdb: { us: 'TV-14', local: '16' } });
  assert.equal(ratings.formatContentRating(result.contentRating), 'Kijkwijzer · 16+');
  assert.equal(result.contentRating.source, 'tvdb');
  assert.equal(result.certification, 'TV-MA');
  assert.equal(passesAgeRating(result.certification, 'series', 'PG-13'), false);
  assert.equal(passesAgeRating(result.certification, 'series', 'R'), true);
  const tmdbLocal = classify(nl, 'series', { tmdb: { us: 'TV-MA', local: '12' }, tvdb: { local: '16' } });
  assert.equal(tmdbLocal.contentRating.source, 'tmdb');
  assert.equal(ratings.formatContentRating(tmdbLocal.contentRating), 'Kijkwijzer · 12+');
  const tvdbFallback = classify(nl, 'series', { tmdb: {}, tvdb: { us: 'TV-14' } });
  assert.equal(tvdbFallback.contentRating.source, 'tvdb');
  assert.equal(ratings.formatContentRating(tvdbFallback.contentRating), 'TV-14 (US)');
});

test('only a foreign US fallback has the US suffix, for both movies and series', () => {
  for (const [type, code, label] of [['series', 'TV-14', 'TV-14'], ['movie', 'R', 'MPA · R']]) {
    for (const config of [{ language: 'en-US', contentRatingCountry: 'auto' }, { language: 'nl-NL', contentRatingCountry: 'US' }]) {
      assert.equal(ratings.formatContentRating(classify(config, type, { tmdb: { us: code } }).contentRating), label);
    }
    for (const country of ['NL', 'DE', 'FR', 'BE']) {
      const result = classify({ language: 'es-ES', contentRatingCountry: country }, type, { tmdb: { us: code, local: 'NR' } });
      assert.equal(ratings.formatContentRating(result.contentRating), `${label} (US)`);
      assert.equal(result.contentRating.country, 'US');
    }
  }
});

test('native local codes keep their country system without translating US classifications', () => {
  for (const [country, code, type, expected] of [
    ['NL', '9', 'series', 'Kijkwijzer · 9+'], ['NL', '14', 'movie', 'Kijkwijzer · 14+'],
    ['NL', 'AL', 'series', 'Kijkwijzer · AL'], ['DE', '16', 'movie', 'FSK · 16'],
    ['FR', '12', 'movie', 'CNC · 12'], ['FR', '12', 'series', 'Arcom · 12'],
    ['BE', '10', 'series', 'GoedGezien / BienVu · 10+'], ['BE', '9', 'series', 'Kijkwijzer · 9+'],
    ['BE', 'BienVu 12', 'movie', 'GoedGezien / BienVu · 12+'],
    ['CA', 'unrecognized', 'series', 'unrecognized (CA)'],
  ]) {
    const rating = classify({ contentRatingCountry: country }, type, { tmdb: { local: code } }).contentRating;
    assert.equal(ratings.formatContentRating(rating), expected);
    assert.equal(rating.code, code);
  }
  assert.equal(ratings.formatContentRating(classify(nl, 'movie', { tmdb: { us: 'NC-17' } }).contentRating), 'MPA · NC-17 · 18+ (US)');
});

test('missing classifications remain unrated and obey the existing filter switch', () => {
  const result = classify(nl, 'movie', { tmdb: { us: 'NR', local: 'UR' } });
  assert.equal(result.contentRating, null);
  assert.equal(ratings.formatContentRating(result.contentRating), null);
  assert.equal(passesAgeRating(result.certification, 'movie', 'PG', false), false);
  assert.equal(passesAgeRating(result.certification, 'movie', 'PG', true), true);
});

test('MAL and Kitsu preserve their native classifications and source data', () => {
  for (const [source, code, expected] of [['mal', 'PG-13 - Teens 13 or older', 'MAL · PG-13'], ['kitsu', 'R', 'Kitsu · R']]) {
    const rating = ratings.nativeContentRating(nl, code, source);
    assert.equal(rating.country, null);
    assert.equal(rating.code, code);
    assert.equal(ratings.formatContentRating(rating), expected);
  }
});

test('fresh and serialized metadata produce one rating link without changing the US filter value', () => {
  const config = { ...nl, displayAgeRating: true };
  const fresh = ratings.applyContentRatingDisplay(metadata(), config);
  const cached = ratings.applyContentRatingDisplay(copy(fresh), config);
  assert.deepEqual(cached, fresh);
  assert.equal(cached.ageRating, 'Kijkwijzer · 16+');
  assert.equal(cached.app_extras.certification, 'TV-MA');
  assert.equal(cached.links.filter(link => link.name === cached.ageRating).length, 1);
  ratings.applyContentRatingDisplay(cached, { ...config, displayAgeRating: false });
  assert.deepEqual(cached.links.map(link => link.name), ['Drama']);
  assert.equal(cached.ageRating, 'Kijkwijzer · 16+');
});

const items = loadIsolated('addon/lib/jellyfin/items.ts', {
  '../redisClient': { default: null, __esModule: true },
  './streams': { placeholderSources: () => [] },
  './viewer': { viewerAccountOwner: () => '' },
  './dto': { EMPTY_USER_DATA: {} },
});

test('Jellyfin movies, series, seasons and episodes show local ratings but filter on the original scale', () => {
  const series = { ...metadata(), videos: [{ id: 'tmdb:123:1:1', season: 1, episode: 1, title: 'Episode' }] };
  const base = items.metaToBaseItem(series, 'series', 'test-server', null);
  const dtos = [base, ...items.buildSeasons(series, 'series', base.Id, 'test-server'), ...items.buildEpisodes(series, 'series', base.Id, 'test-server', 1)];
  const movie = metadata(classify(nl, 'movie', { tmdb: { us: 'R', local: '16' } }), 'movie');
  dtos.push(items.metaToBaseItem(movie, 'movie', 'test-server', null));
  for (const dto of dtos) {
    assert.equal(dto.OfficialRating, 'Kijkwijzer · 16+');
    assert.equal(profiles.keepsUnderProfileCap({ ageRating: 'PG-13', allowUnratedContent: true })({ ...dto }), false);
    assert.equal(profiles.keepsUnderProfileCap({ ageRating: 'R' })(dto), true);
    const json = JSON.stringify(dto);
    assert.equal(JSON.parse(json).OfficialRating, 'Kijkwijzer · 16+');
    assert.equal(json.includes('filterCertification'), false);
    assert.equal(json.includes('TV-MA'), false);
  }
});

test('Jellyfin local-only ratings remain unrated for US filtering; legacy items still filter', () => {
  const item = items.metaToBaseItem(metadata(classify(nl, 'movie', { tmdb: { local: '16' } }), 'movie'), 'movie', 'test-server', null);
  assert.equal(item.OfficialRating, 'Kijkwijzer · 16+');
  assert.equal(profiles.keepsUnderProfileCap({ ageRating: 'PG', allowUnratedContent: false })(item), false);
  assert.equal(profiles.keepsUnderProfileCap({ ageRating: 'PG', allowUnratedContent: true })(item), true);
  assert.equal(profiles.keepsUnderProfileCap({ ageRating: 'PG' })({ Type: 'Movie', OfficialRating: 'R' }), false);
});

async function trendingFixture(extras, options = {}) {
  let calls = 0;
  const meta = metadata(copy(extras));
  const read = (data, country = 'US') => data[country] || null;
  const certifications = async () => {
    calls++;
    if (options.fail) throw new Error('Provider unavailable');
    return { US: 'TV-MA', NL: '16' };
  };
  const { getTrending } = loadIsolated('addon/lib/getTrending.ts', {
    dotenv: { config() {} },
    consola: { withTag: () => ({ debug() {} }) },
    './getTmdb.js': { trending: async () => ({ results: [{ id: 123 }] }), getTvCertifications: certifications },
    './getMeta.js': { getMeta: async () => ({ meta }) },
    './getCache.js': { cacheWrapMetaSmart: async (_uuid, _id, loader) => loader() },
    '../utils/ageRating.js': require('../addon/utils/ageRating.ts'),
    '../utils/contentRating.js': ratings,
    '../utils/parseProps.js': { getTmdbTvCertificationForCountry: read },
  });
  const result = await getTrending('series', 'en-US', 1, 'day', { ...nl, ageRating: options.cap || 'None', allowUnratedContent: options.allowUnrated, displayAgeRating: true }, 'fixture-user');
  return { result, calls, meta };
}

test('trending fills missing US ratings before filtering without overwriting an existing local classification', async () => {
  const extras = classify(nl, 'series', { tvdb: { local: '12' } });
  const { result, calls, meta } = await trendingFixture(extras, { cap: 'PG-13', allowUnrated: true });
  assert.equal(calls, 1);
  assert.equal(result.metas.length, 0);
  assert.equal(meta.app_extras.certification, 'TV-MA');
  assert.equal(meta.ageRating, 'Kijkwijzer · 12+');
  assert.equal(meta.app_extras.contentRating.source, 'tvdb');
});

test('trending can replace a TVDB US fallback with an actual TMDB local rating', async () => {
  const { result, calls } = await trendingFixture(classify(nl, 'series', { tvdb: { us: 'TV-MA' } }));
  assert.equal(calls, 1);
  assert.equal(result.metas[0].ageRating, 'Kijkwijzer · 16+');
  assert.equal(result.metas[0].app_extras.contentRating.source, 'tmdb');
});

test('trending does not repeat complete TMDB lookups or overwrite native anime ratings', async () => {
  const cases = [classify(), classify(nl, 'series', { tmdb: { us: 'TV-MA' } })];
  for (const source of ['mal', 'kitsu']) cases.push({ certification: 'PG-13', contentRating: ratings.nativeContentRating(nl, 'PG-13', source) });
  for (const extras of cases) {
    const { result, calls } = await trendingFixture(extras);
    assert.equal(calls, 0);
    assert.equal(result.metas.length, 1);
    assert.deepEqual(result.metas[0].app_extras.contentRating, extras.contentRating);
  }
});

test('trending provider failures preserve metadata and obey the unrated-content policy', async () => {
  for (const allowUnrated of [true, false]) {
    const { result, calls } = await trendingFixture({ certification: null, contentRating: null }, { fail: true, cap: 'PG-13', allowUnrated });
    assert.equal(calls, 1);
    assert.equal(result.metas.length, allowUnrated ? 1 : 0);
  }
});
