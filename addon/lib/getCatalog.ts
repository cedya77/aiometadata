require("dotenv").config();
import { getGenreList } from "./getGenreList.js";
import { getLanguages } from "./getLanguages.js";
import { fetchMDBListItems, parseMDBListItems, fetchMDBListBatchMediaInfo } from "../utils/mdbList.js";
import { fetchStremThruCatalog, parseStremThruItems } from "../utils/stremthru.js";
import { fetchTraktWatchlistItems, fetchTraktFavoritesItems, fetchTraktRecommendationsItems, fetchTraktListItems, parseTraktItems, fetchTraktMostFavoritedItems, fetchTraktCalendarShows } from "../utils/traktUtils.js";
import { fetchListItems } from "./anilistCatalog.js";
import * as Utils from '../utils/parseProps.js';
import * as CATALOG_TYPES from "../static/catalog-types.json";
import * as moviedb from "./getTmdb.js";
import * as tvdb from './tvdb.js';
import { to3LetterCode, to3LetterCountryCode } from './language-map.js';
import { resolveAllIds } from './id-resolver.js';
import { cacheWrapTvdbApi, cacheWrap, cacheWrapAniListCatalog } from './getCache.js';
import { getTVDBContentRatingId } from '../utils/tvdbContentRating.js';
import { getMeta } from './getMeta.js';

const consola = require('consola');
const database = require('./database.js');

const logger = consola.create({ 
  level: process.env.LOG_LEVEL ? 
    (consola.LogLevels[process.env.LOG_LEVEL.toLowerCase()] ?? 4) : 
    (process.env.NODE_ENV === 'production' ? 3 : 4),
  fancy: true,
  colors: true,
  formatOptions: {
    colors: true,
    compact: false,
    date: false,
  },
  tag: 'Catalog'
});

/**
 * Helper to get Trakt access token from database
 */
async function getTraktAccessToken(config: any): Promise<string | null> {
  if (!config.apiKeys?.traktTokenId) {
    return null;
  }
  
  const tokenData = await database.getOAuthToken(config.apiKeys.traktTokenId);
  if (!tokenData) {
    logger.warn(`Trakt token not found in database: ${config.apiKeys.traktTokenId}`);
    return null;
  }
  
  // Check if token is expired
  const now = Date.now();
  if (tokenData.expires_at && tokenData.expires_at < now) {
    logger.info(`Trakt token expired, needs refresh`);
    // TODO: Implement token refresh
    return null;
  }
  
  return tokenData.access_token;
}
import { cacheWrapMetaSmart } from './getCache.js';
import { UserConfig } from '../types/index.js';
import { isReleasedDigitally } from "../utils/parseProps.js";
import { filterMetasByRegex } from "../utils/regexFilter.js";

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
const TVDB_IMAGE_BASE = 'https://artworks.thetvdb.com';

const host = process.env.HOST_NAME?.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;

/**
 * Apply age rating filter to metas based on user configuration
 * @param metas - Array of meta objects to filter
 * @param type - Content type ('movie' or 'series')
 * @param config - User configuration
 * @returns Filtered array of metas
 */
function applyAgeRatingFilter(metas: any[], type: string, config: any): any[] {
  if (!config.ageRating || config.ageRating.toLowerCase() === 'none') {
    return metas;
  }

  logger.info(`[StremThru] Applying age rating filter: ${config.ageRating} for type: ${type}`);
  const beforeCount = metas.length;
  const filterStartTime = performance.now();
  
  const movieRatingHierarchy = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
  const tvRatingHierarchy = ["TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA"];
  
  const movieToTvMap: { [key: string]: string } = {
    'G': 'TV-G',
    'PG': 'TV-PG', 
    'PG-13': 'TV-14',
    'R': 'TV-MA',
    'NC-17': 'TV-MA'
  };
  
  const isTvRating = type === 'series';
  const finalUserRating = isTvRating ? (movieToTvMap[config.ageRating] || config.ageRating) : config.ageRating;
  const ratingHierarchy = isTvRating ? tvRatingHierarchy : movieRatingHierarchy;
  const userRatingIndex = ratingHierarchy.indexOf(finalUserRating);

  if (userRatingIndex === -1) {
    return metas;
  }

  const filteredMetas = metas.filter(meta => {
    let cert: string | null = null;
    
    if (meta.app_extras?.certification) {
      cert = meta.app_extras.certification;
    } else {
      logger.debug(`[StremThru] ${type} ${meta.name}: No certification data available`);
    }

    // If rating is PG-13 or lower, exclude NR content as it could be inappropriate
    const isUserRatingRestrictive = finalUserRating === 'PG-13' || 
                                   (movieRatingHierarchy.indexOf(finalUserRating) !== -1 && 
                                    movieRatingHierarchy.indexOf(finalUserRating) <= movieRatingHierarchy.indexOf('PG-13')) ||
                                   (tvRatingHierarchy.indexOf(finalUserRating) !== -1 && 
                                    tvRatingHierarchy.indexOf(finalUserRating) <= tvRatingHierarchy.indexOf('TV-14'));
    
    if (!cert || cert === "" || cert.toLowerCase() === 'nr') {
      return !isUserRatingRestrictive; // Exclude NR if user rating is restrictive
    }
      
    const resultRatingIndex = ratingHierarchy.indexOf(cert);
    if (resultRatingIndex === -1) {
      return true; // Allow items with unknown ratings
    }
    
    return resultRatingIndex <= userRatingIndex;
  });
  
  const afterCount = filteredMetas.length;
  const filterTime = performance.now() - filterStartTime;
  if (beforeCount !== afterCount) {
    logger.info(`Age rating filter (StremThru): filtered out ${beforeCount - afterCount} items in ${filterTime.toFixed(2)}ms`);
  }

  return filteredMetas;
}


