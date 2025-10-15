const { request } = require("undici");
const { cacheWrapMetaSmart } = require("../lib/getCache");
const { getMeta } = require("../lib/getMeta");
const Utils = require("./parseProps");
const idMapper = require("../lib/id-mapper");
const imdb = require("../lib/imdb");
const { getImdbRating } = require("../lib/getImdbRating");
const { resolveAllIds } = require('../lib/id-resolver');

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
    const response = await request(new URL(url).toString(), {
      method: 'GET',
      headers: { 'User-Agent': 'aiometadata-addon/1.0' },
      bodyTimeout: 30000
    });
    return await response.body.json();
  } catch (err) {
    console.error(`[StremThru] Request to ${url} failed:`, err.message);
    throw err; // Re-throw to be caught by the caller
  }
}

/**
 * Processes a single anime item by finding its TMDB mapping and enriching it.
 * @private
 */
async function _processAnimeItem(item, provider, id, language, config) {
  const mappingFunctions = {
    kitsu: idMapper.getMappingByKitsuId,
    mal: idMapper.getMappingByMalId,
    anidb: idMapper.getMappingByAnidbId,
    anilist: idMapper.getMappingByAnilistId,
  };

  const getMapping = mappingFunctions[provider];
  const mapping = getMapping ? getMapping(id) : null;

  if (!mapping) {
    console.warn(`[StremThru] No mapping found for anime ${provider}:${id}`);
    return null; // Let the main loop handle the fallback
  }

  const imdbId = mapping.imdb_id;
  const isMovie = item.type === 'movie';


  if(config.mal?.useImdbIdForCatalogAndSearch && item.type === 'series' && mapping.imdb_id){
    return (await cacheWrapMetaSmart(config.userUUID, imdbId, async () => {
      return await getMeta(item.type, language, imdbId, config, config.userUUID, false);
    }, undefined, { enableErrorCaching: true, maxRetries: 2 }, item.type, false))?.meta || null;
  }
  else if(!config.mal?.useImdbIdForCatalogAndSearch || !imdbId){
    const posterUrl = mapping.mal_id
    ? await Utils.getAnimePoster({ malId: mapping.mal_id, imdbId: imdbId, malPosterUrl: item.poster, mediaType: item.type }, config)
    : item.poster;

    let posterProxyUrl;
    if(imdbId){
      posterProxyUrl = `${host}/poster/${item.type}/${imdbId}?fallback=${encodeURIComponent(posterUrl)}&lang=${language}&key=${config.apiKeys?.rpdb}`;
    }else{
      posterProxyUrl = posterUrl;
    }
    const details = await imdb.getMetaFromImdb(imdbId, item.type);

    console.log(`[StremThru] StremThru item: ${JSON.stringify(item)}`);
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
async function _processStandardItem(item, provider, language, config) {
  const result = await cacheWrapMetaSmart(config.userUUID, item.id, async () => {
      let stremioId = item.id;
      //  if (preferredProvider === 'tvdb' && allIds?.tvdbId) {
      //      stremioId = `tvdb:${allIds.tvdbId}`;
      //  } else if (preferredProvider === 'tvmaze' && allIds?.tvmazeId) {
      //      stremioId = `tvmaze:${allIds.tvmazeId}`;
      //  } else if (preferredProvider === 'imdb' && allIds?.imdbId) {
      //      stremioId = allIds.imdbId;
      //  } else if (preferredProvider === 'tmdb' && allIds?.tmdbId) {
       //     stremioId = `tmdb:${allIds.tmdbId}`;
      //  }
      //}
      
      // Use the potentially translated ID to get the meta.
      // Note: Your getMeta function must be able to handle these different ID formats.
      return await getMeta(item.type, language, stremioId, config, config.userUUID, false);
  }, undefined, { enableErrorCaching: true, maxRetries: 2 }, item.type, false);
  
  return result?.meta || null;
}

/**
 * Creates a basic fallback meta object when processing fails.
 * @private
 */
function _createFallbackMeta(item, language, config) {
    const fallbackPosterUrl = item.poster || `${host}/missing_poster.png`;
    const posterProxyUrl = `${host}/poster/${item.type}/${item.id}?fallback=${encodeURIComponent(fallbackPosterUrl)}&lang=${language}&key=${config.apiKeys?.rpdb}`;
    
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
      console.warn(`[StremThru] Invalid response format from ${catalogUrl}`);
      return [];
    }
    console.log(`[✨ StremThru] Successfully fetched ${data.metas.length} items from catalog (skip: ${skip}, genre: ${genre || 'all'})`);
    return data.metas;
  } catch (err) {
    return [];
  }
}

async function fetchStremThruManifest(manifestUrl) {
  try {
    const data = await _makeRequest(manifestUrl);
    if (!data || !data.catalogs) {
      console.warn(`[StremThru] Invalid manifest format from ${manifestUrl}`);
      return [];
    }
    console.log(`[✨ StremThru] Successfully fetched ${data.catalogs.length} catalogs from manifest`);
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
    console.log(`[✨ StremThru] Extracted ${genres.length} unique genres from catalog`);
    return genres;
  } catch (err) {
    console.error("[StremThru] ERROR in getGenresFromStremThruCatalog:", err);
    return [];
  }
}

async function parseStremThruItems(items, type, genreFilter, language, config) {
  const animeProviders = new Set(['mal', 'kitsu', 'anidb', 'anilist']);
  
  
  console.log(`[✨ StremThru] Processing ${items.length} items (type: ${type}, genre: ${genreFilter || 'all'})`);

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
        console.warn(`[StremThru] Invalid ID format: ${item.id}`);
        return _createFallbackMeta(item, language, config);
      }

      let meta;
      if (animeProviders.has(provider)) {
        meta = await _processAnimeItem(item, provider, id, language, config);
      } else {
        meta = await _processStandardItem(item, provider, language, config);
      }
      
      // If a processor returns null (e.g., anime mapping failed), use the fallback.
      return meta || _createFallbackMeta(item, language, config);

    } catch (error) {
      console.error(`[StremThru] Error processing item ${item.id}:`, error.message);
      return _createFallbackMeta(item, language, config);
    }
  });

  const metas = await Promise.all(metaPromises);
  const validMetas = metas.filter(Boolean);
  
  console.log(`[✨ StremThru] Successfully parsed ${validMetas.length}/${items.length} items`);
  return validMetas;
}

module.exports = {
  fetchStremThruCatalog,
  fetchStremThruManifest,
  getGenresFromStremThruCatalog,
  parseStremThruItems
};