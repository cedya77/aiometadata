/**
 * Self-check for the parent config merge: npm run check:parent-config
 */
import assert from 'node:assert/strict';
import { mergeParentConfig, normalizeParentLink } from '../addon/lib/parentConfig';

const parent = {
  language: 'fr-FR',
  ageRating: 'PG-13',
  configVersion: 200,
  apiKeys: { tmdb: 'parent-tmdb', mdblist: 'parent-mdb', traktTokenId: 'parent-trakt' },
  catalogs: [
    { id: 'tmdb.top', type: 'movie', enabled: true, name: 'Parent Top' },
    { id: 'mdblist.1', type: 'movie', enabled: true },
  ],
  tags: [{ name: 'Kids', color: 'blue' }],
  traktWatchTracking: true,
  sessionId: 'parent-session',
};

const child = {
  language: 'en-US',
  ageRating: 'G',
  configVersion: 100,
  apiKeys: { tmdb: '', mdblist: 'child-mdb', traktTokenId: 'child-trakt' },
  catalogs: [
    { id: 'tmdb.top', type: 'movie', enabled: false, name: 'Child Top' },
    { id: 'trakt.list.9', type: 'series', enabled: true },
  ],
  tags: [{ name: 'kids', color: 'red' }, { name: 'Mine', color: 'green' }],
  traktWatchTracking: false,
  sessionId: 'child-session',
  parentConfig: { uuid: 'parent-uuid', password: 'secret' },
};

// Default: everything listed inherits, personal fields and the link stay out of it.
let merged = mergeParentConfig(parent, child);
assert.equal(merged.language, 'fr-FR');
assert.equal(merged.ageRating, 'PG-13');
assert.equal(merged.apiKeys.tmdb, 'parent-tmdb');
assert.equal(merged.apiKeys.traktTokenId, 'child-trakt');
assert.equal(merged.traktWatchTracking, false);
assert.equal(merged.sessionId, 'child-session');
assert.deepEqual(merged.catalogs, parent.catalogs);
assert.equal(merged.configVersion, 200);
assert.equal('parentConfig' in merged, false);
assert.equal(child.apiKeys.tmdb, '', 'the child is not changed');

// Section strategies, a field override winning over its section, and extend.
merged = mergeParentConfig(parent, {
  ...child,
  parentConfig: {
    ...child.parentConfig,
    mergeStrategies: {
      filters: 'override',
      apiKeys: 'inherit',
      catalogs: 'extend',
      fieldOverrides: { 'apiKeys.mdblist': 'override', language: 'override' },
    },
  },
});
assert.equal(merged.ageRating, 'G');
assert.equal(merged.language, 'en-US');
assert.equal(merged.apiKeys.tmdb, 'parent-tmdb');
assert.equal(merged.apiKeys.mdblist, 'child-mdb');
assert.deepEqual(merged.catalogs.map((c: any) => c.name ?? c.id), ['Parent Top', 'mdblist.1', 'trakt.list.9']);
assert.deepEqual(merged.tags.map((t: any) => t.name), ['Kids', 'Mine']);

// A parent without a value leaves none, rather than the child's.
merged = mergeParentConfig({ ...parent, ageRating: undefined }, child);
assert.equal('ageRating' in merged, false);

// Links are tidied: unknown sections, bad values and extend on scalars are dropped.
assert.equal(normalizeParentLink({ uuid: 'x' }), null);
assert.equal(normalizeParentLink('nope'), null);
assert.deepEqual(
  normalizeParentLink({
    uuid: ' x ',
    password: 'p',
    mergeStrategies: { filters: 'extend', bogus: 'inherit', search: 'override', fieldOverrides: { language: 'extend', tags: 'extend', nope: 'inherit' } },
  }),
  { uuid: 'x', password: 'p', mergeStrategies: { search: 'override', fieldOverrides: { tags: 'extend' } } },
);

console.log('parent config checks passed');
