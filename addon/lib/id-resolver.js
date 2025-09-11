
const idMapper = require('./id-mapper');
const tvdb = require('./tvdb');
const tvmaze = require('./tvmaze');
const moviedb = require("./getTmdb");
const axios = require('axios');
const redisIdCache = require('./redis-id-cache');
const consola = require('consola');

const logger = consola.create({ 
  level: 4, // Show all levels
  fancy: true,
  colors: true,
  formatOptions: {
    colors: true,
    compact: false,
    date: false
  },
  tag: 'ID-Resolver'
});

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
  try {
    logger.debug(`[API Fetch] TMDB External IDs for ${type} ${tmdbId}`);
    const details = type === 'movie'
      ? await moviedb.movieInfo({ id: tmdbId, append_to_response: 'external_ids' }, config)
      : await moviedb.tvInfo({ id: tmdbId, append_to_response: 'external_ids' }, config);
    
    return {
      imdbId: details.external_ids?.imdb_id || null,
      tvdbId: details.external_ids?.tvdb_id || null,
    };
  } catch (error) {
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
    const response = await axios.get(url);
    const tvdbId = response.data?.meta?.tvdb_id || response.data?.meta?.thetvdb_id;
    const tmdbId = response.data?.meta?.moviedb_id || response.data?.meta?.themoviedb_id || response.data?.meta?.tmdb_id;
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
  logger.info(`Starting resolution for ${stremioId} (type: ${type})`);
  if (type !== 'movie' && type !== 'series' && type !== 'anime') {
    logger.warn(`Invalid type: ${type}`);
    return null;
  }

  // 1. Initialize IDs
  let allIds = { ..._parseStremioId(stremioId), ...prefetchedIds };
  const isAnime = type === 'anime' || allIds.malId || allIds.kitsuId || allIds.anidbId || allIds.anilistId;

  // 2. Handle Anime
  if (isAnime) {
    _handleAnimeMapping(allIds);
    logger.success(` Anime resolution complete for ${stremioId}`);
    return allIds;
  }

  // 3. Check Cache
  if (!isAnime) {
    const cachedMapping = await redisIdCache.getCachedIdMapping(type, allIds.tmdbId, allIds.tvdbId, allIds.imdbId, allIds.tvmazeId);
    if (cachedMapping) {
      logger.info(` Found cached mapping for ${stremioId}`);
      allIds.tmdbId = allIds.tmdbId || cachedMapping.tmdb_id;
      allIds.tvdbId = allIds.tvdbId || cachedMapping.tvdb_id;
      allIds.imdbId = allIds.imdbId || cachedMapping.imdb_id;
      allIds.tvmazeId = allIds.tvmazeId || cachedMapping.tvmaze_id;
        return allIds;
    }
    logger.info(` No cache hit for ${stremioId}, proceeding to API lookups.`);
  }

  // 4. Perform API Lookups in PARALLEL
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
    if (allIds.tvdbId && (!allIds.imdbId || !allIds.tmdbId || !allIds.tvmazeId)) {
      primaryPromises.push(_fetchFromTvdb(allIds.tvdbId, type, config));
    }
    if (allIds.tvmazeId && (!allIds.imdbId || !allIds.tmdbId || !allIds.tvdbId)) {
      primaryPromises.push(_fetchFromTvmaze(allIds.tvmazeId, config));
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

    // ********* FIX: Re-added secondary lookups by external IDs *********
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

  logger.success(` Resolution complete for ${stremioId}`);
  logger.info(` Final resolved IDs for this ${stremioId} of type ${type} are:`, allIds);
  return allIds;
}

module.exports = { resolveAllIds };