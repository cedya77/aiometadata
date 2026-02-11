import { httpGet, httpPost } from "./httpClient.js";
import { getMeta } from "../lib/getMeta.js";
import { cacheWrapMetaSmart, cacheWrapGlobal } from "../lib/getCache.js";
import { UserConfig } from "../types/index.js";
import * as Utils from "./parseProps.js";
import { progress } from "framer-motion";
const consola = require('consola');
const { Agent } = require('undici');
const crypto = require('crypto');
const database = require('../lib/database.js');
const requestTracker = require('../lib/requestTracker.js');
const redis = require('../lib/redisClient');
const logger = consola.withTag('Simkl');
const idMapper = require('../lib/id-mapper');

const SIMKL_BASE_URL = 'https://api.simkl.com';
const SIMKL_CLIENT_ID = process.env.SIMKL_CLIENT_ID || '';
const SIMKL_TRENDING_TTL = 12 * 60 * 60; // 12 hours
const SIMKL_WATCHLIST_TTL = 24 * 60 * 60; // Cache in Redis for 24h, relies on activity check to invalidate
const SIMKL_ACTIVITIES_TTL = parseInt(process.env.SIMKL_ACTIVITIES_TTL || '21600'); // Cache activity check for 6 hours (21600s) to prevent spamming on pagination
const SIMKL_TRENDING_DATA_URL = 'https://data.simkl.in/discover/trending';

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
  baseDelay: 1000,
  maxDelay: 30000,
  rateLimitDelay: 5000,
  minInterval: 300,
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimitError(error: any): boolean {
  return error.response?.status === 429 || error.response?.status === 503;
}

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

async function getSimklToken(tokenId: any): Promise<any | null> {
  try {
    const token = await database.getOAuthToken(tokenId);
    if (!token || token.provider !== 'simkl') {
      return null;
    }
    return token;
  } catch (error: any) {
    logger.error(`Error getting Simkl access token: ${error.message}`);
    return null;
  }
}

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

async function fetchSimklUserStats(tokenId: string): Promise<any> {
  const tokenHash = crypto.createHash('sha256').update(tokenId).digest('hex').substring(0, 16);
  const cacheKey = `simkl-stats:${tokenHash}`;
  const statsTTL = 24 * 60 * 60; // 24 hours
  const token = await getSimklToken(tokenId);
  return await cacheWrapGlobal(
    cacheKey,
    async () => {
      const url = `${SIMKL_BASE_URL}/users/${token.user_id}/stats`;
      const response: any = await makeAuthenticatedSimklRequest(
        url,
        token.access_token,
        'Simkl fetchUserStats',
        'POST'
      );
      return response.data;
    },
    statsTTL,
    { skipVersion: true }
  );
}

// Check if any significant timestamp has changed
function hasActivityChanged(oldActivity: any, newActivity: any, status: string): { changed: boolean, removed: boolean } {
  if (!oldActivity) return { changed: true, removed: true };
  if (!newActivity) return { changed: true, removed: true }; // Should not happen if API healthy

  // Check generic "all" first
  if (newActivity.all !== oldActivity.all) {
    // Dig deeper
    const categories = ['movies', 'tv_shows', 'anime'];
    let contentChanged = false;
    let contentRemoved = false;

    for (const cat of categories) {
      if (newActivity[cat]?.all !== oldActivity[cat]?.all) {
        // This category changed. Check specific status.
        const apiStatus = status === 'plantowatch' ? 'plantowatch' : status; 
        
        if (newActivity[cat]?.[apiStatus] !== oldActivity[cat]?.[apiStatus]) {
          contentChanged = true;
        }

        if (newActivity[cat]?.removed_from_list !== oldActivity[cat]?.removed_from_list) {
          contentRemoved = true;
        }
      }
    }
    return { changed: contentChanged || contentRemoved, removed: contentRemoved };
  }

  return { changed: false, removed: false };
}

