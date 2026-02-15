const crypto = require('crypto');
const {
  collectFallbackGenreOptions,
  inferChildGenreSemantic,
} = require('./mergedGenreCatalogProfiles');

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(v => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function normalizeMergedGenreOption(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeMergedGenreValue(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.toLowerCase() === 'none') return undefined;
  return normalized;
}

function getChildKey(catalog) {
  return `${catalog.id}-${catalog.type}`;
}

function addOption(optionsMap, option, child, semantic) {
  const label = String(option || '').trim();
  if (!label || label.toLowerCase() === 'none') return;
  const normalized = normalizeMergedGenreOption(label);
  if (!normalized || normalized === 'none') return;

  if (!optionsMap.has(normalized)) {
    optionsMap.set(normalized, {
      option: label,
      routes: [],
    });
  }

  optionsMap.get(normalized).routes.push({
    childKey: getChildKey(child),
    childId: child.id,
    childType: child.type,
    semantic,
    childGenreArg: label,
  });
}

function collectDeclaredGenreOptions(catalog) {
  const options = [];

  if (Array.isArray(catalog?.genres)) {
    catalog.genres.forEach(genre => {
      if (typeof genre === 'string' && genre.trim() && genre.trim().toLowerCase() !== 'none') {
        options.push(genre.trim());
      }
    });
  }

  if (Array.isArray(catalog?.manifestData?.extra)) {
    const genreExtra = catalog.manifestData.extra.find(e => e?.name === 'genre');
    if (Array.isArray(genreExtra?.options)) {
      genreExtra.options.forEach(option => {
        if (typeof option === 'string' && option.trim() && option.trim().toLowerCase() !== 'none') {
          options.push(option.trim());
        }
      });
    }
  }

  return options;
}

function uniqueOptions(options) {
  const byNormalized = new Map();
  options.forEach(option => {
    const label = String(option || '').trim();
    const normalized = normalizeMergedGenreOption(label);
    if (!normalized || normalized === 'none') return;
    if (!byNormalized.has(normalized)) {
      byNormalized.set(normalized, label);
    }
  });
  return Array.from(byNormalized.values());
}

function getChildGenreProfile(catalog, context = {}) {
  const semantic = inferChildGenreSemantic(catalog);
  const declared = semantic === 'none' ? [] : collectDeclaredGenreOptions(catalog);
  const fallback = collectFallbackGenreOptions(catalog, context);
  const options = uniqueOptions([...declared, ...fallback]);

  return {
    childKey: getChildKey(catalog),
    semantic,
    options,
    supportsWildcardContent: false,
  };
}

function buildMergedGenreRouting(parentCatalog, childCatalogs, context = {}) {
  const optionsMap = new Map();
  const profilesByChildKey = {};

  (childCatalogs || []).forEach(child => {
    if (!child) return;
    const profile = getChildGenreProfile(child, context);
    profilesByChildKey[profile.childKey] = profile;

    profile.options.forEach(option => {
      addOption(optionsMap, option, child, profile.semantic);
    });
  });

  const options = Array.from(optionsMap.values())
    .map(entry => entry.option)
    .sort((a, b) => a.localeCompare(b));

  const routesByOption = {};
  options.forEach(option => {
    const normalized = normalizeMergedGenreOption(option);
    const entry = optionsMap.get(normalized);
    const dedupe = new Set();
    routesByOption[normalized] = (entry?.routes || []).filter(route => {
      const key = `${route.childKey}:${normalizeMergedGenreOption(route.childGenreArg)}`;
      if (dedupe.has(key)) return false;
      dedupe.add(key);
      return true;
    });
  });

  const hashPayload = {
    parent: {
      id: parentCatalog?.id || null,
      type: parentCatalog?.type || null,
      showInHome: parentCatalog?.showInHome !== false,
    },
    options,
    routes: routesByOption,
    profiles: profilesByChildKey,
  };

  const hash = crypto.createHash('sha1').update(stableStringify(hashPayload)).digest('hex');

  return {
    options,
    routesByOption,
    profilesByChildKey,
    hash,
  };
}

function resolveMergedGenreSelection(routing, requestedGenre) {
  const selected = normalizeMergedGenreValue(requestedGenre);
  if (!selected) {
    return {
      requestedGenre: undefined,
      normalizedRequestedGenre: '',
      hasGenreFilter: false,
      childGenreByKey: new Map(),
      hasExplicitRoute: false,
    };
  }

  const normalized = normalizeMergedGenreOption(selected);
  const explicitRoutes = routing?.routesByOption?.[normalized] || [];
  const childGenreByKey = new Map();

  if (explicitRoutes.length > 0) {
    const hasNonContentRoute = explicitRoutes.some(route => route.semantic !== 'content');
    const routesToApply = hasNonContentRoute
      ? explicitRoutes.filter(route => route.semantic !== 'content')
      : explicitRoutes;

    routesToApply.forEach(route => {
      childGenreByKey.set(route.childKey, route.childGenreArg);
    });

    // If this option is clearly non-content (e.g. Day/Week), never spill into content children.
    if (hasNonContentRoute) {
      return {
        requestedGenre: selected,
        normalizedRequestedGenre: normalized,
        hasGenreFilter: true,
        childGenreByKey,
        hasExplicitRoute: true,
      };
    }

    return {
      requestedGenre: selected,
      normalizedRequestedGenre: normalized,
      hasGenreFilter: true,
      childGenreByKey,
      hasExplicitRoute: true,
    };
  }

  return {
    requestedGenre: selected,
    normalizedRequestedGenre: normalized,
    hasGenreFilter: true,
    childGenreByKey,
    hasExplicitRoute: false,
  };
}

module.exports = {
  buildMergedGenreRouting,
  getChildGenreProfile,
  normalizeMergedGenreOption,
  normalizeMergedGenreValue,
  resolveMergedGenreSelection,
};
