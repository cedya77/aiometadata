const fs = require('fs').promises;
const path = require('path');
const { httpGet, httpHead } = require('../utils/httpClient');
const redis = require('./redisClient');
const kitsu = require('./kitsu');
const { LRUCache } = require('lru-cache');
const consola = require('consola');


const logger = consola.withTag('ID-Mapper');

function parsePositiveIntEnv(envValue, defaultValue, minValue = 1, maxValue = 100000) {
  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed < minValue) {
    return defaultValue;
  }
  return Math.min(parsed, maxValue);
}

// from  https://github.com/Fribb/anime-lists
const REMOTE_MAPPING_URL ='https://raw.githubusercontent.com/Fribb/anime-lists/refs/heads/master/anime-list-full.json';
const REMOTE_KITSU_TO_IMDB_MAPPING_URL = 'https://raw.githubusercontent.com/TheBeastLT/stremio-kitsu-anime/bbf149474f610885629b95b1b9ce4408c3c1353d/static/data/imdb_mapping.json';
const REMOTE_TRAKT_ANIME_MOVIES_URL = 'https://github.com/rensetsu/db.trakt.extended-anitrakt/releases/download/latest/movies_ex.json';
const LOCAL_CACHE_PATH = path.join(process.cwd(), 'addon', 'data', 'anime-list-full.json.cache');
const LOCAL_KITSU_TO_IMDB_MAPPING_PATH = path.join(process.cwd(), 'addon', 'data', 'imdb_mapping.json.cache');
const LOCAL_TRAKT_ANIME_MOVIES_PATH = path.join(process.cwd(), 'addon', 'data', 'trakt-anime-movies.json.cache');
const REDIS_ETAG_KEY = 'anime-list-etag'; 
const REDIS_KITSU_TO_IMDB_ETAG_KEY = 'kitsu-to-imdb-etag';
const REDIS_TRAKT_ANIME_MOVIES_ETAG_KEY = 'trakt-anime-movies-etag';
const UPDATE_INTERVAL_HOURS = parsePositiveIntEnv(process.env.ANIME_LIST_UPDATE_INTERVAL_HOURS, 24); // Update every 24 hours (configurable)
const UPDATE_INTERVAL_KITSU_TO_IMDB_HOURS = parsePositiveIntEnv(process.env.KITSU_TO_IMDB_UPDATE_INTERVAL_HOURS, 24); // Update every 24 hours (configurable)
const UPDATE_INTERVAL_TRAKT_ANIME_MOVIES_HOURS = parsePositiveIntEnv(process.env.TRAKT_ANIME_MOVIES_UPDATE_INTERVAL_HOURS, 24); // Update every 24 hours (configurable)
const FRANCHISE_MAP_CACHE_MAX_SIZE = parsePositiveIntEnv(
  process.env.ID_MAPPER_FRANCHISE_MAP_CACHE_MAX_SIZE,
  20000,
  100
);
const TMDB_FRANCHISE_INFO_CACHE_MAX_SIZE = parsePositiveIntEnv(
  process.env.ID_MAPPER_TMDB_FRANCHISE_INFO_CACHE_MAX_SIZE,
  3000,
  100
);
const TMDB_SEASON_CACHE_MAX_SIZE = parsePositiveIntEnv(
  process.env.ID_MAPPER_TMDB_SEASON_CACHE_MAX_SIZE,
  15000,
  100
);
const KITSU_TO_IMDB_CACHE_MAX_SIZE = parsePositiveIntEnv(
  process.env.ID_MAPPER_KITSU_TO_IMDB_CACHE_MAX_SIZE,
  20000,
  100
);

let animeIdMap = new Map();
let tvdbIdToAnimeListMap = new Map();
let isInitialized = false;
let tvdbIdMap = new Map();
const franchiseMapCache = new LRUCache({ max: FRANCHISE_MAP_CACHE_MAX_SIZE });
const tmdbFranchiseInfoCache = new LRUCache({ max: TMDB_FRANCHISE_INFO_CACHE_MAX_SIZE });
const tmdbSeasonCache = new LRUCache({ max: TMDB_SEASON_CACHE_MAX_SIZE });

// Auxiliary index maps for O(1) lookups (instead of O(N) Array.from().find())
let kitsuIdMap = new Map();
let anidbIdMap = new Map();
let anilistIdMap = new Map();
let imdbIdMap = new Map();
let simklIdMap = new Map();

async function getTmdbSeasonInfo(tmdbId, config = {}) {
  if (tmdbSeasonCache.has(tmdbId)) {
    return tmdbSeasonCache.get(tmdbId);
  }
  const { tvInfo } = require('./getTmdb.js');

  // Pass config to tvInfo so it can use the user's TMDB API key
  const showInfo = await tvInfo({ id: tmdbId }, config);
  
  if (showInfo && showInfo.seasons) {
    // Sort seasons by season number to ensure correct order
    const sortedSeasons = showInfo.seasons.sort((a, b) => a.season_number - b.season_number);
    tmdbSeasonCache.set(tmdbId, sortedSeasons);
    return sortedSeasons;
  }

  return [];
}

let tmdbIndexArray; 
const kitsuToImdbCache = new LRUCache({ max: KITSU_TO_IMDB_CACHE_MAX_SIZE });
let imdbIdToAnimeListMap = new Map();
let updateInterval = null;
let kitsuToImdbMapping = null;
let kitsuToImdbMappingCount = 0; // Pre-computed count for O(1) stats access
let isKitsuToImdbInitialized = false;
let traktAnimeMovies = null;
let isTraktAnimeMoviesInitialized = false;
let malIdToTraktMovieMap = new Map();
let tmdbIdToTraktMovieMap = new Map();
let imdbIdToTraktMovieMap = new Map();


function processAndIndexData(data) {
  let animeList;
  
  if (Array.isArray(data)) {
    // It's already an array, use it directly
    animeList = data;
  } else if (typeof data === 'string') {
    try {
      // First parse attempt
      const parsed = JSON.parse(data);
      
      if (Array.isArray(parsed)) {
        animeList = parsed;
      } else if (typeof parsed === 'string') {
        // Handle double-encoded string case
        try {
          const doubleParsed = JSON.parse(parsed);
          if (Array.isArray(doubleParsed)) {
            animeList = doubleParsed;
          }
        } catch (e) {
          // Ignore second parse error
        }
      }
    } catch (e) {
      throw new Error(`Failed to parse anime list JSON: ${e.message}`);
    }
  }

  if (!animeList || !Array.isArray(animeList)) {
    throw new Error(`Anime list expected to be an array, got ${typeof animeList}`);
  }

  animeIdMap.clear();
  tvdbIdMap.clear();
  tvdbIdToAnimeListMap.clear();
  imdbIdToAnimeListMap.clear();
  
  // Clear auxiliary index maps
  kitsuIdMap.clear();
  anidbIdMap.clear();
  anilistIdMap.clear();
  imdbIdMap.clear();
  simklIdMap.clear();
  
  for (const item of animeList) {
    if (item.mal_id) {
      animeIdMap.set(item.mal_id, item);
    }
    
    // Build auxiliary indices for O(1) lookups
    if (item.kitsu_id) kitsuIdMap.set(item.kitsu_id, item);
    if (item.anidb_id) anidbIdMap.set(item.anidb_id, item);
    if (item.anilist_id) anilistIdMap.set(item.anilist_id, item);
    if (item.imdb_id) imdbIdMap.set(item.imdb_id, item);
    if (item.simkl_id) simklIdMap.set(item.simkl_id, item);
    
    if (item.tvdb_id) {
      const tvdbId = item.tvdb_id;
      // If we haven't seen this TVDB ID before, create a new array for it
      if (!tvdbIdToAnimeListMap.has(tvdbId)) {
        tvdbIdToAnimeListMap.set(tvdbId, []);
      }
      tvdbIdToAnimeListMap.get(tvdbId).push(item);
    }
    if (item.imdb_id) {
      const imdbId = item.imdb_id;
      if (!imdbIdToAnimeListMap.has(imdbId)) {
        imdbIdToAnimeListMap.set(imdbId, []);
      }
      imdbIdToAnimeListMap.get(imdbId).push(item);
    }
  }
  tmdbIndexArray = animeList.filter(item => item.themoviedb_id);
  isInitialized = true;
  logger.info(`Successfully loaded and indexed ${animeIdMap.size} anime mappings.`);
}

/**
 * Downloads and processes the anime mapping file.
 * It uses Redis and ETags to check if the remote file has changed,
 * avoiding a full download if the local cache is up-to-date.
 * @param {boolean} force - If true, bypass ETag check and force re-download
 */
async function downloadAndProcessAnimeList(force = false) {
  const useRedisCache = redis; 

  try {
    if (useRedisCache && !force) {
      const savedEtag = await redis.get(REDIS_ETAG_KEY);
      const headers = (await httpHead(REMOTE_MAPPING_URL)).headers;
      const remoteEtag = headers.etag;

      logger.debug(`[ID Mapper] [Fribb\'s Anime-List] Saved ETag: ${savedEtag} | Remote ETag: ${remoteEtag}`);

      if (savedEtag && remoteEtag && savedEtag === remoteEtag) {
        try {
          logger.debug('[ID Mapper] [Fribb\'s Anime-List] No changes detected. Loading from local disk cache...');
          const fileContent = await fs.readFile(LOCAL_CACHE_PATH, 'utf-8');
          processAndIndexData(fileContent);
          // Update last check timestamp even when using cache
          if (useRedisCache) {
            await redis.set('maintenance:last_id_mapper_update', Date.now().toString());
          }
          return { success: true, message: 'Loaded from cache (no changes)', count: animeIdMap.size };
        } catch (e) {
          logger.warn('[ID Mapper] [Fribb\'s Anime-List] ETag matched, but local cache was unreadable. Forcing re-download.');
        }
      }
    } else if (force) {
      logger.debug('[ID Mapper] [Fribb\'s Anime-List] Force update requested. Bypassing ETag check.');
    } else {
      logger.debug('[ID Mapper] [Fribb\'s Anime-List] Redis cache is disabled. Proceeding to download.');
    }

    logger.debug('[ID Mapper] [Fribb\'s Anime-List] Downloading full list...');
    const response = await httpGet(REMOTE_MAPPING_URL);
    let dataToCache;
    let dataForProcessing;

    if (typeof response.data === 'string') {
        // It came back as a string (likely text/plain header)
        dataToCache = response.data;
        // Verify it's valid JSON before caching
        try {
             dataForProcessing = JSON.parse(response.data);
        } catch (e) {
             throw new Error("Invalid JSON received from remote");
        }
    } else {
        // It came back as an object/array (application/json header)
        dataForProcessing = response.data;
        dataToCache = JSON.stringify(response.data);
    }

    
    await fs.mkdir(path.dirname(LOCAL_CACHE_PATH), { recursive: true });
    await fs.writeFile(LOCAL_CACHE_PATH, dataToCache, 'utf-8');
    
    if (useRedisCache) {
      await redis.set(REDIS_ETAG_KEY, response.headers.etag);
      // Write maintenance timestamp
      await redis.set('maintenance:last_id_mapper_update', Date.now().toString());
    }
    
    processAndIndexData(dataForProcessing);
    return { success: true, message: 'Downloaded and updated', count: animeIdMap.size };

  } catch (error) {
    logger.error(`[ID Mapper] [Fribb\'s Anime-List] An error occurred during remote download: ${error.message}`);
    logger.debug('[ID Mapper] Attempting to fall back to local disk cache...');
    
    try {
      const fileContent = await fs.readFile(LOCAL_CACHE_PATH, 'utf-8');
      logger.debug('[ID Mapper] [Fribb\'s Anime-List] Successfully loaded data from local cache on fallback.');
      processAndIndexData(fileContent); 
      return { success: true, message: 'Loaded from local cache (fallback)', count: animeIdMap.size };
    } catch (fallbackError) {
      logger.error('[ID Mapper] [Fribb\'s Anime-List] CRITICAL: Fallback to local cache also failed. Mapper will be empty.');
      return { success: false, message: `Failed to update: ${error.message}`, count: 0 };
    }
  }
}

/**
 * Downloads and processes the Trakt anime movies mapping file.
 * It uses Redis and ETags to check if the remote file has changed,
 * avoiding a full download if the local cache is up-to-date.
 */
