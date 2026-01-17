
const idMapper = require('./id-mapper');
const tvdb = require('./tvdb');
const tvmaze = require('./tvmaze');
const moviedb = require("./getTmdb");
const redisIdCache = require('./redis-id-cache');
const timingMetrics = require('./timing-metrics');
const consola = require('consola');
const { httpGet } = require('../utils/httpClient');
const { mappings } = require('./wiki-mapper.js');

const logger = consola.withTag('ID-Resolver');

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
        allIds.tvdbId = allIds.tvdbId || mapping.tvdb_id;
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
    timingMetrics.recordTiming('tmdb_external_ids', duration, { 
      type, 
      tmdbId,
      success: true,
      method: 'dedicated_endpoint',
      provider: 'tmdb'
    });
    
    // Record provider-specific timing
    timingMetrics.recordTiming(`api_tmdb_${type}`, duration, {
      operation: 'external_ids',
      tmdbId,
      success: true
    });
    
    logger.debug(`[API Fetch] TMDB External IDs completed in ${duration}ms for ${type} ${tmdbId}`);
    
    return {
      imdbId: externalIds.imdb_id || null,
      tvdbId: externalIds.tvdb_id || null,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    timingMetrics.recordTiming('tmdb_external_ids', duration, { 
      type, 
      tmdbId,
      success: false,
      method: 'dedicated_endpoint',
      provider: 'tmdb',
      error: error.message
    });
    
    // Record provider-specific timing for failures (fire-and-forget)
    timingMetrics.recordTiming(`api_tmdb_${type}`, duration, {
      operation: 'external_ids',
      tmdbId,
      success: false,
      error: error.message
    });
    
    logger.warn(`[API Fetch] Failed to fetch from TMDB ${tmdbId}:`, error.message || error || 'Unknown error');
    return {};
  }
}