async function fetchSimklLastActivities(accessToken: string): Promise<any> {
  const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex').substring(0, 16);
  const cacheKey = `simkl-api-last-activities:${tokenHash}`;
  
  // Cache the activity check itself for 6 hours.
  // This ensures rapid pagination requests use the cached "state of truth" 
  // instead of hitting the API 5 times in 1 second.
  return await cacheWrapGlobal(
    cacheKey,
    async () => {
      const url = `${SIMKL_BASE_URL}/sync/activities`;
      const response: any = await makeAuthenticatedSimklRequest(
        url,
        accessToken,
        'Simkl fetchLastActivities',
        'POST'
      );
      return response.data;
    },
    SIMKL_ACTIVITIES_TTL, 
    { skipVersion: true }
  );
}

async function fetchSimklWatchlistItems(
  accessToken: string,
  type: 'movies' | 'shows' | 'anime',
  status: 'watching' | 'plantowatch' | 'hold' | 'completed' | 'dropped',
  cacheTTL: number = SIMKL_WATCHLIST_TTL // Default long TTL, we manage invalidation manually
): Promise<{items: any[]}> {
  try {
    const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex').substring(0, 16);
    // Redis keys
    const fullListKey = `simkl-watchlist-full:${tokenHash}:${status}`; // Stores the full object { movies:[], shows:[], anime:[] }
    const activitiesKey = `simkl-activities:${tokenHash}`; // Stores the last fetched activities object

    // 1. Get latest activities from Simkl (Cached via fetchSimklLastActivities for 6 hours)
    let currentActivities;
    try {
      currentActivities = await fetchSimklLastActivities(accessToken);
    } catch (e) {
      logger.error(`Failed to fetch Simkl activities: ${e.message}. Using cache if available.`);
    }

    // 2. Get cached data
    let cachedList: any = null;
    let cachedActivities: any = null;
    
    if (redis) {
      const [listStr, actStr] = await Promise.all([
        redis.get(fullListKey),
        redis.get(activitiesKey)
      ]);
      if (listStr) cachedList = JSON.parse(listStr);
      if (actStr) cachedActivities = JSON.parse(actStr);
    }

    // 3. Determine Sync Strategy
    let itemsToReturn: any = { movies: [], shows: [], anime: [] };
    let shouldUpdateCache = false;

    if (!currentActivities) {
      // API failed, return cache if exists
      if (cachedList) {
        itemsToReturn = cachedList;
      } else {
        return { items: [] };
      }
    } else {
      // We have API connection
      const { changed, removed } = hasActivityChanged(cachedActivities, currentActivities, status);

      if (!cachedList || removed) {
        // Case A: No cache OR items removed -> Full Sync
        logger.debug(`Simkl ${status}: Performing FULL sync (Reason: ${!cachedList ? 'No cache' : 'Items removed'})`);
        
        const url = `${SIMKL_BASE_URL}/sync/all-items/${status}?extended=full`;
        const response: any = await makeAuthenticatedSimklRequest(url, accessToken, `Simkl Full Sync ${status}`);
        
        itemsToReturn = {
          movies: response.data?.movies || [],
          shows: response.data?.shows || [],
          anime: response.data?.anime || []
        };
        shouldUpdateCache = true;

      } else if (changed) {
        // Case B: Updates available -> Incremental Sync
        // Use the main 'all' timestamp from the *cached* activities as date_from
        const lastSyncDate = cachedActivities?.all || new Date(0).toISOString();
        logger.debug(`Simkl ${status}: Performing INCREMENTAL sync (Since: ${lastSyncDate})`);

        const url = `${SIMKL_BASE_URL}/sync/all-items/${status}?extended=full&date_from=${encodeURIComponent(lastSyncDate)}`;
        const response: any = await makeAuthenticatedSimklRequest(url, accessToken, `Simkl Incremental Sync ${status}`);

        const updates = {
          movies: response.data?.movies || [],
          shows: response.data?.shows || [],
          anime: response.data?.anime || []
        };

        // Merge logic
        itemsToReturn = {
          movies: mergeItems(cachedList.movies || [], updates.movies),
          shows: mergeItems(cachedList.shows || [], updates.shows),
          anime: mergeItems(cachedList.anime || [], updates.anime)
        };

        const totalUpdates = updates.movies.length + updates.shows.length + updates.anime.length;
        logger.debug(`Simkl ${status}: Merged ${totalUpdates} updates`);
        shouldUpdateCache = true;

      } else {
        // Case C: No changes
        // This is the path taken when you paginate quickly, because fetchSimklLastActivities returns cached data
        // and that data matches what's stored in activitiesKey
        logger.debug(`Simkl ${status}: No changes detected (Hit Cache)`);
        itemsToReturn = cachedList;
        // Extend TTL
        if (redis) redis.expire(fullListKey, cacheTTL);
      }
    }

    // 4. Update Cache if needed
    if (shouldUpdateCache && redis && currentActivities) {
      await Promise.all([
        redis.setex(fullListKey, cacheTTL, JSON.stringify(itemsToReturn)),
        redis.setex(activitiesKey, cacheTTL, JSON.stringify(currentActivities))
      ]);
    }

    // 5. Select items based on requested type
    let finalItems: any[] = [];
    if (type === 'movies') {
      finalItems = itemsToReturn.movies || [];
    } else if (type === 'shows') {
      finalItems = itemsToReturn.shows || [];
    } else if (type === 'anime') {
      finalItems = itemsToReturn.anime || [];
    }

    // 6. Sort by last watched
    finalItems.sort((a: any, b: any) => {
      const aTime = (a.last_watched_at || a.last_watched) ? new Date(a.last_watched_at || a.last_watched).getTime() : 0;
      const bTime = (b.last_watched_at || b.last_watched) ? new Date(b.last_watched_at || b.last_watched).getTime() : 0;
      return bTime - aTime;
    });

    return { items: finalItems };

  } catch (error: any) {
    logger.error(`Error fetching Simkl watchlist items: ${error.message}`);
    return { items: [] };
  }
}

