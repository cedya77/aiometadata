require("dotenv").config();
const { getGenreList } = require("./getGenreList");
const { getLanguages } = require("./getLanguages");
const { getGenresFromMDBList, fetchMDBListGenres } = require("../utils/mdbList");
const { getGenresFromStremThruCatalog, fetchStremThruCatalog } = require("../utils/stremthru");
const { fetchTraktGenres } = require("../utils/traktUtils");
const { getGenresBySelection } = require("../static/genres");
const packageJson = require("../../package.json");
const catalogsTranslations = require("../static/translations.json");
const CATALOG_TYPES = require("../static/catalog-types.json");
const jikan = require('./mal');
const DEFAULT_LANGUAGE = "en-US";
const { cacheWrapJikanApi, cacheWrapGlobal, cacheWrapStremThruGenres } = require('./getCache');
const consola = require('consola');
const logger = consola.withTag('Manifest');


const host = process.env.HOST_NAME && process.env.HOST_NAME.startsWith('http')
  ? process.env.HOST_NAME
  : `https://${process.env.HOST_NAME}`;

// Allow logo override via env var
const manifestLogoUrl = process.env.ADDON_LOGO_URL && process.env.ADDON_LOGO_URL.trim() !== ''
  ? process.env.ADDON_LOGO_URL.trim()
  : `${host}/logo.png`;

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