async function _fetchFromTvdb(tvdbId, type, config) {
  if (!tvdbId) return {};
  const startTime = Date.now();
  try {
    logger.debug(`[API Fetch] TVDB Remote IDs for ${type} ${tvdbId}`);
    const details = type === 'movie'
      ? await tvdb.getMovieExtended(tvdbId, config)
      : await tvdb.getSeriesExtended(tvdbId, config);

    const duration = Date.now() - startTime;
    
    // Record timing metrics for TVDB (fire-and-forget)
    timingMetrics.recordTiming('tvdb_remote_ids', duration, { 
      type, 
      tvdbId,
      success: true,
      provider: 'tvdb'
    });
    
    // Record provider-specific timing (fire-and-forget)
    timingMetrics.recordTiming(`api_tvdb_${type}`, duration, {
      operation: 'remote_ids',
      tvdbId,
      success: true
    });

    const findId = (sourceName) => details.remoteIds?.find(id => id.sourceName === sourceName)?.id || null;
    
    return {
      imdbId: findId('IMDB'),
      tmdbId: findId('TheMovieDB.com'),
      tvmazeId: findId('TV Maze'),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    timingMetrics.recordTiming('tvdb_remote_ids', duration, { 
      type, 
      tvdbId,
      success: false,
      provider: 'tvdb',
      error: error.message
    });
    
    // Record provider-specific timing for failures
    timingMetrics.recordTiming(`api_tvdb_${type}`, duration, {
      operation: 'remote_ids',
      tvdbId,
      success: false,
      error: error.message
    });
    
    logger.warn(`[API Fetch] Failed to fetch from TVDB ${tvdbId}:`, error.message || error || 'Unknown error');
    return {};
  }
}

async function _fetchFromTvmaze(tvmazeId, config) {
  if (!tvmazeId) return {};
  const startTime = Date.now();
  try {
    logger.debug(`[API Fetch] TVmaze Externals for ${tvmazeId}`);
    const details = await tvmaze.getShowById(tvmazeId, config);
    const duration = Date.now() - startTime;
    
    // Record timing metrics for TVMaze
    timingMetrics.recordTiming('tvmaze_externals', duration, { 
      tvmazeId,
      success: true,
      provider: 'tvmaze'
    });
    
    // Record provider-specific timing
    timingMetrics.recordTiming('api_tvmaze_series', duration, {
      operation: 'externals',
      tvmazeId,
      success: true
    });
    
    return {
      imdbId: details.externals?.imdb || null,
      tmdbId: details.externals?.themoviedb || null,
      tvdbId: details.externals?.thetvdb || null,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    timingMetrics.recordTiming('tvmaze_externals', duration, { 
      tvmazeId,
      success: false,
      provider: 'tvmaze',
      error: error.message
    });
    
    // Record provider-specific timing for failures
    timingMetrics.recordTiming('api_tvmaze_series', duration, {
      operation: 'externals',
      tvmazeId,
      success: false,
      error: error.message
    });
    
    logger.warn(`[API Fetch] Failed to fetch from TVmaze ${tvmazeId}:`, error.message || error || 'Unknown error');
    return {};
  }
}

async function getExternalIdsFromImdb(imdbId, type) {
  if (!imdbId || imdbId.toString().trim() === '') return undefined;
  const url = `https://cinemeta-live.strem.io/meta/${type}/${imdbId}.json`;

  try {
    const { data } = await httpGet(url);
    const tvdbId = data?.meta?.tvdb_id;
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
    timingMetrics.recordTiming('id_resolution_anime', duration, { 
      type, 
      stremioId,
      cached: false,
      resolution_type: 'anime_mapping'
    });
    logger.debug(`[Anime] Resolution complete for ${stremioId} (took ${duration}ms)`);
    return allIds;
  }

  // 3. Check Cache
  if (!isAnime) {
    // 1.5. Check wiki mappings first for fast resolution
    try {
      let wikiMapping = null;
      if (allIds.tmdbId && (type === 'movie' || type === 'series')) {
        wikiMapping = mappings.getByTmdbId(allIds.tmdbId.toString(), type);
      } else if (allIds.tvdbId && (type === 'movie' || type === 'series')) {
        wikiMapping = mappings.getByTvdbId(allIds.tvdbId.toString());
      } else if (allIds.imdbId && (type === 'movie' || type === 'series')) {
        wikiMapping = mappings.getByImdbId(allIds.imdbId, type);
      } else if (allIds.tvmazeId && type === 'series') {
        wikiMapping = mappings.getSeriesByTvmaze(allIds.tvmazeId.toString());
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
            timingMetrics.recordTiming('id_resolution_wiki', duration, { 
              type, 
              stremioId,
              cached: false,
              resolution_type: 'wiki_mapping_complete'
            });
            logger.debug(`[Wiki] Mapping provided all target providers for ${stremioId} (took ${duration}ms)`);
            return allIds;
          }
        }
      }
    } catch (error) {
      logger.warn(`Wiki mapping lookup failed for ${stremioId}:`, error.message);
    }


    const cachedMapping = await redisIdCache.getCachedIdMapping(type, allIds.tmdbId, allIds.tvdbId, allIds.imdbId, allIds.tvmazeId);
    if (cachedMapping) {
      logger.debug(` Found cached mapping for ${stremioId}`);
      allIds.tmdbId = allIds.tmdbId || cachedMapping.tmdb_id;
      allIds.tvdbId = allIds.tvdbId || cachedMapping.tvdb_id;
      allIds.imdbId = allIds.imdbId || cachedMapping.imdb_id;
      allIds.tvmazeId = allIds.tvmazeId || cachedMapping.tvmaze_id;
      
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
          performanceStats.cacheEarlyReturns++;
          const duration = Date.now() - startTime;
          timingMetrics.recordTiming('id_resolution_cache', duration, { 
            type, 
            stremioId,
            cached: true,
            resolution_type: 'cache_hit'
          });
          logger.debug(`[Cache] Hit provided all target providers for ${stremioId} (took ${duration}ms)`);
          return allIds;
        }
      } else {
        // If no target providers specified, return cache hit immediately
        performanceStats.cacheEarlyReturns++;
        const duration = Date.now() - startTime;
        timingMetrics.recordTiming('id_resolution_cache', duration, { 
          type, 
          stremioId,
          cached: true,
          resolution_type: 'cache_hit'
        });
        logger.debug(`[Cache] Hit resolution complete for ${stremioId} (took ${duration}ms)`);
        return allIds;
      }
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
    
    // Determine what IDs we actually need based on targetProviders
    const needsImdb = targetProviders.length === 0 || targetProviders.includes('imdb');
    const needsTmdb = targetProviders.length === 0 || targetProviders.includes('tmdb');
    const needsTvdb = targetProviders.length === 0 || targetProviders.includes('tvdb');
    const needsTvmaze = targetProviders.length > 0 && targetProviders.includes('tvmaze');
    
    // Only fetch from TMDB if we need IMDB or TVDB IDs and don't have them
    if (allIds.tmdbId && ((needsImdb && !allIds.imdbId) || (needsTvdb && !allIds.tvdbId))) {
      logger.debug(`[Primary API] TMDB external IDs - needs: imdb=${needsImdb && !allIds.imdbId}, tvdb=${needsTvdb && !allIds.tvdbId}`);
      primaryPromises.push(_fetchFromTmdb(allIds.tmdbId, type, config));
    }
    
    // Only fetch from TVMaze if we explicitly need TVMaze, TMDB, or TVDB IDs
    if (allIds.tvmazeId && ((needsImdb && !allIds.imdbId) || (needsTmdb && !allIds.tmdbId) || (needsTvdb && !allIds.tvdbId))) {
      logger.debug(`[Primary API] TVMaze externals - needs: imdb=${needsImdb && !allIds.imdbId}, tmdb=${needsTmdb && !allIds.tmdbId}, tvdb=${needsTvdb && !allIds.tvdbId}`);
      primaryPromises.push(_fetchFromTvmaze(allIds.tvmazeId, config));
    }
    
    // Only fetch from TVDB if we need IMDB, TMDB, or TVMaze IDs and don't have them
    if (allIds.tvdbId && ((needsImdb && !allIds.imdbId) || (needsTmdb && !allIds.tmdbId) || (needsTvmaze && !allIds.tvmazeId))) {
      logger.debug(`[Primary API] TVDB remote IDs - needs: imdb=${needsImdb && !allIds.imdbId}, tmdb=${needsTmdb && !allIds.tmdbId}, tvmaze=${needsTvmaze && !allIds.tvmazeId}`);
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
    const secondaryTimings = [];

    if (!allIds.tmdbId && allIds.imdbId && needsTmdb) {
        const tmdbFindStartTime = Date.now();
        logger.debug(`[Secondary API] TMDB find by IMDB - targetProviders: [${targetProviders.join(', ')}]`);
        secondaryPromises.push(
            moviedb.find({ id: allIds.imdbId, external_source: 'imdb_id' }, config)
                .then(res => {
                    const duration = Date.now() - tmdbFindStartTime;
                    const tmdbId = res.movie_results?.[0]?.id || res.tv_results?.[0]?.id || null;
                    secondaryTimings.push({
                        operation: 'tmdb_find_by_imdb',
                        duration,
                        success: !!tmdbId,
                        provider: 'tmdb',
                        sourceId: allIds.imdbId,
                        type
                    });
                    return { tmdbId };
                })
                .catch(error => {
                    const duration = Date.now() - tmdbFindStartTime;
                    secondaryTimings.push({
                        operation: 'tmdb_find_by_imdb',
                        duration,
                        success: false,
                        provider: 'tmdb',
                        sourceId: allIds.imdbId,
                        type,
                        error: error.message
                    });
                    return { tmdbId: null };
                })
        );
    }
    
    if (!allIds.tvdbId && allIds.imdbId && needsTvdb) {
        logger.debug(`[Secondary API] Finding TVDB ID for IMDB ID ${allIds.imdbId}`);
        const tvdbFindStartTime = Date.now();
        logger.debug(`[Secondary API] TVDB find by IMDB - targetProviders: [${targetProviders.join(', ')}]`);
        secondaryPromises.push(
            tvdb.findByImdbId(allIds.imdbId, config)
                .then(res => {
                    const duration = Date.now() - tvdbFindStartTime;
                    const tvdbId = (type === 'movie' ? res?.[0]?.movie?.id : res?.[0]?.series?.id) || null;
                    secondaryTimings.push({
                        operation: 'tvdb_find_by_imdb',
                        duration,
                        success: !!tvdbId,
                        provider: 'tvdb',
                        sourceId: allIds.imdbId,
                        type
                    });
                    return { tvdbId };
                })
                .catch(error => {
                    const duration = Date.now() - tvdbFindStartTime;
                    secondaryTimings.push({
                        operation: 'tvdb_find_by_imdb',
                        duration,
                        success: false,
                        provider: 'tvdb',
                        sourceId: allIds.imdbId,
                        type,
                        error: error.message
                    });
                    return { tvdbId: null };
                })
        );
    }
    
    if (!allIds.tvdbId && allIds.tmdbId && needsTvdb) {
        const tvdbFindTmdbStartTime = Date.now();
        logger.debug(`[Secondary API] TVDB find by TMDB - targetProviders: [${targetProviders.join(', ')}]`);
        secondaryPromises.push(
            tvdb.findByTmdbId(allIds.tmdbId, config)
                .then(res => {
                    const duration = Date.now() - tvdbFindTmdbStartTime;
                    const movieResult = res?.find(r => r.movie);
                    const seriesResult = res?.find(r => r.series);
                    const tvdbId = (type === 'movie' ? movieResult?.movie?.id : seriesResult?.series?.id) || null;
                    secondaryTimings.push({
                        operation: 'tvdb_find_by_tmdb',
                        duration,
                        success: !!tvdbId,
                        provider: 'tvdb',
                        sourceId: allIds.tmdbId,
                        type
                    });
                    return { tvdbId };
                })
                .catch(error => {
                    const duration = Date.now() - tvdbFindTmdbStartTime;
                    secondaryTimings.push({
                        operation: 'tvdb_find_by_tmdb',
                        duration,
                        success: false,
                        provider: 'tvdb',
                        sourceId: allIds.tmdbId,
                        type,
                        error: error.message
                    });
                    return { tvdbId: null };
                })
        );
    }
    
    // Only call TVMaze if it's specifically requested in targetProviders
    // If no targetProviders specified, we should only fetch essential providers (TMDB, TVDB, IMDB)
    const shouldCallTvmaze = targetProviders.length > 0 && targetProviders.includes('tvmaze');
    if (!allIds.tvmazeId && allIds.imdbId && type === 'series' && shouldCallTvmaze) {
        const tvmazeFindStartTime = Date.now();
        logger.debug(`[Secondary API] TVMaze lookup requested - targetProviders: [${targetProviders.join(', ')}]`);
        secondaryPromises.push(
            tvmaze.getShowByImdbId(allIds.imdbId)
                .then(res => {
                    const duration = Date.now() - tvmazeFindStartTime;
                    const tvmazeId = res?.id || null;
                    secondaryTimings.push({
                        operation: 'tvmaze_find_by_imdb',
                        duration,
                        success: !!tvmazeId,
                        provider: 'tvmaze',
                        sourceId: allIds.imdbId,
                        type
                    });
                    return { tvmazeId };
                })
                .catch(error => {
                    const duration = Date.now() - tvmazeFindStartTime;
                    secondaryTimings.push({
                        operation: 'tvmaze_find_by_imdb',
                        duration,
                        success: false,
                        provider: 'tvmaze',
                        sourceId: allIds.imdbId,
                        type,
                        error: error.message
                    });
                    return { tvmazeId: null };
                })
        );
    } else if (!allIds.tvmazeId && allIds.tvdbId && type === 'series' && shouldCallTvmaze) {
        const tvmazeFindTvdbStartTime = Date.now();
        logger.debug(`[Secondary API] TVMaze lookup requested - targetProviders: [${targetProviders.join(', ')}]`);
        secondaryPromises.push(
            tvmaze.getShowByTvdbId(allIds.tvdbId)
                .then(res => {
                    const duration = Date.now() - tvmazeFindTvdbStartTime;
                    const tvmazeId = res?.id || null;
                    secondaryTimings.push({
                        operation: 'tvmaze_find_by_tvdb',
                        duration,
                        success: !!tvmazeId,
                        provider: 'tvmaze',
                        sourceId: allIds.tvdbId,
                        type
                    });
                    return { tvmazeId };
                })
                .catch(error => {
                    const duration = Date.now() - tvmazeFindTvdbStartTime;
                    secondaryTimings.push({
                        operation: 'tvmaze_find_by_tvdb',
                        duration,
                        success: false,
                        provider: 'tvmaze',
                        sourceId: allIds.tvdbId,
                        type,
                        error: error.message
                    });
                    return { tvmazeId: null };
                })
        );
    }

    if (secondaryPromises.length > 0) {
        logger.debug(`Starting ${secondaryPromises.length} secondary API lookups for ${stremioId}`);
        const secondaryResults = await Promise.allSettled(secondaryPromises);
        
        // Record individual secondary API call timings
        for (const timing of secondaryTimings) {
            timingMetrics.recordTiming(`secondary_${timing.operation}`, timing.duration, {
                type: timing.type,
                success: timing.success,
                provider: timing.provider,
                sourceId: timing.sourceId,
                error: timing.error
            });
            
            // Also record provider-specific secondary timing
            timingMetrics.recordTiming(`secondary_${timing.provider}_${timing.type}`, timing.duration, {
                operation: timing.operation,
                success: timing.success,
                sourceId: timing.sourceId,
                error: timing.error
            });
            
            logger.debug(`Secondary ${timing.operation} completed in ${timing.duration}ms (success: ${timing.success})`);
        }
        
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
        
        logger.debug(`Secondary API lookups completed for ${stremioId}. Found IDs: ${JSON.stringify({ tmdb: allIds.tmdbId, tvdb: allIds.tvdbId, imdb: allIds.imdbId, tvmaze: allIds.tvmazeId })}`);
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
  timingMetrics.recordTiming('api_lookup', apiDuration, { 
    type, 
    stremioId,
    cached: false,
    resolution_type: 'api_lookup'
  });
  
  // Record total resolution timing
  timingMetrics.recordTiming('id_resolution_total', totalDuration, { 
    type, 
    stremioId,
    cached: false,
    resolution_type: 'full_resolution'
  });
  
  logger.debug(` API lookup phase took ${apiDuration}ms for ${stremioId}`);
  const duration = totalDuration;
  logger.debug(`[Resolution] Complete for ${stremioId} (took ${duration}ms)`);
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