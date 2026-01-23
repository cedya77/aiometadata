import { httpGet, httpPost } from "./httpClient.js";
import { getMeta } from "../lib/getMeta.js";
import { cacheWrapMetaSmart, cacheWrapGlobal } from "../lib/getCache.js";
import { UserConfig } from "../types/index.js";
const consola = require('consola');
const { Agent } = require('undici');
const crypto = require('crypto');
const database = require('../lib/database.js');
const requestTracker = require('../lib/requestTracker.js');
const redis = require('../lib/redisClient');

const logger = consola.withTag('Simkl');

const SIMKL_BASE_URL = 'https://api.simkl.com';
const SIMKL_CLIENT_ID = process.env.SIMKL_CLIENT_ID || '';

const SIMKL_TRENDING_TTL = 12 * 60 * 60; // 12 hours
const SIMKL_WATCHLIST_TTL = 60 * 60; // 1 hour default

/**
 * Sanitize URL by removing access token for safe logging
 */
function sanitizeUrlForLogging(url: string): string {
  return url.replace(/(Authorization: Bearer\s+)[^\s]+/gi, '$1[REDACTED]');
}

const simklDispatcher = new Agent({ connect: { timeout: 30000 } });

/**
 * Checks if an error is a "permanent" client-side error that should not be retried.
 */
function isPermanentError(error: any): boolean {
  const status = error.response?.status;
  return status >= 400 && status < 500 && status !== 429;
}

const RATE_LIMIT_CONFIG = {
  maxRetries: 5,
  baseDelay: 1000, // 1 second base delay
  maxDelay: 30000, // 30 seconds max delay
  rateLimitDelay: 5000, // 5 seconds for rate limit backoff
  minInterval: 300, // Minimum 300ms between requests
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
 * Extract retry delay from Simkl's Retry-After header (in seconds)
 * Falls back to exponential backoff if header is not present
 */
function getRetryAfterMs(error: any, fallbackMs: number): number {
  const headers = error.response?.headers;
  if (!headers) return fallbackMs;

  const retryAfter = headers['retry-after'] || headers['Retry-After'];
  if (retryAfter) {
    const retrySeconds = parseInt(retryAfter, 10);
    if (!isNaN(retrySeconds) && retrySeconds > 0) {
      const jitter = Math.random() * 1000;
      return (retrySeconds * 1000) + jitter;
    }
  }

  return fallbackMs;
}

/**
 * Rate limiting and retry logic for Simkl API calls (aligned with Trakt)
 */
async function makeRateLimitedRequest<T>(
  requestFn: () => Promise<T>, 
  context: string = 'Simkl', 
  retries: number = RATE_LIMIT_CONFIG.maxRetries
): Promise<T> {
  let attempt = 0;
  
  while (attempt < retries) {
    attempt++;
    const isLastAttempt = attempt === retries;

    const now = Date.now();
    
    if (rateLimitState.isRateLimited && rateLimitState.rateLimitResetTime > now) {
      const waitTime = rateLimitState.rateLimitResetTime - now;
      logger.debug(`Global rate limit cooldown active, waiting ${waitTime}ms - ${context}`);
      await sleep(waitTime);
    }
    rateLimitState.isRateLimited = false;

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
      requestTracker.trackProviderCall('simkl', responseTime, true);
      rateLimitState.recentRateLimitHits = 0;
      logger.debug(`Simkl API call succeeded: ${context} [${responseTime}ms]`);
      return response;
    } catch (error: any) {
      const responseTime = Date.now() - startTime;
      requestTracker.trackProviderCall('simkl', responseTime, false);
      const status = error.response?.status;

      if (isPermanentError(error)) {
        logger.error(`[Simkl] Permanent error (${status}): ${context} - ${error.message || String(error)}`);
        throw error;
      }
      
      if (isRateLimitError(error)) {
        rateLimitState.lastRateLimitTime = Date.now();
        rateLimitState.recentRateLimitHits++;
        
        if (isLastAttempt) {
          logger.error(`[Simkl] Rate limit exceeded after ${retries} attempts: ${context}`);
          throw error;
        }

        const fallbackDelay = RATE_LIMIT_CONFIG.rateLimitDelay * Math.pow(2, rateLimitState.recentRateLimitHits - 1);
        const totalDelay = Math.min(getRetryAfterMs(error, fallbackDelay), RATE_LIMIT_CONFIG.maxDelay);

        logger.warn(`[Simkl] Rate limit hit (${status}). Retrying in ${Math.round(totalDelay / 1000)}s (attempt ${attempt}/${retries}) - ${context}`);

        rateLimitState.isRateLimited = true;
        rateLimitState.rateLimitResetTime = Date.now() + totalDelay;

        await sleep(totalDelay);
        continue;
      }
      
      if (isLastAttempt) {
        logger.error(`[Simkl] Request failed after ${retries} attempts: ${context} - ${error.message || String(error)}`);
        throw error;
      }
      
      const delay = Math.min(
        RATE_LIMIT_CONFIG.baseDelay * Math.pow(RATE_LIMIT_CONFIG.backoffMultiplier, attempt - 1),
        RATE_LIMIT_CONFIG.maxDelay
      );
      logger.warn(`[Simkl] Request failed (${status}), retrying in ${delay}ms (attempt ${attempt}/${retries}): ${context} - ${error.message || String(error)}`);
      await sleep(delay);
    }
  }
  
  throw new Error(`Simkl API request failed after ${retries} attempts: ${context}`);
}

