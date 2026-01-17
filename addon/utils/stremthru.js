const { httpGet } = require("./httpClient");
const { cacheWrapMetaSmart } = require("../lib/getCache");
const { getMeta } = require("../lib/getMeta");
const Utils = require("./parseProps");
const idMapper = require("../lib/id-mapper");
const imdb = require("../lib/imdb");
const { getImdbRating } = require("../lib/getImdbRating");
const { resolveAllIds } = require('../lib/id-resolver');
const consola = require('consola');

const logger = consola.withTag('StremThru');

const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;

// --- Helper Functions ---

/**
 * A reusable, robust request helper.
 * @private
 */
async function _makeRequest(url) {
  try {
    const response = await httpGet(url, { headers: { 'User-Agent': 'aiometadata-addon/1.0' }, timeout: 30000 });
    return response.data;
  } catch (err) {
    if (err.response) {
      const { status, data } = err.response;
      logger.error(`HTTP error from ${url} (status: ${status}): ${typeof data === 'string' ? data.slice(0,100) : ''}`);
    } else {
      logger.error(`Request to ${url} failed:`, err.message);
    }
    throw err;
  }
}

/**
 * Processes a single anime item by finding its TMDB mapping and enriching it.
 * @private
 */
async function _processAnimeItem(item, provider, id, language, config, includeVideos = false) {
  const mappingFunctions = {
    kitsu: idMapper.getMappingByKitsuId,
    mal: idMapper.getMappingByMalId,
    anidb: idMapper.getMappingByAnidbId,
    anilist: idMapper.getMappingByAnilistId,
  };

  const getMapping = mappingFunctions[provider];
  const mapping = getMapping ? getMapping(id) : null;

  if (!mapping) {
    logger.info(`No mapping found for anime ${provider}:${id}`);
    return null; // Let the main loop handle the fallback
  }

  const malId = mapping.mal_id;
  const isMovie = item.type === 'movie';
  const imdbId = isMovie ? idMapper.getTraktAnimeMovieByMalId(malId)?.externals.imdb : mapping.imdb_id;


  if(config.mal?.useImdbIdForCatalogAndSearch && item.type === 'series' && imdbId){
    return (await cacheWrapMetaSmart(config.userUUID, imdbId, async () => {
      return await getMeta(item.type, language, imdbId, config, config.userUUID, includeVideos);
    }, undefined, { enableErrorCaching: true, maxRetries: 2 }, item.type, includeVideos))?.meta || null;
  }
  else if(!config.mal?.useImdbIdForCatalogAndSearch || !imdbId){
    const posterUrl = mapping.mal_id
    ? await Utils.getAnimePoster({ malId: mapping.mal_id, imdbId: imdbId, malPosterUrl: item.poster, mediaType: item.type }, config)
    : item.poster;

    let posterProxyUrl;
    if(imdbId && Utils.isPosterRatingEnabled(config)){
      posterProxyUrl = Utils.buildPosterProxyUrl(host, item.type, imdbId, posterUrl, language, config);
    }else{
      posterProxyUrl = posterUrl;
    }
    const details = await imdb.getMetaFromImdb(imdbId, item.type);

    logger.debug(`StremThru item: ${JSON.stringify(item)}`);
    return {
      id: item.id,
      type: item.type,
      cast: details?.cast || [],
      name: item.name ,
      poster: posterProxyUrl,
      releaseInfo: details?.releaseInfo || item.releaseInfo,
      background: details?.background || item.background,
      logo: details?.logo,
      description: Utils.addMetaProviderAttribution(item.description || details?.description, provider, config),
      imdbRating: details?.imdbRating || item.imdbRating,
      genres: item.genres || [],
      runtime: details?.runtime,
      year: item.releaseInfo, 
      trailers: item.trailers || details?.trailers || [],
      behavioralHints: details?.behavioralHints || item.behavioralHints,
    };
  }

}

/**
 * Processes a standard movie or series item using the addon's core getMeta function.
 * @private
 */
async function _processStandardItem(item, provider, language, config, includeVideos = false) {
  let stremioId = item.id;
  const result = await cacheWrapMetaSmart(config.userUUID, item.id, async () => {
      return await getMeta(item.type, language, stremioId, config, config.userUUID, includeVideos);
  }, undefined, { enableErrorCaching: true, maxRetries: 2 }, item.type, includeVideos);
  
  if (result?.meta && item.behaviorHints && Object.keys(item.behaviorHints).length > 0) {
    result.meta.behaviorHints = item.behaviorHints;
  }
  
  return result?.meta || null;
}

