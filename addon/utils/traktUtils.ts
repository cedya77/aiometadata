/**
 * Fetch Trakt Up Next episodes for a user with last_activities optimization
 * Returns object with items array and last watched timestamp
 * @param accessToken - User's Trakt access token
 * @param cachedTimestamp - Optional cached episodes.watched_at timestamp to check against
 * @returns Object with items array and watched_at timestamp
 */
async function fetchTraktUpNextEpisodes(
  accessToken: string, 
  cachedTimestamp?: string
): Promise<{ items: any[], watched_at: string }> {
  const startTime = Date.now();
  
  // First, check if anything has changed since last fetch
  const activityStart = Date.now();
  const lastActivity = await fetchTraktLastActivity(accessToken);
  const activityTime = Date.now() - activityStart;
  logger.info(`Up Next: last_activities fetch took ${activityTime}ms`);
  
  const currentWatchedAt = lastActivity?.episodes?.watched_at;
  
  // If we have a cached timestamp and nothing has changed, return empty result
  // The caller will use the cached data
  if (cachedTimestamp && currentWatchedAt && cachedTimestamp === currentWatchedAt) {
    const totalTime = Date.now() - startTime;
    logger.info(`Up Next: No changes detected (watched_at: ${currentWatchedAt}), using cached data [total: ${totalTime}ms]`);
    return { items: [], watched_at: currentWatchedAt };
  }
  
  logger.info(`Up Next: Changes detected or no cache, rebuilding list (watched_at: ${currentWatchedAt})`);
  
  // Fetch all watched shows and build the Up Next list
  const watchedStart = Date.now();
  const watchedShows = await fetchTraktWatchedShows(accessToken);
  const watchedTime = Date.now() - watchedStart;
  logger.info(`Up Next: watched shows fetch took ${watchedTime}ms (${watchedShows.length} shows)`);
  
  const progressStart = Date.now();
  
  const MAX_RESULTS = 50;
  const BATCH_SIZE = 30;
  const upNextList: any[] = [];
  let processedCount = 0;
  
  for (let i = 0; i < watchedShows.length && upNextList.length < MAX_RESULTS; i += BATCH_SIZE) {
    const remainingNeeded = MAX_RESULTS - upNextList.length;
    const batchSize = Math.min(BATCH_SIZE, watchedShows.length - i, remainingNeeded + 20); // Fetch extra to account for shows without next episodes
    const batch = watchedShows.slice(i, i + batchSize);
    
    const results = await Promise.all(
      batch.map(async (show) => {
        const showData = show.show;
        const showId = showData?.ids?.trakt;
        if (!showId) return null;
        
        try {
          // Use maxRetries of 1 (only 1 attempt, no retries) for individual show fetches
          const response: any = await makeRateLimitedRequest(
            () => httpGet(`${TRAKT_BASE_URL}/shows/${showId}/progress/watched`, {
              dispatcher: traktDispatcher,
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'trakt-api-version': '2',
                'trakt-api-key': TRAKT_CLIENT_ID
              }
            }),
            `Trakt fetchShowWatchedProgress (${showId})`,
            1  // Only 1 attempt for individual show fetches (no retries)
          );
          const progress = response.data;
          if (!progress?.next_episode) return null;
          
          const nextEp = progress.next_episode;
          return {
            type: 'show',
            show: showData,
            upNextEpisode: {
              season: nextEp.season,
              episode: nextEp.number,
              trakt_id: nextEp.ids.trakt,
              imdb_id: nextEp.ids.imdb,
              tvdb_id: nextEp.ids.tvdb,
            }
          };
        } catch (error: any) {
          logger.error(`Up Next: Failed to fetch progress for show ${showId} (${showData?.title || 'unknown'}): ${error?.message || String(error)}`);
          if (error?.response?.data) {
            logger.error(`Up Next: Trakt API response for show ${showId}: ${JSON.stringify(error.response.data)}`);
          }
          return null;
        }
      })
    );
    
    const validResults = results.filter(item => item !== null);
    upNextList.push(...validResults.slice(0, MAX_RESULTS - upNextList.length));
    processedCount += batch.length;
    
    if (upNextList.length >= MAX_RESULTS) break;
  }
  
  const progressTime = Date.now() - progressStart;
  const totalTime = Date.now() - startTime;
  logger.info(`Up Next: Built list with ${upNextList.length} shows from ${processedCount} watched shows (watched_at: ${currentWatchedAt})`);
  logger.info(`Up Next: Parallel fetches took ${progressTime}ms (avg: ${Math.round(progressTime/processedCount)}ms/show, ${BATCH_SIZE} concurrent)`);
  logger.info(`Up Next: Total rebuild time: ${totalTime}ms`);
  
  return { items: upNextList, watched_at: currentWatchedAt };
}
/**
 * Fetch Trakt last activity for a user (OAuth required)
 * @param accessToken - User's Trakt access token
 * @returns last activity object
 */
