require("dotenv").config();
const { getGenreList } = require("./getGenreList");
const { getLanguages } = require("./getLanguages");
const { fetchMDBListItems, parseMDBListItems } = require("../utils/mdbList");
const { fetchStremThruCatalog, parseStremThruItems } = require("../utils/stremthru");
const CATALOG_TYPES = require("../static/catalog-types.json");
const moviedb = require("./getTmdb");
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
const TVDB_IMAGE_BASE = 'https://artworks.thetvdb.com';
const tvdb = require('./tvdb');
const { to3LetterCode, to3LetterCountryCode } = require('./language-map');
const Utils = require('../utils/parseProps');
const { resolveAllIds } = require('./id-resolver');
const { cacheWrapTvdbApi } = require('./getCache');
const { getTVDBContentRatingId } = require('../utils/tvdbContentRating');
const { getImdbRating } = require('./getImdbRating');

const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;

async function getCatalog(type, language, page, id, genre, config, userUUID) {
  try {
    if (id === 'tvdb.collections') {
      console.log(`[getCatalog] Fetching TVDB collections catalog: ${id}`);
      const metas = await getTvdbCollectionsCatalog(type, id, page, language, config);
      return { metas: metas };
    }
    if (id.startsWith('tvdb.') && !id.startsWith('tvdb.collection.')) {
      console.log(`[getCatalog] Routing to TVDB catalog handler for id: ${id}`);
      const tvdbResults = await getTvdbCatalog(type, id, genre, page, language, config);
      return { metas: tvdbResults };
    } 
    else if (id.startsWith('tmdb.') || id.startsWith('mdblist.') || id.startsWith('streaming.')) {
      console.log(`[getCatalog] Routing to TMDB/MDBList catalog handler for id: ${id}`);
      const tmdbResults = await getTmdbAndMdbListCatalog(type, id, genre, page, language, config, userUUID);
      return { metas: tmdbResults };
    }
    else if (id.startsWith('stremthru.')) {
      console.log(`[getCatalog] Routing to StremThru catalog handler for id: ${id}`);
      const stremthruResults = await getStremThruCatalog(type, id, genre, page, language, config, userUUID);
      return { metas: stremthruResults };
    }

    else {
      console.warn(`[getCatalog] Received request for unknown catalog prefix: ${id}`);
      return { metas: [] };
    }
  } catch (error) {
    console.warn(`[getCatalog] Error in getCatalog router for id=${id}, type=${type}:`, error.message);
    return { metas: [] };
  }
}