function createCatalog(id, type, catalogDef, options, showPrefix, translatedCatalogs, showInHome = false, customName = null, displayType = null) {
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
      // Add "None" option for airing_today when showInHome is false to work around Stremio's genre requirement
      const finalOptions = (id.startsWith('tmdb.airing_today') && !showInHome) ? ['None', ...formattedOptions] : formattedOptions;
      const genreExtra = {
        name: "genre",
        options: finalOptions,
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
  const isDefaultEnglishName = customName && customName === defaultEnglishName;
  
  // Use custom name only if it's provided, not empty, and not just the default English name
  const hasCustomName = customName && typeof customName === 'string' && customName.trim() !== '' && !isDefaultEnglishName;
  const catalogName = hasCustomName ? customName : `${showPrefix ? "AIOMetadata - " : ""}${translatedCatalogs[catalogDef.nameKey]}`;

  // Use displayType if defined, otherwise use original type
  const catalogType = displayType || type;
  let finalId = id;
  if (displayType) {
    finalId = `${id}_${type}`;
  }

  return {
    id: finalId,
    type: catalogType,
    name: catalogName,
    pageSize: pageSize,
    extra,
    showInHome: showInHome 
  };
}

function getCatalogDefinition(catalogId) {
  const [provider, catalogType] = catalogId.split('.');

  // Check auth catalogs (favorites and watchlist) first
  if ((catalogType === 'favorites' || catalogType === 'watchlist') && CATALOG_TYPES.auth && CATALOG_TYPES.auth[catalogType]) {
    return CATALOG_TYPES.auth[catalogType];
  }

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

async function createMDBListCatalog(userCatalog, mdblistKey, prefetchedStandardGenres = [], prefetchedAnimeGenres = []) {
  try {
    logger.info(`Creating MDBList catalog: ${userCatalog.id} (${userCatalog.type})`);
    const listId = userCatalog.id.split(".")[1];
    logger.debug(`MDBList list ID: ${listId}, API key present: ${!!mdblistKey}`);
    
    // Use pre-fetched genres or fall back to static
    const genreSelection = userCatalog.genreSelection || 'standard';
    let genres = [];
    
    // Use pre-fetched genres based on selection
    if (genreSelection === 'standard' && prefetchedStandardGenres.length > 0) {
      genres = prefetchedStandardGenres;
      logger.debug(`MDBList using ${genres.length} pre-fetched standard genres`);
    } else if (genreSelection === 'anime' && prefetchedAnimeGenres.length > 0) {
      genres = prefetchedAnimeGenres;
      logger.debug(`MDBList using ${genres.length} pre-fetched anime genres`);
    } else if (genreSelection === 'all' && (prefetchedStandardGenres.length > 0 || prefetchedAnimeGenres.length > 0)) {
      genres = [...prefetchedStandardGenres, ...prefetchedAnimeGenres];
      logger.debug(`MDBList using ${genres.length} pre-fetched combined genres`);
    } else {
      // Fallback to static genres if pre-fetch failed
      genres = getGenresBySelection(genreSelection);
      logger.info(`MDBList using ${genres.length} static fallback genres for selection: ${genreSelection}`);
    }
    
    // Add "None" option when showInHome is false to work around Stremio's genre requirement
    const genreOptions = userCatalog.showInHome ? genres : ['None', ...genres];
    
    // Use displayType if defined, otherwise use original type
    const catalogType = userCatalog.displayType || userCatalog.type;
    
    const catalog = {
      id: userCatalog.id,
      type: catalogType,
      name: userCatalog.name,
      pageSize: parseInt(process.env.CATALOG_LIST_ITEMS_SIZE) || 20,
      extra: [
        { name: "genre", options: genreOptions, isRequired: userCatalog.showInHome ? false : true },
        { name: "skip" },
      ],
      showInHome: userCatalog.showInHome
    };
    
    logger.success(`MDBList catalog created successfully: ${catalog.id}`);
    return catalog;
  } catch (error) {
    logger.error(`Error creating MDBList catalog ${userCatalog.id}:`, error.message);
    return null; // Return null instead of throwing to prevent manifest failure
  }
}

async function createTraktCatalog(userCatalog, prefetchedMovieGenres = [], prefetchedShowGenres = []) {
  try {
    logger.info(`Creating Trakt catalog: ${userCatalog.id} (${userCatalog.type})`);
    
    // Determine which genre list to use based on catalog type
    let genres = [];
    // Select the correct list of genre objects
    if (userCatalog.type === 'movie' && prefetchedMovieGenres.length > 0) {
      genres = prefetchedMovieGenres;
      logger.debug(`Trakt using ${genres.length} pre-fetched movie genres`);
    } else if (userCatalog.type === 'series' && prefetchedShowGenres.length > 0) {
      genres = prefetchedShowGenres;
      logger.debug(`Trakt using ${genres.length} pre-fetched show genres`);
    } else if (userCatalog.type === 'all') {
      const combined = [...prefetchedMovieGenres, ...prefetchedShowGenres];
      const uniqueMap = new Map(combined.map(g => [g.slug, g]));
      genres = Array.from(uniqueMap.values()).sort((a, b) => a.name.localeCompare(b.name));
      
      logger.debug(`Trakt using ${genres.length} combined genres`);
    } else {
      logger.warn(`Trakt no pre-fetched genres available for type: ${userCatalog.type}`);
    }

    const genreNames = genres.map(g => g.name);
    
    const genreOptions = userCatalog.showInHome ? genreNames : ['None', ...genreNames];
    
    // Use displayType if defined, otherwise use original type
    const catalogType = userCatalog.displayType || userCatalog.type;
    
    const catalog = {
      id: userCatalog.id,
      type: catalogType,
      name: userCatalog.name,
      pageSize: parseInt(process.env.CATALOG_LIST_ITEMS_SIZE) || 20,
      extra: [
        { name: "skip" },
      ],
      showInHome: userCatalog.showInHome
    };
    
    // Only add genre extra if genres are available
    if (genreOptions.length > 0) {
      catalog.extra.unshift({ 
        name: "genre", 
        options: genreOptions, 
        isRequired: userCatalog.showInHome ? false : true 
      });
    }
    
    logger.success(`Trakt catalog created successfully: ${catalog.id}`);
    return catalog;
  } catch (error) {
    logger.error(`Error creating Trakt catalog ${userCatalog.id}:`, error.message);
    return null; // Return null instead of throwing to prevent manifest failure
  }
}

async function createTMDBListCatalog(userCatalog, movieGenres = [], seriesGenres = []) {
  try {
    logger.info(`Creating TMDB List catalog: ${userCatalog.id} (${userCatalog.type})`);
    
    const catalogType = userCatalog.displayType || userCatalog.type;
    
    let genres = [];
    if (userCatalog.type === 'movie' && movieGenres.length > 0) {
      genres = movieGenres;
      logger.debug(`TMDB List using ${genres.length} movie genres`);
    } else if (userCatalog.type === 'series' && seriesGenres.length > 0) {
      genres = seriesGenres;
      logger.debug(`TMDB List using ${genres.length} series genres`);
    } else if (userCatalog.type === 'all') {
      const combined = [...movieGenres, ...seriesGenres];
      const uniqueGenres = [...new Set(combined)].sort();
      genres = uniqueGenres;
      logger.debug(`TMDB List using ${genres.length} combined genres`);
    }
    
    const genreOptions = genres.length > 0 
      ? (userCatalog.showInHome ? genres : ['None', ...genres])
      : ['None'];
    
    const catalog = {
      id: userCatalog.id,
      type: catalogType,
      name: userCatalog.name,
      pageSize: parseInt(process.env.CATALOG_LIST_ITEMS_SIZE) || 20,
      extra: [
        { name: "genre", options: genreOptions, isRequired: userCatalog.showInHome ? false : true },
        { name: "skip" },
      ],
      showInHome: userCatalog.showInHome
    };
    
    logger.success(`TMDB List catalog created successfully: ${catalog.id}`);
    return catalog;
  } catch (error) {
    logger.error(`Error creating TMDB List catalog ${userCatalog.id}:`, error.message);
    return null;
  }
}

async function createLetterboxdCatalog(userCatalog) {
  try {
    logger.info(`Creating Letterboxd catalog: ${userCatalog.id} (${userCatalog.type})`);
    
    // Use displayType if defined, otherwise use original type
    const catalogType = userCatalog.displayType || userCatalog.type;
    const genreNameById = {
      "8G":  "Action",
      "9k":  "Adventure",
      "8m":  "Animation",
      "7I":  "Comedy",
      "9Y":  "Crime",
      "ai":  "Documentary",
      "7S":  "Drama",
      "8w":  "Family",
      "82":  "Fantasy",
      "90":  "History",
      "aC":  "Horror",
      "b6":  "Music",
      "aW":  "Mystery",
      "8c":  "Romance",
      "9a":  "Science Fiction",
      "a8":  "Thriller",
      "1hO": "TV Movie",
      "9u":  "War",
      "8Q":  "Western",
    };
    let genreOptions = Object.values(genreNameById).sort((a, b) => a.localeCompare(b));
    genreOptions = userCatalog.showInHome ? genreOptions : ['None', ...genreOptions];
    const catalog = {
      id: userCatalog.id,
      type: catalogType,
      name: userCatalog.name,
      pageSize: parseInt(process.env.CATALOG_LIST_ITEMS_SIZE) || 20,
      extra: [
        { name: "genre", options: genreOptions, isRequired: userCatalog.showInHome ? false : true },
        { name: "skip" },
      ],
      showInHome: userCatalog.showInHome
    };
    
    logger.success(`Letterboxd catalog created successfully: ${catalog.id}`);
    return catalog;
  } catch (error) {
    logger.error(`Error creating Letterboxd catalog ${userCatalog.id}:`, error.message);
    return null; // Return null instead of throwing to prevent manifest failure
  }
}

async function createStremThruCatalog(userCatalog) {
  try {
    // Extract catalog info from the StremThru catalog ID
    // Format: stremthru.{manifestId}.{catalogId}
    const parts = userCatalog.id.split(".");
    if (parts.length < 3) {
      logger.warn(`Invalid StremThru catalog ID format: ${userCatalog.id}`);
      return null;
    }

    logger.info(`Creating StremThru catalog: ${userCatalog.id}`);
    
    const manifestId = parts[1];
    const catalogId = parts[2];
    
    // Get the catalog URL from the user catalog (try sourceUrl first, fallback to source)
    const catalogUrl = userCatalog.sourceUrl || userCatalog.source;
    if (!catalogUrl) {
      logger.warn(`No source URL found for catalog: ${userCatalog.id}`);
      return null;
    }
    
    // Get genres from multiple sources with fallback priority:
    // 1. userCatalog.genres (from manifest import)
    // 2. userCatalog.manifestData.extra (from original StremThru manifest)
    // 3. Fetch from catalog items (as last resort)
    let genres = [];
    
    if (userCatalog.genres && Array.isArray(userCatalog.genres) && userCatalog.genres.length > 0) {
      genres = userCatalog.genres;
    } else if (userCatalog.manifestData && userCatalog.manifestData.extra) {
      // Try to extract genres from the original manifest data
      const genreExtra = userCatalog.manifestData.extra.find(e => e.name === 'genre');
      if (genreExtra && genreExtra.options && Array.isArray(genreExtra.options) && genreExtra.options.length > 0) {
        genres = genreExtra.options;
      }
    }
    
    // If still no genres, try to fetch from catalog items
    if (genres.length === 0) {
      try {
        logger.debug(`Attempting to fetch genres from catalog items for ${userCatalog.id}`);
        // Wrap in cache to avoid repeated API calls on manifest generation
        genres = await cacheWrapStremThruGenres(catalogUrl, async () => {
          logger.debug(`Fetching fresh genres from StremThru catalog: ${catalogUrl}`);
          const items = await fetchStremThruCatalog(catalogUrl);
          if (items && items.length > 0) {
            const extractedGenres = await getGenresFromStremThruCatalog(items);
            logger.debug(`Extracted and cached ${extractedGenres.length} genres from catalog items`);
            return extractedGenres;
          }
          return [];
        });
        logger.debug(`Using ${genres.length} genres for ${userCatalog.id}`);
      } catch (genreError) {
        logger.warn(`Failed to fetch genres from catalog items for ${userCatalog.id}:`, genreError.message);
      }
    }
    
    // Final fallback
    if (genres.length === 0) {
      logger.warn(`No genres found for ${userCatalog.id}, using fallback`);
      genres = ['None']; // Single option for catalogs without genre support
    }
    
    // Add "None" option when showInHome is false to work around Stremio's genre requirement
    const genreOptions = userCatalog.showInHome ? genres : ['None', ...genres];
    
    // Use displayType if defined, otherwise use original type
    const catalogType = userCatalog.displayType || userCatalog.type;
    
    const catalog = {
      id: userCatalog.id,
      type: catalogType,
      name: userCatalog.name,
      pageSize: parseInt(process.env.CATALOG_LIST_ITEMS_SIZE) || 20,
      extra: [
        { name: "genre", options: genreOptions, isRequired: userCatalog.showInHome ? false : true },
        { name: "skip" },
      ],
      showInHome: userCatalog.showInHome
    };
    
    logger.success(`StremThru catalog created successfully: ${catalog.id}`);
    return catalog;
  } catch (error) {
    logger.error(`Error creating StremThru catalog ${userCatalog.id}:`, error.message);
    return null; // Return null instead of throwing to prevent manifest failure
  }
}

/**
 * Create an AniList catalog entry for the manifest
 * AniList catalogs are user's personal anime lists (Watching, Completed, etc.)
 */
function createAniListCatalog(userCatalog) {
  try {
    logger.info(`Creating AniList catalog: ${userCatalog.id} (${userCatalog.type})`);
    
    // Use displayType if defined, otherwise use original type (default to 'series' for anime)
    const catalogType = userCatalog.displayType || userCatalog.type || 'series';
    
    const catalog = {
      id: userCatalog.id,
      type: catalogType,
      name: userCatalog.name,
      pageSize: parseInt(process.env.CATALOG_LIST_ITEMS_SIZE) || 20,
      extra: [
        { name: "genre", options: ["None"], isRequired: userCatalog.showInHome ? false : true },
        { name: "skip" },
      ],
      showInHome: userCatalog.showInHome
    };
    
    logger.success(`AniList catalog created successfully: ${catalog.id}`);
    return catalog;
  } catch (error) {
    logger.error(`Error creating AniList catalog ${userCatalog.id}:`, error.message);
    return null;
  }
}

async function getManifest(config) {
  const startTime = Date.now();
  logger.start('Starting manifest generation...');
  
  // Generate manifest directly without caching to avoid cache key issues
  // The manifest is fast to generate and caching causes more problems than it solves
    const language = config.language || DEFAULT_LANGUAGE;
    const showPrefix = config.showPrefix === true;
    const provideImdbId = config.provideImdbId === "true";
    const sessionId = config.sessionId;
    const userCatalogs = config.catalogs || getDefaultCatalogs();
    const translatedCatalogs = loadTranslations(language);


  const enabledCatalogs = userCatalogs.filter(c => c.enabled);
  logger.info(`Total catalogs: ${userCatalogs.length}, Enabled: ${enabledCatalogs.length}`);
  logger.debug(`MDBList catalogs in enabled:`, enabledCatalogs.filter(c => c.id.startsWith('mdblist.')).map(c => c.id));
  logger.debug(`Custom catalogs in enabled:`, enabledCatalogs.filter(c => c.id.startsWith('custom.')).map(c => c.id));
  //logger.debug(`StremThru catalogs in enabled:`, enabledCatalogs.filter(c => c.id.startsWith('stremthru.')).map(c => c.id));
  
  const years = generateArrayOfYears(new Date().getFullYear() - 1900);
  
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
  logger.debug(`Genre lists and languages fetched in ${Date.now() - genreStart}ms`);
  
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
      logger.info('[Cache Miss] Fetching fresh anime genre list in manifest from Jikan...');
      return await jikan.getAnimeGenres();
    });
    animeGenreNames = animeGenres.filter(Boolean).map(genre => genre.name).sort();
    logger.debug(`Anime genres fetched in ${Date.now() - animeStart}ms`);
    
    // Only fetch studios if we have a studio catalog - but don't block manifest generation
    const hasStudioCatalog = enabledCatalogs.some(cat => cat.id === 'mal.studios');
    if (hasStudioCatalog) {
      try {
        // Try to get cached studios first, don't block if not available
        const studioPromise = cacheWrapJikanApi('mal-studios', async () => {
          logger.debug('[Cache Miss] Fetching fresh anime studio list in manifest from Jikan...');
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
        logger.success(`Studio list fetched successfully (${studioNames.length} studios)`);
      } catch (error) {
        logger.warn('Studio list fetch failed, using empty list:', error.message);
        studioNames = []; // Fallback to empty list
      }
    }

    // Fetch available seasons if we have a seasons catalog
    const hasSeasonsCatalog = enabledCatalogs.some(cat => cat.id === 'mal.seasons');
    if (hasSeasonsCatalog) {
      try {
        const seasonsData = await cacheWrapJikanApi('mal-available-seasons', async () => {
          logger.debug('[Cache Miss] Fetching available seasons from Jikan...');
          return await jikan.getAvailableSeasons();
        }, 7 * 24 * 60 * 60); // Cache for 7 days (seasons only change quarterly)
        
        // Build season options from API data
        const seasonOptions = [];
        const seasons = ['Winter', 'Spring', 'Summer', 'Fall'];
        
        for (const yearData of seasonsData) {
          const availableSeasons = yearData.seasons || [];
          for (const season of availableSeasons) {
            const capitalizedSeason = season.charAt(0).toUpperCase() + season.slice(1);
            seasonOptions.push(`${capitalizedSeason} ${yearData.year}`);
          }
        }
        
        // Store for later use
        global.availableSeasons = seasonOptions;
        logger.debug(`Available seasons fetched successfully (${seasonOptions.length} seasons)`);
      } catch (error) {
        logger.warn('Available seasons fetch failed, will use fallback:', error.message);
        global.availableSeasons = null;
      }
    }
  }
  
  const genres_movie_names = genres_movie.map(g => g.name).sort();
  const genres_series_names = genres_series.map(g => g.name).sort();
  const genres_tvdb_all_names = genres_tvdb_all.map(g => g.name).sort();
  const filterLanguages = setOrderLanguage(language, languagesArray);
  const isMDBList = (id) => id.startsWith("mdblist.");
  const isTrakt = (id) => id.startsWith("trakt.");
  const options = { years, genres_movie: genres_movie_names, genres_series: genres_series_names, filterLanguages };

  // Pre-fetch MDBList genres once to avoid repeated API calls
  let mdblistGenresStandard = [];
  let mdblistGenresAnime = [];
  if (enabledCatalogs.some(c => c.id.startsWith('mdblist.'))) {
    logger.debug('Pre-fetching MDBList genres for all catalogs...');
    try {
      [mdblistGenresStandard, mdblistGenresAnime] = await Promise.all([
        fetchMDBListGenres(config.apiKeys?.mdblist, false),
        fetchMDBListGenres(config.apiKeys?.mdblist, true)
      ]);
      logger.success(`Pre-fetched ${mdblistGenresStandard.length} standard genres and ${mdblistGenresAnime.length} anime genres`);
    } catch (error) {
      logger.warn('Failed to pre-fetch MDBList genres, will use fallback:', error.message);
    }
  }

  // Pre-fetch Trakt genres once to avoid repeated API calls
  let traktGenresMovies = [];
  let traktGenresShows = [];
  if (enabledCatalogs.some(c => c.id.startsWith('trakt.'))) {
    logger.debug('Pre-fetching Trakt genres for all catalogs...');
    try {
      [traktGenresMovies, traktGenresShows] = await Promise.all([
        fetchTraktGenres('movies'),
        fetchTraktGenres('shows')
      ]);
      logger.success(`Pre-fetched ${traktGenresMovies.length} movie genres and ${traktGenresShows.length} show genres from Trakt`);
    } catch (error) {
      logger.warn('Failed to pre-fetch Trakt genres, catalogs will have no genres:', error.message);
    }
  }

  let catalogs = await Promise.all(enabledCatalogs
    .filter(userCatalog => {
      const catalogDef = getCatalogDefinition(userCatalog.id);
      if (isMDBList(userCatalog.id)) {
        return true;
      }
      if (isTrakt(userCatalog.id)) {
        return true;
      }
      if (userCatalog.id.startsWith('tmdb.list.')) {
        return true;
      }
      if (userCatalog.id.startsWith('stremthru.')) {
        return true;
      }
      if (userCatalog.id.startsWith('custom.')) {
        return true;
      }
      if (userCatalog.id.startsWith('anilist.')) {
        return true;
      }
      if (userCatalog.id.startsWith('letterboxd.')) {
        return true;
      }
      if (!catalogDef) {
        logger.debug(`Catalog ${userCatalog.id} failed filter: no catalog definition`);
        return false;
      }
      // Don't filter out auth catalogs - show them in manifest even without session
      // They will fail at the catalog route level if not authenticated, which is expected
      return true;
    })
    .map(async (userCatalog) => {
      if (isMDBList(userCatalog.id)) {
          logger.debug(`Processing MDBList catalog: ${userCatalog.id}`);
          const result = await createMDBListCatalog(userCatalog, config.apiKeys?.mdblist, mdblistGenresStandard, mdblistGenresAnime);
          logger.debug(`MDBList catalog result:`, result ? 'success' : 'failed');
          return result;
      }
      if (isTrakt(userCatalog.id)) {
          logger.debug(`Processing Trakt catalog: ${userCatalog.id}`);
          const result = await createTraktCatalog(userCatalog, traktGenresMovies, traktGenresShows);
          logger.debug(`Trakt catalog result:`, result ? 'success' : 'failed');
          return result;
      }
      if (userCatalog.id.startsWith('tmdb.list.')) {
          logger.debug(`Processing TMDB List catalog: ${userCatalog.id}`);
          const result = await createTMDBListCatalog(userCatalog, genres_movie_names, genres_series_names);
          logger.debug(`TMDB List catalog result:`, result ? 'success' : 'failed');
          return result;
      }
      if (userCatalog.id.startsWith('stremthru.')) {
          const result = await createStremThruCatalog(userCatalog);
          return result;
      }
      if (userCatalog.id.startsWith('custom.')) {
          logger.debug(`Processing Custom catalog: ${userCatalog.id}`);
          const result = await createStremThruCatalog(userCatalog);
          logger.debug(`Custom catalog result:`, result ? 'success' : 'failed');
          return result;
      }
      if (userCatalog.id.startsWith('anilist.')) {
          logger.debug(`Processing AniList catalog: ${userCatalog.id}`);
          const result = createAniListCatalog(userCatalog);
          logger.debug(`AniList catalog result:`, result ? 'success' : 'failed');
          return result;
      }
      if (userCatalog.id.startsWith('letterboxd.')) {
          logger.debug(`Processing Letterboxd catalog: ${userCatalog.id}`);
          const result = await createLetterboxdCatalog(userCatalog);
          logger.debug(`Letterboxd catalog result:`, result ? 'success' : 'failed');
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
          userCatalog.name,
          userCatalog.displayType
        );
      }
      else if (userCatalog.id === 'mal.genres') {
          // Use pre-fetched anime genres
          // Add "None" option when showInHome is false to work around Stremio's genre requirement
          catalogOptions = animeGenreNames;
      } else if (userCatalog.id === 'mal.studios'){
        // Use pre-fetched studio names, fallback to empty if not available
        catalogOptions = studioNames.length > 0 ? studioNames : ['None'];
      }
      else if (userCatalog.id === 'mal.schedule') {
        catalogOptions = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      }
      else if (userCatalog.id === 'tvmaze.schedule') {
        const countries = ['US', 'CA', 'GB', 'AU', 'DE', 'FR', 'ES', 'BR'];
        catalogOptions = userCatalog.showInHome ? countries : ['None', ...countries];
      }
      else if (userCatalog.id === 'mal.seasons') {
        // Use fetched available seasons from API, or fallback to generated list
        if (global.availableSeasons && global.availableSeasons.length > 0) {
          catalogOptions = global.availableSeasons;
        } else {
          // Fallback: Generate season options from Winter 2000 to current season
          const seasons = ['Winter', 'Spring', 'Summer', 'Fall'];
          const currentDate = new Date();
          const currentYear = currentDate.getFullYear();
          const currentMonth = currentDate.getMonth(); // 0-11
          
          // Determine current season based on month
          let currentSeasonIndex;
          if (currentMonth <= 2) currentSeasonIndex = 0; // Winter (Jan-Mar)
          else if (currentMonth <= 5) currentSeasonIndex = 1; // Spring (Apr-Jun)
          else if (currentMonth <= 8) currentSeasonIndex = 2; // Summer (Jul-Sep)
          else currentSeasonIndex = 3; // Fall (Oct-Dec)
          
          const seasonOptions = [];
          
          // Generate from current season down to Winter 2000
          for (let year = currentYear; year >= 2000; year--) {
            const maxSeasonIndex = (year === currentYear) ? currentSeasonIndex : 3;
            for (let s = maxSeasonIndex; s >= 0; s--) {
              seasonOptions.push(`${seasons[s]} ${year}`);
            }
          }
          
          catalogOptions = seasonOptions;
        }
      } 
      else if (userCatalog.id === 'mal.airing' || userCatalog.id === 'mal.upcoming' || 
               userCatalog.id === 'mal.top_movies' || userCatalog.id === 'mal.top_series' || 
               userCatalog.id === 'mal.most_favorites' || userCatalog.id === 'mal.most_popular' || 
               userCatalog.id === 'mal.top_anime') {
        // Provide "None" option to work around Stremio's genre requirement
        catalogOptions = ['None'];
      }
      else if (userCatalog.id.startsWith('mal.') && !['mal.airing', 'mal.upcoming', 'mal.schedule', 'mal.seasons', 'mal.top_movies', 'mal.top_series', 'mal.most_favorites', 'mal.top_anime', 'mal.most_popular'].includes(userCatalog.id)) {
        // Use pre-fetched anime genres for decade catalogs
        // Add "None" option when showInHome is false to work around Stremio's genre requirement
        catalogOptions = userCatalog.showInHome ? animeGenreNames : ['None', ...animeGenreNames];
      }
      else {
        catalogOptions = getOptionsForCatalog(catalogDef, userCatalog.type, userCatalog.showInHome, options);
        if ((userCatalog.id.startsWith('streaming.') || userCatalog.id.startsWith('tmdb.top') || userCatalog.id.startsWith('tmdb.top_rated') || userCatalog.id.startsWith('tmdb.airing_today')) && userCatalog.showInHome === false) {
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
          userCatalog.name,
          userCatalog.displayType
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
  const searchNames = config.search?.searchNames || {};
  // Backward compatibility: support old providerNames format
  const legacyProviderNames = config.search?.providerNames || {};
  const searchOrder = config.search?.searchOrder || ['movie', 'series', 'tvdb.collections.search', 'anime_series', 'anime_movie'];
  
  // Helper function to get default search name
  const getDefaultSearchName = (searchId) => {
    const searchNameMap = {
      'movie': 'Movies Search',
      'series': 'Series Search',
      'anime_series': 'Anime Series Search',
      'anime_movie': 'Anime Movies Search',
      'tvdb.collections.search': 'TVDB Collections',
      'gemini.search': 'AI Search',
      'people_search_movie': 'People Search',
      'people_search_series': 'People Search',
    };
    return searchNameMap[searchId] || searchId;
  };

  // Helper function to get search catalog name (handles custom names vs default names)
  const getSearchCatalogName = (searchId, prefix = '', suffix = 'Search') => {
    const customName = searchNames[searchId];
    if (customName) {
      // If custom name is provided, use it as-is (no suffix)
      return `${prefix}${customName}`;
    }
    
    let legacyName = null;
    if (searchId === 'movie' && legacyProviderNames[searchProviders.movie]) {
      legacyName = legacyProviderNames[searchProviders.movie];
    } else if (searchId === 'series' && legacyProviderNames[searchProviders.series]) {
      legacyName = legacyProviderNames[searchProviders.series];
    } else if (searchId === 'anime_series' && legacyProviderNames[searchProviders.anime_series]) {
      legacyName = legacyProviderNames[searchProviders.anime_series];
    } else if (searchId === 'anime_movie' && legacyProviderNames[searchProviders.anime_movie]) {
      legacyName = legacyProviderNames[searchProviders.anime_movie];
    } else if (searchId === 'tvdb.collections.search' && legacyProviderNames['tvdb.collections.search']) {
      legacyName = legacyProviderNames['tvdb.collections.search'];
    } else if (searchId === 'gemini.search' && legacyProviderNames['gemini.search']) {
      legacyName = legacyProviderNames['gemini.search'];
    }
    
    if (legacyName) {
      return `${prefix}${legacyName}`;
    }
    
    // Fallback to default search name
    return `${prefix}${getDefaultSearchName(searchId)}`;
  };

  if (isSearchEnabled) {
    const prefix = showPrefix ? "AIOMetadata - " : "";
    
    // Generate search catalogs in the specified order
    const searchCatalogConfigs = [
      {
        id: 'movie',
        type: 'movie',
        provider: searchProviders.movie,
        enabled: engineEnabled[searchProviders.movie] !== false,
        suffix: 'Search'
      },
      {
        id: 'series',
        type: 'series',
        provider: searchProviders.series,
        enabled: engineEnabled[searchProviders.series] !== false,
        suffix: 'Search'
      },
      {
        id: 'tvdb.collections.search',
        type: 'collection',
        provider: 'tvdb.collections.search',
        enabled: engineEnabled['tvdb.collections.search'] !== false,
        suffix: 'Collections'
      },
      {
        id: 'anime_series',
        type: 'anime.series',
        provider: searchProviders.anime_series,
        enabled: engineEnabled[searchProviders.anime_series] !== false,
        suffix: 'Anime Search'
      },
      {
        id: 'anime_movie',
        type: 'anime.movie',
        provider: searchProviders.anime_movie,
        enabled: engineEnabled[searchProviders.anime_movie] !== false,
        suffix: 'Anime Search'
      },
      {
        id: 'people_search_movie',
        type: 'movie',
        provider: config.search?.providers?.people_search_movie || 'tmdb.people.search',
        enabled: engineEnabled[config.search?.providers?.people_search_movie || 'tmdb.people.search'] !== false,
        suffix: 'People Search'
      },
      {
        id: 'people_search_series',
        type: 'series',
        provider: config.search?.providers?.people_search_series || 'tmdb.people.search',
        enabled: engineEnabled[config.search?.providers?.people_search_series || 'tmdb.people.search'] !== false,
        suffix: 'People Search'
      },
      {
        id: 'gemini.search',
        type: 'other',
        provider: 'gemini.search',
        enabled: engineEnabled['gemini.search'] !== false && config.search?.ai_enabled === true && !!config.apiKeys?.gemini,
        suffix: 'AI Search'
      }
    ];
    
    // Sort by searchOrder and add enabled catalogs
    searchCatalogConfigs
      .sort((a, b) => {
        const aIndex = searchOrder.indexOf(a.id);
        const bIndex = searchOrder.indexOf(b.id);
        return aIndex - bIndex;
      })
      .filter(config => config.enabled)
      .forEach(config => {
        // Use provider id as the catalog id (e.g., 'tmdb.search' or 'gemini.search')
        const catalogId = config.provider === 'gemini.search' 
          ? 'gemini.search' 
          : (config.id === 'people_search_movie' || config.id === 'people_search_series')
            ? 'people_search'
            : "search";
        catalogs.push({
          id: catalogId,
          type: config.type,
          name: getSearchCatalogName(config.id, prefix, config.suffix),
          extra: [{ name: 'search', isRequired: true }]
        });
      });
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

  // No separate addition for gemini.search here — the provider will be added in the searchCatalogConfigs loop above

  const activeConfigs = [
    `Language: ${language}`,
    `TMDB Account: ${sessionId ? 'Connected' : 'Not Connected'}`,
    `MDBList Integration: ${config.apiKeys?.mdblist ? 'Connected' : 'Not Connected'}`,
    `IMDb Integration: ${provideImdbId ? 'Enabled' : 'Disabled'}`,
    `RPDB Integration: ${config.apiKeys?.rpdb } ? 'Enabled' : 'Disabled'}`,
    `Search: ${config.searchEnabled !== "false" ? 'Enabled' : 'Disabled'}`,
    `Active Catalogs: ${catalogs.length}`
  ].join(' | ');
  

  // Support custom name suffix (e.g., "| ElfHosted")
  const nameSuffix = process.env.ADDON_NAME_SUFFIX || "";
  const addonName = nameSuffix ? `AIOMetadata ${nameSuffix}` : "AIOMetadata";

  // Build resources array - exclude "meta" if catalogModeOnly is enabled
  const resources = ["catalog"];
  if (!config.catalogModeOnly) {
    resources.push("meta");
  }
  // Add subtitles resource for watch tracking
  resources.push("subtitles");
  // Add stream resource for rating page
  if(config.showRateMeButton) {
    resources.push("stream");
  }
  
  const manifest = {
    id: packageJson.name,
    version: packageJson.version,
    logo: manifestLogoUrl,
    background: `${host}/background.png`,
    name: addonName,
    description: "A metadata addon for power users. AIOMetadata uses TMDB, TVDB, TVMaze, MyAnimeList, IMDB and Fanart.tv to provide accurate data for movies, series, and anime. You choose the source.",
    resources,
    types: ["movie", "series", "anime.movie", "anime.series", "anime", "Trakt", "collection"],
    idPrefixes: ["tmdb:", "tt", "tvdb:", "mal:", "tvmaze:", "kitsu:", "anidb:", "anilist:", "tvdbc:", "upnext_", "unwatched_", "mdblist_upnext_"],
    stremioAddonsConfig: {
      "issuer": "https://stremio-addons.net",
      "signature": "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..3_iKJ-pKhR-LclfTPxvyag.uY747PgjymdL0OMdZrE7HTOVG-8nNWC-LrlJ5tCXm2i2FioXv_ismzWV0_XsLl0Me9cW9D3xog6d4tSHDY8Pe27mbIylUb61MS4VVqg_sFZXUVon2le-fRFrtmMnIqCF.oyYRDftPN2sohMpDMbMbYg"
    },  
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
    catalogs,
  };
  
  const endTime = Date.now();
  logger.success(`Manifest generation completed in ${endTime - startTime}ms`);
  
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