async function fetchTraktLastActivity(accessToken: string): Promise<any> {
  const url = `${TRAKT_BASE_URL}/sync/last_activities`;
  const response: any = await makeRateLimitedRequest(
    () => httpGet(url, {
      dispatcher: traktDispatcher,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': TRAKT_CLIENT_ID
      }
    }),
    'Trakt fetchLastActivity'
  );
  return response.data;
}

/**
 * Fetch watched shows for a user (OAuth required)
 * @param accessToken - User's Trakt access token
 * @returns array of watched shows
 */
async function fetchTraktWatchedShows(accessToken: string): Promise<any[]> {
  const url = `${TRAKT_BASE_URL}/sync/watched/shows?extended=noseasons`;
  const response: any = await makeRateLimitedRequest(
    () => httpGet(url, {
      dispatcher: traktDispatcher,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': TRAKT_CLIENT_ID
      }
    }),
    'Trakt fetchWatchedShows'
  );
  return Array.isArray(response.data) ? response.data : [];
}

/**
 * Fetch watched progress for a show (OAuth required)
 * @param accessToken - User's Trakt access token
 * @param showId - Trakt show ID
 * @returns watched progress object
 */
async function fetchTraktShowWatchedProgress(accessToken: string, showId: string): Promise<any> {
  const url = `${TRAKT_BASE_URL}/shows/${showId}/progress/watched`;
  const response: any = await makeRateLimitedRequest(
    () => httpGet(url, {
      dispatcher: traktDispatcher,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': TRAKT_CLIENT_ID
      }
    }),
    `Trakt fetchShowWatchedProgress (${showId})`
  );
  return response.data;
}
import { httpGet } from "./httpClient.js";
import { getMeta } from "../lib/getMeta.js";
import { cacheWrapMetaSmart } from "../lib/getCache.js";
import { UserConfig } from "../types/index.js";
import { meta } from "@eslint/js";
const consola = require('consola');
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
  tag: 'Trakt'
});

/**
 * Sanitize URL by removing access token for safe logging
 */
function sanitizeUrlForLogging(url: string): string {
  return url.replace(/(Authorization: Bearer\s+)[^\s]+/gi, '$1[REDACTED]');
}

const traktDispatcher = new Agent({ connect: { timeout: 30000 } });

/**
 * Checks if an error is a "permanent" client-side error that should not be retried.
 */
function isPermanentError(error: any): boolean {
  const status = error.response?.status;
  // Consider 4xx errors (except 429 rate limit) as permanent.
  // 401 (unauthorized) and 403 (forbidden) are permanent auth errors
  // Also treat 500 errors as permanent for individual resource fetches (likely bad data on Trakt's side)
  return (status >= 400 && status < 500 && status !== 429) || status === 500;
}