type MovieIdInput =
  | string
  | {
      imdb?: string;
      tmdb?: number | string;
      simkl?: number | string;
      mal?: number | string;
    };

type EpisodeIdInput =
  | string
  | {
    imdb?: string;
    tmdb?: number | string;
    simkl?: number | string;
    tvdb?: number | string;
    mal?: number | string;
  };

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
  const simkl = toOptionalNumber(input.simkl);
  if (simkl !== undefined) ids.simkl = simkl;
  const mal = toOptionalNumber(input.mal);
  if (mal !== undefined) ids.mal = mal;

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
  const simkl = toOptionalNumber(input.simkl);
  if (simkl !== undefined) ids.simkl = simkl;
  const tvdb = toOptionalNumber(input.tvdb);
  if (tvdb !== undefined) ids.tvdb = tvdb;
  const mal = toOptionalNumber(input.mal);
  if (mal !== undefined) ids.mal = mal;

  return Object.keys(ids).length > 0 ? ids : null;
}

async function checkinMovie(idInput: MovieIdInput, accessToken: string): Promise<boolean> {
  const normalizedIds = normalizeMovieIdInput(idInput);

  if (!normalizedIds || !accessToken) {
    logger.debug('[Simkl Checkin] Missing ID or accessToken for checkinMovie', {
      id: idInput,
      hasToken: !!accessToken
    });
    return false;
  }

  try {

    const url = `${SIMKL_BASE_URL}/scrobble/checkin`;
    const watchedAt = new Date().toISOString();

    const payload = {
      progress: 1,
      movie:
        {
          ids: normalizedIds,
        }
    };

    logger.debug(
      `[Simkl Checkin] Checkin for movie - ids: ${formatIdSummary(normalizedIds)}, timestamp: ${watchedAt}`
    );

    await makeAuthenticatedSimklRequest(
      url,
      accessToken,
      'Simkl Checkin',
      'POST',
      payload
    );

    logger.info('[Simkl Checkin] Check in for movie successful', {
      ids: normalizedIds
    });
    return true;
  } catch (error: any) {
    logger.error(
      `[Simkl Checkin] Failed to checkin movie- ids: ${formatIdSummary(normalizedIds)}, error: ${error.message}`,
      {
        stack: error.stack
      }
    );

    if (error.response) {
      logger.error(
        `[Simkl Checkin] Simkl API error response - status: ${error.response.status}, statusText: ${
          error.response.statusText || 'N/A'
        }`,
        {
          responseData: error.response.data,
          headers: error.response.headers
        }
      );
    } else if (error.code) {
      logger.error(`[Simkl Checkin] Network error - code: ${error.code}`, {
        errno: error.errno,
        syscall: error.syscall
      });
    }

    return false;
  }
}

