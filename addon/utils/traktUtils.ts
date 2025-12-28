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
  
  // Fetch all watched shows and dropped shows
  const watchedStart = Date.now();
  const [watchedShows, droppedShowIds] = await Promise.all([
    fetchTraktWatchedShows(accessToken),
    fetchTraktDroppedShows(accessToken)
  ]);
  const watchedTime = Date.now() - watchedStart;
  
  // Filter out dropped shows
  const activeWatchedShows = watchedShows.filter(show => {
    const showId = show?.show?.ids?.trakt;
    return showId && !droppedShowIds.has(showId);
  });
  
  logger.info(`Up Next: watched shows fetch took ${watchedTime}ms (${watchedShows.length} total, ${activeWatchedShows.length} active after filtering ${droppedShowIds.size} dropped)`);
  
  const progressStart = Date.now();
  
  const MAX_RESULTS = 50;
  const BATCH_SIZE = 30;
  const upNextList: any[] = [];
  let processedCount = 0;
  
  for (let i = 0; i < activeWatchedShows.length && upNextList.length < MAX_RESULTS; i += BATCH_SIZE) {
    const remainingNeeded = MAX_RESULTS - upNextList.length;
    const batchSize = Math.min(BATCH_SIZE, activeWatchedShows.length - i, remainingNeeded + 20); // Fetch extra to account for shows without next episodes
    const batch = activeWatchedShows.slice(i, i + batchSize);
    
    const results = await Promise.all(
      batch.map(async (show) => {
        const showData = show.show;
        const showId = showData?.ids?.trakt;
        if (!showId) return null;
        
        try {
          // Use up to 3 attempts for individual show fetches
          const response: any = await makeRateLimitedRequest(
            () => httpGet(`${TRAKT_BASE_URL}/shows/${showId}/progress/watched`, {
              dispatcher: traktDispatcher,
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'trakt-api-version': '2',
                'trakt-api-key': TRAKT_CLIENT_ID,
                'User-Agent': `AIOMetadata/${process.env.npm_package_version || 'dev'} (https://github.com/AIOMetadata/AIOMetadata)`
              },
              params: {
                'now': Date.now() 
              }
            }),
            `Trakt fetchShowWatchedProgress (${showId})`,
            3  // Allow up to 3 attempts for individual show fetches
          );
          const progress = response.data;
          if (!progress?.next_episode) return null;
          const nextEp = progress.next_episode;          
          // Skip episodes that haven't aired yet
          if (nextEp.first_aired) {
            const airedDate = new Date(nextEp.first_aired);
            const now = new Date();
            if (airedDate > now) {
              logger.debug(`Up Next: Skipping ${showData?.title} S${nextEp.season}E${nextEp.number} - airs on ${airedDate.toISOString()}`);
              return null;
            }
          }
          
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
 * Fetch dropped shows for a user (OAuth required)
 * Handles pagination to fetch all dropped shows across multiple pages
 * @param accessToken - User's Trakt access token
 * @returns Set of dropped show IDs
 */
async function fetchTraktDroppedShows(accessToken: string): Promise<Set<number>> {
  try {
    const droppedIds = new Set<number>();
    let currentPage = 1;
    let totalPages = 1;
    const limit = 100; // Max items per page
    
    // Loop through all pages
    do {
      const url = `${TRAKT_BASE_URL}/users/hidden/dropped?type=show&page=${currentPage}&limit=${limit}`;
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
        'Trakt fetchDroppedShows'
      );
      
      // Extract pagination info from headers
      const paginationHeaders = response.headers || {};
      totalPages = paginationHeaders['x-pagination-page-count'] 
        ? parseInt(paginationHeaders['x-pagination-page-count']) 
        : 1;
      const totalItems = paginationHeaders['x-pagination-item-count'] 
        ? parseInt(paginationHeaders['x-pagination-item-count']) 
        : 0;
      
      // Add dropped show IDs from this page
      if (Array.isArray(response.data)) {
        for (const item of response.data) {
          if (item?.show?.ids?.trakt) {
            droppedIds.add(item.show.ids.trakt);
          }
        }
      }
      
      logger.debug(`Dropped shows page ${currentPage}/${totalPages}: ${response.data?.length || 0} items, total: ${totalItems}`);
      currentPage++;
    } while (currentPage <= totalPages);
    
    logger.info(`Fetched ${droppedIds.size} dropped shows from Trakt (${totalPages} page${totalPages !== 1 ? 's' : ''})`);
    return droppedIds;
  } catch (error: any) {
    logger.error(`Failed to fetch dropped shows: ${error?.message || String(error)}`);
    return new Set<number>(); // Return empty set on error, don't fail the whole operation
  }
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
/**
 * Fetch Trakt Unwatched episodes for all shows with progress (<100%)
 * Returns object with items array and last watched timestamp
 * Each item includes an array of unwatched episodes to render
 */
async function fetchTraktUnwatchedEpisodes(
  accessToken: string,
  cachedTimestamp?: string
): Promise<{ items: any[], watched_at: string }> {
  const startTime = Date.now();

  const activityStart = Date.now();
  const lastActivity = await fetchTraktLastActivity(accessToken);
  const activityTime = Date.now() - activityStart;
  logger.info(`Unwatched: last_activities fetch took ${activityTime}ms`);

  const currentWatchedAt = lastActivity?.episodes?.watched_at;
  if (cachedTimestamp && currentWatchedAt && cachedTimestamp === currentWatchedAt) {
    const totalTime = Date.now() - startTime;
    logger.info(`Unwatched: No changes detected (watched_at: ${currentWatchedAt}), using cached data [total: ${totalTime}ms]`);
    return { items: [], watched_at: currentWatchedAt };
  }

  logger.info(`Unwatched: Changes detected or no cache, rebuilding list (watched_at: ${currentWatchedAt})`);

  const watchedStart = Date.now();
  const [watchedShows, droppedShowIds] = await Promise.all([
    fetchTraktWatchedShows(accessToken),
    fetchTraktDroppedShows(accessToken)
  ]);
  const watchedTime = Date.now() - watchedStart;
  
  // Filter out dropped shows
  const activeWatchedShows = watchedShows.filter(show => {
    const showId = show?.show?.ids?.trakt;
    return showId && !droppedShowIds.has(showId);
  });
  
  logger.info(`Unwatched: watched shows fetch took ${watchedTime}ms (${watchedShows.length} total, ${activeWatchedShows.length} active after filtering ${droppedShowIds.size} dropped)`);

  const MAX_SHOWS = 50; // cap number of series to avoid overlong pages
  const BATCH_SIZE = 30;
  const items: any[] = [];
  let processedCount = 0;

  for (let i = 0; i < activeWatchedShows.length && items.length < MAX_SHOWS; i += BATCH_SIZE) {
    const remainingNeeded = MAX_SHOWS - items.length;
    const batchSize = Math.min(BATCH_SIZE, activeWatchedShows.length - i, remainingNeeded + 20);
    const batch = activeWatchedShows.slice(i, i + batchSize);

    const results = await Promise.all(
      batch.map(async (show) => {
        const showData = show.show;
        const showId = showData?.ids?.trakt;
        if (!showId) return null;

        try {
          const response: any = await makeRateLimitedRequest(
            () => httpGet(`${TRAKT_BASE_URL}/shows/${showId}/progress/watched?specials=false&count_specials=false`, {
              dispatcher: traktDispatcher,
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'trakt-api-version': '2',
                'trakt-api-key': TRAKT_CLIENT_ID
              }
            }),
            `Trakt fetchShowWatchedProgress (unwatched ${showId})`,
            1
          );
          const progress = response.data;
          if (!progress?.seasons || !Array.isArray(progress.seasons)) return null;

          // Only include shows that are not 100% complete and have unwatched aired episodes
          if (progress.completed >= progress.aired) return null;

          logger.debug(`Unwatched: access token ${accessToken}`);
          // Fetch seasons with episode air dates to sort accurately
          const showSeasonsResp: any = await makeRateLimitedRequest(
            () => httpGet(`${TRAKT_BASE_URL}/shows/${showId}/seasons?extended=full,episodes`, {
              dispatcher: traktDispatcher,
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'trakt-api-version': '2',
                'trakt-api-key': TRAKT_CLIENT_ID
              }
            }),
            `Trakt fetchShowSeasons (unwatched ${showId})`,
            1
          );
          const seasonsData = Array.isArray(showSeasonsResp.data) ? showSeasonsResp.data : [];
          const airedMap = new Map<string, string>();
          for (const season of seasonsData) {
            if (!season?.episodes || season.number === 0) continue; // skip specials
            for (const ep of season.episodes) {
              if (ep.first_aired) {
                airedMap.set(`S${season.number}E${ep.number}`, ep.first_aired);
              }
            }
          }

          const unwatched: Array<{season:number; episode:number; ids:any; aired?: string}> = [];
          let mostRecentAired: string | null = null;
          
          // Get the next_episode to determine where the user's progress is
          const nextEp = progress.next_episode;
          let startSeason = 1;
          let startEpisode = 1;
          
          if (nextEp) {
            startSeason = nextEp.season;
            startEpisode = nextEp.number;
          }
          
          for (const season of progress.seasons) {
            if (!season?.episodes || season.number === 0) continue; // skip specials
            
            // Skip seasons before the current progress
            if (season.number < startSeason) continue;
            
            for (const ep of season.episodes) {
              if (!ep?.completed) {
                // Skip episodes before the next_episode in the same season
                if (season.number === startSeason && ep.number < startEpisode) continue;
                
                const epKey = `S${season.number}E${ep.number}`;
                const aired = ep.first_aired || airedMap.get(epKey) || null;
                unwatched.push({
                  season: season.number,
                  episode: ep.number,
                  ids: ep.ids || {},
                  aired: aired
                });
                
                // Track most recent aired date for this show
                if (aired && (!mostRecentAired || new Date(aired) > new Date(mostRecentAired))) {
                  mostRecentAired = aired;
                }
              }
            }
          }

          if (unwatched.length === 0) return null;

          return {
            type: 'show',
            show: showData,
            unwatchedEpisodes: unwatched,
            mostRecentAired: mostRecentAired
          };
        } catch (error: any) {
          logger.error(`Unwatched: Failed to fetch progress for show ${showId} (${showData?.title || 'unknown'}): ${error?.message || String(error)}`);
          if (error?.response?.data) {
            logger.error(`Unwatched: Trakt API response for show ${showId}: ${JSON.stringify(error.response.data)}`);
          }
          return null;
        }
      })
    );

    const valid = results.filter(x => x !== null);
    items.push(...valid.slice(0, MAX_SHOWS - items.length));
    processedCount += batch.length;
  }

  // Sort by most recent aired episode (newest first)
  items.sort((a: any, b: any) => {
    const aDate = a.mostRecentAired ? new Date(a.mostRecentAired).getTime() : 0;
    const bDate = b.mostRecentAired ? new Date(b.mostRecentAired).getTime() : 0;
    return bDate - aDate; // Descending order (newest first)
  });

  const totalTime = Date.now() - startTime;
  logger.info(`Unwatched: Built list with ${items.length} shows from ${processedCount} watched shows, sorted by most recent aired (watched_at: ${currentWatchedAt}) [total: ${totalTime}ms]`);

  return { items, watched_at: currentWatchedAt };
}
import { httpGet } from "./httpClient.js";
import { getMeta } from "../lib/getMeta.js";
import { cacheWrapMetaSmart } from "../lib/getCache.js";
import { UserConfig } from "../types/index.js";
import { meta } from "@eslint/js";
const consola = require('consola');
const { Agent } = require('undici');

const logger = consola.withTag('Trakt');

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
  // 500 errors are now retryable since they can be transient on Trakt's side
  return status >= 400 && status < 500 && status !== 429;
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
 * Extract retry delay from Trakt's Retry-After header (in seconds)
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

  // Log X-Ratelimit header for debugging if available
  const rateLimitInfo = headers['x-ratelimit'] || headers['X-Ratelimit'];
  if (rateLimitInfo) {
    try {
      const info = typeof rateLimitInfo === 'string' ? JSON.parse(rateLimitInfo) : rateLimitInfo;
      logger.debug(`Trakt rate limit info: ${info.name}, remaining: ${info.remaining}/${info.limit}, resets: ${info.until}`);
    } catch (e) {
      // Ignore parse errors
    }
  }

  return fallbackMs;
}

/**
 * Get a stable episode identifier part for cache keys.
 * Handles multiple shapes: { trakt_id }, { ids: { trakt } }, or { season, episode/number }
 */
function getEpisodeIdPart(ep: any): string {
  const traktId = (ep as any).trakt_id ?? (ep as any).ids?.trakt;
  if (traktId) return `trakt${traktId}`;
  const season = ep?.season;
  const episode = (ep as any).episode ?? (ep as any).number;
  if (season != null && episode != null) return `S${season}E${String(episode).padStart(2, '0')}`;
  return 'unknown';
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

        // Use Trakt's Retry-After header if available, otherwise fall back to exponential backoff
        const fallbackDelay = RATE_LIMIT_CONFIG.rateLimitDelay * Math.pow(2, rateLimitState.recentRateLimitHits - 1);
        const totalDelay = Math.min(getRetryAfterMs(error, fallbackDelay), RATE_LIMIT_CONFIG.maxDelay);

        logger.warn(`Rate limit hit (429). Retrying in ${Math.round(totalDelay / 1000)}s (attempt ${attempt}/${retries}) - ${context}`);

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
  unwatchedEpisodes?: Array<{
    season: number;
    episode: number;
    ids: {
      trakt?: number;
      imdb?: string;
      tvdb?: number;
    };
    aired?: string;
  }>;
  mostRecentAired?: string;
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
    if (genre && genre.toLowerCase() !== 'all' && genre.toLowerCase() !== 'none') {
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
    if (genre && genre.toLowerCase() !== 'all' && genre.toLowerCase() !== 'none') {
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
          ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {}),
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
 * Fetch items from a Trakt list by its numeric Trakt list ID
 * @param listId - Numeric Trakt list id
 * @param accessToken - User's Trakt access token
 * @param type - Content type filter ('movies', 'shows', or undefined for all)
 * @param page - Page number (1-indexed)
 * @param limit - Items per page
 * @param sort - Sort order
 * @param genre - Genre filter
 * @param sortDirection - 'asc' or 'desc'
 */
async function fetchTraktListItemsById(
  listId: string | number,
  accessToken: string,
  type: 'movies' | 'shows' | undefined,
  page: number,
  limit: number = 20,
  sort?: string,
  genre?: string,
  sortDirection?: 'asc' | 'desc'
): Promise<{items: TraktListItem[], totalItems?: number, hasMore: boolean, totalPages?: number}> {
  try {
    const typeParam = type || 'movie,show';
    let url = `${TRAKT_BASE_URL}/lists/${listId}/items/${typeParam}?page=${page}&limit=${limit}`;
    if (sort) {
      url += `&sort_by=${encodeURIComponent(sort)}`;
      if (sortDirection) {
        url += `&sort_how=${sortDirection}`;
      }
    }
    if (genre && genre.toLowerCase() !== 'all' && genre.toLowerCase() !== 'none') {
      url += `&genres=${encodeURIComponent(genre)}`;
    }

    logger.debug(`Trakt list request by id: listId=${listId}, type=${typeParam}, page=${page}, sort=${sort || 'default'}, sortDirection=${sortDirection || 'default'}, genre=${genre || 'none'}`);
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, { 
        dispatcher: traktDispatcher,
        headers: {
          ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {}),
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': TRAKT_CLIENT_ID
        }
      }),
      `Trakt fetchListItemsById (${listId}, page: ${page}, genre: ${genre || 'none'})`
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

    const items = Array.isArray(response.data) ? response.data : [];
    const hasMore = currentPage < (pageCount || 1);

    logger.debug(
      `Trakt list pagination by id - ${listId} page ${currentPage}/${pageCount || '?'}, ` +
      `items: ${items.length}, totalItems: ${totalItems || '?'}, hasMore: ${hasMore}`
    );

    return {
      items,
      totalItems,
      hasMore,
      totalPages: pageCount
    };
  } catch (err: any) {
    logger.error(`Error fetching Trakt list by id ${listId}, page ${page}:`, err.message);
    return { items: [], hasMore: false };
  }
}

/**
 * Fetch genres from Trakt API
 * @param type - 'movies' or 'shows'
 * @returns Array of genre slugs
 */
async function fetchTraktGenres(type: 'movies' | 'shows' | 'all'): Promise<any[]> {
  if (type === 'all') {
    try {
      const [movies, shows] = await Promise.all([
        fetchTraktGenres('movies'),
        fetchTraktGenres('shows')
      ]);
      
      // Combine
      const combined = [...movies, ...shows];
      
      // Deduplicate by slug using a Map
      const uniqueMap = new Map();
      combined.forEach(item => {
        if (item && item.slug) {
          uniqueMap.set(item.slug, item);
        }
      });
      
      const unique = Array.from(uniqueMap.values());
      
      // Sort alphabetically by name
      return unique.sort((a: any, b: any) => a.name.localeCompare(b.name));
    } catch (err) {
      return [];
    }
  }

  try {
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

      // Return objects with name and slug
      const genres = response.data
        .map((g: any) => ({ name: g.name, slug: g.slug }))
        .filter((g: any) => g.name && g.slug);

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
  includeVideos: boolean = false,
  useShowPoster: boolean = false
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
        const hasUnwatchedList = Array.isArray((item as any).unwatchedEpisodes) && (item as any).unwatchedEpisodes.length > 0;
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
        
        // For Up Next items, use a unique cache key that includes the next-episode identifier
        // so cached metas update when the user's next episode advances.
        let cacheId: string;
        if (isUpNext && upNextEpisode) {
          const epIdPart = getEpisodeIdPart(upNextEpisode);
          cacheId = `upnext_${stremioId}_${epIdPart}`;
        } else {
          cacheId = hasUnwatchedList ? `unwatched_${stremioId}` : stremioId;
        }
        
        const shouldIncludeVideos = (isUpNext || hasUnwatchedList) ? true : includeVideos;
        
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
                
                // Check if user wants to use show poster or episode thumbnail
                if (!useShowPoster) {
                  metaResult.meta.poster = upNextVideo.thumbnail;
                  metaResult.meta.posterShape = 'landscape';
                }
                // If useShowPoster is true, keep the original show poster and posterShape
                
                metaResult.meta.name = `${metaResult.meta.name} - S${upNextEpisode.season}E${upNextEpisode.episode}`;
                metaResult.meta.id = cacheId;
                // ...removed Up Next filter debug log...
              } else {
                logger.warn(`Up Next episode S${upNextEpisode.season}E${upNextEpisode.episode} not found in videos for ${metaResult.meta.name}`);
              }
            } else if (hasUnwatchedList && metaResult?.meta?.videos && Array.isArray(metaResult.meta.videos)) {
              const list = (item as any).unwatchedEpisodes as Array<{season:number; episode:number; ids:any}>;
              const wanted = new Set(list.map(e => `S${e.season}E${e.episode}`));
              const filtered = metaResult.meta.videos.filter((v: any) => wanted.has(`S${v.season}E${v.episode}`));
              if (filtered.length > 0) {
                metaResult.meta.videos = filtered;
                metaResult.meta.id = cacheId;
              } else {
                logger.warn(`Unwatched episodes not found in videos for ${metaResult.meta.name}; leaving original videos`);
              }
            }
            
            return metaResult;
          }, 
          undefined, 
          { enableErrorCaching: true, maxRetries: 2 }, 
          type as any, 
          shouldIncludeVideos,
          useShowPoster
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
          ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {}),
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