// Rate limiting configuration for Trakt API
// Trakt rate limit: 1000 requests per 5 minutes (rolling window)
const RATE_LIMIT_CONFIG = {
  maxRetries: 5,
  baseDelay: 1000, // 1 second base delay
  maxDelay: 30000, // 30 seconds max delay
  rateLimitDelay: 5000, // 5 seconds for rate limit backoff
  minInterval: 300, // Minimum 300ms between requests (1000 req / 5 min = ~3.3 req/sec)
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
 * Rate limiting and retry logic for Trakt API calls
 */
async function makeRateLimitedRequest<T>(
  requestFn: () => Promise<T>, 
  context: string = 'Trakt', 
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
      const responseTime = Date.now() - startTime;
      
      const requestTracker = require('../lib/requestTracker.js');
      requestTracker.trackProviderCall('trakt', responseTime, true);
      
      // Reset recent hits on success
      rateLimitState.recentRateLimitHits = 0;
      
      return response;
      
    } catch (error: any) {
      const responseTime = Date.now() - startTime;
      const requestTracker = require('../lib/requestTracker.js');
      requestTracker.trackProviderCall('trakt', responseTime, false);

      if (isPermanentError(error)) {
        logger.error(`Request failed with permanent error, no retry: ${error.message} - ${context}`);
        throw error;
      }
      
      if (isRateLimitError(error)) {
        rateLimitState.lastRateLimitTime = Date.now();
        rateLimitState.recentRateLimitHits++;
        
        if (isLastAttempt) {
          logger.error(`Rate limit exceeded after ${retries} attempts: ${error.message} - ${context}`);
          throw error;
        }
        
        let backoffTime = RATE_LIMIT_CONFIG.rateLimitDelay * Math.pow(2, rateLimitState.recentRateLimitHits - 1);
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

const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID || '';
const TRAKT_BASE_URL = 'https://api.trakt.tv';

interface TraktListItem {
  rank?: number;
  listed_at?: string;
  type: 'movie' | 'show';
  movie?: {
    title: string;
    year: number;
    ids: {
      trakt: number;
      slug: string;
      imdb: string;
      tmdb: number;
    };
  };
  show?: {
    title: string;
    year: number;
    ids: {
      trakt: number;
      slug: string;
      imdb: string;
      tvdb: number;
      tmdb: number;
    };
  };
  upNextEpisode?: {
    season: number;
    episode: number;
    trakt_id: number;
    imdb_id: string;
    tvdb_id: number;
  };
}

/**
 * Fetch items from Trakt watchlist
 * @param accessToken - User's Trakt access token
 * @param type - Content type filter ('movies', 'shows', or undefined for all)
 * @param page - Page number (1-indexed)
 * @param limit - Items per page
 * @param sort - Sort order (added, rank, title, released, runtime, popularity, percentage, votes, random)
 * @returns Object with items array and pagination info
 */
async function fetchTraktWatchlistItems(
  accessToken: string, 
  type: 'movies' | 'shows' | undefined,
  page: number,
  limit: number = 20,
  sort?: string,
  sortDirection?: 'asc' | 'desc',
  genre?: string
): Promise<{items: TraktListItem[], totalItems?: number, hasMore: boolean, totalPages?: number}> {
  try {
    // Construct the URL based on type
    const typeParam = type || 'all';
    const sortParam = sort || 'rank';
    const sortHow = sortDirection || 'asc';
    let url = `${TRAKT_BASE_URL}/sync/watchlist/${typeParam}/${sortParam}/${sortHow}?page=${page}&limit=${limit}`;
    if (genre && genre !== 'all' && genre !== 'none') {
      url += `&genres=${encodeURIComponent(genre)}`;
    }
    
    logger.debug(`Trakt watchlist request: type=${typeParam}, page=${page}, limit=${limit}, sort=${sortParam}, sortDirection=${sortHow}, genre=${genre || 'none'}`);
    
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, { 
        dispatcher: traktDispatcher,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': TRAKT_CLIENT_ID
        }
      }),
      `Trakt fetchWatchlistItems (type: ${typeParam}, page: ${page})`
    );
    
    // Extract pagination info from headers
    const paginationHeaders = response.headers || {};
    const totalItems = paginationHeaders['x-pagination-item-count'] 
      ? parseInt(paginationHeaders['x-pagination-item-count']) 
      : undefined;
    const pageCount = paginationHeaders['x-pagination-page-count'] 
      ? parseInt(paginationHeaders['x-pagination-page-count']) 
      : undefined;
    const currentPage = paginationHeaders['x-pagination-page']
      ? parseInt(paginationHeaders['x-pagination-page'])
      : page;
    
    const items = Array.isArray(response.data) ? response.data : [];
    const hasMore = currentPage < (pageCount || 1);
    
    logger.debug(
      `Trakt watchlist pagination - page ${currentPage}/${pageCount || '?'}, ` +
      `items: ${items.length}, totalItems: ${totalItems || '?'}, hasMore: ${hasMore}`
    );
    
    return {
      items,
      totalItems,
      hasMore,
      totalPages: pageCount
    };
  } catch (err: any) {
    logger.error(`Error fetching Trakt watchlist, page ${page}:`, err.message);
    return { items: [], hasMore: false };
  }
}