/**
 * Get Simkl access token from database using tokenId
 */
async function getSimklAccessToken(tokenId: string): Promise<string | null> {
  try {
    const token = await database.getOAuthToken(tokenId);
    if (!token || token.provider !== 'simkl') {
      return null;
    }
    return token.access_token;
  } catch (error: any) {
    logger.error(`Error getting Simkl access token: ${error.message}`);
    return null;
  }
}

/**
 * Make an authenticated Simkl API request with rate limiting
 * @param url - Full Simkl API URL
 * @param accessToken - OAuth access token
 * @param context - Context string for logging
 * @param method - HTTP method (GET or POST)
 * @param body - Request body for POST requests
 * @returns Response with data property
 */
async function makeAuthenticatedSimklRequest(
  url: string, 
  accessToken: string, 
  context: string = 'Simkl (Auth)',
  method: 'GET' | 'POST' = 'GET',
  body?: any
): Promise<any> {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'simkl-api-key': SIMKL_CLIENT_ID
  };

  if (method === 'POST') {
    return await makeRateLimitedRequest(
      () => httpPost(url, body || {}, { headers, dispatcher: simklDispatcher }),
      context
    );
  } else {
    return await makeRateLimitedRequest(
      () => httpGet(url, { headers, dispatcher: simklDispatcher }),
      context
    );
  }
}

/**
 * Make a rate-limited GET request to Simkl API (public endpoints)
 * @param url - Full Simkl API URL
 * @param context - Context string for logging
 * @returns Response with data property
 */
async function makeRateLimitedSimklRequest(url: string, context: string = 'Simkl Proxy'): Promise<any> {
  const headers = {
    'Content-Type': 'application/json',
    'simkl-api-key': SIMKL_CLIENT_ID
  };

  return await makeRateLimitedRequest(
    () => httpGet(url, { headers, dispatcher: simklDispatcher }),
    context
  );
}

/**
 * Fetch Simkl user stats
 * @param accessToken - User's Simkl access token
 * @returns Stats object
 */
async function fetchSimklUserStats(accessToken: string): Promise<any> {
  const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex').substring(0, 16);
  const cacheKey = `simkl-stats:${tokenHash}`;
  const statsTTL = 24 * 60 * 60; 
  
  return await cacheWrapGlobal(
    cacheKey,
    async () => {
      const url = `${SIMKL_BASE_URL}/users/me/stats`;
      const response: any = await makeAuthenticatedSimklRequest(
        url,
        accessToken,
        'Simkl fetchUserStats',
        'POST'
      );
      return response.data;
    },
    statsTTL,
    { skipVersion: true }
  );
}

/**
 * Fetch Simkl watchlist items by type and status
 * Note: Simkl API doesn't support pagination for watchlists, so we fetch all items at once
 * and do local pagination like StremThru
 * @param accessToken - User's Simkl access token
 * @param type - Content type: 'movies', 'shows', or 'anime'
 * @param status - Item status: 'watching', 'plantowatch', 'hold', 'completed', 'dropped'
 * @param cacheTTL - Cache TTL in seconds
 * @returns Object with all items array (no pagination)
 */