async function downloadAndProcessTraktAnimeMovies() {
  const useRedisCache = redis; 

  try {
    if (useRedisCache) {
      const savedEtag = await redis.get(REDIS_TRAKT_ANIME_MOVIES_ETAG_KEY);
      const headers = (await httpHead(REMOTE_TRAKT_ANIME_MOVIES_URL)).headers;
      const remoteEtag = headers.etag;

      logger.debug(`[ID Mapper] [Trakt-Anime-Movies] Saved ETag: ${savedEtag} | Remote ETag: ${remoteEtag}`);

      if (savedEtag && remoteEtag && savedEtag === remoteEtag) {
        try {
          logger.debug('[ID Mapper] [Trakt-Anime-Movies] No changes detected. Loading from local disk cache...');
          const fileContent = await fs.readFile(LOCAL_TRAKT_ANIME_MOVIES_PATH, 'utf-8');
          let parsed = JSON.parse(fileContent);
          // Handle double-encoded JSON (backwards compatibility with existing cache files)
          traktAnimeMovies = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
          processAndIndexTraktAnimeMovies(traktAnimeMovies);
          isTraktAnimeMoviesInitialized = true;
          logger.debug(`[ID Mapper] [Trakt-Anime-Movies] Successfully loaded ${traktAnimeMovies.length} mappings from local cache.`);
          return;
        } catch (e) {
          logger.warn('[ID Mapper] [Trakt-Anime-Movies] ETag matched, but local cache was unreadable. Forcing re-download.');
        }
      }
    } else {
      logger.debug('[ID Mapper] [Trakt-Anime-Movies] Redis cache is disabled. Proceeding to download.');
    }

    logger.debug('[ID Mapper] [Trakt-Anime-Movies] Downloading Trakt anime movies mapping...');
    const response = await httpGet(REMOTE_TRAKT_ANIME_MOVIES_URL);
    // GitHub raw returns text/plain, so response.data may be a string; parse if needed
    traktAnimeMovies = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    const jsonData = JSON.stringify(traktAnimeMovies);

    await fs.mkdir(path.dirname(LOCAL_TRAKT_ANIME_MOVIES_PATH), { recursive: true });
    await fs.writeFile(LOCAL_TRAKT_ANIME_MOVIES_PATH, jsonData, 'utf-8');
    
    if (useRedisCache) {
      await redis.set(REDIS_TRAKT_ANIME_MOVIES_ETAG_KEY, response.headers.etag);
    }
    
    processAndIndexTraktAnimeMovies(traktAnimeMovies);
    isTraktAnimeMoviesInitialized = true;
    logger.debug(`[ID Mapper] [Trakt-Anime-Movies] Successfully loaded ${traktAnimeMovies.length} mappings.`);

  } catch (error) {
    logger.error(`[ID Mapper] [Trakt-Anime-Movies] An error occurred during remote download: ${error.message}`);
    logger.debug('[ID Mapper] [Trakt-Anime-Movies] Attempting to fall back to local disk cache...');
    
    try {
      const fileContent = await fs.readFile(LOCAL_TRAKT_ANIME_MOVIES_PATH, 'utf-8');
      let parsed = JSON.parse(fileContent);
      // Handle double-encoded JSON (backwards compatibility with existing cache files)
      traktAnimeMovies = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
      processAndIndexTraktAnimeMovies(traktAnimeMovies);
      isTraktAnimeMoviesInitialized = true;
      logger.debug('[ID Mapper] [Trakt-Anime-Movies] Successfully loaded data from local cache on fallback.');
    } catch (fallbackError) {
      logger.error('[ID Mapper] [Trakt-Anime-Movies] CRITICAL: Fallback to local cache also failed. Trakt anime movies mapping will be empty.');
      traktAnimeMovies = [];
      isTraktAnimeMoviesInitialized = true;
    }
  }
}

/**
 * Processes and indexes the Trakt anime movies mapping for fast lookups.
 */
function processAndIndexTraktAnimeMovies(moviesArray) {
  malIdToTraktMovieMap.clear();
  tmdbIdToTraktMovieMap.clear();
  imdbIdToTraktMovieMap.clear();
  
  for (const movie of moviesArray) {
    if (movie.myanimelist?.id) {
      malIdToTraktMovieMap.set(movie.myanimelist.id, movie);
    }
    if (movie.externals?.tmdb) {
      tmdbIdToTraktMovieMap.set(movie.externals.tmdb, movie);
    }
    if (movie.externals?.imdb) {
      imdbIdToTraktMovieMap.set(movie.externals.imdb, movie);
    }
  }
  
  logger.debug(`[ID Mapper] [Trakt-Anime-Movies] Indexed ${malIdToTraktMovieMap.size} MAL, ${tmdbIdToTraktMovieMap.size} TMDB, ${imdbIdToTraktMovieMap.size} IMDB mappings.`);
}

/**
 * Downloads and processes the Kitsu to IMDB mapping file.
 * It uses Redis and ETags to check if the remote file has changed,
 * avoiding a full download if the local cache is up-to-date.
 * @param {boolean} force - If true, bypass ETag check and force re-download
 */
async function downloadAndProcessKitsuToImdbMapping(force = false) {
  const useRedisCache = redis; 

  try {
    if (useRedisCache && !force) {
      const savedEtag = await redis.get(REDIS_KITSU_TO_IMDB_ETAG_KEY);
      const headers = (await httpHead(REMOTE_KITSU_TO_IMDB_MAPPING_URL)).headers;
      const remoteEtag = headers.etag;

      logger.debug(`[ID Mapper] [Kitsu-IMDB] Saved ETag: ${savedEtag} | Remote ETag: ${remoteEtag}`);

      if (savedEtag && remoteEtag && savedEtag === remoteEtag) {
        try {
          logger.debug('[ID Mapper] [Kitsu-IMDB] No changes detected. Loading from local disk cache...');
          const fileContent = await fs.readFile(LOCAL_KITSU_TO_IMDB_MAPPING_PATH, 'utf-8');
          kitsuToImdbMapping = JSON.parse(fileContent);
          kitsuToImdbMappingCount = Object.keys(kitsuToImdbMapping).length;
          isKitsuToImdbInitialized = true;
          // Update last check timestamp even when using cache
          if (useRedisCache) {
            await redis.set('maintenance:last_kitsu_imdb_update', Date.now().toString());
          }
          logger.debug(`[ID Mapper] [Kitsu-IMDB] Successfully loaded ${kitsuToImdbMappingCount} mappings from local cache.`);
          return { success: true, message: 'Loaded from cache (no changes)', count: kitsuToImdbMappingCount };
        } catch (e) {
          logger.warn('[ID Mapper] [Kitsu-IMDB] ETag matched, but local cache was unreadable. Forcing re-download.');
        }
      }
    } else if (force) {
      logger.debug('[ID Mapper] [Kitsu-IMDB] Force update requested. Bypassing ETag check.');
    } else {
      logger.debug('[ID Mapper] [Kitsu-IMDB] Redis cache is disabled. Proceeding to download.');
    }

    logger.debug('[ID Mapper] [Kitsu-IMDB] Downloading Kitsu to IMDB mapping...');
    const response = await httpGet(REMOTE_KITSU_TO_IMDB_MAPPING_URL);
    kitsuToImdbMapping = response.data;
    kitsuToImdbMappingCount = Object.keys(kitsuToImdbMapping).length;
    const jsonData = JSON.stringify(kitsuToImdbMapping);

    await fs.mkdir(path.dirname(LOCAL_KITSU_TO_IMDB_MAPPING_PATH), { recursive: true });
    await fs.writeFile(LOCAL_KITSU_TO_IMDB_MAPPING_PATH, jsonData, 'utf-8');
    
    if (useRedisCache) {
      await redis.set(REDIS_KITSU_TO_IMDB_ETAG_KEY, response.headers.etag);
      // Write maintenance timestamp
      await redis.set('maintenance:last_kitsu_imdb_update', Date.now().toString());
    }
    
    isKitsuToImdbInitialized = true;
    logger.debug(`[ID Mapper] [Kitsu-IMDB] Successfully loaded ${kitsuToImdbMappingCount} mappings.`);
    return { success: true, message: 'Downloaded and updated', count: kitsuToImdbMappingCount };

  } catch (error) {
    logger.error(`[ID Mapper] [Kitsu-IMDB] An error occurred during remote download: ${error.message}`);
    logger.debug('[ID Mapper] [Kitsu-IMDB] Attempting to fall back to local disk cache...');
    
    try {
      const fileContent = await fs.readFile(LOCAL_KITSU_TO_IMDB_MAPPING_PATH, 'utf-8');
      kitsuToImdbMapping = JSON.parse(fileContent);
      kitsuToImdbMappingCount = Object.keys(kitsuToImdbMapping).length;
      isKitsuToImdbInitialized = true;
      logger.debug('[ID Mapper] [Kitsu-IMDB] Successfully loaded data from local cache on fallback.');
      return { success: true, message: 'Loaded from local cache (fallback)', count: kitsuToImdbMappingCount };
    } catch (fallbackError) {
      logger.error('[ID Mapper] [Kitsu-IMDB] CRITICAL: Fallback to local cache also failed. Kitsu-IMDB mapping will be empty.');
      kitsuToImdbMapping = {};
      kitsuToImdbMappingCount = 0;
      isKitsuToImdbInitialized = true;
      return { success: false, message: `Failed to update: ${error.message}`, count: 0 };
    }
  }
}

/**
 * Loads the anime mapping file into memory on addon startup.
 * It uses Redis and ETags to check if the remote file has changed,
 * avoiding a full download if the local cache is up-to-date.
 */
async function initializeMapper() {
  if (isInitialized && isKitsuToImdbInitialized && isTraktAnimeMoviesInitialized) return;

  await Promise.all([
    downloadAndProcessAnimeList(),
    downloadAndProcessKitsuToImdbMapping(),
    downloadAndProcessTraktAnimeMovies()
  ]);
  
  // Schedule periodic updates
  if (!updateInterval) {
    const intervalMs = UPDATE_INTERVAL_HOURS * 60 * 60 * 1000; // Convert hours to milliseconds
    updateInterval = setInterval(async () => {
      logger.debug(`[ID Mapper] Running scheduled update (every ${UPDATE_INTERVAL_HOURS} hours)...`);
      try {
        await Promise.all([
          downloadAndProcessAnimeList(),
          downloadAndProcessKitsuToImdbMapping(),
          downloadAndProcessTraktAnimeMovies()
        ]);
        logger.debug('[ID Mapper] Scheduled update completed successfully.');
      } catch (error) {
        logger.error('[ID Mapper] Scheduled update failed:', error.message);
      }
    }, intervalMs);
    
    logger.debug(`[ID Mapper] Scheduled periodic updates every ${UPDATE_INTERVAL_HOURS} hours.`);
  }
}

/**
 * Creates a mapping of TVDB Season Number -> Kitsu ID for a given franchise.
 * This is the core of the new, reliable seasonal mapping.
 * OVAs are assigned to season 0 to avoid conflicts with main TV series.
 */
