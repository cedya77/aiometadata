const TMDB_TRENDING_INTERVAL_OPTIONS = ['Day', 'Week'];
const SIMKL_TRENDING_INTERVAL_OPTIONS = ['today', 'week', 'month'];
const TVMAZE_SCHEDULE_COUNTRY_OPTIONS = ['US', 'CA', 'GB', 'AU', 'DE', 'FR', 'ES', 'BR'];
const TMDB_AIRING_TODAY_COUNTRY_OPTIONS = ['AU', 'BR', 'CA', 'DE', 'FR', 'GB', 'IN', 'NL', 'PL', 'PT', 'SE', 'US'];
const MAL_SCHEDULE_DAY_OPTIONS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ANILIST_TRENDING_GENRE_OPTIONS = [
  'Action',
  'Adventure',
  'Comedy',
  'Drama',
  'Ecchi',
  'Fantasy',
  'Horror',
  'Mahou Shoujo',
  'Mecha',
  'Music',
  'Mystery',
  'Psychological',
  'Romance',
  'Sci-Fi',
  'Slice of Life',
  'Sports',
  'Supernatural',
  'Thriller',
];
const LETTERBOXD_GENRE_OPTIONS = [
  'Action',
  'Adventure',
  'Animation',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Family',
  'Fantasy',
  'History',
  'Horror',
  'Music',
  'Mystery',
  'Romance',
  'Science Fiction',
  'Thriller',
  'TV Movie',
  'War',
  'Western',
];
const SIMKL_MOVIE_GENRE_OPTIONS = [
  'all',
  'action',
  'adventure',
  'animation',
  'comedy',
  'crime',
  'documentary',
  'drama',
  'family',
  'fantasy',
  'history',
  'horror',
  'music',
  'mystery',
  'romance',
  'science-fiction',
  'thriller',
  'tv-movie',
  'war',
  'western',
];
const SIMKL_TV_GENRE_OPTIONS = [
  'all',
  'action',
  'adventure',
  'animation',
  'awards-show',
  'children',
  'comedy',
  'crime',
  'documentary',
  'drama',
  'family',
  'fantasy',
  'food',
  'game-show',
  'history',
  'home-and-garden',
  'horror',
  'indie',
  'korean-drama',
  'martial-arts',
  'mini-series',
  'musical',
  'mystery',
  'news',
  'podcast',
  'reality',
  'romance',
  'science-fiction',
  'soap',
  'special-interest',
  'sport',
  'suspense',
  'talk-show',
  'thriller',
  'travel',
  'video-game-play',
  'war',
  'western',
];
const SIMKL_ANIME_GENRE_OPTIONS = [
  'all',
  'action',
  'adventure',
  'comedy',
  'drama',
  'ecchi',
  'educational',
  'fantasy',
  'gag-humor',
  'gore',
  'harem',
  'historical',
  'horror',
  'idol',
  'isekai',
  'josei',
  'kids',
  'magic',
  'martial-arts',
  'mecha',
  'military',
  'music',
  'mystery',
  'mythology',
  'parody',
  'psychological',
  'racing',
  'reincarnation',
  'romance',
  'samurai',
  'school',
  'sci-fi',
  'seinen',
  'shoujo',
  'shoujo-ai',
  'shounen',
  'shounen-ai',
  'slice-of-life',
  'space',
  'sports',
  'strategy-game',
  'super-power',
  'supernatural',
  'thriller',
  'vampire',
  'yaoi',
  'yuri',
];

const MAL_NON_GENRE_CATALOG_IDS = new Set([
  'mal.airing',
  'mal.upcoming',
  'mal.top_movies',
  'mal.top_series',
  'mal.most_favorites',
  'mal.top_anime',
  'mal.most_popular',
]);

const TRAKT_NON_GENRE_CATALOG_IDS = new Set([
  'trakt.upnext',
  'trakt.unwatched',
  'trakt.calendar',
  'trakt.recommendations.movies',
  'trakt.recommendations.shows',
]);

function getDiscoverParams(catalog) {
  const params = catalog?.metadata?.discover?.params;
  if (params && typeof params === 'object' && !Array.isArray(params)) return params;
  const legacyParams = catalog?.metadata?.discoverParams;
  if (legacyParams && typeof legacyParams === 'object' && !Array.isArray(legacyParams)) return legacyParams;
  return {};
}

