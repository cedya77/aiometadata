// Run with: node --test scripts/test-tmdb-translations.js
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the actual modules without starting clients or loading database/cache
// services. Translation selection uses the real getTmdb.getTranslations export.
function loadModule(relativePath, dependencies = {}) {
  const filename = path.join(__dirname, '..', relativePath);
  const source = readFileSync(filename, 'utf8');
  const code = filename.endsWith('.ts')
    ? ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText
    : source;
  const module = { exports: {} };
  const logger = { debug() {}, withTag() { return this; } };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    process: { env: { HOST_NAME: 'localhost' } },
    require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      if (id === 'consola') return logger;
      if (id === 'undici') return { Agent: class {} };
      if (id === 'lru-cache') return { LRUCache: class {} };
      // Unused dependencies are inert; attempting to call them fails the test.
      return {};
    },
  }, { filename });
  return module.exports;
}

const tmdb = loadModule('addon/lib/getTmdb.ts');
const localization = loadModule('addon/utils/tmdbLocalization.ts');
const { processOverviewTranslations, processTitleTranslations, parseMedia, classifyTmdbLocalization } = loadModule('addon/utils/parseProps.js', {
  '../lib/getTmdb': tmdb,
  './tmdbLocalization': localization,
});

function translations(entries) {
  return {
    translations: Object.entries(entries).map(([locale, data]) => {
      const [iso_639_1, iso_3166_1] = locale.split('-');
      return { iso_639_1, iso_3166_1, data };
    }),
  };
}

const emptyFields = [undefined, null, '', ' \t\n '];
const portugueseLocales = ['pt-BR', 'pt-PT'];

for (const language of portugueseLocales) {
  const alternative = language === 'pt-BR' ? 'pt-PT' : 'pt-BR';

  test(`${language}: prefers the requested overview over the other variant and English`, () => {
    const data = translations({
      'en-US': { overview: 'English overview' },
      [alternative]: { overview: 'Other Portuguese overview' },
      [language]: { overview: 'Requested overview' },
    });
    assert.equal(processOverviewTranslations(data, language, 'Supplied overview'), 'Requested overview');
  });

  test(`${language}: falls back to the other overview when the requested locale is absent`, () => {
    const data = translations({
      'en-US': { overview: 'English overview' },
      [alternative]: { overview: 'Other Portuguese overview' },
    });
    assert.equal(processOverviewTranslations(data, language, 'Supplied overview'), 'Other Portuguese overview');
  });

  test(`${language}: missing, null, empty and whitespace overviews fall back independently of the name`, () => {
    for (const overview of emptyFields) {
      const data = translations({
        [language]: { name: 'Requested name', overview },
        [alternative]: { name: 'Other name', overview: 'Other Portuguese overview' },
        'en-US': { name: 'English name', overview: 'English overview' },
      });
      assert.equal(processOverviewTranslations(data, language, 'Supplied overview'), 'Other Portuguese overview');
      assert.equal(processTitleTranslations(data, language, 'Supplied name', 'series'), 'Requested name');
    }
  });

  test(`${language}: blank Portuguese overviews fall back to English, then the supplied overview`, () => {
    for (const overview of emptyFields) {
      const entries = { [language]: { overview }, [alternative]: { overview } };
      assert.equal(processOverviewTranslations(translations({ ...entries, 'en-US': { overview: 'English overview' } }), language, 'Supplied overview'), 'English overview');
      assert.equal(processOverviewTranslations(translations({ ...entries, 'en-US': { overview } }), language, 'Supplied overview'), 'Supplied overview');
    }
  });

  for (const [type, field] of [['movie', 'title'], ['series', 'name']]) {
    test(`${language} ${type}: keeps the exact title before the other variant and original title`, () => {
      const data = translations({
        [alternative]: { [field]: 'Other Portuguese title' },
        'en-US': { [field]: 'English title' },
        [language]: { [field]: 'Requested title' },
      });
      assert.equal(processTitleTranslations(data, language, 'Supplied title', type, 'pt', 'Original title'), 'Requested title');
    });

    test(`${language} ${type}: absent locale falls back to the other Portuguese title`, () => {
      const data = translations({
        'en-US': { [field]: 'English title' },
        [alternative]: { [field]: 'Other Portuguese title' },
      });
      assert.equal(processTitleTranslations(data, language, 'Supplied title', type, 'pt', 'Original title'), 'Other Portuguese title');
    });

    test(`${language} ${type}: blank titles fall back independently of a populated overview`, () => {
      for (const title of emptyFields) {
        const data = translations({
          [language]: { [field]: title, overview: 'Requested overview' },
          [alternative]: { [field]: 'Other Portuguese title', overview: 'Other overview' },
          'en-US': { [field]: 'English title' },
        });
        assert.equal(processTitleTranslations(data, language, 'Supplied title', type, 'pt', 'Original title'), 'Other Portuguese title');
        assert.equal(processOverviewTranslations(data, language, 'Supplied overview'), 'Requested overview');
      }
    });

    test(`${language} ${type}: preserves original-language, English and supplied-title fallbacks`, () => {
      for (const title of emptyFields) {
        const entries = { [language]: { [field]: title }, [alternative]: { [field]: title } };
        const data = translations({ ...entries, 'en-US': { [field]: 'English title' } });
        assert.equal(processTitleTranslations(data, language, 'Supplied title', type, 'pt', 'Original title'), 'Original title');
        assert.equal(processTitleTranslations(data, language, 'Supplied title', type, 'ja', 'Original title'), 'English title');
        assert.equal(processTitleTranslations(data, language, 'Supplied title', type, 'pt', title), 'English title');
        assert.equal(processTitleTranslations(translations({ ...entries, 'en-US': { [field]: title } }), language, 'Supplied title', type, 'ja', 'Original title'), 'Supplied title');
      }
    });
  }
}