async function buildFranchiseMapFromTvdbId(tvdbId) {
  const numericTvdbId = parseInt(tvdbId, 10);
  if (franchiseMapCache.has(numericTvdbId)) {
    return franchiseMapCache.get(numericTvdbId);
  }

  const franchiseSiblings = tvdbIdToAnimeListMap.get(numericTvdbId);
  if (!franchiseSiblings || franchiseSiblings.length === 0) return null;

  try {
    const kitsuIds = franchiseSiblings.map(s => s.kitsu_id).filter(Boolean);
    const kitsuDetails = (await kitsu.getMultipleAnimeDetails(kitsuIds))?.data || [];
    const desiredTvTypes = new Set(['tv', 'ova', 'ona']);
    const kitsuTvSeasons = kitsuDetails.filter(item => 
        desiredTvTypes.has(item.attributes?.subtype.toLowerCase())
    );

    // Separate TV series from OVAs/ONAs
    const tvSeries = kitsuTvSeasons.filter(item => 
        item.attributes?.subtype.toLowerCase() === 'tv'
    );
    const ovasAndOnas = kitsuTvSeasons.filter(item => 
        ['ova', 'ona'].includes(item.attributes?.subtype.toLowerCase())
    );

    // Sort TV series by start date for main season numbering
    const sortedTvSeries = tvSeries.sort((a, b) => {
      const aDate = new Date(a.attributes?.startDate || '9999-12-31');
      const bDate = new Date(b.attributes?.startDate || '9999-12-31');
      return aDate - bDate;
    });

    // Sort OVAs/ONAs by start date
    const sortedOvasAndOnas = ovasAndOnas.sort((a, b) => {
      const aDate = new Date(a.attributes?.startDate || '9999-12-31');
      const bDate = new Date(b.attributes?.startDate || '9999-12-31');
      return aDate - bDate;
    });
    
    const seasonToKitsuMap = new Map();

    // Assign main TV series to seasons 1, 2, 3, etc.
    sortedTvSeries.forEach((kitsuItem, index) => {
      const seasonNumber = index + 1;
      seasonToKitsuMap.set(seasonNumber, parseInt(kitsuItem.id, 10));
    });

    // for each tv series, we need to find

    // Assign OVAs/ONAs to season 0 (all OVAs share season 0)
    // Note: Stremio doesn't support negative season numbers, so all OVAs use season 0
    if (sortedOvasAndOnas.length > 0) {
      // Use the first (earliest) OVA for season 0
      seasonToKitsuMap.set(0, parseInt(sortedOvasAndOnas[0].id, 10));
    }

    logger.debug(`[ID Mapper] Built franchise map for TVDB ${tvdbId}:`, seasonToKitsuMap);
    franchiseMapCache.set(numericTvdbId, seasonToKitsuMap);
    return seasonToKitsuMap;

  } catch (error) {
    logger.error(`[ID Mapper] Failed to build franchise map for TVDB ${tvdbId}:`, error);
    return null;
  }
}

/**
 * The public function to get a Kitsu ID for a specific TVDB season.
 * It uses the franchise map internally.
 * Supports special season numbers: 0 for single OVA, negative numbers for multiple OVAs.
 */
async function resolveKitsuIdFromTvdbSeason(tvdbId, seasonNumber) {
    if (!isInitialized) return null;
    
    const franchiseMap = await buildFranchiseMapFromTvdbId(tvdbId);
    if (!franchiseMap) {
      logger.warn(`[ID Mapper] No franchise map available for TVDB ${tvdbId}`);
      return null;
    }
    logger.debug(`[ID Mapper] Franchise map for TVDB ${tvdbId}:`, franchiseMap);
    
    const foundKitsuId = franchiseMap.get(seasonNumber) || null;
    if (foundKitsuId) {
      let seasonType = 'TV';
      if (seasonNumber === 0) {
        seasonType = 'OVA/ONA';
      }
      logger.debug(`[ID Mapper] Resolved TVDB S${seasonNumber} (${seasonType}) to Kitsu ID ${foundKitsuId}`);
    } else {
      logger.warn(`[ID Mapper] No Kitsu ID found for S${seasonNumber} in franchise map for TVDB ${tvdbId}`);
      
      // Provide helpful debugging info about available seasons
      const availableSeasons = Array.from(franchiseMap.keys()).sort((a, b) => a - b);
      logger.debug(`[ID Mapper] Available seasons for TVDB ${tvdbId}: ${availableSeasons.join(', ')}`);
    }
    return foundKitsuId;
}

/**
 * Resolves Kitsu ID for a specific TMDB season number.
 * Uses franchise mapping to find the corresponding Kitsu season.
 * 
 * @param {string|number} tmdbId - The TMDB ID of the series
 * @param {number} seasonNumber - The season number to resolve
 * @returns {Promise<string|null>} The Kitsu ID for the season, or null if not found
 */
async function resolveKitsuIdFromTmdbSeason(tmdbId, seasonNumber) {
    if (!isInitialized) return null;
    
    // Get franchise information for this TMDB ID
    const franchiseInfo = await getFranchiseInfoFromTmdbId(tmdbId);
    
    if (!franchiseInfo) {
      logger.warn(`[ID Mapper] No franchise info found for TMDB ID ${tmdbId}`);
      return null;
    }
    
    logger.debug(`[ID Mapper] Resolving TMDB S${seasonNumber} for ${tmdbId} (scenario: ${franchiseInfo.mappingScenario})`);
    
    // Check if episode-level mapping is needed (like Dan Da Dan scenario)
    if (franchiseInfo.needsEpisodeMapping) {
      logger.debug(`[ID Mapper] Episode-level mapping detected for TMDB ${tmdbId} (${franchiseInfo.tvSeriesCount} Kitsu entries for 1 TMDB season)`);
      
      // For episode-level mapping, we need to return a representative Kitsu ID
      // The actual episode-specific mapping will be done in getMeta.js
      const firstKitsuEntry = franchiseInfo.kitsuDetails
        .filter(entry => entry.subtype?.toLowerCase() === 'tv')
        .sort((a, b) => new Date(a.startDate || '9999-12-31') - new Date(b.startDate || '9999-12-31'))[0];
      
      if (firstKitsuEntry) {
        logger.debug(`[ID Mapper] Using first Kitsu ID ${firstKitsuEntry.id} as representative for episode-level mapping`);
        return firstKitsuEntry.id;
      }
    }
    
    // Check if the requested season exists in our mapping
    if (!franchiseInfo.seasons[seasonNumber]) {
      logger.warn(`[ID Mapper] Season ${seasonNumber} not found in franchise mapping for TMDB ${tmdbId}`);
      logger.debug(`[ID Mapper] Available seasons: ${franchiseInfo.availableSeasonNumbers.join(', ')}`);
      
      // For complex scenarios, try to find the best match
      if (franchiseInfo.mappingScenario === 'tv_series_with_ovas' && seasonNumber > 0) {
        // If requesting a TV season but only have TV+OVA, return the TV series
        const tvSeason = Object.entries(franchiseInfo.seasons).find(([num, info]) => 
          info.mappingType === 'tv_series'
        );
        if (tvSeason) {
          const [seasonNum, info] = tvSeason;
          logger.debug(`[ID Mapper] Using TV series season ${seasonNum} (Kitsu ID ${info.kitsuId}) for TMDB S${seasonNumber}`);
          return info.kitsuId;
        }
      }
      
      // Fallback to first available season
      const firstSeason = franchiseInfo.availableSeasonNumbers[0];
      const firstSeasonInfo = franchiseInfo.seasons[firstSeason];
      logger.debug(`[ID Mapper] Using fallback season ${firstSeason} (Kitsu ID ${firstSeasonInfo.kitsuId}) for TMDB S${seasonNumber}`);
      return firstSeasonInfo.kitsuId;
    }
    
    const seasonInfo = franchiseInfo.seasons[seasonNumber];
    logger.debug(`[ID Mapper] Resolved TMDB S${seasonNumber} to Kitsu ID ${seasonInfo.kitsuId} (${seasonInfo.mappingType})`);
    logger.debug(`[ID Mapper] Season details: ${seasonInfo.title} (${seasonInfo.episodeCount} episodes, started ${seasonInfo.startDate})`);
    
    return seasonInfo.kitsuId;
}

/**
 * Gets IMDB episode ID for a specific TMDB episode using pre-fetched Cinemeta videos data.
 * Uses episode air dates to map TMDB episodes to IMDB episodes.
 * 
 * @param {string|number} tmdbId - The TMDB ID of the series
 * @param {number} seasonNumber - The season number
 * @param {number} episodeNumber - The episode number
 * @param {string} episodeAirDate - The episode air date (ISO string)
 * @param {Array} cinemetaVideos - Pre-fetched Cinemeta videos array
 * @returns {string|null} The IMDB episode ID in format "imdbId:seasonNumber:episodeNumber", or null if not found
 */
function getImdbEpisodeIdFromTmdbEpisode(tmdbId, seasonNumber, episodeNumber, episodeAirDate, cinemetaVideos, imdbId) {
    if (!isInitialized) return null;
    
    // We MUST have the imdbId parameter - no fallback to mapping file
    if (!imdbId) {
      logger.warn(`[ID Mapper] No IMDB ID provided for TMDB ${tmdbId} S${seasonNumber}E${episodeNumber}`);
      return null;
    }
    
    if (!cinemetaVideos || !Array.isArray(cinemetaVideos)) {
      logger.warn(`[ID Mapper] No valid Cinemeta videos array provided for ${imdbId}`);
      // Fallback: return the base IMDB ID with season/episode
      return null;
    }
    
    // Parse the episode air date
    const targetDate = new Date(episodeAirDate);
    if (isNaN(targetDate.getTime())) {
      logger.warn(`[ID Mapper] Invalid episode air date: ${episodeAirDate}`);
      // Fallback: return the base IMDB ID with season/episode
      const fallbackId = `${imdbId}:${seasonNumber}:${episodeNumber}`;
      logger.debug(`[ID Mapper] Using fallback IMDB ID ${fallbackId} for TMDB S${seasonNumber}E${episodeNumber} (invalid date)`);
      return fallbackId;
    }
    
    // Find the best matching episode by air date
    let bestMatch = null;
    let smallestDateDiff = Infinity;
    
    for (const video of cinemetaVideos) {
      if (!video.released || !video.season || !video.episode) continue;
      
      const videoDate = new Date(video.released);
      if (isNaN(videoDate.getTime())) continue;
      
      // Calculate date difference in days
      const dateDiff = Math.abs(targetDate.getTime() - videoDate.getTime()) / (1000 * 60 * 60 * 24);
      
      // If this is a better match (closer date), update best match
      if (dateDiff < smallestDateDiff) {
        smallestDateDiff = dateDiff;
        bestMatch = video;
      }
    }
    
    // If we found a match within 7 days, use it
    if (bestMatch && smallestDateDiff <= 7) {
      const episodeId = `${imdbId}:${bestMatch.season}:${bestMatch.episode}`;
      logger.debug(`[ID Mapper] Mapped TMDB S${seasonNumber}E${episodeNumber} (${episodeAirDate}) to IMDB ${episodeId} (${bestMatch.released}, diff: ${smallestDateDiff.toFixed(1)} days)`);
      return episodeId;
    }
    
    // If no close match found, try to find by season/episode number
    if (seasonNumber > 0) {
      const seasonMatch = cinemetaVideos.find(video => 
        video.season === seasonNumber && video.episode === episodeNumber
      );
      
      if (seasonMatch) {
        const episodeId = `${imdbId}:${seasonMatch.season}:${seasonMatch.episode}`;
        logger.debug(`[ID Mapper] Mapped TMDB S${seasonNumber}E${episodeNumber} to IMDB ${episodeId} (by season/episode number)`);
        return episodeId;
      }
    }
    
    // Fallback: return the base IMDB ID with season/episode
    const fallbackId = `${tmdbId}:${seasonNumber}:${episodeNumber}`;
    logger.debug(`[ID Mapper] Using fallback IMDB ID ${fallbackId} for TMDB S${seasonNumber}E${episodeNumber}`);
    return fallbackId;
}

/**
 * Fetches Cinemeta videos data for an IMDB series.
 * This should be called once per IMDB series to get all episode data.
 * 
 * @param {string} imdbId - The IMDB ID of the series
 * @returns {Promise<Array|null>} Array of Cinemeta videos, or null if not found
 */
async function getCinemetaVideosForImdbSeries(imdbId) {
  if (!imdbId) {
    logger.warn(`[ID Mapper] No IMDB ID provided`);
    return null;
  }
  
  try {
    // Fetch episode data from Cinemeta API
    const cinemetaUrl = `https://cinemeta-live.strem.io/meta/series/${imdbId}.json`;
    logger.debug(`[ID Mapper] Fetching Cinemeta videos for IMDB ${imdbId}: ${cinemetaUrl}`);
    
    const response = await httpGet(cinemetaUrl);
    const cinemetaData = response?.data?.meta;

    if (!cinemetaData?.videos || !Array.isArray(cinemetaData.videos)) {
      logger.warn(`[ID Mapper] No videos array found in Cinemeta data for ${imdbId}`);
      return null;
    }

    logger.debug(`[ID Mapper] Successfully fetched ${cinemetaData.videos.length} videos from Cinemeta for IMDB ${imdbId}`);
    return cinemetaData.videos;

  } catch (error) {
    logger.error(`[ID Mapper] Error fetching Cinemeta data for IMDB ${imdbId}:`, error.message);
    return null;
  }
}

