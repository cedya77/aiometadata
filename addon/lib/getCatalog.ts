require("dotenv").config();
import { getGenreList } from "./getGenreList.js";
import { getLanguages } from "./getLanguages.js";
const consola = require('consola');

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
  tag: 'Catalog'
});
import { fetchMDBListItems, parseMDBListItems, fetchMDBListBatchMediaInfo } from "../utils/mdbList.js";
import { fetchStremThruCatalog, parseStremThruItems } from "../utils/stremthru.js";
import * as CATALOG_TYPES from "../static/catalog-types.json";
import * as moviedb from "./getTmdb.js";
import * as tvdb from './tvdb.js';
import { to3LetterCode, to3LetterCountryCode } from './language-map.js';
import { resolveAllIds } from './id-resolver.js';
import { cacheWrapTvdbApi } from './getCache.js';
import { getTVDBContentRatingId } from '../utils/tvdbContentRating.js';
import { getMeta } from './getMeta.js';
import { cacheWrapMetaSmart } from './getCache.js';
import { UserConfig } from '../types/index.js';
import { isReleasedDigitally } from "../utils/parseProps.js";

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
const TVDB_IMAGE_BASE = 'https://artworks.thetvdb.com';

const host = process.env.HOST_NAME?.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;


async function getCatalog(type: string, language: string, page: number, id: string, genre: string, config: UserConfig, userUUID: string): Promise<{ metas: any[] }> {
  try {
    if (id === 'tvdb.collections') {
      logger.info(`Fetching TVDB collections catalog: ${id}`);
      const metas = await getTvdbCollectionsCatalog(type, id, page, language, config);
      return { metas: metas };
    }
    if (id.startsWith('tvdb.') && !id.startsWith('tvdb.collection.')) {
      logger.info(`Routing to TVDB catalog handler for id: ${id}`);
      const tvdbResults = await getTvdbCatalog(type, id, genre, page, language, config, id === 'tvdb.trending');
      return { metas: tvdbResults };
    } 
    else if (id.startsWith('tmdb.') || id.startsWith('mdblist.') || id.startsWith('streaming.')) {
      logger.info(`Routing to TMDB/MDBList catalog handler for id: ${id}`);
      const tmdbResults = await getTmdbAndMdbListCatalog(type, id, genre, page, language, config, userUUID);
      return { metas: tmdbResults };
    }
    else if (id.startsWith('stremthru.')) {
      logger.info(`Routing to StremThru catalog handler for id: ${id}`);
      const stremthruResults = await getStremThruCatalog(type, id, genre, page, language, config, userUUID);
      return { metas: stremthruResults };
    }
    else if (id.startsWith('custom.')) {
      logger.info(`Routing to Custom Manifest catalog handler for id: ${id}`);
      const customResults = await getStremThruCatalog(type, id, genre, page, language, config, userUUID);
      return { metas: customResults };
    }

    else {
      logger.warn(`Received request for unknown catalog prefix: ${id}`);
      return { metas: [] };
    }
  } catch (error: any) {
    logger.error(`Error in getCatalog router for id=${id}, type=${type}:`, error.message);
    return { metas: [] };
  }
}