async function checkinSeries(
  idInput: EpisodeIdInput,
  season: number,
  episode: number,
  accessToken: string,
  fallbackData?: any // Made optional
): Promise<boolean> {
  const normalizedIds = normalizeEpisodeIdInput(idInput);

  if (!normalizedIds || !accessToken || season < 1 || episode < 1) {
    logger.warn('[Simkl Checkin] Invalid parameters for checkinSeries', {
      id: idInput,
      season,
      episode,
      hasToken: !!accessToken
    });
    return false;
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'simkl-api-key': SIMKL_CLIENT_ID
  };

  const doCheckin = async (ids: Record<string, string | number>, attemptLabel: string, seasonNumber: number, episodeNumber:number) => {
      const url = `${SIMKL_BASE_URL}/scrobble/checkin`;
      const payload = {
        progress: 1,
        show: { ids: ids },
        episode: { season: seasonNumber, number: episodeNumber }
      };

      logger.debug(`[Simkl Checkin] ${attemptLabel} - ids: ${formatIdSummary(ids)}, S${seasonNumber}E${episodeNumber}`);

      const response = await httpPost(url, payload, { 
        headers, 
        dispatcher: simklDispatcher,
        timeout: 10000 
      });
  
      if (response.status >= 200 && response.status < 300) {
        logger.info(`[Simkl Checkin] Checked into episode (${attemptLabel})`, { ids, seasonNumber, episodeNumber });
        return true;
      }
      
      throw { response }; 
  };

  try {
    await doCheckin(normalizedIds, 'Primary ID', season, episode);
    return true;
  } catch (error: any) {
    if (error.response?.status === 404 && fallbackData && fallbackData.ids) {
      const normalizedFallbackIds = normalizeEpisodeIdInput(fallbackData.ids);
      if (normalizedFallbackIds) {
        logger.info('[Simkl Checkin] Primary ID failed (404), attempting fallback IDs...');
        try {
          await doCheckin(normalizedFallbackIds, 'Fallback ID', fallbackData.season, fallbackData.episode);
          return true;
        } catch (fallbackError: any) {
          logger.error(`[Simkl Checkin] Fallback check-in also failed: ${fallbackError.message}`);
          return false;
        }
      }
    }

    // Logging for the initial failure if no fallback or fallback not applicable
    logger.error(
      `[Simkl Checkin] Failed to check in episode - ids: ${formatIdSummary(normalizedIds)}, S${season}E${episode}, error: ${error.message}`
    );
    if (error.response) {
      logger.debug(
        `[Simkl Checkin] API error response:`,
        { status: error.response.status, data: error.response.data }
      );
    }
    return false;
  }
}


function mergeItems(existingItems: any[], newItems: any[]): any[] {
  const itemMap = new Map();
  
  // Index existing items
  existingItems.forEach((item: any) => {
    const simklId = item.show?.ids?.simkl || item.movie?.ids?.simkl || item.ids?.simkl;
    if (simklId) itemMap.set(simklId, item);
  });

  // Merge new items (overwriting existing ones)
  newItems.forEach((item: any) => {
    const simklId = item.show?.ids?.simkl || item.movie?.ids?.simkl || item.ids?.simkl;
    if (simklId) itemMap.set(simklId, item);
  });

  return Array.from(itemMap.values());
}

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