async function getCatalog(type: string, language: string, page: number, id: string, genre: string, config: UserConfig, userUUID: string, includeVideos: boolean = false): Promise<{ metas: any[] }> {
  try {
    if (id === 'tvdb.collections') {
      logger.info(`Fetching TVDB collections catalog: ${id}`);
      const metas = await getTvdbCollectionsCatalog(type, id, page, language, config);
      const filteredMetas = filterMetasByRegex(metas, config.exclusionKeywords || '', config.regexExclusionFilter || '');
      return { metas: filteredMetas };
    }
    if (id.startsWith('tvdb.') && !id.startsWith('tvdb.collection.')) {
      logger.info(`Routing to TVDB catalog handler for id: ${id}`);
      const tvdbResults = await getTvdbCatalog(type, id, genre, page, language, config, id === 'tvdb.trending', includeVideos);
      const filteredResults = filterMetasByRegex(tvdbResults, config.exclusionKeywords || '', config.regexExclusionFilter || '');
      return { metas: filteredResults };
    } 
    else if (id.startsWith('tmdb.') || id.startsWith('mdblist.') || id.startsWith('streaming.')) {
      logger.info(`Routing to TMDB/MDBList catalog handler for id: ${id}`);
      const tmdbResults = await getTmdbAndMdbListCatalog(type, id, genre, page, language, config, userUUID, includeVideos);
      const filteredResults = filterMetasByRegex(tmdbResults, config.exclusionKeywords || '', config.regexExclusionFilter || '');
      return { metas: filteredResults };
    }
    else if (id.startsWith('stremthru.')) {
      logger.info(`Routing to StremThru catalog handler for id: ${id}`);
      const stremthruResults = await getStremThruCatalog(type, id, genre, page, language, config, userUUID, includeVideos);
      const filteredResults = filterMetasByRegex(stremthruResults, config.exclusionKeywords || '', config.regexExclusionFilter || '');
      return { metas: filteredResults };
    }
    else if (id.startsWith('custom.')) {
      logger.info(`Routing to Custom Manifest catalog handler for id: ${id}`);
      const customResults = await getStremThruCatalog(type, id, genre, page, language, config, userUUID, includeVideos);
      const filteredResults = filterMetasByRegex(customResults, config.exclusionKeywords || '', config.regexExclusionFilter || '');
      return { metas: filteredResults };
    }
    else if (id.startsWith('trakt.')) {
      logger.info(`Routing to Trakt catalog handler for id: ${id}`);
      const traktResults = await getTraktCatalog(type, id, genre, page, language, config, userUUID, includeVideos);
      const filteredResults = filterMetasByRegex(traktResults, config.exclusionKeywords || '', config.regexExclusionFilter || '');
      return { metas: filteredResults };
    }
    else if (id.startsWith('anilist.')) {
      logger.info(`Routing to AniList catalog handler for id: ${id}`);
      const anilistResults = await getAniListCatalog(type, id, page, language, config, userUUID, includeVideos);
      const filteredResults = filterMetasByRegex(anilistResults, config.exclusionKeywords || '', config.regexExclusionFilter || '');
      return { metas: filteredResults };
    }

    else {
      logger.warn(`Received request for unknown catalog prefix: ${id}`);
      return { metas: [] };
    }
  } catch (error: any) {
    const errorLine = error.stack?.split('\n')[1]?.trim() || 'unknown';
    logger.error(`Error in getCatalog router for id=${id}, type=${type}: ${error.message}`);
    logger.error(`Error at: ${errorLine}`);
    logger.error(`Full stack trace:`, error.stack);
    return { metas: [] };
  }
}

async function getTvdbCatalog(type: string, catalogId: string, genreName: string, page: number, language: string, config: UserConfig, isTrending: boolean, includeVideos: boolean = false): Promise<any[]> {
  logger.info(`Fetching TVDB catalog: ${catalogId}, Genre: ${genreName}, Page: ${page}`);
  
  // Cache the raw TVDB API response using a cache key that doesn't include page
  const cacheKey = `tvdb-filter:${type}:${genreName}:${language}:${isTrending}`;
  
  const allTvdbGenres = await getGenreList('tvdb', language, type as "movie" | "series", config);
  logger.debug(`TVDB genres fetched: ${allTvdbGenres.length} genres available`);
  
  const genre = allTvdbGenres.find(g => g.name === genreName);
  logger.debug(`Genre lookup for "${genreName}":`, genre ? `Found ID ${genre.id}` : 'NOT FOUND');
  
  const langParts = language.split('-');
  const langCode2 = langParts[0];
  const countryCode2 = langParts[1] || langCode2; 
  const langCode3 = await to3LetterCode(langCode2, config);
  const countryCode3 = to3LetterCountryCode(countryCode2);
  const tvdbContentRatingId = getTVDBContentRatingId(config.ageRating as string, countryCode3, type === 'movie' ? 'movie' : 'episode');
  
  const params: any = {
    country:'usa',
    lang: 'eng',
    sort: 'score'
  };
  if (isTrending) {
    params.year = new Date().getFullYear();
  }

  if (tvdbContentRatingId) {
    logger.debug(`Using TVDB content rating ID ${tvdbContentRatingId} for TVDB filter`);
    params.contentRating = tvdbContentRatingId;
  }

  if (genre) {
    params.genre = genre.id;
    logger.debug(`Using genre ID ${genre.id} for TVDB filter`);
  } else {
    logger.warn(`No genre found for "${genreName}", proceeding without genre filter`);
  }
  
  const tvdbType = type === 'movie' ? 'movies' : 'series';
  if(tvdbType === 'series'){
    params.sortType = 'desc';
  }
  
  logger.debug(`TVDB filter params:`, JSON.stringify(params));
  
  // Use cacheWrapTvdbApi to cache the raw API response
  const results = await cacheWrapTvdbApi(cacheKey, async () => {
    return await tvdb.filter(tvdbType, params, config);
  });
  
  logger.info(`TVDB filter results: ${results ? results.length : 0} items returned`);
  
  if (!results || results.length === 0) {
    logger.warn(`No results from TVDB filter, returning empty array`);
    return [];
  }

  // Sort results by score (highest first)
  const sortedResults = results.sort((a: any, b: any) => b.score - a.score);
  
  // Apply client-side pagination
  const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE || '20');
  const startIndex = (page - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  const paginatedResults = sortedResults.slice(startIndex, endIndex);
  
  logger.info(`Pagination: page ${page}, showing items ${startIndex + 1}-${Math.min(endIndex, sortedResults.length)} of ${sortedResults.length} total results`);

  let preferredProvider: string;
  if (type === 'movie') {
    preferredProvider = config.providers?.movie || 'tmdb';
  } else {
    preferredProvider = config.providers?.series || 'tvdb';
  }
  const metas = await Promise.all(paginatedResults.map(async (item: any) => {
    const tvdbId = item.id;
    if (!tvdbId) return null;
    
    let stremioId = `tvdb:${tvdbId}`;
    //if(preferredProvider === 'tmdb' && allIds?.tmdbId) {
    //  stremioId = `tmdb:${allIds.tmdbId}`;
    //} else if(preferredProvider === 'tvmaze' && allIds?.tvmazeId) {
    //  stremioId = `tvmaze:${allIds.tvmazeId}`;
    //} else if(preferredProvider === 'imdb' && allIds?.imdbId) {
    //  stremioId = allIds.imdbId;
    //}
    
    const result = await cacheWrapMetaSmart(config.userUUID, stremioId, async () => {
      return await getMeta(type, language, stremioId, config, config.userUUID, includeVideos);
    }, undefined, {enableErrorCaching: true, maxRetries: 2}, type as any, includeVideos);
    
    if (result && result.meta) {
      return result.meta;
    }
    return null;
  }));

  let validMetas = metas.filter(meta => meta !== null);
  validMetas.sort((a, b) => new Date(b.released).getTime() - new Date(a.released).getTime());
  
  // Apply digital release filter if enabled (movies only)
  if (type === 'movie' && config.hideUnreleasedDigital) {
    const beforeCount = validMetas.length;
    validMetas = validMetas.filter(meta =>  isReleasedDigitally(meta));
    const afterCount = validMetas.length;
    if (beforeCount !== afterCount) {
      logger.info(`Digital release filter (TVDB): filtered out ${beforeCount - afterCount} unreleased movies`);
    }
  }
  
  return validMetas;
}

