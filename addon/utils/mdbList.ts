import { httpGet, httpPost } from "./httpClient.js";
import { resolveAllIds } from "../lib/id-resolver.js";
import { getMeta } from "../lib/getMeta.js";
import { cacheWrapMetaSmart, cacheWrapMDBListGenres } from "../lib/getCache.js";
import { UserConfig } from "../types/index.js";
const consola = require('consola');
const { socksDispatcher } = require('fetch-socks');
const { Agent, ProxyAgent } = require('undici');

const logger = consola.withTag('MDBList');

/**
 * Sanitize URL by removing API key for safe logging
 * @param {string} url - URL that may contain an API key
 * @returns {string} - Sanitized URL with API key replaced by [REDACTED]
 */
function sanitizeUrlForLogging(url: string): string {
  // Replace API key in query string with [REDACTED]
  return url.replace(/([?&]apikey=)[^&]+/gi, '$1[REDACTED]');
}


// MDBList dispatcher configuration
// Priority: MDBLIST_SOCKS_PROXY_URL > HTTPS_PROXY/HTTP_PROXY > direct connection
const MDBLIST_SOCKS_PROXY_URL = process.env.MDBLIST_SOCKS_PROXY_URL;
const HTTP_PROXY_URL = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
let mdblistDispatcher: any;

if (MDBLIST_SOCKS_PROXY_URL) {
  try {
    const proxyUrlObj = new URL(MDBLIST_SOCKS_PROXY_URL);
    if (proxyUrlObj.protocol === 'socks5:' || proxyUrlObj.protocol === 'socks4:') {
      mdblistDispatcher = socksDispatcher({
        type: proxyUrlObj.protocol === 'socks5:' ? 5 : 4,
        host: proxyUrlObj.hostname,
        port: parseInt(proxyUrlObj.port),
        userId: proxyUrlObj.username,
        password: proxyUrlObj.password,
      });
      logger.info(`[MDBList] SOCKS proxy is enabled for MDBList API via fetch-socks.`);
    } else {
      logger.error(`[MDBList] Unsupported proxy protocol: ${proxyUrlObj.protocol}. Falling back.`);
      mdblistDispatcher = null; // Will be set below
    }
  } catch (error: any) {
    logger.error(`[MDBList] Invalid MDBLIST_SOCKS_PROXY_URL. Falling back. Error: ${error.message}`);
    mdblistDispatcher = null; // Will be set below
  }
}

// Fallback to HTTP proxy or direct connection
if (!mdblistDispatcher) {
  if (HTTP_PROXY_URL) {
    try {
      // ProxyAgent may need to be imported if not already
      const { ProxyAgent } = require('undici');
      mdblistDispatcher = new ProxyAgent({ uri: new URL(HTTP_PROXY_URL).toString() });
      logger.info('[MDBList] Using global HTTP proxy.');
    } catch (error: any) {
      logger.error(`[MDBList] Invalid HTTP_PROXY URL. Using direct connection. Error: ${error.message}`);
      mdblistDispatcher = new Agent({ connect: { timeout: 30000 } });
    }
  } else {
    mdblistDispatcher = new Agent({ connect: { timeout: 30000 } });
    logger.info('[MDBList] undici agent is enabled for direct connections.');
  }
}

/**
 * Checks if an error is a "permanent" client-side error that should not be retried.
 */
function isPermanentError(error: any): boolean {
  const status = error.response?.status;
  // Consider 4xx errors (except 429 rate limit) as permanent.
  return status >= 400 && status < 500 && status !== 429;
}

const host = process.env.HOST_NAME?.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;

// Rate limiting configuration for MDBList API
const RATE_LIMIT_CONFIG = {
  maxRetries: 5,
  baseDelay: 1000, // 1 second base delay
  maxDelay: 30000, // 30 seconds max delay
  rateLimitDelay: 5000, // 5 seconds for rate limit backoff
  minInterval: 200, // Minimum 200ms between requests
  backoffMultiplier: 2
};

// Rate limiting state
let rateLimitState = {
  lastRequestTime: 0,
  recentRateLimitHits: 0,
  lastRateLimitTime: 0,
  isRateLimited: false,
  rateLimitResetTime: 0,
  lastLimit: undefined as number | undefined,
  lastRemaining: undefined as number | undefined,
  lastReset: undefined as number | undefined
};

/**
 * Sleep function for delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if error is a rate limit error
 */
function isRateLimitError(error: any): boolean {
  return error.response?.status === 429 || error.response?.status === 503;
}

/**
 * Rate limiting and retry logic for MDBList API calls
 */