async function getCinemetaVideosForImdbIoSeries(imdbId) {
  if (!imdbId) {
    logger.warn(`[ID Mapper] No IMDB ID provided`);
    return null;
  }
  
  try {
    // Fetch episode data from Cinemeta API
    const cinemetaUrl = `https://cinemeta-live.strem.io/meta/series/${imdbId}.json`;
    logger.debug(`[ID Mapper] Fetching Cinemeta videos for IMDB ${imdbId}: ${cinemetaUrl}`);
    
    const response = await httpGet(cinemetaUrl);
    const cinemetaData = response?.data?.meta;

    if (!cinemetaData?.videos || !Array.isArray(cinemetaData.videos)) {
      logger.warn(`[ID Mapper] No videos array found in Cinemeta data for ${imdbId}`);
      return null;
    }

    logger.debug(`[ID Mapper] Successfully fetched ${cinemetaData.videos.length} videos from Cinemeta for IMDB ${imdbId}`);
    return cinemetaData.videos;

  } catch (error) {
    logger.error(`[ID Mapper] Error fetching Cinemeta data for IMDB ${imdbId}:`, error.message);
    return null;
  }
}

function getSiblingsByImdbId(imdbId) {
  if (!isInitialized) return [];
  // IMDb IDs are strings, no need to parse.
  return imdbIdToAnimeListMap.get(imdbId) || [];
}

/**
 * Finds the corresponding IMDb ID and Season Number for a given Kitsu show ID.
 * It uses the shared IMDb ID as the franchise link.
 *
 * @param {string|number} kitsuId - The Kitsu ID of the anime season.
 * @returns {Promise<{imdbId: string, seasonNumber: number}|null>}
 */
async function resolveImdbSeasonFromKitsu(kitsuId) {
  const numericKitsuId = parseInt(kitsuId, 10);
  if (kitsuToImdbCache.has(numericKitsuId)) {
    return kitsuToImdbCache.get(numericKitsuId);
  }

  try {
    const baseMapping = getMappingByKitsuId(numericKitsuId);
    if (!baseMapping || !baseMapping.imdb_id) {
      logger.warn(`Incomplete mapping for Kitsu ID ${numericKitsuId}. Missing IMDb parent.`);
      return null;
    }
    const parentImdbId = baseMapping.imdb_id;

    const siblings = getSiblingsByImdbId(parentImdbId);
    if (!siblings || siblings.length === 0) return null;

    if (siblings.length === 1) {
      const result = { imdbId: parentImdbId, seasonNumber: 1 };
      kitsuToImdbCache.set(numericKitsuId, result);
      return result;
    }

    const siblingKitsuIds = siblings.map(s => s.kitsu_id);
    const kitsuDetails = (await kitsu.getMultipleAnimeDetails(siblingKitsuIds))?.data || [];

    const sortedKitsuSeasons = kitsuDetails
      .filter(k => k.attributes?.subtype === 'TV')
      .sort((a, b) => new Date(a.attributes.startDate) - new Date(b.attributes.startDate));

    const seasonIndex = sortedKitsuSeasons.findIndex(k => parseInt(k.id, 10) === numericKitsuId);

    if (seasonIndex !== -1) {
      const seasonNumber = seasonIndex + 1;
      const result = { imdbId: parentImdbId, seasonNumber: seasonNumber };
      logger.debug(`[ID Resolver] Mapped Kitsu ID ${numericKitsuId} to IMDb Season ${seasonNumber}`);
      kitsuToImdbCache.set(numericKitsuId, result);
      return result;
    }

    logger.warn(`[ID Resolver] Could not determine season number for Kitsu ID ${numericKitsuId}.`);
    kitsuToImdbCache.set(numericKitsuId, null);
    return null;

  } catch (error) {
    logger.error(`[ID Resolver] Error in resolveImdbSeasonFromKitsu for ${kitsuId}:`, error.message);
    return null;
  }
}

function getMappingBySimklId(simklId) {
  if (!isInitialized) return null;
  const numericSimklId = parseInt(simklId, 10);
  return simklIdMap.get(numericSimklId) || null;
}

function getMappingByMalId(malId) {
  if (!isInitialized) {
    logger.warn('[ID Mapper] Mapper is not initialized. Returning null.');
    return null;
  }
  return animeIdMap.get(parseInt(malId, 10)) || null;
}

function getMappingByKitsuId(kitsuId) {
  if (!isInitialized) return null;
  const numericKitsuId = parseInt(kitsuId, 10);
  // O(1) lookup using auxiliary index map
  return kitsuIdMap.get(numericKitsuId) || null;
}

function getMappingByAnidbId(anidbId) {
  if (!isInitialized) return null;
  const numericAnidbId = parseInt(anidbId, 10);
  // O(1) lookup using auxiliary index map
  return anidbIdMap.get(numericAnidbId) || null;
}

function getMappingByAnilistId(anilistId) {
  if (!isInitialized) return null;
  const numericAnilistId = parseInt(anilistId, 10);
  // O(1) lookup using auxiliary index map
  return anilistIdMap.get(numericAnilistId) || null;
}

function getMappingByImdbId(imdbId) {
  if (!isInitialized) return null;
  // O(1) lookup using auxiliary index map (IMDB IDs are strings, no need to parse)
  return imdbIdMap.get(imdbId) || null;
}

/**
 * Gets the Kitsu to IMDB mapping for a specific Kitsu ID
 * @param {string|number} kitsuId - The Kitsu ID
 * @returns {Object|null} The mapping object or null if not found
 */
function getKitsuToImdbMapping(kitsuId) {
  if (!isKitsuToImdbInitialized) {
    logger.warn('[ID Mapper] [Kitsu-IMDB] Mapper is not initialized. Returning null.');
    return null;
  }
  const numericKitsuId = parseInt(kitsuId, 10);
  return kitsuToImdbMapping[numericKitsuId] || null;
}

/**
 * Gets all Kitsu to IMDB mappings for a specific IMDB ID
 * @param {string} imdbId - The IMDB ID
 * @returns {Array} Array of mapping objects for the IMDB ID
 */
function getKitsuToImdbMappingsByImdbId(imdbId) {
  if (!isKitsuToImdbInitialized) {
    logger.warn('[ID Mapper] [Kitsu-IMDB] Mapper is not initialized. Returning empty array.');
    return [];
  }
  
  return Object.values(kitsuToImdbMapping).filter(mapping => mapping.imdb_id === imdbId);
}

/**
 * Enriches MAL episodes with IMDB metadata using the Kitsu to IMDB mapping
 * @param {Object} videos - The videos array
 * @param {Object} imdbInfo - The IMDB mapping info for the Kitsu ID
 * @param {Object} imdbMetadata - The IMDB metadata containing episode information
 * @returns {Array} Enriched episodes array
 */
async function enrichMalEpisodes(videos, kitsuId, preserveIds = false) {
  logger.debug(`[enrichMalEpisodes] Called with kitsuId: ${kitsuId}, videos count: ${videos?.length || 0}`);
  
  if (!videos || !videos.length) {
    logger.debug(`[enrichMalEpisodes] No videos provided, returning null`);
    return null;
  }

  const imdbInfo = getKitsuToImdbMapping(kitsuId);
  if (!imdbInfo) {
    logger.debug(`[enrichMalEpisodes] No IMDB mapping found for kitsuId: ${kitsuId}, returning null (no enrichment)`);
    return null;
  }

  logger.info(`[enrichMalEpisodes] Found IMDB mapping for kitsuId ${kitsuId}: ${JSON.stringify(imdbInfo)}`);
  const imdbMetadata = await getCinemetaVideosForImdbSeries(imdbInfo.imdb_id);
  const startSeason = Number.isInteger(imdbInfo.fromSeason) ? imdbInfo.fromSeason : 1;
  const startEpisode = Number.isInteger(imdbInfo.fromEpisode) ? imdbInfo.fromEpisode : 1;
  // get highest season number
  const highestSeason = Math.max(...(imdbMetadata?.map(episode => episode.season).filter(season => season != 0) || []));
  if((!Number.isInteger(startSeason) || !Number.isInteger(startEpisode)) && highestSeason > 1) {
    return videos;
  }
  
  const imdbEpisodes = imdbMetadata?.filter(video => 
    video.season === startSeason && video.episode >= startEpisode
  ) || [];

  const otherImdbEntries = getKitsuToImdbMappingsByImdbId(imdbInfo.imdb_id)
    .filter((entry) => entry.kitsu_id !== kitsuId
      && entry.fromSeason >= startSeason
      && entry.fromEpisode >= startEpisode);
  
  const nextImdbEntry = otherImdbEntries && otherImdbEntries[0];

  const perSeasonEpisodeCount = imdbMetadata && Array.isArray(imdbMetadata) && imdbMetadata
      .filter((video) => (video.season === startSeason && video.episode >= startEpisode) || (video.season > startSeason
          && (!nextImdbEntry || nextImdbEntry.fromSeason > video.season)))
      .reduce(
          (counts, next) => (counts[next.season - startSeason] = counts[next.season - startSeason] + 1 || 1, counts),
          []);

  const videosMap = perSeasonEpisodeCount && imdbMetadata && Array.isArray(imdbMetadata) && imdbMetadata.reduce((map, next) => (map[next.id] = next, map), {})
  let skippedEpisodes = 0;

  //logger.debug(`[ID Mapper] Per season episode count:`, perSeasonEpisodeCount);


  if (perSeasonEpisodeCount && perSeasonEpisodeCount.length) {
    let lastReleased;
    return videos
        .map(video => {
          if (imdbInfo.nonImdbEpisodes && imdbInfo.nonImdbEpisodes.includes(video.episode)) {
            skippedEpisodes++
            return video
          }
          const seasonIndex = ([...perSeasonEpisodeCount.keys()]
              .find((i) => perSeasonEpisodeCount.slice(0, i + 1)
                  .reduce((a, b) => a + b, 0) >= video.episode - skippedEpisodes) + 1 || perSeasonEpisodeCount.length) - 1;
          const previousSeasonsEpisodeCount = perSeasonEpisodeCount.slice(0, seasonIndex).reduce((a, b) => a + b, 0);
          const season = startSeason + seasonIndex;
          const episode = startEpisode - 1 + video.episode - skippedEpisodes - previousSeasonsEpisodeCount;
          const imdbVideo = videosMap[`${imdbInfo.imdb_id}:${season}:${episode}`];
          const title = video.title;
          // If video.thumbnail is missing_thumbnail.png, prefer imdbVideo.thumbnail if available
          const thumbnail = video.thumbnail;
          const overview = video.overview || imdbVideo?.overview;
          const episodeId = preserveIds ? video.id : `${imdbInfo.imdb_id}:${season}:${episode}`;
          return {
            ...video,
            id: episodeId,
            title,
            thumbnail,
            overview,
            imdb_id: imdbInfo.imdb_id,
            imdbSeason: season,
            imdbEpisode: episode
          }
        });
  }
  
  
  const enrichedVideos = videos.map((video, index) => {
    // Find corresponding IMDB episode data
    const imdbVideo = imdbEpisodes.find(imdbEp => 
      imdbEp.season === startSeason && imdbEp.episode === (startEpisode + index)
    );
    
    // Use IMDB data to enrich the episode
    // If video.thumbnail is missing_thumbnail.png, prefer imdbVideo.thumbnail if available
    video.thumbnail = (video.thumbnail && video.thumbnail.includes('missing_thumbnail.png'))
      ? (imdbVideo?.thumbnail || video.thumbnail)
      : (video.thumbnail || imdbVideo?.thumbnail);
    video.overview = video.overview || imdbVideo?.overview;
    video.released = imdbVideo?.released ? new Date(imdbVideo.released) : video.released;
    video.title = video.title.match(/Episode \d+/) && (imdbVideo?.title || imdbVideo?.name) || video.title;
    const episodeId = preserveIds ? video.id : `${imdbInfo.imdb_id}:${startSeason}:${startEpisode + index}`;
    return {
      ...video,
      id: episodeId
    };
  });
  return enrichedVideos;
  
}

