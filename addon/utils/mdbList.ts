import { historyPayload, type EpisodeRef } from './historyPayload';
import { httpGet, httpPost } from "./httpClient.js";
import { resolveAllIds } from "../lib/id-resolver.js";
const buildInfo = require('../lib/buildInfo');
import { getMeta } from "../lib/getMeta.js";
import { mapWithLimit } from "./concurrency.js";
import { cacheWrapMetaSmart, cacheWrapMDBListGenres, cacheWrapGlobal } from "../lib/getCache.js";
import { UserConfig } from "../types/index.js";
import { getSetting } from "../lib/settingsService.js";
import { envInt } from "./envNumber.js";
const consola = require('consola');
const crypto = require('crypto');
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
      mdblistDispatcher = new ProxyAgent({ uri: new URL(HTTP_PROXY_URL).toString(), allowH2: false });
      logger.info('[MDBList] Using global HTTP proxy.');
    } catch (error: any) {
      logger.error(`[MDBList] Invalid HTTP_PROXY URL. Using direct connection. Error: ${error.message}`);
      mdblistDispatcher = new Agent({ allowH2: false, connect: { timeout: 30000 } });
    }
  } else {
    mdblistDispatcher = new Agent({ allowH2: false, connect: { timeout: 30000 } });
    logger.debug('[MDBList] undici agent is enabled for direct connections.');
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
  baseDelay: 1000,
  maxDelay: 30000,
  maxRetryAfter: 120000,
  rateLimitDelay: 5000,
  minInterval: 210, 
  backoffMultiplier: 2
};


interface RateLimitState {
  recentRateLimitHits: number;
  lastRateLimitTime: number;
  isRateLimited: boolean;
  rateLimitResetTime: number;
  lastLimit?: number;
  lastRemaining?: number;
  lastReset?: number;
}

const rateLimitStates = new Map<string, RateLimitState>();

let globalLastRequestTime = 0;
let globalRequestPromise = Promise.resolve();

/**
 * Global throttle to satisfy Cloudflare IP limits
 * Forces requests into a single-file line
 */
async function globalThrottle(): Promise<void> {
  // Chain this request to the previous one
  const currentRequest = globalRequestPromise.then(async () => {
    const now = Date.now();
    const timeSinceLast = now - globalLastRequestTime;
    
    if (timeSinceLast < RATE_LIMIT_CONFIG.minInterval) {
      const waitTime = RATE_LIMIT_CONFIG.minInterval - timeSinceLast;
      await sleep(waitTime);
    }
    
    globalLastRequestTime = Date.now();
  });

  // Update the global chain
  globalRequestPromise = currentRequest;
  
  // Wait for our turn
  await currentRequest;
}
// ---------------------------------------

