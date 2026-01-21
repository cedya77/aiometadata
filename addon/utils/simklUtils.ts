import { httpGet, httpPost } from "./httpClient.js";
import { getMeta } from "../lib/getMeta.js";
import { cacheWrapMetaSmart } from "../lib/getCache.js";
import { UserConfig } from "../types/index.js";
const consola = require('consola');
const { Agent } = require('undici');
const database = require('../lib/database.js');

const logger = consola.withTag('Simkl');

const SIMKL_BASE_URL = 'https://api.simkl.com';
const SIMKL_CLIENT_ID = process.env.SIMKL_CLIENT_ID || '';

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
  // Consider 4xx errors (except 429 rate limit) as permanent.
  // 401 (unauthorized) and 403 (forbidden) are permanent auth errors
  return status >= 400 && status < 500 && status !== 429;
}

// Rate limiting configuration for Simkl API
// Simkl rate limit: Check API documentation for actual limits
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

  // Try to get Retry-After header (value is in seconds)
  const retryAfter = headers['retry-after'] || headers['Retry-After'];
  if (retryAfter) {
    const retrySeconds = parseInt(retryAfter, 10);
    if (!isNaN(retrySeconds) && retrySeconds > 0) {
      // Add small jitter (0-1 second) to prevent thundering herd
      const jitter = Math.random() * 1000;
      return (retrySeconds * 1000) + jitter;
    }
  }

  return fallbackMs;
}

/**
 * Rate limiting and retry logic for Simkl API calls
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
    
    // Update the timestamp BEFORE making the request to prevent parallel calls
    rateLimitState.lastRequestTime = Date.now();
    const startTime = Date.now();
    
    try {
      const response = await requestFn();
      const duration = Date.now() - startTime;
      
      // Reset rate limit state on successful request
      rateLimitState.recentRateLimitHits = 0;
      
      logger.debug(`Simkl API call succeeded: ${context} [${duration}ms]`);
      return response;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const status = error.response?.status;
      
      // Handle rate limiting
      if (isRateLimitError(error)) {
        rateLimitState.recentRateLimitHits++;
        rateLimitState.lastRateLimitTime = now;
        
        const retryAfterMs = getRetryAfterMs(error, RATE_LIMIT_CONFIG.rateLimitDelay);
        rateLimitState.rateLimitResetTime = now + retryAfterMs;
        rateLimitState.isRateLimited = true;
        
        logger.warn(`[Simkl] Rate limit hit (${status}). Retrying in ${Math.round(retryAfterMs / 1000)}s (attempt ${attempt}/${retries}) - ${context}`);
        
        if (isLastAttempt) {
          logger.error(`[Simkl] Rate limit exceeded after ${retries} attempts: ${context}`);
          throw error;
        }
        
        await sleep(retryAfterMs);
        continue;
      }
      
      // Handle permanent errors (don't retry)
      if (isPermanentError(error)) {
        logger.error(`[Simkl] Permanent error (${status}): ${context} - ${error.message || String(error)}`);
        throw error;
      }
      
      // Handle transient errors (retry with exponential backoff)
      if (isLastAttempt) {
        logger.error(`[Simkl] Request failed after ${retries} attempts: ${context} - ${error.message || String(error)}`);
        throw error;
      }
      
      const backoffDelay = Math.min(
        RATE_LIMIT_CONFIG.baseDelay * Math.pow(RATE_LIMIT_CONFIG.backoffMultiplier, attempt - 1),
        RATE_LIMIT_CONFIG.maxDelay
      );
      
      logger.warn(`[Simkl] Request failed (${status}), retrying in ${backoffDelay}ms (attempt ${attempt}/${retries}): ${context} - ${error.message || String(error)}`);
      await sleep(backoffDelay);
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
  const url = `${SIMKL_BASE_URL}/users/me/stats`;
  const response: any = await makeRateLimitedRequest(
    () => httpPost(url, {}, {
      dispatcher: simklDispatcher,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'simkl-api-key': SIMKL_CLIENT_ID
      }
    }),
    'Simkl fetchUserStats'
  );
  return response.data;
}

/**
 * Fetch Simkl watchlist items
 * @param accessToken - User's Simkl access token
 * @param type - Content type: 'movies', 'shows', or 'anime'
 * @returns Array of watchlist items
 */