/**
 * Fetch user's favorite items from Trakt
 * @param accessToken - User's Trakt access token
 * @param type - Content type ('movies' or 'shows')
 * @param page - Page number (1-indexed)
 * @param limit - Items per page
 * @param sort - Sort order
 * @returns Object with items array and pagination info
 */
async function fetchTraktFavoritesItems(
  accessToken: string, 
  type: 'movies' | 'shows',
  page: number,
  limit: number = 20,
  sort?: string,
  sortDirection?: 'asc' | 'desc',
  genre?: string
): Promise<{items: TraktListItem[], totalItems?: number, hasMore: boolean, totalPages?: number}> {
  try {
    const sortParam = sort || 'rank';
    const sortHow = sortDirection || 'asc';
    let url = `${TRAKT_BASE_URL}/sync/favorites/${type}/${sortParam}/${sortHow}?page=${page}&limit=${limit}`;
    if (genre && genre !== 'all' && genre !== 'none') {
      url += `&genres=${encodeURIComponent(genre)}`;
    }
    
    logger.debug(`Trakt favorites request: type=${type}, page=${page}, limit=${limit}, sort=${sortParam}, sortDirection=${sortHow}, genre=${genre || 'none'}`);
    
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, { 
        dispatcher: traktDispatcher,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': TRAKT_CLIENT_ID
        }
      }),
      `Trakt fetchFavoritesItems (type: ${type}, page: ${page})`
    );
    
    // Extract pagination info from headers
    const paginationHeaders = response.headers || {};
    const totalItems = paginationHeaders['x-pagination-item-count'] 
      ? parseInt(paginationHeaders['x-pagination-item-count']) 
      : undefined;
    const pageCount = paginationHeaders['x-pagination-page-count'] 
      ? parseInt(paginationHeaders['x-pagination-page-count']) 
      : undefined;
    const currentPage = paginationHeaders['x-pagination-page']
      ? parseInt(paginationHeaders['x-pagination-page'])
      : page;
    
    const items = Array.isArray(response.data) ? response.data : [];
    const hasMore = currentPage < (pageCount || 1);
    
    logger.debug(
      `Trakt favorites pagination - type: ${type}, page ${currentPage}/${pageCount || '?'}, ` +
      `items: ${items.length}, totalItems: ${totalItems || '?'}, hasMore: ${hasMore}`
    );
    
    return {
      items,
      totalItems,
      hasMore,
      totalPages: pageCount
    };
  } catch (err: any) {
    logger.error(`Error fetching Trakt favorites for type ${type}, page ${page}:`, err.message);
    return { items: [], hasMore: false };
  }
}

/**
 * Fetch user's recommendations from Trakt
 * @param accessToken - User's Trakt access token
 * @param type - Content type ('movies' or 'shows')
 * @param page - Page number (1-indexed)
 * @param limit - Items per page
 * @returns Object with items array and pagination info
 */
