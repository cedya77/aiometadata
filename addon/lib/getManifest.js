require("dotenv").config();
const { getGenreList } = require("./getGenreList");
const { getLanguages } = require("./getLanguages");
const { getGenresFromMDBList } = require("../utils/mdbList");
const { getGenresFromStremThruCatalog, fetchStremThruCatalog } = require("../utils/stremthru");
const packageJson = require("../../package.json");
const catalogsTranslations = require("../static/translations.json");
const CATALOG_TYPES = require("../static/catalog-types.json");
const jikan = require('./mal');
const DEFAULT_LANGUAGE = "en-US";
const { cacheWrapJikanApi, cacheWrapGlobal, cacheWrapStremThruGenres } = require('./getCache');

const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;

// Manifest cache TTL (5 minutes)
const MANIFEST_CACHE_TTL = 5 * 60;

function generateArrayOfYears(maxYears) {
  const max = new Date().getFullYear();
  const min = max - maxYears;
  const years = [];
  for (let i = max; i >= min; i--) {
    years.push(i.toString());
  }
  return years;
}

function setOrderLanguage(language, languagesArray) {
  const languageObj = languagesArray.find((lang) => lang.iso_639_1 === language);
  const fromIndex = languagesArray.indexOf(languageObj);
  const element = languagesArray.splice(fromIndex, 1)[0];
  languagesArray = languagesArray.sort((a, b) => (a.name > b.name ? 1 : -1));
  languagesArray.splice(0, 0, element);
  return [...new Set(languagesArray.map((el) => el.name))];
}

function loadTranslations(language) {
  const defaultTranslations = catalogsTranslations[DEFAULT_LANGUAGE] || {};
  const selectedTranslations = catalogsTranslations[language] || {};

  return { ...defaultTranslations, ...selectedTranslations };
}

function createCatalog(id, type, catalogDef, options, showPrefix, translatedCatalogs, showInHome = false, customName = null) {
  const extra = [];

  if (catalogDef.extraSupported.includes("genre")) {
    if (catalogDef.defaultOptions) {
      const formattedOptions = catalogDef.defaultOptions.map(option => {
        if (option.includes('.')) {
          const [field, order] = option.split('.');
          if (translatedCatalogs[field] && translatedCatalogs[order]) {
            return `${translatedCatalogs[field]} (${translatedCatalogs[order]})`;
          }
          return option;
        }
        return translatedCatalogs[option] || option;
      });
      const genreExtra = {
        name: "genre",
        options: formattedOptions,
        isRequired: showInHome ? false : true
      };

      if (options && options.length > 0) {
        genreExtra.default = options[0];
      }

      extra.push(genreExtra);
    } else {
      const genreExtra = {
        name: "genre",
        options,
        isRequired: showInHome ? false : true
      };

      if (options && options.length > 0) {
        genreExtra.default = options[0];
      }

      extra.push(genreExtra);
    }
  }
  if (catalogDef.extraSupported.includes("search")) {
    extra.push({ name: "search" });
  }
  if (catalogDef.extraSupported.includes("skip")) {
    extra.push({ name: "skip" });
  }

  let pageSize;
  if (id.startsWith('mal.')) {
    pageSize = 25; // Jikan API uses a page size of 25 (anime catalogs)
  } else {
    // Use environment variable for non-anime catalogs, fallback to 20
    pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE) || 20;
  }

  // Get the default English name from translations to check if customName is just a placeholder
  const defaultEnglishTranslations = catalogsTranslations[DEFAULT_LANGUAGE] || {};
  const defaultEnglishName = defaultEnglishTranslations[catalogDef.nameKey];
  
  // Check if customName is just the default English translation (not a true custom name)
  const isDefaultEnglishName = customName && customName.includes(defaultEnglishName);
  
  // Use custom name only if it's provided, not empty, and not just the default English name
  const hasCustomName = customName && typeof customName === 'string' && customName.trim() !== '' && !isDefaultEnglishName;
  const catalogName = hasCustomName ? customName : `${showPrefix ? "AIOMetadata - " : ""}${translatedCatalogs[catalogDef.nameKey]}`;

  return {
    id,
    type,
    name: catalogName,
    pageSize: pageSize,
    extra,
    showInHome: showInHome 
  };
}