async function makeRateLimitedRequest<T>(
  requestFn: () => Promise<T>, 
  context: string = 'MDBList', 
  retries: number = RATE_LIMIT_CONFIG.maxRetries
): Promise<T> {
  let attempt = 0;
  
  while (attempt < retries) {
    attempt++;
    const isLastAttempt = attempt === retries;

    const now = Date.now();
    
    // Check if we're in a global cooldown period from a previous rate limit hit.
    if (rateLimitState.isRateLimited && rateLimitState.rateLimitResetTime > now) {
      const waitTime = rateLimitState.rateLimitResetTime - now;
      logger.debug(`Global rate limit cooldown active, waiting ${waitTime}ms - ${context}`);
      await sleep(waitTime);
    }
    rateLimitState.isRateLimited = false; // Cooldown is over

    // Enforce minimum interval between every single request attempt.
    const timeSinceLastRequest = now - rateLimitState.lastRequestTime;
    if (timeSinceLastRequest < RATE_LIMIT_CONFIG.minInterval) {
      const waitTime = RATE_LIMIT_CONFIG.minInterval - timeSinceLastRequest;
      await sleep(waitTime);
    }
    
    rateLimitState.lastRequestTime = Date.now();
    const startTime = Date.now();
    
    try {
      const response = await requestFn();
      const responseTime = Date.now() - startTime;
      const requestTracker = require('../lib/requestTracker.js');
      requestTracker.trackProviderCall('mdblist', responseTime, true);

      // --- MDBList Rate Limit Header Logging ---
      // Type guard for headers property
      const headers = (response && typeof response === 'object' && 'headers' in response && response.headers && typeof response.headers === 'object') ? response.headers as Record<string, string> : undefined;
      if (headers) {
        const limit = headers['x-ratelimit-limit'];
        const remaining = headers['x-ratelimit-remaining'];
        const reset = headers['x-ratelimit-reset'];
        logger.debug(`[MDBList] Rate limit: limit=${limit}, remaining=${remaining}, reset=${reset}`);
        // Optionally update state for diagnostics
        rateLimitState.lastLimit = limit ? parseInt(limit) : undefined;
        rateLimitState.lastRemaining = remaining ? parseInt(remaining) : undefined;
        rateLimitState.lastReset = reset ? parseInt(reset) : undefined;
      }

      // Reset recent hits on success
      rateLimitState.recentRateLimitHits = 0;
      return response;
    } catch (error: any) {
      const responseTime = Date.now() - startTime;
      const requestTracker = require('../lib/requestTracker.js');
      requestTracker.trackProviderCall('mdblist', responseTime, false);

      if (isPermanentError(error)) {
        logger.error(`Request failed with permanent error, no retry: ${error.message} - ${context}`);
        requestTracker.logError('error', `MDBList API permanent error`, { /* ... */ });
        throw error;
      }
      
      if (isRateLimitError(error)) {
        rateLimitState.lastRateLimitTime = Date.now();
        rateLimitState.recentRateLimitHits++;

        // --- MDBList Rate Limit Header Logging on Error ---
        const headers = (error.response && typeof error.response === 'object' && 'headers' in error.response && error.response.headers && typeof error.response.headers === 'object') ? error.response.headers as Record<string, string> : {};
        const limit = headers['x-ratelimit-limit'];
        const remaining = headers['x-ratelimit-remaining'];
        const reset = headers['x-ratelimit-reset'];
        const retryAfter = headers['retry-after'];
        logger.warn(`[MDBList] Rate limit error: limit=${limit}, remaining=${remaining}, reset=${reset}, retry-after=${retryAfter}`);
        rateLimitState.lastLimit = limit ? parseInt(limit) : undefined;
        rateLimitState.lastRemaining = remaining ? parseInt(remaining) : undefined;
        rateLimitState.lastReset = reset ? parseInt(reset) : undefined;

        if (isLastAttempt) {
          logger.error(`Rate limit exceeded after ${retries} attempts: ${error.message} - ${context}`);
          throw error;
        }

        // Prefer Retry-After header if present, otherwise exponential backoff
        let backoffTime = 0;
        if (retryAfter) {
          const retrySeconds = parseInt(retryAfter);
          if (!isNaN(retrySeconds)) {
            backoffTime = retrySeconds * 1000;
          }
        }
        if (!backoffTime) {
          backoffTime = RATE_LIMIT_CONFIG.rateLimitDelay * Math.pow(2, rateLimitState.recentRateLimitHits - 1);
          const jitter = Math.random() * 1000;
          backoffTime = Math.min(backoffTime + jitter, RATE_LIMIT_CONFIG.maxDelay);
        }

        logger.warn(`Rate limit hit. Retrying in ${Math.round(backoffTime)}ms (attempt ${attempt}/${retries}) - ${context}`);

        // Set a global cooldown period for all subsequent requests.
        rateLimitState.isRateLimited = true;
        rateLimitState.rateLimitResetTime = Date.now() + backoffTime;

        await sleep(backoffTime);
        continue; // Go to the next attempt
      }
      
      // Handle other temporary errors (e.g., 500, timeouts)
      if (isLastAttempt) {
        logger.error(`Request failed after ${retries} attempts: ${error.message} - ${context}`);
        throw error;
      }
      
      const delay = Math.min(
        RATE_LIMIT_CONFIG.baseDelay * Math.pow(RATE_LIMIT_CONFIG.backoffMultiplier, attempt - 1),
        RATE_LIMIT_CONFIG.maxDelay
      );
      
      logger.debug(`Attempt ${attempt} failed with temporary error, retrying in ${delay}ms - ${context}`);
      await sleep(delay);
    }
  }
  
  throw new Error(`[${context}] All ${retries} attempts failed.`);
}

