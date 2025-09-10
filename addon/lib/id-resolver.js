const idMapper = require('./id-mapper');
const tvdb = require('./tvdb'); 
const tvmaze = require('./tvmaze');
const moviedb = require("./getTmdb");
const axios = require('axios');
const database = require('./database');
const redisIdCache = require('./redis-id-cache');

async function resolveAllIds(stremioId, type, config, prefetcheIds, targetProviders = []) {
  console.log(`🔗 [ID Resolver] Resolving ${stremioId} (type: ${type})`);
  console.log(`🔗 [ID Resolver] Config userUUID: ${config.userUUID || 'NOT SET'}`);
 
  
  const allIds = { tmdbId: null, tvdbId: null, imdbId: null, malId: null, kitsuId: null, tvmazeId: null, anidbId: null, anilistId: null };
  if (prefetcheIds) {
    allIds.tmdbId = prefetcheIds?.tmdbId;
    allIds.tvdbId = prefetcheIds?.tvdbId;
    allIds.imdbId = prefetcheIds?.imdbId;
    allIds.tvmazeId = prefetcheIds?.tvmazeId;
  }
  const [prefix, sourceId] = stremioId.split(':');

  if (prefix === 'tmdb') allIds.tmdbId = sourceId;
  if (prefix === 'tvdb') allIds.tvdbId = sourceId;
  if (prefix === 'mal') allIds.malId = sourceId;
  if (prefix === 'kitsu') allIds.kitsuId = sourceId;
  if (prefix === 'tvmaze') allIds.tvmazeId = sourceId;
  if (stremioId.startsWith('tt')) allIds.imdbId = stremioId;
  if (prefix === 'anidb') allIds.anidbId = sourceId;
  if (prefix === 'anilist') allIds.anilistId = sourceId;
  // Handle anime ID mapping first
  const isAnime = type === 'anime' || allIds.malId || allIds.kitsuId || allIds.anidbId || allIds.anilistId;
  
  if (!isAnime) {
    // Try to get cached mapping first
    const cachedMapping = null;
    
    if (cachedMapping) {
      //console.log(`🔗 [ID Resolver] Cached mapping:`, JSON.stringify(cachedMapping));
      // Merge cached data with existing IDs
      allIds.tmdbId = allIds.tmdbId || cachedMapping.tmdb_id;
      allIds.tvdbId = allIds.tvdbId || cachedMapping.tvdb_id;
      allIds.imdbId = allIds.imdbId || cachedMapping.imdb_id;
      allIds.tvmazeId = allIds.tvmazeId || cachedMapping.tvmaze_id;

      if(targetProviders.length > 0) {
        // check if we have the target provider id
        if(targetProviders.includes('tmdb')) {
          allIds.tmdbId = allIds.tmdbId || cachedMapping.tmdb_id;
        } else if(targetProviders.includes('tvdb')) {
          allIds.tvdbId = allIds.tvdbId || cachedMapping.tvdb_id;
        } else if(targetProviders.includes('imdb')) {
          allIds.imdbId = allIds.imdbId || cachedMapping.imdb_id;
        } else if(targetProviders.includes('tvmaze')) {
          allIds.tvmazeId = allIds.tvmazeId || cachedMapping.tvmaze_id;
        }
      }

      //console.log(`🔗 [ID Resolver] All IDs for target providers:`, JSON.stringify(allIds));
      // if we have found all the target providers, return early
      if(targetProviders.length > 0 && targetProviders.every(provider => allIds[provider])) {
        //console.log(`🔗 [ID Resolver] Using cached mapping for ${stremioId}`);
        return allIds;
      }
      
      
      
      // If we have all the IDs we need, return early
      if (type === 'series' && allIds.tmdbId && allIds.tvdbId && allIds.imdbId && allIds.tvmazeId) {
        //console.log(`🔗 [ID Resolver] Using cached mapping for ${stremioId}`);
        return allIds;
      }
      
      if(type === 'movie' && allIds.tmdbId && allIds.imdbId && allIds.tvdbId) {
        //console.log(`🔗 [ID Resolver] Using cached mapping for ${stremioId}`);
        return allIds;
      }
    }
  }

  try {
    if (allIds.malId) {
      const mapping = idMapper.getMappingByMalId(allIds.malId);
      if (mapping) {
        //console.log(JSON.stringify(mapping));
        console.log(`🔗 [ID Resolver] MAL ID found: ${JSON.stringify(allIds.malId)}`);
        allIds.tmdbId = allIds.tmdbId || mapping?.themoviedb_id;
        allIds.imdbId = allIds.imdbId || mapping?.imdb_id;
        allIds.kitsuId = allIds.kitsuId || mapping?.kitsu_id;
        allIds.anidbId = allIds.anidbId || mapping?.anidb_id;
        allIds.anilistId = allIds.anilistId || mapping?.anilist_id;
        allIds.tvdbId = allIds.tvdbId || mapping?.thetvdb_id;
      }
    }

    if (allIds.kitsuId) {
      const mapping = idMapper.getMappingByKitsuId(allIds.kitsuId);
      if (mapping) {
        allIds.malId = allIds.malId || mapping?.mal_id;
        allIds.tmdbId = allIds.tmdbId || mapping?.themoviedb_id;
        allIds.imdbId = allIds.imdbId || mapping?.imdb_id;
        allIds.anidbId = allIds.anidbId || mapping?.anidb_id;
        allIds.anilistId = allIds.anilistId || mapping?.anilist_id;
        allIds.tvdbId = allIds.tvdbId || mapping?.thetvdb_id;
      }
    }

    if (allIds.anidbId) {
      const mapping = idMapper.getMappingByAnidbId(allIds.anidbId);
      if (mapping) {
        allIds.malId = allIds.malId || mapping?.mal_id;
        allIds.kitsuId = allIds.kitsuId || mapping?.kitsu_id;
        allIds.tvdbId = allIds.tvdbId || mapping?.thetvdb_id;
        allIds.tvmazeId = allIds.tvmazeId || mapping?.tvmaze_id;
        allIds.anilistId = allIds.anilistId || mapping?.anilist_id;
        allIds.tmdbId = allIds.tmdbId || mapping?.themoviedb_id;
        allIds.imdbId = allIds.imdbId || mapping?.imdb_id;
      }
    }
    if (allIds.anilistId) {
      const mapping = idMapper.getMappingByAnilistId(allIds.anilistId);
      if (mapping) {
        allIds.malId = allIds.malId || mapping?.mal_id;
        allIds.kitsuId = allIds.kitsuId || mapping?.kitsu_id;
        allIds.tmdbId = allIds.tmdbId || mapping?.themoviedb_id;
        allIds.imdbId = allIds.imdbId || mapping?.imdb_id;
        allIds.tvdbId = allIds.tvdbId || mapping?.thetvdb_id;
        allIds.tvmazeId = allIds.tvmazeId || mapping?.tvmaze_id;
        allIds.anidbId = allIds.anidbId || mapping?.anidb_id;
      }
    }

    if (allIds.tmdbId) {
      const details = type === 'movie'
        ? await moviedb.movieInfo({ id: allIds.tmdbId, append_to_response: 'external_ids' }, config)
        : await moviedb.tvInfo({ id: allIds.tmdbId, append_to_response: 'external_ids' }, config);
      
      allIds.imdbId = allIds.imdbId ?? details.external_ids?.imdb_id ?? null;
      console.log(`🔗 [ID Resolver] TMDB external_ids.tvdb_id: ${details.external_ids?.tvdb_id ?? 'NOT FOUND'}`);
      const tvdbLookupResult = await tvdb.findByTmdbId(allIds.tmdbId, config);
      console.log(`🔗 [ID Resolver] TVDB findByTmdbId result: ${tvdbLookupResult ? JSON.stringify(tvdbLookupResult) : 'NULL'}`);
      allIds.tvdbId = allIds.tvdbId ?? details.external_ids?.tvdb_id ?? tvdbLookupResult?.[0]?.series?.id ?? null;
      console.log(`🔗 [ID Resolver] Final tvdbId: ${allIds.tvdbId ?? 'NOT SET'}`);
      if(allIds.tvdbId && type === 'series') {
        const tvdbDetails = await tvdb.getSeriesExtended(allIds.tvdbId, config);
        allIds.tvmazeId = allIds.tvmazeId ?? tvdbDetails.remoteIds?.find(id => id.sourceName === "TV Maze")?.id ?? null;
      }
    }

    if (allIds.tvdbId && (!allIds.imdbId || !allIds.tmdbId || !allIds.tvmazeId)) {
      let tvdbDetails;
      if (type === 'movie') {
        tvdbDetails = await tvdb.getMovieExtended(allIds.tvdbId, config);
      } else {
          tvdbDetails = await tvdb.getSeriesExtended(allIds.tvdbId, config);
      }
      
      allIds.imdbId = allIds.imdbId ?? tvdbDetails.remoteIds?.find(id => id.sourceName === 'IMDB')?.id ?? null;
      allIds.tmdbId = allIds.tmdbId ?? tvdbDetails.remoteIds?.find(id => id.sourceName === 'TheMovieDB.com')?.id ?? null;
      allIds.tvmazeId = allIds.tvmazeId ?? tvdbDetails.remoteIds?.find(id => id.sourceName === "TV Maze")?.id ?? (await tvmaze.getShowByTvdbId(allIds.tvdbId, config))?.id ?? null;
    }


    if (allIds.imdbId && (!allIds.tmdbId || !allIds.tvdbId || !allIds.tvmazeId)) {
      // get external IDs from Cinemeta
      const externalIds = await getExternalIdsFromImdb(allIds.imdbId, type);
      console.log(`🔗 [ID Resolver] External IMDb IDs:`, JSON.stringify(externalIds));
      if (externalIds) {
        allIds.tmdbId = allIds.tmdbId ?? externalIds.tmdbId ?? null;
        allIds.tvdbId = allIds.tvdbId ?? externalIds.tvdbId ?? null;
      }
      if (!allIds.tmdbId) {
        const findResults = await moviedb.find({ id: allIds.imdbId, external_source: 'imdb_id' }, config);
        const match = findResults.movie_results?.[0] || findResults.tv_results?.[0];
        if (match && match.id) allIds.tmdbId = match.id;
      }
      
      if (!allIds.tvdbId) {
        const tvdbMatch = await tvdb.findByImdbId(allIds.imdbId, config);
        //console.log(tvdbMatch);
        if (tvdbMatch) {
          if (type === 'movie' && tvdbMatch.movie && tvdbMatch.movie.id) {
            allIds.tvdbId = tvdbMatch.movie.id;
          } else if (type === 'series' && tvdbMatch.series && tvdbMatch.series.id) {
            allIds.tvdbId = tvdbMatch.series.id;
          }
        }
      }

      if (!allIds.tvmazeId && type === 'series') {
        const tvmazeMatch = await tvmaze.getShowByImdbId(allIds.imdbId);
        if (tvmazeMatch && tvmazeMatch.id) allIds.tvmazeId = tvmazeMatch.id;
      }
    }

    if (allIds.tvmazeId && (!allIds.imdbId || !allIds.tmdbId || !allIds.tvdbId)) {
      const tvmazeDetails = await tvmaze.getShowById(allIds.tvmazeId);
      if (tvmazeDetails && tvmazeDetails.externals) {
        allIds.imdbId = allIds.imdbId ?? tvmazeDetails.externals.imdb ?? null;
        allIds.tmdbId = allIds.tmdbId ?? tvmazeDetails.externals.themoviedb ?? null;
        allIds.tvdbId = allIds.tvdbId ?? tvmazeDetails.externals.thetvdb ?? null;
      }
    }

    // Cache the mapping for non-anime content
    /*if (!isAnime) {
      try {

        // Also save to Redis cache
        await redisIdCache.saveIdMapping(
          type,
          allIds.tmdbId,
          allIds.tvdbId,
          allIds.imdbId,
          allIds.tvmazeId
        );
        
        // console.log(`[ID Cache] Saved mapping for ${type}:`, { tmdbId: allIds.tmdbId, tvdbId: allIds.tvdbId, imdbId: allIds.imdbId, tvmazeId: allIds.tvmazeId });
      } catch (error) {
        console.warn(`❌ [ID Cache] Failed to save mapping: ${error.message}`);
      }
    }*/

  } catch (error) {
    console.warn(`❌ [ID Resolver] API bridging failed for ${stremioId}: ${error.message}`);
    console.warn(`❌ [ID Resolver] Error stack:`, error.stack);
  }

  console.log(`🔗 [ID Resolver] Final IDs:`, JSON.stringify(allIds));
  return allIds;
}

async function getExternalIdsFromImdb(imdbId, type) {
  if (!imdbId) {
    return undefined;
  }

  const url = `https://cinemeta-live.strem.io/meta/${type}/${imdbId}.json`;
  try {
    const response = await axios.get(url);
    const tvdbId = response.data?.meta?.tvdb_id;
    const tmdbId = response.data?.meta?.moviedb_id;
    return {
      tmdbId: tmdbId || null,
      tvdbId: tvdbId || null
    };

  } catch (error) {
    console.warn(`❌ Could not fetch external ids for ${imdbId} from Cinemeta for type ${type}. Error: ${error.message}`);
    return undefined;
  }
}

module.exports = { resolveAllIds };