/**
 * Finds the mapping entry for a given TMDB ID.
 * This is more complex than other lookups because TMDB can have ID collisions
 * between movies and various series-like anime types (TV, OVA, ONA, etc.).
 * 
 * @param {number|string} tmdbId - The TMDB ID.
 * @param {string} type - The Stremio type ('movie' or 'series') to help disambiguate.
 * @returns {object|null} - The best matching mapping object, or null.
 */
function getMappingByTmdbId(tmdbId, type) {
  if (!isInitialized) return null;

  const numericTmdbId = parseInt(tmdbId, 10);
  
  const allMatches = tmdbIndexArray.filter(item => item.themoviedb_id === numericTmdbId);

  if (allMatches.length === 0) {
    return null;
  }
  
  if (allMatches.length === 1) {
    return allMatches[0];
  }

  logger.debug(`[ID Mapper] Found ${allMatches.length} potential matches for TMDB ID ${numericTmdbId}. Using type ('${type}') to find the best fit.`);

  if (type === 'movie') {
    const movieMatch = allMatches.find(item => item.type && item.type.toLowerCase() === 'movie');
    if (movieMatch) return movieMatch;
  }
  
  if (type === 'series') {
    const seriesLikeTypes = ['tv', 'ova', 'ona', 'special'];
    const seriesMatch = allMatches.find(item => item.type && seriesLikeTypes.includes(item.type.toLowerCase()));
    if (seriesMatch) return seriesMatch;
  }

  logger.warn(`[ID Mapper] Could not disambiguate for TMDB ID ${numericTmdbId} with type '${type}'. Returning first available match.`);
  return allMatches[0];
}

function getAnimeTypeFromAnilistId(anilistId) {
  if (!isInitialized) return null;
  const numericAnilistId = parseInt(anilistId, 10);
  const mapping = Array.from(animeIdMap.values()).find(item => item.anilist_id === numericAnilistId);
  if(mapping?.type){
    const seriesLikeTypes = ['tv', 'ova', 'ona', 'special'];
    if(seriesLikeTypes.includes(mapping.type.toLowerCase())){
      return 'series';
    }else{
      return 'movie';
    }
  }
  return null;
}

function getAnimeTypeFromKitsuId(kitsuId) {
  if (!isInitialized) return null;
  const numericKitsuId = parseInt(kitsuId, 10);
  const mapping = Array.from(animeIdMap.values()).find(item => item.kitsu_id === numericKitsuId);
  if(mapping?.type){
    const seriesLikeTypes = ['tv', 'ova', 'ona', 'special'];
    if(seriesLikeTypes.includes(mapping.type.toLowerCase())){
      return 'series';
    }else{
      return 'movie';
    }
  }
  return null;
}

function getAnimeTypeFromMalId(malId) {
  if (!isInitialized) return null;
  const numericMalId = parseInt(malId, 10);
  const mapping = Array.from(animeIdMap.values()).find(item => item.mal_id === numericMalId);
  if(mapping?.type){
    const seriesLikeTypes = ['tv', 'ova', 'ona', 'special'];
    if(seriesLikeTypes.includes(mapping.type.toLowerCase())){
      return 'series';
    }else{
      return 'movie';
    }
  }
  return null;
}

function getAnimeTypeFromAnidbId(anidbId) {
  if (!isInitialized) return null;
  const numericAnidbId = parseInt(anidbId, 10);
  const mapping = Array.from(animeIdMap.values()).find(item => item.anidb_id === numericAnidbId);
  if(mapping?.type){
    const seriesLikeTypes = ['tv', 'ova', 'ona', 'special'];
    if(seriesLikeTypes.includes(mapping.type.toLowerCase())){
      return 'series';
    }else{
      return 'movie';
    }
  }
  return null;
}

function getMappingByTvdbId(tvdbId) {
  if (!isInitialized) return null;
  const numericTvdbId = parseInt(tvdbId, 10);
  const siblings = tvdbIdToAnimeListMap.get(numericTvdbId);
  return siblings?.[0] || null;
}

/**
 * Gets detailed information about the franchise mapping for a TVDB ID.
 * Useful for debugging and understanding the season structure.
 * 
 * @param {string|number} tvdbId - The TVDB ID
 * @returns {Promise<object|null>} - Franchise mapping information
 */
async function getFranchiseInfoFromTvdbId(tvdbId) {
  if (!isInitialized) return null;
  
  const franchiseMap = await buildFranchiseMapFromTvdbId(tvdbId);
  if (!franchiseMap) return null;
  
  const franchiseSiblings = tvdbIdToAnimeListMap.get(parseInt(tvdbId, 10));
  if (!franchiseSiblings) return null;
  
  const kitsuIds = franchiseSiblings.map(s => s.kitsu_id).filter(Boolean);
  const kitsuDetails = (await kitsu.getMultipleAnimeDetails(kitsuIds))?.data || [];
  
  const seasonInfo = {};
  for (const [seasonNumber, kitsuId] of franchiseMap.entries()) {
    const kitsuItem = kitsuDetails.find(item => parseInt(item.id, 10) === kitsuId);
    if (kitsuItem) {
      seasonInfo[seasonNumber] = {
        kitsuId: kitsuId,
        title: kitsuItem.attributes?.canonicalTitle,
        subtype: kitsuItem.attributes?.subtype,
        startDate: kitsuItem.attributes?.startDate,
        episodeCount: kitsuItem.attributes?.episodeCount
      };
    }
  }
  
  return {
    tvdbId: parseInt(tvdbId, 10),
    totalSeasons: franchiseMap.size,
    seasons: seasonInfo,
    availableSeasonNumbers: Array.from(franchiseMap.keys()).sort((a, b) => a - b)
  };
}

/**
 * Gets detailed information about the franchise mapping for a TMDB ID.
 * Similar to getFranchiseInfoFromTvdbId but for TMDB-based franchises.
 * 
 * @param {string|number} tmdbId - The TMDB ID
 * @returns {Promise<object|null>} - Franchise mapping information
 */
async function getFranchiseInfoFromTmdbId(tmdbId) {
  if (tmdbFranchiseInfoCache.has(tmdbId)) {
    return tmdbFranchiseInfoCache.get(tmdbId);
  }
  if (!isInitialized) return null;
  
  // Find all mappings for this TMDB ID
  const tmdbMappings = Array.from(animeIdMap.values())
    .filter(mapping => mapping.themoviedb_id === tmdbId);
  
  if (tmdbMappings.length === 0) {
    logger.warn(`[ID Mapper] No TMDB mapping found for TMDB ID ${tmdbId}`);
    tmdbFranchiseInfoCache.set(tmdbId, null);
    return null;
  }
  
  try {
    // Get all Kitsu IDs from the mappings
    const kitsuIds = tmdbMappings.map(m => m.kitsu_id).filter(Boolean);
    
    if (kitsuIds.length === 0) {
      logger.warn(`[ID Mapper] No valid Kitsu IDs found in TMDB mappings for ${tmdbId}`);
      tmdbFranchiseInfoCache.set(tmdbId, null);
      return null;
    }
    
    // Fetch detailed information for all Kitsu entries
    const kitsuDetails = (await kitsu.getMultipleAnimeDetails(kitsuIds))?.data || [];
    
    // Filter for TV series and sort by start date
    const tvSeries = kitsuDetails
      .filter(item => item.attributes?.subtype?.toLowerCase() === 'tv')
      .sort((a, b) => {
        const aDate = new Date(a.attributes?.startDate || '9999-12-31');
        const bDate = new Date(b.attributes?.startDate || '9999-12-31');
        return aDate - bDate;
      });
    
    // Filter for OVAs/ONAs and sort by start date
    const ovasAndOnas = kitsuDetails
      .filter(item => ['ova', 'ona'].includes(item.attributes?.subtype?.toLowerCase()))
      .sort((a, b) => {
        const aDate = new Date(a.attributes?.startDate || '9999-12-31');
        const bDate = new Date(b.attributes?.startDate || '9999-12-31');
        return aDate - bDate;
      });
    
    const seasonInfo = {};
    
    // Map TV series to seasons 1, 2, 3, etc.
    tvSeries.forEach((kitsuItem, index) => {
      const seasonNumber = index + 1;
      seasonInfo[seasonNumber] = {
        kitsuId: parseInt(kitsuItem.id, 10),
        title: kitsuItem.attributes?.canonicalTitle,
        subtype: kitsuItem.attributes?.subtype,
        startDate: kitsuItem.attributes?.startDate,
        episodeCount: kitsuItem.attributes?.episodeCount,
        mappingType: 'tv_series'
      };
    });
    
    // Map OVAs/ONAs to season 0
    if (ovasAndOnas.length > 0) {
      seasonInfo[0] = {
        kitsuId: parseInt(ovasAndOnas[0].id, 10),
        title: ovasAndOnas[0].attributes?.canonicalTitle,
        subtype: ovasAndOnas[0].attributes?.subtype,
        startDate: ovasAndOnas[0].attributes?.startDate,
        episodeCount: ovasAndOnas[0].attributes?.episodeCount,
        mappingType: 'ova_ona',
        allOvaIds: ovasAndOnas.map(ova => parseInt(ova.id, 10))
      };
    }
    
    const availableSeasonNumbers = Object.keys(seasonInfo).map(Number).sort((a, b) => a - b);
    
    // Determine if we need episode-level mapping
    const needsEpisodeMapping = determineIfEpisodeMappingNeeded(tvSeries.length, ovasAndOnas.length);
    
    const result = {
      tmdbId: parseInt(tmdbId, 10),
      totalSeasons: availableSeasonNumbers.length,
      totalKitsuIds: kitsuIds.length,
      seasons: seasonInfo,
      availableSeasonNumbers,
      mappingScenario: determineMappingScenario(tvSeries.length, ovasAndOnas.length, availableSeasonNumbers.length),
      tvSeriesCount: tvSeries.length,
      ovaCount: ovasAndOnas.length,
      needsEpisodeMapping,
      allKitsuIds: kitsuIds,
      kitsuDetails: kitsuDetails.map(item => ({
        id: parseInt(item.id, 10),
        title: item.attributes?.canonicalTitle,
        subtype: item.attributes?.subtype,
        startDate: item.attributes?.startDate,
        episodeCount: item.attributes?.episodeCount
      }))
    };

    tmdbFranchiseInfoCache.set(tmdbId, result);
    return result;
    
  } catch (error) {
    logger.error(`[ID Mapper] Error getting franchise info for TMDB ${tmdbId}:`, error);
    tmdbFranchiseInfoCache.set(tmdbId, null);
    return null;
  }
}

/**
 * Gets detailed information about the franchise mapping for a IMDb ID.
 * Similar to getFranchiseInfoFromTvdbId and getFranchiseInfoFromTmdbId but for IMDb-based franchises.
 * 
 * @param {string|number} imdbId - The IMDb ID
 * @returns {Promise<object|null>} - Franchise mapping information
 */
