import { httpGet, httpPost } from "./httpClient.js";
import { resolveAllIds } from "../lib/id-resolver.js";
import { getMeta } from "../lib/getMeta.js";
import { cacheWrapMetaSmart, cacheWrapMDBListGenres } from "../lib/getCache.js";
import { UserConfig } from "../types/index.js";
const consola = require('consola');
const { socksDispatcher } = require('fetch-socks');
const { Agent } = require('undici');

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
  tag: 'MDBList'
});

// Proxy configuration for MDBList requests
const MDBLIST_SOCKS_PROXY_URL = process.env.MDBLIST_SOCKS_PROXY_URL;
let mdblistDispatcher;

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
      logger.error(`[MDBList] Unsupported proxy protocol: ${proxyUrlObj.protocol}. Using direct connection.`);
      mdblistDispatcher = new Agent({ connect: { timeout: 30000 } });
    }
  } catch (error) {
    logger.error(`[MDBList] Invalid MDBLIST_SOCKS_PROXY_URL. Using direct connection. Error: ${error.message}`);
    mdblistDispatcher = new Agent({ connect: { timeout: 30000 } });
  }
} else {
  mdblistDispatcher = new Agent({ connect: { timeout: 30000 } });
  logger.info('[MDBList] undici agent is enabled for direct connections.');
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
  rateLimitResetTime: 0
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
    
    // ** CRITICAL FIX: Update the timestamp BEFORE making the request. **
    // This prevents other parallel calls from firing at the same time.
    rateLimitState.lastRequestTime = Date.now();
    const startTime = Date.now();
    
    try {
      const response = await requestFn();
      const responseTime = Date.now() - startTime;
      
      const requestTracker = require('../lib/requestTracker.js');
      requestTracker.trackProviderCall('mdblist', responseTime, true);
      
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
        
        if (isLastAttempt) {
          logger.error(`Rate limit exceeded after ${retries} attempts: ${error.message} - ${context}`);
          throw error;
        }
        
        let backoffTime = RATE_LIMIT_CONFIG.rateLimitDelay * Math.pow(2, rateLimitState.recentRateLimitHits -1);
        const jitter = Math.random() * 1000;
        const totalDelay = Math.min(backoffTime + jitter, RATE_LIMIT_CONFIG.maxDelay);
        
        logger.warn(`Rate limit hit. Retrying in ${Math.round(totalDelay)}ms (attempt ${attempt}/${retries}) - ${context}`);
        
        // Set a global cooldown period for all subsequent requests.
        rateLimitState.isRateLimited = true;
        rateLimitState.rateLimitResetTime = Date.now() + totalDelay;
        
        await sleep(totalDelay);
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

async function fetchMDBListItems(listId: string, apiKey: string, language: string, page: number, sort?: string, order?: string, genre?: string): Promise<{items: any[], totalItems?: number, hasMore?: boolean, totalPages?: number}> {
  // Use configurable page size (supports CATALOG_LIST_ITEMS_SIZE env var)
  const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20;
  const offset = (page * pageSize) - pageSize;
  
  try {
    let url = `https://api.mdblist.com/lists/${listId}/items?language=${language}&limit=${pageSize}&offset=${offset}&apikey=${apiKey}&append_to_response=genre,poster`;
    
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
    
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, { dispatcher: mdblistDispatcher }),
      `MDBList fetchMDBListItems (listId: ${listId}, page: ${page}, pageSize: ${pageSize}, sort: ${sort}, order: ${order}, genre: ${genre})`
    );
    
    // Extract pagination metadata from headers
    const totalItems = response.headers?.['x-total-items'] ? parseInt(response.headers['x-total-items']) : undefined;
    const hasMore = response.headers?.['x-has-more'] === 'true';
    
    // Calculate total pages from headers
    const totalPages = totalItems ? Math.ceil(totalItems / pageSize) : undefined;
    
    const items = [
      ...(response.data.movies || []),
      ...(response.data.shows || [])
    ];
    
    // Smart pagination validation and logging
    if (totalItems !== undefined) {
      // Validate request didn't exceed available items
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
      
      logger.debug(`Smart pagination - listId: ${listId}, page: ${page}/${totalPages}, items: ${itemsReturned}/${expectedItems}, offset: ${offset}, totalItems: ${totalItems}, hasMore: ${hasMore}`);
      
      // Validate response consistency
      if (!hasMore && itemsReturned > 0 && offset + itemsReturned < totalItems) {
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


async function parseMDBListItems(items: any[], type: string, language: string, config: UserConfig): Promise<any[]> {
  let filteredItems = items;
  //console.log(`[MDBList] Filtered items: ${JSON.stringify(filteredItems)}`);

  const targetMediaType = type === 'series' ? 'show' : 'movie';
  //const batchMediaInfo = await fetchMDBListBatchMediaInfo('tmdb', targetMediaType, filteredItems.map(item => item.id), config.apiKeys?.mdblist || '');
  //console.log(`[MDBList] Batch media info: ${JSON.stringify(batchMediaInfo)}`);
  
 
  const metas = await Promise.all(filteredItems
    .filter(item => item.mediatype === targetMediaType)
    .map(async (item: any) => {
      try {
        let stremioId = `tmdb:${item.id}`;
        
        // Use getMeta with cacheWrapMetaSmart to get the full meta object with caching
        const result = await cacheWrapMetaSmart(config.userUUID, stremioId, async () => {
          return await getMeta(type, language, stremioId, config, config.userUUID, false);
        }, undefined, {enableErrorCaching: true, maxRetries: 2}, type as any);
        
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

        // Extract titles from the genre objects
        const genres = genresData.map(g => g.title).filter(Boolean);

        logger.info(`Successfully fetched ${genres.length} ${isAnime ? 'anime' : 'standard'} genres from MDBList API`);
        return genres;
      }, `MDBList Genres API (anime=${animeParam})`);
    });
  } catch (err: any) {
    logger.error(`Error fetching MDBList genres (anime=${isAnime}):`, err.message);
    return [];
  }
}

export { fetchMDBListItems, fetchMDBListBatchMediaInfo, getGenresFromMDBList, parseMDBListItems, getMediaRatingFromMDBList, fetchMDBListGenres };