function splitConfiguredValues(rawValue) {
  if (rawValue === null || rawValue === undefined) return [];
  if (Array.isArray(rawValue)) {
    return rawValue
      .flatMap(value => String(value || '').split(/[|,]/))
      .map(value => value.trim())
      .filter(Boolean);
  }
  return String(rawValue)
    .split(/[|,]/)
    .map(value => value.trim())
    .filter(Boolean);
}

function buildGenreLookupMap(genreObjects = [], idKeys = ['id']) {
  const byId = new Map();
  const byName = new Map();

  (Array.isArray(genreObjects) ? genreObjects : []).forEach((genreObject) => {
    const name = String(genreObject?.name || '').trim();
    if (!name) return;

    byName.set(name.toLowerCase(), name);
    idKeys.forEach((idKey) => {
      const rawId = genreObject?.[idKey];
      if (rawId === null || rawId === undefined) return;
      const normalizedId = String(rawId).trim();
      if (!normalizedId) return;
      byId.set(normalizedId, name);
    });
  });

  return { byId, byName };
}

function mapConfiguredValuesToGenreNames(values, genreObjects = [], idKeys = ['id']) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const { byId, byName } = buildGenreLookupMap(genreObjects, idKeys);
  return values
    .map((value) => {
      const normalized = String(value || '').trim();
      if (!normalized) return null;
      return byId.get(normalized) || byName.get(normalized.toLowerCase()) || null;
    })
    .filter(Boolean);
}

function formatSimklOptionLabel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'all') return '';
  if (normalized === 'animation-filter') return 'Animation';
  return normalized
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function unionUnique(options) {
  const byNormalized = new Map();
  options.forEach((option) => {
    const label = String(option || '').trim();
    const normalized = label.toLowerCase();
    if (!normalized || normalized === 'none') return;
    if (!byNormalized.has(normalized)) {
      byNormalized.set(normalized, label);
    }
  });
  return Array.from(byNormalized.values());
}

function getCatalogGenreOptionsByType(type, movieOptions = [], seriesOptions = [], animeOptions = []) {
  if (type === 'movie') return Array.isArray(movieOptions) ? movieOptions : [];
  if (type === 'series') return Array.isArray(seriesOptions) ? seriesOptions : [];
  if (type === 'anime') return Array.isArray(animeOptions) ? animeOptions : [];
  if (type === 'all') {
    return unionUnique([
      ...(Array.isArray(movieOptions) ? movieOptions : []),
      ...(Array.isArray(seriesOptions) ? seriesOptions : []),
      ...(Array.isArray(animeOptions) ? animeOptions : []),
    ]);
  }
  return [];
}

function isNonGenreMALCatalogId(id) {
  if (MAL_NON_GENRE_CATALOG_IDS.has(id)) return true;
  return false;
}

function isMdbListNonGenreCatalogId(id) {
  return id === 'mdblist.upnext';
}

function isTvdbNonGenreCatalogId(id) {
  if (id === 'tvdb.collections') return true;
  return false;
}

function isTmdbNonGenreCatalogId(id) {
  if (id === 'tmdb.favorites' || id === 'tmdb.watchlist') return true;
  return false;
}

function isTraktNonGenreCatalogId(id) {
  return TRAKT_NON_GENRE_CATALOG_IDS.has(id);
}

function isTraktGenreCatalogId(id) {
  if (!id.startsWith('trakt.')) return false;
  return !isTraktNonGenreCatalogId(id);
}

function isSimklNonGenreCatalogId(id) {
  if (id.startsWith('simkl.watchlist.')) return true;
  if (id.startsWith('simkl.calendar')) return true;
  return false;
}

function isAniListNonGenreCatalogId(id) {
  if (id === 'anilist.trending') return false;
  if (id.startsWith('anilist.discover.')) return false;
  if (id.startsWith('anilist.')) return true;
  return false;
}

function isStremioCustomManifestCatalog(id) {
  return id.startsWith('custom.') || id.startsWith('stremthru.');
}

function isCatalogWithoutGenreSupport(catalog) {
  const id = String(catalog?.id || '');
  if (isNonGenreMALCatalogId(id)) return true;
  if (isTvdbNonGenreCatalogId(id)) return true;
  if (isTmdbNonGenreCatalogId(id) && id !== 'tmdb.favorites' && id !== 'tmdb.watchlist') return true;
  if (isMdbListNonGenreCatalogId(id)) return true;
  if (isTraktNonGenreCatalogId(id)) return true;
  if (isSimklNonGenreCatalogId(id)) return true;
  if (isAniListNonGenreCatalogId(id)) return true;
  return false;
}