async function getFranchiseInfoFromImdbId(imdbId) {
  if (!isInitialized) return null;

  // Find all mappings for this IMDb ID
  const imdbMappings = imdbIdToAnimeListMap.get(imdbId) || [];
  if (imdbMappings.length === 0) {
    logger.warn(`[ID Mapper] No IMDb mapping found for IMDb ID ${imdbId}`);
    return null;
  }

  try {
    // Get all Kitsu IDs from the mappings
    const kitsuIds = imdbMappings.map(m => m.kitsu_id).filter(Boolean);
    if (kitsuIds.length === 0) {
      logger.warn(`[ID Mapper] No valid Kitsu IDs found in IMDb mappings for ${imdbId}`);
      return null;
    }

    // Fetch detailed information for all Kitsu entries
    const kitsuDetails = (await kitsu.getMultipleAnimeDetails(kitsuIds))?.data || [];

    // Filter for TV series and sort by start date
    const tvSeries = kitsuDetails
      .filter(item => item.attributes?.subtype?.toLowerCase() === 'tv')
      .sort((a, b) => {
        const aDate = new Date(a.attributes?.startDate || '9999-12-31');
        const bDate = new Date(b.attributes?.startDate || '9999-12-31');
        return aDate - bDate;
      });

    // Filter for OVAs/ONAs and sort by start date
    const ovasAndOnas = kitsuDetails
      .filter(item => ['ova', 'ona'].includes(item.attributes?.subtype?.toLowerCase()))
      .sort((a, b) => {
        const aDate = new Date(a.attributes?.startDate || '9999-12-31');
        const bDate = new Date(b.attributes?.startDate || '9999-12-31');
        return aDate - bDate;
      });

    const seasonInfo = {};

    // Map TV series to seasons 1, 2, 3, etc.
    tvSeries.forEach((kitsuItem, index) => {
      const seasonNumber = index + 1;
      seasonInfo[seasonNumber] = {
        kitsuId: parseInt(kitsuItem.id, 10),
        title: kitsuItem.attributes?.canonicalTitle,
        subtype: kitsuItem.attributes?.subtype,
        startDate: kitsuItem.attributes?.startDate,
        episodeCount: kitsuItem.attributes?.episodeCount,
        mappingType: 'tv_series'
      };
    });

    // Map OVAs/ONAs to season 0
    if (ovasAndOnas.length > 0) {
      seasonInfo[0] = {
        kitsuId: parseInt(ovasAndOnas[0].id, 10),
        title: ovasAndOnas[0].attributes?.canonicalTitle,
        subtype: ovasAndOnas[0].attributes?.subtype,
        startDate: ovasAndOnas[0].attributes?.startDate,
        episodeCount: ovasAndOnas[0].attributes?.episodeCount,
        mappingType: 'ova_ona',
        allOvaIds: ovasAndOnas.map(ova => parseInt(ova.id, 10))
      };
    }

    const availableSeasonNumbers = Object.keys(seasonInfo).map(Number).sort((a, b) => a - b);

    return {
      imdbId: imdbId,
      totalSeasons: availableSeasonNumbers.length,
      seasons: seasonInfo,
      availableSeasonNumbers,
      kitsuDetails: kitsuDetails.map(item => ({
        id: parseInt(item.id, 10),
        title: item.attributes?.canonicalTitle,
        subtype: item.attributes?.subtype,
        startDate: item.attributes?.startDate,
        episodeCount: item.attributes?.episodeCount
      }))
    };
  } catch (error) {
    logger.error(`[ID Mapper] Error getting franchise info for IMDb ${imdbId}:`, error);
    return null;
  }
}

/**
 * Determines if episode-level mapping is needed based on Kitsu vs TMDB season count
 */
function determineIfEpisodeMappingNeeded(tvSeriesCount, ovaCount) {
  // If we have multiple TV series, we likely need episode mapping
  // This handles cases like "Dan Da Dan" where 2 Kitsu seasons = 1 TMDB season
  return tvSeriesCount > 1;
}

/**
 * Resolves Kitsu ID and episode number for a specific episode when episode-level mapping is needed.
 * This handles cases where multiple Kitsu entries map to a single TVDB season.
 * 
 * @param {string|number} tvdbId - The TVDB ID
 * @param {number} seasonNumber - The TVDB season number
 * @param {number} episodeNumber - The episode number
 * @returns {Promise<{kitsuId: number, episodeNumber: number}|null>} - The Kitsu ID and episode number for this specific episode
 */
async function resolveKitsuIdForEpisodeByTvdb(tvdbId, seasonNumber, episodeNumber, episodeAirDate = null) {
  if (!isInitialized) return null;
  const franchiseInfo = await getFranchiseInfoFromTvdbId(tvdbId);
  if (!franchiseInfo || !franchiseInfo.needsEpisodeMapping) {
    logger.warn(`[ID Mapper] Episode-level mapping not needed for TVDB ${tvdbId}`);
    return null;
  }
  logger.debug(`[ID Mapper] Resolving episode-level mapping for TVDB ${tvdbId} S${seasonNumber}E${episodeNumber}`);
  
  try {
    const kitsuEntries = franchiseInfo.kitsuDetails
      .filter(entry => entry.subtype?.toLowerCase() === 'tv')
      .sort((a, b) => new Date(a.startDate || '9999-12-31') - new Date(b.startDate || '9999-12-31'));
      
    if (kitsuEntries.length === 0) {
      logger.warn(`[ID Mapper] No TV series found for episode-level mapping`);
      return null;
    }
    
    // Strategy 1: Use episode number ranges if available
    // Each Kitsu entry starts from episode 1, so we need to map TVDB episode numbers to Kitsu episode numbers
    let cumulativeEpisodes = 0;
    for (const kitsuEntry of kitsuEntries) {
      const episodeCount = kitsuEntry.episodeCount || 0;
      const startEpisode = cumulativeEpisodes + 1;
      const endEpisode = cumulativeEpisodes + episodeCount;
      
      if (episodeNumber >= startEpisode && episodeNumber <= endEpisode) {
        // Calculate the Kitsu episode number (reset to 1 for each Kitsu entry)
        const kitsuEpisodeNumber = episodeNumber - cumulativeEpisodes;
        logger.debug(`[ID Mapper] Episode ${episodeNumber} maps to Kitsu ID ${kitsuEntry.id} episode ${kitsuEpisodeNumber} (TMDB range ${startEpisode}-${endEpisode})`);
        return {
          kitsuId: kitsuEntry.id,
          episodeNumber: kitsuEpisodeNumber
        };
      }
      
      cumulativeEpisodes = endEpisode;
    }
    
    // Strategy 2: Use air date if available
    if (episodeAirDate) {
      const targetDate = new Date(episodeAirDate);
      if (!isNaN(targetDate.getTime())) {
        // Find the Kitsu entry that was airing around this time
        for (const kitsuEntry of kitsuEntries) {
          if (kitsuEntry.startDate) {
            const kitsuStartDate = new Date(kitsuEntry.startDate);
            const kitsuEndDate = new Date(kitsuEntry.startDate);
            kitsuEndDate.setDate(kitsuEndDate.getDate() + (kitsuEntry.episodeCount * 7)); // Rough estimate
            
            if (targetDate >= kitsuStartDate && targetDate <= kitsuEndDate) {
              logger.debug(`[ID Mapper] Episode ${episodeNumber} (${episodeAirDate}) maps to Kitsu ID ${kitsuEntry.id} by air date`);
              // For air date strategy, we can't determine exact episode number, so use 1 as fallback
              return {
                kitsuId: kitsuEntry.id,
                episodeNumber: 1
              };
            }
          }
        }
      }
    }
    
    // Strategy 3: Fallback to first Kitsu entry
    logger.debug(`[ID Mapper] Using fallback: episode ${episodeNumber} maps to first Kitsu ID ${kitsuEntries[0].id}`);
    return {
      kitsuId: kitsuEntries[0].id,
      episodeNumber: 1
    };
    
  } catch (error) {
    logger.error(`[ID Mapper] Error in episode-level mapping for TMDB ${tmdbId} S${seasonNumber}E${episodeNumber}:`, error);
    return null;
  }
}

/**
 * Resolves Kitsu ID and episode number for a specific episode when episode-level mapping is needed.
 * This handles cases where multiple Kitsu entries map to a single TMDB season.
 * 
 * @param {string|number} tmdbId - The TMDB ID
 * @param {number} seasonNumber - The TMDB season number
 * @param {number} episodeNumber - The episode number
 * @param {string} episodeAirDate - The episode air date (optional)
 * @returns {Promise<{kitsuId: number, episodeNumber: number}|null>} - The Kitsu ID and episode number for this specific episode
 */
async function resolveKitsuIdForEpisodeByTmdb(tmdbId, seasonNumber, episodeNumber, episodeAirDate = null) {
  if (!isInitialized) return null;
  
  const franchiseInfo = await getFranchiseInfoFromTmdbId(tmdbId);
  if (!franchiseInfo || !franchiseInfo.needsEpisodeMapping) {
    logger.warn(`[ID Mapper] Episode-level mapping not needed for TMDB ${tmdbId}`);
    return null;
  }
  
  logger.debug(`[ID Mapper] Resolving episode-level mapping for TMDB ${tmdbId} S${seasonNumber}E${episodeNumber}`);
  
  try {
    // Get all Kitsu entries for this TMDB ID
    const kitsuEntries = franchiseInfo.kitsuDetails
      .filter(entry => entry.subtype?.toLowerCase() === 'tv')
      .sort((a, b) => new Date(a.startDate || '9999-12-31') - new Date(b.startDate || '9999-12-31'));
    
    if (kitsuEntries.length === 0) {
      logger.warn(`[ID Mapper] No TV series found for episode-level mapping`);
      return null;
    }
    
    // Determine mapping strategy based on scenario:
    // - If Season 1 with multiple Kitsu entries → Use episode-based mapping (e.g., Solo Leveling: 1 TMDB season, 2 Kitsu entries)
    // - If Season 2+ → Use season-based mapping (e.g., To Your Eternity: 3 TMDB seasons, 3 Kitsu entries)
    // - If Season 1 with single Kitsu entry → Use season-based mapping (simple case)
    
    const isSeason1 = seasonNumber === 1;
    const hasMultipleKitsuEntries = kitsuEntries.length > 1;
    
    // Strategy 1: Try episode-based mapping first for Season 1 with multiple Kitsu entries
    // For cases like Solo Leveling where 1 TMDB season spans multiple Kitsu entries
    if (isSeason1 && hasMultipleKitsuEntries) {
      let cumulativeEpisodes = 0;
      for (const kitsuEntry of kitsuEntries) {
        const episodeCount = kitsuEntry.episodeCount || 0;
        const startEpisode = cumulativeEpisodes + 1;
        const endEpisode = cumulativeEpisodes + episodeCount;
        
        if (episodeNumber >= startEpisode && episodeNumber <= endEpisode) {
          // Calculate the Kitsu episode number (reset to 1 for each Kitsu entry)
          const kitsuEpisodeNumber = episodeNumber - cumulativeEpisodes;
          logger.debug(`[ID Mapper] Season 1 Episode ${episodeNumber} maps to Kitsu ID ${kitsuEntry.id} episode ${kitsuEpisodeNumber} (episode-based mapping, range ${startEpisode}-${endEpisode})`);
          return {
            kitsuId: kitsuEntry.id,
            episodeNumber: kitsuEpisodeNumber
          };
        }
        
        cumulativeEpisodes = endEpisode;
      }
      // If episode number is beyond all cumulative ranges, fall through to season-based mapping
    }
    
    // Strategy 2: Hopes and prayers - Season-based mapping (for Season 2+ or Season 1 when episode-based didn't match)
    // TMDB Season 1 → Kitsu Entry 0, Season 2 → Entry 1, etc.
    // Note: TMDB seasons are 1-based, Kitsu entries array is 0-based
    const seasonIndex = seasonNumber - 1;
    
    if (seasonIndex >= 0 && seasonIndex < kitsuEntries.length) {
      const kitsuEntry = kitsuEntries[seasonIndex];
      logger.debug(`[ID Mapper] TMDB Season ${seasonNumber} maps directly to Kitsu ID ${kitsuEntry.id}, Episode ${episodeNumber} (season-based mapping)`);
      return {
        kitsuId: kitsuEntry.id,
        episodeNumber: episodeNumber
      };
    }
    
    // Strategy 3: Fallback to episode number ranges if season mapping doesn't work
    // Each Kitsu entry starts from episode 1, so we need to map TMDB episode numbers to Kitsu episode numbers
    let cumulativeEpisodes = 0;
    for (const kitsuEntry of kitsuEntries) {
      const episodeCount = kitsuEntry.episodeCount || 0;
      const startEpisode = cumulativeEpisodes + 1;
      const endEpisode = cumulativeEpisodes + episodeCount;
      
      if (episodeNumber >= startEpisode && episodeNumber <= endEpisode) {
        // Calculate the Kitsu episode number (reset to 1 for each Kitsu entry)
        const kitsuEpisodeNumber = episodeNumber - cumulativeEpisodes;
        logger.debug(`[ID Mapper] Episode ${episodeNumber} maps to Kitsu ID ${kitsuEntry.id} episode ${kitsuEpisodeNumber} (fallback, range ${startEpisode}-${endEpisode})`);
        return {
          kitsuId: kitsuEntry.id,
          episodeNumber: kitsuEpisodeNumber
        };
      }
      
      cumulativeEpisodes = endEpisode;
    }
    
    // Strategy 4: Inchallah - Use air date if available (fallback if season/episode mapping failed)
    if (episodeAirDate) {
      const targetDate = new Date(episodeAirDate);
      if (!isNaN(targetDate.getTime())) {
        // Find the Kitsu entry that was airing around this time
        for (const kitsuEntry of kitsuEntries) {
          if (kitsuEntry.startDate) {
            const kitsuStartDate = new Date(kitsuEntry.startDate);
            const kitsuEndDate = new Date(kitsuEntry.startDate);
            kitsuEndDate.setDate(kitsuEndDate.getDate() + (kitsuEntry.episodeCount * 7)); // Rough estimate
            
            if (targetDate >= kitsuStartDate && targetDate <= kitsuEndDate) {
              logger.debug(`[ID Mapper] Episode S${seasonNumber}E${episodeNumber} (${episodeAirDate}) maps to Kitsu ID ${kitsuEntry.id} by air date`);
              // Use the episode number from TMDB directly
              return {
                kitsuId: kitsuEntry.id,
                episodeNumber: episodeNumber
              };
            }
          }
        }
      }
    }
    
    // Strategy 5: cooked - Fallback to first Kitsu entry if season is out of range
    logger.debug(`[ID Mapper] Using fallback: Season ${seasonNumber} is out of range, mapping to first Kitsu ID ${kitsuEntries[0].id}`);
    return {
      kitsuId: kitsuEntries[0].id,
      episodeNumber: episodeNumber
    };
    
  } catch (error) {
    logger.error(`[ID Mapper] Error in episode-level mapping for TMDB ${tmdbId} S${seasonNumber}E${episodeNumber}:`, error);
    return null;
  }
}

