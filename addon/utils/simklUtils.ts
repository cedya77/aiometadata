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
const animeListMapper = require('../lib/anime-list-mapper');

const SIMKL_BASE_URL = 'https://api.simkl.com';
const SIMKL_CLIENT_ID = process.env.SIMKL_CLIENT_ID || '';
const SIMKL_TRENDING_TTL = 12 * 60 * 60; // 12 hours
const SIMKL_WATCHLIST_TTL = 24 * 60 * 60; // Cache in Redis for 24h, relies on activity check to invalidate
const SIMKL_ACTIVITIES_TTL_DEFAULT = 30 * 60; // Simkl asks callers to throttle sync checks to once per 15-30 min
const SIMKL_LIST_STATUSES = ['plantowatch', 'watching', 'completed', 'hold', 'dropped'];

function getSimklActivitiesTtl(): number {
  const parsed = parseInt(process.env.SIMKL_ACTIVITIES_TTL || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SIMKL_ACTIVITIES_TTL_DEFAULT;
}
const SIMKL_TRENDING_DATA_URL = 'https://data.simkl.in/discover/trending';
const SIMKL_DISCOVER_DATA_URL = 'https://data.simkl.in/discover';
const SIMKL_APP_NAME = 'aiometadata';

function simklDataParams(): string {
  const params = new URLSearchParams({
    'app-name': SIMKL_APP_NAME,
    'app-version': process.env.npm_package_version || '1.0'
  });
  if (SIMKL_CLIENT_ID) params.set('client_id', SIMKL_CLIENT_ID);
  return params.toString();
}

/**
 * Sanitize URL by removing access token for safe logging
 */
function sanitizeUrlForLogging(url: string): string {
  return url.replace(/(Authorization: Bearer\s+)[^\s]+/gi, '$1[REDACTED]');
}

const simklDispatcher = new Agent({ allowH2: false, connect: { timeout: 30000 } });

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

/**
 * `type` is its own path segment and its own bucket in the reply, and Simkl files
 * anime apart from movies whatever the anime_type, so an anime film is only ever
 * in the `anime` bucket — never in `movies`.
 */
async function getSimklRatings(
  accessToken: string,
  type: 'movies' | 'shows' | 'anime',
  dateFrom?: string
): Promise<any[]> {
  try {
    let url = `${SIMKL_BASE_URL}/sync/ratings/${type}`;
    if (dateFrom) url += `?date_from=${encodeURIComponent(dateFrom)}`;
    const response: any = await makeAuthenticatedSimklRequest(url, accessToken, `Simkl ${type} ratings`);
    const bucket = response?.data?.[type];
    return Array.isArray(bucket) ? bucket : [];
  } catch (error) {
    return [];
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

/**
 * Simkl matches against every translated title it holds, which is why it answers
 * queries like "LotR" that title-only engines miss.
 */
async function fetchSimklSearchItems(
  type: 'movie' | 'tv' | 'anime',
  query: string,
  limit: number = 20,
  page: number = 1
): Promise<any[]> {
  try {
    // Simkl clamps rather than rejecting: limit tops out at 50 and page at 20.
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const safePage = Math.min(Math.max(page, 1), 20);
    const url = `${SIMKL_BASE_URL}/search/${type}?q=${encodeURIComponent(query)}&limit=${safeLimit}&page=${safePage}&extended=full&${simklDataParams()}`;
    const response: any = await makeRateLimitedSimklRequest(url, `Simkl search (${type}, query: "${query}")`);

    if (!response?.data || !Array.isArray(response.data)) {
      logger.info(`No Simkl search results found for query: "${query}"`);
      return [];
    }

    logger.debug(`Found ${response.data.length} Simkl search results for query: "${query}"`);
    return response.data;
  } catch (err: any) {
    if (err?.response?.status === 412) {
      logger.error('Simkl rejected the client_id, so search cannot run. Check SIMKL_CLIENT_ID.');
    } else {
      logger.error(`Error fetching Simkl search results for ${type} "${query}":`, err.message);
    }
    return [];
  }
}

/**
 * Search answers with an index row, so anything beyond title, year, poster and ids
 * has to come from here. This is also the only place a simkl id turns into an imdb
 * or tvdb one, which search omits.
 */
async function fetchSimklItemDetail(type: 'movie' | 'tv', simklId: string | number): Promise<any> {
  if (!simklId) return null;
  const segment = type === 'movie' ? 'movies' : 'tv';
  return cacheWrapGlobal(
    `simkl:detail:${segment}:${simklId}`,
    async () => {
      try {
        const url = `${SIMKL_BASE_URL}/${segment}/${simklId}?extended=full&${simklDataParams()}`;
        const response: any = await makeRateLimitedSimklRequest(url, `Simkl detail (${segment}/${simklId})`);
        return response?.data ?? null;
      } catch (err: any) {
        logger.debug(`Simkl detail lookup failed for ${segment}/${simklId}: ${err.message}`);
        return null;
      }
    },
    24 * 60 * 60
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
    { upstream: true }
  );
}

// Check if any significant timestamp has changed.
// `reconcile` means items may have LEFT this list, which a date_from delta can
// never tell us: it only carries additions and updates.
function hasActivityChanged(oldActivity: any, newActivity: any, status: string): { changed: boolean, reconcile: boolean } {
  if (!oldActivity) return { changed: true, reconcile: true };
  if (!newActivity) return { changed: true, reconcile: true }; // Should not happen if API healthy

  // Check generic "all" first
  if (newActivity.all !== oldActivity.all) {
    // Dig deeper
    const categories = ['movies', 'tv_shows', 'anime'];
    let contentChanged = false;
    let contentLeft = false;

    for (const cat of categories) {
      if (newActivity[cat]?.all !== oldActivity[cat]?.all) {
        // This category changed. Check specific status.
        if (newActivity[cat]?.[status] !== oldActivity[cat]?.[status]) {
          contentChanged = true;
        }

        // An item lives in exactly one status, so it leaves this list either by
        // landing in a sibling one or by leaving the library. This status bumps
        // on the way out too, but that is indistinguishable from an arrival: the
        // sibling bump is what actually says something has to be dropped.
        const movedOut = SIMKL_LIST_STATUSES.some(
          s => s !== status && newActivity[cat]?.[s] !== oldActivity[cat]?.[s]
        );

        // removed_from_list is the other exit: gone from the library entirely.
        if (movedOut || newActivity[cat]?.removed_from_list !== oldActivity[cat]?.removed_from_list) {
          contentLeft = true;
        }
      }
    }
    return { changed: contentChanged, reconcile: contentLeft };
  }

  return { changed: false, reconcile: false };
}

async function fetchSimklLastActivities(accessToken: string): Promise<any> {
  const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex').substring(0, 16);
  const cacheKey = `simkl-api-last-activities:${tokenHash}`;
  
  // Cached so that rapid pagination requests share one "state of truth"
  // instead of hitting the API once per page.
  return await cacheWrapGlobal(
    cacheKey,
    async () => {
      const url = `${SIMKL_BASE_URL}/sync/activities`;
      // GET, not POST: Simkl caps apps at 10 GET/sec but only 1 POST/sec per
      // client_id, shared across every user on the instance.
      const response: any = await makeAuthenticatedSimklRequest(
        url,
        accessToken,
        'Simkl fetchLastActivities'
      );
      return response.data;
    },
    getSimklActivitiesTtl(),
    { upstream: true }
  );
}

async function getSimklActivityFingerprint(
  accessToken: string,
  type: 'movies' | 'shows' | 'anime',
  status: string
): Promise<string> {
  try {
    const activities = await fetchSimklLastActivities(accessToken);
    if (!activities) return '';
    const cat = type === 'shows' ? activities.tv_shows : activities[type];
    const specific = cat?.[status] ?? cat?.all ?? activities.all ?? '';
    const removed = cat?.removed_from_list ?? '';
    // An item leaving this list shows up as a bump on the status it moved to, so
    // the siblings belong in the key too or the catalog keeps serving the old page.
    const siblingParts = SIMKL_LIST_STATUSES.filter(s => s !== status).map(s => cat?.[s] || '');
    const siblings = siblingParts.join(',');
    return (specific || removed || siblingParts.some(Boolean)) ? `${specific}|${removed}|${siblings}` : '';
  } catch {
    return '';
  }
}

/**
 * Drop the items that have left a list. A date_from delta only carries additions
 * and updates, so Simkl's documented way to spot a departure is to refetch the
 * list ids-only and diff: whatever the cached blob still holds and the live list
 * does not has moved to another status or left the library.
 * Returns null when the answer could not be trusted, so the caller keeps the
 * cached list rather than pruning against a body it failed to read.
 */
async function reconcileSimklList(
  accessToken: string,
  status: string,
  cached: any
): Promise<any | null> {
  let response: any;
  try {
    // ids-only: the point is which ids are still here, not their contents, and
    // this runs often enough that pulling extended=full again would be wasteful.
    const url = `${SIMKL_BASE_URL}/sync/all-items/${status}?extended=simkl_ids_only`;
    response = await makeAuthenticatedSimklRequest(url, accessToken, `Simkl Reconcile ${status}`);
  } catch (e: any) {
    logger.warn(`Simkl ${status}: reconcile fetch failed (${e.message}), keeping cached list`);
    return null;
  }

  const data = response?.data;
  if (!data || typeof data !== 'object') {
    logger.warn(`Simkl ${status}: reconcile returned no usable body, keeping cached list`);
    return null;
  }

  const result: any = {};
  let dropped = 0;
  for (const bucket of ['movies', 'shows', 'anime']) {
    const live = Array.isArray(data[bucket]) ? data[bucket] : [];
    const liveIds = new Set<any>();
    for (const item of live) {
      const id = simklItemId(item);
      // An id we cannot read would prune a live item, so give up rather than guess.
      if (!id) {
        logger.warn(`Simkl ${status}: reconcile item carried no simkl id, keeping cached list`);
        return null;
      }
      liveIds.add(id);
    }
    result[bucket] = (cached?.[bucket] || []).filter((item: any) => {
      const id = simklItemId(item);
      // Unidentifiable cached items are left alone, the same way mergeItems skips them.
      if (!id) return true;
      if (liveIds.has(id)) return true;
      dropped++;
      return false;
    });
  }

  if (dropped) logger.debug(`Simkl ${status}: reconcile dropped ${dropped} item(s) that left the list`);
  return result;
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
    // v2 carried next_to_watch_info; v3 drops the blobs that delta syncs left items
    // stranded in, so both have to be refetched rather than merged into.
    const fullListKey = `simkl-watchlist-full-v3:${tokenHash}:${status}`; // Stores the full object { movies:[], shows:[], anime:[] }
    const activitiesKey = `simkl-activities:${tokenHash}:${status}`; // Per-status watermark, matching fullListKey granularity

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
    let reconcileFailed = false;

    if (!currentActivities) {
      // API failed, return cache if exists
      if (cachedList) {
        itemsToReturn = cachedList;
      } else {
        return { items: [] };
      }
    } else {
      // We have API connection
      const { changed, reconcile } = hasActivityChanged(cachedActivities, currentActivities, status);

      if (!cachedList) {
        // Case A: No cache -> Full Sync
        logger.debug(`Simkl ${status}: Performing FULL sync (Reason: No cache)`);
        
        const url = `${SIMKL_BASE_URL}/sync/all-items/${status}?extended=full&next_watch_info=yes&language=en`;
        const response: any = await makeAuthenticatedSimklRequest(url, accessToken, `Simkl Full Sync ${status}`);
        
        itemsToReturn = {
          movies: response.data?.movies || [],
          shows: response.data?.shows || [],
          anime: response.data?.anime || []
        };
        shouldUpdateCache = true;

      } else if (changed || reconcile) {
        // Case B: Updates available -> Incremental Sync
        itemsToReturn = cachedList;

        if (changed) {
          // Use the main 'all' timestamp from the *cached* activities as date_from
          const lastSyncDate = cachedActivities?.all || new Date(0).toISOString();
          logger.debug(`Simkl ${status}: Performing INCREMENTAL sync (Since: ${lastSyncDate})`);

          const url = `${SIMKL_BASE_URL}/sync/all-items/${status}?extended=full&next_watch_info=yes&language=en&date_from=${encodeURIComponent(lastSyncDate)}`;
          const response: any = await makeAuthenticatedSimklRequest(url, accessToken, `Simkl Incremental Sync ${status}`);

          const updates = {
            movies: response.data?.movies || [],
            shows: response.data?.shows || [],
            anime: response.data?.anime || []
          };

          // Merge logic
          itemsToReturn = {
            movies: mergeItems(itemsToReturn.movies || [], updates.movies),
            shows: mergeItems(itemsToReturn.shows || [], updates.shows),
            anime: mergeItems(itemsToReturn.anime || [], updates.anime)
          };

          const totalUpdates = updates.movies.length + updates.shows.length + updates.anime.length;
          logger.debug(`Simkl ${status}: Merged ${totalUpdates} updates`);
        }

        if (reconcile) {
          // The merge above can add and update, never drop, so anything that left
          // the list is still sitting in the blob until this diff removes it.
          const pruned = await reconcileSimklList(accessToken, status, itemsToReturn);
          if (pruned) itemsToReturn = pruned;
          else reconcileFailed = true;
        }

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
      const writes: any[] = [redis.setex(fullListKey, cacheTTL, JSON.stringify(itemsToReturn))];
      // Holding the watermark back on a failed reconcile is what makes the next
      // call retry the diff instead of trusting a list it could not verify.
      if (!reconcileFailed) {
        writes.push(redis.setex(activitiesKey, cacheTTL, JSON.stringify(currentActivities)));
      }
      await Promise.all(writes);
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

    // 6. Sort: plantowatch/hold by added date, others by last watched
    if (status === 'plantowatch' || status === 'hold') {
      finalItems.sort((a: any, b: any) => {
        const aTime = a.added_to_watchlist_at ? new Date(a.added_to_watchlist_at).getTime() : 0;
        const bTime = b.added_to_watchlist_at ? new Date(b.added_to_watchlist_at).getTime() : 0;
        return bTime - aTime;
      });
    } else {
      finalItems.sort((a: any, b: any) => {
        const aTime = (a.last_watched_at || a.last_watched) ? new Date(a.last_watched_at || a.last_watched).getTime() : 0;
        const bTime = (b.last_watched_at || b.last_watched) ? new Date(b.last_watched_at || b.last_watched).getTime() : 0;
        return bTime - aTime;
      });
    }

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


function simklItemId(item: any): any {
  return item?.show?.ids?.simkl ?? item?.movie?.ids?.simkl ?? item?.anime?.ids?.simkl ?? item?.ids?.simkl;
}

function mergeItems(existingItems: any[], newItems: any[]): any[] {
  const itemMap = new Map();
  
  // Index existing items
  existingItems.forEach((item: any) => {
    const simklId = simklItemId(item);
    if (simklId) itemMap.set(simklId, item);
  });

  // Merge new items (overwriting existing ones)
  newItems.forEach((item: any) => {
    const simklId = simklItemId(item);
    if (simklId) itemMap.set(simklId, item);
  });

  return Array.from(itemMap.values());
}

async function fetchSimklWatchedItems(
  accessToken: string,
  type: 'movies' | 'shows' | 'anime' = 'movies',
  status: 'completed' | 'dropped' | 'hold' = 'completed'
): Promise<any[]> {
  try {
    const endpoint = type === 'movies' ? 'movies' : type === 'shows' ? 'tv' : 'anime';
    // Default richness on purpose: it already carries user_rating, last_watched_at
    // and the episode counters. `extended=full` only adds per-episode arrays.
    const url = `${SIMKL_BASE_URL}/sync/all-items/${endpoint}/${status}`;
    
    const response: any = await makeAuthenticatedSimklRequest(
      url,
      accessToken,
      `Simkl fetchWatchedItems (${type}/${status})`
    );
    
    // The payload is an object keyed by media kind, never a bare array, so an
    // Array.isArray guard on it silently returns nothing.
    const payload = response.data;
    const items = Array.isArray(payload)
      ? payload
      : (payload?.movies || payload?.shows || payload?.anime || []);
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
    
    const payload = response.data;
    const items = Array.isArray(payload)
      ? payload
      : (payload?.shows || payload?.anime || payload?.movies || []);
    return Array.isArray(items) ? items : [];
  } catch (error: any) {
    logger.error(`Error fetching Simkl watching items: ${error.message}`);
    return [];
  }
}

export interface SimklWatchedIds {
  movieImdbIds: Set<string>;
  showImdbIds: Set<string>;
  malIds: Set<number>;
  anilistIds: Set<number>;
}

async function getSimklWatchedIds(config: any): Promise<SimklWatchedIds | null> {
  try {
    const token = await getSimklToken(config?.apiKeys?.simklTokenId);
    const accessToken = token?.access_token;
    if (!accessToken) return null;

    const types = ['movies', 'shows', 'anime'] as const;
    const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex').substring(0, 16);
    const fingerprints = await Promise.all(
      types.map(type => getSimklActivityFingerprint(accessToken, type, 'completed'))
    );
    const fingerprint = crypto.createHash('sha256')
      .update(fingerprints.join('|'))
      .digest('hex')
      .substring(0, 16);

    const watched = await cacheWrapGlobal(`simkl_watched_ids:${tokenHash}:${fingerprint}`, async () => {
      const movieImdbIds: string[] = [];
      const showImdbIds: string[] = [];
      const malIds: number[] = [];
      const anilistIds: number[] = [];

      for (const type of types) {
        const { items } = await fetchSimklWatchlistItems(accessToken, type, 'completed');
        for (const item of items) {
          const ids = (item?.movie || item?.show)?.ids;
          if (!ids) continue;

          const imdb = ids.imdb ? String(ids.imdb).trim() : '';
          if (imdb) {
            const isMovie = type === 'movies'
              || (type === 'anime' && (item.anime_type === 'movie' || item.anime_type === 'ona'));
            (isMovie ? movieImdbIds : showImdbIds).push(imdb.startsWith('tt') ? imdb : `tt${imdb}`);
          }

          if (type !== 'anime') continue;
          const malId = resolveMalIdFromIds(ids);
          if (malId) malIds.push(malId);
          const anilistId = ids.anilist || (malId ? idMapper.getMappingByMalId(malId)?.anilist_id : null);
          if (anilistId) anilistIds.push(Number(anilistId));
        }
      }

      logger.info(`[Watched IDs] ${movieImdbIds.length} movies, ${showImdbIds.length} shows, ${malIds.length} anime completed on Simkl`);
      return { movieImdbIds, showImdbIds, malIds, anilistIds };
    }, SIMKL_WATCHLIST_TTL);

    return {
      movieImdbIds: new Set(watched.movieImdbIds),
      showImdbIds: new Set(watched.showImdbIds),
      malIds: new Set(watched.malIds),
      anilistIds: new Set(watched.anilistIds),
    };
  } catch (err: any) {
    logger.warn(`[Watched IDs] Error fetching Simkl watched IDs: ${err.message}`);
    return null;
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
      const batchMetas = await Utils.parseAnimeCatalogMetaBatch(animeItems, config, config.language, includeVideos);
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
            { enableErrorCaching: true, maxRetries: 2, config },
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
          { enableErrorCaching: true, maxRetries: 2, config },
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
    const url = `${SIMKL_TRENDING_DATA_URL}/${endpoint}/${interval}_500.json?${simklDataParams()}`;

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
      { upstream: true, sourceList: true }
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

function simklEntryRating(entry: any): { rating: number; votes: number } {
  const s = entry?.ratings?.simkl;
  return { rating: Number(s?.rating) || 0, votes: Number(s?.votes) || 0 };
}

function parseRuntimeMinutes(runtime: any): number {
  if (!runtime) return 0;
  const str = String(runtime);
  const h = /(\d+)\s*h/.exec(str);
  const m = /(\d+)\s*m/.exec(str);
  return (h ? parseInt(h[1], 10) * 60 : 0) + (m ? parseInt(m[1], 10) : 0);
}

function parseDropRate(dropRate: any): number {
  if (!dropRate) return 0;
  const v = parseFloat(String(dropRate).replace('%', ''));
  return isNaN(v) ? 0 : v;
}

function parseBoxOffice(metadata: any): number {
  if (!metadata) return 0;
  const m = /Box office\s*\$?([\d.]+)\s*([KMB])?/i.exec(String(metadata));
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return 0;
  const suffix = m[2]?.toUpperCase();
  const mult = suffix === 'B' ? 1e9 : suffix === 'M' ? 1e6 : suffix === 'K' ? 1e3 : 1;
  return n * mult;
}

type SimklRecipeFn = (items: any[]) => any[];

const SIMKL_RECIPES: Record<string, SimklRecipeFn> = {
  hiddengems: (items) => {
    const watchedVals = items
      .map((it: any) => Number(it.watched) || 0)
      .filter((v: number) => v > 0)
      .sort((a: number, b: number) => a - b);
    const median = watchedVals.length ? watchedVals[Math.floor(watchedVals.length / 2)] : 0;
    return items
      .filter((it: any) => {
        const { rating, votes } = simklEntryRating(it);
        const watched = Number(it.watched) || 0;
        return rating >= 7.5 && votes >= 100 && (median === 0 || watched <= median);
      })
      .sort((a: any, b: any) => {
        const ra = simklEntryRating(a);
        const rb = simklEntryRating(b);
        return rb.rating - ra.rating || rb.votes - ra.votes;
      });
  },
  marathon: (items) => {
    return items
      .filter((it: any) => {
        const eps = Number(it.total_episodes) || 0;
        return it.status === 'ended' && eps >= 24 && parseDropRate(it.drop_rate) <= 5;
      })
      .sort((a: any, b: any) => {
        const ra = simklEntryRating(a);
        const rb = simklEntryRating(b);
        return rb.rating - ra.rating || (Number(b.watched) || 0) - (Number(a.watched) || 0);
      });
  },
  quick: (items) => {
    return items
      .filter((it: any) => {
        const mins = parseRuntimeMinutes(it.runtime);
        const { votes } = simklEntryRating(it);
        return mins > 0 && mins <= 100 && votes >= 30;
      })
      .sort((a: any, b: any) => {
        const ra = simklEntryRating(a);
        const rb = simklEntryRating(b);
        return rb.rating - ra.rating || (Number(b.watched) || 0) - (Number(a.watched) || 0);
      });
  },
  boxoffice: (items) => {
    return items
      .map((it: any) => ({ it, bo: parseBoxOffice(it.metadata) }))
      .filter((x: any) => x.bo > 0)
      .sort((a: any, b: any) => b.bo - a.bo)
      .map((x: any) => x.it);
  }
};

async function fetchSimklRecipeItems(
  recipe: string,
  type: 'movies' | 'shows' | 'anime',
  interval: 'today' | 'week' | 'month' = 'week',
  page: number = 1,
  limit: number = 20,
  cacheTTL?: number
): Promise<{ items: any[]; totalItems?: number; hasMore: boolean; totalPages?: number }> {
  const recipeFn = SIMKL_RECIPES[recipe];
  if (!recipeFn) {
    logger.warn(`[Simkl] Unknown recipe: ${recipe}`);
    return { items: [], hasMore: false };
  }

  const full = await fetchSimklTrendingItems(type, interval, 1, 100000, cacheTTL);
  const transformed = recipeFn(full.items || []);

  const startIndex = (page - 1) * limit;
  const pageItems = transformed.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < transformed.length;
  const totalItems = transformed.length;

  logger.debug(`[Simkl] Recipe ${recipe} (${type}/${interval}): ${totalItems} matches, page ${page} -> ${pageItems.length} items`);
  return { items: pageItems, hasMore, totalItems, totalPages: Math.ceil(totalItems / limit) };
}

interface SimklDiscoverQuery {
  genre?: string;
  type?: string;
  country?: string;
  network?: string;
  year?: string;
  sort?: string;
}

async function fetchSimklGenreItems(
  mediaType: 'movies' | 'shows' | 'anime',
  query: SimklDiscoverQuery,
  page: number = 1,
  limit: number = 20,
  cacheTTL?: number
): Promise<{ items: any[]; totalItems?: number; hasMore: boolean; totalPages?: number }> {
  try {
    const clientId = SIMKL_CLIENT_ID;
    if (!clientId) {
      logger.warn('[Simkl] Missing SIMKL_CLIENT_ID, cannot fetch discover genre items');
      return { items: [], hasMore: false };
    }

    const normalizedMedia = mediaType === 'shows' ? 'tv' : mediaType;
    const genre = String(query.genre || 'all').trim().toLowerCase();
    const type = String(query.type || 'all-types').trim().toLowerCase();
    const country = String(query.country || 'all-countries').trim().toLowerCase();
    const network = String(query.network || 'all-networks').trim().toLowerCase();
    const year = String(query.year || (mediaType === 'movies' ? 'this-year' : 'all-years')).trim().toLowerCase();
    const sort = String(query.sort || (mediaType === 'movies' ? 'popular-this-week' : 'popular-today')).trim().toLowerCase();

    const pathSegments = mediaType === 'movies'
      ? [genre, type, country, year, sort]
      : mediaType === 'shows'
        ? [genre, type, country, network, year, sort]
        : [genre, type, network, year, sort];

    const encodedSegments = pathSegments.map(segment => encodeURIComponent(segment)).join('/');
    const endpointUrl = `${SIMKL_BASE_URL}/${normalizedMedia}/genres/${encodedSegments}?client_id=${encodeURIComponent(clientId)}`;
    logger.debug(`[Simkl Discover] Fetching ${mediaType} genres endpoint: ${sanitizeUrlForLogging(endpointUrl)}`);

    const ttl = Math.max(cacheTTL || SIMKL_TRENDING_TTL, 3600);
    const cacheKey = `simkl-discover:${mediaType}:${pathSegments.join(':')}`;
    const response: any = await cacheWrapGlobal(
      cacheKey,
      async () => {
        return await makeRateLimitedRequest(
          () => httpGet(endpointUrl, {
            dispatcher: simklDispatcher,
            headers: {
              'User-Agent': `AIOMetadata/${process.env.npm_package_version || '1.0'}`,
              'Accept': 'application/json',
              'simkl-api-key': clientId
            }
          }),
          `Simkl fetchGenreItems (${mediaType})`
        );
      },
      ttl,
      { upstream: true, sourceList: true }
    );

    const allItems: any[] = Array.isArray(response?.data) ? response.data : [];
    const safeLimit = Math.max(1, Math.floor(limit || 20));
    const safePage = Math.max(1, Math.floor(page || 1));
    const startIndex = (safePage - 1) * safeLimit;
    const pageItems = allItems.slice(startIndex, startIndex + safeLimit);
    const hasMore = startIndex + safeLimit < allItems.length;
    const totalItems = allItems.length;
    const totalPages = Math.ceil(totalItems / safeLimit);

    const items = pageItems.map((entry: any) => {
      let itemType: 'movie' | 'series';
      if (mediaType === 'movies') {
        itemType = 'movie';
      } else if (mediaType === 'shows') {
        itemType = 'series';
      } else {
        itemType = (entry?.anime_type === 'movie' || entry?.anime_type === 'ona') ? 'movie' : 'series';
      }
      return { type: itemType, ...entry };
    });

    return { items, hasMore, totalItems, totalPages };
  } catch (err: any) {
    logger.error(`Error fetching Simkl discover ${mediaType} items:`, err.message);
    return { items: [], hasMore: false };
  }
}

async function fetchSimklDvdReleases(
  page: number = 1,
  limit: number = 20,
  cacheTTL?: number
): Promise<{items: any[], totalItems?: number, hasMore: boolean, totalPages?: number}> {
  try {
    const url = `${SIMKL_DISCOVER_DATA_URL}/dvd/releases_500.json?${simklDataParams()}`;

    logger.debug(`Simkl dvd releases: page=${page}, limit=${limit}, url=${url}`);

    // Cache the FULL 500-item file, then paginate locally
    const cacheKey = `simkl-dvd-releases-json`;
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
          `Simkl fetchDvdReleases JSON`
        );
      },
      ttl,
      { upstream: true, sourceList: true }
    );

    const allItems: any[] = Array.isArray(response.data) ? response.data : [];

    // Paginate locally from the cached full list
    const startIndex = (page - 1) * limit;
    const pageItems = allItems.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < allItems.length;
    const totalItems = allItems.length;
    const totalPages = Math.ceil(totalItems / limit);

    logger.debug(`Simkl dvd releases page ${page}: ${pageItems.length} items (of ${totalItems} total), hasMore: ${hasMore}`);

    const items = pageItems.map((entry: any) => {
      return {
        type: 'movie',
        ...entry
      };
    });

    return { items, hasMore, totalItems, totalPages };
  } catch (err: any) {
    logger.error(`Error fetching Simkl dvd releases: ${err.message}`);
    return { items: [], hasMore: false, totalItems: 0 };
  }
}

interface SimklUpNextItem {
  stremioId: string;
  season: number;
  episode: number;
  episodeTitle?: string;
  showTitle?: string;
  lastWatchedAt?: string;
}

/**
 * Simkl reports the next episode in the /sync/all-items payload, so unlike Trakt
 * there is no per-show progress call to make. Anime entries carry no season,
 * because Simkl files each cour as its own AniDB-style entry numbered from 1.
 */
function resolveSimklNextEpisode(item: any): { season: number | null; episode: number; title?: string; date?: string } | null {
  const info = item?.next_to_watch_info;
  const episode = Number(info?.episode);
  if (Number.isInteger(episode) && episode > 0) {
    const season = Number(info.season);
    return {
      season: Number.isInteger(season) ? season : null,
      episode,
      title: info.title,
      date: info.date,
    };
  }

  const marker = typeof item?.next_to_watch === 'string'
    ? item.next_to_watch.match(/^(?:S(\d+))?E(\d+)$/i)
    : null;
  if (marker) return { season: marker[1] ? Number(marker[1]) : null, episode: Number(marker[2]) };

  return null;
}

function normalizeImdbId(value: any): string {
  const id = String(value);
  return id.startsWith('tt') ? id : `tt${id}`;
}

/**
 * Picks the id form the user's anime provider implies, then the episode numbering
 * that id form uses. Grouped pages need the AniDB to TVDB offset, so an entry that
 * cannot be mapped is dropped rather than pinned to a plausible wrong episode.
 */
function resolveSimklAnimeTarget(
  ids: any,
  episode: number,
  config: UserConfig
): { stremioId: string; season: number; episode: number } | null {
  const provider = (config as any).providers?.anime || 'mal';
  const grouped = provider === 'tvdb' || provider === 'tmdb' || provider === 'imdb';

  if (!grouped) {
    if (provider === 'kitsu' && ids.kitsu) return { stremioId: `kitsu:${ids.kitsu}`, season: 1, episode };
    if (ids.mal) return { stremioId: `mal:${ids.mal}`, season: 1, episode };
    if (ids.kitsu) return { stremioId: `kitsu:${ids.kitsu}`, season: 1, episode };
    return null;
  }

  const mapped = ids.anidb
    ? animeListMapper.resolveTvdbEpisodeFromAnidbEpisode(Number(ids.anidb), 1, episode)
    : null;
  if (!mapped) return null;

  // Simkl often omits tvdb on anime entries, but the mapping carries the id it
  // just resolved the episode against.
  let stremioId: string;
  if (provider === 'tmdb' && ids.tmdb) stremioId = `tmdb:${ids.tmdb}`;
  else if (provider === 'imdb' && ids.imdb) stremioId = normalizeImdbId(ids.imdb);
  else stremioId = `tvdb:${ids.tvdb || mapped.tvdbId}`;

  return { stremioId, season: mapped.tvdbSeason, episode: mapped.tvdbEpisode };
}

function enrichSimklIds(media: any): any {
  const ids = { ...(media.ids || {}) };
  const simklId = ids.simkl_id || ids.simkl;
  if (simklId) {
    const mapping = idMapper.getMappingBySimklId(simklId);
    if (mapping) {
      if (!ids.imdb && mapping.imdb_id) ids.imdb = mapping.imdb_id;
      if (!ids.tmdb && mapping.themoviedb_id) ids.tmdb = mapping.themoviedb_id;
      if (!ids.tvdb && mapping.tvdb_id) ids.tvdb = mapping.tvdb_id;
      if (!ids.mal && mapping.mal_id) ids.mal = mapping.mal_id;
      if (!ids.kitsu && mapping.kitsu_id) ids.kitsu = mapping.kitsu_id;
      if (!ids.anidb && mapping.anidb_id) ids.anidb = mapping.anidb_id;
    }
  }
  return ids;
}

async function fetchSimklUpNextItems(
  accessToken: string,
  config: UserConfig,
  buckets: Array<'shows' | 'anime'> = ['shows']
): Promise<SimklUpNextItem[]> {
  const now = Date.now();
  const upNext: SimklUpNextItem[] = [];
  let considered = 0;
  let unmappedAnime = 0;

  for (const bucket of buckets) {
    const { items } = await fetchSimklWatchlistItems(accessToken, bucket, 'watching');
    considered += items.length;

    for (const item of items) {
      const next = resolveSimklNextEpisode(item);
      if (!next) continue;

      if (next.date) {
        const airsAt = new Date(next.date).getTime();
        if (Number.isFinite(airsAt) && airsAt > now) continue;
      }

      const media = item.anime || item.show || item;
      const ids = enrichSimklIds(media);

      let target: { stremioId: string; season: number; episode: number } | null = null;
      if (bucket === 'anime') {
        target = resolveSimklAnimeTarget(ids, next.episode, config);
        if (!target) unmappedAnime++;
      } else if (next.season !== null) {
        if (ids.imdb) target = { stremioId: normalizeImdbId(ids.imdb), season: next.season, episode: next.episode };
        else if (ids.tmdb) target = { stremioId: `tmdb:${ids.tmdb}`, season: next.season, episode: next.episode };
        else if (ids.tvdb) target = { stremioId: `tvdb:${ids.tvdb}`, season: next.season, episode: next.episode };
      }

      if (!target) {
        logger.debug(`[Simkl Up Next] Skipping ${media.title || 'Unknown'} (${bucket}), no usable target`);
        continue;
      }

      upNext.push({
        ...target,
        episodeTitle: next.title,
        showTitle: media.title,
        lastWatchedAt: item.last_watched_at,
      });
    }
  }

  upNext.sort((a, b) => {
    const timeA = a.lastWatchedAt ? new Date(a.lastWatchedAt).getTime() : 0;
    const timeB = b.lastWatchedAt ? new Date(b.lastWatchedAt).getTime() : 0;
    if (timeB !== timeA) return timeB - timeA;
    return (a.showTitle || '').localeCompare(b.showTitle || '');
  });

  const unmapped = unmappedAnime ? `, ${unmappedAnime} anime unmapped` : '';
  logger.info(`[Simkl Up Next] ${upNext.length} with an aired next episode (from ${considered} watching${unmapped})`);
  return upNext;
}

async function parseSimklUpNextItems(
  items: SimklUpNextItem[],
  config: UserConfig,
  userUUID: string,
  useShowPoster: boolean = false
): Promise<any[]> {
  const metas = await Promise.all(
    items.map(async (item) => {
      try {
        const cacheId = `simkl_upnext_${item.stremioId}_S${item.season}E${item.episode}`;

        const result = await cacheWrapMetaSmart(
          userUUID,
          cacheId,
          async () => {
            const metaResult = await getMeta('series', config.language, item.stremioId, config, userUUID, true);
            const meta = metaResult?.meta;
            if (!meta || !Array.isArray(meta.videos)) return metaResult;

            const nextVideo = meta.videos.find((v: any) => v.season === item.season && v.episode === item.episode);
            if (!nextVideo) {
              logger.warn(`[Simkl Up Next] S${item.season}E${item.episode} not found in videos for ${meta.name}`);
              return metaResult;
            }

            meta.videos = [nextVideo];
            meta.behaviorHints = meta.behaviorHints || {};
            meta.behaviorHints.defaultVideoId = nextVideo.id;

            if (!useShowPoster && nextVideo.thumbnail
                && nextVideo.thumbnail !== meta.poster
                && !nextVideo.thumbnail.includes('/missing_thumbnail.png')) {
              let thumbnailUrl = nextVideo.thumbnail;
              if (thumbnailUrl.includes('/poster/') && thumbnailUrl.includes('fallback=')) {
                try {
                  const fallback = new URL(thumbnailUrl).searchParams.get('fallback');
                  if (fallback) thumbnailUrl = decodeURIComponent(fallback);
                } catch {}
              }
              if (thumbnailUrl && thumbnailUrl !== meta.poster && !thumbnailUrl.includes('/missing_thumbnail.png')) {
                meta.poster = thumbnailUrl;
                meta._rawPosterUrl = null;
                meta.posterShape = 'landscape';
              }
            }

            meta.name = `${meta.name} - S${item.season}E${item.episode}`;
            meta.id = cacheId;
            return metaResult;
          },
          undefined,
          { enableErrorCaching: true, maxRetries: 2, config },
          'series' as any,
          true,
          useShowPoster
        );

        return result?.meta || null;
      } catch (err: any) {
        logger.warn(`[Simkl Up Next] Failed to parse ${item.stremioId}: ${err.message}`);
        return null;
      }
    })
  );

  return metas.filter(Boolean);
}

export {
  fetchSimklUserStats,
  fetchSimklSearchItems,
  fetchSimklItemDetail,
  fetchSimklWatchlistItems,
  fetchSimklUpNextItems,
  parseSimklUpNextItems,
  parseSimklItems,
  makeAuthenticatedSimklRequest,
  getSimklRatings,
  getSimklToken,
  getSimklWatchedIds,
  fetchSimklWatchedItems,
  getSimklActivityFingerprint,
  fetchSimklTrendingItems,
  fetchSimklRecipeItems,
  fetchSimklDvdReleases,
  fetchSimklGenreItems,
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
        const url = `https://data.simkl.in/calendar/${type}.json?${simklDataParams()}`;
        // Use a simple GET request for the CDN file
        const response: any = await makeRateLimitedRequest(
          () => httpGet(url, { dispatcher: simklDispatcher }),
          `Simkl Calendar (${type})`
        );
        return Array.isArray(response.data) ? response.data : [];
      },
      cacheTTL,
      { upstream: true, sourceList: true }
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