function getMdbListGenreSelection(catalog) {
  const explicitSelection = catalog?.genreSelection || catalog?.metadata?.genreSelection;
  if (explicitSelection === 'standard' || explicitSelection === 'anime' || explicitSelection === 'all') {
    return explicitSelection;
  }

  if (catalog?.type === 'anime') return 'anime';
  if (catalog?.type === 'all') return 'all';
  return 'standard';
}

function getMdbListSelectionNeeds(children) {
  let needsStandard = false;
  let needsAnime = false;

  for (const child of children) {
    const id = String(child?.id || '');
    if (!id.startsWith('mdblist.') || id === 'mdblist.upnext') continue;

    const selection = child?.genreSelection || child?.metadata?.genreSelection;
    if (selection === 'all') {
      needsStandard = true;
      needsAnime = true;
      continue;
    }
    if (selection === 'anime') {
      needsAnime = true;
      continue;
    }
    if (selection === 'standard') {
      needsStandard = true;
      continue;
    }

    if (child?.type === 'anime') {
      needsAnime = true;
    } else if (child?.type === 'all') {
      needsStandard = true;
      needsAnime = true;
    } else {
      needsStandard = true;
    }
  }

  return { needsStandard, needsAnime };
}

function getConfiguredTmdbDiscoverGenres(catalog, context = {}) {
  const id = String(catalog?.id || '');
  if (!id.startsWith('tmdb.discover.')) return [];

  const discoverParams = getDiscoverParams(catalog);
  const genreValues = splitConfiguredValues(discoverParams.with_genres);
  if (genreValues.length === 0) return [];

  const {
    tmdbMovieGenres = [],
    tmdbSeriesGenres = [],
  } = context;

  const catalogType = String(catalog?.type || '');
  let genreObjects = [];
  if (catalogType === 'movie') {
    genreObjects = tmdbMovieGenres;
  } else if (catalogType === 'series') {
    genreObjects = tmdbSeriesGenres;
  } else {
    genreObjects = [
      ...(Array.isArray(tmdbMovieGenres) ? tmdbMovieGenres : []),
      ...(Array.isArray(tmdbSeriesGenres) ? tmdbSeriesGenres : []),
    ];
  }

  return mapConfiguredValuesToGenreNames(genreValues, genreObjects, ['id']);
}

function getConfiguredTvdbDiscoverGenres(catalog, context = {}) {
  const id = String(catalog?.id || '');
  if (!id.startsWith('tvdb.discover.')) return [];

  const discoverParams = getDiscoverParams(catalog);
  const genreValues = splitConfiguredValues(discoverParams.genre);
  if (genreValues.length === 0) return [];

  const tvdbGenres = Array.isArray(context.tvdbGenres) ? context.tvdbGenres : [];
  return mapConfiguredValuesToGenreNames(genreValues, tvdbGenres, ['id']);
}

function getConfiguredSimklDiscoverGenres(catalog) {
  const id = String(catalog?.id || '');
  if (!id.startsWith('simkl.discover.')) return [];

  const discoverParams = getDiscoverParams(catalog);
  const genreValues = splitConfiguredValues(discoverParams.genre)
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .filter(value => value !== 'all');
  if (genreValues.length === 0) return [];

  return genreValues
    .map(formatSimklOptionLabel)
    .filter(Boolean);
}

function getConfiguredAniListDiscoverGenres(catalog) {
  const id = String(catalog?.id || '');
  if (!id.startsWith('anilist.discover.')) return [];

  const discoverParams = getDiscoverParams(catalog);
  return splitConfiguredValues(discoverParams.genre_in);
}

function getConfiguredMalDiscoverGenres(catalog, context = {}) {
  const id = String(catalog?.id || '');
  if (!id.startsWith('mal.discover.')) return [];

  const discoverParams = getDiscoverParams(catalog);
  const genreValues = splitConfiguredValues(discoverParams.genres);
  if (genreValues.length === 0) return [];

  const malGenres = Array.isArray(context.malGenres) ? context.malGenres : [];
  return mapConfiguredValuesToGenreNames(genreValues, malGenres, ['mal_id', 'id']);
}