/**
 * Resolves TMDB season and episode number from a Kitsu ID and episode number.
 * 
 * @param {string|number} kitsuId
 * @param {number} kitsuEpisodeNumber
 * @param {object} config - Optional config object containing API keys (needed for TMDB API calls)
 * @returns {Promise<{tmdbId: number, seasonNumber: number, episodeNumber: number}|null>} - The TMDB ID, season, and episode number
 */
async function resolveTmdbEpisodeFromKitsu(kitsuId, kitsuEpisodeNumber, config = {}) {
  if (!isInitialized) return null;

  const mapping = getMappingByKitsuId(kitsuId);
  if (!mapping || !mapping.themoviedb_id) {
    logger.warn(`[ID Mapper] No TMDB mapping found for Kitsu ID ${kitsuId}`);
    return null;
  }

  const tmdbId = mapping.themoviedb_id;
  logger.debug(`[ID Mapper] Resolving TMDB episode from Kitsu ID ${kitsuId} episode ${kitsuEpisodeNumber} (TMDB ID: ${tmdbId})`);

  try {
    const franchiseInfo = await getFranchiseInfoFromTmdbId(tmdbId);
    if (!franchiseInfo) {
      logger.warn(`[ID Mapper] No franchise info found for TMDB ID ${tmdbId}`);
      return null;
    }

    const kitsuEntries = franchiseInfo.kitsuDetails
      .filter(entry => entry.subtype?.toLowerCase() === 'tv')
      .sort((a, b) => new Date(a.startDate || '9999-12-31') - new Date(b.startDate || '9999-12-31'));

    const kitsuEntryIndex = kitsuEntries.findIndex(entry => entry.id === parseInt(kitsuId, 10));
    if (kitsuEntryIndex === -1) {
      logger.warn(`[ID Mapper] Kitsu ID ${kitsuId} not found in franchise entries for TMDB ${tmdbId}`);
      // Fallback for cases where Kitsu entry is not in franchise (e.g. OVA)
      // We can assume it is the first entry and has no predecessors
      const tmdbSeasonData = await getTmdbSeasonInfo(tmdbId, config);
      let cumulativeEpisodes = 0;
      for (const season of tmdbSeasonData) {
        if (season.season_number === 0) continue;
        if (kitsuEpisodeNumber <= cumulativeEpisodes + season.episode_count) {
          const tmdbSeasonNumber = season.season_number;
          const tmdbEpisodeNumber = kitsuEpisodeNumber - cumulativeEpisodes;
          logger.debug(`[ID Mapper] Kitsu ID ${kitsuId} (not in franchise) maps to TMDB ${tmdbId} S${tmdbSeasonNumber}E${tmdbEpisodeNumber}`);
          return { tmdbId, seasonNumber: tmdbSeasonNumber, episodeNumber: tmdbEpisodeNumber, isFranchiseFallback: true };
        }
        cumulativeEpisodes += season.episode_count;
      }
      return null;
    }

    let absoluteEpisodeNumber = kitsuEpisodeNumber;
    for (let i = 0; i < kitsuEntryIndex; i++) {
      absoluteEpisodeNumber += kitsuEntries[i].episodeCount || 0;
    }

    const tmdbSeasons = await getTmdbSeasonInfo(tmdbId, config);
    if (!tmdbSeasons || tmdbSeasons.length === 0) {
      logger.warn(`[ID Mapper] No TMDB season data found for ${tmdbId}`);
      // Fallback to old logic if TMDB seasons are not available
      const tmdbSeasonNumber = kitsuEntryIndex + 1;
      return { tmdbId, seasonNumber: tmdbSeasonNumber, episodeNumber: kitsuEpisodeNumber, isFranchiseFallback: false };
    }

    let cumulativeEpisodes = 0;
    for (const season of tmdbSeasons) {
      if (season.season_number === 0) continue; // Skip specials

      const seasonEpisodeCount = season.episode_count;
      if (absoluteEpisodeNumber <= cumulativeEpisodes + seasonEpisodeCount) {
        const tmdbSeasonNumber = season.season_number;
        const relativeEpisodeNumber = absoluteEpisodeNumber - cumulativeEpisodes;
        let tmdbEpisodeNumber;

        // Special case for One Piece (TMDB ID 37854) as TMDB uses absolute episode numbers for it.
        if (tmdbId === 37854) {
          tmdbEpisodeNumber = absoluteEpisodeNumber;
        } else {
          tmdbEpisodeNumber = relativeEpisodeNumber;
        }
        
        logger.debug(`[ID Mapper] Kitsu ${kitsuId} Ep ${kitsuEpisodeNumber} (Absolute: ${absoluteEpisodeNumber}) -> TMDB ${tmdbId} S${tmdbSeasonNumber}E${tmdbEpisodeNumber}`);
        return {
          tmdbId: tmdbId,
          seasonNumber: tmdbSeasonNumber,
          episodeNumber: tmdbEpisodeNumber,
          relativeEpisodeNumber: relativeEpisodeNumber,
          isFranchiseFallback: false
        };
      }
      cumulativeEpisodes += seasonEpisodeCount;
    }

    logger.warn(`[ID Mapper] Episode ${absoluteEpisodeNumber} exceeds total episodes in TMDB for ${tmdbId}.`);
    return null;

  } catch (error) {
    logger.error(`[ID Mapper] Error resolving TMDB episode from Kitsu ID ${kitsuId} episode ${kitsuEpisodeNumber}:`, error);
    return null;
  }
}

/**
 * Resolves Kitsu ID and episode number for a specific episode when episode-level mapping is needed (IMDb version).
 * This handles cases where multiple Kitsu entries map to a single IMDb season.
 * 
 * @param {string|number} imdbId - The IMDb ID
 * @param {number} seasonNumber - The IMDb season number
 * @param {number} episodeNumber - The episode number
 * @param {string} episodeAirDate - The episode air date (optional)
 * @returns {Promise<{kitsuId: number, episodeNumber: number}|null>} - The Kitsu ID and episode number for this specific episode
 */
async function resolveKitsuIdForEpisodeByImdb(imdbId, seasonNumber, episodeNumber, episodeAirDate = null) {
  if (!isInitialized) return null;
  try {
    const franchiseInfo = await getFranchiseInfoFromImdbId(imdbId);
    if (!franchiseInfo || !franchiseInfo.kitsuDetails) {
      logger.warn(`[ID Mapper] [IMDb] No franchise info found for IMDb ${imdbId}`);
      return null;
    }
    // If only one TV series, no episode-level mapping needed
    const tvSeries = franchiseInfo.kitsuDetails.filter(item => item.subtype?.toLowerCase() === 'tv');
    if (tvSeries.length <= 1) {
      logger.debug(`[ID Mapper] [IMDb] Only one TV series for IMDb ${imdbId}, no episode-level mapping needed.`);
      return null;
    }
    // Multiple TV series: episode-level mapping needed
    let cumulativeEpisodes = 0;
    for (const kitsuEntry of tvSeries) {
      const epCount = kitsuEntry.episodeCount || 0;
      const startEp = cumulativeEpisodes + 1;
      const endEp = cumulativeEpisodes + epCount;
      if (episodeNumber >= startEp && episodeNumber <= endEp) {
        const kitsuEpisodeNumber = episodeNumber - cumulativeEpisodes;
        logger.debug(`[ID Mapper] [IMDb] Episode ${episodeNumber} maps to Kitsu ID ${kitsuEntry.id} episode ${kitsuEpisodeNumber} (IMDb range ${startEp}-${endEp})`);
        return { kitsuId: kitsuEntry.id, episodeNumber: kitsuEpisodeNumber };
      }
      cumulativeEpisodes = endEp;
    }
    // Fallback: try to use air date if provided
    if (episodeAirDate) {
      const targetDate = new Date(episodeAirDate);
      if (!isNaN(targetDate.getTime())) {
        for (const kitsuEntry of tvSeries) {
          if (kitsuEntry.startDate) {
            const kitsuStartDate = new Date(kitsuEntry.startDate);
            const kitsuEndDate = new Date(kitsuEntry.startDate);
            kitsuEndDate.setDate(kitsuEndDate.getDate() + (kitsuEntry.episodeCount * 7)); // Rough estimate
            if (targetDate >= kitsuStartDate && targetDate <= kitsuEndDate) {
              logger.debug(`[ID Mapper] [IMDb] Episode ${episodeNumber} (${episodeAirDate}) maps to Kitsu ID ${kitsuEntry.id} by air date`);
              return { kitsuId: kitsuEntry.id, episodeNumber: 1 };
            }
          }
        }
      }
    }
    // Fallback: use first TV series Kitsu entry
    if (tvSeries.length > 0) {
      logger.debug(`[ID Mapper] [IMDb] Fallback: episode ${episodeNumber} maps to first Kitsu ID ${tvSeries[0].id}`);
      return { kitsuId: tvSeries[0].id, episodeNumber: 1 };
    }
    return null;
  } catch (error) {
    logger.error(`[ID Mapper] [IMDb] Error in resolveKitsuIdForEpisodeByImdb for IMDb ${imdbId} S${seasonNumber}E${episodeNumber}:`, error);
    return null;
  }
}

/**
 * Determines the mapping scenario for better understanding of the relationship
 */
function determineMappingScenario(tvSeriesCount, ovaCount, totalSeasons) {
  if (tvSeriesCount === 1 && ovaCount === 0) {
    return 'single_tv_series';
  } else if (tvSeriesCount === 0 && ovaCount === 1) {
    return 'single_ova';
  } else if (tvSeriesCount > 1 && ovaCount === 0) {
    return 'multiple_tv_seasons';
  } else if (tvSeriesCount === 1 && ovaCount > 0) {
    return 'tv_series_with_ovas';
  } else if (tvSeriesCount > 1 && ovaCount > 0) {
    return 'multiple_tv_seasons_with_ovas';
  } else if (tvSeriesCount === 0 && ovaCount > 1) {
    return 'multiple_ovas_only';
  } else {
    return 'complex_mapping';
  }
}

/**
 * Gets all mapping statistics and data for monitoring/debugging
 */
function getAllMappings() {
  if (!isInitialized) return null;
  return {
    animeIdMapSize: animeIdMap.size,
    tvdbIdMapSize: tvdbIdToAnimeListMap.size,
    imdbIdMapSize: imdbIdToAnimeListMap.size,
    simklIdMapSize: simklIdMap.size, // Added stats
    tmdbIndexArraySize: tmdbIndexArray ? tmdbIndexArray.length : 0,
    animeIdMap: animeIdMap,
    tvdbIdToAnimeListMap: tvdbIdToAnimeListMap,
    imdbIdToAnimeListMap: imdbIdToAnimeListMap,
    tmdbIndexArray: tmdbIndexArray
  };
}

/**
 * Cleans up resources when the process exits
 */