/**
 * Get list details by numeric Trakt list ID
 * @param listId - Numeric Trakt list id
 * @param accessToken - User's Trakt access token (optional for public lists)
 */
async function getTraktListDetailsById(
  listId: string | number,
  accessToken?: string
): Promise<any> {
  try {
    const url = `${TRAKT_BASE_URL}/lists/${listId}`;

    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, { 
        dispatcher: traktDispatcher,
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': TRAKT_CLIENT_ID,
          ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {})
        }
      }),
      `Trakt getTraktListDetailsById (${listId})`
    );

    return response.data || null;
  } catch (err: any) {
    logger.error(`Error fetching Trakt list details for id ${listId}:`, err.message);
    return null;
  }
}

/**
 * Fetch calendar shows airing for a user
 * @param accessToken - User's Trakt access token
 * @param startDate - Start date in YYYY-MM-DD format
 * @param days - Number of days to fetch
 * @returns Object with items array
 */
async function fetchTraktCalendarShows(
  accessToken: string,
  startDate: string,
  days: number
): Promise<{items: any[]}> {
  try {
    const url = `${TRAKT_BASE_URL}/calendars/my/shows/${startDate}/${days}`;
    
    logger.debug(`Trakt calendar request: startDate=${startDate}, days=${days}`);
    
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
      `Trakt fetchCalendarShows (startDate: ${startDate}, days: ${days})`
    );
    
    const items = Array.isArray(response.data) ? response.data : [];
    
    logger.debug(`Trakt calendar - fetched ${items.length} calendar entries`);
    
    // Transform calendar entries to match list item format
    // Group by show to avoid duplicates
    const showMap = new Map<number, any>();
    
    for (const entry of items) {
      const show = entry.show;
      const episode = entry.episode;
      const firstAired = entry.first_aired;
      
      if (!show?.ids?.trakt) continue;
      
      const showId = show.ids.trakt;
      
      // Keep the earliest airing episode for each show
      if (!showMap.has(showId) || new Date(firstAired) < new Date(showMap.get(showId).first_aired)) {
        showMap.set(showId, {
          type: 'show',
          show: show,
          first_aired: firstAired,
          next_episode: {
            season: episode.season,
            number: episode.number,
            title: episode.title,
            ids: episode.ids
          }
        });
      }
    }
    
    const uniqueItems = Array.from(showMap.values());
    
    logger.info(`Trakt calendar - ${uniqueItems.length} unique shows from ${items.length} total entries`);
    
    return { items: uniqueItems };
  } catch (err: any) {
    logger.error(`Error fetching Trakt calendar shows:`, err.message);
    return { items: [] };
  }
}