function collectConfiguredDiscoverGenreOptions(catalog, context = {}) {
  const id = String(catalog?.id || '');
  if (!id.includes('.discover.')) return [];

  if (id.startsWith('tmdb.discover.')) return getConfiguredTmdbDiscoverGenres(catalog, context);
  if (id.startsWith('tvdb.discover.')) return getConfiguredTvdbDiscoverGenres(catalog, context);
  if (id.startsWith('simkl.discover.')) return getConfiguredSimklDiscoverGenres(catalog);
  if (id.startsWith('anilist.discover.')) return getConfiguredAniListDiscoverGenres(catalog);
  if (id.startsWith('mal.discover.')) return getConfiguredMalDiscoverGenres(catalog, context);

  return [];
}

function hasConfiguredDiscoverGenre(catalog) {
  const id = String(catalog?.id || '');
  if (!id.includes('.discover.')) return false;

  const discoverParams = getDiscoverParams(catalog);
  if (id.startsWith('tmdb.discover.')) {
    return splitConfiguredValues(discoverParams.with_genres).length > 0;
  }
  if (id.startsWith('tvdb.discover.')) {
    return splitConfiguredValues(discoverParams.genre).length > 0;
  }
  if (id.startsWith('simkl.discover.')) {
    return splitConfiguredValues(discoverParams.genre)
      .map(value => String(value || '').trim().toLowerCase())
      .some(value => !!value && value !== 'all');
  }
  if (id.startsWith('anilist.discover.')) {
    return splitConfiguredValues(discoverParams.genre_in).length > 0;
  }
  if (id.startsWith('mal.discover.')) {
    return splitConfiguredValues(discoverParams.genres).length > 0;
  }
  return false;
}

function inferChildGenreSemantic(catalog) {
  const id = String(catalog?.id || '');
  if (id === 'tmdb.trending' || id.startsWith('simkl.trending.')) return 'interval';
  if (id === 'tmdb.year') return 'year';
  if (id === 'tmdb.language') return 'language';
  if (id === 'tvmaze.schedule' || id === 'tmdb.airing_today') return 'country';
  if (id === 'mal.schedule') return 'weekday';
  if (id === 'mal.seasons') return 'season';
  if (id === 'mal.studios') return 'studio';
  if (id === 'tmdb.favorites' || id === 'tmdb.watchlist') return 'sort';
  if (hasConfiguredDiscoverGenre(catalog)) return 'content';
  if (isCatalogWithoutGenreSupport(catalog)) return 'none';
  return 'content';
}

function getContextRequirementsForCatalog(catalog) {
  const id = String(catalog?.id || '');
  const requirements = new Set();

  if (id.startsWith('tmdb.discover.')) {
    requirements.add('tmdbGenres');
  }
  if (id.startsWith('tvdb.discover.')) {
    requirements.add('tvdbGenres');
  }
  if (id.startsWith('mal.discover.')) {
    requirements.add('malGenres');
  }

  if (id === 'tmdb.year') requirements.add('years');
  if (id === 'tmdb.language') requirements.add('languages');
  if (id === 'mal.studios') requirements.add('malStudios');
  if (id === 'mal.seasons') requirements.add('malSeasons');
  if (id.startsWith('streaming.') || id.startsWith('tmdb.list.') || id === 'tmdb.top' || id === 'tmdb.top_rated') {
    requirements.add('tmdbGenres');
  }
  if (id.startsWith('tvdb.') && !isTvdbNonGenreCatalogId(id)) {
    requirements.add('tvdbGenres');
  }
  if (id.startsWith('mdblist.') && !isMdbListNonGenreCatalogId(id)) {
    requirements.add('mdblistGenres');
  }
  if (id.startsWith('trakt.') && isTraktGenreCatalogId(id)) {
    requirements.add('traktGenres');
  }
  if (id.startsWith('mal.') && !isNonGenreMALCatalogId(id) && id !== 'mal.schedule' && id !== 'mal.seasons' && id !== 'mal.studios') {
    requirements.add('malGenres');
  }

  return requirements;
}