async function fetchTraktRecommendationsItems(
  accessToken: string,
  type: 'movies' | 'shows',
  page: number,
  limit: number = 50
): Promise<{items: TraktListItem[], totalItems?: number, hasMore: boolean, totalPages?: number}> {
  try {
    // Trakt recommendations endpoint doesn't support pagination, only a limit (max 100)
    // We use limit=50 and ignore the page parameter
    const recommendationsLimit = 50;
    const url = `${TRAKT_BASE_URL}/recommendations/${type}?limit=${recommendationsLimit}&ignore_collected=false&ignore_watchlisted=false`;
    
    logger.debug(`Trakt recommendations request: type=${type}, limit=${recommendationsLimit}`);
    
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, { 
        dispatcher: traktDispatcher,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': TRAKT_CLIENT_ID
        }
      }),
      `Trakt fetchRecommendationsItems (type: ${type}, page: ${page})`
    );
    
    // Extract pagination info from headers
    const paginationHeaders = response.headers || {};
    const totalItems = paginationHeaders['x-pagination-item-count'] 
      ? parseInt(paginationHeaders['x-pagination-item-count']) 
      : undefined;
    const pageCount = paginationHeaders['x-pagination-page-count'] 
      ? parseInt(paginationHeaders['x-pagination-page-count']) 
      : undefined;
    const currentPage = paginationHeaders['x-pagination-page']
      ? parseInt(paginationHeaders['x-pagination-page'])
      : page;
    
    // Transform recommendations to match list item format
    // Recommendations return movies/shows directly, not wrapped in list items
    const rawItems = Array.isArray(response.data) ? response.data : [];
    const items = rawItems.map((media: any) => ({
      type: type === 'movies' ? 'movie' : 'show',
      movie: type === 'movies' ? media : undefined,
      show: type === 'shows' ? media : undefined
    }));
    
    // Trakt recommendations endpoint does NOT support pagination
    // We fetch a single batch of results with limit=50
    const hasMore = false;
    
    logger.debug(
      `Trakt recommendations - type: ${type}, items: ${items.length}, hasMore: ${hasMore}`
    );
    return {
      items,
      totalItems,
      hasMore,
      totalPages: pageCount
    };
  } catch (err: any) {
    logger.error(`Error fetching Trakt recommendations for type ${type}, page ${page}:`, err.message);
    return { items: [], hasMore: false };
  }
}

/**
 * Fetch items from a Trakt custom list
 * @param username - List owner's username
 * @param listSlug - List identifier slug
 * @param accessToken - User's Trakt access token
 * @param type - Content type filter ('movies', 'shows', or undefined for all)
 * @param page - Page number (1-indexed)
 * @param limit - Items per page
 * @param sort - Sort order
 * @returns Object with items array and pagination info
 */