async function fetchMDBListItems(listId: string, apiKey: string, language: string, page: number, sort?: string, order?: string, genre?: string, unified?: boolean, catalogType?: string): Promise<{items: any[], totalItems?: number, hasMore?: boolean, totalPages?: number}> {
  // Use configurable page size (supports CATALOG_LIST_ITEMS_SIZE env var)
  const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20;
  const offset = (page * pageSize) - pageSize;
  
  try {
    let url: string;
    
    // Special handling for watchlist
    if (listId === 'watchlist') {
      url = `https://api.mdblist.com/watchlist/items?language=${language}&limit=${pageSize}&offset=${offset}&apikey=${apiKey}&append_to_response=genre,poster&unified=${unified !== false}`;
    } else {
      url = `https://api.mdblist.com/lists/${listId}/items?language=${language}&limit=${pageSize}&offset=${offset}&apikey=${apiKey}&append_to_response=genre,poster&unified=${unified !== false}`;
    }
    
    // Add sort and order parameters if provided and not empty
    if (sort && sort.trim() !== '') {
      url += `&sort=${sort}`;
    }
    if (order && order.trim() !== '') {
      url += `&order=${order}`;
    }
    if (genre && genre.toLowerCase() !== 'none') {
      url += `&filter_genre=${genre}`;
    }
    
    // Log the final URL for debugging (with API key sanitized)
    logger.debug(`MDBList request URL: ${sanitizeUrlForLogging(url)}`);
    
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, { dispatcher: mdblistDispatcher }),
      `MDBList fetchMDBListItems (listId: ${listId}, page: ${page}, pageSize: ${pageSize}, sort: ${sort}, order: ${order}, genre: ${genre})`
    );
    
    // Extract pagination metadata from headers
    let totalItems = response.headers?.['x-total-items'] ? parseInt(response.headers['x-total-items']) : undefined;
    const hasMore = response.headers?.['x-has-more'] === 'true';
    
    // For watchlist, we can only rely on X-Has-More header
    let totalPages: number | undefined;
    if (listId === 'watchlist') {
      totalItems = undefined; // Watchlist doesn't provide total items
      totalPages = undefined; // Can't calculate pages without total items
    } else {
      // Calculate total pages from headers for regular lists
      totalPages = totalItems ? Math.ceil(totalItems / pageSize) : undefined;
    }
    
    let items: any[];
    
    // Handle different response formats based on unified parameter
    if (listId === 'watchlist' && unified === false) {
      // Non-unified format: response has separate movies and shows arrays
      // Extract the appropriate array based on catalog type
      if (catalogType === 'series') {
        items = response.data.shows || [];
      } else {
        items = response.data.movies || [];
      }
    } else {
      if (Array.isArray(response.data)) {
        items = response.data;
      } else {
        items = [
          ...(response.data?.movies || []),
          ...(response.data?.shows || [])
        ];
      }
    }
    
    // Smart pagination validation and logging
    if (listId === 'watchlist') {
      logger.debug(`Watchlist pagination - page: ${page}, items: ${items.length}, hasMore: ${hasMore}`);
    } else if (totalItems !== undefined) {
      if (offset >= totalItems) {
        logger.warn(`Requested offset ${offset} exceeds total items ${totalItems} for list ${listId}`);
        return { 
          items: [], 
          totalItems, 
          hasMore: false, 
          totalPages 
        };
      }
      
      // Enhanced logging with pagination context
      const itemsReturned = items.length;
      const expectedItems = Math.min(pageSize, totalItems - offset);
      
      logger.debug(`Smart pagination - listId: ${listId}, page: ${page}/${totalPages}, items: ${itemsReturned}/${expectedItems}, offset: ${offset}, totalItems: ${totalItems}, hasMore: ${hasMore}${genre && genre.toLowerCase() !== 'none' ? ` (filtered by: ${genre})` : ''}`);
      
      // Validate response consistency (but skip when genre filter is active as totalItems is unfiltered count)
      const isFiltered = genre && genre.toLowerCase() !== 'none';
      if (!hasMore && itemsReturned > 0 && offset + itemsReturned < totalItems && !isFiltered) {
        logger.warn(`Inconsistent pagination: hasMore=false but ${offset + itemsReturned} < ${totalItems}`);
      }
      
      // Early exit detection
      if (!hasMore && itemsReturned === 0) {
        logger.info(`Reached end of list at page ${page} (no items returned)`);
      }
    } else {
      logger.debug(`No pagination headers - listId: ${listId}, page: ${page}, items: ${items.length}, hasMore: ${hasMore}`);
    }
    
    return {
      items,
      totalItems,
      hasMore,
      totalPages
    };
  } catch (err: any) {
    logger.error(`Error retrieving items for list ${listId}, page ${page}:`, err.message);
    return { items: [] };
  }
}