/** Resolves mal_id only from native anime IDs (mal, anilist, kitsu, anidb). Does NOT resolve from imdb/tmdb/tvdb - those go through getMeta. */
function resolveMalIdFromIds(ids: any): number | null {
  const malId = ids.mal;
  if (malId && typeof malId === 'number' && malId > 0) return malId;
  const anilistId = ids.anilist;
  if (anilistId) {
    const m = idMapper.getMappingByAnilistId(anilistId);
    if (m?.mal_id) return m.mal_id;
  }
  const kitsuId = ids.kitsu;
  if (kitsuId) {
    const m = idMapper.getMappingByKitsuId(kitsuId);
    if (m?.mal_id) return m.mal_id;
  }
  const anidbId = ids.anidb;
  if (anidbId) {
    const m = idMapper.getMappingByAnidbId(anidbId);
    if (m?.mal_id) return m.mal_id;
  }
  return null;
}

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

  if (isAnimeCatalog) {
    // Split: items with mal/kitsu/anidb/anilist -> parseAnimeCatalogMetaBatch; items with only tmdb/imdb/tvdb -> getMeta
    const animeItems: any[] = [];
    const getMetaItems: { item: any; itemType: string; stremioId: string; index: number }[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        const itemType = (item.type || type) as 'movie' | 'series';
        const ids = item.ids || {};
        const simklId = ids.simkl_id || ids.simkl;

        if (simklId) {
          const mapping = idMapper.getMappingBySimklId(simklId);
          if (mapping) {
            if (!ids.imdb && mapping.imdb_id) ids.imdb = mapping.imdb_id;
            if (!ids.tmdb && mapping.themoviedb_id) ids.tmdb = mapping.themoviedb_id;
            if (!ids.tvdb && mapping.tvdb_id) ids.tvdb = mapping.tvdb_id;
            if (!ids.mal && mapping.mal_id) ids.mal = mapping.mal_id;
            if (!ids.anilist && mapping.anilist_id) ids.anilist = mapping.anilist_id;
            if (!ids.kitsu && mapping.kitsu_id) ids.kitsu = mapping.kitsu_id;
            if (!ids.anidb && mapping.anidb_id) ids.anidb = mapping.anidb_id;
            logger.debug(`[Simkl] Enriched item ${simklId} (${item.title || 'Unknown'}) with IDs from mapping: ${JSON.stringify(ids)}`);
          }
        }

        const malId = resolveMalIdFromIds(ids);
        if (malId) {
          const year = item.release_date ? new Date(item.release_date).getFullYear() : null;
          const posterUrl = `https://wsrv.nl/?url=https://simkl.in/posters/${item.poster}_m.jpg`;
          const airedFrom = item.release_date 
              ? new Date(item.release_date).toISOString().substring(0, 10) 
              : (year ? `${year}-01-01` : null);
          const years = typeof item.metadata === "string"
            ? item.metadata.match(/\b\d{4}\b/g)
            : null;

          const secondYear = years?.[1];
          const airedTo = secondYear ? `${secondYear}-12-31` : null;
          animeItems.push({
            mal_id: malId,
            type: itemType,
            title: (item.title || '').replace(/\\'/g, "'"),
            year,
            duration: item.runtime,
            synopsis: item.overview,
            images: { jpg: { large_image_url: posterUrl } },
            aired: { from: airedFrom, to: airedTo },
            status: item.status
          });
        } else {
          const imdbId = ids.imdb;
          const tmdbId = ids.tmdb;
          const tvdbId = ids.tvdb;
          const anilistId = ids.anilist;
          const kitsuId = ids.kitsu;
          const anidbId = ids.anidb;
          const hasValidId = !!(ids.mal || anilistId || kitsuId || anidbId || tmdbId || imdbId || tvdbId);
          if (hasValidId) {
            let stremioId: string;
            if (ids.mal) {
              stremioId = `mal:${ids.mal}`;
            } else if (imdbId) {
              stremioId = typeof imdbId === 'string' && imdbId.startsWith('tt') ? imdbId : `tt${imdbId}`;
            } else if (tmdbId) {
              stremioId = `tmdb:${tmdbId}`;
            } else if (tvdbId) {
              stremioId = `tvdb:${tvdbId}`;
            } else if (anilistId) {
              stremioId = `anilist:${anilistId}`;
            } else if (kitsuId) {
              stremioId = `kitsu:${kitsuId}`;
            } else {
              stremioId = `anidb:${anidbId}`;
            }
            getMetaItems.push({ item, itemType, stremioId, index: i });
          }
        }
      } catch (error: any) {
        logger.warn(`Error building Simkl anime item: ${error.message}`);
      }
    }

    const result: (any | null)[] = new Array(items.length).fill(null);

    if (animeItems.length > 0) {
      const batchMetas = await Utils.parseAnimeCatalogMetaBatch(animeItems, config, config.language || 'en-US', includeVideos);
      let batchIdx = 0;
      for (let i = 0; i < items.length && batchIdx < batchMetas.length; i++) {
        const malId = resolveMalIdFromIds(items[i].ids || {});
        if (malId) {
          result[i] = batchMetas[batchIdx++] ?? null;
        }
      }
    }

    if (getMetaItems.length > 0) {
      const getMetaMetas = await Promise.all(
        getMetaItems.map(async ({ itemType, stremioId }) => {
          const r = await cacheWrapMetaSmart(
            userUUID,
            stremioId,
            async () => getMeta(itemType, config.language, stremioId, config, userUUID, includeVideos),
            undefined,
            { enableErrorCaching: true, maxRetries: 2 },
            itemType as any,
            includeVideos
          );
          return r?.meta ?? null;
        })
      );
      getMetaItems.forEach((g, idx) => {
        result[g.index] = getMetaMetas[idx];
      });
    }

    return result.filter(Boolean);
  }

  // Standard catalog: use getMeta per item
  const metas = await Promise.all(
    items.map(async (item: any) => {
      try {
        const itemType = item.type || type;
        const ids = item.ids || {};
        const simklId = ids.simkl_id || ids.simkl;

        if (simklId) {
          const mapping = idMapper.getMappingBySimklId(simklId);
          if (mapping) {
            if (!ids.imdb && mapping.imdb_id) ids.imdb = mapping.imdb_id;
            if (!ids.tmdb && mapping.themoviedb_id) ids.tmdb = mapping.themoviedb_id;
            if (!ids.tvdb && mapping.tvdb_id) ids.tvdb = mapping.tvdb_id;
            if (!ids.mal && mapping.mal_id) ids.mal = mapping.mal_id;
            if (!ids.anilist && mapping.anilist_id) ids.anilist = mapping.anilist_id;
            if (!ids.kitsu && mapping.kitsu_id) ids.kitsu = mapping.kitsu_id;
            if (!ids.anidb && mapping.anidb_id) ids.anidb = mapping.anidb_id;
            logger.debug(`[Simkl] Enriched item ${simklId} (${item.title || 'Unknown'}) with IDs from mapping: ${JSON.stringify(ids)}`);
          }
        }

        const imdbId = ids.imdb;
        const tmdbId = ids.tmdb;
        const tvdbId = ids.tvdb;
        const malId = ids.mal;
        const hasValidId = !!(imdbId || tmdbId || tvdbId || malId);
        if (!hasValidId) {
          logger.debug(`[Simkl] Skipping item with only simkl ID: ${JSON.stringify(item)}`);
          return null;
        }

        let stremioId: string | null = null;
        if (imdbId) {
          stremioId = typeof imdbId === 'string' && imdbId.startsWith('tt') ? imdbId : `tt${imdbId}`;
        } else if (tmdbId) {
          stremioId = `tmdb:${tmdbId}`;
        } else if (tvdbId) {
          stremioId = `tvdb:${tvdbId}`;
        } else if (malId) {
          stremioId = `mal:${malId}`;
        }

        if (!stremioId) return null;

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

        if (result?.meta) return result.meta;
        return null;
      } catch (error: any) {
        logger.warn(`Error parsing Simkl item: ${error.message}`);
        return null;
      }
    })
  );

  return metas.filter(Boolean);
}