test('parseMedia: One Pace retains its Brazilian name while using the Portuguese overview (#781)', () => {
  // Synthetic text with the TMDB ID and response shape from the issue: pt-BR
  // has a name but an empty overview, while the pt-PT overview is populated.
  const item = {
    id: 336584,
    name: 'One Pace',
    original_name: 'One Pace',
    original_language: 'en',
    overview: '',
    translations: translations({
      'pt-BR': { name: 'One Pace', overview: '' },
      'pt-PT': { name: 'One Pace PT', overview: 'Uma aventura em busca do One Piece.' },
      'en-US': { name: 'One Pace EN', overview: 'An adventure in search of the One Piece.' },
    }),
  };
  const stamp = classifyTmdbLocalization(item, 'pt-BR', 'series');
  assert.equal(stamp.titleLang, 'exact');
  assert.equal(stamp.overviewLang, 'fallback');
  const meta = parseMedia(item, 'series', [], { language: 'pt-BR' });
  assert.equal(meta.id, 'tmdb:336584');
  assert.equal(meta.name, 'One Pace');
  assert.equal(meta.description, 'Uma aventura em busca do One Piece.');
});

test('parseMedia: movies use title and series use name when both Portuguese fields are provided', () => {
  for (const [type, field] of [['movie', 'title'], ['series', 'name']]) {
    const item = {
      id: 1,
      [field]: 'Supplied title',
      overview: 'Supplied overview',
      translations: translations({
        'pt-BR': { title: '', name: '', overview: '' },
        'pt-PT': { title: 'Movie title', name: 'Series name', overview: 'Portuguese overview' },
        'en-US': { title: 'English movie', name: 'English series', overview: 'English overview' },
      }),
    };
    const meta = parseMedia(item, type, [], { language: 'pt-BR' });
    assert.equal(meta.name, type === 'movie' ? 'Movie title' : 'Series name');
    assert.equal(meta.description, 'Portuguese overview');
  }
});

test('unrelated locales retain exact, original-language and English fallbacks', () => {
  const entries = {
    'pt-BR': { name: 'Brazilian name', overview: 'Brazilian overview' },
    'pt-PT': { name: 'Portuguese name', overview: 'Portuguese overview' },
    'en-US': { name: 'English name', overview: 'English overview' },
    'fr-FR': { name: 'French name', overview: 'French overview' },
  };
  const data = translations(entries);
  assert.equal(processOverviewTranslations(data, 'fr-FR', 'Supplied overview'), 'French overview');
  assert.equal(processTitleTranslations(data, 'fr-FR', 'Supplied name', 'series'), 'French name');
  assert.equal(processOverviewTranslations(data, 'es-ES', 'Supplied overview'), 'English overview');
  assert.equal(processTitleTranslations(data, 'es-ES', 'Supplied name', 'series'), 'English name');
  assert.equal(processTitleTranslations(data, 'es-ES', 'Supplied name', 'series', 'es', 'Original name'), 'Original name');
  assert.equal(processOverviewTranslations(data, 'en-US', 'Supplied overview'), 'English overview');
  assert.equal(processTitleTranslations(data, 'en-US', 'Supplied name', 'series'), 'English name');
});

test('absent or empty translation collections retain the supplied fields', () => {
  for (const data of [undefined, null, {}, { translations: [] }]) {
    for (const language of [...portugueseLocales, 'fr-FR']) {
      assert.equal(processOverviewTranslations(data, language, 'Supplied overview'), 'Supplied overview');
      assert.equal(processTitleTranslations(data, language, 'Supplied title', 'movie'), 'Supplied title');
    }
  }
});