// get media rating from MDBList
/**
 * Fetches media rating from MDBList API for multiple IDs
 * @param {string} mediaProvider - The media provider . Possible values: tmdb, imdb, trakt, tvdb, mal
 * @param {string} mediaType - The media type . Possible values: movie, show, any
 * @param {string} id - ID to fetch rating for
 * @param {string} apiKey - MDBList API key
 * @returns {Promise<Array>} Array of media rating objects
 */
async function getMediaRatingFromMDBList(mediaProvider: string, mediaType: string, id: string, apiKey: string): Promise<any[]> {
  if (!apiKey || !id) {
    // This check is good, it prevents unnecessary API calls.
    logger.warn("Missing API key for getMediaRatingFromMDBList");
    return [];
  }

  const url = `https://api.mdblist.com/${mediaProvider}/${mediaType}/${id}?apikey=${apiKey}`;
  const context = `MDBList getMediaRatingFromMDBList (mediaProvider: ${mediaProvider}, mediaType: ${mediaType}, id: ${id})`;

  try {
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, { dispatcher: mdblistDispatcher }),
      context
    );
    return response.data?.ratings || [];
  } catch (error: any) {
    if (error.response?.status === 404) {
      logger.info(`Item not found on MDBList (404), returning empty ratings - ${context}`);
      return [];
    }
    
    logger.error(`An unexpected error occurred: ${error.message} - ${context}`);
    return [];
  }
}

/**
 * Fetches batch media info from MDBList API for multiple IDs
 * Automatically handles batching for requests exceeding 200 items
 * @param {string} mediaProvider - The media provider (tmdb, imdb, trakt, tvdb, mal)
 * @param {string} mediaType - The media type (movie, show, any)
 * @param {Array<string>} ids - Array of IDs to fetch info for
 * @param {string} apiKey - MDBList API key
 * @param {Array<string>} appendToResponse - Optional array of additional data to append
 * @returns {Promise<Array>} Array of media info objects
 */
async function fetchMDBListBatchMediaInfo(mediaProvider: string, mediaType: string, ids: string[], apiKey: string, appendToResponse: string[] = []): Promise<any[]> {
  if (!ids || ids.length === 0 || !apiKey) {
    logger.warn("Missing required parameters for batch media info");
    return [];
  }

  const BATCH_SIZE = 200;
  const allResults: any[] = [];

  // Split IDs into batches of 200
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batchIds = ids.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(ids.length / BATCH_SIZE);

    logger.debug(`Processing batch ${batchNumber}/${totalBatches} with ${batchIds.length} items`);

    try {
      const url = `https://api.mdblist.com/${mediaProvider}/${mediaType}?apikey=${apiKey}`;
      
      const requestBody = {
        ids: batchIds,
        append_to_response: appendToResponse
      };

      const response: any = await makeRateLimitedRequest(
        () => httpPost(url, requestBody, {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: 30000, // 30 second timeout for batch requests
          dispatcher: mdblistDispatcher
        }),
        `MDBList batch media info (batch ${batchNumber}/${totalBatches})`
      );

      if (response.data && Array.isArray(response.data)) {
        logger.debug(`Batch ${batchNumber}/${totalBatches} successful: ${response.data.length} items`);
        allResults.push(...response.data);
      } else {
        logger.warn(`Batch ${batchNumber}/${totalBatches} unexpected response format:`, response.data);
      }

    } catch (error: any) {
      logger.error(`Error in batch ${batchNumber}/${totalBatches}:`, error.message);
      if (error.response) {
        logger.error(`Response status: ${error.response.status}`);
        logger.error(`Response data:`, error.response.data);
      }
      // Continue with next batch even if this one fails
    }

    // Add a delay between batches to be respectful to the API
    if (i + BATCH_SIZE < ids.length) {
      await sleep(500); // Increased from 100ms to 500ms for better rate limiting
    }
  }

  logger.info(`Completed all batches. Total items fetched: ${allResults.length}`);
  return allResults;
}