async function fetchSimklTrendingItems(
  type: 'movies' | 'shows' | 'anime',
  interval: 'today' | 'week' | 'month' = 'today',
  page: number = 1,
  limit: number = 20,
  cacheTTL?: number
): Promise<{items: any[], totalItems?: number, hasMore: boolean, totalPages?: number}> {
  try {
    // Map type to the JSON file path segments
    const endpoint = type === 'movies' ? 'movies' : type === 'shows' ? 'tv' : 'anime';
    const url = `${SIMKL_TRENDING_DATA_URL}/${endpoint}/${interval}_500.json`;

    logger.debug(`Simkl trending ${type}: interval=${interval}, page=${page}, limit=${limit}, url=${url}`);

    // Cache the FULL 500-item file, then paginate locally
    const cacheKey = `simkl-trending-json:${type}:${interval}`;
    const ttl = Math.max(cacheTTL || SIMKL_TRENDING_TTL, 3600);
    const response: any = await cacheWrapGlobal(
      cacheKey,
      async () => {
        return await makeRateLimitedRequest(
          () => httpGet(url, {
            dispatcher: simklDispatcher,
            headers: {
              'User-Agent': `AIOMetadata/${process.env.npm_package_version || '1.0'}`,
              'Accept': 'application/json'
            }
          }),
          `Simkl fetchTrendingItems JSON (${type}, interval: ${interval})`
        );
      },
      ttl,
      { skipVersion: true }
    );

    const allItems: any[] = Array.isArray(response.data) ? response.data : [];

    // Paginate locally from the cached full list
    const startIndex = (page - 1) * limit;
    const pageItems = allItems.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < allItems.length;
    const totalItems = allItems.length;
    const totalPages = Math.ceil(totalItems / limit);

    logger.debug(`Simkl trending page ${page}: ${pageItems.length} items (of ${totalItems} total), hasMore: ${hasMore}`);

    const items = pageItems.map((entry: any) => {
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

    return { items, hasMore, totalItems, totalPages };
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
  getSimklToken,
  fetchSimklTrendingItems,
  fetchSimklCalendarItems,
  checkinMovie,
  checkinSeries
};

async function fetchSimklCalendar(
  type: 'tv' | 'anime' | 'movie_release',
  cacheTTL: number = 14400 // 4 hours
): Promise<any[]> {
  try {
    const cacheKey = `simkl-calendar:${type}`;
    
    return await cacheWrapGlobal(
      cacheKey,
      async () => {
        const url = `https://data.simkl.in/calendar/${type}.json`;
        // Use a simple GET request for the CDN file
        const response: any = await makeRateLimitedRequest(
          () => httpGet(url, { dispatcher: simklDispatcher }),
          `Simkl Calendar (${type})`
        );
        return Array.isArray(response.data) ? response.data : [];
      },
      cacheTTL,
      { skipVersion: true }
    );
  } catch (err: any) {
    logger.error(`Error fetching Simkl calendar ${type}:`, err.message);
    return [];
  }
}

async function fetchSimklCalendarItems(
  days: number = 1,
  timezone: string = 'UTC',
  cacheTTL?: number,
  type: 'all' | 'anime' | 'series' = 'all'
): Promise<{items: any[]}> {
  try {
    let allItems: any[] = [];
    
    const promises: Promise<any[]>[] = [];
    
    if (type === 'all' || type === 'series') {
      promises.push(fetchSimklCalendar('tv', cacheTTL));
    }
    
    if (type === 'all' || type === 'anime') {
      promises.push(fetchSimklCalendar('anime', cacheTTL));
    }
    
    const results = await Promise.all(promises);
    results.forEach(items => {
      allItems = [...allItems, ...items];
    });
    
    if (allItems.length === 0) {
      return { items: [] };
    }

    // 2. Filter by date range in user's timezone
    const now = new Date();
    const allowedDates = new Set<string>();
    
    const dateFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    
    for (let i = 0; i < days; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() + i);
        allowedDates.add(dateFormatter.format(d));
    }

    const filtered = allItems.filter(item => {
      if (!item.date) return false;
      const itemDate = new Date(item.date);
      
      const itemDateStr = dateFormatter.format(itemDate);
      return allowedDates.has(itemDateStr);
    });

    filtered.sort((a, b) => {
      const dateA = new Date(a.date).getTime();
      const dateB = new Date(b.date).getTime();
      
      if (dateA !== dateB) {
        return dateA - dateB;
      }
      
      const rankA = a.rank || 999999;
      const rankB = b.rank || 999999;
      
      return rankA - rankB;
    });

    const mappedItems = filtered.map(item => {
      let type: 'movie' | 'series' = 'series'; // Default to series for calendar
      if (item.anime_type && (item.anime_type === 'movie' || item.anime_type === 'ona')) {
        // Some anime might be movies
        // But typically calendar "airing" implies episodes.
        // We will trust getMeta to handle it if we pass the right ID.
        // But parseSimklItems expects a type to fallback to.
      }
      
      return {
        ...item,
        type
      };
    });

    return { items: mappedItems };
  } catch (err: any) {
    logger.error(`Error processing Simkl calendar items:`, err.message);
    return { items: [] };
  }
}