async function fetchSimklWatchlistItems(
  accessToken: string,
  type: 'movies' | 'shows' | 'anime',
  status: 'watching' | 'plantowatch' | 'hold' | 'completed' | 'dropped',
  cacheTTL: number = SIMKL_WATCHLIST_TTL
): Promise<{items: any[]}> {
  try {
    // Create user-specific cache key by hashing accessToken
    const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex').substring(0, 16);
    
    // Cache keys are status-only (not type-specific) since we fetch all types in one call
    const fullListKey = `simkl-watchlist-full:${tokenHash}:${status}`;
    const lastSyncKey = `simkl-last-sync:${tokenHash}:${status}`;
    
    // Get cached full response (contains all types: movies, shows, anime)
    let cachedFullResponse: any = null;
    let dateFrom: string | null = null;
    
    try {
      const cachedFullList = await redis.get(fullListKey);
      if (cachedFullList) {
        cachedFullResponse = JSON.parse(cachedFullList);
        logger.debug(`Simkl using cached full watchlist response for ${status}`);
        
        const lastSync = await redis.get(lastSyncKey);
        if (lastSync) {
          dateFrom = lastSync;
          logger.debug(`Simkl will fetch changes since ${dateFrom}`);
        }
      }
    } catch (error: any) {
      logger.debug(`Failed to get cached watchlist: ${error.message}`);
    }
    
    // Make single API call to get all types (movies, shows, anime) for this status
    // This is more efficient than separate calls per type
    let url = `${SIMKL_BASE_URL}/sync/all-items/${status}?extended=full`;
    if (dateFrom) {
      url += `&date_from=${encodeURIComponent(dateFrom)}`;
    }
    
    logger.debug(`Simkl watchlist ${status}${dateFrom ? `, date_from=${dateFrom} (incremental)` : ' (full sync)'}`);
    
    // Cache key is status-only (not type-specific) since response contains all types
    const cacheKey = `simkl-watchlist-api:${tokenHash}:${status}${dateFrom ? `:${dateFrom}` : ''}`;
    
    const response: any = await cacheWrapGlobal(
      cacheKey,
      async () => {
        return await makeAuthenticatedSimklRequest(
          url,
          accessToken,
          `Simkl fetchWatchlistItems (${status}${dateFrom ? `, date_from=${dateFrom}` : ''})`
        );
      },
      cacheTTL,
      { skipVersion: true }
    );
    
    const allApiItems: any = {
      movies: response.data?.movies || [],
      shows: response.data?.shows || [],
      anime: response.data?.anime || []
    };
    
    // Merge: if we have date_from, merge changes with cached full response
    // Otherwise, use API response as the full response
    let fullResponse: any;
    if (dateFrom && cachedFullResponse) {
      fullResponse = {
        movies: mergeItems(cachedFullResponse.movies || [], allApiItems.movies),
        shows: mergeItems(cachedFullResponse.shows || [], allApiItems.shows),
        anime: mergeItems(cachedFullResponse.anime || [], allApiItems.anime)
      };
      const totalChanges = allApiItems.movies.length + allApiItems.shows.length + allApiItems.anime.length;
      const totalItems = fullResponse.movies.length + fullResponse.shows.length + fullResponse.anime.length;
      logger.debug(`Simkl merged incremental update: ${totalChanges} changes, ${totalItems} total items`);
    } else {
      // Full sync: use API response as the full response
      fullResponse = allApiItems;
      const totalItems = fullResponse.movies.length + fullResponse.shows.length + fullResponse.anime.length;
      logger.debug(`Simkl full sync: ${totalItems} total items`);
    }
    
    // Cache the full response (all types)
    try {
      const now = new Date().toISOString();
      await redis.setex(fullListKey, cacheTTL, JSON.stringify(fullResponse));
      await redis.setex(lastSyncKey, 30 * 24 * 60 * 60, now);
      logger.debug(`Simkl cached full watchlist response and stored last sync timestamp: ${now}`);
    } catch (error: any) {
      logger.debug(`Failed to cache watchlist or store timestamp: ${error.message}`);
    }
    
    let items: any[] = [];
    if (type === 'movies') {
      items = fullResponse.movies || [];
    } else if (type === 'shows') {
      items = fullResponse.shows || [];
    } else if (type === 'anime') {
      items = fullResponse.anime || [];
    }
    
    // Sort by last_watched_at (most recent first)
    // Handle both last_watched_at and last_watched field names
    items.sort((a: any, b: any) => {
      const aTime = (a.last_watched_at || a.last_watched) ? new Date(a.last_watched_at || a.last_watched).getTime() : 0;
      const bTime = (b.last_watched_at || b.last_watched) ? new Date(b.last_watched_at || b.last_watched).getTime() : 0;
      // Most recent first (descending order)
      return bTime - aTime;
    });
    
    logger.debug(`Simkl watchlist ${type}/${status}: returning ${items.length} items (from full response, sorted by last_watched_at)`);
    
    return { items: Array.isArray(items) ? items : [] };
  } catch (error: any) {
    logger.error(`Error fetching Simkl watchlist items: ${error.message}`);
    return { items: [] };
  }
}