function getCatalogDefinition(catalogId) {
  const [provider, catalogType] = catalogId.split('.');

  if (CATALOG_TYPES[provider] && CATALOG_TYPES[provider][catalogType]) {
    return CATALOG_TYPES[provider][catalogType];
  }
  if (CATALOG_TYPES.default && CATALOG_TYPES.default[catalogType]) {
    return CATALOG_TYPES.default[catalogType];
  }
  return null;
}

function getOptionsForCatalog(catalogDef, type, showInHome, { years, genres_movie, genres_series, filterLanguages }) {
  if (catalogDef.defaultOptions) return catalogDef.defaultOptions;

  const movieGenres = [...genres_movie]
  const seriesGenres = [...genres_series]

  switch (catalogDef.nameKey) {
    case 'year':
      return years;
    case 'language':
      return filterLanguages;
    case 'popular':
      return type === 'movie' ? movieGenres : seriesGenres;
    default:
      // For anime type, return empty array since most anime catalogs don't need genre options
      if (type === 'anime') {
        return [];
      }
      return type === 'movie' ? movieGenres : seriesGenres;
  }
}

async function createMDBListCatalog(userCatalog, mdblistKey) {
  try {
    console.log(`[Manifest] Creating MDBList catalog: ${userCatalog.id} (${userCatalog.type})`);
    const listId = userCatalog.id.split(".")[1];
    console.log(`[Manifest] MDBList list ID: ${listId}, API key present: ${!!mdblistKey}`);
    
    let genres = [];
    try {
      genres = await getGenresFromMDBList(listId, mdblistKey);
      console.log(`[Manifest] MDBList genres fetched: ${genres.length} genres`);
    } catch (genreError) {
      console.warn(`[Manifest] Failed to fetch MDBList genres for ${listId}, using fallback:`, genreError.message);
      // Use fallback genres if API call fails
      genres = [
        "Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary", 
        "Drama", "Family", "Fantasy", "History", "Horror", "Music", "Mystery", 
        "Romance", "Science Fiction", "Thriller", "War", "Western"
      ];
    }
    
    // Add "None" option when showInHome is false to work around Stremio's genre requirement
    const genreOptions = userCatalog.showInHome ? genres : ['None', ...genres];
    
    const catalog = {
      id: userCatalog.id,
      type: userCatalog.type,
      name: userCatalog.name,
      pageSize: parseInt(process.env.CATALOG_LIST_ITEMS_SIZE) || 20,
      extra: [
        { name: "genre", options: genreOptions, isRequired: userCatalog.showInHome ? false : true },
        { name: "skip" },
      ],
      showInHome: userCatalog.showInHome
    };
    
    console.log(`[Manifest] MDBList catalog created successfully: ${catalog.id}`);
    return catalog;
  } catch (error) {
    console.error(`[Manifest] Error creating MDBList catalog ${userCatalog.id}:`, error.message);
    return null; // Return null instead of throwing to prevent manifest failure
  }
}