export { 
  fetchTraktWatchlistItems, 
  fetchTraktFavoritesItems,
  fetchTraktRecommendationsItems,
  fetchTraktListItems,
  fetchTraktListItemsById,
  fetchTraktGenres,
  parseTraktItems,
  getTraktListDetails,
  getTraktListDetailsById,
  fetchTraktUpNextEpisodes,
  fetchTraktCalendarShows,
  fetchTraktUnwatchedEpisodes,
  makeRateLimitedTraktRequest,
  makeAuthenticatedRateLimitedTraktRequest
};

/**
 * Wrapper for proxy endpoints - makes a rate-limited GET request to Trakt
 * @param url - Full Trakt API URL
 * @param context - Context string for logging
 * @returns Response with data property
 */
async function makeRateLimitedTraktRequest(url: string, context: string = 'Trakt Proxy'): Promise<any> {
  return await makeRateLimitedRequest(
    () => httpGet(url, { 
      dispatcher: traktDispatcher,
      headers: {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': TRAKT_CLIENT_ID
      }
    }),
    context
  );
}

/**
 * Wrapper for authenticated proxy endpoints - makes a rate-limited GET request with OAuth Bearer token
 * @param url - Full Trakt API URL
 * @param accessToken - OAuth access token for authenticated requests
 * @param context - Context string for logging
 * @returns Response with data property
 */