async function fetchTraktListItems(
  username: string,
  listSlug: string,
  accessToken: string,
  type: 'movies' | 'shows' | undefined,
  page: number,
  limit: number = 20,
  sort?: string,
  genre?: string,
  sortDirection?: 'asc' | 'desc'
): Promise<{items: TraktListItem[], totalItems?: number, hasMore: boolean, totalPages?: number}> {
  try {
    const typeParam = type || 'all';
    let url = `${TRAKT_BASE_URL}/users/${username}/lists/${listSlug}/items/${typeParam}?page=${page}&limit=${limit}`;
    if (sort) {
      url += `&sort_by=${encodeURIComponent(sort)}`;
      if (sortDirection) {
        url += `&sort_how=${sortDirection}`;
      }
    }
    if (genre && genre.toLowerCase() !== 'all' && genre.toLowerCase() !== 'none') {
      url += `&genres=${encodeURIComponent(genre)}`;
    }
    logger.debug(`Trakt list request: user=${username}, list=${listSlug}, type=${typeParam}, page=${page}, sort=${sort || 'default'}, sortDirection=${sortDirection || 'default'}, genre=${genre || 'none'}`);
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, { 
        dispatcher: traktDispatcher,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': TRAKT_CLIENT_ID
        }
      }),
      `Trakt fetchListItems (${username}/${listSlug}, page: ${page}, genre: ${genre || 'none'})`
    );
    
    // Extract pagination info from headers
    const paginationHeaders = response.headers || {};
    const totalItems = paginationHeaders['x-pagination-item-count'] 
      ? parseInt(paginationHeaders['x-pagination-item-count']) 
      : undefined;
    const pageCount = paginationHeaders['x-pagination-page-count'] 
      ? parseInt(paginationHeaders['x-pagination-page-count']) 
      : undefined;
    const currentPage = paginationHeaders['x-pagination-page']
      ? parseInt(paginationHeaders['x-pagination-page'])
      : page;
    
    const items = Array.isArray(response.data) ? response.data : [];
    const hasMore = currentPage < (pageCount || 1);
    
    logger.debug(
      `Trakt list pagination - ${username}/${listSlug} page ${currentPage}/${pageCount || '?'}, ` +
      `items: ${items.length}, totalItems: ${totalItems || '?'}, hasMore: ${hasMore}`
    );
    
    return {
      items,
      totalItems,
      hasMore,
      totalPages: pageCount
    };
  } catch (err: any) {
    logger.error(`Error fetching Trakt list ${username}/${listSlug}, page ${page}:`, err.message);
    return { items: [], hasMore: false };
  }
}

/**
 * Fetch genres from Trakt API
 * @param type - 'movies' or 'shows'
 * @returns Array of genre slugs
 */
async function fetchTraktGenres(type: 'movies' | 'shows'): Promise<string[]> {
  try {
    // Use cache wrapper to avoid repeated API calls
    const { cacheWrapTraktGenres } = require('../lib/getCache.js');
    
    return await cacheWrapTraktGenres(type, async () => {
      const url = `${TRAKT_BASE_URL}/genres/${type}`;
      
      logger.debug(`Fetching Trakt genres from API for type: ${type}`);
      
      const response: any = await makeRateLimitedRequest(
        () => httpGet(url, { 
          dispatcher: traktDispatcher,
          headers: {
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': TRAKT_CLIENT_ID
          }
        }),
        `Trakt fetchGenres (${type})`
      );
      
      if (!Array.isArray(response.data)) {
        logger.warn(`Trakt genres API returned non-array response for ${type}`);
        return [];
      }
      
      // Trakt returns objects like: { name: "Action", slug: "action" }
      const genres = response.data
        .map((g: any) => g.slug)
        .filter(Boolean);
      
      logger.info(`Successfully fetched and cached ${genres.length} ${type} genres from Trakt API`);
      return genres;
    });
  } catch (err: any) {
    logger.error(`Error fetching Trakt genres for ${type}:`, err.message);
    return [];
  }
}

/**
 * Parse Trakt items and convert to Stremio meta format
 * @param items - Array of Trakt list items
 * @param type - Catalog type ('movie' or 'series')
 * @param language - Language code
 * @param config - User configuration
 * @param includeVideos - Whether to include video data
 * @returns Array of Stremio meta objects
 */