async function fetchSimklWatchlistItems(
  accessToken: string,
  type: 'movies' | 'shows' | 'anime' = 'movies'
): Promise<any[]> {
  try {
    // Simkl API endpoint for watchlist - adjust based on actual API documentation
    const endpoint = type === 'movies' ? 'movies' : type === 'shows' ? 'tv' : 'anime';
    const url = `${SIMKL_BASE_URL}/sync/all-items/${endpoint}/plantowatch`;
    
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, {
        dispatcher: simklDispatcher,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'simkl-api-key': SIMKL_CLIENT_ID
        }
      }),
      `Simkl fetchWatchlistItems (${type})`
    );
    
    // Simkl returns items in a specific format - adjust parsing based on actual API response
    const items = response.data || [];
    return Array.isArray(items) ? items : [];
  } catch (error: any) {
    logger.error(`Error fetching Simkl watchlist items: ${error.message}`);
    return [];
  }
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
    
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, {
        dispatcher: simklDispatcher,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'simkl-api-key': SIMKL_CLIENT_ID
        }
      }),
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
    
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, {
        dispatcher: simklDispatcher,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'simkl-api-key': SIMKL_CLIENT_ID
        }
      }),
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
 * @returns Array of parsed meta items
 */
async function parseSimklItems(
  items: any[],
  type: 'movie' | 'series',
  config: UserConfig,
  userUUID: string
): Promise<any[]> {
  if (!items || items.length === 0) {
    return [];
  }

  const parsedItems: any[] = [];
  
  for (const item of items) {
    try {
      // Simkl item structure - adjust based on actual API response
      // Typically includes: ids (simkl, imdb, tmdb, tvdb), title, year, etc.
      const simklId = item.ids?.simkl;
      const imdbId = item.ids?.imdb;
      const tmdbId = item.ids?.tmdb;
      const tvdbId = item.ids?.tvdb;
      
      // Determine the best ID to use for Stremio
      let stremioId: string | null = null;
      if (imdbId) {
        stremioId = imdbId.startsWith('tt') ? imdbId : `tt${imdbId}`;
      } else if (tmdbId) {
        stremioId = `tmdb:${tmdbId}`;
      } else if (tvdbId) {
        stremioId = `tvdb:${tvdbId}`;
      } else if (simklId) {
        stremioId = `simkl:${simklId}`;
      }
      
      if (!stremioId) {
        logger.debug(`Skipping Simkl item without valid ID: ${JSON.stringify(item)}`);
        continue;
      }
      
      // Fetch meta using the ID resolver
      const result = await cacheWrapMetaSmart(
        userUUID,
        stremioId,
        async () => {
          return await getMeta(type, config.language || 'en-US', stremioId!, config, userUUID, false);
        },
        undefined,
        { enableErrorCaching: true, maxRetries: 2 },
        type as any,
        false
      );
      
      if (result?.meta) {
        parsedItems.push(result.meta);
      }
    } catch (error: any) {
      logger.warn(`Error parsing Simkl item: ${error.message}`);
      continue;
    }
  }
  
  return parsedItems;
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
    
    // Build URL with interval in path
    // Format: /anime/trending/week?client_id=... (for week/month)
    // Or: /anime/trending/?extended=...&client_id=... (for default today)
    let url = `${SIMKL_BASE_URL}/${endpoint}/trending/`;
    
    // Add interval to path if not default (today)
    if (interval !== 'today') {
      url += `${interval}?`;
    } else {
      url += '?';
    }
    
    // Add extended parameters for full metadata
    url += `extended=overview,metadata,tmdb,genres,trailer&client_id=${SIMKL_CLIENT_ID}`;
    
    // Simkl API supports page and limit parameters but doesn't return pagination headers
    // We'll fetch the requested page and determine hasMore by checking if we get an empty array
    const urlWithPagination = `${url}&page=${page}&limit=${limit}`;
    
    logger.debug(`Simkl trending ${type}: interval=${interval}, page=${page}, limit=${limit}`);
    
    const response: any = await makeRateLimitedRequest(
      () => httpGet(urlWithPagination, {
        dispatcher: simklDispatcher,
        headers: {
          'Content-Type': 'application/json',
          'simkl-api-key': SIMKL_CLIENT_ID
        }
      }),
      `Simkl fetchTrendingItems (${type}, interval: ${interval}, page: ${page})`
    );

    // Simkl returns an array directly (no pagination headers)
    // If the array is empty, there are no more pages
    let rawItems: any[] = Array.isArray(response.data) ? response.data : [];
    const hasMore = rawItems.length > 0;
    
    logger.debug(`Simkl trending page ${page}: ${rawItems.length} items, hasMore: ${hasMore}`);
    
    // Map Simkl response to items (items are already in the correct format)
    const items = rawItems.map((entry: any) => {
      return {
        type: type === 'movies' ? 'movie' : 'series',
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