async function makeAuthenticatedRateLimitedTraktRequest(url: string, accessToken: string, context: string = 'Trakt Proxy (Auth)'): Promise<any> {
  return await makeRateLimitedRequest(
    () => httpGet(url, { 
      dispatcher: traktDispatcher,
      headers: {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': TRAKT_CLIENT_ID,
        'Authorization': `Bearer ${accessToken}`
      }
    }),
    context
  );
}


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
    if (genre && genre.toLowerCase() !== 'all' && genre.toLowerCase() !== 'none') {
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

/**
 * Fetch trending items for movies or shows from Trakt
 */
async function fetchTraktTrendingItems(
  type: 'movies' | 'shows',
  page: number = 1,
  limit: number = 20,
  genre?: string
): Promise<{items: any[], totalItems?: number, hasMore: boolean, totalPages?: number}> {
  try {
    let url = `${TRAKT_BASE_URL}/${type}/trending?page=${page}&limit=${limit}`;
    if (genre && genre.toLowerCase() !== 'all' && genre.toLowerCase() !== 'none') {
      url += `&genres=${encodeURIComponent(genre)}`;
    }
    logger.debug(`Trakt trending ${type}: page=${page}, limit=${limit}, genre=${genre || 'none'}`);
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, {
        dispatcher: traktDispatcher,
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': TRAKT_CLIENT_ID
        }
      }),
      `Trakt fetchTrendingItems (${type}, page: ${page})`
    );

    const paginationHeaders = response.headers || {};
    const totalItems = paginationHeaders['x-pagination-item-count'] ? parseInt(paginationHeaders['x-pagination-item-count']) : undefined;
    const pageCount = paginationHeaders['x-pagination-page-count'] ? parseInt(paginationHeaders['x-pagination-page-count']) : undefined;
    const currentPage = paginationHeaders['x-pagination-page'] ? parseInt(paginationHeaders['x-pagination-page']) : page;

    const rawItems = Array.isArray(response.data) ? response.data : [];
    // Map Trakt response to TraktListItem-like objects
    const items = rawItems.map((entry: any) => {
      const media = entry.movie || entry.show || entry;
      const itemType = type === 'movies' ? 'movie' : 'show';
      return { type: itemType, movie: itemType === 'movie' ? media : undefined, show: itemType === 'show' ? media : undefined } as TraktListItem;
    });

    const hasMore = currentPage < (pageCount || 1);
    return { items, totalItems, hasMore, totalPages: pageCount };
  } catch (err: any) {
    logger.error(`Error fetching Trakt trending ${type}, page ${page}:`, err.message);
    return { items: [], hasMore: false };
  }
}