async function parseTraktItems(
  items: TraktListItem[], 
  type: string, 
  language: string, 
  config: UserConfig, 
  includeVideos: boolean = false
): Promise<any[]> {
  const parseStart = Date.now();
  
  // Filter items by type
  const filteredItems = items.filter(item => {
    if (type === 'movie') return item.type === 'movie';
    if (type === 'series') return item.type === 'show';
    return true; // 'all' type
  });
  
  logger.info(`Up Next: Parsing ${filteredItems.length} Trakt items (filtered from ${items.length} total)`);
  
  const getMetaTimings: number[] = [];
  
  const metas = await Promise.all(
    filteredItems.map(async (item: TraktListItem, index: number) => {
      const itemStart = Date.now();
      try {
        // Get the media object based on type
        const media = item.movie || item.show;
        if (!media) {
          logger.warn(`Trakt item missing media object:`, item);
          return null;
        }
        
        const isUpNext = !!item.upNextEpisode;
        const upNextEpisode = item.upNextEpisode;
        
        let stremioId: string;
        if (media.ids.imdb) {
          stremioId = media.ids.imdb;
        } else if (media.ids.tmdb) {
          stremioId = `tmdb:${media.ids.tmdb}`;
        } else if (item.type === 'show' && (media as any).ids.tvdb) {
          stremioId = `tvdb:${(media as any).ids.tvdb}`;
        } else {
          logger.warn(`Trakt item has no usable ID:`, media.ids);
          return null;
        }
        
        const metaType = item.type === 'movie' ? 'movie' : 'series';
        
        // For Up Next items, use a unique cache key with shorter TTL
        const cacheId = isUpNext ? `upnext_${stremioId}` : stremioId;
        
        const shouldIncludeVideos = isUpNext ? true : includeVideos;
        
        const getMetaStart = Date.now();
        const result = await cacheWrapMetaSmart(
          config.userUUID, 
          cacheId, 
          async () => {
            const metaResult = await getMeta(metaType, language, stremioId, config, config.userUUID, shouldIncludeVideos);
            
            if (isUpNext && upNextEpisode && metaResult?.meta?.videos && Array.isArray(metaResult.meta.videos)) {
              const upNextVideo = metaResult.meta.videos.find((v: any) => 
                v.season === upNextEpisode.season && 
                v.episode === upNextEpisode.episode
              );
              
              if (upNextVideo) {
                metaResult.meta.videos = [upNextVideo];
                metaResult.meta.behaviorHints = metaResult.meta.behaviorHints || {};
                metaResult.meta.behaviorHints.defaultVideoId = upNextVideo.id;
                metaResult.meta.poster = upNextVideo.thumbnail;
                metaResult.meta.name = `${metaResult.meta.name} - S${upNextEpisode.season}E${upNextEpisode.episode}`;
                metaResult.meta.posterShape = 'landscape';
                metaResult.meta.id = cacheId;
                // ...removed Up Next filter debug log...
              } else {
                logger.warn(`Up Next episode S${upNextEpisode.season}E${upNextEpisode.episode} not found in videos for ${metaResult.meta.name}`);
              }
            }
            
            return metaResult;
          }, 
          undefined, 
          { enableErrorCaching: true, maxRetries: 2 }, 
          type as any, 
          shouldIncludeVideos
        );
        
        const getMetaTime = Date.now() - getMetaStart;
        getMetaTimings.push(getMetaTime);
        
        const itemTime = Date.now() - itemStart;
        // ...removed Up Next getMeta debug log...
        
        if (result && result.meta) {
          return result.meta;
        }
        return null;
      } catch (error: any) {
        logger.error(`Error getting meta for Trakt item:`, error.message);
        return null;
      }
    })
  );
  
  const validMetas = metas.filter(Boolean);
  const totalParseTime = Date.now() - parseStart;
  const avgGetMetaTime = getMetaTimings.length > 0 ? Math.round(getMetaTimings.reduce((a, b) => a + b, 0) / getMetaTimings.length) : 0;
  const maxGetMetaTime = getMetaTimings.length > 0 ? Math.max(...getMetaTimings) : 0;
  const minGetMetaTime = getMetaTimings.length > 0 ? Math.min(...getMetaTimings) : 0;
  
  logger.info(`Up Next: Successfully parsed ${validMetas.length} Trakt items into metas`);
  logger.info(`Up Next: getMeta timings - avg: ${avgGetMetaTime}ms, min: ${minGetMetaTime}ms, max: ${maxGetMetaTime}ms`);
  logger.info(`Up Next: Total parsing time: ${totalParseTime}ms`);
  
  return validMetas;
}