function mergeItems(existingItems: any[], newItems: any[]): any[] {
  const existingMap = new Map();
  existingItems.forEach((item: any) => {
    const simklId = item.show?.ids?.simkl || item.movie?.ids?.simkl || item.ids?.simkl;
    if (simklId) {
      existingMap.set(simklId, item);
    }
  });
  
  newItems.forEach((item: any) => {
    const simklId = item.show?.ids?.simkl || item.movie?.ids?.simkl || item.ids?.simkl;
    if (simklId) {
      existingMap.set(simklId, item);
    }
  });
  
  return Array.from(existingMap.values());
}

/**
 * Fetch Simkl watched items
 * @param accessToken - User's Simkl access token
 * @param type - Content type: 'movies', 'shows', or 'anime'
 * @returns Array of watched items
 */
async function fetchSimklWatchedItems(
  accessToken: string,
  type: 'movies' | 'shows' | 'anime' = 'movies'
): Promise<any[]> {
  try {
    const endpoint = type === 'movies' ? 'movies' : type === 'shows' ? 'tv' : 'anime';
    const url = `${SIMKL_BASE_URL}/sync/all-items/${endpoint}/completed`;
    
    const response: any = await makeAuthenticatedSimklRequest(
      url,
      accessToken,
      `Simkl fetchWatchedItems (${type})`
    );
    
    const items = response.data || [];
    return Array.isArray(items) ? items : [];
  } catch (error: any) {
    logger.error(`Error fetching Simkl watched items: ${error.message}`);
    return [];
  }
}

/**
 * Fetch Simkl watching items (currently watching shows/anime)
 * @param accessToken - User's Simkl access token
 * @param type - Content type: 'shows' or 'anime'
 * @returns Array of watching items
 */
async function fetchSimklWatchingItems(
  accessToken: string,
  type: 'shows' | 'anime' = 'shows'
): Promise<any[]> {
  try {
    const endpoint = type === 'shows' ? 'tv' : 'anime';
    const url = `${SIMKL_BASE_URL}/sync/all-items/${endpoint}/watching`;
    
    const response: any = await makeAuthenticatedSimklRequest(
      url,
      accessToken,
      `Simkl fetchWatchingItems (${type})`
    );
    
    const items = response.data || [];
    return Array.isArray(items) ? items : [];
  } catch (error: any) {
    logger.error(`Error fetching Simkl watching items: ${error.message}`);
    return [];
  }
}

/**
 * Parse Simkl items and convert to Stremio meta format
 * @param items - Array of Simkl items
 * @param type - Content type: 'movie' or 'series'
 * @param config - User configuration
 * @param userUUID - User UUID
 * @param includeVideos - Whether to include video/episode data
 * @param isAnimeCatalog - If true, prefer mal/anilist/kitsu/anidb over tmdb/imdb/tvdb for getMeta
 * @returns Array of parsed meta items
 */
async function parseSimklItems(
  items: any[],
  type: 'movie' | 'series',
  config: UserConfig,
  userUUID: string,
  includeVideos: boolean = false,
  isAnimeCatalog: boolean = false
): Promise<any[]> {
  if (!items || items.length === 0) {
    return [];
  }

  const metas = await Promise.all(
    items.map(async (item: any) => {
      try {
        const itemType = item.type || type;
        
        const imdbId = item.ids?.imdb;
        const tmdbId = item.ids?.tmdb;
        const tvdbId = item.ids?.tvdb;
        const malId = item.ids?.mal;
        const anilistId = item.ids?.anilist;
        const kitsuId = item.ids?.kitsu;
        const anidbId = item.ids?.anidb;
        
        const hasValidId = isAnimeCatalog
          ? !!(malId || anilistId || kitsuId || anidbId || tmdbId || imdbId || tvdbId)
          : !!(imdbId || tmdbId || tvdbId || malId);
        if (!hasValidId) {
          logger.debug(`[Simkl] Skipping item with only simkl ID: ${JSON.stringify(item)}`);
          return null;
        }
        
        let stremioId: string | null = null;
        if (isAnimeCatalog) {
          // Anime catalogs: prefer mal → anilist → kitsu → anidb, then tmdb → imdb → tvdb
          if (malId) {
            stremioId = `mal:${malId}`;
          } else if (anilistId) {
            stremioId = `anilist:${anilistId}`;
          } else if (kitsuId) {
            stremioId = `kitsu:${kitsuId}`;
          } else if (anidbId) {
            stremioId = `anidb:${anidbId}`;
          } else if (tmdbId) {
            stremioId = `tmdb:${tmdbId}`;
          } else if (imdbId) {
            stremioId = imdbId.startsWith('tt') ? imdbId : `tt${imdbId}`;
          } else if (tvdbId) {
            stremioId = `tvdb:${tvdbId}`;
          }
        } else {
          if (imdbId) {
            stremioId = imdbId.startsWith('tt') ? imdbId : `tt${imdbId}`;
          } else if (tmdbId) {
            stremioId = `tmdb:${tmdbId}`;
          } else if (tvdbId) {
            stremioId = `tvdb:${tvdbId}`;
          } else if (malId) {
            stremioId = `mal:${malId}`;
          }
        }
        if (!stremioId) {
          return null;
        }
        
        const result = await cacheWrapMetaSmart(
          userUUID,
          stremioId,
          async () => {
            return await getMeta(itemType, config.language, stremioId!, config, userUUID, includeVideos);
          },
          undefined,
          { enableErrorCaching: true, maxRetries: 2 },
          itemType as any,
          includeVideos
        );
        
        if (result?.meta) {
          return result.meta;
        }
        return null;
      } catch (error: any) {
        logger.warn(`Error parsing Simkl item: ${error.message}`);
        return null;
      }
    })
  );
  
  return metas.filter(Boolean);
}