async function getTvdbCatalog(type, catalogId, genreName, page, language, config) {
  console.log(`[getCatalog] Fetching TVDB catalog: ${catalogId}, Genre: ${genreName}, Page: ${page}`);
  
  // Cache the raw TVDB API response using a cache key that doesn't include page
  const cacheKey = `tvdb-filter:${type}:${genreName}:${language}`;
  
  const allTvdbGenres = await getGenreList('tvdb', language, type, config);
  console.log(`[getCatalog] TVDB genres fetched: ${allTvdbGenres.length} genres available`);
  
  const genre = allTvdbGenres.find(g => g.name === genreName);
  console.log(`[getCatalog] Genre lookup for "${genreName}":`, genre ? `Found ID ${genre.id}` : 'NOT FOUND');
  
  const langParts = language.split('-');
  const langCode2 = langParts[0];
  const countryCode2 = langParts[1] || langCode2; 
  const langCode3 = await to3LetterCode(langCode2, config);
  const countryCode3 = to3LetterCountryCode(countryCode2);
  const tvdbContentRatingId = getTVDBContentRatingId(config.ageRating, countryCode3, type === 'movie' ? 'movie' : 'episode');
  
  const params = {
    country: countryCode3 || 'usa',
    lang: langCode3 || 'eng',
    sort: 'score'
  };

  if (tvdbContentRatingId) {
    console.log(`[getCatalog] Using TVDB content rating ID ${tvdbContentRatingId} for TVDB filter`);
    params.contentRating = tvdbContentRatingId;
  }

  if (genre) {
    params.genre = genre.id;
    console.log(`[getCatalog] Using genre ID ${genre.id} for TVDB filter`);
  } else {
    console.log(`[getCatalog] WARNING: No genre found for "${genreName}", proceeding without genre filter`);
  }
  
  const tvdbType = type === 'movie' ? 'movies' : 'series';
  if(tvdbType === 'series'){
    params.sortType = 'desc';
  }
  
  console.log(`[getCatalog] TVDB filter params:`, JSON.stringify(params));
  
  // Use cacheWrapTvdbApi to cache the raw API response
  const results = await cacheWrapTvdbApi(cacheKey, async () => {
    return await tvdb.filter(tvdbType, params, config);
  });
  
  console.log(`[getCatalog] TVDB filter results: ${results ? results.length : 0} items returned`);
  
  if (!results || results.length === 0) {
    console.log(`[getCatalog] No results from TVDB filter, returning empty array`);
    return [];
  }

  // Sort results by score (highest first)
  const sortedResults = results.sort((a, b) => b.score - a.score);
  
  // Apply client-side pagination
  const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE) || 20;
  const startIndex = (page - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  const paginatedResults = sortedResults.slice(startIndex, endIndex);
  
  console.log(`[getCatalog] Pagination: page ${page}, showing items ${startIndex + 1}-${Math.min(endIndex, sortedResults.length)} of ${sortedResults.length} total results`);

  const metas = await Promise.all(paginatedResults.map(async item => {
    const tvdbId = item.id;
    const allIds = await resolveAllIds(`tvdb:${tvdbId}`, type, config);
    if (!tvdbId) return null;
    const fallbackPosterUrl = item.image ? (item.image.startsWith('http') ? item.image : `${TVDB_IMAGE_BASE}${item.image}`) : `https://artworks.thetvdb.com/banners/images/missing/series.jpg`;
    const posterUrl = type === 'movie' ? await Utils.getMoviePoster({ tmdbId: allIds?.tmdbId, tvdbId: tvdbId, imdbId: null, metaProvider: 'tvdb', fallbackPosterUrl: fallbackPosterUrl }, config) : await Utils.getSeriesPoster({ tmdbId: null, tvdbId: tvdbId, imdbId: null, metaProvider: 'tvdb', fallbackPosterUrl: fallbackPosterUrl }, config);
    const posterProxyUrl = `${host}/poster/${type}/${type === 'movie' && allIds?.tmdbId ? `tmdb:${allIds?.tmdbId}` : `tvdb:${tvdbId}`}?fallback=${encodeURIComponent(posterUrl)}&lang=${language}&key=${config.apiKeys?.rpdb}`;
    return {
      id: `tvdb:${tvdbId}`,
      imdb_id: allIds?.imdbId,
      type: type,
      name: item.name,
      description: item.overview,
      poster: posterProxyUrl,
      logo: type === 'movie' ? await moviedb.getTmdbMovieLogo(allIds?.tmdbId, config) : await moviedb.getTmdbSeriesLogo(allIds?.tmdbId, config),
      year: item.year || null,
      runtime: Utils.parseRunTime(item.runtime),
      releaseInfo: item.year || null,
    };
  }).filter(Boolean));

  return metas;
}

async function getTvdbCollectionsCatalog(type, id, page, language, config) {
  const langCode = language.split('-')[0];
  if (id === 'tvdb.collections') {
    // Cache the collections list for this specific page
    const collections = await cacheWrapTvdbApi(`collections-list:${page}`, () => tvdb.getCollectionsList(config, page));
    if (!collections || !collections.length) return [];
    
    console.log(`[getTvdbCollectionsCatalog] Page ${page}: fetched ${collections.length} collections from TVDB API`);
    
    // Fetch extended details and translations for each collection in parallel
    const metas = await Promise.all(collections.map(async col => {
      const extended = await cacheWrapTvdbApi(`collection-extended:${col.id}`, () => tvdb.getCollectionDetails(col.id, config));
      if (!extended) return null;
      // Try to get translation in user language, fallback to English, then fallback to default
      let translation = await tvdb.getCollectionTranslations(col.id, langCode, config);
      if (!translation || !translation.name) {
        translation = await tvdb.getCollectionTranslations(col.id, 'eng', config);
      }
      const name = translation && translation.name ? translation.name : extended.name;
      if (!name) return null;
      const overview = translation && translation.overview ? translation.overview : extended.overview;
      const poster = extended.image ? (extended.image.startsWith('http') ? extended.image : `${TVDB_IMAGE_BASE}${extended.image}`) : undefined;
      return {
        id: `tvdbc:${col.id}`,
        type: 'series',
        name,
        poster,
        description: overview,
        year: extended.year || null
      };
    }));
    return metas.filter(Boolean);
  }
  return [];
}