/**
 * Get list details from Trakt
 * @param username - List owner's username
 * @param listSlug - List identifier slug
 * @param accessToken - User's Trakt access token
 * @returns List details object
 */
async function getTraktListDetails(
  username: string,
  listSlug: string,
  accessToken: string
): Promise<any> {
  try {
    const url = `${TRAKT_BASE_URL}/users/${username}/lists/${listSlug}`;
    
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, { 
        dispatcher: traktDispatcher,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': TRAKT_CLIENT_ID
        }
      }),
      `Trakt getTraktListDetails (${username}/${listSlug})`
    );
    
    return response.data || null;
  } catch (err: any) {
    logger.error(`Error fetching Trakt list details for ${username}/${listSlug}:`, err.message);
    return null;
  }
}

export { 
  fetchTraktWatchlistItems, 
  fetchTraktFavoritesItems,
  fetchTraktRecommendationsItems,
  fetchTraktListItems, 
  fetchTraktGenres,
  parseTraktItems,
  getTraktListDetails,
  fetchTraktUpNextEpisodes
};


/**
 * Fetch most favorited movies or shows from Trakt for a given period
 * @param type - 'movies' or 'shows'
 * @param period - 'daily', 'weekly', 'monthly', 'all'
 * @param page - Page number (1-indexed)
 * @param limit - Items per page (max 100)
 * @returns Object with items array and pagination info
 */
async function fetchTraktMostFavoritedItems(
  type: 'movies' | 'shows',
  period: 'daily' | 'weekly' | 'monthly' | 'all',
  page: number = 1,
  limit: number = 20,
  genre?: string
): Promise<{items: any[], totalItems?: number, hasMore: boolean, totalPages?: number}> {
  try {
    let url = `${TRAKT_BASE_URL}/${type}/favorited/${period}?page=${page}&limit=${limit}`;
    if (genre && genre !== 'all' && genre !== 'none') {
      url += `&genres=${encodeURIComponent(genre)}`;
    }
    logger.debug(`Trakt most favorited ${type}: period=${period}, page=${page}, limit=${limit}, genre=${genre || 'none'}`);
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, {
        dispatcher: traktDispatcher,
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': TRAKT_CLIENT_ID
        }
      }),
      `Trakt fetchMostFavoritedItems (${type}, period: ${period}, page: ${page}, genre: ${genre || 'none'})`
    );
    const paginationHeaders = response.headers || {};
    const totalItems = paginationHeaders['x-pagination-item-count'] 
      ? parseInt(paginationHeaders['x-pagination-item-count']) 
      : undefined;
    const pageCount = paginationHeaders['x-pagination-page-count'] 
      ? parseInt(paginationHeaders['x-pagination-page-count']) 
      : undefined;
    const currentPage = paginationHeaders['x-pagination-page']
      ? parseInt(paginationHeaders['x-pagination-page'])
      : page;
    const rawItems = Array.isArray(response.data) ? response.data : [];
    const items = rawItems.map((entry: any) => {
      const media = entry?.movie || entry?.show || entry;
      const itemType = type === 'movies' ? 'movie' : 'show';
      return {
        type: itemType,
        movie: itemType === 'movie' ? media : undefined,
        show: itemType === 'show' ? media : undefined
      } as TraktListItem;
    });
    const hasMore = currentPage < (pageCount || 1);
    logger.debug(
      `Trakt most favorited ${type} pagination - period ${period} page ${currentPage}/${pageCount || '?'}, ` +
      `items: ${items.length}, totalItems: ${totalItems || '?'}, hasMore: ${hasMore}`
    );
    return {
      items,
      totalItems,
      hasMore,
      totalPages: pageCount
    };
  } catch (err: any) {
    logger.error(`Error fetching Trakt most favorited ${type} for period ${period}, page ${page}:`, err.message);
    return { items: [], hasMore: false };
  }
}

export {
  fetchTraktMostFavoritedItems
};