async function getTvdbCollectionsCatalog(type: string, id: string, page: number, language: string, config: UserConfig): Promise<any[]> {
  const langCode = language.split('-')[0];
  if (id === 'tvdb.collections') {
    // Cache the collections list for this specific page
    const collections = await cacheWrapTvdbApi(`collections-list:${page}`, () => tvdb.getCollectionsList(config, page));
    if (!collections || !collections.length) return [];
    
    logger.info(`Page ${page}: fetched ${collections.length} collections from TVDB API`);
    
    // Fetch extended details and translations for each collection in parallel
    const metas = await Promise.all(collections.map(async (col: any) => {
      const extended = await cacheWrapTvdbApi(`collection-extended:${col.id}`, () => tvdb.getCollectionDetails(col.id, config));
      if (!extended || !Array.isArray(extended.entities)) return null;
      
      // Only include collections that have at least one movie
      const hasMovies = extended.entities.some((e: any) => e.movieId);
      if (!hasMovies) return null;
      
      const langCode3 = await to3LetterCode(langCode, config);
      let translation = await tvdb.getCollectionTranslations(col.id, langCode3, config);

      const name = translation && translation.name ? translation.name : extended.name;
      if (!name) return null;
      const overview = translation && translation.overview ? translation.overview : extended.overview;
      const poster = extended.image ? (extended.image.startsWith('http') ? extended.image : `${TVDB_IMAGE_BASE}${extended.image}`) : undefined;
      return {
        id: `tvdbc:${col.id}`,
        type: 'movie', // Collections are movies only
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

async function getTmdbAndMdbListCatalog(type: string, id: string, genre: string, page: number, language: string, config: UserConfig, userUUID: string, includeVideos: boolean = false): Promise<any[]> {
  if (id.startsWith("mdblist.")) {
    logger.info(`Fetching MDBList catalog: ${id}, Genre: ${genre}, Page: ${page}`);
    const catalogConfig = config.catalogs?.find(c => c.id === id);
    const sort = catalogConfig?.sort === 'default' ? undefined : catalogConfig?.sort;
    const order = catalogConfig?.sort === 'default' ? undefined : catalogConfig?.order;
    logger.debug(`MDBList sorting - sort: ${sort}, order: ${order}`);
    
    // Convert genre title to slug format for MDBList API (using the mapping from API)
    const { convertGenreToSlug } = await import('../utils/mdbList');
    const genreSlug = convertGenreToSlug(genre);
    if (genreSlug !== genre) {
      logger.debug(`Converted genre "${genre}" to slug "${genreSlug}"`);
    }
    
    // Handle different watchlist catalog IDs
    let listId: string;
    let unified: boolean | undefined;
    
    if (id === 'mdblist.watchlist') {
      // Unified watchlist
      listId = 'watchlist';
      unified = true;
    } else if (id === 'mdblist.watchlist.movies' || id === 'mdblist.watchlist.series') {
      // Non-unified watchlist (separate movies/series catalogs)
      listId = 'watchlist';
      unified = false;
    } else {
      // Regular MDBList catalog
      listId = id.split(".")[1];
      unified = undefined;
    }
    
    const response = await fetchMDBListItems(listId, config.apiKeys?.mdblist || process.env.MDBLIST_API_KEY || '', language, page, sort, order, genreSlug, unified, type);
    
    // Smart pagination handling
    if (listId === 'watchlist') {
      // For watchlist, we only have hasMore information
      const itemInfo = `${response.items.length} items`;
      const statusInfo = response.hasMore ? 'more available' : 'end reached';
      
      logger.debug(`MDBList watchlist pagination - page ${page}, ${itemInfo}, ${statusInfo}`);
      
      // Early exit for empty pages beyond list end
      if (!response.hasMore && response.items.length === 0) {
        logger.debug(`MDBList watchlist early exit - no more items at page ${page}`);
        return [];
      }
    } else if (response.totalItems !== undefined && response.totalPages !== undefined) {
      const pageInfo = `page ${page}/${response.totalPages}`;
      const itemInfo = `${response.items.length} items`;
      const totalInfo = `${response.totalItems} total`;
      const statusInfo = response.hasMore ? 'more available' : 'end reached';
      
      logger.debug(`MDBList smart pagination - ${pageInfo}, ${itemInfo}, ${totalInfo}, ${statusInfo}`);
      
      // Early exit for empty pages beyond list end
      if (!response.hasMore && response.items.length === 0) {
        logger.debug(`MDBList early exit - no more items for list ${listId} at page ${page}`);
        return [];
      }
      
      // Performance warning for large offsets
      if (page > 50) {
        logger.warn(`MDBList performance warning - requesting page ${page} (offset ${(page - 1) * (parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20)}) for list ${listId}`);
      }
    }
    
    let metas = await parseMDBListItems(response.items, type, language, config, includeVideos);
    
    // Apply digital release filter if enabled (movies only)
    if (type === 'movie' && config.hideUnreleasedDigital) {
      const beforeCount = metas.length;
      metas = metas.filter(meta => isReleasedDigitally(meta));
      const afterCount = metas.length;
      if (beforeCount !== afterCount) {
        logger.info(`Digital release filter (MDBList): filtered out ${beforeCount - afterCount} unreleased movies`);
      }
    }
    metas = applyAgeRatingFilter(metas, type, config);
    
    return metas;
  }

  const genreList = await getGenreList('tmdb', language, type as "movie" | "series", config);
  const parameters = await buildParameters(type, language, page, id, genre, genreList, config);

  // Log the full URL for airing_today catalog
  if (id === 'tmdb.airing_today') {
    const baseUrl = 'https://api.themoviedb.org/3';
    const endpoint = type === 'movie' ? '/discover/movie' : '/discover/tv';
    const queryParams = new URLSearchParams();
    Object.keys(parameters).forEach(key => {
      const value = parameters[key];
      if (value !== undefined && value !== null) {
        queryParams.append(key, String(value));
      }
    });
    queryParams.append('api_key', config.apiKeys?.tmdb || process.env.TMDB_API || '');
    const fullUrl = `${baseUrl}${endpoint}?${queryParams.toString()}`;
    logger.info(`[Airing Today] Full TMDB API URL: ${fullUrl}`);
    logger.info(`[Airing Today] Parameters: ${JSON.stringify(parameters, null, 2)}`);
  }

  const fetchFunction = type === "movie" 
    ? () => moviedb.discoverMovie(parameters, config) 
    : () => moviedb.discoverTv(parameters, config);

  const res: any = await fetchFunction();
  // define preferred provider as string
  
  // Sort results by release date (newest first) for catalogs that explicitly sort by release date
  // Top rated, year, and language catalogs should keep TMDB's default sorting, so skip this
  if (res?.results) {
    if (id === 'tmdb.top') {
      res.results.sort((a: any, b: any) => new Date(b.release_date).getTime() - new Date(a.release_date).getTime());
    }
    const metas = await Promise.all(res.results.map(async (item: any) => {
    let stremioId = `tmdb:${item.id}`;
    
    const result = await cacheWrapMetaSmart(userUUID, stremioId, async () => {
      return await getMeta(type, language, stremioId, config, userUUID, includeVideos);
    }, undefined, {enableErrorCaching: true, maxRetries: 2}, type as any, includeVideos);
    if (result && result.meta) {
      return result.meta;
    }
    return null;
  }));

  let validMetas = metas.filter(meta => meta !== null);
  
  // Apply digital release filter if enabled (movies only)
  if (type === 'movie' && config.hideUnreleasedDigital) {
    const beforeCount = validMetas.length;
    validMetas = validMetas.filter(meta => isReleasedDigitally(meta));
    const afterCount = validMetas.length;
    if (beforeCount !== afterCount) {
      logger.info(`Digital release filter: filtered out ${beforeCount - afterCount} unreleased movies`);
    }
  }
  
  return validMetas;
  } else {
    return [];
  }
}

async function buildParameters(type: string, language: string, page: number, id: string, genre: string, genreList: any[], config: UserConfig): Promise<any> {
  const languages = await getLanguages(config);
  const parameters: any = { language, page, 'vote_count.gte': 50};

  /*if (id === 'tmdb.top' && type === 'series') {
    logger.debug('Applying genre exclusion for popular series catalog.');

    const excludedGenreIds = [
      '10767', // Talk
      '10763', // News
      '10768', // War & Politics
    ];
    
    parameters.without_genres = excludedGenreIds.join(',');
    
    logger.debug(`Excluding genre IDs: ${parameters.without_genres}`);
  }*/
  parameters.include_adult = config.includeAdult;

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
    logger.debug(`Found provider: ${JSON.stringify(provider)}`);

    if(genre && genre.toLowerCase() !== 'none') {
      parameters.with_genres = findGenreId(genre, genreList);
    }
    parameters.with_watch_providers = provider.watchProviderId
    parameters.watch_region = provider.country;
    parameters.with_watch_monetization_types = "flatrate|free|ads";
  } else {
    switch (id) {
      case "tmdb.top":
        parameters.sort_by = 'primary_release_date.desc'
        if(genre && genre.toLowerCase() !== 'none') {
          logger.debug(`Found genre: ${genre}, genre ID: ${findGenreId(genre, genreList)}`);
          parameters.with_genres = findGenreId(genre, genreList);
        }
        if (type === "series") {
          parameters.watch_region = language.split("-")[1];
          parameters.with_watch_monetization_types = "flatrate|free|ads|rent|buy";
        }
        break;
      case "tmdb.year":
        const year = genre && genre.toLowerCase() !== 'none' ? genre : new Date().getFullYear();
        parameters[type === "movie" ? "primary_release_year" : "first_air_date_year"] = year;
        break;
      case "tmdb.language":
        const findGenre = genre && genre.toLowerCase() !== 'none' ? findLanguageCode(genre, languages) : language.split("-")[0];
        parameters.with_original_language = findGenre;
        break;
      case "tmdb.top_rated":
        // Sort by vote average (highest rated first) with minimum vote count
        parameters.sort_by = type === "movie" ? 'vote_average.desc' : 'vote_average.desc';
        parameters['vote_count.gte'] = 200; // Require at least 200 votes for top rated
        // Exclude Documentary (99) and News (10755) genres
        parameters.without_genres = '99,10755';
        if(genre && genre.toLowerCase() !== 'none') {
          logger.debug(`Found genre: ${genre}, genre ID: ${findGenreId(genre, genreList)}`);
          parameters.with_genres = findGenreId(genre, genreList);
        }
        break;
      case "tmdb.airing_today":
        // Filter for TV shows with episodes airing today
        // Use first_air_date to find shows that first aired, but for "airing today" we want shows with episodes today
        // TMDB's discover endpoint doesn't have direct "airing today" filter, so we use air_date range
        // Use user's configured timezone (or server timezone as fallback)
        const userTimezone = config.timezone || process.env.TZ || 'UTC';
        const formatter = new Intl.DateTimeFormat('en-CA', { 
          timeZone: userTimezone, 
          year: 'numeric', 
          month: '2-digit', 
          day: '2-digit' 
        });
        const today = formatter.format(new Date()); // YYYY-MM-DD format in user's timezone
        parameters['air_date.gte'] = today;
        parameters['air_date.lte'] = today;
        parameters.sort_by = 'popularity.desc';
        parameters.with_type = '2|3|4'; // Filter by TV show types (Scripted, Reality, Miniseries)
        delete parameters['vote_count.gte'];
        if(genre && genre.toLowerCase() !== 'none') {
          parameters.with_origin_country = genre.toUpperCase();
          logger.debug(`Found origin country: ${genre}`);
        }
        break;
      default:
        break;
    }
  }
  return parameters;
}

function findGenreId(genreName: string, genreList: any[]): number | undefined {
  const genreData = genreList.find(genre => genre.name === genreName);
  return genreData ? genreData.id : undefined;
}

function findLanguageCode(genre: string, languages: any[]): string {
  const language = languages.find((lang) => lang.name === genre);
  return language ? language.iso_639_1.split("-")[0] : "";
}

function findProvider(providerId: string): any {
  const provider = (CATALOG_TYPES as any).streaming[providerId];
  if (!provider) throw new Error(`Could not find provider: ${providerId}`);
  return provider;
}

async function getStremThruCatalog(type: string, catalogId: string, genre: string, page: number, language: string, config: UserConfig, userUUID: string, includeVideos: boolean = false): Promise<any[]> {
  try {
    logger.info(`[✨ StremThru] Processing catalog request: ${catalogId}, type: ${type}, genre: ${genre || 'none'}, page: ${page}`);
    
    // Find the user catalog configuration to get the source URL
    const userCatalog = config.catalogs?.find(c => c.id === catalogId && c.type === type);
    if (!userCatalog || (!userCatalog.sourceUrl && !userCatalog.source)) {
      logger.error(`[✨ StremThru] No source URL found for catalog: ${catalogId}`);
      return [];
    }
    
    // Use sourceUrl for StremThru catalogs, fallback to source for backward compatibility
    const catalogUrl = userCatalog.sourceUrl || userCatalog.source;
    // sparkle emoji
    logger.debug(`[✨ StremThru] Using catalog URL: ${catalogUrl}`);
    
    // --- Dynamic pagination ---
    const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE || '20');
    // Use catalog-specific page size if configured, otherwise default to 100
    const stremThruBatchSize = userCatalog.pageSize || 100;
    const globalItemIndex = (page - 1) * pageSize;

    const batchesNeeded = Math.ceil((globalItemIndex % stremThruBatchSize + pageSize) / stremThruBatchSize);
    const firstBatchSkip = Math.floor(globalItemIndex / stremThruBatchSize) * stremThruBatchSize;

    // ✅ Debug helper
    const debugPagination = (skips: number[], start: number, end: number, total: number) => {
      logger.info(
        `[🧩 Pagination Debug] Page ${page}: fetching batches ${skips.join(", ")} ` +
        `(skip range = ${firstBatchSkip}–${firstBatchSkip + skips.length * stremThruBatchSize - 1}), ` +
        `slicing local ${start}–${end}, total fetched = ${total}`
      );
    };

    // --- Fetch all required batches with caching ---
    const batchSkips: number[] = [];
    let allItems: any[] = [];

    for (let i = 0; i < batchesNeeded; i++) {
      const skip = firstBatchSkip + i * stremThruBatchSize;
      batchSkips.push(skip);
      const cacheKey = `custom-batch:${catalogId}:${genre || 'all'}:skip=${skip}`;
      
      // Use cacheWrap to cache the batch fetch
      const batch = await cacheWrap(cacheKey, async () => {
        logger.debug(`[✨ StremThru] Fetching fresh batch: skip=${skip}, genre=${genre || 'all'}`);
        return await fetchStremThruCatalog(catalogUrl, skip, genre);
      }, 300, { enableErrorCaching: true, maxRetries: 2 }); // 5 minute TTL for batches
      
      if (batch?.length) allItems = allItems.concat(batch);
    }

    if (!allItems.length) {
      logger.warn(`[✨ StremThru] No items fetched from catalog: ${catalogId}`);
      return [];
    }

    // --- Slice exact page range ---
    const localStartIndex = globalItemIndex - firstBatchSkip;
    const localEndIndex = localStartIndex + pageSize;
    const paginatedItems = allItems.slice(localStartIndex, localEndIndex);

    // 📋 Print pagination debug info
    debugPagination(batchSkips, localStartIndex, localEndIndex, allItems.length);
    
    // Log caching benefits
    logger.info(`[✨ StremThru] Batch caching: fetched ${batchesNeeded} batch(es) for page ${page}, total items: ${allItems.length}`);

    // --- Parse and filter metas ---
    let metas = await parseStremThruItems(paginatedItems, type, genre, language, config, includeVideos);

    // Filter unreleased content if configured
    if (type === 'movie' && config.hideUnreleasedDigital) {
      const before = metas.length;
      metas = metas.filter(meta => isReleasedDigitally(meta));
      const after = metas.length;
      if (before !== after) {
        logger.info(`Digital release filter (StremThru): filtered out ${before - after} unreleased movies`);
      }
    }

    // Filter by age rating if enabled
    metas = applyAgeRatingFilter(metas, type, config);

    logger.success(`[StremThru] Processed ${metas.length} items for catalog ${catalogId} (page ${page})`);
    return metas;

  } catch (err: any) {
    const errorLine = err.stack?.split('\n')[1]?.trim() || 'unknown';
    logger.error(`[StremThru] Error processing catalog ${catalogId}: ${err.message}`);
    logger.error(`Error at: ${errorLine}`);
    logger.error(`Full stack trace:`, err.stack);
    return [];
  }
}

async function getTraktCatalog(
  type: string, 
  catalogId: string, 
  genre: string, 
  page: number, 
  language: string, 
  config: UserConfig, 
  userUUID: string, 
  includeVideos: boolean = false
): Promise<any[]> {
  try {
    logger.info(`Fetching Trakt catalog: ${catalogId}, Genre: ${genre}, Page: ${page}`);
    
    // Get Trakt access token from database
    const accessToken = await getTraktAccessToken(config);
    if (!accessToken) {
      logger.warn(`Trakt not connected for user ${userUUID}`);
      return [];
    }
    
    const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20;
    
    const catalogConfig = config.catalogs?.find(c => c.id === catalogId);
    const sort = catalogConfig?.sort;
    const sortDirection = catalogConfig?.sortDirection;
    
    // Determine content type filter for API
    let traktType: 'movies' | 'shows' | undefined;
    if (type === 'movie') traktType = 'movies';
    else if (type === 'series') traktType = 'shows';
    // If type is 'all', traktType remains undefined
    
    let response: any;
    
    if (catalogId === 'trakt.upnext') {
      // Trakt Up Next catalog with last_activities optimization
      // Up Next only has one page - return empty for page 2+
      if (page > 1) {
        logger.info(`Up Next: Page ${page} requested, returning empty (only page 1 exists)`);
        response = { 
          items: [], 
          hasMore: false
        };
      } else {
        const upNextStart = Date.now();
        logger.info('Up Next: Starting catalog fetch');
        
        const cacheKey = `trakt_upnext_${accessToken.substring(0, 8)}`;
        const timestampKey = `trakt_upnext_timestamp_${accessToken.substring(0, 8)}`;
        const cacheTTL = 300; // 5 minutes for items
        const timestampTTL = 3600; // 1 hour for timestamp (persists across cache refreshes)
        
        const cacheCheckStart = Date.now();
        const cachedData = await cacheWrap(cacheKey, async () => null, cacheTTL);
        
        // Get last known timestamp (longer TTL so it persists)
        const cachedTimestamp = await cacheWrap(timestampKey, async () => null, timestampTTL);
        const cacheCheckTime = Date.now() - cacheCheckStart;
        logger.info(`Up Next: Cache check took ${cacheCheckTime}ms`);
        
        const fetchStart = Date.now();
        const result = await require('../utils/traktUtils.js').fetchTraktUpNextEpisodes(accessToken, cachedTimestamp);
        const fetchTime = Date.now() - fetchStart;
        logger.info(`Up Next: fetchTraktUpNextEpisodes took ${fetchTime}ms`);
        
        let allItems: any[];
        
        if (result.items.length === 0 && cachedData?.items) {
          logger.info(`Up Next: No activity changes, extending cache for ${cachedData.items.length} items`);
          allItems = cachedData.items;
          
          await cacheWrap(cacheKey, async () => cachedData, cacheTTL);
        } else {
          allItems = result.items;
          
          const parseStart = Date.now();
          // Cache both items and timestamp
          await cacheWrap(cacheKey, async () => ({ items: allItems, watched_at: result.watched_at }), cacheTTL);
          await cacheWrap(timestampKey, async () => result.watched_at, timestampTTL);
          const parseTime = Date.now() - parseStart;
          
          logger.info(`Up Next: Rebuilt and cached ${allItems.length} items (watched_at: ${result.watched_at}) [cache write: ${parseTime}ms]`);
        }
        
        const totalTime = Date.now() - upNextStart;
        logger.info(`Up Next: Total catalog fetch time: ${totalTime}ms`);
        
        response = { 
          items: allItems, 
          hasMore: false
        };
      }
    } else if (catalogId === 'trakt.unwatched') {
      // Trakt Unwatched Episodes catalog (all unwatched episodes grouped per show)
      if (page > 1) {
        logger.info(`Unwatched: Page ${page} requested, returning empty (only page 1 exists)`);
        response = { items: [], hasMore: false };
      } else {
        const runStart = Date.now();
        logger.info('Unwatched: Starting catalog fetch');

        const cacheKey = `trakt_unwatched_${accessToken.substring(0, 8)}`;
        const timestampKey = `trakt_unwatched_timestamp_${accessToken.substring(0, 8)}`;
        const cacheTTL = 300; // 5 minutes
        const timestampTTL = 3600; // 1 hour

        const cachedData = await cacheWrap(cacheKey, async () => null, cacheTTL);
        const cachedTimestamp = await cacheWrap(timestampKey, async () => null, timestampTTL);

        const result = await require('../utils/traktUtils.js').fetchTraktUnwatchedEpisodes(accessToken, cachedTimestamp);

        let allItems: any[];
        if (result.items.length === 0 && cachedData?.items) {
          logger.info(`Unwatched: No activity changes, extending cache for ${cachedData.items.length} items`);
          allItems = cachedData.items;
          await cacheWrap(cacheKey, async () => cachedData, cacheTTL);
        } else {
          allItems = result.items;
          await cacheWrap(cacheKey, async () => ({ items: allItems, watched_at: result.watched_at }), cacheTTL);
          await cacheWrap(timestampKey, async () => result.watched_at, timestampTTL);
          logger.info(`Unwatched: Rebuilt and cached ${allItems.length} items (watched_at: ${result.watched_at})`);
        }

        const total = Date.now() - runStart;
        logger.info(`Unwatched: Total catalog fetch time: ${total}ms`);

        response = { items: allItems, hasMore: false };
      }
    } else if (catalogId === 'trakt.calendar') {
      // Trakt Calendar - Shows airing this week
      // Only shows page 1, returns empty for page 2+
      if (page > 1) {
        logger.info(`Trakt Calendar: Page ${page} requested, returning empty (only page 1 exists)`);
        response = { items: [], hasMore: false };
      } else {
        // Get timezone from config or default to UTC
        const timezone = config.timezone || process.env.TZ || 'UTC';
        
        // Get today's date in the user's timezone (YYYY-MM-DD format)
        // Create a date formatter for the user's timezone
        const formatter = new Intl.DateTimeFormat('en-CA', { 
          timeZone: timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        });
        const startDate = formatter.format(new Date()); // Returns YYYY-MM-DD
        
        logger.info(`Trakt Calendar: Fetching today's shows (${startDate}, timezone: ${timezone})`);
        
        // Fetch 1 day (today only)
        const calendarResult = await fetchTraktCalendarShows(accessToken, startDate, 1);
        
        response = {
          items: calendarResult.items,
          hasMore: false
        };
        
        logger.info(`Trakt Calendar: Retrieved ${response.items.length} shows`);
      }
    } else if (catalogId.startsWith('trakt.most_favorited.')) {
      // Format: trakt.most_favorited.{type}.{period}
      // Example: trakt.most_favorited.movies.weekly
      const parts = catalogId.split('.');
      if (parts.length !== 4) {
        logger.error(`Invalid Trakt most_favorited ID format: ${catalogId}`);
        return [];
      }
      const favType = parts[2]; // 'movies' or 'shows'
      const favPeriod = parts[3]; // 'daily', 'weekly', 'monthly', 'all'
      logger.debug(`Fetching Trakt most favorited: type=${favType}, period=${favPeriod}`);
      response = await fetchTraktMostFavoritedItems(favType as 'movies' | 'shows', favPeriod as any, page, pageSize, genre);
    } else if (catalogId === 'trakt.watchlist') {
      // Unified watchlist
      logger.debug(`Fetching Trakt unified watchlist`);
      response = await fetchTraktWatchlistItems(accessToken, undefined, page, pageSize, sort, sortDirection, genre);
    } else if (catalogId === 'trakt.watchlist.movies') {
      // Movies-only watchlist
      logger.debug(`Fetching Trakt watchlist (movies only)`);
      response = await fetchTraktWatchlistItems(accessToken, 'movies', page, pageSize, sort, sortDirection, genre);
    } else if (catalogId === 'trakt.watchlist.series') {
      // Series-only watchlist
      logger.debug(`Fetching Trakt watchlist (shows only)`);
      response = await fetchTraktWatchlistItems(accessToken, 'shows', page, pageSize, sort, sortDirection, genre);
    } else if (catalogId === 'trakt.favorites.movies') {
      // Movies-only favorites
      logger.debug(`Fetching Trakt favorites (movies only)`);
      response = await fetchTraktFavoritesItems(accessToken, 'movies', page, pageSize, sort, sortDirection, genre);
    } else if (catalogId === 'trakt.favorites.shows') {
      // Shows-only favorites
      logger.debug(`Fetching Trakt favorites (shows only)`);
      response = await fetchTraktFavoritesItems(accessToken, 'shows', page, pageSize, sort, sortDirection, genre);
    } else if (catalogId === 'trakt.recommendations.movies') {
      // Movies-only recommendations
      logger.debug(`Fetching Trakt recommendations (movies only)`);
      response = await fetchTraktRecommendationsItems(accessToken, 'movies', page, pageSize);
    } else if (catalogId === 'trakt.recommendations.shows') {
      // Shows-only recommendations
      logger.debug(`Fetching Trakt recommendations (shows only)`);
      response = await fetchTraktRecommendationsItems(accessToken, 'shows', page, pageSize);
    } else {
      // Custom list: trakt.{username}.{listSlug}
      const parts = catalogId.split('.');
      if (parts.length < 3) {
        logger.error(`Invalid Trakt list ID format: ${catalogId}`);
        return [];
      }
      
      const username = parts[1];
      let listSlug = parts.slice(2).join('.'); 
      
      // Remove .movies or .series suffix if present (from split catalogs)
      if (listSlug.endsWith('.movies')) {
        listSlug = listSlug.slice(0, -7); // Remove '.movies'
      } else if (listSlug.endsWith('.series')) {
        listSlug = listSlug.slice(0, -7); // Remove '.series'
      }
      
      logger.debug(`Fetching Trakt list: ${username}/${listSlug}`);
      response = await fetchTraktListItems(username, listSlug, accessToken, traktType, page, pageSize, sort, genre, sortDirection);
    }
    
    // Log pagination info
    if (response.totalItems !== undefined && response.totalPages !== undefined) {
      logger.debug(
        `Trakt pagination - page ${page}/${response.totalPages}, ` +
        `items: ${response.items.length}, totalItems: ${response.totalItems}, hasMore: ${response.hasMore}`
      );
    } else {
      logger.debug(
        `Trakt pagination - page ${page}, items: ${response.items.length}, hasMore: ${response.hasMore}`
      );
    }
    
    // Early exit for empty pages
    if (!response.hasMore && response.items.length === 0) {
      logger.debug(`Trakt early exit - no more items at page ${page}`);
      return [];
    }
    
    const parseStart = Date.now();
    let metas = await parseTraktItems(response.items, type, language, config, includeVideos);
    const parseTime = Date.now() - parseStart;
    logger.info(`Up Next: parseTraktItems took ${parseTime}ms for ${response.items.length} items`);
    
    // Apply digital release filter if enabled (movies only)
    if (type === 'movie' && config.hideUnreleasedDigital) {
      const beforeCount = metas.length;
      metas = metas.filter(meta => isReleasedDigitally(meta));
      const afterCount = metas.length;
      if (beforeCount !== afterCount) {
        logger.info(`Digital release filter (Trakt): filtered out ${beforeCount - afterCount} unreleased movies`);
      }
    }
    
    // Apply age rating filter
    metas = applyAgeRatingFilter(metas, type, config);
    
    logger.success(`[Trakt] Processed ${metas.length} items for catalog ${catalogId} (page ${page})`);
    return metas;
    
  } catch (err: any) {
    const errorLine = err.stack?.split('\n')[1]?.trim() || 'unknown';
    logger.error(`[Trakt] Error processing catalog ${catalogId}: ${err.message}`);
    logger.error(`Error at: ${errorLine}`);
    logger.error(`Full stack trace:`, err.stack);
    return [];
  }
}

/**
 * Get AniList catalog items for a user's list
 * Handles 'anilist.*' catalog IDs (e.g., anilist.Watching, anilist.Completed)
 */
async function getAniListCatalog(
  type: string,
  catalogId: string,
  page: number,
  language: string,
  config: UserConfig,
  userUUID: string,
  includeVideos: boolean = false
): Promise<any[]> {
  try {
    logger.info(`[AniList] Fetching catalog: ${catalogId}, Page: ${page}`);
    
    // Extract list name from catalog ID (format: anilist.<listName>)
    const listName = catalogId.replace('anilist.', '');
    if (!listName) {
      logger.error(`[AniList] Invalid catalog ID format: ${catalogId}`);
      return [];
    }
    
    // Get the catalog config to retrieve username and custom TTL
    const catalogConfig = config.catalogs?.find(c => c.id === catalogId);
    const username = catalogConfig?.metadata?.username;
    
    if (!username) {
      logger.error(`[AniList] No username found in catalog config for: ${catalogId}`);
      return [];
    }
    
    const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20;
    
    // Get custom cache TTL from catalog config if specified
    const customCacheTTL = catalogConfig?.cacheTTL || null;
    
    // Fetch list items from AniList API with caching
    const response = await cacheWrapAniListCatalog(
      username,
      listName,
      page,
      async () => fetchListItems(username, listName, page, pageSize),
      customCacheTTL,
      { enableErrorCaching: true }
    );
    
    // Handle cached error responses
    if (response && (response as any).error) {
      logger.warn(`[AniList] Cached error for list "${listName}": ${(response as any).message}`);
      return [];
    }
    
    logger.debug(`[AniList] Fetched ${response.items.length} items from list "${listName}", hasMore: ${response.hasMore}`);
    
    // Early exit for empty pages
    if (response.items.length === 0) {
      logger.debug(`[AniList] No items at page ${page} for list "${listName}"`);
      return [];
    }
    
    // Resolve AniList media IDs to Stremio metas
    const metas = await resolveAniListItemsToMetas(response.items, type, language, config, userUUID, includeVideos);
    
    logger.success(`[AniList] Processed ${metas.length} items for catalog ${catalogId} (page ${page})`);
    return metas;
    
  } catch (err: any) {
    const errorLine = err.stack?.split('\n')[1]?.trim() || 'unknown';
    logger.error(`[AniList] Error processing catalog ${catalogId}: ${err.message}`);
    logger.error(`Error at: ${errorLine}`);
    logger.error(`Full stack trace:`, err.stack);
    return [];
  }
}

/**
 * Resolve AniList media entries to Stremio meta objects
 * Uses ID mapping to convert AniList IDs to Stremio-compatible IDs
 */
async function resolveAniListItemsToMetas(
  items: Array<{ score: number; media: { id: number; idMal: number | null } }>,
  type: string,
  language: string,
  config: UserConfig,
  userUUID: string,
  includeVideos: boolean
): Promise<any[]> {
  const idMapper = require('./id-mapper.js');
  
  const metas = await Promise.all(items.map(async (item) => {
    try {
      const anilistId = item.media.id;
      const malId = item.media.idMal;
      
      // Try to get mapping from AniList ID first
      let mapping = idMapper.getMappingByAnilistId(anilistId);
      
      // Fallback to MAL ID if AniList mapping not found
      if (!mapping && malId) {
        mapping = idMapper.getMappingByMalId(malId);
      }
      
      // Determine the best Stremio ID to use
      let stremioId: string | null = null;
      
      if (mapping) {
        // Prefer IMDB ID for best compatibility with Stremio
        if (mapping.imdb_id) {
          stremioId = mapping.imdb_id;
        } else if (mapping.kitsu_id) {
          stremioId = `kitsu:${mapping.kitsu_id}`;
        } else if (mapping.mal_id) {
          stremioId = `mal:${mapping.mal_id}`;
        } else if (mapping.themoviedb_id) {
          stremioId = `tmdb:${mapping.themoviedb_id}`;
        }
      }
      
      // Fallback to AniList ID if no mapping found
      if (!stremioId) {
        // Try MAL ID as fallback
        if (malId) {
          stremioId = `mal:${malId}`;
      }
      
      logger.debug(`[AniList] Resolving AniList ID ${anilistId} -> ${stremioId}`);
      
      // Fetch meta using getMeta with the resolved ID
      const result = await cacheWrapMetaSmart(userUUID, stremioId, async () => {
        return await getMeta(type, language, stremioId!, config, userUUID, includeVideos);
      }, undefined, { enableErrorCaching: true, maxRetries: 2 }, type as any, includeVideos);
      
      if (result && result.meta) {
        return result.meta;
      }
      
      return null;
    } catch (error: any) {
      logger.warn(`[AniList] Failed to resolve meta for AniList ID ${item.media.id}: ${error.message}`);
      return null;
    }
  }));
  
  // Filter out null results
  return metas.filter(meta => meta !== null);
}

export { getCatalog };