async function getGenresFromMDBList(listId: string, apiKey: string): Promise<string[]> {
  try {
    return await cacheWrapMDBListGenres(listId, async () => {
      logger.debug(`Fetching fresh genres from MDBList for list ${listId}`);
      const response = await fetchMDBListItems(listId, apiKey, 'en-US', 1);
      const genres = [
        ...new Set(
          response.items.flatMap((item: any) =>
            (item.genre || []).map((g: any) => {
              if (!g || typeof g !== "string") return null;
              return g.charAt(0).toUpperCase() + g.slice(1).toLowerCase();
            })
          ).filter(Boolean)
        )
      ].sort();
      logger.info(`Successfully fetched and cached ${genres.length} genres for list ${listId}`);
      return genres;
    });
  } catch(err: any) {
    logger.error("Error in getGenresFromMDBList:", err);
    return [];
  }
}


async function fetchMDBListExternalItems(
  url: string,
  apiKey: string,
  language: string,
  page: number,
  sort?: string,
  order?: string,
  genre?: string,
  catalogType?: string,
  unified?: boolean,
  filterScoreMin?: number,
  filterScoreMax?: number
): Promise<{items: any[], totalItems?: number, hasMore?: boolean, totalPages?: number}> {
  const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20;
  const offset = (page * pageSize) - pageSize;

  try {
    const urlWithParams = new URL(url);
    urlWithParams.searchParams.set('apikey', apiKey);
    urlWithParams.searchParams.set('limit', pageSize.toString());
    urlWithParams.searchParams.set('offset', offset.toString());
    urlWithParams.searchParams.set('language', language);
    urlWithParams.searchParams.set('append_to_response', 'genre,poster');
    urlWithParams.searchParams.set('unified', String(unified));

    if (sort && sort.trim() !== '') {
      urlWithParams.searchParams.set('sort', sort);
    }
    if (order && order.trim() !== '') {
      urlWithParams.searchParams.set('order', order);
    }
    if (genre && genre.toLowerCase() !== 'none') {
      urlWithParams.searchParams.set('filter_genre', genre);
    }
    if (typeof filterScoreMin === 'number') {
      urlWithParams.searchParams.set('filter_score_min', String(filterScoreMin));
    }
    if (typeof filterScoreMax === 'number') {
      urlWithParams.searchParams.set('filter_score_max', String(filterScoreMax));
    }

    const fullUrl = urlWithParams.toString();

    logger.debug(`MDBList external request URL: ${sanitizeUrlForLogging(fullUrl)}`);

    const response: any = await makeRateLimitedRequest(
      () => httpGet(fullUrl, { dispatcher: mdblistDispatcher }),
      `MDBList fetchMDBListExternalItems (url: ${sanitizeUrlForLogging(url)}, page: ${page})`
    );

    const hasMore = response.headers?.['x-has-more'] === 'true';

    let items: any[];

    if (unified === false) {
      if (catalogType === 'series') {
        items = response.data.shows || [];
      } else {
        items = response.data.movies || [];
      }
    } else {
      if (Array.isArray(response.data)) {
        items = response.data;
      } else {
        items = [
          ...(response.data?.movies || []),
          ...(response.data?.shows || [])
        ];
      }
    }

    return { items, hasMore };
  } catch (err: any) {
    logger.error(`Error retrieving items from URL ${sanitizeUrlForLogging(url)}, page ${page}:`, err.message);
    return { items: [] };
  }
}

async function parseMDBListItems(items: any[], type: string, language: string, config: UserConfig, includeVideos: boolean = false): Promise<any[]> {
  let filteredItems = items;
  //console.log(`[MDBList] Filtered items: ${JSON.stringify(filteredItems)}`);

  //const batchMediaInfo = await fetchMDBListBatchMediaInfo('tmdb', targetMediaType, filteredItems.map(item => item.id), config.apiKeys?.mdblist || '');
  //console.log(`[MDBList] Batch media info: ${JSON.stringify(batchMediaInfo)}`);
  
  // Normalize IDs, falling back to imdb_id or tvdb_id when possible
  const normalizedItems = filteredItems.map((item: any) => {
    if (!item.id || item.id === null || item.id === undefined) {
      const fallbackId = item.imdb_id || item.tvdb_id;
      if (fallbackId) {
        const resolvedId = typeof fallbackId === 'string' ? fallbackId : String(fallbackId);
        return { ...item, id: resolvedId };
      }
    }
    return item;
  });

  const validItems = normalizedItems.filter((item: any) => {
    if (!item.id || item.id === null || item.id === undefined) {
      logger.warn(`Skipping MDBList item with invalid ID: ${JSON.stringify(item)}`);
      return false;
    }
    return true;
  });
 
  const metas = await Promise.all(validItems

    .map(async (item: any) => {
      try {
        let stremioId = `tmdb:${item.id}`;
        
        // Use getMeta with cacheWrapMetaSmart to get the full meta object with caching
        const result = await cacheWrapMetaSmart(config.userUUID, stremioId, async () => {
          const mdblistType = item.mediatype === 'movie' ? 'movie' : 'series';
          return await getMeta(mdblistType, language, stremioId, config, config.userUUID, includeVideos);
        }, undefined, {enableErrorCaching: true, maxRetries: 2}, type as any, includeVideos);
        
        if (result && result.meta) {
          return result.meta;
        }
        return null;
      } catch (error: any) {
        logger.error(`Error getting meta for item ${item.id}:`, error.message);
        return null;
      }
    }));

  return metas.filter(Boolean);
}