function getRateLimitState(apiKey: string = 'global'): RateLimitState {
  if (!rateLimitStates.has(apiKey)) {
    rateLimitStates.set(apiKey, {
      recentRateLimitHits: 0,
      lastRateLimitTime: 0,
      isRateLimited: false,
      rateLimitResetTime: 0,
      lastLimit: undefined,
      lastRemaining: undefined,
      lastReset: undefined
    });
  }
  return rateLimitStates.get(apiKey)!;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimitError(error: any): boolean {
  return error.response?.status === 429 || error.response?.status === 503;
}

/**
 * Rate limiting and retry logic for MDBList API calls
 * Tracks provider calls only for final outcomes (not each retry attempt)
 */
async function makeRateLimitedRequest<T>(
  requestFn: () => Promise<T>,
  apiKey: string,
  context: string = 'MDBList',
  retries: number = RATE_LIMIT_CONFIG.maxRetries
): Promise<T> {
  let attempt = 0;
  const state = getRateLimitState(apiKey);
  const overallStartTime = Date.now();

  if (state.lastRemaining === 0 && state.lastReset && Date.now() < state.lastReset * 1000) {
    const quotaError = new Error('MDBList API quota exhausted (remaining=0).') as Error & { code?: string; response?: any };
    quotaError.code = 'MDBLIST_QUOTA_EXHAUSTED';
    quotaError.response = { status: 429 };
    logger.warn(`[MDBList] Quota exhausted, skipping request - ${context}`);
    throw quotaError;
  }

  while (attempt < retries) {
    attempt++;
    const isLastAttempt = attempt === retries;

    const now = Date.now();
    
    // 1. Check User-specific Penalty Box (from previous 429 errors)
    if (state.isRateLimited && state.rateLimitResetTime > now) {
      const waitTime = state.rateLimitResetTime - now;
      logger.debug(`Rate limit cooldown active for key ending in ...${apiKey.slice(-4)}, waiting ${waitTime}ms - ${context}`);
      await sleep(waitTime);
    }
    state.isRateLimited = false;

    // 2. Enforce GLOBAL IP Limit (The Fix)
    // This pauses execution until it is safe to send relative to ALL other users
    await globalThrottle();
    
    const startTime = Date.now();
    
    try {
      const response = await requestFn();
      const responseTime = Date.now() - startTime;
      
      // Track success only once on first successful attempt
      const requestTracker = require('../lib/requestTracker.js');
      requestTracker.trackProviderCall('mdblist', responseTime, true);

      // --- MDBList Rate Limit Header Logging ---
      const headers = (response && typeof response === 'object' && 'headers' in response && response.headers && typeof response.headers === 'object') ? response.headers as Record<string, string> : undefined;
      if (headers) {
        const limit = headers['x-ratelimit-limit'];
        const remaining = headers['x-ratelimit-remaining'];
        const reset = headers['x-ratelimit-reset'];
        if (limit || remaining || reset) {
          logger.debug(`[MDBList] Rate limit: limit=${limit}, remaining=${remaining}, reset=${reset}`);
        }
        state.lastLimit = limit ? parseInt(limit) : undefined;
        state.lastRemaining = remaining ? parseInt(remaining) : undefined;
        state.lastReset = reset ? parseInt(reset) : undefined;
      }

      state.recentRateLimitHits = 0;
      return response;
    } catch (error: any) {
      if (isPermanentError(error)) {
        // Track failure for permanent errors (no retry)
        const responseTime = Date.now() - overallStartTime;
        const requestTracker = require('../lib/requestTracker.js');
        requestTracker.trackProviderCall('mdblist', responseTime, false);
        logger.error(`Request failed with permanent error, no retry: ${error.message} - ${context}`);
        requestTracker.logError('error', `MDBList API permanent error`, { context, status: error.response?.status, message: error.message, responseTime });
        throw error;
      }
      
      if (isRateLimitError(error)) {
        state.lastRateLimitTime = Date.now();
        state.recentRateLimitHits++;

        const headers = (error.response && typeof error.response === 'object' && 'headers' in error.response && error.response.headers && typeof error.response.headers === 'object') ? error.response.headers as Record<string, string> : {};
        const limit = headers['x-ratelimit-limit'];
        const remaining = headers['x-ratelimit-remaining'];
        const reset = headers['x-ratelimit-reset'];
        const retryAfter = headers['retry-after'];
        if (limit || remaining || reset || retryAfter) {
          logger.warn(`[MDBList] Rate limit error: limit=${limit}, remaining=${remaining}, reset=${reset}, retry-after=${retryAfter}`);
        }
        state.lastLimit = limit ? parseInt(limit) : undefined;
        state.lastRemaining = remaining ? parseInt(remaining) : undefined;
        state.lastReset = reset ? parseInt(reset) : undefined;

        if (isLastAttempt) {
          // Track failure only when all retries exhausted
          const responseTime = Date.now() - overallStartTime;
          const requestTracker = require('../lib/requestTracker.js');
          requestTracker.trackProviderCall('mdblist', responseTime, false);
          logger.error(`Rate limit exceeded after ${retries} attempts: ${error.message} - ${context}`);
          throw error;
        }

        let backoffTime = 0;
        if (retryAfter) {
          const retrySeconds = parseInt(retryAfter);
          if (!isNaN(retrySeconds)) {
            backoffTime = retrySeconds * 1000;
          }
        }
        if (!backoffTime) {
          backoffTime = RATE_LIMIT_CONFIG.rateLimitDelay * Math.pow(2, state.recentRateLimitHits - 1);
          const jitter = Math.random() * 1000;
          backoffTime = Math.min(backoffTime + jitter, RATE_LIMIT_CONFIG.maxDelay);
        }

        if (backoffTime > RATE_LIMIT_CONFIG.maxRetryAfter) {
          state.lastRemaining = 0;
          state.lastReset = Math.ceil((Date.now() + backoffTime) / 1000);
          const requestTracker = require('../lib/requestTracker.js');
          requestTracker.trackProviderCall('mdblist', Date.now() - overallStartTime, false);
          logger.warn(`Rate limited for ${Math.round(backoffTime / 1000)}s, skipping MDBList until then - ${context}`);
          throw error;
        }

        logger.warn(`Rate limit hit. Retrying in ${Math.round(backoffTime)}ms (attempt ${attempt}/${retries}) - ${context}`);

        // Set User Penalty Box
        state.isRateLimited = true;
        state.rateLimitResetTime = Date.now() + backoffTime;

        await sleep(backoffTime);
        continue;
      }
      
      // For other temporary errors, only track failure on last attempt
      if (isLastAttempt) {
        const responseTime = Date.now() - overallStartTime;
        const requestTracker = require('../lib/requestTracker.js');
        requestTracker.trackProviderCall('mdblist', responseTime, false);
      }
      
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

/** MDBList meters requests, not rows. 1000 is the endpoint ceiling; the page size restores one request per page. */
function listBlockSize(pageSize: number): number {
  const configured = parseInt(getSetting('MDBLIST_LIST_BLOCK_SIZE'), 10);
  const size = Number.isFinite(configured) && configured > 0 ? configured : 500;
  return Math.max(pageSize, Math.min(size, 1000));
}

function buildListItemsUrl(opts: { listId: string; apiKey: string; limit: number; offset: number; sort?: string; order?: string; genre?: string; unified?: boolean; filterScoreMin?: number; filterScoreMax?: number; mediaTypeFilter?: string }): string {
  const { listId, apiKey, limit, offset } = opts;
  const base = listId === 'watchlist'
    ? 'https://api.mdblist.com/watchlist/items'
    : `https://api.mdblist.com/lists/${listId}/items`;
  let url = `${base}?limit=${limit}&offset=${offset}&apikey=${apiKey}&append_to_response=genre,poster&unified=${opts.unified !== false}`;

  if (opts.sort && opts.sort.trim() !== '') url += `&sort=${opts.sort}`;
  if (opts.order && opts.order.trim() !== '') url += `&order=${opts.order}`;
  if (opts.genre && opts.genre.toLowerCase() !== 'none') url += `&filter_genre=${encodeURIComponent(opts.genre)}`;
  if (typeof opts.filterScoreMin === 'number') url += `&filter_score_min=${opts.filterScoreMin}`;
  if (typeof opts.filterScoreMax === 'number') url += `&filter_score_max=${opts.filterScoreMax}`;
  // MDBList spells series "show".
  if (opts.mediaTypeFilter) url += `&mediatype=${opts.mediaTypeFilter}`;

  return url;
}

/**
 * Read unified, the only form that says where each entry sits in the list.
 * Neither `unified` nor `catalogType` is keyed, so one fetch serves both.
 */
/** Rebuilds what `unified=false` would have answered for the same window. */
function splitWindowByType(window: any[], catalogType?: string): any[] {
  if (catalogType === 'series') return window.filter((r) => r?.mediatype === 'show');
  if (catalogType === 'movie') return window.filter((r) => r?.mediatype === 'movie');
  return [
    ...window.filter((r) => r?.mediatype === 'movie'),
    ...window.filter((r) => r?.mediatype === 'show'),
  ];
}

async function fetchListBlock(opts: { listId: string; apiKey: string; keyScope: string; blockOffset: number; blockSize: number; sort?: string; order?: string; genre?: string; filterScoreMin?: number; filterScoreMax?: number; mediaTypeFilter?: string; ttl: number; ttlSegment: string }): Promise<{ rows: any[]; totalItems?: number; hasMore: boolean }> {
  const { listId, keyScope, blockOffset, blockSize } = opts;
  const cacheKey = `mdblist-api:block:${keyScope}:${listId}:${blockOffset}:${blockSize}:${opts.sort || ''}:${opts.order || ''}:${opts.genre || ''}:${opts.filterScoreMin ?? ''}:${opts.filterScoreMax ?? ''}:${opts.mediaTypeFilter || ''}${opts.ttlSegment}`;

  return cacheWrapGlobal(cacheKey, async () => {
    const url = buildListItemsUrl({ ...opts, unified: true, limit: blockSize, offset: blockOffset });
    logger.debug(`MDBList block request URL: ${sanitizeUrlForLogging(url)}`);

    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, { dispatcher: mdblistDispatcher }),
      opts.apiKey,
      `MDBList fetchListBlock (listId: ${listId}, offset: ${blockOffset}, blockSize: ${blockSize})`
    );

    const rows: any[] = Array.isArray(response.data) ? response.data : [];
    return {
      rows,
      totalItems: response.headers?.['x-total-items'] ? parseInt(response.headers['x-total-items']) : undefined,
      hasMore: response.headers?.['x-has-more'] === 'true',
    };
  }, opts.ttl, { upstream: true, sourceList: true });
}

async function fetchMDBListItems(listId: string, apiKey: string, language: string, page: number, sort?: string, order?: string, genre?: string, unified?: boolean, catalogType?: string, cacheTTL?: number, filterScoreMin?: number, filterScoreMax?: number, mediaTypeFilter?: string): Promise<{items: any[], totalItems?: number, hasMore?: boolean, totalPages?: number}> {
  // Use configurable page size (supports CATALOG_LIST_ITEMS_SIZE env var)
  const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20;

  const keyScope = (listId === 'watchlist' || listId.startsWith('recommended/'))
    ? crypto.createHash('sha256').update(apiKey).digest('hex').substring(0, 16)
    : 'shared';

  const ttlSegment = cacheTTL !== undefined ? `:ttl:${cacheTTL}` : '';
  const cacheKey = `mdblist-api:items:${keyScope}:${listId}:${page}:${sort || ''}:${order || ''}:${genre || ''}:${unified !== false}:${catalogType || ''}:${filterScoreMin ?? ''}:${filterScoreMax ?? ''}:${mediaTypeFilter || ''}:${pageSize}${ttlSegment}`;

  const ttl = cacheTTL !== undefined ? cacheTTL : parseInt(process.env.CATALOG_TTL || String(1 * 24 * 60 * 60), 10);

  try {
    return await cacheWrapGlobal(cacheKey, async () => {
      const offset = (page * pageSize) - pageSize;

      let items: any[];
      let totalItems: number | undefined;
      let hasMore: boolean;

      // x-total-items counts the whole list, ignoring these.
      const filtered = !!mediaTypeFilter
        || (!!genre && genre.toLowerCase() !== 'none')
        || typeof filterScoreMin === 'number'
        || typeof filterScoreMax === 'number';

      const blockSize = listBlockSize(pageSize);
      if (blockSize > pageSize) {
        const blockOffset = Math.floor(offset / blockSize) * blockSize;
        const block = await fetchListBlock({
          listId, apiKey, keyScope, blockOffset, blockSize,
          sort, order, genre, filterScoreMin, filterScoreMax, mediaTypeFilter,
          ttl, ttlSegment,
        });
        const within = offset - blockOffset;
        const window = block.rows.slice(within, within + pageSize);
        // Both forms page the same merged list; the split one only buckets its window.
        items = unified !== false ? window : splitWindowByType(window, catalogType);
        // Rows left in this block, else the block's word on what follows.
        hasMore = within + pageSize < block.rows.length ? true : block.hasMore;
        // Offsets run over the filtered sequence, so a final block counts exactly.
        totalItems = !block.hasMore
          ? blockOffset + block.rows.length
          : (filtered ? undefined : block.totalItems);
      } else {
        const url = buildListItemsUrl({
          listId, apiKey, limit: pageSize, offset,
          sort, order, genre, unified, filterScoreMin, filterScoreMax, mediaTypeFilter,
        });
        logger.debug(`MDBList request URL: ${sanitizeUrlForLogging(url)}`);

        const response: any = await makeRateLimitedRequest(
          () => httpGet(url, { dispatcher: mdblistDispatcher }),
          apiKey,
          `MDBList fetchMDBListItems (listId: ${listId}, page: ${page}, pageSize: ${pageSize}, sort: ${sort}, order: ${order}, genre: ${genre})`
        );

        hasMore = response.headers?.['x-has-more'] === 'true';
        const reported = response.headers?.['x-total-items'] ? parseInt(response.headers['x-total-items']) : undefined;
        totalItems = filtered ? undefined : reported;

        const hasMoviesShowsStructure = response.data &&
                                        typeof response.data === 'object' &&
                                        !Array.isArray(response.data) &&
                                        ('movies' in response.data || 'shows' in response.data);

        if (hasMoviesShowsStructure) {
          if (catalogType === 'series') {
            items = response.data.shows || [];
          } else if (catalogType === 'movie') {
            items = response.data.movies || [];
          } else {
            items = [
              ...(response.data?.movies || []),
              ...(response.data?.shows || [])
            ];
          }
        } else if (Array.isArray(response.data)) {
          items = response.data;
        } else {
          items = [
            ...(response.data?.movies || []),
            ...(response.data?.shows || [])
          ];
        }
      }

      // For watchlist, we can only rely on X-Has-More header
      let totalPages: number | undefined;
      if (listId === 'watchlist') {
        totalItems = undefined; // Watchlist doesn't provide total items
        totalPages = undefined; // Can't calculate pages without total items
      } else {
        // Calculate total pages from headers for regular lists
        totalPages = totalItems ? Math.ceil(totalItems / pageSize) : undefined;
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
    }, ttl, { upstream: true, sourceList: true });
  } catch (err: any) {
    logger.error(`Error retrieving items for list ${listId}, page ${page}:`, err.message);
    return { items: [] };
  }
}


/**
 * Fetches the user's personal movie ratings from MDBList's `/sync/ratings`.
 * Always a full snapshot: the endpoint's `since` filters on when the rating was
 * given, so ratings imported from Trakt keep their original date and never come
 * back. One request covers a thousand ratings, so there is little to save anyway.
 * Returns the raw `movies[]` items
 * (shape: { rated_at, rating, movie: { title, year, ids: { imdb } } }).
 * @param {string} apiKey - MDBList API key
 */
async function getRatingsFromMDBList(apiKey: string): Promise<any[]> {
  if (!apiKey) {
    logger.warn("Missing API key for getRatingsFromMDBList");
    return [];
  }
  const pageSize = Math.min(parseInt(process.env.MDBLIST_RATINGS_PAGE_SIZE || '1000', 10), 1000);
  const maxPages = parseInt(process.env.MDBLIST_RATINGS_MAX_PAGES || '100', 10);
  const movies: any[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    let url = `https://api.mdblist.com/sync/ratings?apikey=${apiKey}&limit=${pageSize}`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, { dispatcher: mdblistDispatcher }),
      apiKey,
      `MDBList getRatingsFromMDBList (page ${page + 1})`
    );

    const data = response?.data || {};
    if (Array.isArray(data.movies)) movies.push(...data.movies);
    const next = data.pagination?.next_cursor || null;
    if (!next || next === cursor) break;
    cursor = next;
  }

  return movies;
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
      apiKey,
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
        apiKey,
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


const MDBLIST_BY_NAME_ITEMS_PATTERN = /api\.mdblist\.com\/lists\/[^/]+\/[^/]+\/items/;

function usesMdblistExternalItemsEndpoint(catalogConfig: any): boolean {
  const sourceUrl = catalogConfig?.sourceUrl;
  if (typeof sourceUrl !== 'string') return false;
  return sourceUrl.includes('/external/lists/') || MDBLIST_BY_NAME_ITEMS_PATTERN.test(sourceUrl);
}

function supportsMdblistScoreFilters(catalogConfig: any): boolean {
  const id = catalogConfig?.id;
  if (typeof id !== 'string' || !id.startsWith('mdblist.')) return false;
  return id !== 'mdblist.upnext'
    && !id.startsWith('mdblist.discover.')
    && !id.startsWith('mdblist.recommended.');
}

async function fetchCursorBlock(opts: { baseUrl: string; apiKey: string; blockIndex: number; blockSize: number; sort?: string; order?: string; genre?: string; filterScoreMin?: number; filterScoreMax?: number; mediaTypeFilter?: string; ttl: number; ttlSegment: string }): Promise<{ rows: any[]; hasMore: boolean; nextCursor: string | null }> {
  const { baseUrl, blockIndex, blockSize } = opts;
  const cacheKey = `mdblist-api:cursor-block:${baseUrl}:${blockIndex}:${blockSize}:${opts.sort || ''}:${opts.order || ''}:${opts.genre || ''}:${opts.filterScoreMin ?? ''}:${opts.filterScoreMax ?? ''}:${opts.mediaTypeFilter || ''}${opts.ttlSegment}`;

  return cacheWrapGlobal(cacheKey, async () => {
    let cursor: string | null = null;
    if (blockIndex > 0) {
      const previous = await fetchCursorBlock({ ...opts, blockIndex: blockIndex - 1 });
      if (!previous.hasMore || !previous.nextCursor) return { rows: [], hasMore: false, nextCursor: null };
      cursor = previous.nextCursor;
    }

    const url = new URL(baseUrl);
    url.searchParams.set('apikey', opts.apiKey);
    url.searchParams.set('limit', String(blockSize));
    url.searchParams.set('unified', 'true');
    url.searchParams.set('append_to_response', 'genre,poster');
    if (cursor) url.searchParams.set('cursor', cursor);
    if (opts.sort && opts.sort.trim() !== '') url.searchParams.set('sort', opts.sort);
    if (opts.order && opts.order.trim() !== '') url.searchParams.set('order', opts.order);
    if (opts.genre && opts.genre.toLowerCase() !== 'none') url.searchParams.set('filter_genre', opts.genre);
    if (typeof opts.filterScoreMin === 'number') url.searchParams.set('filter_score_min', String(opts.filterScoreMin));
    if (typeof opts.filterScoreMax === 'number') url.searchParams.set('filter_score_max', String(opts.filterScoreMax));
    if (opts.mediaTypeFilter) url.searchParams.set('mediatype', opts.mediaTypeFilter);

    logger.debug(`MDBList cursor block request URL: ${sanitizeUrlForLogging(url.toString())}`);
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url.toString(), { dispatcher: mdblistDispatcher }),
      opts.apiKey,
      `MDBList fetchCursorBlock (url: ${sanitizeUrlForLogging(baseUrl)}, block: ${blockIndex}, blockSize: ${blockSize})`
    );

    const hasMore = response.headers?.['x-has-more'] === 'true';
    return {
      rows: Array.isArray(response.data) ? response.data : [],
      hasMore,
      nextCursor: hasMore ? (response.headers?.['x-next-cursor'] || null) : null,
    };
  }, opts.ttl, { upstream: true, sourceList: true });
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
  filterScoreMax?: number,
  cacheTTL?: number
): Promise<{items: any[], totalItems?: number, hasMore?: boolean, totalPages?: number}> {
  const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20;

  const normalizedUrl = new URL(url);
  if (normalizedUrl.protocol !== 'https:' || normalizedUrl.hostname !== 'api.mdblist.com') {
    throw new Error(`Not an MDBList list URL: ${normalizedUrl.origin}`);
  }
  for (const param of ['apikey', 'limit', 'offset', 'cursor', 'language', 'append_to_response', 'unified', 'sort', 'order', 'filter_genre', 'filter_score_min', 'filter_score_max', 'mediatype']) {
    normalizedUrl.searchParams.delete(param);
  }
  const urlBase = normalizedUrl.toString();

  const mediaTypeFilter = unified === false
    ? (catalogType === 'movie' ? 'movie' : catalogType === 'series' ? 'show' : undefined)
    : undefined;
  const ttlSegment = cacheTTL !== undefined ? `:ttl:${cacheTTL}` : '';
  const cacheKey = `mdblist-api:external:v2:shared:${urlBase}:${page}:${sort || ''}:${order || ''}:${genre || ''}:${catalogType || ''}:${unified !== false}:${filterScoreMin ?? ''}:${filterScoreMax ?? ''}:${pageSize}${ttlSegment}`;

  const ttl = cacheTTL !== undefined ? cacheTTL : parseInt(process.env.CATALOG_TTL || String(1 * 24 * 60 * 60), 10);

  try {
    return await cacheWrapGlobal(cacheKey, async () => {
      const offset = (page * pageSize) - pageSize;
      const blockSize = listBlockSize(pageSize);
      const blockIndex = Math.floor(offset / blockSize);
      const block = await fetchCursorBlock({
        baseUrl: urlBase, apiKey, blockIndex, blockSize,
        sort, order, genre, filterScoreMin, filterScoreMax, mediaTypeFilter,
        ttl, ttlSegment,
      });
      const within = offset - blockIndex * blockSize;
      const window = block.rows.slice(within, within + pageSize);
      const items = unified !== false ? window : splitWindowByType(window, catalogType);
      const hasMore = within + pageSize < block.rows.length ? true : block.hasMore;
      return { items, hasMore };
    }, ttl, { upstream: true, sourceList: true });
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
  const normalizedItems = filteredItems
  .filter((item: any) => item.mediatype === 'movie' || item.mediatype === 'show')
  .map((item: any) => {
    if (!item.id || item.id === null || item.id === undefined) {
      // Prefer tmdb_id for catalog endpoint items (used as tmdb:{id} downstream)
      if (item.tmdb_id) {
        return { ...item, id: item.tmdb_id };
      }
      if(item.imdb_id && item.imdb_id.startsWith('tr')) item.imdb_id = null;
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
 
  const metas = await mapWithLimit(validItems, async (item: any) => {
      try {
        let stremioId = `tmdb:${item.id}`;
        const mdblistType = item.mediatype === 'movie' ? 'movie' : 'series';

        const result = await cacheWrapMetaSmart(config.userUUID || '', stremioId, async () => {
          return await getMeta(mdblistType, language, stremioId, config, config.userUUID, includeVideos);
        }, undefined, {enableErrorCaching: true, maxRetries: 2, config}, mdblistType as any, includeVideos);

        if (result && result.meta) {
          return result.meta;
        }
        return null;
      } catch (error: any) {
        logger.error(`Error getting meta for item ${item.id}:`, error.message);
        return null;
      }
    });

  return metas.filter(Boolean);
}

// Global genre mapping cache (title -> slug)
let genreTitleToSlugMap: Map<string, string> | null = null;

async function fetchMDBListGenres(apiKey: string, isAnime: boolean = false): Promise<string[]> {
  try {
    const cacheKey = `genres-raw-${isAnime ? 'anime' : 'standard'}`;

    const genresData: Array<{title: string, slug: string}> = await cacheWrapMDBListGenres(cacheKey, async () => {
      const animeParam = isAnime ? 1 : 0;
      const url = `https://api.mdblist.com/genres/?apikey=${apiKey}&anime=${animeParam}`;

      return await makeRateLimitedRequest(async () => {
        logger.debug(`Fetching MDBList genres from API (anime=${animeParam})`);

        const response = await fetch(url, {
          headers: {
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
          throw new Error(`MDBList genres API returned ${response.status}`);
        }

        const data = await response.json();

        if (!Array.isArray(data)) {
          throw new Error('MDBList genres API returned invalid format');
        }

        logger.info(`Successfully fetched ${data.length} ${isAnime ? 'anime' : 'standard'} genres from MDBList API`);
        return data.filter((g: any) => g.title && g.slug);
      }, apiKey, `MDBList Genres API (anime=${animeParam})`);
    });

    if (!genreTitleToSlugMap) {
      genreTitleToSlugMap = new Map();
    }
    genresData.forEach((g) => {
      genreTitleToSlugMap!.set(g.title.toLowerCase(), g.slug);
    });

    return genresData.map(g => g.title);
  } catch (err: any) {
    logger.error(`Error fetching MDBList genres (anime=${isAnime}):`, err.message);
    return [];
  }
}

async function fetchMdbListSearchItems(query: string, type: string, apiKey: string): Promise<any[]> {
  const url = `https://api.mdblist.com/search/${type}?query=${encodeURIComponent(query)}&limit=30&quick_search=true&apikey=${apiKey}`;

  const res: Response = await makeRateLimitedRequest(async () => {
    return await fetch(url, { headers: { Accept: "application/json" } });
  }, apiKey, `MDBList Search API (type=${type})`);

  const data = await res.json() as any;

  return data.search ?? [];
}

async function convertGenreToSlug(genre: string, apiKey?: string): Promise<string> {
  if (!genre || genre.toLowerCase() === 'none') {
    return genre;
  }

  if (!genreTitleToSlugMap || genreTitleToSlugMap.size === 0) {
    const key = apiKey || process.env.MDBLIST_API_KEY || process.env.BUILT_IN_MDBLIST_API_KEY || '';
    if (key) {
      await fetchMDBListGenres(key, false);
      await fetchMDBListGenres(key, true);
    }
  }

  if (genreTitleToSlugMap) {
    const slug = genreTitleToSlugMap.get(genre.toLowerCase());
    if (slug) {
      return slug;
    }
  }

  // Fallback: genre is already in slug format or direct conversion
  return genre.toLowerCase();
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
 * Wrapper for proxy endpoints - makes a rate-limited GET request to MDBList
 */
async function makeRateLimitedMDBListRequest(url: string, apiKey: string, context: string = 'MDBList Proxy'): Promise<any> {
  return await makeRateLimitedRequest(
    () => httpGet(url, { dispatcher: mdblistDispatcher }),
    apiKey,
    context
  );
}

async function makeRateLimitedMDBListPost(url: string, body: any, apiKey: string, context: string = 'MDBList Proxy'): Promise<any> {
  return await makeRateLimitedRequest(
    () => httpPost(url, body, { headers: { 'Content-Type': 'application/json' }, timeout: 10000, dispatcher: mdblistDispatcher }),
    apiKey,
    context
  );
}

/**
 * Validate an MDBList API key using the rate-limited path with no retries.
 */
async function testMdblistKey(
  apiKey: string
): Promise<boolean> {
  if (!apiKey || apiKey.trim() === '') {
    const emptyKeyError = new Error('MDBList API key is empty.') as Error & { statusCode?: number };
    emptyKeyError.statusCode = 400;
    throw emptyKeyError;
  }

  const url = `https://api.mdblist.com/user?apikey=${apiKey}`;
  const response = await makeRateLimitedRequest(
    () => httpGet(url, { dispatcher: mdblistDispatcher, timeout: 5000 }),
    apiKey,
    'MDBList Proxy - Get User (API Key Test)',
    1
  );

  const remainingRaw = response?.data?.rate_limit_remaining;
  const remaining =
    typeof remainingRaw === 'number' || typeof remainingRaw === 'string'
      ? Number(remainingRaw)
      : NaN;

  if (!Number.isNaN(remaining) && remaining <= 0) {
    const quotaError = new Error('MDBList API quota exhausted (rate_limit_remaining=0).') as Error & { code?: string };
    quotaError.code = 'MDBLIST_QUOTA_EXHAUSTED';
    throw quotaError;
  }

  return true;
}

/**
 * Fetch MDBList Up Next shows for a user
 * @param apiKey - User's MDBList API key
 * @param page - Page number (default: 1)
 * @param limit - Number of items per page (default: 20, max: 100)
 * @returns Object with items array and pagination info
 */
async function fetchMDBListUpNext(
  apiKey: string,
  page: number = 1,
  limit: number = 20,
  hideUnreleased?: boolean
): Promise<{ items: any[], hasMore: boolean, limit: number }> {
  if (!apiKey) {
    logger.warn('[MDBList Up Next] Missing API key');
    return { items: [], hasMore: false, limit };
  }

  try {
    // Use configurable page size (supports CATALOG_LIST_ITEMS_SIZE env var)
    // Use provided limit if valid, otherwise use env var or default
    const pageSize = limit > 0 ? limit : (parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20);
    // Ensure page is a number and calculate offset
    const pageNum = typeof page === 'number' ? page : parseInt(String(page), 10) || 1;
    const offset = (pageNum * pageSize) - pageSize;
    let url = `https://api.mdblist.com/upnext?apikey=${apiKey}&limit=${pageSize}&offset=${offset}`;
    if (hideUnreleased !== undefined) {
      url += `&hide_unreleased=${hideUnreleased}`;
    }
    
    logger.debug(`[MDBList Up Next] Fetching page ${pageNum} (limit: ${pageSize}, offset: ${offset})`);
    
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, { dispatcher: mdblistDispatcher }),
      apiKey,
      `MDBList fetchMDBListUpNext (page: ${pageNum}, limit: ${pageSize})`
    );

    const items = response.data?.items || [];
    const hasMore = response.data?.has_more || false;
    
    logger.info(`[MDBList Up Next] Fetched ${items.length} items (hasMore: ${hasMore})`);
    
    return {
      items,
      hasMore,
      limit: response.data?.limit || pageSize
    };
  } catch (error: any) {
    logger.error(`[MDBList Up Next] Error fetching up next shows: ${error.message}`);
    return { items: [], hasMore: false, limit };
  }
}

/**
 * The next future episode of every show the user follows, airing within `days` (MDBList
 * caps it at 90): watchlisted, in progress or caught up. Callers decide which count as
 * upcoming. `instant` gives next_episode.air_date as a UTC timestamp, not a bare date.
 */
async function fetchMDBListUpcoming(apiKey: string, days: number, limit: number = 100): Promise<any[]> {
  if (!apiKey) return [];
  const window = Math.min(Math.max(1, Math.round(days)), 90);
  const pageSize = Math.min(Math.max(1, limit), 100);
  const maxPages = envInt('JELLYFIN_UPCOMING_MAX_PAGES', 10, 1);
  const items: any[] = [];
  try {
    for (let page = 0; page < maxPages; page += 1) {
      const url = `https://api.mdblist.com/upnext/upcoming/episodes?apikey=${apiKey}&days=${window}&limit=${pageSize}&offset=${page * pageSize}&air_date_format=instant`;
      const response: any = await makeRateLimitedRequest(
        () => httpGet(url, { dispatcher: mdblistDispatcher }),
        apiKey,
        `MDBList fetchMDBListUpcoming (days: ${window}, page: ${page + 1})`
      );
      const pageItems = Array.isArray(response.data?.items) ? response.data.items : [];
      items.push(...pageItems);
      if (!response.data?.has_more || pageItems.length === 0) break;
    }
  } catch (error: any) {
    logger.error(`[MDBList Upcoming] Error fetching upcoming episodes: ${error.message}`);
  }
  return items;
}

function mdblistEpisodeRef(show: any, episode: any): { ids: Record<string, any>; season: number; episode: number; tvdb: boolean } | null {
  const named = episode?.tvdb_ids;
  const tvdbSeason = Number(named?.season);
  const tvdbEpisode = Number(named?.episode);
  if (named?.series && Number.isFinite(tvdbSeason) && Number.isFinite(tvdbEpisode)) {
    const sameShow = String(show?.ids?.tvdb ?? '') === String(named.series);
    return { ids: { tvdb: named.series, ...(sameShow && show?.ids?.imdb ? { imdb: show.ids.imdb } : {}) }, season: tvdbSeason, episode: tvdbEpisode, tvdb: true };
  }
  const season = Number(episode?.season);
  const number = Number(episode?.episode);
  if (!Number.isFinite(season) || !Number.isFinite(number)) return null;
  return { ids: show?.ids ?? {}, season, episode: number, tvdb: false };
}

async function mdblistWatchedRef(episode: any, config: any): Promise<{ ids: Record<string, any>; season: number; episode: number; tvdb: boolean } | null> {
  const show = episode?.show;
  const named = mdblistEpisodeRef(show, { season: episode?.season, episode: episode?.number, tvdb_ids: episode?.tvdb_ids });
  if (named?.tvdb || show?.ids?.imdb || show?.ids?.tvdb || !episode?.ids?.tvdb) return named;
  const found = await require('../lib/tvdb').getEpisodeNumbering(String(episode.ids.tvdb), config).catch(() => null);
  return found ? { ids: { tvdb: found.seriesId }, season: found.season, episode: found.episode, tvdb: true } : named;
}

/**
 * Parse MDBList Up Next items into Stremio meta format
 * @param items - Array of MDBList up next items
 * @param language - Language code
 * @param config - User config
 * @param includeVideos - Whether to include videos
 * @param useShowPoster - Whether to use show poster instead of episode thumbnail
 * @returns Array of parsed meta objects
 */
async function parseMDBListUpNextItems(
  items: any[],
  language: string,
  config: UserConfig,
  includeVideos: boolean = false,
  useShowPoster: boolean = false
): Promise<any[]> {
  const parseStart = Date.now();
  
  logger.info(`[MDBList Up Next] Parsing ${items.length} items`);
  
  const getMetaTimings: number[] = [];
  
  const metas = await mapWithLimit(items, async (item: any, index: number) => {
      const itemStart = Date.now();
      try {
        const show = item.show;
        const nextEpisode = item.next_episode;

        if (!show || !nextEpisode) {
          logger.warn(`[MDBList Up Next] Item missing show or next_episode:`, item);
          return null;
        }

        const named = mdblistEpisodeRef(show, nextEpisode);
        const byTvdb = named?.tvdb === true && (config.providers?.series || 'tvdb') !== 'tmdb';
        const season = byTvdb ? named.season : nextEpisode.season;
        const episode = byTvdb ? named.episode : nextEpisode.episode;
        let stremioId: string;
        if (byTvdb) {
          stremioId = named.ids.imdb || `tvdb:${named.ids.tvdb}`;
        } else if (show.ids?.tmdb) {
          stremioId = `tmdb:${show.ids.tmdb}`;
        } else if (show.ids?.imdb) {
          stremioId = show.ids.imdb;
        } else {
          logger.warn(`[MDBList Up Next] Show has no usable ID:`, show.ids);
          return null;
        }

        const epIdPart = `S${season}E${episode}`;
        const cacheId = `mdblist_upnext_${stremioId}_${epIdPart}`;

        const getMetaStart = Date.now();
        const result = await cacheWrapMetaSmart(
          config.userUUID || '',
          cacheId,
          async () => {
            const metaResult = await getMeta('series', language, stremioId, config, config.userUUID, true);

            if (metaResult?.meta?.videos && Array.isArray(metaResult.meta.videos)) {
              const upNextVideo = metaResult.meta.videos.find((v: any) =>
                v.season === season &&
                v.episode === episode
              );

              if (upNextVideo) {
                metaResult.meta.videos = [upNextVideo];
                metaResult.meta.behaviorHints = metaResult.meta.behaviorHints || {};
                metaResult.meta.behaviorHints.defaultVideoId = upNextVideo.id;

                if (!useShowPoster) {
                  if (nextEpisode.still) {
                    metaResult.meta.poster = nextEpisode.still.startsWith('http')
                      ? nextEpisode.still
                      : `https://image.tmdb.org/t/p/w500${nextEpisode.still}`;
                  } else if (upNextVideo.thumbnail) {
                    metaResult.meta.poster = upNextVideo.thumbnail;
                  }

                  if (metaResult.meta.poster) {
                    metaResult.meta.posterShape = 'landscape';
                    if (metaResult.meta.poster.includes('/poster/') && metaResult.meta.poster.includes('fallback=')) {
                      try {
                        const url = new URL(metaResult.meta.poster);
                        const fallback = url.searchParams.get('fallback');
                        if (fallback) {
                          metaResult.meta.poster = decodeURIComponent(fallback);
                        }
                      } catch (e) {
                        logger.warn(`[MDBList Up Next] Failed to extract fallback poster URL: ${e.message}`);
                      }
                    }
                    metaResult.meta._rawPosterUrl = null;
                  }
                }

                metaResult.meta.name = `${metaResult.meta.name} - S${season}E${episode}`;
                metaResult.meta.id = cacheId;
              } else {
                logger.warn(`[MDBList Up Next] Episode S${season}E${episode} not found in videos for ${metaResult.meta.name}`);
              }
            }

            return metaResult;
          },
          undefined,
          { enableErrorCaching: true, maxRetries: 2, config },
          'series' as any,
          true,
          useShowPoster
        );

        const getMetaTime = Date.now() - getMetaStart;
        getMetaTimings.push(getMetaTime);

        if (result && result.meta) {
          return result.meta;
        }
        return null;
      } catch (error: any) {
        logger.error(`[MDBList Up Next] Error getting meta for item:`, error.message);
        return null;
      }
    });
  
  const validMetas = metas.filter(Boolean);
  const totalParseTime = Date.now() - parseStart;
  const avgGetMetaTime = getMetaTimings.length > 0 ? Math.round(getMetaTimings.reduce((a, b) => a + b, 0) / getMetaTimings.length) : 0;
  
  logger.info(`[MDBList Up Next] Successfully parsed ${validMetas.length} items into metas`);
  logger.info(`[MDBList Up Next] getMeta timings - avg: ${avgGetMetaTime}ms`);
  logger.info(`[MDBList Up Next] Total parsing time: ${totalParseTime}ms`);
  
  return validMetas;
}

// An episode always names its season and number: a show sent bare cascades to
// every season and episode it has.
async function historySync(
  path: 'watched' | 'watched/remove',
  idInput: Record<string, string | number>,
  apiKey: string,
  season?: number,
  episode?: number,
  episodes?: EpisodeRef[]
): Promise<boolean> {
  const payload = historyPayload(idInput, season, episode, episodes);

  try {
    const response: any = await makeRateLimitedRequest(
      () => httpPost(`https://api.mdblist.com/sync/${path}?apikey=${apiKey}`, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
        dispatcher: mdblistDispatcher,
      }),
      apiKey,
      `MDBList /sync/${path} (${formatIdSummary(idInput)})`
    );
    // A miss comes back inside a 200.
    const missed = response?.data?.not_found;
    const missing = ['movies', 'shows', 'episodes'].reduce((n, key) => n + (Array.isArray(missed?.[key]) ? missed[key].length : 0), 0);
    if (missing > 0) {
      logger.warn(`[MDBList] /sync/${path} did not find the title`, { ids: idInput, season, episode, not_found: missed });
      return false;
    }
    logger.info(`[MDBList] ${path === 'watched' ? 'Added to' : 'Removed from'} history`, { ids: idInput, season, episode });
    return true;
  } catch (error: any) {
    logger.error(`[MDBList] /sync/${path} failed: ${error.message}`);
    return false;
  }
}

async function addToHistory(
  idInput: Record<string, string | number>,
  apiKey: string,
  season?: number,
  episode?: number,
  episodes?: EpisodeRef[]
): Promise<boolean> {
  return historySync('watched', idInput, apiKey, season, episode, episodes);
}

async function removeFromHistory(
  idInput: Record<string, string | number>,
  apiKey: string,
  season?: number,
  episode?: number,
  episodes?: EpisodeRef[]
): Promise<boolean> {
  return historySync('watched/remove', idInput, apiKey, season, episode, episodes);
}

// A resume point is held separately from watched status, so clearing a watch
// leaves the item in continue-watching until the session is cleared as well.
async function clearScrobbleSession(
  idInput: Record<string, string | number>,
  apiKey: string,
  season?: number,
  episode?: number
): Promise<boolean> {
  if (!idInput || !apiKey) return false;

  const payload =
    season != null && episode != null
      ? { show: { ids: idInput, season: { number: season, episode: { number: episode } } } }
      : { movie: { ids: idInput } };

  // Not through the rate-limited wrapper: it counts every 4xx as a failed call
  // and logs it, and the usual answer here is 404. A title marked watched by
  // hand was never paused, so it holds no session, and that is not a failure.
  try {
    await httpPost(`https://api.mdblist.com/scrobble/clear?apikey=${apiKey}`, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
      dispatcher: mdblistDispatcher,
    });
    logger.info('[MDBList] Cleared the resume point', { ids: idInput, season, episode });
    return true;
  } catch (error: any) {
    if (error?.response?.status === 404) return true;
    logger.error(`[MDBList] Clearing the resume point failed: ${error.message}`);
    return false;
  }
}

export interface MdblistScrobbleOptions {
  /** checkin derives progress from elapsed time; start, pause and stop carry it. */
  action?: 'checkin' | 'start' | 'pause' | 'stop';
  /** 0-100. Stopping at 80 or above marks the item watched. */
  progress?: number;
}

function responseDetail(error: any): string {
  const data = error?.response?.data;
  const text = typeof data === 'string' ? data : data ? JSON.stringify(data) : '';
  return text ? ` (${text.slice(0, 300)})` : '';
}

function scrobblePath(action: string): string {
  return action === 'checkin' ? 'checkin' : `scrobble/${action}`;
}

function scrobbleUrl(action: string, apiKey: string): string {
  return `https://api.mdblist.com/${scrobblePath(action)}?apikey=${apiKey}`;
}

async function checkinMovie(
  idInput: Record<string, string | number>,
  apiKey: string,
  options: MdblistScrobbleOptions = {}
): Promise<boolean> {
  if (!idInput || !apiKey) return false;

  const action = options.action ?? 'checkin';
  try {
    const url = scrobbleUrl(action, apiKey);
    const payload = {
      movie: {
        ids: idInput
      },
      ...(action === 'checkin' ? {} : { progress: options.progress ?? 0 }),
      app_version: `AIOMetadata ${buildInfo.version}`,
      app_date: new Date().toISOString().split('T')[0]
    };

    logger.debug(`[MDBList ${action}] Reporting movie: ${formatIdSummary(idInput)}`);

    await makeRateLimitedRequest(
      () => httpPost(url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
        dispatcher: mdblistDispatcher
      }),
      apiKey,
      `MDBList ${scrobblePath(action)} (${formatIdSummary(idInput)})`
    );

    logger.info(`[MDBList ${action}] Movie reported`, { ids: idInput });
    return true;
  } catch (error: any) {
    if (error.response?.status === 409) {
      logger.info(`[MDBList ${action}] Session already managed by another API (409 Conflict)`);
      return true;
    }
    logger.error(`[MDBList ${action}] Movie report failed: ${error.message}${responseDetail(error)}`);
    return false;
  }
}

/**
 * Perform a manual check-in for a TV episode on MDBList
 */
async function checkinEpisode(
  idInput: Record<string, string | number>,
  season: number,
  episode: number,
  apiKey: string,
  options: MdblistScrobbleOptions = {}
): Promise<boolean> {
  if (!idInput || !apiKey) return false;

  const action = options.action ?? 'checkin';
  try {
    const url = scrobbleUrl(action, apiKey);
    
    // Note: MDBList uses a nested structure for episode check-ins
    const payload = {
      show: {
        ids: idInput,
        season: {
          number: season,
          episode: {
            number: episode
          }
        }
      },
      ...(action === 'checkin' ? {} : { progress: options.progress ?? 0 }),
      app_version: `AIOMetadata ${buildInfo.version}`,
      app_date: new Date().toISOString().split('T')[0]
    };

    logger.debug(`[MDBList ${action}] Reporting episode: ${formatIdSummary(idInput)} S${season}E${episode}`);

    await makeRateLimitedRequest(
      () => httpPost(url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
        dispatcher: mdblistDispatcher
      }),
      apiKey,
      `MDBList ${scrobblePath(action)} (${formatIdSummary(idInput)} S${season}E${episode})`
    );

    logger.info(`[MDBList ${action}] Episode reported`, { ids: idInput, season, episode });
    return true;
  } catch (error: any) {
    if (error.response?.status === 409) {
      logger.info(`[MDBList ${action}] Session already managed by another API (409 Conflict)`);
      return true;
    }
    logger.error(`[MDBList ${action}] Episode report failed: ${error.message}${responseDetail(error)}`);
    return false;
  }
}


/**
 * Fetch dynamic MDBList catalog (discover) items from /catalog/movie or /catalog/show endpoints.
 * Uses cursor-based pagination: cursors are stored in Redis per unique filter combination.
 */
async function fetchMDBListCatalog(
  mediaType: 'movie' | 'show',
  apiKey: string,
  page: number,
  params: Record<string, string | number | boolean>,
  cacheTTL?: number
): Promise<{ items: any[]; hasMore: boolean }> {
  const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20;

  const paramEntries = Object.entries(params).filter(([k]) => k !== 'cursor' && k !== 'limit').sort(([a], [b]) => a.localeCompare(b));
  const paramsHash = crypto.createHash('sha256').update(JSON.stringify(paramEntries)).digest('hex').substring(0, 16);

  // MDBList caches catalog results server-side for 6 hours 
  const maxTtl = 6 * 60 * 60;
  const baseTtl = cacheTTL !== undefined ? cacheTTL : parseInt(process.env.CATALOG_TTL || String(maxTtl), 10);
  const ttl = Math.min(baseTtl, maxTtl);

  const ttlSegment = cacheTTL !== undefined ? `:ttl:${ttl}` : '';
  const responseCacheKey = `mdblist-api:catalog:${paramsHash}:${mediaType}:page:${page}${ttlSegment}`;

  return await cacheWrapGlobal(responseCacheKey, async () => {
    try {
      // For page > 1, look up cursor from previous page
      let cursor: string | undefined;
      if (page > 1) {
        const cursorCacheKey = `mdblist-catalog:cursor:${paramsHash}:${mediaType}:page:${page - 1}`;
        try {
          cursor = await cacheWrapGlobal(cursorCacheKey, async () => {
            return null;
          }, ttl, { upstream: true });
        } catch {
          cursor = undefined;
        }

        if (!cursor) {
          logger.warn(`[MDBList Catalog] No cursor found for page ${page} (paramsHash: ${paramsHash}). Returning empty.`);
          return { items: [], hasMore: false };
        }
      }

      const url = new URL(`https://api.mdblist.com/catalog/${mediaType}`);
      url.searchParams.set('apikey', apiKey);
      url.searchParams.set('limit', String(Math.min(pageSize, 100)));
      if (cursor) url.searchParams.set('cursor', cursor);

      // Add all filter params
      for (const [key, value] of Object.entries(params)) {
        if (key !== 'cursor' && key !== 'limit' && value !== '' && value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }

      logger.debug(`[MDBList Catalog] Request URL: ${sanitizeUrlForLogging(url.toString())}`);

      const response: any = await makeRateLimitedRequest(
        () => httpGet(url.toString(), { dispatcher: mdblistDispatcher }),
        apiKey,
        `MDBList catalog (${mediaType}, page: ${page})`
      );

      // Handle 202 (cache building)
      if (response.status === 202) {
        logger.info(`[MDBList Catalog] 202 response - cache building for ${mediaType} catalog`);
        return { items: [], hasMore: true };
      }

      const data = response.data;
      const items = mediaType === 'movie' ? (data?.movies || []) : (data?.shows || []);
      const hasMore = data?.pagination?.has_more ?? false;
      const nextCursor = data?.pagination?.next_cursor;

      // Store cursor for next page
      if (nextCursor && hasMore) {
        const cursorStoreKey = `mdblist-catalog:cursor:${paramsHash}:${mediaType}:page:${page}`;
        await cacheWrapGlobal(cursorStoreKey, async () => nextCursor, ttl, { upstream: true });
      }

      logger.info(`[MDBList Catalog] Fetched ${items.length} ${mediaType} items (page ${page}, hasMore: ${hasMore})`);
      return { items, hasMore };
    } catch (err: any) {
      logger.error(`[MDBList Catalog] Error fetching ${mediaType} catalog page ${page}: ${err.message}`);
      return { items: [], hasMore: false };
    }
  }, ttl, { upstream: true, sourceList: true });
}

/**
 * MDBList's activity digest for one key, shared by everything that asks whether the
 * key's library moved: the watch mirror, the paused-titles gate and the hide-watched
 * filter. A watch recorded here clears it.
 */
async function fetchMdblistLastActivities(apiKey: string): Promise<any> {
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex').substring(0, 16);
  return cacheWrapGlobal(
    `mdblist_last_activities:${keyHash}`,
    async () => {
      const response = await makeRateLimitedMDBListRequest(`https://api.mdblist.com/sync/last_activities?apikey=${apiKey}`, apiKey, 'MDBList activities');
      return response?.data ?? {};
    },
    envInt('MDBLIST_ACTIVITIES_TTL', 300, 30),
    { upstream: true }
  );
}

export {
  fetchMdblistLastActivities,
  fetchMDBListItems,
  fetchMDBListExternalItems,
  usesMdblistExternalItemsEndpoint,
  supportsMdblistScoreFilters,
  fetchMDBListBatchMediaInfo,
  getGenresFromMDBList,
  parseMDBListItems,
  getMediaRatingFromMDBList,
  getRatingsFromMDBList,
  fetchMDBListGenres,
  convertGenreToSlug,
  makeRateLimitedMDBListRequest,
  makeRateLimitedMDBListPost,
  testMdblistKey,
  fetchMDBListUpNext,
  mdblistEpisodeRef,
  mdblistWatchedRef,
  parseMDBListUpNextItems,
  fetchMDBListUpcoming,
  fetchMdbListSearchItems,
  checkinMovie,
  checkinEpisode,
  addToHistory,
  removeFromHistory,
  clearScrobbleSession,
  clearScrobbleSession as clearPlayback,
  fetchMDBListCatalog
};