async function getTmdbAndMdbListCatalog(type, id, genre, page, language, config, userUUID) {
  if (id.startsWith("mdblist.")) {
    console.log(`[getCatalog] Fetching MDBList catalog: ${id}, Genre: ${genre}, Page: ${page}`);
    const listId = id.split(".")[1];
    const results = await fetchMDBListItems(listId, config.apiKeys?.mdblist, language, page);
    return await parseMDBListItems(results, type, genre, language, config);
  }

  const genreList = await getGenreList('tmdb', language, type, config);
  const parameters = await buildParameters(type, language, page, id, genre, genreList, config);

  const fetchFunction = type === "movie" 
    ? () => moviedb.discoverMovie(parameters, config) 
    : () => moviedb.discoverTv(parameters, config);

  const res = await fetchFunction();
  const metas = await Promise.all(res.results.map(async item => {
    // Resolve IDs for each individual item
    // Check all three art types and collect non-meta providers
    const posterProvider = Utils.resolveArtProvider(type, 'poster', config);
    const backgroundProvider = Utils.resolveArtProvider(type, 'background', config);
    const logoProvider = Utils.resolveArtProvider(type, 'logo', config);

    // Determine preferred meta provider
    let preferredProvider;
    if (type === 'movie') {
      preferredProvider = config.providers?.movie || 'tmdb';
    } else {
      preferredProvider = config.providers?.series || 'tvdb';
    }

    // Collect all unique non-meta providers
    const targetProviders = new Set();
    if (posterProvider !== preferredProvider && posterProvider !== 'tmdb' && posterProvider !== 'fanart') targetProviders.add(posterProvider);
    if (backgroundProvider !== preferredProvider && backgroundProvider !== 'tmdb' && backgroundProvider !== 'fanart') targetProviders.add(backgroundProvider);
    if (logoProvider !== preferredProvider && logoProvider !== 'tmdb' && logoProvider !== 'fanart') targetProviders.add(logoProvider);
    if (preferredProvider !== 'tmdb') targetProviders.add(preferredProvider);
    if ((posterProvider === 'fanart' || backgroundProvider === 'fanart' || logoProvider === 'fanart') && type === 'series') targetProviders.add('tvdb');

    let allIds;
    if (targetProviders.size > 0) {
      const targetProviderArray = Array.from(targetProviders);
      allIds = await resolveAllIds(`tmdb:${item.id}`, type, config, null, targetProviderArray);
    }
    const tmdbLogoUrl = type === 'movie' ? await moviedb.getTmdbMovieLogo(item.id, config) : await moviedb.getTmdbSeriesLogo(item.id, config);

    let stremioId = `tmdb:${item.id}`;
    if(preferredProvider === 'tvdb' && allIds?.tvdbId) {
      stremioId = `tvdb:${allIds.tvdbId}`;
    } else if(preferredProvider === 'tvmaze' && allIds?.tvmazeId) {
      stremioId = `tvmaze:${allIds.tvmazeId}`;
    } else if(preferredProvider === 'imdb' && allIds?.imdbId) {
      stremioId = allIds.imdbId;
    }


    // Poster and background with art provider logic
    const tmdbPosterFullUrl = item.poster_path
      ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${item.poster_path}`
      : `https://artworks.thetvdb.com/banners/images/missing/series.jpg`;
    const tmdbBackgroundFullUrl = item.backdrop_path
      ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` 
      : undefined;
    const itemDetails = type === 'movie' ? await moviedb.movieInfo({ id: item.id, language, append_to_response: "external_ids" }, config) : await moviedb.tvInfo({ id: item.id, language, append_to_response: "external_ids" }, config);
    let posterUrl = tmdbPosterFullUrl;
    let backgroundUrl = tmdbBackgroundFullUrl;
    if(allIds) {
      if (type === 'movie') {
        posterUrl = await Utils.getMoviePoster({
          tmdbId: allIds.tmdbId,
          tvdbId: allIds.tvdbId,
          imdbId: allIds.imdbId,
          metaProvider: preferredProvider,
          fallbackPosterUrl: tmdbPosterFullUrl
        }, config);
        backgroundUrl = await Utils.getMovieBackground({
          tmdbId: allIds.tmdbId,
          tvdbId: allIds.tvdbId,
          imdbId: allIds.imdbId,
          metaProvider: preferredProvider,
          fallbackBackgroundUrl: tmdbBackgroundFullUrl
        }, config);
      } else {
        posterUrl = await Utils.getSeriesPoster({
          tmdbId: allIds.tmdbId,
          tvdbId: allIds.tvdbId,
          imdbId: allIds.imdbId,
          metaProvider: preferredProvider,
          fallbackPosterUrl: tmdbPosterFullUrl
        }, config);
        backgroundUrl = await Utils.getSeriesBackground({
          tmdbId: allIds.tmdbId,
          tvdbId: allIds.tvdbId,
          imdbId: allIds.imdbId,
          metaProvider: preferredProvider,
            fallbackBackgroundUrl: tmdbBackgroundFullUrl
          }, config);
      }
    }
    const runtime = type === 'movie' ? itemDetails?.runtime || null : itemDetails?.episode_run_time?.[0] ?? itemDetails?.last_episode_to_air?.runtime ?? itemDetails?.next_episode_to_air?.runtime ?? null;
    const posterProxyUrl = `${host}/poster/${type}/${`tmdb:${item.id}`}?fallback=${encodeURIComponent(posterUrl)}&lang=${language}&key=${config.apiKeys?.rpdb}`;
    const imdbRating = await getImdbRating(itemDetails.imdb_id || itemDetails.external_ids.imdb_id || allIds?.imdbId, type) || item.vote_average?.toFixed(1) || "N/A";
    return {
      id: stremioId,
      type: type,
      imdb_id: itemDetails.imdb_id || itemDetails.external_ids.imdb_id || allIds?.imdbId,
      logo: tmdbLogoUrl,
      releaseInfo: (item.release_date || item.first_air_date || '').substring(0, 4),
      name: item.title || item.name,
      poster: posterProxyUrl,
      year: (item.release_date || item.first_air_date || '').substring(0, 4),
      background: backgroundUrl,
      description: item.overview,
      runtime: Utils.parseRunTime(runtime),
      genres: item.genre_ids.map(g => genreList.find(genre => genre.id === g)?.name),
      imdbRating: imdbRating,
    };
  }));

  return metas;
}

async function buildParameters(type, language, page, id, genre, genreList, config) {
  const languages = await getLanguages(config);
  const parameters = { language, page};

  if (id === 'tmdb.top' && type === 'series') {
    console.log('[TMDB Filter] Applying genre exclusion for popular series catalog.');

    const excludedGenreIds = [
      '10767', // Talk
      '10763', // News
      '10768', // War & Politics
    ];
    
    parameters.without_genres = excludedGenreIds.join(',');
    
    console.log(`[TMDB Filter] Excluding genre IDs: ${parameters.without_genres}`);
  }

  if (config.ageRating) {
    switch (config.ageRating) {
      case "G":
        parameters.certification_country = "US";
        parameters.certification = type === "movie" ? "G" : "TV-G";
        break;
      case "PG":
        parameters.certification_country = "US";
        parameters.certification = type === "movie" ? ["G", "PG"].join("|") : ["TV-G", "TV-PG"].join("|");
        break;
      case "PG-13":
        parameters.certification_country = "US";
        parameters.certification = type === "movie" ? ["G", "PG", "PG-13"].join("|") : ["TV-G", "TV-PG", "TV-14"].join("|");
        break;
      case "R":
        parameters.certification_country = "US";
        parameters.certification = type === "movie" ? ["G", "PG", "PG-13", "R"].join("|") : ["TV-G", "TV-PG", "TV-14", "TV-MA"].join("|");
        break;
      case "NC-17":
        break;
    }
  }

  if (id.includes("streaming")) {
    const provider = findProvider(id.split(".")[1]);
    console.log(`[getCatalog] Found provider: ${JSON.stringify(provider)}`);

    parameters.with_genres = genre ? findGenreId(genre, genreList) : undefined;
    parameters.with_watch_providers = provider.watchProviderId
    parameters.watch_region = provider.country;
    parameters.with_watch_monetization_types = "flatrate|free|ads";
  } else {
    switch (id) {
      case "tmdb.top":
        parameters.sort_by = 'popularity.desc'
        parameters.with_genres = genre ? findGenreId(genre, genreList) : undefined;
        if (type === "series") {
          parameters.watch_region = language.split("-")[1];
          parameters.with_watch_monetization_types = "flatrate|free|ads|rent|buy";
        }
        break;
      case "tmdb.year":
        const year = genre ? genre : new Date().getFullYear();
        parameters[type === "movie" ? "primary_release_year" : "first_air_date_year"] = year;
        break;
      case "tmdb.language":
        const findGenre = genre ? findLanguageCode(genre, languages) : language.split("-")[0];
        parameters.with_original_language = findGenre;
        break;
      default:
        break;
    }
  }
  return parameters;
}

function findGenreId(genreName, genreList) {
  const genreData = genreList.find(genre => genre.name === genreName);
  return genreData ? genreData.id : undefined;
}

function findLanguageCode(genre, languages) {
  const language = languages.find((lang) => lang.name === genre);
  return language ? language.iso_639_1.split("-")[0] : "";
}

function findProvider(providerId) {
  const provider = CATALOG_TYPES.streaming[providerId];
  if (!provider) throw new Error(`Could not find provider: ${providerId}`);
  return provider;
}

/**
 * Handles StremThru catalog requests
 * @param {string} type - Content type ('movie' or 'series')
 * @param {string} catalogId - The StremThru catalog ID
 * @param {string} genre - Optional genre filter
 * @param {number} page - Page number
 * @param {string} language - Language code
 * @param {Object} config - Addon configuration
 * @param {string} userUUID - User UUID
 * @returns {Promise<Array>} Array of meta items
 */
async function getStremThruCatalog(type, catalogId, genre, page, language, config, userUUID) {
  try {
    console.log(`[✨ StremThru] Processing catalog request: ${catalogId}, type: ${type}, genre: ${genre || 'none'}, page: ${page}`);
    
    // Find the user catalog configuration to get the source URL
    const userCatalog = config.catalogs?.find(c => c.id === catalogId);
    if (!userCatalog || (!userCatalog.sourceUrl && !userCatalog.source)) {
      console.error(`[✨ StremThru] No source URL found for catalog: ${catalogId}`);
      return [];
    }
    
    // Use sourceUrl for StremThru catalogs, fallback to source for backward compatibility
    const catalogUrl = userCatalog.sourceUrl || userCatalog.source;
    // sparkle emoji
    console.log(`[✨ StremThru] Using catalog URL: ${catalogUrl}`);
    
    // Fetch catalog items from StremThru with proper pagination
    const items = await fetchStremThruCatalog(catalogUrl);
    if (!items || items.length === 0) {
      console.warn(`[StremThru] No items returned from catalog: ${catalogUrl} (page: ${page})`);
      return [];
    }

    // Apply client-side pagination
    const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE) || 20;
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedItems = items.slice(startIndex, endIndex);
    
    // Parse items into Stremio format
    const metas = await parseStremThruItems(paginatedItems, type, genre, language, config);
    
    console.log(`[StremThru] Successfully processed ${metas.length} items for catalog: ${catalogId} (page: ${page})`);
    return metas;
    
  } catch (error) {
    console.error(`[StremThru] Error processing catalog ${catalogId}:`, error.message);
    return [];
  }
}

module.exports = { getCatalog };
