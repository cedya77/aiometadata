const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const filename = path.join(__dirname, '../addon/lib/getMeta.js');
const source = readFileSync(filename, 'utf8');

// Load the public entry point with provider fixtures, without starting databases,
// contacting external services, or exposing the private response builders.
function fixture(imdbId) {
  const errors = [];
  const logger = {
    debug() {}, info() {},
    warn: (...args) => errors.push(args),
    error: (...args) => errors.push(args),
  };
  const title = {
    id: 123, name: 'TVDB fixture', overview: 'Available TVDB metadata',
    year: '2020', firstAired: '2020-01-01', first_release: { date: '2020-01-01' },
    originalCountry: 'jpn', remoteIds: [], characters: [], artworks: [], seasons: [],
  };
  const artwork = () => 'https://example.invalid/art.jpg';
  const utils = {
    resolveArtProvider: () => 'tvdb',
    getAnimePoster: artwork, getAnimeBg: artwork, getAnimeLogo: artwork,
    getMoviePoster: artwork, getMovieBackground: artwork, getMovieLogo: artwork,
    getSeriesPoster: artwork, getSeriesBackground: artwork, getSeriesLogo: artwork,
    buildPosterProxyUrl: artwork, isPosterRatingEnabled: () => false,
    parseTvdbTrailers: () => ({ trailers: [] }), pickTrailersByLanguage: () => [],
    buildLinks: () => [], parseCast: () => [], parseSlug: () => 'tvdb-fixture',
    parseRunTime: () => '24 min', buildReleaseInfo: () => '2020',
    addMetaProviderAttribution: overview => overview,
  };
  const modules = {
    dotenv: { config() {} },
    '../utils/parseProps': utils,
    './tvdb': {
      getMovieExtended: async () => title,
      getSeriesExtended: async () => title,
      getSeriesEpisodes: async () => ({ episodes: [
        { id: 456, name: 'Episode one', seasonNumber: 1, number: 1, aired: '2020-01-01' },
      ] }),
    },
    './id-resolver': { resolveAllIds: async () => ({ tvdbId: 123, imdbId }) },
    './id-mapper': {
      getMappingByTmdbId: () => null, getMappingByTvdbId: () => null,
      mappingIsType: () => false,
    },
    './id-mappings.js': { getByTvdbId: () => null },
    './getImdbRating': { getImdbRating: async () => 'N/A' },
    './language-map': { to3LetterCodeResolved: async () => ({ code3: 'eng', resolved: true }) },
    '../utils/tvdbLanguage': {
      tvdbLanguageChain: () => ['eng'], pickTranslation: () => null,
      pickArtwork: () => null, classifyTvdbLocalization: () => ({}),
    },
    './metaColdStore': { deriveStabilityStamp: () => ({}) },
    './metaDetails': { tvdbMovieDetails: () => ({}), tvdbSeriesDetails: () => ({}) },
    '../utils/episodeOrder': { withEpisodeOrder: config => config },
    '../utils/contentRating': { buildCertificationMap: () => ({}) },
    consola: { withTag: () => logger },
  };
  // These dependencies are imported by the module but unused in these TVDB paths.
  for (const name of ['./getTmdb', './imdb', './tvmaze', './mal', './anime-list-mapper',
    '../utils/fanart', '../utils/isAnime', '../utils/tmdbImageSize', 'express',
    './getCache', './kitsu', 'name-to-imdb', 'fs']) {
    modules[name] = {};
  }
  const loaded = { exports: {} };
  vm.runInNewContext(source, {
    module: loaded,
    process: { env: { HOST_NAME: 'https://example.invalid' } },
    require(name) {
      assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
      return modules[name];
    },
  }, { filename });
  return { getMeta: loaded.exports.getMeta, errors };
}

for (const type of ['movie', 'series']) {
  const nativeId = type === 'movie' ? 'kitsu:42' : 'mal:63381';
  const cases = [
    { name: 'missing IMDb falls back to the anime ID', imdbId: undefined, prefer: true, expected: nativeId },
    { name: 'null IMDb falls back to the anime ID', imdbId: null, prefer: true, expected: nativeId },
    { name: 'empty IMDb falls back to the anime ID', imdbId: '', prefer: true, expected: nativeId },
    { name: 'available IMDb remains preferred', imdbId: 'tt1234567', prefer: true, expected: 'tt1234567' },
    { name: 'disabled IMDb preference retains the anime ID', imdbId: 'tt1234567', prefer: false, expected: nativeId },
    { name: 'disabled preference works without IMDb', imdbId: undefined, prefer: false, expected: nativeId },
    { name: 'absent MAL settings retain the anime ID', imdbId: 'tt1234567', expected: nativeId },
    { name: 'non-anime still prefers IMDb', requestId: 'tvdb:123', imdbId: 'tt1234567', prefer: true, expected: 'tt1234567' },
    { name: 'non-anime still falls back to its requested ID', requestId: 'tvdb:123', prefer: true, expected: 'tvdb:123' },
  ];
  for (const scenario of cases) {
    test(`TVDB ${type}: ${scenario.name}`, async () => {
      const { getMeta, errors } = fixture(scenario.imdbId);
      const config = {
        providers: { anime: 'tvdb', movie: 'tvdb', series: 'tvdb', anime_id_provider: 'imdb' },
        tvdbSeasonType: 'default',
      };
      if (scenario.prefer !== undefined) config.mal = { useImdbIdForCatalogAndSearch: scenario.prefer };
      const { meta } = await getMeta(type, 'en-US', scenario.requestId || nativeId, config, 'test-profile');
      assert.deepEqual(errors, [], 'The TVDB path must not fail over to another provider');
      assert.ok(meta, 'Metadata must be returned');
      assert.equal(meta._metaProvider, 'tvdb');
      assert.equal(meta.type, type);
      assert.equal(meta.name, 'TVDB fixture');
      assert.equal(typeof meta.id, 'string', 'Metadata must have a valid ID');
      assert.equal(meta.id, scenario.expected);
      if (type === 'series') {
        assert.equal(meta.videos.length, 1);
        assert.ok(meta.videos[0].id);
        assert.equal(meta.videos[0].title, 'Episode one');
      }
    });
  }
}
