
const idMapper = require('./id-mapper');
const tvdb = require('./tvdb');
const tvmaze = require('./tvmaze');
const moviedb = require("./getTmdb");
const redisIdCache = require('./redis-id-cache');
const timingMetrics = require('./timing-metrics');
const consola = require('consola');
const { httpGet } = require('../utils/httpClient');
const { mappings } = require('./wiki-mapper.js');

const logger = consola.create({ 
  level: process.env.LOG_LEVEL ? 
    (consola.LogLevels[process.env.LOG_LEVEL.toLowerCase()] ?? 4) : 
    (process.env.NODE_ENV === 'production' ? 3 : 4),
  fancy: true,
  colors: true,
  formatOptions: {
    colors: true,
    compact: false,
    date: false
  },
  tag: 'ID-Resolver'
});

// Performance tracking counters
let performanceStats = {
  totalResolutions: 0,
  wikiMappingEarlyReturns: 0,
  cacheEarlyReturns: 0,
  apiCallsRequired: 0,
  animeResolutions: 0
};

/**
 * Parses the initial Stremio ID into a usable object.
 * @private
 */
function _parseStremioId(stremioId) {
  const ids = { tmdbId: null, tvdbId: null, imdbId: null, tvmazeId: null, malId: null, kitsuId: null, anidbId: null, anilistId: null };
  if (stremioId.startsWith('tt')) {
    ids.imdbId = stremioId;
    return ids;
  }
  const [prefix, sourceId] = stremioId.split(':');
  const key = `${prefix}Id`;
  if (key in ids) {
    ids[key] = sourceId;
  }
  return ids;
}

/**
 * Handles the fast, local mapping for anime IDs.
 * @private
 */
function _handleAnimeMapping(allIds) {
  const providers = ['mal', 'kitsu', 'anidb', 'anilist'];
  const mappingFunctions = {
    mal: idMapper.getMappingByMalId,
    kitsu: idMapper.getMappingByKitsuId,
    anidb: idMapper.getMappingByAnidbId,
    anilist: idMapper.getMappingByAnilistId
  };

  for (const provider of providers) {
    const id = allIds[`${provider}Id`];
    if (id) {
      const mapping = mappingFunctions[provider](id);
      if (mapping) {
        allIds.tmdbId = allIds.tmdbId || mapping.themoviedb_id;
        allIds.imdbId = allIds.imdbId || mapping.imdb_id;
        allIds.tvdbId = allIds.tvdbId || mapping.thetvdb_id;
        allIds.tvmazeId = allIds.tvmazeId || mapping.tvmaze_id;
        allIds.malId = allIds.malId || mapping.mal_id;
        allIds.kitsuId = allIds.kitsuId || mapping.kitsu_id;
        allIds.anidbId = allIds.anidbId || mapping.anidb_id;
        allIds.anilistId = allIds.anilistId || mapping.anilist_id;
      }
    }
  }
}

// --- Individual Provider Fetchers ---