// Global genre mapping cache (title -> slug)
let genreTitleToSlugMap: Map<string, string> | null = null;

async function fetchMDBListGenres(apiKey: string, isAnime: boolean = false): Promise<string[]> {
  try {
    const cacheKey = `genres-${isAnime ? 'anime' : 'standard'}`;
    
    return await cacheWrapMDBListGenres(cacheKey, async () => {
      const animeParam = isAnime ? 1 : 0;
      const url = `https://api.mdblist.com/genres/?apikey=${apiKey}&anime=${animeParam}`;
      
      return await makeRateLimitedRequest(async () => {
        logger.debug(`Fetching MDBList genres from API (anime=${animeParam})`);
        
        const response = await fetch(url, {
          headers: {
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(10000), // 10 second timeout
        });

        if (!response.ok) {
          throw new Error(`MDBList genres API returned ${response.status}`);
        }

        const genresData = await response.json();
        
        if (!Array.isArray(genresData)) {
          throw new Error('MDBList genres API returned invalid format');
        }

        // Build title->slug mapping for genre conversion
        if (!genreTitleToSlugMap) {
          genreTitleToSlugMap = new Map();
        }
        genresData.forEach((g: any) => {
          if (g.title && g.slug) {
            genreTitleToSlugMap!.set(g.title.toLowerCase(), g.slug);
          }
        });

        // Extract slugs from the genre objects (MDBList API uses slugs for filtering)
        const genres = genresData.map(g => g.slug).filter(Boolean);

        logger.info(`Successfully fetched ${genres.length} ${isAnime ? 'anime' : 'standard'} genres from MDBList API`);
        return genres;
      }, `MDBList Genres API (anime=${animeParam})`);
    });
  } catch (err: any) {
    logger.error(`Error fetching MDBList genres (anime=${isAnime}):`, err.message);
    return [];
  }
}

// Convert genre title to slug using the mapping from the API
function convertGenreToSlug(genre: string): string {
  if (!genre || genre.toLowerCase() === 'none') {
    return genre;
  }
  
  // If we have the mapping, use it
  if (genreTitleToSlugMap) {
    const slug = genreTitleToSlugMap.get(genre.toLowerCase());
    if (slug) {
      return slug;
    }
  }
  
  // Fallback: genre is already in slug format or direct conversion
  return genre;
}

type MovieIdInput =
  | string
  | {
      imdb?: string;
      tmdb?: number | string;
      trakt?: number | string;
      kitsu?: number | string;
    };

type EpisodeIdInput =
  | string
  | {
    imdb?: string;
    tmdb?: number | string;
    trakt?: number | string;
    tvdb?: number | string;
  };

// Watch history types
interface WatchHistoryMovieEntry {
  last_watched_at: string;
  movie: {
    title: string;
    year: number;
    ids: {
      trakt?: number;
      imdb?: string;
      tmdb?: number;
      kitsu?: number;
      mdblist?: string;
    };
  };
}

interface WatchHistoryEpisodeEntry {
  last_watched_at: string;
  episode: {
    season: number;
    number: number;
    name: string;
    ids: {
      tmdb?: number;
    };
    show: {
      title: string;
      year: number;
      ids: {
        tmdb?: number;
        trakt?: number;
        imdb?: string;
        mdblist?: string;
      };
    };
  };
}

interface WatchHistoryResponse {
  movies: WatchHistoryMovieEntry[];
  seasons: any[];
  episodes: WatchHistoryEpisodeEntry[];
  pagination: {
    page: number;
    limit: number;
    total_movies: number;
    total_seasons: number;
    total_episodes: number;
    has_more: boolean;
  };
}

function formatIdSummary(ids: Record<string, string | number>) {
  return Object.entries(ids)
    .map(([key, value]) => `${key}:${value}`)
    .join(', ');
}

function toOptionalNumber(value: number | string | undefined) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeMovieIdInput(input: MovieIdInput | null | undefined) {
  if (!input) return null;

  const ids: Record<string, string | number> = {};

  if (typeof input === 'string') {
    if (input.startsWith('tt')) {
      ids.imdb = input;
      return ids;
    }
    const [prefix, value] = input.split(':');
    if (prefix && value) {
      ids[prefix] = /^\d+$/.test(value) ? Number(value) : value;
      return ids;
    }
    return null;
  }

  if (input.imdb) ids.imdb = input.imdb;
  const tmdb = toOptionalNumber(input.tmdb);
  if (tmdb !== undefined) ids.tmdb = tmdb;
  const trakt = toOptionalNumber(input.trakt);
  if (trakt !== undefined) ids.trakt = trakt;
  const kitsu = toOptionalNumber(input.kitsu);
  if (kitsu !== undefined) ids.kitsu = kitsu;

  return Object.keys(ids).length > 0 ? ids : null;
}

function normalizeEpisodeIdInput(input: EpisodeIdInput | null | undefined) {
  if (!input) return null;

  const ids: Record<string, string | number> = {};

  if (typeof input === 'string') {
    if (input.startsWith('tt')) {
      ids.imdb = input;
      return ids;
    }
    const [prefix, value] = input.split(':');
    if (prefix && value) {
      ids[prefix] = /^\d+$/.test(value) ? Number(value) : value;
      return ids;
    }
    return null;
  }

  if (input.imdb) ids.imdb = input.imdb;
  const tmdb = toOptionalNumber(input.tmdb);
  if (tmdb !== undefined) ids.tmdb = tmdb;
  const trakt = toOptionalNumber(input.trakt);
  if (trakt !== undefined) ids.trakt = trakt;
  const tvdb = toOptionalNumber(input.tvdb);
  if (tvdb !== undefined) ids.tvdb = tvdb;

  return Object.keys(ids).length > 0 ? ids : null;
}

/**
 * Fetch user's watch history from MDBList API
 */
async function fetchWatchHistory(apiKey: string): Promise<WatchHistoryResponse | null> {
  if (!apiKey) {
    logger.debug('[Watch Tracking] Missing API key for fetchWatchHistory');
    return null;
  }

  try {
    const url = `https://api.mdblist.com/sync/watched?apikey=${apiKey}`;

    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, { dispatcher: mdblistDispatcher }),
      'MDBList fetchWatchHistory'
    );

    return response.data as WatchHistoryResponse;
  } catch (error: any) {
    logger.error(`[Watch Tracking] Failed to fetch watch history: ${error.message}`);
    return null;
  }
}

