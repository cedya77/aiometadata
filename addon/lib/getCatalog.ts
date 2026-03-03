require("dotenv").config();
import { getGenreList } from "./getGenreList.js";
import { getLanguages } from "./getLanguages.js";
import { fetchMDBListItems, parseMDBListItems, fetchMDBListBatchMediaInfo, fetchMDBListUpNext, parseMDBListUpNextItems } from "../utils/mdbList.js";
import { fetchStremThruCatalog, parseStremThruItems } from "../utils/stremthru.js";
import { fetchTraktWatchlistItems, fetchTraktFavoritesItems, fetchTraktRecommendationsItems, fetchTraktListItems, fetchTraktListItemsById, parseTraktItems, fetchTraktMostFavoritedItems, fetchTraktCalendarShows, fetchTraktSearchItems, getTraktAccessToken } from "../utils/traktUtils.js";
import { fetchSimklTrendingItems, fetchSimklWatchlistItems, parseSimklItems, getSimklToken, fetchSimklCalendarItems, fetchSimklGenreItems, fetchSimklDvdReleases } from "../utils/simklUtils.js";
import { fetchLetterboxdList, parseLetterboxdItems, getLetterboxdGenreIdByName } from "../utils/letterboxdUtils.js";
const anilist = require('./anilist');
import * as jikan from "./mal.js"
import * as Utils from '../utils/parseProps.js';
import * as CATALOG_TYPES from "../static/catalog-types.json";
import * as moviedb from "./getTmdb.js";
import * as tvdb from './tvdb.js';
import { to3LetterCode, to3LetterCountryCode } from './language-map.js';
import { resolveAllIds } from './id-resolver.js';
import { cacheWrapTvdbApi, cacheWrap, cacheWrapAniListCatalog, cacheWrapJikanApi, stableStringify } from './getCache.js';
import { getTVDBContentRatingId } from '../utils/tvdbContentRating.js';
import { getMeta } from './getMeta.js';
import { resolveDynamicTmdbDiscoverParams } from './tmdbDiscoverDateTokens.js';

const consola = require('consola');
const database = require('./database.js');

const logger = consola.withTag('Catalog');
import { cacheWrapMetaSmart } from './getCache.js';
import { UserConfig } from '../types/index.js';

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

  logger.debug(`[StremThru] Applying age rating filter: ${config.ageRating} for type: ${type}`);
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