/**
 * Creates a basic fallback meta object when processing fails.
 * @private
 */
function _createFallbackMeta(item, language, config) {
    const fallbackPosterUrl = item.poster || `${host}/missing_poster.png`;
    const posterProxyUrl = Utils.isPosterRatingEnabled(config)
        ? `${host}/poster/${item.type}/${item.id}?fallback=${encodeURIComponent(fallbackPosterUrl)}&lang=${language}&key=${config.apiKeys?.rpdb}`
        : fallbackPosterUrl;
    
    return {
        id: item.id,
        type: item.type,
        name: item.name,
        poster: posterProxyUrl,
        description: item.description || '',
        genres: item.genres || [],
        year: item.releaseInfo || null,
        releaseInfo: item.releaseInfo || null,
        imdbRating: item.imdbRating || null,
    };
}


// --- Exported Functions ---

async function fetchStremThruCatalog(catalogUrl, skip = 0, genre) {
  try {
    let url = catalogUrl;
    
    // Build URL parameters
    const params = [];
    if (skip > 0) params.push(`skip=${skip}`);
    if (genre && genre.toLowerCase() !== 'none') params.push(`genre=${encodeURIComponent(genre)}`);
    
    if (params.length > 0) {
      // Remove .json extension if present, add parameters, then add .json back
      url = url.replace(/\.json$/, '');
      url = `${url}/${params.join('&')}.json`;
    }
    
    const data = await _makeRequest(url);
    if (!data || !data.metas) {
      logger.warn(`Invalid response format from ${catalogUrl}`);
      return [];
    }
    logger.debug(`Successfully fetched ${data.metas.length} items from catalog (skip: ${skip}, genre: ${genre || 'all'})`);
    return data.metas;
  } catch (err) {
    return [];
  }
}

async function fetchStremThruManifest(manifestUrl) {
  try {
    const data = await _makeRequest(manifestUrl);
    if (!data || !data.catalogs) {
      logger.warn(`Invalid manifest format from ${manifestUrl}`);
      return [];
    }
    logger.debug(`Successfully fetched ${data.catalogs.length} catalogs from manifest`);
    return data.catalogs;
  } catch (err) {
    return [];
  }
}

async function getGenresFromStremThruCatalog(items) {
  try {
    const genres = [
      ...new Set(
        items.flatMap(item =>
          (item.genres || []).map(g =>
            (g && typeof g === "string") ? g.charAt(0).toUpperCase() + g.slice(1).toLowerCase() : null
          )
        ).filter(Boolean)
      )
    ].sort();
    logger.debug(`Extracted ${genres.length} unique genres from catalog`);
    return genres;
  } catch (err) {
    logger.error("ERROR in getGenresFromStremThruCatalog:", err);
    return [];
  }
}

async function parseStremThruItems(items, type, genreFilter, language, config, includeVideos = false) {
  const animeProviders = new Set(['mal', 'kitsu', 'anidb', 'anilist']);
  
  
  logger.debug(`Processing ${items.length} items (type: ${type}, genre: ${genreFilter || 'all'})`);

  const metaPromises = items.map(async item => {
    try {
      let provider, id;
      
      // Handle tun_ prefix (Trakt Up Next)
      if (item.id.startsWith('tun_')) {
        provider = 'imdb';
        id = item.id.replace(/^tun_/, ''); // Strip tun_ prefix
      }
      // Handle standard IMDB IDs
      else if (item.id.startsWith('tt')) {
        provider = 'imdb';
        id = item.id;
      }
      // Handle provider:id format
      else {
        [provider, id] = item.id.split(':');
      }
      
      if (!provider || !id) {
        logger.warn(`Invalid ID format: ${item.id}`);
        return _createFallbackMeta(item, language, config);
      }

      let meta;
      if (animeProviders.has(provider)) {
        meta = await _processAnimeItem(item, provider, id, language, config, includeVideos);
      } else {
        meta = await _processStandardItem(item, provider, language, config, includeVideos);
      }
      
      // If a processor returns null (e.g., anime mapping failed), use the fallback.
      return meta || _createFallbackMeta(item, language, config);

    } catch (error) {
      logger.error(`Error processing item ${item.id}:`, error.message);
      return _createFallbackMeta(item, language, config);
    }
  });

  const metas = await Promise.all(metaPromises);
  const validMetas = metas.filter(Boolean);
  
  logger.debug(`Successfully parsed ${validMetas.length}/${items.length} items`);
  return validMetas;
}

module.exports = {
  fetchStremThruCatalog,
  fetchStremThruManifest,
  getGenresFromStremThruCatalog,
  parseStremThruItems
};