/**
 * Fetch trending items for movies, shows, or anime from Simkl
 * @param type - Content type: 'movies', 'shows', or 'anime'
 * @param interval - Time period: 'today', 'week', or 'month' (default: 'today')
 * @param page - Page number (1-indexed)
 * @param limit - Items per page
 * @returns Object with items array and pagination info
 */
async function fetchSimklTrendingItems(
  type: 'movies' | 'shows' | 'anime',
  interval: 'today' | 'week' | 'month' = 'today',
  page: number = 1,
  limit: number = 20
): Promise<{items: any[], totalItems?: number, hasMore: boolean, totalPages?: number}> {
  try {
    const endpoint = type === 'movies' ? 'movies' : type === 'shows' ? 'tv' : 'anime';
    
    let url = `${SIMKL_BASE_URL}/${endpoint}/trending/`;
    
    if (interval !== 'today') {
      url += `${interval}?`;
    } else {
      url += '?';
    }
    
    url += `extended=overview,metadata,tmdb,genres,trailer&client_id=${SIMKL_CLIENT_ID}`;
    
    const urlWithPagination = `${url}&page=${page}&limit=${limit}`;
    
    logger.debug(`Simkl trending ${type}: interval=${interval}, page=${page}, limit=${limit}`);
    
    const cacheKey = `simkl-trending:${type}:${interval}:${page}:${limit}`;
    
    const response: any = await cacheWrapGlobal(
      cacheKey,
      async () => {
        return await makeRateLimitedRequest(
          () => httpGet(urlWithPagination, {
            dispatcher: simklDispatcher,
            headers: {
              'Content-Type': 'application/json',
              'simkl-api-key': SIMKL_CLIENT_ID
            }
          }),
          `Simkl fetchTrendingItems (${type}, interval: ${interval}, page: ${page})`
        );
      },
      SIMKL_TRENDING_TTL,
      { skipVersion: true }
    );

    // Simkl returns an array directly (no pagination headers)
    // If the array is empty, there are no more pages
    let rawItems: any[] = Array.isArray(response.data) ? response.data : [];
    const hasMore = rawItems.length > 0;
    
    logger.debug(`Simkl trending page ${page}: ${rawItems.length} items, hasMore: ${hasMore}`);
    
    const items = rawItems.map((entry: any) => {
      // For anime, use anime_type to determine if it's a movie or series
      // movies and onas are movies, everything else is series
      let itemType: 'movie' | 'series';
      if (type === 'anime' && entry.anime_type) {
        itemType = (entry.anime_type === 'movie' || entry.anime_type === 'ona') ? 'movie' : 'series';
      } else {
        itemType = type === 'movies' ? 'movie' : 'series';
      }
      return {
        type: itemType,
        ...entry
      };
    });

    return { items, hasMore };
  } catch (err: any) {
    logger.error(`Error fetching Simkl trending ${type}, interval ${interval}, page ${page}:`, err.message);
    return { items: [], hasMore: false };
  }
}

export {
  fetchSimklUserStats,
  fetchSimklWatchlistItems,
  fetchSimklWatchedItems,
  fetchSimklWatchingItems,
  parseSimklItems,
  makeRateLimitedSimklRequest,
  makeAuthenticatedSimklRequest,
  getSimklAccessToken,
  fetchSimklTrendingItems
};