async function getTvdbCatalog(type: string, catalogId: string, genreName: string, page: number, language: string, config: UserConfig, isTrending: boolean): Promise<any[]> {
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
  const sortedResults = results.sort((a, b) => b.score - a.score);
  
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
  const metas = await Promise.all(paginatedResults.map(async item => {
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
      return await getMeta(type, language, stremioId, config, config.userUUID, false);
    }, undefined, {enableErrorCaching: true, maxRetries: 2}, type as any);
    
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

async function getTmdbAndMdbListCatalog(type: string, id: string, genre: string, page: number, language: string, config: UserConfig, userUUID: string): Promise<any[]> {
  if (id.startsWith("mdblist.")) {
    logger.info(`Fetching MDBList catalog: ${id}, Genre: ${genre}, Page: ${page}`);
    const listId = id.split(".")[1];
    const catalogConfig = config.catalogs?.find(c => c.id === id);
    const sort = catalogConfig?.sort === 'default' ? undefined : catalogConfig?.sort;
    const order = catalogConfig?.sort === 'default' ? undefined : catalogConfig?.order;
    logger.debug(`MDBList sorting - sort: ${sort}, order: ${order}`);
    const response = await fetchMDBListItems(listId, config.apiKeys?.mdblist || process.env.MDBLIST_API_KEY || '', language, page, sort, order, genre);
    
    // Smart pagination handling
    if (response.totalItems !== undefined && response.totalPages !== undefined) {
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
    
    let metas = await parseMDBListItems(response.items, type, language, config);
    
    // Apply digital release filter if enabled (movies only)
    if (type === 'movie' && config.hideUnreleasedDigital) {
      const beforeCount = metas.length;
      metas = metas.filter(meta => isReleasedDigitally(meta));
      const afterCount = metas.length;
      if (beforeCount !== afterCount) {
        logger.info(`Digital release filter (MDBList): filtered out ${beforeCount - afterCount} unreleased movies`);
      }
    }
    
    return metas;
  }

  const genreList = await getGenreList('tmdb', language, type as "movie" | "series", config);
  const parameters = await buildParameters(type, language, page, id, genre, genreList, config);

  const fetchFunction = type === "movie" 
    ? () => moviedb.discoverMovie(parameters, config) 
    : () => moviedb.discoverTv(parameters, config);

  const res: any = await fetchFunction();
  // define preferred provider as string
  
  //sort res.results by vote count in descending order
  res.results.sort((a, b) => new Date(b.release_date).getTime() - new Date(a.release_date).getTime());
  const metas = await Promise.all(res.results.map(async item => {
    let stremioId = `tmdb:${item.id}`;
    
    const result = await cacheWrapMetaSmart(userUUID, stremioId, async () => {
      return await getMeta(type, language, stremioId, config, userUUID, false);
    }, undefined, {enableErrorCaching: true, maxRetries: 2}, type as any);
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
  const provider = CATALOG_TYPES.streaming[providerId];
  if (!provider) throw new Error(`Could not find provider: ${providerId}`);
  return provider;
}

async function getStremThruCatalog(type: string, catalogId: string, genre: string, page: number, language: string, config: UserConfig, userUUID: string): Promise<any[]> {
  try {
    logger.info(`[✨ StremThru] Processing catalog request: ${catalogId}, type: ${type}, genre: ${genre || 'none'}, page: ${page}`);
    
    // Find the user catalog configuration to get the source URL
    const userCatalog = config.catalogs?.find(c => c.id === catalogId);
    if (!userCatalog || (!userCatalog.sourceUrl && !userCatalog.source)) {
      logger.error(`[✨ StremThru] No source URL found for catalog: ${catalogId}`);
      return [];
    }
    
    // Use sourceUrl for StremThru catalogs, fallback to source for backward compatibility
    const catalogUrl = userCatalog.sourceUrl || userCatalog.source;
    // sparkle emoji
    logger.debug(`[✨ StremThru] Using catalog URL: ${catalogUrl}`);
    
    // Calculate StremThru pagination (skip in multiples of 100, client-side paginate to 20)
    const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE || '20');
    const stremThruBatchSize = 100;
    
    // Determine which 100-item batch we need from StremThru
    const globalItemIndex = (page - 1) * pageSize; // 0-based index of first item on this page
    const stremThruSkip = Math.floor(globalItemIndex / stremThruBatchSize) * stremThruBatchSize;
    
    // Fetch the 100-item batch from StremThru with server-side genre filtering
    let items = await fetchStremThruCatalog(catalogUrl, stremThruSkip, genre);
    
    // Fallback: if we get empty results with skip > 0, try skip=0 (for small genre lists)
    if ((!items || items.length === 0) && stremThruSkip > 0) {
      logger.debug(`[✨ StremThru] Empty results with skip=${stremThruSkip}, falling back to skip=0`);
      items = await fetchStremThruCatalog(catalogUrl, 0, genre);
    }
    
    if (!items || items.length === 0) {
      logger.warn(`[StremThru] No items returned from catalog: ${catalogUrl} (page: ${page}, genre: ${genre || 'all'})`);
      return [];
    }
    
    // No client-side filtering needed - StremThru handles genre filtering server-side
    const filteredItems = items;
    
    // Client-side pagination within the fetched batch
    let localStartIndex, localEndIndex;
    
    if (stremThruSkip === 0 && filteredItems.length < stremThruBatchSize) {
      // Fallback case: we got all results from skip=0, paginate through entire list
      localStartIndex = globalItemIndex;
      localEndIndex = Math.min(globalItemIndex + pageSize, filteredItems.length);
      // If we're beyond available items, return empty
      if (localStartIndex >= filteredItems.length) {
        localStartIndex = 0;
        localEndIndex = 0;
      }
    } else {
      // Normal case: paginate within the 100-item batch
      localStartIndex = globalItemIndex % stremThruBatchSize;
      localEndIndex = Math.min(localStartIndex + pageSize, filteredItems.length);
    }
    
    let paginatedItems = filteredItems.slice(localStartIndex, localEndIndex);
    
    // Handle case where page spans across batch boundaries (skip normal batch boundaries in fallback case)
    if (paginatedItems.length < pageSize && localStartIndex + pageSize > stremThruBatchSize && !(stremThruSkip === 0 && filteredItems.length < stremThruBatchSize)) {
      // Need to fetch next batch to complete the page
      const nextStremThruSkip = stremThruSkip + stremThruBatchSize;
      const nextItems = await fetchStremThruCatalog(catalogUrl, nextStremThruSkip, genre);
      
      if (nextItems && nextItems.length > 0) {
        // No client-side filtering needed - StremThru handles genre filtering server-side
        const nextFilteredItems = nextItems;
        
        const remainingItemsNeeded = pageSize - paginatedItems.length;
        const nextBatchItems = nextFilteredItems.slice(0, remainingItemsNeeded);
        paginatedItems = [...paginatedItems, ...nextBatchItems];
        
        logger.debug(`[✨ StremThru] Fetched additional ${nextBatchItems.length} items from next batch (skip: ${nextStremThruSkip}, genre: ${genre || 'all'})`);
      }
    }
    
    logger.debug(`[✨ StremThru] Batch skip: ${stremThruSkip}, local slice: ${localStartIndex}-${localEndIndex}, final items: ${paginatedItems.length}`);
    
    // Parse items into Stremio format
    let metas = await parseStremThruItems(paginatedItems, type, genre, language, config);
    
    // Apply digital release filter if enabled (movies only)
    if (type === 'movie' && config.hideUnreleasedDigital) {
      const beforeCount = metas.length;
      metas = metas.filter(meta => isReleasedDigitally(meta));
      const afterCount = metas.length;
      if (beforeCount !== afterCount) {
        logger.info(`Digital release filter (StremThru): filtered out ${beforeCount - afterCount} unreleased movies`);
      }
    }
    
    logger.success(`[StremThru] Successfully processed ${metas.length} items for catalog: ${catalogId} (page: ${page})`);
    return metas;
    
  } catch (error: any) {
    logger.error(`[StremThru] Error processing catalog ${catalogId}:`, error.message);
    return [];
  }
}

export { getCatalog };