function collectFallbackGenreOptions(catalog, context = {}) {
  const id = String(catalog?.id || '');
  const type = String(catalog?.type || '');
  const {
    years = [],
    genres_movie_names = [],
    genres_series_names = [],
    genres_tvdb_all_names = [],
    tmdbMovieGenres = [],
    tmdbSeriesGenres = [],
    tvdbGenres = [],
    malGenres = [],
    animeGenreNames = [],
    studioNames = [],
    filterLanguages = [],
    availableSeasons = [],
    traktMovieGenreNames = [],
    traktShowGenreNames = [],
    mdblistStandardGenreNames = [],
    mdblistAnimeGenreNames = [],
  } = context;

  const configuredDiscoverGenres = collectConfiguredDiscoverGenreOptions(catalog, {
    tmdbMovieGenres,
    tmdbSeriesGenres,
    tvdbGenres,
    malGenres,
  });
  const mergeConfigured = (options = []) =>
    unionUnique([
      ...(Array.isArray(options) ? options : []),
      ...(Array.isArray(configuredDiscoverGenres) ? configuredDiscoverGenres : []),
    ]);

  if (id === 'tmdb.trending') return TMDB_TRENDING_INTERVAL_OPTIONS;
  if (id.startsWith('simkl.trending.')) return SIMKL_TRENDING_INTERVAL_OPTIONS;
  if (id === 'tvmaze.schedule') return TVMAZE_SCHEDULE_COUNTRY_OPTIONS;
  if (id === 'tmdb.airing_today') return TMDB_AIRING_TODAY_COUNTRY_OPTIONS;
  if (id === 'mal.schedule') return MAL_SCHEDULE_DAY_OPTIONS;
  if (id === 'mal.studios') return Array.isArray(studioNames) ? studioNames : [];
  if (id === 'mal.seasons') return Array.isArray(availableSeasons) ? availableSeasons : [];
  if (id === 'tmdb.language') return Array.isArray(filterLanguages) ? filterLanguages : [];
  if (id === 'tmdb.year') return Array.isArray(years) ? years : [];
  if (id.startsWith('tmdb.discover.')) {
    return mergeConfigured(getCatalogGenreOptionsByType(type, genres_movie_names, genres_series_names, animeGenreNames));
  }
  if (id.startsWith('tvdb.discover.')) {
    return mergeConfigured(Array.isArray(genres_tvdb_all_names) ? genres_tvdb_all_names : []);
  }
  if (id.startsWith('mal.discover.')) {
    return mergeConfigured(Array.isArray(animeGenreNames) ? animeGenreNames : []);
  }
  if (id.startsWith('anilist.discover.')) {
    return mergeConfigured(ANILIST_TRENDING_GENRE_OPTIONS);
  }
  if (id.startsWith('simkl.discover.')) {
    return mergeConfigured(getCatalogGenreOptionsByType(type, SIMKL_MOVIE_GENRE_OPTIONS, SIMKL_TV_GENRE_OPTIONS, SIMKL_ANIME_GENRE_OPTIONS));
  }
  if (isCatalogWithoutGenreSupport(catalog)) return [];

  if (id.startsWith('mal.')) {
    return Array.isArray(animeGenreNames) ? animeGenreNames : [];
  }
  if (id.startsWith('tvdb.') && !isTvdbNonGenreCatalogId(id)) {
    return Array.isArray(genres_tvdb_all_names) ? genres_tvdb_all_names : [];
  }
  if (id === 'anilist.trending') {
    return ANILIST_TRENDING_GENRE_OPTIONS;
  }
  if (id.startsWith('letterboxd.')) {
    return LETTERBOXD_GENRE_OPTIONS;
  }
  if (id.startsWith('trakt.') && isTraktGenreCatalogId(id)) {
    return getCatalogGenreOptionsByType(type, traktMovieGenreNames, traktShowGenreNames, traktShowGenreNames);
  }
  if (id.startsWith('mdblist.') && !isMdbListNonGenreCatalogId(id)) {
    const selection = getMdbListGenreSelection(catalog);
    if (selection === 'anime') {
      return Array.isArray(mdblistAnimeGenreNames) ? mdblistAnimeGenreNames : [];
    }
    if (selection === 'all') {
      return unionUnique([
        ...(Array.isArray(mdblistStandardGenreNames) ? mdblistStandardGenreNames : []),
        ...(Array.isArray(mdblistAnimeGenreNames) ? mdblistAnimeGenreNames : []),
      ]);
    }
    return Array.isArray(mdblistStandardGenreNames) ? mdblistStandardGenreNames : [];
  }
  if (id.startsWith('tmdb.list.') || id.startsWith('streaming.') || id === 'tmdb.top' || id === 'tmdb.top_rated') {
    return getCatalogGenreOptionsByType(type, genres_movie_names, genres_series_names, animeGenreNames);
  }
  if (isStremioCustomManifestCatalog(id)) return [];
  if (id.startsWith('simkl.')) return [];

  // Unknown providers: do not infer capability from type alone.
  return [];
}

module.exports = {
  collectFallbackGenreOptions,
  getContextRequirementsForCatalog,
  getMdbListSelectionNeeds,
  inferChildGenreSemantic,
  isTraktGenreCatalogId,
};
