const idMapper = require('./id-mapper');
const tvdb = require('./tvdb'); 
const tvmaze = require('./tvmaze');
const moviedb = require("./getTmdb");
const axios = require('axios');
const database = require('./database');

async function resolveAllIds(stremioId, type, config, animeType = null) {
  console.log(`[ID Resolver] Resolving ${stremioId} (type: ${type})`);

  const allIds = { tmdbId: null, tvdbId: null, imdbId: null, malId: null, kitsuId: null, tvmazeId: null, anidbId: null, anilistId: null };
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
  const isAnime = type === 'anime' || allIds.malId || allIds.kitsuId;
  
  if (!isAnime) {
    // Try to get cached mapping first
    const cachedMapping = await database.getCachedMappingByAnyId(
      type, 
      allIds.tmdbId, 
      allIds.tvdbId, 
      allIds.imdbId, 
      allIds.tvmazeId
    );
    
    if (cachedMapping) {
      // Merge cached data with existing IDs
      allIds.tmdbId = allIds.tmdbId || cachedMapping.tmdb_id;
      allIds.tvdbId = allIds.tvdbId || cachedMapping.tvdb_id;
      allIds.imdbId = allIds.imdbId || cachedMapping.imdb_id;
      allIds.tvmazeId = allIds.tvmazeId || cachedMapping.tvmaze_id;
      
      // If we have all the IDs we need, return early
      if (allIds.tmdbId && allIds.tvdbId && allIds.imdbId && allIds.tvmazeId) {
        console.log(`[ID Resolver] Using cached mapping for ${stremioId}`);
        return allIds;
      }
    }
  }

  try {
    if (allIds.malId) {
      const mapping = idMapper.getMappingByMalId(allIds.malId);
      if (mapping) {
        //console.log(JSON.stringify(mapping));
        console.log(`[ID Resolver] MAL ID found: ${allIds.malId}`);
        allIds.tmdbId = allIds.tmdbId || mapping.themoviedb_id;
        allIds.imdbId = allIds.imdbId || mapping.imdb_id;
        allIds.kitsuId = allIds.kitsuId || mapping.kitsu_id;
        allIds.anidbId = allIds.anidbId || mapping.anidb_id;
        allIds.anilistId = allIds.anilistId || mapping.anilist_id;
        if(animeType) {
          if(animeType === 'anime'){
            animeType = idMapper.getAnimeTypeFromMalId(allIds.malId);
          }
          if (animeType === 'movie') {
            const tvdbMatch = await tvdb.findByImdbId(allIds.imdbId, config);
            if (tvdbMatch) {
              allIds.tvdbId = tvdbMatch.movie.id;
            }
          } else if (animeType === 'series') {
            allIds.tvdbId = allIds.tvdbId || mapping.thetvdb_id;
          }
        }
      }
    }

    if (allIds.kitsuId) {
      const mapping = idMapper.getMappingByKitsuId(allIds.kitsuId);
      if (mapping) {
        allIds.malId = allIds.malId || mapping.mal_id;
        allIds.tmdbId = allIds.tmdbId || mapping.themoviedb_id;
        allIds.imdbId = allIds.imdbId || mapping.imdb_id;
        allIds.anidbId = allIds.anidbId || mapping.anidb_id;
        allIds.anilistId = allIds.anilistId || mapping.anilist_id;
        allIds.tvdbId = allIds.tvdbId || mapping.thetvdb_id;
      }
    }

    if (allIds.anidbId) {
      const mapping = idMapper.getMappingByAnidbId(allIds.anidbId);
      if (mapping) {
        allIds.malId = allIds.malId || mapping.mal_id;
        allIds.kitsuId = allIds.kitsuId || mapping.kitsu_id;
        allIds.tvdbId = allIds.tvdbId || mapping.thetvdb_id;
        allIds.tvmazeId = allIds.tvmazeId || mapping.tvmaze_id;
        allIds.anilistId = allIds.anilistId || mapping.anilist_id;
        allIds.tmdbId = allIds.tmdbId || mapping.themoviedb_id;
        allIds.imdbId = allIds.imdbId || mapping.imdb_id;
      }
    }
    if (allIds.anilistId) {
      const mapping = idMapper.getMappingByAnilistId(allIds.anilistId);
      if (mapping) {
        allIds.malId = allIds.malId || mapping.mal_id;
        allIds.kitsuId = allIds.kitsuId || mapping.kitsu_id;
        allIds.tmdbId = allIds.tmdbId || mapping.themoviedb_id;
        allIds.imdbId = allIds.imdbId || mapping.imdb_id;
        allIds.tvdbId = allIds.tvdbId || mapping.thetvdb_id;
        allIds.tvmazeId = allIds.tvmazeId || mapping.tvmaze_id;
        allIds.anidbId = allIds.anidbId || mapping.anidb_id;
      }
    }

    if (allIds.tmdbId) {
      const details = type === 'movie'
        ? await moviedb.movieInfo({ id: allIds.tmdbId, append_to_response: 'external_ids' }, config)
        : await moviedb.tvInfo({ id: allIds.tmdbId, append_to_response: 'external_ids' }, config);
      
      allIds.imdbId = allIds.imdbId || details.external_ids?.imdb_id;
      allIds.tvdbId = allIds.tvdbId || details.external_ids?.tvdb_id;
      const mapping= idMapper.getMappingByTmdbId(allIds.tmdbId, type);
      if (mapping) {
        allIds.malId = allIds.malId || mapping.mal_id;
        allIds.kitsuId = allIds.kitsuId || mapping.kitsu_id;
        allIds.anidbId = allIds.anidbId || mapping.anidb_id;
        allIds.anilistId = allIds.anilistId || mapping.anilist_id;
      }
    }

    if (allIds.imdbId && (!allIds.tmdbId || !allIds.tvdbId || !allIds.malId || !allIds.tvmazeId)) {
      // get external IDs from Cinemeta
      const externalIds = await getExternalIdsFromImdb(allIds.imdbId, type);
      if (externalIds) {
        allIds.tmdbId = allIds.tmdbId || externalIds.tmdbId;
        allIds.tvdbId = allIds.tvdbId || externalIds.tvdbId;
      }
      if (!allIds.tmdbId) {
        const findResults = await moviedb.find({ id: allIds.imdbId, external_source: 'imdb_id' }, config);
        const match = findResults.movie_results?.[0] || findResults.tv_results?.[0];
        if (match) allIds.tmdbId = match.id;
      }
      
      if (!allIds.tvdbId) {
        const tvdbMatch = await tvdb.findByImdbId(allIds.imdbId, config);
        //console.log(tvdbMatch);
        if (tvdbMatch) allIds.tvdbId = type === 'movie' ? tvdbMatch.movie.id : tvdbMatch.series.id;
      }
      if (!allIds.malId) {
        const malMatch = idMapper.getMappingByImdbId(allIds.imdbId);
        if (malMatch) allIds.malId = malMatch.mal_id;
        allIds.kitsuId = allIds.kitsuId || malMatch.kitsu_id;
        allIds.anidbId = allIds.anidbId || malMatch.anidb_id;
        allIds.anilistId = allIds.anilistId || malMatch.anilist_id;
      }

      if (!allIds.tvmazeId && type === 'series') {
        const tvmazeMatch = await tvmaze.getShowByImdbId(allIds.imdbId);
        if (tvmazeMatch) allIds.tvmazeId = tvmazeMatch.id;
      }
    }
    
    if (allIds.tvdbId && (!allIds.imdbId || !allIds.tmdbId || !allIds.tvmazeId || !allIds.malId)) {
        let tvdbDetails;
        const mapping = idMapper.getMappingByTvdbId(allIds.tvdbId);
        if (mapping) {  
          allIds.malId = allIds.malId || mapping.mal_id;
          allIds.kitsuId = allIds.kitsuId || mapping.kitsu_id;
          allIds.anidbId = allIds.anidbId || mapping.anidb_id;
          allIds.anilistId = allIds.anilistId || mapping.anilist_id;
        }
        if (type === 'anime') {
            console.log(`[ID Resolver] Anime detected. Using animeType ('${animeType}') to query TVDB.`);
            if(animeType === 'anime'){
              animeType = idMapper.getAnimeTypeFromMalId(allIds.malId);
            }
            if (animeType === 'movie') {
                tvdbDetails = await tvdb.getMovieExtended(allIds.tvdbId, config);
            } else {
                tvdbDetails = await tvdb.getSeriesExtended(allIds.tvdbId, config);
            }
        } else {
            if (type === 'movie') {
                tvdbDetails = await tvdb.getMovieExtended(allIds.tvdbId, config);
            } else {
                tvdbDetails = await tvdb.getSeriesExtended(allIds.tvdbId, config);
            }
        }
        
        allIds.imdbId = allIds.imdbId || tvdbDetails.remoteIds?.find(id => id.sourceName === 'IMDB')?.id;
        allIds.tmdbId = allIds.tmdbId || tvdbDetails.remoteIds?.find(id => id.sourceName === 'TheMovieDB.com')?.id;
        allIds.tvmazeId = allIds.tvmazeId || tvdbDetails.remoteIds?.find(id => id.sourceName === "TV Maze")?.id ;
    }

    if (allIds.tvmazeId && (!allIds.imdbId || !allIds.tmdbId || !allIds.tvdbId || !allIds.malId)) {
      const tvmazeDetails = await tvmaze.getShowById(allIds.tvmazeId);
      allIds.imdbId = allIds.imdbId || tvmazeDetails.externals?.imdb;
      allIds.tmdbId = allIds.tmdbId || tvmazeDetails.externals?.themoviedb;
      allIds.tvdbId = allIds.tvdbId || tvmazeDetails.externals?.thetvdb;
      const mapping = idMapper.getMappingByTvdbId(allIds.tvdbId);
      if (mapping) {
        allIds.malId = allIds.malId || mapping.mal_id;
        allIds.kitsuId = allIds.kitsuId || mapping.kitsu_id;
        allIds.anidbId = allIds.anidbId || mapping.anidb_id;
        allIds.anilistId = allIds.anilistId || mapping.anilist_id;
      }
    }

    // Cache the mapping for non-anime content
    if (!isAnime) {
      try {
        await database.saveIdMapping(
          type,
          allIds.tmdbId,
          allIds.tvdbId,
          allIds.imdbId,
          allIds.tvmazeId
        );
        console.log(`[ID Cache] Saved mapping for ${type}:`, { tmdbId: allIds.tmdbId, tvdbId: allIds.tvdbId, imdbId: allIds.imdbId, tvmazeId: allIds.tvmazeId });
      } catch (error) {
        console.warn(`[ID Cache] Failed to save mapping: ${error.message}`);
      }
    }

  } catch (error) {
    console.warn(`[ID Resolver] API bridging failed for ${stremioId}: ${error.message}`);
  }

  console.log(`[ID Resolver] Final IDs:`, allIds);
  return allIds;
}

async function getExternalIdsFromImdb(imdbId, type) {
  if (!imdbId) {
    return undefined;
  }

  const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
  try {
    const response = await axios.get(url);
    const tvdbId = response.data?.meta?.tvdb_id;
    const tmdbId = response.data?.meta?.moviedb_id;
    return {
      tmdbId: tmdbId || null,
      tvdbId: tvdbId || null
    };

  } catch (error) {
    console.warn(`Could not fetch external ids for ${imdbId} from Cinemeta for type ${type}. Error: ${error.message}`);
    return undefined;
  }
}

module.exports = { resolveAllIds };