/**
 * Fetch popular items for movies or shows from Trakt
 */
async function fetchTraktPopularItems(
  type: 'movies' | 'shows',
  page: number = 1,
  limit: number = 20,
  genre?: string
): Promise<{items: any[], totalItems?: number, hasMore: boolean, totalPages?: number}> {
  try {
    let url = `${TRAKT_BASE_URL}/${type}/popular?page=${page}&limit=${limit}`;
    if (genre && genre.toLowerCase() !== 'all' && genre.toLowerCase() !== 'none') {
      url += `&genres=${encodeURIComponent(genre)}`;
    }
    logger.debug(`Trakt popular ${type}: page=${page}, limit=${limit}, genre=${genre || 'none'}`);
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, {
        dispatcher: traktDispatcher,
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': TRAKT_CLIENT_ID
        }
      }),
      `Trakt fetchPopularItems (${type}, page: ${page})`
    );

    const paginationHeaders = response.headers || {};
    const totalItems = paginationHeaders['x-pagination-item-count'] ? parseInt(paginationHeaders['x-pagination-item-count']) : undefined;
    const pageCount = paginationHeaders['x-pagination-page-count'] ? parseInt(paginationHeaders['x-pagination-page-count']) : undefined;
    const currentPage = paginationHeaders['x-pagination-page'] ? parseInt(paginationHeaders['x-pagination-page']) : page;

    const rawItems = Array.isArray(response.data) ? response.data : [];
    const items = rawItems.map((entry: any) => {
      const media = entry.movie || entry.show || entry;
      const itemType = type === 'movies' ? 'movie' : 'show';
      return { type: itemType, movie: itemType === 'movie' ? media : undefined, show: itemType === 'show' ? media : undefined } as TraktListItem;
    });

    const hasMore = currentPage < (pageCount || 1);
    return { items, totalItems, hasMore, totalPages: pageCount };
  } catch (err: any) {
    logger.error(`Error fetching Trakt popular ${type}, page ${page}:`, err.message);
    return { items: [], hasMore: false };
  }
}

export {
  fetchTraktMostFavoritedItems,
  fetchTraktTrendingItems,
  fetchTraktPopularItems
};