async function _fetchFromTmdb(tmdbId, type, config) {
  if (!tmdbId) return {};
  const startTime = Date.now();
  try {
    logger.debug(`[API Fetch] TMDB External IDs for ${type} ${tmdbId}`);
    const externalIds = type === 'movie'
      ? await moviedb.movieExternalIds(tmdbId, config)
      : await moviedb.tvExternalIds(tmdbId, config);
    const duration = Date.now() - startTime;
    
    // Record timing metrics for TMDB external IDs
    await timingMetrics.recordTiming('tmdb_external_ids', duration, { 
      type, 
      tmdbId,
      success: true,
      method: 'dedicated_endpoint'
    });
    
    logger.debug(`[API Fetch] TMDB External IDs completed in ${duration}ms for ${type} ${tmdbId}`);
    
    return {
      imdbId: externalIds.imdb_id || null,
      tvdbId: externalIds.tvdb_id || null,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    await timingMetrics.recordTiming('tmdb_external_ids', duration, { 
      type, 
      tmdbId,
      success: false,
      method: 'dedicated_endpoint'
    });
    logger.warn(`[API Fetch] Failed to fetch from TMDB ${tmdbId}: ${error.message}`);
    return {};
  }
}

async function _fetchFromTvdb(tvdbId, type, config) {
  if (!tvdbId) return {};
  try {
    logger.debug(`[API Fetch] TVDB Remote IDs for ${type} ${tvdbId}`);
    const details = type === 'movie'
      ? await tvdb.getMovieExtended(tvdbId, config)
      : await tvdb.getSeriesExtended(tvdbId, config);

    const findId = (sourceName) => details.remoteIds?.find(id => id.sourceName === sourceName)?.id || null;
    
    return {
      imdbId: findId('IMDB'),
      tmdbId: findId('TheMovieDB.com'),
      tvmazeId: findId('TV Maze'),
    };
  } catch (error) {
    logger.warn(`[API Fetch] Failed to fetch from TVDB ${tvdbId}: ${error.message}`);
    return {};
  }
}

async function _fetchFromTvmaze(tvmazeId, config) {
  if (!tvmazeId) return {};
  try {
    logger.debug(`[API Fetch] TVmaze Externals for ${tvmazeId}`);
    const details = await tvmaze.getShowById(tvmazeId, config);
    return {
      imdbId: details.externals?.imdb || null,
      tmdbId: details.externals?.themoviedb || null,
      tvdbId: details.externals?.thetvdb || null,
    };
  } catch (error) {
    logger.warn(`[API Fetch] Failed to fetch from TVmaze ${tvmazeId}: ${error.message}`);
    return {};
  }
}

async function getExternalIdsFromImdb(imdbId, type) {
  if (!imdbId || imdbId.toString().trim() === '') return undefined;
  const url = `https://cinemeta-live.strem.io/meta/${type}/${imdbId}.json`;

  try {
    const { data } = await httpGet(url);
    const tvdbId = data?.meta?.tvdb_id || data?.meta?.thetvdb_id;
    const tmdbId = data?.meta?.moviedb_id || data?.meta?.themoviedb_id || data?.meta?.tmdb_id;
    return {
      tmdbId: (tmdbId && tmdbId.toString().trim() !== '') ? tmdbId : null,
      tvdbId: (tvdbId && tvdbId.toString().trim() !== '') ? tvdbId : null,
    };
  } catch (error) {
    logger.warn(`[Cinemeta] Could not fetch external ids for ${imdbId}: ${error.message}`);
    return undefined;
  }
}


// --- Main Orchestrator Function ---

async function resolveAllIds(stremioId, type, config, prefetchedIds = {}, targetProviders = []) {
  const startTime = Date.now();
  performanceStats.totalResolutions++;
  logger.debug(`Starting resolution for ${stremioId} (type: ${type})`);
  if (type !== 'movie' && type !== 'series' && type !== 'anime') {
    logger.warn(`Invalid type: ${type}`);
    return null;
  }

  // 1. Initialize IDs
  let allIds = { ..._parseStremioId(stremioId), ...prefetchedIds };
  const isAnime = type === 'anime' || allIds.malId || allIds.kitsuId || allIds.anidbId || allIds.anilistId;


  // 2. Handle Anime
  if (isAnime) {
    performanceStats.animeResolutions++;
    _handleAnimeMapping(allIds);
    const duration = Date.now() - startTime;
    await timingMetrics.recordTiming('id_resolution_anime', duration, { 
      type, 
      stremioId,
      cached: false,
      resolution_type: 'anime_mapping'
    });
    logger.success(` Anime resolution complete for ${stremioId} (took ${duration}ms)`);
    return allIds;
  }

  // 3. Check Cache
  if (!isAnime) {
    // 1.5. Check wiki mappings first for fast resolution
    try {
      let wikiMapping = null;
      if (allIds.tmdbId && (type === 'movie' || type === 'series')) {
        wikiMapping = await mappings.getByTmdbId(allIds.tmdbId.toString(), type);
      } else if (allIds.tvdbId && (type === 'movie' || type === 'series')) {
        wikiMapping = await mappings.getByTvdbId(allIds.tvdbId.toString());
      } else if (allIds.imdbId && (type === 'movie' || type === 'series')) {
        wikiMapping = await mappings.getByImdbId(allIds.imdbId, type);
      } else if (allIds.tvmazeId && type === 'series') {
        wikiMapping = await mappings.getSeriesByTvmaze(allIds.tvmazeId.toString());
      }
      
      if (wikiMapping) {
        // Merge wiki mapping data with existing IDs
        if (wikiMapping.imdbId && !allIds.imdbId) allIds.imdbId = wikiMapping.imdbId;
        if (wikiMapping.tvdbId && !allIds.tvdbId) allIds.tvdbId = wikiMapping.tvdbId;
        if (wikiMapping.tmdbId && !allIds.tmdbId) allIds.tmdbId = wikiMapping.tmdbId;
        if (wikiMapping.tvmazeId && !allIds.tvmazeId) allIds.tvmazeId = wikiMapping.tvmazeId;
        
        logger.debug(`Wiki mapping found for ${stremioId}:`, { imdbId: allIds.imdbId, tvdbId: allIds.tvdbId, tmdbId: allIds.tmdbId, tvmazeId: allIds.tvmazeId });
        
        // Check if we have all target providers - if so, return early
        if (targetProviders.length > 0) {
          const hasAllTargets = targetProviders.every(provider => {
            switch (provider) {
              case 'imdb': return allIds.imdbId;
              case 'tvdb': return allIds.tvdbId;
              case 'tmdb': return allIds.tmdbId;
              case 'tvmaze': return allIds.tvmazeId;
              default: return false;
            }
          });
          
          if (hasAllTargets) {
            performanceStats.wikiMappingEarlyReturns++;
            const duration = Date.now() - startTime;
            await timingMetrics.recordTiming('id_resolution_wiki', duration, { 
              type, 
              stremioId,
              cached: false,
              resolution_type: 'wiki_mapping_complete'
            });
            logger.success(` Wiki mapping provided all target providers for ${stremioId} (took ${duration}ms)`);
            return allIds;
          }
        }
      }
    } catch (error) {
      logger.warn(`Wiki mapping lookup failed for ${stremioId}:`, error.message);
    }


    const cachedMapping = await redisIdCache.getCachedIdMapping(type, allIds.tmdbId, allIds.tvdbId, allIds.imdbId, allIds.tvmazeId);
    if (cachedMapping) {
      performanceStats.cacheEarlyReturns++;
      logger.debug(` Found cached mapping for ${stremioId}`);
      allIds.tmdbId = allIds.tmdbId || cachedMapping.tmdb_id;
      allIds.tvdbId = allIds.tvdbId || cachedMapping.tvdb_id;
      allIds.imdbId = allIds.imdbId || cachedMapping.imdb_id;
      allIds.tvmazeId = allIds.tvmazeId || cachedMapping.tvmaze_id;
      const duration = Date.now() - startTime;
      await timingMetrics.recordTiming('id_resolution_cache', duration, { 
        type, 
        stremioId,
        cached: true,
        resolution_type: 'cache_hit'
      });
      logger.success(` Cache hit resolution complete for ${stremioId} (took ${duration}ms)`);
      return allIds;
    }
    logger.debug(` No cache hit for ${stremioId}, proceeding to API lookups.`);
  }

  // 4. Perform API Lookups in PARALLEL
  performanceStats.apiCallsRequired++;
  const apiStartTime = Date.now();
  try {
    // Phase 1: Primary lookups based on existing IDs
    if (allIds.imdbId && !allIds.tmdbId && !allIds.tvdbId) {
      const cinemetaIds = await getExternalIdsFromImdb(allIds.imdbId, type);
      if (cinemetaIds) {
        allIds.tmdbId = allIds.tmdbId || cinemetaIds.tmdbId;
        allIds.tvdbId = allIds.tvdbId || cinemetaIds.tvdbId;
      }
    }

    const primaryPromises = [];
    if (allIds.tmdbId && (!allIds.imdbId || !allIds.tvdbId)) {
      primaryPromises.push(_fetchFromTmdb(allIds.tmdbId, type, config));
    }
    if (allIds.tvmazeId && (!allIds.imdbId || !allIds.tmdbId || !allIds.tvdbId)) {
      primaryPromises.push(_fetchFromTvmaze(allIds.tvmazeId, config));
    }
    if (allIds.tvdbId && (!allIds.imdbId || !allIds.tmdbId || !allIds.tvmazeId)) {
      primaryPromises.push(_fetchFromTvdb(allIds.tvdbId, type, config));
    }
    
    const primaryResults = await Promise.allSettled(primaryPromises);
    for (const result of primaryResults) {
      if (result.status === 'fulfilled' && result.value) {
        const { tmdbId, tvdbId, imdbId, tvmazeId } = result.value;

        allIds.tmdbId = allIds.tmdbId || tmdbId;
        allIds.tvdbId = allIds.tvdbId || tvdbId;
        allIds.imdbId = allIds.imdbId || imdbId;
        allIds.tvmazeId = allIds.tvmazeId || tvmazeId;
      }
    }
    
    // Phase 2: Secondary lookups to fill any remaining gaps
    const secondaryPromises = [];

    if (!allIds.tmdbId && allIds.imdbId) {
        secondaryPromises.push(moviedb.find({ id: allIds.imdbId, external_source: 'imdb_id' }, config)
            .then(res => ({ tmdbId: res.movie_results?.[0]?.id || res.tv_results?.[0]?.id || null })));
    }
    if (!allIds.tvdbId && allIds.imdbId) {
        secondaryPromises.push(tvdb.findByImdbId(allIds.imdbId, config)
            .then(res => ({ tvdbId: (type === 'movie' ? res?.movie?.id : res?.series?.id) || null })));
    }
    if (!allIds.tvdbId && allIds.tmdbId) {
        secondaryPromises.push(tvdb.findByTmdbId(allIds.tmdbId, config)
            .then(res => {
                const movieResult = res?.find(r => r.movie);
                const seriesResult = res?.find(r => r.series);
                return { tvdbId: (type === 'movie' ? movieResult?.movie?.id : seriesResult?.series?.id) || null };
            }));
    }
    if (!allIds.tvmazeId && allIds.imdbId && type === 'series') {
        secondaryPromises.push(tvmaze.getShowByImdbId(allIds.imdbId)
            .then(res => ({ tvmazeId: res?.id || null })));
    }
    // ******************************************************************

    if (secondaryPromises.length > 0) {
        const secondaryResults = await Promise.allSettled(secondaryPromises);
        for (const result of secondaryResults) {
            if (result.status === 'fulfilled' && result.value) {
                const { tmdbId, tvdbId, imdbId, tvmazeId } = result.value;
                allIds.tmdbId = allIds.tmdbId || tmdbId;
                allIds.tvdbId = allIds.tvdbId || tvdbId;
                allIds.imdbId = allIds.imdbId || imdbId;
                allIds.tvmazeId = allIds.tvmazeId || tvmazeId;
            } else if (result.status === 'rejected') {
                logger.warn(` A secondary API lookup failed: ${result.reason?.message}`);
            }
        }
    }
    
    // 5. Save the complete mapping to cache
    if (!isAnime) {
      await redisIdCache.saveIdMapping(
        type,
        allIds.tmdbId,
        allIds.tvdbId,
        allIds.imdbId,
        allIds.tvmazeId
      );
    }

  } catch (error) {
    logger.error(` API bridging failed for ${stremioId}: ${error.message}`);
  }

  const apiDuration = Date.now() - apiStartTime;
  const totalDuration = Date.now() - startTime;
  
  // Record API lookup timing
  await timingMetrics.recordTiming('api_lookup', apiDuration, { 
    type, 
    stremioId,
    cached: false,
    resolution_type: 'api_lookup'
  });
  
  // Record total resolution timing
  await timingMetrics.recordTiming('id_resolution_total', totalDuration, { 
    type, 
    stremioId,
    cached: false,
    resolution_type: 'full_resolution'
  });
  
  logger.debug(` API lookup phase took ${apiDuration}ms for ${stremioId}`);
  const duration = totalDuration;
  logger.success(` Resolution complete for ${stremioId} (took ${duration}ms)`);
  logger.debug(` Final resolved IDs for ${stremioId} (type: ${type}):`, allIds);
  return allIds;
}

function getPerformanceStats() {
  const total = performanceStats.totalResolutions;
  if (total === 0) {
    return {
      totalResolutions: 0,
      wikiMappingEarlyReturns: { count: 0, percentage: 0 },
      cacheEarlyReturns: { count: 0, percentage: 0 },
      apiCallsRequired: { count: 0, percentage: 0 },
      animeResolutions: { count: 0, percentage: 0 },
      earlyReturnRate: 0
    };
  }
  
  const wikiCount = performanceStats.wikiMappingEarlyReturns;
  const cacheCount = performanceStats.cacheEarlyReturns;
  const apiCount = performanceStats.apiCallsRequired;
  const animeCount = performanceStats.animeResolutions;
  const earlyReturns = wikiCount + cacheCount + animeCount;
  
  return {
    totalResolutions: total,
    wikiMappingEarlyReturns: { 
      count: wikiCount, 
      percentage: Math.round((wikiCount / total) * 100) 
    },
    cacheEarlyReturns: { 
      count: cacheCount, 
      percentage: Math.round((cacheCount / total) * 100) 
    },
    apiCallsRequired: { 
      count: apiCount, 
      percentage: Math.round((apiCount / total) * 100) 
    },
    animeResolutions: { 
      count: animeCount, 
      percentage: Math.round((animeCount / total) * 100) 
    },
    earlyReturnRate: Math.round((earlyReturns / total) * 100)
  };
}

function resetPerformanceStats() {
  performanceStats = {
    totalResolutions: 0,
    wikiMappingEarlyReturns: 0,
    cacheEarlyReturns: 0,
    apiCallsRequired: 0,
    animeResolutions: 0
  };
}

module.exports = { 
  resolveAllIds, 
  getPerformanceStats, 
  resetPerformanceStats 
};