async function createStremThruCatalog(userCatalog) {
  try {
    //console.log(`[Manifest] Creating StremThru catalog: ${userCatalog.id} (${userCatalog.type})`);
    
    // Extract catalog info from the StremThru catalog ID
    // Format: stremthru.{manifestId}.{catalogId}
    const parts = userCatalog.id.split(".");
    if (parts.length < 3) {
      console.warn(`[Manifest] Invalid StremThru catalog ID format: ${userCatalog.id}`);
      return null;
    }
    
    const manifestId = parts[1];
    const catalogId = parts[2];
    
    // Get the catalog URL from the user catalog source
    const catalogUrl = userCatalog.source;
    if (!catalogUrl) {
      console.warn(`[Manifest] No source URL found for StremThru catalog: ${userCatalog.id}`);
      return null;
    }
    
    // Get genres from multiple sources with fallback priority:
    // 1. userCatalog.genres (from manifest import)
    // 2. userCatalog.manifestData.extra (from original StremThru manifest)
    // 3. Fetch from catalog items (as last resort)
    let genres = [];
    
    if (userCatalog.genres && Array.isArray(userCatalog.genres) && userCatalog.genres.length > 0) {
      genres = userCatalog.genres;
      console.log(`[Manifest] Using genres from userCatalog.genres: ${genres.length} genres`);
    } else if (userCatalog.manifestData && userCatalog.manifestData.extra) {
      // Try to extract genres from the original manifest data
      const genreExtra = userCatalog.manifestData.extra.find(e => e.name === 'genre');
      if (genreExtra && genreExtra.options && Array.isArray(genreExtra.options) && genreExtra.options.length > 0) {
        genres = genreExtra.options;
        console.log(`[Manifest] Using genres from manifestData.extra: ${genres.length} genres`);
      }
    }
    
    // If still no genres, try to fetch from catalog items (last resort)
    if (genres.length === 0) {
      try {
        console.log(`[Manifest] Attempting to fetch genres from catalog items for ${userCatalog.id}`);
        // Wrap in cache to avoid repeated API calls on manifest generation
        genres = await cacheWrapStremThruGenres(catalogUrl, async () => {
          console.log(`[Manifest] Fetching fresh genres from StremThru catalog: ${catalogUrl}`);
          const items = await fetchStremThruCatalog(catalogUrl);
          if (items && items.length > 0) {
            const extractedGenres = await getGenresFromStremThruCatalog(items);
            console.log(`[Manifest] Extracted and cached ${extractedGenres.length} genres from catalog items`);
            return extractedGenres;
          }
          return [];
        });
        console.log(`[Manifest] Using ${genres.length} genres for ${userCatalog.id}`);
      } catch (genreError) {
        console.warn(`[Manifest] Failed to fetch genres from catalog items for ${userCatalog.id}:`, genreError.message);
      }
    }
    
    // Final fallback
    if (genres.length === 0) {
      console.warn(`[Manifest] No genres found for ${userCatalog.id}, using fallback`);
      genres = ['None']; // Single option for catalogs without genre support
    }
    
    // Add "None" option when showInHome is false to work around Stremio's genre requirement
    const genreOptions = userCatalog.showInHome ? genres : ['None', ...genres];
    
    const catalog = {
      id: userCatalog.id,
      type: userCatalog.type,
      name: userCatalog.name,
      pageSize: parseInt(process.env.CATALOG_LIST_ITEMS_SIZE) || 20,
      extra: [
        { name: "genre", options: genreOptions, isRequired: userCatalog.showInHome ? false : true },
        { name: "skip" },
      ],
      showInHome: userCatalog.showInHome
    };
    
   // console.log(`[Manifest] StremThru catalog created successfully: ${catalog.id}`);
    return catalog;
  } catch (error) {
    console.error(`[Manifest] Error creating StremThru catalog ${userCatalog.id}:`, error.message);
    return null; // Return null instead of throwing to prevent manifest failure
  }
}