function cleanup() {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
    logger.debug('[ID Mapper] Cleaned up update interval.');
  }
}

// Register cleanup on process exit
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

/**
 * Maps TMDB episodes to IMDB episodes when all TMDB seasons map to the same IMDB ID.
 * This handles cases where TMDB and IMDB have different season structures.
 * 
 * @param {string} tmdbId - TMDB series ID
 * @param {number} tmdbSeasonNumber - TMDB season number
 * @param {number} tmdbEpisodeNumber - TMDB episode number
 * @param {string} tmdbAirDate - TMDB episode air date
 * @param {string} commonImdbId - The IMDB ID that all TMDB seasons map to
 * @param {Array} cinemetaVideos - All episodes from Cinemeta for the IMDB series
 * @param {string} tmdbSeasonName - The TMDB season name used for name-to-imdb lookup
 * @returns {string|null} IMDB episode ID in format "tt123456:season:episode" or null if not found
 */
async function getImdbEpisodeIdFromTmdbEpisodeWhenAllSeasonsMapToSameImdb(
  tmdbId,
  tmdbSeasonNumber,
  tmdbEpisodeNumber,
  tmdbAirDate,
  commonImdbId,
  cinemetaVideos,
  tmdbSeasonName
) {
  try {
    // Get all episodes from the common IMDB ID
    const imdbEpisodes = cinemetaVideos.filter(ep => ep.season !==0)
    
    if (!imdbEpisodes.length) {
      logger.warn(`[ID Mapper] No IMDB episodes found for ${commonImdbId}`);
      return null;
    }

    // Group IMDB episodes by season
    const imdbSeasons = new Map();
    imdbEpisodes.forEach(ep => {
      if (!imdbSeasons.has(ep.season)) {
        imdbSeasons.set(ep.season, []);
      }
      imdbSeasons.get(ep.season).push(ep);
    });

    // Find which IMDB season(s) this TMDB season maps to
    const mappedImdbSeasons = findImdbSeasonsForTmdbSeason(
      tmdbSeasonNumber,
      tmdbSeasonName,
      imdbSeasons,
      tmdbAirDate
    );

    if (!mappedImdbSeasons.length) {
      logger.warn(`[ID Mapper] No IMDB seasons mapped for TMDB season ${tmdbSeasonNumber}`);
      return null;
    }

    // Find the specific episode within the mapped IMDB seasons using air date
    const imdbEpisode = findImdbEpisodeByAirDate(
      tmdbAirDate,
      mappedImdbSeasons,
      2, // ±2 days tolerance
      tmdbEpisodeNumber
    );

    if (imdbEpisode) {
      return `${commonImdbId}:${imdbEpisode.season}:${imdbEpisode.episode}`;
    }

    logger.warn(`[ID Mapper] No IMDB episode found for TMDB S${tmdbSeasonNumber}E${tmdbEpisodeNumber} (air date: ${tmdbAirDate})`);
    return null;

  } catch (error) {
    logger.error(`[ID Mapper] Error mapping TMDB episode to IMDB:`, error);
    return null;
  }
}

/**
 * Finds which IMDB seasons a TMDB season maps to based on air date and season structure.
 */
function findImdbSeasonsForTmdbSeason(tmdbSeasonNumber, tmdbSeasonName, imdbSeasons, tmdbAirDate) {
  const imdbSeasonArray = Array.from(imdbSeasons.entries());
  
  // Strategy 1: Try to find IMDB seasons with episodes around the TMDB air date
  const targetDate = new Date(tmdbAirDate);
  const candidateSeasons = [];

  for (const [imdbSeasonNum, imdbSeasonEpisodes] of imdbSeasonArray) {
    const seasonEpisodes = imdbSeasonEpisodes.filter(ep => ep.released);
    if (seasonEpisodes.length === 0) continue;

    const seasonStartDate = new Date(Math.min(...seasonEpisodes.map(ep => new Date(ep.released))));
    const seasonEndDate = new Date(Math.max(...seasonEpisodes.map(ep => new Date(ep.released))));

    // Check if TMDB air date falls within this IMDB season's date range
    if (targetDate >= seasonStartDate && targetDate <= seasonEndDate) {
      candidateSeasons.push([imdbSeasonNum, imdbSeasonEpisodes]);
    }
  }

       if (candidateSeasons.length > 0) {
       return candidateSeasons;
     }

       // Strategy 2: Fallback to season number matching (1:1 mapping) - only if we have exactly one IMDB season
     if (imdbSeasons.has(tmdbSeasonNumber) && imdbSeasonArray.length === 1) {
       return [[tmdbSeasonNumber, imdbSeasons.get(tmdbSeasonNumber)]];
     }

       // Strategy 3: Return all IMDB seasons if no specific mapping found or multiple IMDB seasons exist
     return imdbSeasonArray;
}

/**
 * Finds an IMDB episode by air date within the given IMDB seasons.
 */
function findImdbEpisodeByAirDate(tmdbAirDate, mappedImdbSeasons, toleranceDays = 2, tmdbEpisodeNumber = null) {
  const targetDate = new Date(tmdbAirDate);
  const toleranceMs = toleranceDays * 24 * 60 * 60 * 1000;

  // First pass: try to find exact match by date and episode number
  if (tmdbEpisodeNumber) {
    for (const [imdbSeasonNum, imdbSeasonEpisodes] of mappedImdbSeasons) {
      for (const episode of imdbSeasonEpisodes) {
        if (!episode.released) continue;

        const episodeDate = new Date(episode.released);
        const dateDiff = Math.abs(targetDate - episodeDate);

        if (dateDiff <= toleranceMs && episode.episode === tmdbEpisodeNumber) {
          return {
            season: imdbSeasonNum,
            episode: episode.episode
          };
        }
      }
    }
  }

  // Second pass: just by date (fallback for when episode numbers don't align)
  for (const [imdbSeasonNum, imdbSeasonEpisodes] of mappedImdbSeasons) {
    for (const episode of imdbSeasonEpisodes) {
      if (!episode.released) continue;

      const episodeDate = new Date(episode.released);
      const dateDiff = Math.abs(targetDate - episodeDate);

      if (dateDiff <= toleranceMs) {
        return {
          season: imdbSeasonNum,
          episode: episode.episode
        };
      }
    }
  }

  return null;
}

/**
 * Gets the Trakt anime movie mapping for a MAL ID
 * @param {string|number} malId - The MyAnimeList ID
 * @returns {Object|null} The Trakt mapping object or null if not found
 */
function getTraktAnimeMovieByMalId(malId) {
  if (!isTraktAnimeMoviesInitialized) {
    logger.warn('[ID Mapper] [Trakt-Anime-Movies] Mapper is not initialized. Returning null.');
    return null;
  }
  const numericMalId = parseInt(malId, 10);
  return malIdToTraktMovieMap.get(numericMalId) || null;
}

/**
 * Gets the Trakt anime movie mapping for a TMDB ID
 * @param {string|number} tmdbId - The TMDB ID
 * @returns {Object|null} The Trakt mapping object or null if not found
 */
function getTraktAnimeMovieByTmdbId(tmdbId) {
  if (!isTraktAnimeMoviesInitialized) {
    logger.warn('[ID Mapper] [Trakt-Anime-Movies] Mapper is not initialized. Returning null.');
    return null;
  }
  const numericTmdbId = parseInt(tmdbId, 10);
  return tmdbIdToTraktMovieMap.get(numericTmdbId) || null;
}

/**
 * Gets the Trakt anime movie mapping for an IMDB ID
 * @param {string} imdbId - The IMDB ID (e.g., 'tt0275277')
 * @returns {Object|null} The Trakt mapping object or null if not found
 */
function getTraktAnimeMovieByImdbId(imdbId) {
  if (!isTraktAnimeMoviesInitialized) {
    logger.warn('[ID Mapper] [Trakt-Anime-Movies] Mapper is not initialized. Returning null.');
    return null;
  }
  return imdbIdToTraktMovieMap.get(imdbId) || null;
}

/**
 * Force update the ID Mapper (Fribb's Anime-List)
 * @returns {Promise<Object>} Result object with success, message, and count
 */
async function forceUpdateIdMapper() {
  logger.info('[ID Mapper] Force update requested for ID Mapper...');
  try {
    const result = await downloadAndProcessAnimeList(true);
    return result;
  } catch (error) {
    logger.error('[ID Mapper] Force update failed:', error.message);
    return { success: false, message: `Force update failed: ${error.message}`, count: animeIdMap.size };
  }
}

/**
 * Force update the Kitsu-IMDB Mapping
 * @returns {Promise<Object>} Result object with success, message, and count
 */
async function forceUpdateKitsuImdbMapping() {
  logger.info('[ID Mapper] Force update requested for Kitsu-IMDB Mapping...');
  try {
    const result = await downloadAndProcessKitsuToImdbMapping(true);
    return result;
  } catch (error) {
    logger.error('[ID Mapper] Force update failed:', error.message);
    return { success: false, message: `Force update failed: ${error.message}`, count: kitsuToImdbMapping ? Object.keys(kitsuToImdbMapping).length : 0 };
  }
}

/**
 * Get stats for the ID Mapper (for dashboard display)
 * @returns {Object} Stats object with count, updateInterval, and initialized status
 */
function getIdMapperStats() {
  return {
    count: animeIdMap.size,
    updateIntervalHours: UPDATE_INTERVAL_HOURS,
    initialized: isInitialized,
    cacheStats: {
      franchiseMap: {
        size: franchiseMapCache.size,
        max: FRANCHISE_MAP_CACHE_MAX_SIZE
      },
      tmdbFranchiseInfo: {
        size: tmdbFranchiseInfoCache.size,
        max: TMDB_FRANCHISE_INFO_CACHE_MAX_SIZE
      },
      tmdbSeason: {
        size: tmdbSeasonCache.size,
        max: TMDB_SEASON_CACHE_MAX_SIZE
      }
    }
  };
}

/**
 * Get stats for the Kitsu-IMDB Mapping (for dashboard display)
 * @returns {Object} Stats object with count, updateInterval, and initialized status
 */
function getKitsuImdbStats() {
  return {
    count: kitsuToImdbMappingCount, // O(1) - uses pre-computed count
    updateIntervalHours: UPDATE_INTERVAL_KITSU_TO_IMDB_HOURS,
    initialized: isKitsuToImdbInitialized,
    resolverCache: {
      size: kitsuToImdbCache.size,
      max: KITSU_TO_IMDB_CACHE_MAX_SIZE
    }
  };
}

module.exports = {
  initializeMapper,
  getMappingByMalId,
  getMappingByTmdbId,
  getMappingByTvdbId,
  getMappingByImdbId,
  getMappingByKitsuId,
  getMappingBySimklId,
  resolveKitsuIdFromTvdbSeason,
  resolveKitsuIdFromTmdbSeason,
  resolveKitsuIdForEpisodeByTmdb,
  resolveKitsuIdForEpisodeByImdb,
  getImdbEpisodeIdFromTmdbEpisode,
  getCinemetaVideosForImdbSeries,
  resolveImdbSeasonFromKitsu,
  getFranchiseInfoFromTvdbId,
  getFranchiseInfoFromTmdbId,
  getFranchiseInfoFromImdbId,
  getMappingByAnidbId,
  getMappingByAnilistId,
  getAnimeTypeFromAnilistId,
  getAnimeTypeFromKitsuId,
  getAnimeTypeFromMalId,
  getAnimeTypeFromAnidbId,
  getKitsuToImdbMapping,
  getKitsuToImdbMappingsByImdbId,
  enrichMalEpisodes,
  resolveKitsuIdForEpisodeByTvdb,
  resolveKitsuIdForEpisodeByTmdb,
  resolveTmdbEpisodeFromKitsu,
  getImdbEpisodeIdFromTmdbEpisodeWhenAllSeasonsMapToSameImdb,
  getAllMappings,
  cleanup,
  getCinemetaVideosForImdbIoSeries,
  getTraktAnimeMovieByMalId,
  getTraktAnimeMovieByTmdbId,
  getTraktAnimeMovieByImdbId,
  forceUpdateIdMapper,
  forceUpdateKitsuImdbMapping,
  getIdMapperStats,
  getKitsuImdbStats,
  isInitialized: () => isInitialized
};