/**
 * Check if a movie was recently watched (within the last 30 days)
 */
function isMovieRecentlyWatched(
  normalizedIds: Record<string, string | number>,
  watchHistory: WatchHistoryResponse
): boolean {
  const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const entry of watchHistory.movies) {
    const movieIds = entry.movie.ids;

    // Check if any of our normalized IDs match any ID in the history entry
    for (const [key, value] of Object.entries(normalizedIds)) {
      const historyValue = (movieIds as any)[key];
      if (historyValue !== undefined && String(historyValue) === String(value)) {
        // Found a match - check if watched within the last month
        const watchedAt = new Date(entry.last_watched_at).getTime();
        if (now - watchedAt < ONE_MONTH_MS) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Check if an episode was recently watched (within the last 30 days)
 */
function isEpisodeRecentlyWatched(
  normalizedIds: Record<string, string | number>,
  season: number,
  episode: number,
  watchHistory: WatchHistoryResponse
): boolean {
  const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const entry of watchHistory.episodes) {
    const showIds = entry.episode.show.ids;
    const episodeSeason = entry.episode.season;
    const episodeNumber = entry.episode.number;

    // Check if any of our normalized IDs match any ID in the show's history entry
    for (const [key, value] of Object.entries(normalizedIds)) {
      const historyValue = (showIds as any)[key];
      if (historyValue !== undefined && String(historyValue) === String(value)) {
        // Found a match - check if season and episode also match
        if (episodeSeason === season && episodeNumber === episode) {
          // Check if watched within the last month
          const watchedAt = new Date(entry.last_watched_at).getTime();
          if (now - watchedAt < ONE_MONTH_MS) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

async function markMovieAsWatched(idInput: MovieIdInput, apiKey: string): Promise<boolean> {
  const normalizedIds = normalizeMovieIdInput(idInput);

  if (!normalizedIds || !apiKey) {
    logger.debug('[Watch Tracking] Missing ID or API key for markMovieAsWatched', {
      id: idInput,
      hasApiKey: !!apiKey
    });
    return false;
  }

  try {
    // Check if movie was recently watched before sending the request
    const watchHistory = await fetchWatchHistory(apiKey);
    if (watchHistory && isMovieRecentlyWatched(normalizedIds, watchHistory)) {
      logger.debug(
        `[Watch Tracking] Skipped marking ${formatIdSummary(normalizedIds)} because it's already watched`
      );
      return true; // Return true since the movie is already marked as watched
    }

    const url = `https://api.mdblist.com/sync/watched?apikey=${apiKey}`;
    const watchedAt = new Date().toISOString();

    const payload = {
      movies: [
        {
          ids: normalizedIds,
          watched_at: watchedAt
        }
      ]
    };

    logger.debug(
      `[Watch Tracking] Marking movie as watched - ids: ${formatIdSummary(normalizedIds)}, timestamp: ${watchedAt}`
    );

    await makeRateLimitedRequest(
      () =>
        httpPost(url, payload, {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: 10000,
          dispatcher: mdblistDispatcher
        }),
      `MDBList markMovieAsWatched (${formatIdSummary(normalizedIds)})`
    );

    logger.info('[Watch Tracking] Movie marked as watched', {
      ids: normalizedIds
    });
    return true;
  } catch (error: any) {
    logger.error(
      `[Watch Tracking] Failed to mark movie as watched - ids: ${formatIdSummary(normalizedIds)}, error: ${error.message}`,
      {
        stack: error.stack
      }
    );

    if (error.response) {
      logger.error(
        `[Watch Tracking] MDBList API error response - status: ${error.response.status}, statusText: ${
          error.response.statusText || 'N/A'
        }`,
        {
          responseData: error.response.data,
          headers: error.response.headers
        }
      );
    } else if (error.code) {
      logger.error(`[Watch Tracking] Network error - code: ${error.code}`, {
        errno: error.errno,
        syscall: error.syscall
      });
    }

    return false;
  }
}

async function markEpisodeAsWatched(
  idInput: EpisodeIdInput,
  season: number,
  episode: number,
  apiKey: string
): Promise<boolean> {
  const normalizedIds = normalizeEpisodeIdInput(idInput);

  if (!normalizedIds || !apiKey || season < 1 || episode < 1) {
    logger.warn('[Watch Tracking] Invalid parameters for markEpisodeAsWatched', {
      id: idInput,
      season,
      episode,
      hasApiKey: !!apiKey
    });
    return false;
  }

  try {
    // Check if episode was recently watched before sending the request
    const watchHistory = await fetchWatchHistory(apiKey);
    if (watchHistory && isEpisodeRecentlyWatched(normalizedIds, season, episode, watchHistory)) {
      logger.debug(
        `[Watch Tracking] Skipped marking ${formatIdSummary(normalizedIds)} S${season}E${episode} because it's already watched`
      );
      return true; // Return true since the episode is already marked as watched
    }

    const url = `https://api.mdblist.com/sync/watched?apikey=${apiKey}`;
    const watchedAt = new Date().toISOString();

    const payload = {
      shows: [
        {
          ids: normalizedIds,
          seasons: [
            {
              number: season,
              episodes: [
                {
                  number: episode,
                  watched_at: watchedAt
                }
              ]
            }
          ]
        }
      ]
    };

    logger.debug(
      `[Watch Tracking] Marking episode as watched - ids: ${formatIdSummary(normalizedIds)}, S${season}E${episode}, timestamp: ${watchedAt}`
    );

    await makeRateLimitedRequest(
      () =>
        httpPost(url, payload, {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: 10000,
          dispatcher: mdblistDispatcher
        }),
      `MDBList markEpisodeAsWatched (${formatIdSummary(normalizedIds)}, S${season}E${episode})`
    );

    logger.info('[Watch Tracking] Episode marked as watched', {
      ids: normalizedIds,
      season,
      episode
    });
    return true;
  } catch (error: any) {
    logger.error(
      `[Watch Tracking] Failed to mark episode as watched - ids: ${formatIdSummary(normalizedIds)}, S${season}E${episode}, error: ${error.message}`,
      {
        stack: error.stack
      }
    );

    if (error.response) {
      logger.error(
        `[Watch Tracking] MDBList API error response - status: ${error.response.status}, statusText: ${error.response.statusText || 'N/A'}`,
        {
          responseData: error.response.data,
          headers: error.response.headers
        }
      );
    } else if (error.code) {
      logger.error(`[Watch Tracking] Network error - code: ${error.code}`, {
        errno: error.errno,
        syscall: error.syscall
      });
    }

    return false;
  }
}

/**
 * Wrapper for proxy endpoints - makes a rate-limited GET request to MDBList
 */
async function makeRateLimitedMDBListRequest(url: string, context: string = 'MDBList Proxy'): Promise<any> {
  return await makeRateLimitedRequest(
    () => httpGet(url, { dispatcher: mdblistDispatcher }),
    context
  );
}

export { fetchMDBListItems, fetchMDBListExternalItems, fetchMDBListBatchMediaInfo, getGenresFromMDBList, parseMDBListItems, getMediaRatingFromMDBList, fetchMDBListGenres, convertGenreToSlug, markMovieAsWatched, markEpisodeAsWatched, makeRateLimitedMDBListRequest };