async function getManifest(config) {
  const startTime = Date.now();
  console.log('[Manifest] Starting manifest generation...');
  
  // Generate manifest directly without caching to avoid cache key issues
  // The manifest is fast to generate and caching causes more problems than it solves
    const language = config.language || DEFAULT_LANGUAGE;
    const showPrefix = config.showPrefix === true;
    const provideImdbId = config.provideImdbId === "true";
    const sessionId = config.sessionId;
    const userCatalogs = config.catalogs || getDefaultCatalogs();
    const translatedCatalogs = loadTranslations(language);


  const enabledCatalogs = userCatalogs.filter(c => c.enabled);
  console.log(`[Manifest] Total catalogs: ${userCatalogs.length}, Enabled: ${enabledCatalogs.length}`);
  console.log(`[Manifest] MDBList catalogs in enabled:`, enabledCatalogs.filter(c => c.id.startsWith('mdblist.')).map(c => c.id));
  //console.log(`[Manifest] StremThru catalogs in enabled:`, enabledCatalogs.filter(c => c.id.startsWith('stremthru.')).map(c => c.id));
  
  const years = generateArrayOfYears(20);
  
  // Only fetch genre lists if we actually have catalogs that need them
  const hasTmdbCatalogs = enabledCatalogs.some(cat => cat.id.startsWith('tmdb.'));
  const hasTvdbCatalogs = enabledCatalogs.some(cat => cat.id.startsWith('tvdb.'));
  const hasMalCatalogs = enabledCatalogs.some(cat => cat.id.startsWith('mal.'));
  
  // Parallel fetch only what we need
  const fetchPromises = [];
  
  if (hasTmdbCatalogs) {
    fetchPromises.push(
      getGenreList('tmdb', language, "movie", config),
      getGenreList('tmdb', language, "series", config)
    );
  }
  
  if (hasTvdbCatalogs) {
    fetchPromises.push(
      getGenreList('tvdb', language, "series", config)
    );
  }
  
  fetchPromises.push(
    cacheWrapGlobal(`languages:${language}`, () => getLanguages(config), 60 * 60)
  );
  
  const genreStart = Date.now();
  const results = await Promise.all(fetchPromises);
  console.log(`[Manifest] Genre lists and languages fetched in ${Date.now() - genreStart}ms`);
  
  // Extract results based on what was fetched
  let genres_movie = [], genres_series = [], genres_tvdb_all = [];
  let resultIndex = 0;
  
  if (hasTmdbCatalogs) {
    genres_movie = results[resultIndex++];
    genres_series = results[resultIndex++];
  }
  
  if (hasTvdbCatalogs) {
    genres_tvdb_all = results[resultIndex++];
  }
  
  const languagesArray = results[resultIndex];
  
  // Only fetch anime genres if we have MAL catalogs
  let animeGenreNames = [];
  let studioNames = [];
  if (hasMalCatalogs) {
    const animeStart = Date.now();
    const animeGenres = await cacheWrapJikanApi('anime-genres', async () => {
      console.log('[Cache Miss] Fetching fresh anime genre list in manifest from Jikan...');
      return await jikan.getAnimeGenres();
    });
    animeGenreNames = animeGenres.filter(Boolean).map(genre => genre.name).sort();
    console.log(`[Manifest] Anime genres fetched in ${Date.now() - animeStart}ms`);
    
    // Only fetch studios if we have a studio catalog - but don't block manifest generation
    const hasStudioCatalog = enabledCatalogs.some(cat => cat.id === 'mal.studios');
    if (hasStudioCatalog) {
      try {
        // Try to get cached studios first, don't block if not available
        const studioPromise = cacheWrapJikanApi('mal-studios', async () => {
          console.log('[Cache Miss] Fetching fresh anime studio list in manifest from Jikan...');
          return await jikan.getStudios();
        }, 30 * 24 * 60 * 60); // Cache for 30 days
        
        // Add timeout to prevent blocking manifest generation
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Studio fetch timeout')), 2000); // 2 second timeout
        });
        
        const studios = await Promise.race([studioPromise, timeoutPromise]);
        
        studioNames = studios.map(studio => {
          const defaultTitle = studio.titles.find(t => t.type === 'Default');
          return defaultTitle ? defaultTitle.title : null;
        }).filter(Boolean);
        console.log(`[Manifest] Studio list fetched successfully (${studioNames.length} studios)`);
      } catch (error) {
        console.warn('[Manifest] Studio list fetch failed, using empty list:', error.message);
        studioNames = []; // Fallback to empty list
      }
    }
  }
  
  const genres_movie_names = genres_movie.map(g => g.name).sort();
  const genres_series_names = genres_series.map(g => g.name).sort();
  const genres_tvdb_all_names = genres_tvdb_all.map(g => g.name).sort();
  const filterLanguages = setOrderLanguage(language, languagesArray);
  const isMDBList = (id) => id.startsWith("mdblist.");
  const options = { years, genres_movie: genres_movie_names, genres_series: genres_series_names, filterLanguages };

  let catalogs = await Promise.all(enabledCatalogs
    .filter(userCatalog => {
      const catalogDef = getCatalogDefinition(userCatalog.id);
      if (isMDBList(userCatalog.id)) {
        //console.log(`[Manifest] MDBList catalog ${userCatalog.id} passed filter`);
        return true;
      }
      if (userCatalog.id.startsWith('stremthru.')) {
        //console.log(`[Manifest] StremThru catalog ${userCatalog.id} passed filter`);
        return true;
      }
      if (!catalogDef) {
        console.log(`[Manifest] Catalog ${userCatalog.id} failed filter: no catalog definition`);
        return false;
      }
      if (catalogDef.requiresAuth && !sessionId) {
        console.log(`[Manifest] Catalog ${userCatalog.id} failed filter: requires auth but no session`);
        return false;
      }
      return true;
    })
    .map(async (userCatalog) => {
      if (isMDBList(userCatalog.id)) {
          console.log(`[Manifest] Processing MDBList catalog: ${userCatalog.id}`);
          const result = await createMDBListCatalog(userCatalog, config.apiKeys?.mdblist);
          console.log(`[Manifest] MDBList catalog result:`, result ? 'success' : 'failed');
          return result;
      }
      if (userCatalog.id.startsWith('stremthru.')) {
          //console.log(`[Manifest] Processing StremThru catalog: ${userCatalog.id}`);
          const result = await createStremThruCatalog(userCatalog);
          //console.log(`[Manifest] StremThru catalog result:`, result ? 'success' : 'failed');
          return result;
      }
      const catalogDef = getCatalogDefinition(userCatalog.id);
      let catalogOptions = [];

      if (userCatalog.id.startsWith('tvdb.') && !userCatalog.id.includes('collections')) {
        const excludedGenres = ['awards show', 'podcast', 'game show', 'news'];
        catalogOptions = genres_tvdb_all_names
          .filter(name => !excludedGenres.includes(name.toLowerCase()))
          .sort();
      }
      else if (userCatalog.id === 'tvdb.collections') {
        const genres = ['None'];
        return createCatalog(
          userCatalog.id,
          userCatalog.type,
          catalogDef,
          genres,
          showPrefix,
          translatedCatalogs,
          userCatalog.showInHome,
          userCatalog.name
        );
      }
      else if (userCatalog.id === 'mal.genres') {
          // Use pre-fetched anime genres
          catalogOptions = animeGenreNames;
      } else if (userCatalog.id === 'mal.studios'){
        // Use pre-fetched studio names, fallback to empty if not available
        catalogOptions = studioNames.length > 0 ? studioNames : ['None'];
      }
      else if (userCatalog.id === 'mal.schedule') {
        catalogOptions = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      } 
      else if (userCatalog.id === 'mal.airing' || userCatalog.id === 'mal.upcoming' || 
               userCatalog.id === 'mal.top_movies' || userCatalog.id === 'mal.top_series' || 
               userCatalog.id === 'mal.most_favorites' || userCatalog.id === 'mal.most_popular' || 
               userCatalog.id === 'mal.top_anime') {
        // Provide "None" option to work around Stremio's genre requirement
        catalogOptions = ['None'];
      }
      else if (userCatalog.id.startsWith('mal.') && !['mal.airing', 'mal.upcoming', 'mal.schedule', 'mal.top_movies', 'mal.top_series', 'mal.most_favorites', 'mal.top_anime', 'mal.most_popular'].includes(userCatalog.id)) {
        // Use pre-fetched anime genres for decade catalogs
        catalogOptions = animeGenreNames;
      }
      else {
        catalogOptions = getOptionsForCatalog(catalogDef, userCatalog.type, userCatalog.showInHome, options);
        if (userCatalog.id.startsWith('streaming.') && userCatalog.showInHome === false) {
          catalogOptions = ['None', ...catalogOptions];
        }
      }

      const catalog = createCatalog(
          userCatalog.id,
          userCatalog.type,
          catalogDef,
          catalogOptions,
          showPrefix,
          translatedCatalogs,
          userCatalog.showInHome,
          userCatalog.name
      );
      return catalog;   
    }));
  
  catalogs = catalogs.filter(Boolean);

  const seen = new Set();
  catalogs = catalogs.filter(cat => {
    const key = `${cat.id}:${cat.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const isSearchEnabled = config.search?.enabled ?? true;
  const engineEnabled = config.search?.engineEnabled || {};
  const searchProviders = config.search?.providers || {};
  const movieSearchProviderName = searchProviders.movie.split('.')[0].toUpperCase();
  const seriesSearchProviderName = searchProviders.series.split('.')[0].toUpperCase();

  if (isSearchEnabled) {
    const prefix = showPrefix ? "AIOMetadata - " : "";
    // Movie Search
    if (engineEnabled[searchProviders.movie] !== false) {
      catalogs.push({ id: 'search', type: 'movie', name: `${prefix}Search`, extra: [{ name: 'search', isRequired: true }] });
    }
    // Series Search
    if (engineEnabled[searchProviders.series] !== false) {
      catalogs.push({ id: 'search', type: 'series', name: `${prefix}Search`, extra: [{ name: 'search', isRequired: true }] });
    }
    // Anime Series Search
    if (engineEnabled[searchProviders.anime_series] !== false) {
      catalogs.push({
        id: "search",
        type: "anime.series",
        name: "Anime Search (Series)",
        extra: [{ name: "search", isRequired: true }]
      });
    }
    // Anime Movies Search
    if (engineEnabled[searchProviders.anime_movie] !== false) {
      catalogs.push({
        id: "search",
        type: "anime.movie",
        name: "Anime Search (Movies)",
        extra: [{ name: "search", isRequired: true }]
      });
    }
    // MAL special search catalogs (only if any mal.search engine is enabled)
    const isMalSearchInUse = Object.entries(searchProviders).some(
      ([key, providerId]) =>
        typeof providerId === 'string' &&
        providerId.startsWith('mal.search') &&
        engineEnabled[providerId] !== false
    );
    if (isMalSearchInUse) {
      const searchVAAnime = {
        id: "mal.va_search",
        type: "anime",
        name: `${prefix}Voice Actor Roles`,
        extra: [{ name: "va_id", isRequired: true }]
      };
      const searchGenreAnime = {
        id: "mal.genre_search",
        type: "anime",
        name: `${prefix}Anime Genre`,
        extra: [{ name: "genre_id", isRequired: true }]
      };
      catalogs.push(searchVAAnime, searchGenreAnime);
    }
  }

  if (config.geminikey) {
    const aiSearchCatalogMovie = {
      id: "gemini.search", 
      type: "movie",
      name: "AI Search",
      extra: [{ name: "search", isRequired: true }]
    };

    const aiSearchCatalogSeries = {
      id: "gemini.search",
      type: "series",
      name: "AI Search",
      extra: [{ name: "search", isRequired: true }]
    };
    
    const aiSearchCatalogAnime = {
      id: "gemini.search",
      type: "anime",
      name: "AI Search",
      extra: [{ name: "search", isRequired: true }]
    };

    catalogs = [...catalogs, aiSearchCatalogMovie, aiSearchCatalogSeries, aiSearchCatalogAnime];
  }

  const activeConfigs = [
    `Language: ${language}`,
    `TMDB Account: ${sessionId ? 'Connected' : 'Not Connected'}`,
    `MDBList Integration: ${config.mdblistkey ? 'Connected' : 'Not Connected'}`,
    `IMDb Integration: ${provideImdbId ? 'Enabled' : 'Disabled'}`,
    `RPDB Integration: ${config.rpdbkey ? 'Enabled' : 'Disabled'}`,
    `Search: ${config.searchEnabled !== "false" ? 'Enabled' : 'Disabled'}`,
    `Active Catalogs: ${catalogs.length}`
  ].join(' | ');
  

  const manifest = {
    id: packageJson.name,
    version: packageJson.version,
    favicon: `${host}/favicon.png`,
    logo: `${host}/logo.png`,
    background: `${host}/background.png`,
    name: "AIOMetadata",
    description: "A metadata addon for power users. AIOMetadata uses TMDB, TVDB, TVMaze, MyAnimeList, IMDB and Fanart.tv to provide accurate data for movies, series, and anime. You choose the source. Also includes an optional AI search powered by Gemini.",
    resources: ["catalog", "meta"],
    types: ["movie", "series", "anime.movie", "anime.series", "anime", "Trakt"],
    idPrefixes: ["tmdb:", "tt", "tvdb:", "mal:", "tvmaze:", "kitsu:", "anidb:", "anilist:", "tvdbc:"],
    //stremioAddonsConfig,
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
    catalogs,
  };
  
  const endTime = Date.now();
  console.log(`[Manifest] Manifest generation completed in ${endTime - startTime}ms`);
  
  return manifest;
}

function getDefaultCatalogs() {
  const defaultTypes = ['movie', 'series'];
  const defaultTmdbCatalogs = Object.keys(CATALOG_TYPES.default);
  const defaultTvdbCatalogs = Object.keys(CATALOG_TYPES.tvdb);
  const defaultMalCatalogs = Object.keys(CATALOG_TYPES.mal);
  const defaultStreamingCatalogs = Object.keys(CATALOG_TYPES.streaming);

  const tmdbCatalogs = defaultTmdbCatalogs.flatMap(id =>
    defaultTypes.map(type => ({
      id: `tmdb.${id}`,
      type,
      showInHome: true,
      enabled: true 
    }))
  );
  const tvdbCatalogs = defaultTvdbCatalogs.flatMap(id =>
    id === 'collections'
      ? [{ id: `tvdb.${id}`, type: 'series', showInHome: false, enabled: true }]
      : defaultTypes.map(type => ({
          id: `tvdb.${id}`,
          type,
          showInHome: false,
          enabled: true 
        }))
  );
  const malCatalogs = defaultMalCatalogs.map(id => ({
    id: `mal.${id}`,
    type: 'anime',
    showInHome: !['genres', 'schedule'].includes(id),
    enabled: true 
  }));

  const streamingCatalogs = defaultStreamingCatalogs.flatMap(id =>
    defaultTypes.map(type => ({
    id: `streaming.${id}`,
    type,
    showInHome: false,
    enabled: true
  }))
  );

  return [...tmdbCatalogs, ...tvdbCatalogs, ...malCatalogs, ...streamingCatalogs];
}

module.exports = { getManifest, DEFAULT_LANGUAGE };