async function getCatalog(type: string, language: string, page: number, id: string, genre: string, config: UserConfig, userUUID: string, includeVideos: boolean = false, skip?: number): Promise<{ metas: any[] }> {
  try {
    if (id === 'tvdb.collections') {
      logger.debug(`Fetching TVDB collections catalog: ${id}`);
      const metas = await getTvdbCollectionsCatalog(type, id, page, language, config);
      return { metas };
    }
    if (id.startsWith('tvdb.discover.')) {
      logger.debug(`Routing to TVDB discover catalog handler for id: ${id}`);
      const tvdbDiscoverResults = await getTvdbDiscoverCatalog(type, id, genre, page, language, config, userUUID, includeVideos);
      return { metas: tvdbDiscoverResults };
    }
    if (id.startsWith('tvdb.') && !id.startsWith('tvdb.collection.')) {
      logger.debug(`Routing to TVDB catalog handler for id: ${id}`);
      const tvdbResults = await getTvdbCatalog(type, id, genre, page, language, config, id === 'tvdb.trending', includeVideos);
      return { metas: tvdbResults };
    } 
    else if (id.startsWith('tmdb.') || id.startsWith('mdblist.') || id.startsWith('streaming.')) {
      logger.debug(`Routing to TMDB/MDBList catalog handler for id: ${id}`);
      const tmdbResults = await getTmdbAndMdbListCatalog(type, id, genre, page, language, config, userUUID, includeVideos);
      return { metas: tmdbResults };
    }
    else if (id.startsWith('stremthru.')) {
      logger.debug(`Routing to StremThru catalog handler for id: ${id}`);
      const stremthruResults = await getStremThruCatalog(type, id, genre, page, language, config, userUUID, includeVideos);
      return { metas: stremthruResults };
    }
    else if (id.startsWith('custom.')) {
      logger.debug(`Routing to Custom Manifest catalog handler for id: ${id}`);
      const customResults = await getStremThruCatalog(type, id, genre, page, language, config, userUUID, includeVideos);
      return { metas: customResults };
    }
    else if (id.startsWith('trakt.')) {
      logger.debug(`Routing to Trakt catalog handler for id: ${id}`);
      const traktResults = await getTraktCatalog(type, id, genre, page, language, config, userUUID, includeVideos);
      return { metas: traktResults };
    }
    else if (id.startsWith('mal.discover.')) {
      logger.debug(`Routing to MAL discover catalog handler for id: ${id}`);
      const malDiscoverResults = await getMalDiscoverCatalog(type, id, genre, page, language, config, userUUID, includeVideos);
      return { metas: malDiscoverResults };
    }
    else if (id.startsWith('anilist.discover.')) {
     logger.debug(`Routing to AniList discover catalog handler for id: ${id}`);
     const anilistDiscoverResults = await getAniListDiscoverCatalog(type, id, genre, page, language, config, userUUID, includeVideos);
     return { metas: anilistDiscoverResults };
    }
    else if (id.startsWith('anilist.')) {
      logger.debug(`Routing to AniList catalog handler for id: ${id}`);
      const anilistResults = await getAniListCatalog(type, id, genre, page, language, config, userUUID, includeVideos);
      return { metas: anilistResults };
    }
    else if (id.startsWith('letterboxd.')) {
      logger.debug(`Routing to Letterboxd catalog handler for id: ${id}`);
      const letterboxdResults = await getLetterboxdCatalog(type, id, genre, page, language, config, userUUID, includeVideos);
      return { metas: letterboxdResults };
    }
    else if (id.startsWith('simkl.')) {
      logger.debug(`Routing to Simkl catalog handler for id: ${id}`);
      const simklResults = await getSimklCatalog(type, id, genre, page, language, config, userUUID, includeVideos, skip);
      return { metas: simklResults };
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


/**
 * Get MAL discover catalog items.
 * Handles 'mal.discover.*' catalog IDs created by the builder dialog.
 * Reads the discover params from the catalog's metadata and calls jikan.fetchDiscover().
 */
async function getMalDiscoverCatalog(
  type: string,
  catalogId: string,
  genreName: string | null,
  page: number,
  language: string,
  config: any, // UserConfig
  userUUID: string,
  includeVideos: boolean = false
): Promise<any[]> {
  try {
    logger.info(`[MAL Discover] Fetching catalog: ${catalogId}, Page: ${page}`);

    const catalogConfig = config.catalogs?.find((c: any) => c.id === catalogId);
    const discoverMetadata = catalogConfig?.metadata?.discover || {};
    const rawParams = discoverMetadata?.params || {};
    const customCacheTTL = catalogConfig?.cacheTTL || null;

    if (genreName && genreName.toLowerCase() !== 'none') {
      const allAnimeGenres = await cacheWrapJikanApi('anime-genres', async () => {
        return await jikan.getAnimeGenres();
      }, null, { skipVersion: true });
    
      const selectedGenre = allAnimeGenres.find(
        (g: any) => g.name.toLowerCase() === genreName.toLowerCase()
      );
    
      if (selectedGenre) {
        const genreId = String(selectedGenre.mal_id);
        const existing = rawParams.genres ? String(rawParams.genres).split(',').map((s: string) => s.trim()) : [];
        if (!existing.includes(genreId)) {
          existing.push(genreId);
        }
        rawParams.genres = existing.join(',');
      }
    }

    const response = await cacheWrapJikanApi(
      `mal-discover-${catalogId}-page${page}-genre${genreName || 'All'}`,
      async () => jikan.fetchDiscover(rawParams, page),
      customCacheTTL || 30 * 60
    );

    if (!response?.items || response.items.length === 0) {
      logger.info(`[MAL Discover] No results for ${catalogId} at page ${page}`);
      return [];
    }

    // Convert Jikan anime objects to the format expected by resolveMALItemsToMetas
    // Jikan returns full anime objects with mal_id, title, images, etc.
    // We need to map them through the existing MAL-to-Stremio meta resolver.
    const metas = await Utils.parseAnimeCatalogMetaBatch(
      response.items, config, language
    );

    logger.success(`[MAL Discover] Processed ${metas.length} items for ${catalogId} (page ${page})`);
    return metas;
  } catch (err: any) {
    logger.error(`[MAL Discover] Error processing catalog ${catalogId}: ${err.message}`);
    return [];
  }
}

/**
 * Get AniList discover catalog items.
 * Handles 'anilist.discover.*' catalog IDs created by the builder dialog.
 * Reads the discover params from the catalog's metadata and calls anilist.fetchDiscover().
 */
async function getAniListDiscoverCatalog(
  type: string,
  catalogId: string,
  genre: string | null,
  page: number,
  language: string,
  config: any, // UserConfig
  userUUID: string,
  includeVideos: boolean = false
): Promise<any[]> {
  try {
    logger.info(`[AniList Discover] Fetching catalog: ${catalogId}, Page: ${page}`);

    const catalogConfig = config.catalogs?.find((c: any) => c.id === catalogId);
    const discoverMetadata = catalogConfig?.metadata?.discover || {};
    const rawParams = discoverMetadata?.params || {};
    const customCacheTTL = catalogConfig?.cacheTTL || null;
    const pageSize = 50;

    if (genre && genre.toLowerCase() !== 'none') {
      if (rawParams.genre_in) {
        const existing = typeof rawParams.genre_in === 'string'
          ? rawParams.genre_in.split(',').map((g: string) => g.trim())
          : Array.isArray(rawParams.genre_in) ? [...rawParams.genre_in] : [];
        if (!existing.some((g: string) => g.toLowerCase() === genre.toLowerCase())) {
          existing.push(genre);
        }
        rawParams.genre_in = existing.join(',');
      } else {
        rawParams.genre_in = genre;
      }
    }

    // Fetch from AniList API with caching
    const cacheKeySuffix = `${catalogId}:${stableStringify(rawParams)}`;
    const response = await cacheWrapAniListCatalog(
      'discover',
      cacheKeySuffix,
      page,
      async () => anilist.fetchDiscover(rawParams, page, pageSize),
      customCacheTTL,
      { enableErrorCaching: true }
    );

    // Handle cached error responses
    if (response && (response as any).error) {
      logger.warn(`[AniList Discover] Cached error for ${catalogId}: ${(response as any).message}`);
      return [];
    }

    if (!response?.items || response.items.length === 0) {
      logger.info(`[AniList Discover] No results for ${catalogId} at page ${page}`);
      return [];
    }

    // Resolve AniList media IDs to Stremio meta objects
    // (reuses the existing resolveAniListItemsToMetas function)
    const metas = await resolveAniListItemsToMetas(
      response.items, type, language, config, userUUID, includeVideos
    );

    logger.success(`[AniList Discover] Processed ${metas.length} items for ${catalogId} (page ${page})`);
    return metas;
  } catch (err: any) {
    const errorLine = err.stack?.split('\n')[1]?.trim() || 'unknown';
    logger.error(`[AniList Discover] Error processing catalog ${catalogId}: ${err.message}`);
    logger.error(`Error at: ${errorLine}`);
    return [];
  }
}

async function getTvdbCatalog(type: string, catalogId: string, genreName: string, page: number, language: string, config: UserConfig, isTrending: boolean, includeVideos: boolean = false): Promise<any[]> {
  logger.debug(`Fetching TVDB catalog: ${catalogId}, Genre: ${genreName}, Page: ${page}`);
  
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
  if(tvdbType === 'movies'){
    params.status = 5;
  }
  
  logger.debug(`TVDB filter params:`, JSON.stringify(params));
  
  // Use cacheWrapTvdbApi to cache the raw API response
  const results = await cacheWrapTvdbApi(cacheKey, async () => {
    if (isTrending) {
      const currentYear = new Date().getFullYear();
      const lastYear = currentYear - 1;
      
      // Fetch both years in parallel
      const [currentYearResults, lastYearResults] = await Promise.all([
        tvdb.filter(tvdbType, { ...params, year: currentYear }, config),
        tvdb.filter(tvdbType, { ...params, year: lastYear }, config)
      ]);

      // Combine results
      const combined = [...(currentYearResults || []), ...(lastYearResults || [])];
      
      // Simple deduplication just in case
      const seen = new Set();
      return combined.filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
    } else {
      // Standard behavior for genres/search
      return await tvdb.filter(tvdbType, params, config);
    }
  });
  
  logger.debug(`TVDB filter results: ${results ? results.length : 0} items returned`);
  
  if (!results || results.length === 0) {
    logger.warn(`No results from TVDB filter, returning empty array`);
    return [];
  }

  let filteredResults = results;

  if (isTrending && type === 'series') {
    const now = new Date();
    const nextWeek = new Date();
    nextWeek.setDate(now.getDate() + 7);

    filteredResults = results.filter((item: any) => {
      if (!item.firstAired) return false;
      
      const firstAired = new Date(item.firstAired);
      return firstAired <= nextWeek;
    });
    
    logger.debug(`[TVDB Trending] Filtered ${results.length} -> ${filteredResults.length} series based on air date`);
  }

  // Sort results by score (highest first)
  const sortedResults = filteredResults.sort((a: any, b: any) => b.score - a.score);
  
  // Apply client-side pagination
  const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE || '20');
  const startIndex = (page - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  const paginatedResults = sortedResults.slice(startIndex, endIndex);
  
  logger.debug(`Pagination: page ${page}, showing items ${startIndex + 1}-${Math.min(endIndex, sortedResults.length)} of ${sortedResults.length} total results`);

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

async function getTvdbDiscoverCatalog(
  type: string,
  id: string,
  genreName: string,
  page: number,
  language: string,
  config: UserConfig,
  userUUID: string,
  includeVideos: boolean = false
): Promise<any[]> {
  logger.info(`[TVDB Discover] Fetching custom catalog: ${id}, Type: ${type}, Page: ${page}`);

  const catalogConfig = config.catalogs?.find(c => c.id === id && c.type === type)
    || config.catalogs?.find(c => c.id === id);

  if (!catalogConfig) {
    logger.warn(`[TVDB Discover] Catalog configuration not found for ${id}`);
    return [];
  }

  const isMovieCatalog = type === 'movie';
  const isSeriesCatalog = type === 'series';

  if (!isMovieCatalog && !isSeriesCatalog) {
    logger.warn(`[TVDB Discover] Unsupported type for discover catalog: ${type}`);
    return [];
  }

  const discoverMetadata = catalogConfig?.metadata?.discover || {};
  const rawParams = discoverMetadata?.params || catalogConfig?.metadata?.discoverParams || {};
  let genre;
  if(genreName && genreName.toLowerCase() !== 'none'){
    const allTvdbGenres = await getGenreList('tvdb', language, type as "movie" | "series", config);
    logger.debug(`TVDB genres fetched: ${allTvdbGenres.length} genres available`);
    
    genre = allTvdbGenres.find(g => g.name === genreName);
    logger.debug(`Genre lookup for "${genreName}":`, genre ? `Found ID ${genre.id}` : 'NOT FOUND');
  }
  const parameters = await sanitizeTvdbDiscoverParams(
    rawParams,
    language,
    type as 'movie' | 'series',
    config
  );
  if(genre){
    parameters.genre = genre.id
  }

  const tvdbType = isMovieCatalog ? 'movies' : 'series';
  const discoverPage = typeof page === 'number' ? page : parseInt(String(page), 10) || 1;
  const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE || '20');

  try {
    const response = await tvdb.filter(tvdbType, parameters, config);
    if (!Array.isArray(response) || response.length === 0) {
      logger.info(`[TVDB Discover] No results for ${id} at page ${discoverPage}`);
      return [];
    }

    const startIndex = Math.max(0, (discoverPage - 1) * pageSize);
    const endIndex = startIndex + pageSize;
    const paginatedResults = response.slice(startIndex, endIndex);

    const metas = await Promise.all(paginatedResults.map(async (item: any) => {
      const tvdbId = item?.id;
      if (!tvdbId) return null;

      const stremioId = `tvdb:${tvdbId}`;
      const metaType = isMovieCatalog ? 'movie' : 'series';

      try {
        const result = await cacheWrapMetaSmart(userUUID, stremioId, async () => {
          return await getMeta(metaType, language, stremioId, config, userUUID, includeVideos);
        }, undefined, { enableErrorCaching: true, maxRetries: 2 }, metaType as any, includeVideos);

        if (result && result.meta) {
          return result.meta;
        }
      } catch (error: any) {
        logger.warn(`[TVDB Discover] Failed to get meta for ${stremioId}: ${error.message}`);
      }

      return null;
    }));

    const validMetas = metas.filter(meta => meta !== null);
    logger.success(`[TVDB Discover] Processed ${validMetas.length} items for ${id}`);
    return validMetas;
  } catch (error: any) {
    logger.error(`[TVDB Discover] Error fetching catalog ${id}: ${error.message}`);
    return [];
  }
}

async function getTmdbAndMdbListCatalog(type: string, id: string, genre: string, page: number, language: string, config: UserConfig, userUUID: string, includeVideos: boolean = false): Promise<any[]> {
  if (id.startsWith("mdblist.")) {
    logger.info(`Fetching MDBList catalog: ${id}, Genre: ${genre}, Page: ${page}`);
    const catalogConfig = config.catalogs?.find(c => c.id === id);

    // Handle MDBList Discover catalogs (dynamic filter-based)
    if (id.startsWith('mdblist.discover.')) {
      const apiKey = config.apiKeys?.mdblist || process.env.MDBLIST_API_KEY || '';
      if (!apiKey) {
        logger.warn('[MDBList Discover] Missing API key');
        return [];
      }

      const discoverParams = catalogConfig?.metadata?.discover?.params || {};
      const params: Record<string, string | number | boolean> = { ...discoverParams };

      // Override genre if user selected one at request time
      if (genre && genre.toLowerCase() !== 'none') {
        const { convertGenreToSlug } = await import('../utils/mdbList.js');
        params.genre = convertGenreToSlug(genre);
      }

      const mediaType = type === 'movie' ? 'movie' : 'show';
      const { fetchMDBListCatalog } = await import('../utils/mdbList.js');
      const response = await fetchMDBListCatalog(mediaType, apiKey, page, params, catalogConfig?.cacheTTL);

      // Catalog endpoint returns a different shape than list items:
      // { title, year, score, type, ids: { imdbid, tmdbid, traktid, ... } }
      // parseMDBListItems expects: { id (tmdb), imdb_id, tvdb_id, mediatype }
      const normalizedItems = response.items.map((item: any) => ({
        ...item,
        id: item.ids?.tmdbid || item.id,
        imdb_id: item.ids?.imdbid || item.imdb_id,
        tvdb_id: item.ids?.tvdbid || item.tvdb_id,
        mediatype: item.type === 'movie' ? 'movie' : item.type === 'show' ? 'show' : mediaType,
      }));

      let metas = await parseMDBListItems(normalizedItems, type, language, config, includeVideos);
      metas = applyAgeRatingFilter(metas, type, config);
      return metas;
    }

    // Handle MDBList Up Next catalog
    if (id === 'mdblist.upnext') {
      // MDBList Up Next catalog - only supports series type
      if (type !== 'series') {
        logger.info(`MDBList Up Next: Type ${type} requested, returning empty (only series supported)`);
        return [];
      }
      
      const upNextStart = Date.now();
      logger.info(`[MDBList Up Next] Starting catalog fetch (page: ${page})`);
      
      const apiKey = config.apiKeys?.mdblist || process.env.MDBLIST_API_KEY || '';
      if (!apiKey) {
        logger.warn('[MDBList Up Next] Missing API key');
        return [];
      }
      
      const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20;
      // Ensure page is a number
      const pageNum = typeof page === 'number' ? page : parseInt(String(page), 10) || 1;
      const hideUnreleased = catalogConfig?.metadata?.hideUnreleased;
      const response = await fetchMDBListUpNext(apiKey, pageNum, pageSize, hideUnreleased);
      
      // Early exit for empty pages beyond list end
      if (!response.hasMore && (!response.items || response.items.length === 0)) {
        logger.info(`[MDBList Up Next] No more items at page ${pageNum}`);
        return [];
      }
      
      if (!response.items || response.items.length === 0) {
        logger.info(`[MDBList Up Next] No items found for page ${pageNum}`);
        return [];
      }
      
      const totalTime = Date.now() - upNextStart;
      logger.info(`[MDBList Up Next] Fetched ${response.items.length} items in ${totalTime}ms`);
      
      // Get useShowPoster setting from catalog config
      const useShowPoster = catalogConfig?.metadata?.useShowPosterForUpNext || false;
      logger.debug(`[MDBList Up Next] useShowPosterForUpNext = ${useShowPoster}`);
      
      const parseStart = Date.now();
      let metas = await parseMDBListUpNextItems(response.items, language, config, includeVideos, useShowPoster);
      const parseTime = Date.now() - parseStart;
      logger.info(`[MDBList Up Next] parseMDBListUpNextItems took ${parseTime}ms for ${response.items.length} items`);
      
      // Apply age rating filter
      metas = applyAgeRatingFilter(metas, type, config);
      
      logger.success(`[MDBList Up Next] Processed ${metas.length} items`);
      return metas;
    }
    
    // Handle external lists via sourceUrl
    if (catalogConfig?.sourceUrl && catalogConfig.sourceUrl.includes('/external/lists/')) {
      logger.info(`Fetching MDBList external list from sourceUrl: ${catalogConfig.sourceUrl}`);

      const sort = catalogConfig?.sort === 'default' ? undefined : catalogConfig?.sort;
      const order = catalogConfig?.sort === 'default' ? undefined : catalogConfig?.order;
      const unified = catalogConfig.type === 'all';
      const filterScoreMin = catalogConfig?.filter_score_min;
      const filterScoreMax = catalogConfig?.filter_score_max;

      const { convertGenreToSlug, fetchMDBListExternalItems } = await import('../utils/mdbList.js');
      const genreSlug = convertGenreToSlug(genre);

      const response = await fetchMDBListExternalItems(
        catalogConfig.sourceUrl,
        config.apiKeys?.mdblist || process.env.MDBLIST_API_KEY || '',
        language,
        page,
        sort,
        order,
        genreSlug,
        type,
        unified,
        filterScoreMin,
        filterScoreMax,
        catalogConfig?.cacheTTL
      );

      let metas = await parseMDBListItems(response.items, type, language, config, includeVideos);

      metas = applyAgeRatingFilter(metas, type, config);
      
      return metas;
    }

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
      if (!catalogConfig?.sourceUrl) {
        unified = true;
      } else {
      unified = catalogConfig?.type === 'all' || false;
      }
    }
    
    const response = await fetchMDBListItems(listId, config.apiKeys?.mdblist || process.env.MDBLIST_API_KEY || '', language, page, sort, order, genreSlug, unified, type, catalogConfig?.cacheTTL);
    
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
    
    metas = applyAgeRatingFilter(metas, type, config);
    
    return metas;
  }

  // Handle custom TMDB Discover catalogs (tmdb.discover.{customId})
  if (id.startsWith('tmdb.discover.')) {
    logger.info(`Fetching TMDB discover catalog: ${id}, Type: ${type}, Page: ${page}`);

    const catalogConfig = config.catalogs?.find(c => c.id === id && c.type === type);
    const tmdbApiKey = config.apiKeys?.tmdb || process.env.TMDB_API || process.env.BUILT_IN_TMDB_API_KEY || '';
    const isMovieCatalog = type === 'movie';
    const isSeriesCatalog = type === 'series';

    if (!tmdbApiKey) {
      logger.warn('[TMDB Discover] Missing API key');
      return [];
    }

    if (!isMovieCatalog && !isSeriesCatalog) {
      logger.warn(`[TMDB Discover] Unsupported type for discover catalog: ${type}`);
      return [];
    }

    const mediaType = isMovieCatalog ? 'movie' : 'tv';
    const discoverMetadata = catalogConfig?.metadata?.discover || {};
    const storedParams = discoverMetadata?.params || catalogConfig?.metadata?.discoverParams || {};
    const rawParams = storedParams && typeof storedParams === 'object' && !Array.isArray(storedParams)
      ? { ...storedParams }
      : {};
    if (genre && genre.toLowerCase() !== 'none') {
      const genreList = await getGenreList('tmdb', language, type === 'movie' ? 'movie' : 'series', config);
      const genreId = genreList.find((g: any) => g.name.toLowerCase() === genre.toLowerCase())?.id;
      if (genreId) {
        const existing = rawParams.with_genres ? String(rawParams.with_genres) : '';
        const existingIds = existing ? existing.split(',').map(s => s.trim()) : [];
        if (!existingIds.includes(String(genreId))) {
          existingIds.push(String(genreId));
        }
        rawParams.with_genres = existingIds.join(',');
      }
    }
    const discoverPage = typeof page === 'number' ? page : parseInt(String(page), 10) || 1;
    const resolvedParams = resolveDynamicTmdbDiscoverParams(rawParams, { timezone: config.timezone });
    const parameters = sanitizeTmdbDiscoverParams(
      resolvedParams,
      language,
      discoverPage,
      config.includeAdult || false,
      type as 'movie' | 'series'
    );

    try {
      const response = mediaType === 'movie'
        ? await moviedb.discoverMovie(parameters, config)
        : await moviedb.discoverTv(parameters, config);

      if (!response?.results || !Array.isArray(response.results) || response.results.length === 0) {
        logger.info(`[TMDB Discover] No results for ${id} at page ${discoverPage}`);
        return [];
      }

      const metaType = mediaType === 'movie' ? 'movie' : 'series';
      const metas = await Promise.all(response.results.map(async (item: any) => {
        const stremioId = `tmdb:${item.id}`;

        try {
          const result = await cacheWrapMetaSmart(userUUID, stremioId, async () => {
            return await getMeta(metaType, language, stremioId, config, userUUID, includeVideos);
          }, undefined, { enableErrorCaching: true, maxRetries: 2 }, metaType as any, includeVideos);

          if (result && result.meta) {
            return result.meta;
          }
        } catch (error: any) {
          logger.warn(`[TMDB Discover] Failed to get meta for ${stremioId}: ${error.message}`);
        }

        return null;
      }));

      const validMetas = metas.filter(meta => meta !== null);
      logger.success(`[TMDB Discover] Processed ${validMetas.length} items for ${id}`);
      return validMetas;
    } catch (error: any) {
      logger.error(`[TMDB Discover] Error fetching catalog ${id}: ${error.message}`);
      return [];
    }
  }

  // Handle TMDB List catalogs (tmdb.list.{listId} or tmdb.list.{listId}.movies/series)
  if (id.startsWith('tmdb.list.')) {
    logger.info(`Fetching TMDB list catalog: ${id}, Type: ${type}, Page: ${page}, Genre: ${genre}`);
    
    const catalogConfig = config.catalogs?.find(c => c.id === id);
    const tmdbApiKey = config.apiKeys?.tmdb || process.env.TMDB_API || process.env.BUILT_IN_TMDB_API_KEY || '';
    
    if (!tmdbApiKey) {
      logger.warn('[TMDB List] Missing API key');
      return [];
    }
    
    // Formats: tmdb.list.{listId} or tmdb.list.{listId}.movies or tmdb.list.{listId}.series
    const parts = id.split('.');
    const listId = parts[2]; // The list ID is always at index 2
    const isUnified = parts.length === 3; // tmdb.list.{listId} = unified
    const isSplit = parts.length === 4; // tmdb.list.{listId}.movies or tmdb.list.{listId}.series
    
    if (!listId) {
      logger.error(`[TMDB List] Invalid list ID format: ${id}`);
      return [];
    }
    
    try {
      const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20;
      const pageNum = typeof page === 'number' ? page : parseInt(String(page), 10) || 1;
      
      logger.debug(`[TMDB List] Fetching list ${listId}, page ${pageNum}, pageSize ${pageSize}`);
      
      const result = await moviedb.getTmdbListItems({ list_id: listId, page: pageNum }, config);
      
      if (!result || !result.items || result.items.length === 0) {
        logger.info(`[TMDB List] No items found for list ${listId} at page ${pageNum}`);
        return [];
      }
      
      logger.info(`[TMDB List] Fetched ${result.items.length} items from list ${listId}`);
      
      let items = result.items;
      if (isSplit) {
        const mediaType = parts[3];
        const tmdbMediaType = mediaType === 'movies' ? 'movie' : 'tv';
        items = items.filter((item: any) => item.media_type === tmdbMediaType);
        logger.debug(`[TMDB List] Filtered to ${items.length} ${mediaType} items`);
      }
      
      if (genre && genre.toLowerCase() !== 'none') {
        let genreList: Array<{ id: number; name: string }> = [];
        if (type === 'all') {
          const [movieGenres, seriesGenres] = await Promise.all([
            getGenreList('tmdb', language, "movie", config),
            getGenreList('tmdb', language, "series", config)
          ]);
          const genreMap = new Map();
          [...movieGenres, ...seriesGenres].forEach(g => genreMap.set(g.id, g));
          genreList = Array.from(genreMap.values());
          logger.debug(`[TMDB List] Combined genre list for 'all' type: ${genreList.length} genres`);
        } else {
          genreList = await getGenreList('tmdb', language, type as "movie" | "series", config);
        }
        
        const genreObj = genreList.find(g => g.name === genre);

        logger.debug(`[TMDB List] Genre object: ${JSON.stringify(genreObj)}`);
        if (genreObj) {
          const beforeCount = items.length;
          items = items.filter((item: any) => {
            return item.genre_ids && Array.isArray(item.genre_ids) && item.genre_ids.includes(genreObj.id);
          });
          logger.debug(`[TMDB List] Genre filter (${genre}): ${beforeCount} -> ${items.length} items`);
        } else {
          logger.warn(`[TMDB List] Genre "${genre}" not found in genre list`);
        }
      }
      
      const metas = await Promise.all(items.map(async (item: any) => {
        const itemType = item.media_type === 'movie' ? 'movie' : 'series';

        if (isUnified && type === 'all') {
        } else if (isUnified && itemType !== type) {
          return null;
        }
        
        const stremioId = `tmdb:${item.id}`;
        
        try {
          const result = await cacheWrapMetaSmart(userUUID, stremioId, async () => {
            return await getMeta(itemType, language, stremioId, config, userUUID, includeVideos);
          }, undefined, {enableErrorCaching: true, maxRetries: 2}, itemType as any, includeVideos);
          
          if (result && result.meta) {
            return result.meta;
          }
        } catch (error: any) {
          logger.warn(`[TMDB List] Failed to get meta for ${stremioId}: ${error.message}`);
        }
        
        return null;
      }));
      
      let validMetas = metas.filter(meta => meta !== null);
      
      validMetas = applyAgeRatingFilter(validMetas, type, config);
      
      logger.success(`[TMDB List] Processed ${validMetas.length} items for list ${listId}`);
      return validMetas;
      
    } catch (error: any) {
      logger.error(`[TMDB List] Error fetching list ${listId}: ${error.message}`);
      return [];
    }
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
    queryParams.append('api_key', config.apiKeys?.tmdb || process.env.TMDB_API || process.env.BUILT_IN_TMDB_API_KEY || '');
    const fullUrl = `${baseUrl}${endpoint}?${queryParams.toString()}`;
    // Note: Full URL/params logging removed to avoid exposing API keys in logs
  }

  const fetchFunction = type === "movie" 
    ? () => moviedb.discoverMovie(parameters, config) 
    : () => moviedb.discoverTv(parameters, config);

  const res: any = await fetchFunction();
  // define preferred provider as string
  
  // Sort results by release date (newest first) for catalogs that explicitly sort by release date
  // Top rated, year, and language catalogs should keep TMDB's default sorting, so skip this
  if (res?.results) {
    // Filter out spam entries for airing_today catalog
    if (id === 'tmdb.airing_today') {
      res.results = res.results.filter((item: any) => {
        const isSpam = !item.poster_path && !item.backdrop_path && item.vote_count === 0 && (!item.genre_ids || item.genre_ids.length === 0);
        return !isSpam;
      });
    }

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
    delete parameters['vote_count.gte'];
    const catalogConfig = config._currentCatalogConfig;
    if (catalogConfig?.sort) {
      const direction = catalogConfig.sortDirection || 'desc';
      let sortField = catalogConfig.sort;
      
      if (sortField === 'release_date') {
        sortField = type === 'movie' ? 'primary_release_date' : 'first_air_date';
      }
      
      parameters.sort_by = `${sortField}.${direction}`;
      
      if (sortField === 'vote_average') {
        parameters['vote_count.gte'] = 50; 
      }
    } else {
       parameters.sort_by = 'popularity.desc';
    }
  } else {
    const catalogConfig = config._currentCatalogConfig;
    if (catalogConfig?.sort && (id === 'tmdb.year' || id === 'tmdb.language')) {
      const direction = catalogConfig.sortDirection || 'desc';
      let sortField = catalogConfig.sort;
      
      if (sortField === 'release_date') {
        sortField = type === 'movie' ? 'primary_release_date' : 'first_air_date';
      }
      
      parameters.sort_by = `${sortField}.${direction}`;
      
      if (sortField === 'vote_average') {
        parameters['vote_count.gte'] = 50; 
      }
    }
    
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
        // Only set default sort if no custom sort is configured
        if (!catalogConfig?.sort) {
          parameters.sort_by = 'popularity.desc';
        }
        break;
      case "tmdb.language":
        const findGenre = genre && genre.toLowerCase() !== 'none' ? findLanguageCode(genre, languages) : language.split("-")[0];
        parameters.with_original_language = findGenre;
        // Only set default sort if no custom sort is configured
        if (!catalogConfig?.sort) {
          parameters.sort_by = 'popularity.desc';
        }
        break;
      case "tmdb.top_rated":
        // Sort by vote average (highest rated first) with minimum vote count
        parameters.sort_by = type === "movie" ? 'vote_average.desc' : 'vote_average.desc';
        parameters['vote_count.gte'] = 500; // Require at least 500 votes for top rated
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

async function sanitizeTvdbDiscoverParams(
  rawParams: any,
  language: string,
  catalogType: 'movie' | 'series',
  config: UserConfig
): Promise<Record<string, any>> {
  const sanitized: Record<string, any> = {};
  const isPlainObject = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams);

  if (isPlainObject) {
    for (const [key, rawValue] of Object.entries(rawParams)) {
      if (!/^[a-zA-Z0-9._]+$/.test(key)) continue;
      if (rawValue === null || rawValue === undefined) continue;

      if (typeof rawValue === 'string') {
        const value = rawValue.trim();
        if (!value) continue;
        sanitized[key] = value;
        continue;
      }

      if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
        sanitized[key] = rawValue;
      }
    }
  }

  const langParts = language.split('-');
  const countryCode2 = langParts[1] || 'US';
  const defaultLang = 'eng';
  const defaultCountry = to3LetterCountryCode(countryCode2).toLowerCase();

  const allowedSorts = catalogType === 'movie'
    ? new Set(['score', 'firstAired', 'name'])
    : new Set(['score', 'firstAired', 'lastAired', 'name']);

  const numericFields = new Set(['company', 'contentRating', 'genre', 'status', 'year']);
  for (const field of numericFields) {
    if (sanitized[field] === undefined) continue;
    const numericValue = Number(sanitized[field]);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      delete sanitized[field];
      continue;
    }
    sanitized[field] = Math.floor(numericValue);
  }

  sanitized.lang = typeof sanitized.lang === 'string' && sanitized.lang.trim()
    ? sanitized.lang.trim().toLowerCase()
    : defaultLang;

  sanitized.country = typeof sanitized.country === 'string' && sanitized.country.trim()
    ? sanitized.country.trim().toLowerCase()
    : defaultCountry;

  if (!allowedSorts.has(String(sanitized.sort || '').trim())) {
    sanitized.sort = 'score';
  }

  if (catalogType === 'series') {
    const sortType = String(sanitized.sortType || 'desc').toLowerCase();
    sanitized.sortType = sortType === 'asc' ? 'asc' : 'desc';
  } else {
    delete sanitized.sortType;
  }

  const allowedParams = new Set(['company', 'contentRating', 'country', 'genre', 'lang', 'sort', 'sortType', 'status', 'year']);
  for (const key of Object.keys(sanitized)) {
    if (!allowedParams.has(key)) {
      delete sanitized[key];
    }
  }

  return sanitized;
}

function sanitizeTmdbDiscoverParams(
  rawParams: any,
  language: string,
  page: number,
  includeAdultFallback: boolean,
  catalogType: 'movie' | 'series'
): Record<string, any> {
  const sanitized: Record<string, any> = {};
  const isPlainObject = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams);

  if (isPlainObject) {
    for (const [key, rawValue] of Object.entries(rawParams)) {
      if (!/^[a-zA-Z0-9._]+$/.test(key)) continue;
      if (key === 'api_key') continue;

      if (rawValue === null || rawValue === undefined) continue;

      if (Array.isArray(rawValue)) {
        const arrayValues = rawValue
          .map(v => String(v).trim())
          .filter(Boolean);
        if (arrayValues.length > 0) {
          sanitized[key] = arrayValues.join(',');
        }
        continue;
      }

      if (typeof rawValue === 'string') {
        const value = rawValue.trim();
        if (!value) continue;
        if (value.toLowerCase() === 'true') {
          sanitized[key] = true;
        } else if (value.toLowerCase() === 'false') {
          sanitized[key] = false;
        } else {
          sanitized[key] = value;
        }
        continue;
      }

      if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
        sanitized[key] = rawValue;
        continue;
      }

      if (typeof rawValue === 'boolean') {
        sanitized[key] = rawValue;
      }
    }
  }

  sanitized.page = Math.max(1, Number(page) || 1);
  sanitized.language = sanitized.language || language;

  if (typeof sanitized.include_adult !== 'boolean') {
    sanitized.include_adult = !!includeAdultFallback;
  }

  if (!sanitized.sort_by) {
    sanitized.sort_by = 'popularity.desc';
  }

  const commonAllowedParams = new Set([
    'page',
    'language',
    'include_adult',
    'sort_by',
    'vote_average.gte',
    'vote_average.lte',
    'vote_count.gte',
    'vote_count.lte',
    'watch_region',
    'with_watch_monetization_types',
    'with_watch_providers',
    'without_watch_providers',
    'with_genres',
    'without_genres',
    'with_companies',
    'without_companies',
    'with_keywords',
    'without_keywords',
    'with_origin_country',
    'with_original_language',
    'with_runtime.gte',
    'with_runtime.lte'
  ]);

  const movieOnlyAllowedParams = new Set([
    'certification',
    'certification.gte',
    'certification.lte',
    'certification_country',
    'include_video',
    'primary_release_year',
    'primary_release_date.gte',
    'primary_release_date.lte',
    'release_date.gte',
    'release_date.lte',
    'region',
    'with_cast',
    'with_crew',
    'with_people',
    'with_release_type',
    'year'
  ]);

  const tvOnlyAllowedParams = new Set([
    'air_date.gte',
    'air_date.lte',
    'first_air_date_year',
    'first_air_date.gte',
    'first_air_date.lte',
    'include_null_first_air_dates',
    'screened_theatrically',
    'timezone',
    'with_networks',
    'with_status',
    'with_type'
  ]);

  const allowedParams = catalogType === 'movie'
    ? new Set([...commonAllowedParams, ...movieOnlyAllowedParams])
    : new Set([...commonAllowedParams, ...tvOnlyAllowedParams]);

  for (const key of Object.keys(sanitized)) {
    if (!allowedParams.has(key)) {
      delete sanitized[key];
    }
  }

  if (sanitized.sort_by === 'vote_average.desc' && sanitized['vote_count.gte'] === undefined) {
    sanitized['vote_count.gte'] = 50;
  }

  // Certification filters should be sent as a pair
  if (!!sanitized.certification && !sanitized.certification_country) {
    delete sanitized.certification;
  }
  if (!!sanitized.certification_country && !sanitized.certification) {
    delete sanitized.certification_country;
  }

  // Watch provider filter requires region
  if (!!sanitized.with_watch_providers && !sanitized.watch_region) {
    delete sanitized.with_watch_providers;
    delete sanitized.with_watch_monetization_types;
  } else if (!!sanitized.with_watch_providers && !sanitized.with_watch_monetization_types) {
    sanitized.with_watch_monetization_types = 'flatrate|free|ads|rent|buy';
  }

  if (catalogType === 'movie') {
    delete sanitized['air_date.gte'];
    delete sanitized['air_date.lte'];
    delete sanitized['first_air_date.gte'];
    delete sanitized['first_air_date.lte'];
    delete sanitized.first_air_date_year;
    delete sanitized.with_type;
  } else {
    delete sanitized['primary_release_date.gte'];
    delete sanitized['primary_release_date.lte'];
    delete sanitized.primary_release_year;
    delete sanitized.region;
  }

  return sanitized;
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
      logger.debug(
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
    logger.debug(`[✨ StremThru] Batch caching: fetched ${batchesNeeded} batch(es) for page ${page}, total items: ${allItems.length}`);

    // --- Parse and filter metas ---
    let metas = await parseStremThruItems(paginatedItems, type, genre, language, config, includeVideos);

    // Filter unreleased content if configured
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
    
    const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20;
    
    const catalogConfig = config.catalogs?.find(c => c.id === catalogId);
    const sort = catalogConfig?.sort === 'default' ? undefined : catalogConfig?.sort;
    const sortDirection = catalogConfig?.sortDirection;
    let accessToken: string | null | undefined = undefined;

    const ensureTraktAccessToken = async (): Promise<string | null> => {
      if (accessToken !== undefined) {
        return accessToken;
      }

      accessToken = await getTraktAccessToken(config);
      if (!accessToken) {
        logger.warn(`Trakt not connected for user ${userUUID} (catalog: ${catalogId})`);
      }
      return accessToken;
    };
    // Determine content type filter for API
    let traktType: 'movies' | 'shows' | undefined;
    if (type === 'movie') traktType = 'movies';
    else if (type === 'series') traktType = 'shows';
    // If type is 'all', traktType remains undefined

    let genreSlug = undefined;
    if (genre && genre !== 'None') {
       // Fetch the full genre objects list (cached)
       const genreList = await require('../utils/traktUtils.js').fetchTraktGenres(traktType || 'all');
       
       // Find the object where name matches the user selection
       const genreObj = genreList.find((g: any) => g.name === genre);
       
       // Use the slug if found, otherwise fallback to lowercase (handles legacy/manual inputs)
       genreSlug = genreObj ? genreObj.slug : genre.toLowerCase();
       
       logger.debug(`[Trakt] Resolved genre '${genre}' to slug '${genreSlug}'`);
    }
    
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
        const token = await ensureTraktAccessToken();
        if (!token) {
          return [];
        }

        const upNextStart = Date.now();
        logger.info('Up Next: Starting catalog fetch');
        
        const cacheKey = `trakt_upnext_${token.substring(0, 8)}`;
        const timestampKey = `trakt_upnext_timestamp_${token.substring(0, 8)}`;
        const cacheTTL = 300; // 5 minutes for items
        const timestampTTL = 3600; // 1 hour for timestamp (persists across cache refreshes)
        
        const cacheCheckStart = Date.now();
        const cachedData = await cacheWrap(cacheKey, async () => null, cacheTTL);

        // Get last known timestamp (longer TTL so it persists)
        // Only use the saved timestamp to short-circuit rebuild when we still have cached items.
        // If the items cache has expired (cachedData is null), force a rebuild by not passing the timestamp.
        const cachedTimestamp = cachedData ? await cacheWrap(timestampKey, async () => null, timestampTTL) : null;
        const cacheCheckTime = Date.now() - cacheCheckStart;
        logger.info(`Up Next: Cache check took ${cacheCheckTime}ms`);
        
        const fetchStart = Date.now();
        const result = await require('../utils/traktUtils.js').fetchTraktUpNextEpisodes(token, cachedTimestamp);
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
        const token = await ensureTraktAccessToken();
        if (!token) {
          return [];
        }

        const runStart = Date.now();
        logger.info('Unwatched: Starting catalog fetch');

        const cacheKey = `trakt_unwatched_${token.substring(0, 8)}`;
        const timestampKey = `trakt_unwatched_timestamp_${token.substring(0, 8)}`;
        const cacheTTL = 300; // 5 minutes
        const timestampTTL = 3600; // 1 hour

        const cachedData = await cacheWrap(cacheKey, async () => null, cacheTTL);
        const cachedTimestamp = await cacheWrap(timestampKey, async () => null, timestampTTL);

        const result = await require('../utils/traktUtils.js').fetchTraktUnwatchedEpisodes(token, cachedTimestamp);

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
      // Trakt Calendar - Shows airing soon
      // Only shows page 1, returns empty for page 2+
      if (page > 1) {
        logger.info(`Trakt Calendar: Page ${page} requested, returning empty (only page 1 exists)`);
        response = { items: [], hasMore: false };
      } else {
        const token = await ensureTraktAccessToken();
        if (!token) {
          return [];
        }

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
        
        // Get configured days (1-7), default to 1 if not set
        const catalogConfig = config.catalogs?.find(c => c.id === 'trakt.calendar');
        const days = catalogConfig?.metadata?.airingSoonDays || 1;
        const clampedDays = Math.max(1, Math.min(7, days));
        
        logger.info(`Trakt Calendar: Fetching shows airing in next ${clampedDays} day(s) (${startDate}, timezone: ${timezone})`);
        
        // Fetch shows for the configured number of days
        const calendarResult = await fetchTraktCalendarShows(token, startDate, clampedDays, catalogConfig?.cacheTTL);
        
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
      response = await fetchTraktMostFavoritedItems(favType as 'movies' | 'shows', favPeriod as any, page, pageSize, genreSlug, catalogConfig?.cacheTTL);
    } else if (catalogId === 'trakt.trending.movies') {
      logger.debug('Fetching Trakt trending movies');
      const result = await require('../utils/traktUtils.js').fetchTraktTrendingItems('movies', page, pageSize, genreSlug, catalogConfig?.cacheTTL);
      response = { items: result.items, hasMore: result.hasMore, totalItems: result.totalItems, totalPages: result.totalPages };
    } else if (catalogId === 'trakt.trending.shows') {
      logger.debug('Fetching Trakt trending shows');
      const result = await require('../utils/traktUtils.js').fetchTraktTrendingItems('shows', page, pageSize, genreSlug, catalogConfig?.cacheTTL);
      response = { items: result.items, hasMore: result.hasMore, totalItems: result.totalItems, totalPages: result.totalPages };
    } else if (catalogId === 'trakt.popular.movies') {
      logger.debug('Fetching Trakt popular movies');
      const result = await require('../utils/traktUtils.js').fetchTraktPopularItems('movies', page, pageSize, genreSlug, catalogConfig?.cacheTTL);
      response = { items: result.items, hasMore: result.hasMore, totalItems: result.totalItems, totalPages: result.totalPages };
    } else if (catalogId === 'trakt.popular.shows') {
      logger.debug('Fetching Trakt popular shows');
      const result = await require('../utils/traktUtils.js').fetchTraktPopularItems('shows', page, pageSize, genreSlug, catalogConfig?.cacheTTL);
      response = { items: result.items, hasMore: result.hasMore, totalItems: result.totalItems, totalPages: result.totalPages };
    } else if (catalogId === 'trakt.watchlist') {
      // Unified watchlist
      const token = await ensureTraktAccessToken();
      if (!token) {
        return [];
      }
      logger.debug(`Fetching Trakt unified watchlist`);
      response = await fetchTraktWatchlistItems(token, undefined, page, pageSize, sort, sortDirection, genreSlug, catalogConfig?.cacheTTL);
    } else if (catalogId === 'trakt.watchlist.movies') {
      // Movies-only watchlist
      const token = await ensureTraktAccessToken();
      if (!token) {
        return [];
      }
      logger.debug(`Fetching Trakt watchlist (movies only)`);
      response = await fetchTraktWatchlistItems(token, 'movies', page, pageSize, sort, sortDirection, genreSlug, catalogConfig?.cacheTTL);
    } else if (catalogId === 'trakt.watchlist.series') {
      // Series-only watchlist
      const token = await ensureTraktAccessToken();
      if (!token) {
        return [];
      }
      logger.debug(`Fetching Trakt watchlist (shows only)`);
      response = await fetchTraktWatchlistItems(token, 'shows', page, pageSize, sort, sortDirection, genreSlug, catalogConfig?.cacheTTL);
    } else if (catalogId === 'trakt.favorites.movies') {
      // Movies-only favorites
      const token = await ensureTraktAccessToken();
      if (!token) {
        return [];
      }
      logger.debug(`Fetching Trakt favorites (movies only)`);
      response = await fetchTraktFavoritesItems(token, 'movies', page, pageSize, sort, sortDirection, genreSlug, catalogConfig?.cacheTTL);
    } else if (catalogId === 'trakt.favorites.shows') {
      // Shows-only favorites
      const token = await ensureTraktAccessToken();
      if (!token) {
        return [];
      }
      logger.debug(`Fetching Trakt favorites (shows only)`);
      response = await fetchTraktFavoritesItems(token, 'shows', page, pageSize, sort, sortDirection, genreSlug, catalogConfig?.cacheTTL);
    } else if (catalogId === 'trakt.recommendations.movies') {
      // Movies-only recommendations
      const token = await ensureTraktAccessToken();
      if (!token) {
        return [];
      }
      logger.debug(`Fetching Trakt recommendations (movies only)`);
      response = await fetchTraktRecommendationsItems(token, 'movies', page, 50, catalogConfig?.cacheTTL);
    } else if (catalogId === 'trakt.recommendations.shows') {
      // Shows-only recommendations
      const token = await ensureTraktAccessToken();
      if (!token) {
        return [];
      }
      logger.debug(`Fetching Trakt recommendations (shows only)`);
      response = await fetchTraktRecommendationsItems(token, 'shows', page, 50, catalogConfig?.cacheTTL);
    } else {
      // Custom list: supports two formats:
      // - trakt.list.<traktListId>
      // - trakt.<username>.<listSlug>  (legacy/backwards-compatible)
      const parts = catalogId.split('.');
      if (parts.length < 3) {
        logger.error(`Invalid Trakt list ID format: ${catalogId}`);
        return [];
      }

      const privacy = catalogConfig?.metadata?.privacy || 'public';
      const listAccessToken = privacy === 'public'
        ? ''
        : (await ensureTraktAccessToken() || '');

      if (privacy !== 'public' && !listAccessToken) {
        return [];
      }

      if (parts[1] === 'list') {
        // New numeric list-id format
        let listId = parts[2];
        // Remove .movies or .series suffix if present
        let splitType: string | undefined;
        if (listId.endsWith('.movies')) {
          listId = listId.slice(0, -7);
          splitType = 'movies';
        } else if (listId.endsWith('.series')) {
          listId = listId.slice(0, -7);
          splitType = 'shows';
        }

        logger.debug(`Fetching Trakt list by id: ${listId} (splitType=${splitType || 'all'}), privacy=${privacy})`);
        response = await fetchTraktListItemsById(listId, listAccessToken, traktType, page, pageSize, sort, genreSlug, sortDirection, catalogConfig?.cacheTTL, privacy);
      } else {
        // Legacy username + slug format
        const username = parts[1];
        let listSlug = parts.slice(2).join('.');
        // Remove .movies or .series suffix if present (from split catalogs)
        if (listSlug.endsWith('.movies')) {
          listSlug = listSlug.slice(0, -7); // Remove '.movies'
        } else if (listSlug.endsWith('.series')) {
          listSlug = listSlug.slice(0, -7); // Remove '.series'
        }

        logger.debug(`Fetching Trakt list: ${username}/${listSlug}, privacy=${privacy})`);
        response = await fetchTraktListItems(username, listSlug, listAccessToken, traktType, page, pageSize, sort, genreSlug, sortDirection, catalogConfig?.cacheTTL, privacy);
      }
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
    // Pass useShowPosterForUpNext setting to items
    const useShowPoster = catalogConfig?.metadata?.useShowPosterForUpNext || false;
    logger.debug(`Up Next: useShowPosterForUpNext = ${useShowPoster}`);
    let metas = await parseTraktItems(response.items, type, language, config, includeVideos, useShowPoster);
    const parseTime = Date.now() - parseStart;
    logger.info(`Up Next: parseTraktItems took ${parseTime}ms for ${response.items.length} items`);
    
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
  genre: string | null,
  page: number,
  language: string,
  config: UserConfig,
  userUUID: string,
  includeVideos: boolean = false
): Promise<any[]> {
  try {
    logger.info(`[AniList] Fetching catalog: ${catalogId}, Page: ${page}`);
    
    // Handle trending catalog - doesn't require username
    if (catalogId === 'anilist.trending') {
      const pageSize = 50;
      const catalogConfig = config.catalogs?.find(c => c.id === catalogId);
      const customCacheTTL = catalogConfig?.cacheTTL || null;
      const sfw = config.sfw || false;
      
      // Fetch trending anime with caching
      // Include sfw in cache key to prevent mixing SFW and non-SFW results
      const response = await cacheWrapAniListCatalog(
        'trending',
        `trending:sfw:${sfw}:genre:${genre || 'all'}`,
        page,
        async () => anilist.fetchTrending(page, pageSize, sfw, genre || undefined),
        customCacheTTL,
        { enableErrorCaching: true }
      );
      
      // Handle cached error responses
      if (response && (response as any).error) {
        logger.warn(`[AniList] Cached error for trending: ${(response as any).message}`);
        return [];
      }
      
      logger.debug(`[AniList] Fetched ${response.items.length} trending items, hasMore: ${response.hasMore}`);
      
      if (response.items.length === 0) {
        return [];
      }
      
      // Resolve AniList media IDs to Stremio metas
      const metas = await resolveAniListItemsToMetas(response.items, type, language, config, userUUID, includeVideos);
      logger.success(`[AniList] Processed ${metas.length} trending items (page ${page})`);
      return metas;
    }
    
    // Get the catalog config to retrieve username, list name and custom TTL
    const catalogConfig = config.catalogs?.find(c => c.id === catalogId);
    const username = catalogConfig?.metadata?.username;
    
    // Prefer explicit listName metadata; fall back to id parsing to support older configs
    const idWithoutPrefix = catalogId.replace('anilist.', '');
    const listName = catalogConfig?.metadata?.listName
      || (idWithoutPrefix.includes('.') ? idWithoutPrefix.split('.').slice(1).join('.') : idWithoutPrefix);
    
    if (!username) {
      logger.error(`[AniList] No username found in catalog config for: ${catalogId}`);
      return [];
    }
    if (!listName) {
      logger.error(`[AniList] No list name resolved for catalog: ${catalogId}`);
      return [];
    }
    
    const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20;
    
    // Get custom cache TTL and sort option from catalog config if specified
    const customCacheTTL = catalogConfig?.cacheTTL || null;
    const sortBase = catalogConfig?.sort || 'ADDED_TIME';
    const sortDirection = catalogConfig?.sortDirection || 'desc';
    
    // Combine sort and direction for AniList (e.g., ADDED_TIME + desc = ADDED_TIME_DESC)
    const sort = sortDirection === 'desc' ? `${sortBase}_DESC` : sortBase;
    
    logger.debug(`[AniList] Using sort: ${sortBase}, direction: ${sortDirection}, combined: ${sort}`);
    
    // Fetch list items from AniList API with caching
    const response = await cacheWrapAniListCatalog(
      username,
      listName,
      page,
      async () => anilist.fetchListItems(username, listName, page, pageSize, sort),
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
  items: Array<{ score: number; media: any }>,
  type: string,
  language: string,
  config: UserConfig,
  userUUID: string,
  includeVideos: boolean
): Promise<any[]> {
  // Helper function to strip HTML tags from AniList descriptions
  const stripHtml = (html: string | null | undefined): string => {
    if (!html) return '';
    return html
      .replace(/<br\s*\/?>/gi, '\n') // Convert <br> to newlines
      .replace(/<\/?[^>]+(>|$)/g, '') // Remove all other HTML tags
      .replace(/\n\n+/g, '\n\n') // Collapse multiple newlines
      .trim();
  };

  const getStremioTypeFromFormat = (format: string | null | undefined): string => {
    if (!format) return 'series';
    
    const formatUpper = format.toUpperCase();
    
    // Movie formats: MOVIE, SPECIAL, ONE_SHOT
    if (formatUpper === 'MOVIE' || formatUpper === 'SPECIAL' || formatUpper === 'ONE_SHOT') {
      return 'movie';
    }
    
    // Series formats: TV, TV_SHORT, OVA, ONA (and everything else defaults to series)
    // TV, TV_SHORT, OVA, ONA are all series
    return 'series';
  };

  // create new items with property mal_id and type, plus additional AniList fields
  const newItems = items.map(item => {
    const media = item.media;
    const itemType = getStremioTypeFromFormat(media.format) || type;
    
    // Format dates from AniList structure
    const airedFrom = media.startDate?.year 
      ? `${media.startDate.year}-${String(media.startDate.month || 1).padStart(2, '0')}-${String(media.startDate.day || 1).padStart(2, '0')}`
      : null;
    const airedTo = media.endDate?.year
      ? `${media.endDate.year}-${String(media.endDate.month || 12).padStart(2, '0')}-${String(media.endDate.day || 31).padStart(2, '0')}`
      : null;
    
    return {
      mal_id: media.idMal,
      type: itemType,
      title: media.title?.romaji,
      title_english: media.title?.english,
      year: media.seasonYear || media.startDate?.year,
      duration: media.duration ? `${media.duration} min per ep` : null,
      episodes: media.episodes,
      synopsis: stripHtml(media.description),
      images: {
        jpg: {
          large_image_url: media.coverImage?.large || media.coverImage?.medium || null
        }
      },
      aired: {
        from: airedFrom,
        to: airedTo
      },
      status: airedTo ? 'Finished Airing' : 'Currently Airing'
    };
  });
  const metas= await Utils.parseAnimeCatalogMetaBatch(newItems, config, language);
  
  // Filter out null results
  let validMetas = metas.filter(meta => meta !== null);
  
  return validMetas;
}

/**
 * Get Letterboxd catalog via StremThru API
 */
async function getLetterboxdCatalog(
  type: string,
  catalogId: string,
  genreName: string,
  page: number,
  language: string,
  config: UserConfig,
  userUUID: string,
  includeVideos: boolean = false
): Promise<any[]> {
  try {
    // Extract identifier from catalog ID (format: letterboxd.<identifier>)
    const identifier = catalogId.replace('letterboxd.', '');
    
    if (!identifier) {
      logger.error(`Invalid Letterboxd catalog ID: ${catalogId}`);
      return [];
    }

    // Find catalog config to determine if it's a watchlist
    const catalogConfig = config.catalogs?.find(c => c.id === catalogId);
    const isWatchlist = catalogConfig?.metadata?.isWatchlist || false;

    logger.info(`Fetching Letterboxd ${isWatchlist ? 'watchlist' : 'list'}: ${identifier}, Page: ${page}`);

    // Fetch list data from StremThru
    // cache wrap the fetchLetterboxdList call with the custom cache TTL from the catalog config with a minimum of 2hrs
    const listData = await cacheWrap(
      `letterboxd-list:${identifier}:${isWatchlist}`,
      async () => await fetchLetterboxdList(identifier, isWatchlist),
      catalogConfig?.cacheTTL || 7200,
      { enableErrorCaching: true, maxRetries: 2 }
    );
    
    if (!listData?.data?.items) {
      logger.warn(`No items found in Letterboxd list: ${identifier}`);
      return [];
    }

    const allItems = listData.data.items;
    logger.info(`Retrieved ${allItems.length} items from Letterboxd list`);
    let filteredItems = allItems;
    if( genreName && genreName.toLowerCase() !== 'none') {
      filteredItems = filteredItems.filter(item => item.genre_ids.includes(getLetterboxdGenreIdByName(genreName)));
    }

    // Calculate pagination - use configurable page size (supports CATALOG_LIST_ITEMS_SIZE env var)
    const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20;
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const pageItems = filteredItems.slice(startIndex, endIndex);

    if (pageItems.length === 0) {
      logger.info(`No items on page ${page} for Letterboxd list ${identifier}`);
      return [];
    }

    logger.debug(`Processing ${pageItems.length} items for page ${page}`);

    // Parse items using the helper function
    let metas = await parseLetterboxdItems(
      pageItems,
      type,
      language,
      config,
      includeVideos
    );

    metas = applyAgeRatingFilter(metas, type, config);

    logger.debug(`Successfully processed ${metas.length} Letterboxd items`);
    return metas;
  } catch (error: any) {
    logger.error(`Error in getLetterboxdCatalog: ${error.message}`);
    logger.error(`Stack trace:`, error.stack);
    return [];
  }
}

type SimklDiscoverMediaType = 'movies' | 'shows' | 'anime';

function sanitizeSimklDiscoverParams(
  rawParams: any,
  catalogType: string
): {
  media: SimklDiscoverMediaType;
  genre: string;
  type: string;
  country?: string;
  network?: string;
  year: string;
  sort: string;
} {
  const normalize = (value: any): string => {
    if (typeof value !== 'string') return '';
    return value.trim().toLowerCase();
  };

  const rawMedia = normalize(rawParams?.media);
  const defaultMedia: SimklDiscoverMediaType = catalogType === 'movie'
    ? 'movies'
    : catalogType === 'anime'
      ? 'anime'
      : 'shows';
  const media: SimklDiscoverMediaType = rawMedia === 'movies' || rawMedia === 'shows' || rawMedia === 'anime'
    ? rawMedia
    : defaultMedia;

  const movieGenres = new Set([
    'all', 'action', 'adventure', 'animation', 'comedy', 'crime', 'documentary', 'drama', 'family', 'fantasy',
    'history', 'horror', 'music', 'mystery', 'romance', 'science-fiction', 'thriller', 'tv-movie', 'war', 'western'
  ]);
  const tvGenres = new Set([
    'all', 'action', 'adventure', 'animation', 'awards-show', 'children', 'comedy', 'crime', 'documentary', 'drama',
    'family', 'fantasy', 'food', 'game-show', 'history', 'home-and-garden', 'horror', 'indie', 'korean-drama',
    'martial-arts', 'mini-series', 'musical', 'mystery', 'news', 'podcast', 'reality', 'romance', 'science-fiction',
    'soap', 'special-interest', 'sport', 'suspense', 'talk-show', 'thriller', 'travel', 'video-game-play', 'war', 'western'
  ]);
  const animeGenres = new Set([
    'all', 'action', 'adventure', 'comedy', 'drama', 'ecchi', 'educational', 'fantasy', 'gag-humor', 'gore', 'harem',
    'historical', 'horror', 'idol', 'isekai', 'josei', 'kids', 'magic', 'martial-arts', 'mecha', 'military', 'music',
    'mystery', 'mythology', 'parody', 'psychological', 'racing', 'reincarnation', 'romance', 'samurai', 'school',
    'sci-fi', 'seinen', 'shoujo', 'shoujo-ai', 'shounen', 'shounen-ai', 'slice-of-life', 'space', 'sports',
    'strategy-game', 'super-power', 'supernatural', 'thriller', 'vampire', 'yaoi', 'yuri'
  ]);

  const movieSorts = new Set(['popular-this-week', 'popular-this-month', 'rank', 'votes', 'budget', 'revenue', 'release-date', 'most-anticipated', 'a-z', 'z-a']);
  const tvAnimeSorts = new Set(['popular-today', 'popular-this-week', 'popular-this-month', 'rank', 'votes', 'release-date', 'last-air-date', 'a-z', 'z-a']);

  const movieYears = new Set(['this-week', 'this-month', 'this-year', '2019', '2018', '2017', '2016', '2015', '2014', '2013', '2012', '2011', '2010s', '2000s', '1990s', '1980s', '1970s', '1960s']);
  const tvAnimeYears = new Set(['all-years', 'today', 'this-week', 'this-month', 'this-year', '2019', '2018', '2017', '2016', '2015', '2014', '2013', '2012', '2011', '2010s', '2000s', '1990s', '1980s', '1970s', '1960s']);

  const tvTypes = new Set(['all-types', 'tv-shows', 'entertainment', 'documentaries', 'animation-filter']);
  const animeTypes = new Set(['all-types', 'series', 'movies', 'ovas', 'onas']);

  const movieCountries = new Set(['all', 'us', 'uk', 'ca', 'kr']);
  const tvCountries = new Set(['all', 'us', 'uk', 'ca', 'kr', 'jp']);

  const tvNetworks = new Set([
    'all-networks', 'netflix', 'disney', 'peacock', 'appletv', 'quibi', 'cbs', 'abc', 'fox', 'cw', 'hbo', 'showtime',
    'usa', 'syfy', 'tnt', 'fx', 'amc', 'abcfam', 'showcase', 'starz', 'mtv', 'lifetime', 'ae', 'tvland'
  ]);
  const animeNetworks = new Set([
    'all-networks', 'tvtokyo', 'tokyomx', 'fujitv', 'tokyobroadcastingsystem', 'tvasahi', 'wowow', 'ntv', 'atx',
    'ctc', 'nhk', 'mbs', 'animax', 'cartoonnetwork', 'abc'
  ]);

  const pick = (value: string, allowed: Set<string>, fallback: string): string => {
    if (!value) return fallback;
    return allowed.has(value) ? value : fallback;
  };

  const genre = media === 'movies'
    ? pick(normalize(rawParams?.genre), movieGenres, 'all')
    : media === 'shows'
      ? pick(normalize(rawParams?.genre), tvGenres, 'all')
      : pick(normalize(rawParams?.genre), animeGenres, 'all');

  const type = media === 'movies'
    ? 'all-types'
    : media === 'shows'
      ? pick(normalize(rawParams?.type), tvTypes, 'all-types')
      : pick(normalize(rawParams?.type), animeTypes, 'all-types');

  const year = media === 'movies'
    ? pick(normalize(rawParams?.year), movieYears, 'this-year')
    : pick(normalize(rawParams?.year), tvAnimeYears, 'all-years');

  const sort = media === 'movies'
    ? pick(normalize(rawParams?.sort), movieSorts, 'popular-this-week')
    : pick(normalize(rawParams?.sort), tvAnimeSorts, 'popular-today');

  if (media === 'movies') {
    return {
      media,
      genre,
      type,
      country: pick(normalize(rawParams?.country), movieCountries, 'all'),
      year,
      sort,
    };
  }

  if (media === 'shows') {
    return {
      media,
      genre,
      type,
      country: pick(normalize(rawParams?.country), tvCountries, 'all'),
      network: pick(normalize(rawParams?.network), tvNetworks, 'all-networks'),
      year,
      sort,
    };
  }

  return {
    media,
    genre,
    type,
    network: pick(normalize(rawParams?.network), animeNetworks, 'all-networks'),
    year,
    sort,
  };
}

/**
 * Get Simkl catalog items
 * Handles 'simkl.*' catalog IDs (e.g., simkl.trending.movies, simkl.trending.shows, simkl.trending.anime)
 */
async function getSimklCatalog(
  type: string,
  catalogId: string,
  genre: string,
  page: number,
  language: string,
  config: UserConfig,
  userUUID: string,
  includeVideos: boolean = false,
  skip?: number
): Promise<any[]> {
  try {
    logger.info(`[Simkl] Fetching catalog: ${catalogId}, Type: ${type}, Page: ${page}`);
    
    const catalogConfig = config.catalogs?.find(c => c.id === catalogId);
    
    // For watchlists, use default pageSize (Simkl doesn't support pagination, we do local pagination)
    // For trending, use configured pageSize
    const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE || '20')
    const discoverPageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE || '20');
    
    let response: any;
    
    if (catalogId.startsWith('simkl.discover.')) {
      const discoverMetadata = catalogConfig?.metadata?.discover || {};
      const rawParams = discoverMetadata?.params || catalogConfig?.metadata?.discoverParams || {};
      let genreName = genre;
      const discoverParams = sanitizeSimklDiscoverParams(rawParams, type);
      if(!genreName || genreName.toLowerCase() === 'none') genreName = 'all';
      if(genreName !=discoverParams.genre){
        discoverParams.genre = genreName;
      }
      logger.debug(`[Simkl Discover] Fetching with params: ${JSON.stringify(discoverParams)}`);

      const result = await fetchSimklGenreItems(
        discoverParams.media,
        discoverParams,
        page,
        discoverPageSize,
        catalogConfig?.cacheTTL
      );

      response = { items: result.items, hasMore: result.hasMore, totalItems: result.totalItems };
    } else if (catalogId === 'simkl.trending.movies') {
      const interval: 'today' | 'week' | 'month' = (genre && ['today', 'week', 'month'].includes(genre.toLowerCase()) 
        ? genre.toLowerCase() as 'today' | 'week' | 'month'
        : (catalogConfig?.metadata?.interval as 'today' | 'week' | 'month')) || 'today';
      logger.debug(`[Simkl] Fetching trending movies (interval: ${interval}, pageSize: ${pageSize})`);
      const result = await fetchSimklTrendingItems('movies', interval, page, pageSize, catalogConfig?.cacheTTL);
      const items = (result.items as any[]).filter((it: any) => {
        const ids = it.ids || {};
        const ok = !!(ids.imdb || ids.tmdb || ids.tvdb || ids.mal || ids.simkl || ids.simkl_id);
        if (!ok) logger.debug(`[Simkl] Skipping trending item with only simkl ID: ${it.title || 'Unknown'}`);
        return ok;
      });
      response = { items, hasMore: result.hasMore, totalItems: result.totalItems };
    } else if (catalogId === 'simkl.trending.shows') {
      const interval: 'today' | 'week' | 'month' = (genre && ['today', 'week', 'month'].includes(genre.toLowerCase()) 
        ? genre.toLowerCase() as 'today' | 'week' | 'month'
        : (catalogConfig?.metadata?.interval as 'today' | 'week' | 'month')) || 'today';
      logger.debug(`[Simkl] Fetching trending shows (interval: ${interval}, pageSize: ${pageSize})`);
      const result = await fetchSimklTrendingItems('shows', interval, page, pageSize, catalogConfig?.cacheTTL);
      const items = (result.items as any[]).filter((it: any) => {
        const ids = it.ids || {};
        const ok = !!(ids.imdb || ids.tmdb || ids.tvdb || ids.mal || ids.simkl || ids.simkl_id);
        if (!ok) logger.debug(`[Simkl] Skipping trending item with only simkl ID: ${JSON.stringify(it)}`);
        return ok;
      });
      response = { items, hasMore: result.hasMore, totalItems: result.totalItems };
    } else if (catalogId === 'simkl.trending.anime') {
      const interval: 'today' | 'week' | 'month' = (genre && ['today', 'week', 'month'].includes(genre.toLowerCase()) 
        ? genre.toLowerCase() as 'today' | 'week' | 'month'
        : (catalogConfig?.metadata?.interval as 'today' | 'week' | 'month')) || 'today';
      logger.debug(`[Simkl] Fetching trending anime (interval: ${interval}, pageSize: ${pageSize})`);
      const result = await fetchSimklTrendingItems('anime', interval, page, pageSize, catalogConfig?.cacheTTL);
      const items = (result.items as any[]).filter((it: any) => {
        const ids = it.ids || {};
        const ok = !!(ids.imdb || ids.tmdb || ids.tvdb || ids.mal || ids.anilist || ids.kitsu || ids.anidb || ids.simkl || ids.simkl_id);
        if (!ok) logger.debug(`[Simkl] Skipping trending anime item with only simkl ID: ${JSON.stringify(it)}`);
        return ok;
      });
      response = { items, hasMore: result.hasMore, totalItems: result.totalItems };
    } else if (catalogId === 'simkl.dvd.movies') {
      logger.debug(`[Simkl] Fetching latest DVD movie releases (pageSize: ${pageSize})`);
      const result = await fetchSimklDvdReleases(page, pageSize, catalogConfig?.cacheTTL);
      const items = (result.items as any[]).filter((it: any) => {
        const ids = it.ids || {};
        const ok = !!(ids.imdb || ids.tmdb || ids.tvdb || ids.simkl || ids.simkl_id);
        if (!ok) logger.debug(`[Simkl] Skipping DVD release item with only simkl ID: ${it.title || 'Unknown'}`);
        return ok;
      });
      response = { items, hasMore: result.hasMore, totalItems: result.totalItems };
    } else if (catalogId.startsWith('simkl.calendar')) {
      // Simkl Calendar - Shows airing soon
      const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE || '20');
      
      // Get timezone from config or default to UTC
      const timezone = config.timezone || process.env.TZ || 'UTC';
      
      // Get configured days (1-7), default to 1 if not set
      const days = catalogConfig?.metadata?.airingSoonDays || 1;
      const clampedDays = Math.max(1, Math.min(7, days));
      
      // Determine type
      let calendarType: 'all' | 'anime' | 'series' = 'all';
      if (catalogId === 'simkl.calendar.anime') {
        calendarType = 'anime';
      } else if (catalogId === 'simkl.calendar.series') {
        calendarType = 'series';
      }
      
      logger.debug(`[Simkl] Fetching calendar items (type: ${calendarType}, days: ${clampedDays}, timezone: ${timezone}, page: ${page})`);
      
      // Fetch calendar items (fetches all items for the period)
      const result = await fetchSimklCalendarItems(clampedDays, timezone, catalogConfig?.cacheTTL, calendarType);
      
      // Filter out items with no IDs before pagination
      const validItems = result.items.filter((it: any) => {
        const ids = it.ids || {};
        const ok = !!(ids.imdb || ids.tmdb || ids.tvdb || ids.mal || ids.simkl || ids.simkl_id);
        if (!ok) logger.debug(`[Simkl] Skipping calendar item with only simkl ID: ${it.title || 'Unknown'}`);
        return ok;
      });
      
      // Local pagination
      const globalItemIndex = (page - 1) * pageSize;
      const endIndex = globalItemIndex + pageSize;
      const paginatedItems = validItems.slice(globalItemIndex, endIndex);
      const hasMore = endIndex < validItems.length;
      
      logger.debug(`[Simkl] Local pagination: ${validItems.length} total valid items, showing ${globalItemIndex}-${Math.min(endIndex, validItems.length)} (hasMore: ${hasMore})`);
      
      response = { items: paginatedItems, hasMore };
    } 
    else if (catalogId.startsWith('simkl.watchlist.')) {
      const parts = catalogId.split('.');
      if (parts.length === 4) {
        const watchlistType = parts[2] as 'movies' | 'shows' | 'anime';
        const status = parts[3] as 'watching' | 'plantowatch' | 'hold' | 'completed' | 'dropped';
        
        const tokenId = (config.apiKeys as any)?.simklTokenId;
        if (!tokenId) {
          logger.error(`[Simkl] No Simkl token ID found for watchlist catalog`);
          return [];
        }
        
        const token = await getSimklToken(tokenId);
        const accessToken = token?.access_token;
        if (!accessToken) {
          logger.error(`[Simkl] Failed to get Simkl access token for watchlist catalog`);
          return [];
        }
        
        logger.debug(`[Simkl] Fetching watchlist ${watchlistType}/${status} (all items, local pagination)`);
        const cacheTTL = catalogConfig?.cacheTTL || (60 * 60); // Default 1 hour if not specified
        
        // Fetch all items at once (Simkl doesn't support pagination)
        const result = await fetchSimklWatchlistItems(accessToken, watchlistType, status, cacheTTL);
        
        // Filter and map items
        let allItems = result.items
          .map((item: any) => {
            const media = item.show || item.movie || item;
            const ids = media.ids || {};
            
            const hasValidId = watchlistType === 'anime'
              ? !!(ids.imdb || ids.tmdb || ids.tvdb || ids.mal || ids.anilist || ids.kitsu || ids.anidb || ids.simkl || ids.simkl_id)
              : !!(ids.imdb || ids.tmdb || ids.tvdb || ids.mal || ids.simkl || ids.simkl_id);
            if (!hasValidId) {
              logger.debug(`[Simkl] Skipping watchlist item with only simkl ID: ${media.title || 'Unknown'}`);
              return null;
            }
            let itemType: 'movie' | 'series';
            if (watchlistType === 'anime' && item.anime_type) {
              itemType = (item.anime_type === 'movie' || item.anime_type === 'ona') ? 'movie' : 'series';
            } else {
              itemType = watchlistType === 'movies' ? 'movie' : 'series';
            }
            
            return {
              type: itemType,
              ...media,
              simkl_status: item.status,
              simkl_rating: item.user_rating,
              simkl_last_watched: item.last_watched,
              simkl_next_to_watch: item.next_to_watch,
              simkl_watched_episodes_count: item.watched_episodes_count,
              simkl_total_episodes_count: item.total_episodes_count,
              simkl_not_aired_episodes_count: item.not_aired_episodes_count
            };
          })
          .filter((item: any) => item !== null); // Remove null items

        if (status === 'watching' && (watchlistType === 'shows' || watchlistType === 'anime')) {
          const beforeCount = allItems.length;
          allItems = allItems.filter((item: any) => {
            if (item.simkl_next_to_watch) return true;

            const watched = item.simkl_watched_episodes_count;
            const total = item.simkl_total_episodes_count;
            const notAired = item.simkl_not_aired_episodes_count || 0;
            if (typeof watched === 'number' && typeof total === 'number') {
              const availableEpisodes = total - notAired;
              return watched < availableEpisodes;
            }

            // If we can't determine, keep the item
            return true;
          });
          if (beforeCount !== allItems.length) {
            logger.debug(`[Simkl] Filtered ${beforeCount - allItems.length} fully caught-up shows from watching list (${allItems.length} remaining with unwatched episodes)`);
          }
        }
        
        const globalItemIndex = (page - 1) * pageSize;
        const endIndex = globalItemIndex + pageSize;
        const paginatedItems = allItems.slice(globalItemIndex, endIndex);
        const hasMore = endIndex < allItems.length;
        
        logger.debug(`[Simkl] Local pagination: ${allItems.length} total items, showing ${globalItemIndex}-${Math.min(endIndex, allItems.length)} (hasMore: ${hasMore})`);
        
        response = { items: paginatedItems, hasMore };
      } else {
        logger.warn(`[Simkl] Invalid watchlist catalog ID format: ${catalogId}`);
        return [];
      }
    } else {
      logger.warn(`[Simkl] Unknown catalog ID: ${catalogId}`);
      return [];
    }
    
    // Early exit for empty pages
    if (!response.hasMore && response.items.length === 0) {
      logger.debug(`[Simkl] No more items at page ${page}`);
      return [];
    }
    
    const isAnimeCatalog = catalogId === 'simkl.trending.anime'
      || catalogId.startsWith('simkl.watchlist.anime.')
      || catalogId === 'simkl.calendar'
      || catalogId === 'simkl.calendar.anime'
      || catalogId.startsWith('simkl.discover.anime.');
    const parseStart = Date.now();
    let metas = await parseSimklItems(response.items, type as 'movie' | 'series', config, userUUID, includeVideos, isAnimeCatalog);
    const parseTime = Date.now() - parseStart;
    logger.info(`[Simkl] parseSimklItems took ${parseTime}ms for ${response.items.length} items`);
    
    // Apply age rating filter
    metas = applyAgeRatingFilter(metas, type, config);
    
    logger.success(`[Simkl] Processed ${metas.length} items for catalog ${catalogId} (page ${page})`);
    return metas;
    
  } catch (err: any) {
    const errorLine = err.stack?.split('\n')[1]?.trim() || 'unknown';
    logger.error(`[Simkl] Error processing catalog ${catalogId}: ${err.message}`);
    logger.error(`Error at: ${errorLine}`);
    logger.error(`Full stack trace:`, err.stack);
    return [];
  }
}

export { getCatalog };
