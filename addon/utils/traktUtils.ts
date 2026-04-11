import { httpGet, httpPost } from "./httpClient.js";
import { getMeta } from "../lib/getMeta.js";
import { cacheWrapMetaSmart, cacheWrapGlobal } from "../lib/getCache.js";
import { UserConfig } from "../types/index.js";
const consola = require('consola');
const crypto = require('crypto');
import {Agent, ProxyAgent } from 'undici';
const database = require('../lib/database.js');
const redis = require('../lib/redisClient');

const logger = consola.withTag('Trakt');
const TRAKT_UNAUTHED_QUEUE_KEY = 'unauthed';
const DEFAULT_TRAKT_GET_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_TRAKT_GET_WINDOW_LIMIT = 1000;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const TRAKT_GET_WINDOW_MS = parsePositiveInt(process.env.TRAKT_GET_WINDOW_MS, DEFAULT_TRAKT_GET_WINDOW_MS);
const TRAKT_GET_WINDOW_LIMIT = parsePositiveInt(process.env.TRAKT_GET_WINDOW_LIMIT, DEFAULT_TRAKT_GET_WINDOW_LIMIT);

/**
 * Sanitize URL by removing access token for safe logging
 */
function sanitizeUrlForLogging(url: string): string {
  return url.replace(/(Authorization: Bearer\s+)[^\s]+/gi, '$1[REDACTED]');
}

const TRAKT_PROXY_URL = process.env.TRAKT_PROXY_URL;
const traktDispatcher = TRAKT_PROXY_URL 
  ? new ProxyAgent({ uri: TRAKT_PROXY_URL, requestTls: { timeout: 30000 } })
  : new Agent({ connect: { timeout: 30000 } });


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

const QUEUE_CONFIG = {
  concurrency: parsePositiveInt(process.env.TRAKT_CONCURRENCY, 15),
  minTime: parsePositiveInt(process.env.TRAKT_MIN_TIME, 50), 
  maxRequestsPerWindow: TRAKT_GET_WINDOW_LIMIT, 
  rateLimitWindowMs: TRAKT_GET_WINDOW_MS,
  rateLimitBuffer: parsePositiveInt(process.env.TRAKT_RATE_LIMIT_BUFFER_MS, 1000),
  queueCleanupInterval: 1000 * 60 * 10
};

// --- Global Rate Limit Tracker ---
// Tracks ALL Trakt API requests across all per-user queues against the shared client ID limit.

const TRAKT_RATE_LIMIT_SAFETY_RATIO = (() => {
  const val = parseFloat(process.env.TRAKT_RATE_LIMIT_SAFETY_RATIO || '0.85');
  return Number.isFinite(val) && val > 0 && val <= 1 ? val : 0.85;
})();

class GlobalRateLimitTracker {
  private requestTimestamps: number[] = [];
  private globalPausedUntil = 0;
  private lastLogTime = 0;
  private readonly windowMs = TRAKT_GET_WINDOW_MS;
  private readonly maxRequests = Math.floor(TRAKT_GET_WINDOW_LIMIT * TRAKT_RATE_LIMIT_SAFETY_RATIO);

  private prune(now: number) {
    const cutoff = now - this.windowMs;
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] <= cutoff) {
      this.requestTimestamps.shift();
    }
  }

  recordRequest(now: number) {
    this.requestTimestamps.push(now);
    this.prune(now);
    this.maybeLog(now);
  }

  getWaitMs(now: number): number {
    // If globally paused (e.g. from a 429), wait for that first
    if (now < this.globalPausedUntil) {
      return this.globalPausedUntil - now;
    }

    this.prune(now);
    if (this.requestTimestamps.length < this.maxRequests) {
      return 0;
    }

    // Budget exhausted — wait until the oldest request exits the window
    const oldest = this.requestTimestamps[0];
    return Math.max(0, (oldest + this.windowMs - now) + QUEUE_CONFIG.rateLimitBuffer);
  }

  pauseGlobal(durationMs: number) {
    const resumeAt = Date.now() + durationMs;
    if (resumeAt > this.globalPausedUntil) {
      this.globalPausedUntil = resumeAt;
      logger.warn(`[GlobalRateLimit] All queues paused for ${Math.round(durationMs / 1000)}s due to 429`);
    }
  }

  private maybeLog(now: number) {
    if (now - this.lastLogTime < 60_000) return;
    const usage = this.requestTimestamps.length;
    const ratio = usage / this.maxRequests;
    if (ratio > 0.5) {
      logger.info(`[GlobalRateLimit] ${usage}/${this.maxRequests} requests in window (${Math.round(ratio * 100)}%)`);
      this.lastLogTime = now;
    }
  }
}

const globalRateLimiter = new GlobalRateLimitTracker();

// --- Multi-Queue Implementation ---

class RequestQueue {
  private queue: Array<() => Promise<void>> = [];
  private activeCount = 0;
  private lastRequestTime = 0;
  private requestStarts: number[] = [];
  private pausedUntil = 0;
  private processing = false;
  public lastActivity = Date.now(); 

  async add<T>(fn: () => Promise<T>): Promise<T> {
    this.lastActivity = Date.now();
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
      this.process();
    });
  }

  pause(durationMs: number) {
    const now = Date.now();
    const newResumeTime = now + durationMs;
    if (newResumeTime > this.pausedUntil) {
      this.pausedUntil = newResumeTime;
    }
  }

  private pruneRequestStarts(now: number) {
    const cutoff = now - QUEUE_CONFIG.rateLimitWindowMs;
    while (this.requestStarts.length > 0 && this.requestStarts[0] <= cutoff) {
      this.requestStarts.shift();
    }
  }

  private getWindowWaitMs(now: number): number {
    this.pruneRequestStarts(now);

    if (this.requestStarts.length < QUEUE_CONFIG.maxRequestsPerWindow) {
      return 0;
    }

    const oldestRequest = this.requestStarts[0];
    return Math.max(0, (oldestRequest + QUEUE_CONFIG.rateLimitWindowMs - now) + QUEUE_CONFIG.rateLimitBuffer);
  }

  private async process() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      
      if (now < this.pausedUntil) {
        const wait = this.pausedUntil - now;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (this.activeCount >= QUEUE_CONFIG.concurrency) {
        await new Promise(r => setTimeout(r, 50));
        continue;
      }

      const timeSinceLast = now - this.lastRequestTime;
      if (timeSinceLast < QUEUE_CONFIG.minTime) {
        await new Promise(r => setTimeout(r, QUEUE_CONFIG.minTime - timeSinceLast));
      }

      const windowWaitMs = this.getWindowWaitMs(Date.now());
      if (windowWaitMs > 0) {
        await new Promise(r => setTimeout(r, windowWaitMs));
        continue;
      }

      // Check global rate limit budget across all queues
      const globalWaitMs = globalRateLimiter.getWaitMs(Date.now());
      if (globalWaitMs > 0) {
        await new Promise(r => setTimeout(r, globalWaitMs));
        continue;
      }

      const task = this.queue.shift();
      if (task) {
        this.activeCount++;
        const requestStart = Date.now();
        this.lastRequestTime = requestStart;
        this.requestStarts.push(requestStart);
        this.pruneRequestStarts(requestStart);
        globalRateLimiter.recordRequest(requestStart);
        this.lastActivity = Date.now();
        
        task().finally(() => {
          this.activeCount--;
          this.process();
        });
      }
    }

    this.processing = false;
  }
}

class QueueManager {
  private queues = new Map<string, RequestQueue>();

  constructor() {
    setInterval(() => this.cleanup(), QUEUE_CONFIG.queueCleanupInterval);
  }

  getQueue(key: string): RequestQueue {
    if (!this.queues.has(key)) {
      this.queues.set(key, new RequestQueue());
    }
    return this.queues.get(key)!;
  }

  private cleanup() {
    const now = Date.now();
    for (const [key, queue] of this.queues.entries()) {
      if (now - queue.lastActivity > QUEUE_CONFIG.queueCleanupInterval) {
        this.queues.delete(key);
      }
    }
  }

  getQueueCount(): number {
    return this.queues.size;
  }
}


const queueManager = new QueueManager();
const AUTHED_API_WRITE_INTERVAL_MS = parseInt(process.env.TRAKT_AUTHED_API_WRITE_INTERVAL_MS || '1000', 10);
const writeChains = new Map<string, Promise<void>>();
const lastWriteAtByToken = new Map<string, number>();

async function runSerializedWrite<T>(tokenKey: string, task: () => Promise<T>): Promise<T> {
  const key = tokenKey || 'global';
  const previous = writeChains.get(key) || Promise.resolve();

  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  writeChains.set(key, previous.catch(() => undefined).then(() => gate));
  await previous.catch(() => undefined);

  try {
    return await task();
  } finally {
    releaseGate();
    if (writeChains.get(key) === gate) {
      writeChains.delete(key);
    }
  }
}


function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimitError(error: any): boolean {
  return error.response?.status === 429 || error.response?.status === 503;
}

function getRetryAfterMs(error: any): number {
  const headers = error.response?.headers;
  if (!headers) return 1000;

  const retryAfter = headers['retry-after'] || headers['Retry-After'];
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) return (seconds * 1000) + QUEUE_CONFIG.rateLimitBuffer;
  }

  const rateLimitInfo = headers['x-ratelimit'] || headers['X-Ratelimit'];
  if (rateLimitInfo) {
    try {
      const info = typeof rateLimitInfo === 'string' ? JSON.parse(rateLimitInfo) : rateLimitInfo;
      if (info && info.until) {
        const untilDate = new Date(info.until);
        const now = new Date();
        const diff = untilDate.getTime() - now.getTime();
        if (diff > 0) return diff + QUEUE_CONFIG.rateLimitBuffer;
      }
    } catch (e) {}
  }

  return 2000; 
}

function getEpisodeIdPart(ep: any): string {
  const traktId = (ep as any).trakt_id ?? (ep as any).ids?.trakt;
  if (traktId) return `trakt${traktId}`;
  const season = ep?.season;
  const episode = (ep as any).episode ?? (ep as any).number;
  if (season != null && episode != null) return `S${season}E${String(episode).padStart(2, '0')}`;
  return 'unknown';
}

/**
 * Execute a request with rate limiting and retries.
 * 
 * @param requestFn The request function
 * @param context Log context
 * @param retries Number of retries
 * @param queueKey Unique key for the queue. Use accessToken for user requests, or 'global' for generic.
 */
async function makeRateLimitedRequest<T>(
  requestFn: () => Promise<T>,
  context: string = 'Trakt',
  retries: number = 3,
  queueKey: string = 'global'
): Promise<T> {
  const queue = queueManager.getQueue(queueKey);
  let attempt = 0;

  while (attempt <= retries) {
    attempt++;
    
    try {
      const response = await queue.add(() => requestFn());
      return response;
    } catch (error: any) {
      if (isPermanentError(error)) {
        logger.error(`[Trakt] Permanent error: ${error.message} - ${context}`);
        throw error;
      }

      const isLastAttempt = attempt > retries;

      if (isRateLimitError(error)) {
        const waitMs = getRetryAfterMs(error);
        const keyShort = queueKey === TRAKT_UNAUTHED_QUEUE_KEY
          ? 'UNAUTHED'
          : queueKey === 'global'
            ? 'GLOBAL'
            : `User:${queueKey.substring(0,5)}...`;
        
        logger.warn(`[Trakt] Rate Limit (${keyShort}). Pausing queue for ${Math.round(waitMs/1000)}s - ${context}`);

        // Pause this queue and notify global tracker (client-ID-level limit)
        queue.pause(waitMs);
        globalRateLimiter.pauseGlobal(waitMs);
        
        if (isLastAttempt) throw error;
        
        await sleep(waitMs);
        continue;
      }

      if (isLastAttempt) {
        // Log error but don't spam console for expected 404s in lookup flows
        if (error.response?.status !== 404) {
           logger.warn(`[Trakt] Request failed after ${retries} attempts: ${error.message} - ${context}`);
        }
        throw error;
      }

      const delay = 1000 * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }
  throw new Error('Unreachable code');
}

// Fetch episodes watched by the user since a specific date
async function fetchTraktHistory(
  accessToken: string,
  startAt: string
): Promise<Array<{id: number, watched_at: string}>> {
  try {
    const url = `${TRAKT_BASE_URL}/sync/history/episodes?start_at=${startAt}&limit=100`;
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, {
        dispatcher: traktDispatcher,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'trakt-api-version': '2',
          'trakt-api-key': TRAKT_CLIENT_ID
        }
      }),
      'Trakt History Sync', 3, accessToken
    );
    
    const updates: Array<{id: number, watched_at: string}> = [];
    if (Array.isArray(response.data)) {
      response.data.forEach((item: any) => {
        if (item.show?.ids?.trakt) {
          updates.push({ id: item.show.ids.trakt, watched_at: item.watched_at });
        }
      });
    }
    return updates;
  } catch (error) {
    return [];
  }
}

async function fetchTraktUpdatedShows(
  accessToken: string, 
  startAt: string,
  page: number = 1,
  limit: number = 100
): Promise<number[]> {
  try {
    const url = `${TRAKT_BASE_URL}/shows/updates/${startAt}?page=${page}&limit=${limit}`;
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, {
        dispatcher: traktDispatcher,
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': TRAKT_CLIENT_ID
        }
      }),
      'Trakt Shows Updates',
      3,
      TRAKT_UNAUTHED_QUEUE_KEY
    );

    const showIds = new Set<number>();
    if (Array.isArray(response.data)) {
      response.data.forEach((item: any) => {
        if (item.show?.ids?.trakt) showIds.add(item.show.ids.trakt);
      });
    }
    return Array.from(showIds);
  } catch (error) {
    logger.warn(`[Trakt] Failed to fetch show updates: ${error.message}`);
    return [];
  }
}

const TRAKT_SEARCH_DISABLED = process.env.DISABLE_TRAKT_SEARCH === 'true';


interface TraktUpNextState {
  last_watched_at: string; 
  last_updated_at: string;
  last_hidden_at: string;
  shows: Record<number, any>;
}

async function fetchTraktUpNextEpisodes(
  accessToken: string,
  cachedTimestamp?: string 
): Promise<{ items: any[], watched_at: string }> {
  const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex').substring(0, 16);
  const stateKey = `trakt_upnext_state:${tokenHash}`;
  const startTime = Date.now();

  const lastActivity = await fetchTraktLastActivity(accessToken);
  const userWatchedAt = lastActivity?.episodes?.watched_at;
  const globalUpdatedAt = lastActivity?.shows?.updated_at; 
  const userHiddenAt = lastActivity?.shows?.hidden_at;

  let state: TraktUpNextState = { last_watched_at: '', last_updated_at: '', last_hidden_at: '', shows: {} };
  if (redis) {
    const cachedState = await redis.get(stateKey);
    if (cachedState) {
      try { state = JSON.parse(cachedState); } catch(e) {}
    }
  }

  const showsToRefresh = new Set<number>();
  const historyTimestampMap = new Map<number, string>();
  let needsFullSync = Object.keys(state.shows).length === 0; 

  if (!needsFullSync && userWatchedAt !== state.last_watched_at) {
    if (state.last_watched_at) {
      const historyUpdates = await fetchTraktHistory(accessToken, state.last_watched_at);
      historyUpdates.forEach(update => {
        showsToRefresh.add(update.id);
        historyTimestampMap.set(update.id, update.watched_at);
        if (state.shows[update.id]) {
           state.shows[update.id].last_watched_at = update.watched_at;
        }
      });
    } else {
      needsFullSync = true;
    }
}

  if (!needsFullSync && globalUpdatedAt !== state.last_updated_at) {
    logger.debug(`[Up Next] Global shows updated since ${state.last_updated_at}`);
    if (state.last_updated_at) {
      const updatedIds = await fetchTraktUpdatedShows(accessToken, state.last_updated_at);
      let relevantUpdates = 0;
      updatedIds.forEach(id => {
        if (state.shows[id]) {
          showsToRefresh.add(id);
          relevantUpdates++;
        }
      });
      logger.debug(`[Up Next] Found ${relevantUpdates} relevant show updates (out of ${updatedIds.length} global)`);
    } 
  }

  if (!needsFullSync && userHiddenAt !== state.last_hidden_at) {
    logger.debug(`[Up Next] Hidden/dropped shows changed since ${state.last_hidden_at}`);
    const droppedShowIds = await fetchTraktDroppedShows(accessToken);
    let removedCount = 0;
    for (const id of Object.keys(state.shows).map(Number)) {
      if (droppedShowIds.has(id)) {
        delete state.shows[id];
        removedCount++;
      }
    }
    if (removedCount > 0) {
      logger.info(`[Up Next] Removed ${removedCount} dropped shows from state`);
    }
  }

  if (needsFullSync) {
    const [watchedShows, droppedShowIds] = await Promise.all([
      fetchTraktWatchedShows(accessToken),
      fetchTraktDroppedShows(accessToken)
    ]);

    const activeShows = watchedShows.filter(s => s.show?.ids?.trakt && !droppedShowIds.has(s.show.ids.trakt));
    activeShows.sort((a, b) => {
      const aTime = a.last_watched_at ? new Date(a.last_watched_at).getTime() : 0;
      const bTime = b.last_watched_at ? new Date(b.last_watched_at).getTime() : 0;
      return bTime - aTime;
    });
    const MAX_FULL_SYNC_REFRESH = 60;
    state.shows = {};
    activeShows.forEach((s, i) => {
      const id = s.show.ids.trakt;
      if (i < MAX_FULL_SYNC_REFRESH) showsToRefresh.add(id);
      state.shows[id] = {
        type: 'show', show: s.show, upNextEpisode: null,
        last_watched_at: s.last_watched_at
      };
    });
  } else if (showsToRefresh.size === 0) {
    logger.debug(`[Up Next] No changes detected. Serving from cache.`);
    
    const items = Object.values(state.shows)
      .filter(item => item.upNextEpisode !== null) 
      .sort((a, b) => {
        const timeA = a.last_watched_at ? new Date(a.last_watched_at).getTime() : 0;
        const timeB = b.last_watched_at ? new Date(b.last_watched_at).getTime() : 0;
        return timeB - timeA; 
      })
      .slice(0, 50);

    return { items, watched_at: userWatchedAt };
  }

  // Process Refreshes (The Queue handles concurrency)
  // If we have > 50 updates, maybe we should just limit to top 50 recently watched?
  // For now, process all dirty items to keep state consistent.
  const refreshArray = Array.from(showsToRefresh);
  logger.info(`[Up Next] Refreshing progress for ${refreshArray.length} shows`);
  const showsNeedingData = refreshArray.filter(id => !state.shows[id]?.show);

  const showDataMap = new Map();
  await Promise.all(showsNeedingData.map(async (showId) => {
    try {
      const data = await cacheWrapGlobal(
        `trakt:show:${showId}:full`,
        async () => {
          const resp = await makeRateLimitedRequest(
            () => httpGet(`${TRAKT_BASE_URL}/shows/${showId}`, {
              dispatcher: traktDispatcher,
              headers: { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': TRAKT_CLIENT_ID },
              params: { extended: 'full' }
            }),
            `Trakt Show Info ${showId}`, 3, TRAKT_UNAUTHED_QUEUE_KEY
          );
          return resp.data;
        },
        86400, // 1 day TTL
        { skipVersion: true }
      );
      showDataMap.set(showId, data);
    } catch(e) {}
  }));

  await Promise.all(refreshArray.map(async (showId) => {
    try {
      // 1. Fetch Progress
      const response: any = await makeRateLimitedRequest(
        () => httpGet(`${TRAKT_BASE_URL}/shows/${showId}/progress/watched`, {
          dispatcher: traktDispatcher,
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': TRAKT_CLIENT_ID,
            'User-Agent': `AIOMetadata/${packageJson.version}`
          },
          params: { 'extended': 'full' }
        }),
        `Trakt Progress ${showId}`,
        3,
        accessToken
      );

      const progress = response.data;
      const nextEp = progress?.next_episode;

      if (nextEp && nextEp.first_aired && new Date(nextEp.first_aired) <= new Date()) {
        const showData = state.shows[showId]?.show || showDataMap.get(showId);
        const existingDate = state.shows[showId]?.last_watched_at || historyTimestampMap.get(showId);
      
        if (showData) {
          state.shows[showId] = {
            type: 'show',
            show: showData,
            last_watched_at: existingDate,
            upNextEpisode: {
              season: nextEp.season,
              episode: nextEp.number,
              trakt_id: nextEp.ids.trakt,
              imdb_id: nextEp.ids.imdb,
              tvdb_id: nextEp.ids.tvdb,
              title: nextEp.title,
              overview: nextEp.overview,
              first_aired: nextEp.first_aired
            }
          };
        } else {
          logger.warn(`[Up Next] No show data available for ${showId}, skipping`);
        }
      } else {
        if (state.shows[showId]) {
          state.shows[showId].upNextEpisode = null;
        }
      }
    } catch (error) {
      logger.warn(`[Up Next] Failed to refresh show ${showId}`);
    }
  }));

  // Progressive backfill: resolve a batch of shows that still have no
  // upNextEpisode (e.g. shows beyond the initial top-60 on first sync).
  // This runs on every sync so all shows eventually get their progress
  // without slamming the API.
  const BACKFILL_BATCH = 15;
  const unresolvedIds = Object.entries(state.shows)
    .filter(([, v]) => v.upNextEpisode === null && !showsToRefresh.has(Number(v.show?.ids?.trakt)))
    .sort((a, b) => {
      const tA = a[1].last_watched_at ? new Date(a[1].last_watched_at).getTime() : 0;
      const tB = b[1].last_watched_at ? new Date(b[1].last_watched_at).getTime() : 0;
      return tB - tA;
    })
    .slice(0, BACKFILL_BATCH)
    .map(([id]) => Number(id));

  if (unresolvedIds.length > 0) {
    logger.info(`[Up Next] Backfilling progress for ${unresolvedIds.length} unresolved shows`);
    await Promise.all(unresolvedIds.map(async (showId) => {
      try {
        const response: any = await makeRateLimitedRequest(
          () => httpGet(`${TRAKT_BASE_URL}/shows/${showId}/progress/watched`, {
            dispatcher: traktDispatcher,
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              'trakt-api-version': '2',
              'trakt-api-key': TRAKT_CLIENT_ID,
              'User-Agent': `AIOMetadata/${packageJson.version}`
            },
            params: { 'extended': 'full' }
          }),
          `Trakt Progress ${showId}`,
          3,
          accessToken
        );

        const progress = response.data;
        const nextEp = progress?.next_episode;

        if (nextEp && nextEp.first_aired && new Date(nextEp.first_aired) <= new Date()) {
          const showData = state.shows[showId]?.show;
          if (showData) {
            state.shows[showId].upNextEpisode = {
              season: nextEp.season,
              episode: nextEp.number,
              trakt_id: nextEp.ids.trakt,
              imdb_id: nextEp.ids.imdb,
              tvdb_id: nextEp.ids.tvdb,
              title: nextEp.title,
              overview: nextEp.overview,
              first_aired: nextEp.first_aired
            };
          }
        }
      } catch (error) {
        logger.warn(`[Up Next] Backfill failed for show ${showId}`);
      }
    }));
  }

  state.last_watched_at = userWatchedAt;
  state.last_updated_at = globalUpdatedAt;
  state.last_hidden_at = userHiddenAt;
  
  if (redis) {
    await redis.set(stateKey, JSON.stringify(state), 'EX', 86400 * 7);
  }


  const finalItems = Object.values(state.shows)
    .filter(item => item.upNextEpisode !== null)
    .sort((a, b) => {
      const timeA = a.last_watched_at ? new Date(a.last_watched_at).getTime() : 0;
      const timeB = b.last_watched_at ? new Date(b.last_watched_at).getTime() : 0;

      if (timeB !== timeA) {
        return timeB - timeA;
      }

      const titleA = (a.show?.title || '').toLowerCase();
      const titleB = (b.show?.title || '').toLowerCase();
      return titleA.localeCompare(titleB);
    })
    .slice(0, 50);

  const duration = Date.now() - startTime;
  logger.info(`[Up Next] Sync complete in ${duration}ms. Returning ${finalItems.length} items.`);

  return { items: finalItems, watched_at: userWatchedAt };
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
    'Trakt fetchLastActivity',
    3,
    accessToken
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
    'Trakt fetchWatchedShows',
    3,
    accessToken
  );
  return Array.isArray(response.data) ? response.data : [];
}

/**
 * Fetch watched shows with season/episode data (OAuth required)
 * @param accessToken - User's Trakt access token
 * @returns array of watched shows with season data
 */
async function fetchTraktWatchedShowsFull(accessToken: string): Promise<any[]> {
  const url = `${TRAKT_BASE_URL}/sync/watched/shows?extended=full`;
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
    'Trakt fetchWatchedShowsFull',
    3,
    accessToken
  );
  return Array.isArray(response.data) ? response.data : [];
}

/**
 * Fetch watched movies for a user (OAuth required)
 * @param accessToken - User's Trakt access token
 * @returns array of watched movies
 */
async function fetchTraktWatchedMovies(accessToken: string): Promise<any[]> {
  const url = `${TRAKT_BASE_URL}/sync/watched/movies`;
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
    'Trakt fetchWatchedMovies',
    3,
    accessToken
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
        'Trakt fetchDroppedShows',
        3,
        accessToken
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
    `Trakt fetchShowWatchedProgress (${showId})`,
    3,
    accessToken
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
  const currentHiddenAt = lastActivity?.shows?.hidden_at;
  const activityFingerprint = `${currentWatchedAt}|${currentHiddenAt}`;

  if (cachedTimestamp && cachedTimestamp === activityFingerprint) {
    logger.info(`Unwatched: No changes detected, using cached data`);
    return { items: [], watched_at: activityFingerprint };
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
            1,
            accessToken
          );
          const progress = response.data;
          if (!progress?.seasons || !Array.isArray(progress.seasons)) return null;

          // Only include shows that are not 100% complete and have unwatched aired episodes
          if (progress.completed >= progress.aired) return null;

          logger.debug(`Unwatched: access token ${accessToken}`);
          // Fetch seasons with episode air dates to sort accurately (globally cached - public data)
          const seasonsData: any[] = await cacheWrapGlobal(
            `trakt:show:${showId}:seasons:full_episodes`,
            async () => {
              const showSeasonsResp: any = await makeRateLimitedRequest(
                () => httpGet(`${TRAKT_BASE_URL}/shows/${showId}/seasons?extended=full,episodes`, {
                  dispatcher: traktDispatcher,
                  headers: {
                    'Content-Type': 'application/json',
                    'trakt-api-version': '2',
                    'trakt-api-key': TRAKT_CLIENT_ID
                  }
                }),
                `Trakt fetchShowSeasons (unwatched ${showId})`,
                1,
                TRAKT_UNAUTHED_QUEUE_KEY
              );
              return Array.isArray(showSeasonsResp.data) ? showSeasonsResp.data : [];
            },
            43200, // 12 hour TTL
            { skipVersion: true }
          );
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

const packageJson = require('../../package.json');
const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID || '';
const TRAKT_REDIRECT_URI = (() => {
  const uri = process.env.TRAKT_REDIRECT_URI || `${process.env.HOST_NAME}/api/auth/trakt/callback`;
  if (!uri) return uri;
  const trimmed = uri.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  return `https://${trimmed.replace(/^\/+/, '')}`;
})();
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
  genre?: string,
  cacheTTL?: number
): Promise<{items: TraktListItem[], totalItems?: number, hasMore: boolean, totalPages?: number}> {
  const typeParam = type || 'all';
  const sortParam = sort || '';
  const sortHow = sortDirection || 'asc';

  const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex').substring(0, 16);
  const cacheKey = `trakt-api:watchlist:${tokenHash}:${typeParam}:${page}:${limit}:${sortParam}:${sortHow}:${genre || ''}`;

  const ttl = cacheTTL !== undefined ? cacheTTL : parseInt(process.env.CATALOG_TTL || String(1 * 24 * 60 * 60), 10);

  return await cacheWrapGlobal(cacheKey, async () => {
    try {
      let url = sortParam
        ? `${TRAKT_BASE_URL}/sync/watchlist/${typeParam}/${sortParam}/${sortHow}?page=${page}&limit=${limit}`
        : `${TRAKT_BASE_URL}/sync/watchlist/${typeParam}?page=${page}&limit=${limit}`;
      if (genre && genre.toLowerCase() !== 'all' && genre.toLowerCase() !== 'none') {
        url += `&genres=${encodeURIComponent(genre)}`;
      }

      logger.debug(`Trakt watchlist request: type=${typeParam}, page=${page}, limit=${limit}, sort=${sortParam || 'default'}, sortDirection=${sortHow}, genre=${genre || 'none'}`);
      
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
        `Trakt fetchWatchlistItems (type: ${typeParam}, page: ${page})`,
        3,
        accessToken
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
      throw err;
    }
  }, ttl, { skipVersion: true });
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
  genre?: string,
  cacheTTL?: number
): Promise<{items: TraktListItem[], totalItems?: number, hasMore: boolean, totalPages?: number}> {
  const sortParam = sort || '';
  const sortHow = sortDirection || 'asc';

  const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex').substring(0, 16);
  const cacheKey = `trakt-api:favorites:${tokenHash}:${type}:${page}:${limit}:${sortParam}:${sortHow}:${genre || ''}`;

  const ttl = cacheTTL !== undefined ? cacheTTL : parseInt(process.env.CATALOG_TTL || String(1 * 24 * 60 * 60), 10);

  return await cacheWrapGlobal(cacheKey, async () => {
    try {
      let url = sortParam
        ? `${TRAKT_BASE_URL}/sync/favorites/${type}/${sortParam}/${sortHow}?page=${page}&limit=${limit}`
        : `${TRAKT_BASE_URL}/sync/favorites/${type}?page=${page}&limit=${limit}`;
      if (genre && genre.toLowerCase() !== 'all' && genre.toLowerCase() !== 'none') {
        url += `&genres=${encodeURIComponent(genre)}`;
      }

      logger.debug(`Trakt favorites request: type=${type}, page=${page}, limit=${limit}, sort=${sortParam || 'default'}, sortDirection=${sortHow}, genre=${genre || 'none'}`);
      
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
        `Trakt fetchFavoritesItems (type: ${type}, page: ${page})`,
        3,
        accessToken
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
      throw err;
    }
  }, ttl, { skipVersion: true });
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
  limit: number = 50,
  cacheTTL?: number
): Promise<{items: TraktListItem[], totalItems?: number, hasMore: boolean, totalPages?: number}> {
  const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex').substring(0, 16);
  const cacheKey = `trakt-api:recommendations:${tokenHash}:${type}:${page}:${limit}`;
  
  const ttl = cacheTTL !== undefined ? cacheTTL : parseInt(process.env.CATALOG_TTL || String(1 * 24 * 60 * 60), 10);
  
  return await cacheWrapGlobal(cacheKey, async () => {
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
        `Trakt fetchRecommendationsItems (type: ${type}, page: ${page})`,
        3,
        accessToken
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
      throw err;
    }
  }, ttl, { skipVersion: true });
}

/**
 * Fetch items from a Trakt custom list
 * @param username - List owner's username
 * @param listSlug - List identifier slug
 * @param accessToken - User's Trakt access token
 * @param type - Content type filter ('movies', 'shows', or undefined for all)
 * @param page - Page number (1-indexed)
 * @param limit - Items per page
 * @param sort - Sort order,
 * @param cacheTTL - Cache TTL
 * @param privacy - List privacy setting ('public', 'private', 'friends')
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
  sortDirection?: 'asc' | 'desc',
  cacheTTL?: number,
   privacy: string = 'public'
): Promise<{items: TraktListItem[], totalItems?: number, hasMore: boolean, totalPages?: number}> {
  const typeParam = type || 'all';
  const isPublic = privacy === 'public';
  const tokenHash = isPublic ? 'public' : (accessToken ? crypto.createHash('sha256').update(accessToken).digest('hex').substring(0, 16) : 'public');
  const cacheKey = `trakt-api:list:${tokenHash}:${username}:${listSlug}:${typeParam}:${page}:${limit}:${sort || ''}:${sortDirection || ''}:${genre || ''}`;
  const queueKey = accessToken ? accessToken : TRAKT_UNAUTHED_QUEUE_KEY;
  const ttl = cacheTTL !== undefined ? cacheTTL : parseInt(process.env.CATALOG_TTL || String(1 * 24 * 60 * 60), 10);
  
  return await cacheWrapGlobal(cacheKey, async () => {
    try {
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
        `Trakt fetchListItems (${username}/${listSlug}, page: ${page}, genre: ${genre || 'none'})`,
        3,
        queueKey
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
      throw err;
    }
  }, ttl, { skipVersion: true });
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
 * @param sortDirection - 'asc' or 'desc',
 * @param cacheTTL - Cache TTL
 * @param privacy - List privacy setting ('public', 'private', 'friends')
 */
async function fetchTraktListItemsById(
  listId: string | number,
  accessToken: string,
  type: 'movies' | 'shows' | undefined,
  page: number,
  limit: number = 20,
  sort?: string,
  genre?: string,
  sortDirection?: 'asc' | 'desc',
  cacheTTL?: number,
  privacy: string = 'public'
): Promise<{items: TraktListItem[], totalItems?: number, hasMore: boolean, totalPages?: number}> {
  const typeParam = type || 'movie,show';
  const isPublic = privacy === 'public';
  const tokenHash = isPublic ? 'public' : (accessToken ? crypto.createHash('sha256').update(accessToken).digest('hex').substring(0, 16) : 'public');
  const cacheKey = `trakt-api:list-by-id:${tokenHash}:${listId}:${typeParam}:${page}:${limit}:${sort || ''}:${sortDirection || ''}:${genre || ''}`;
  const queueKey = accessToken ? accessToken : TRAKT_UNAUTHED_QUEUE_KEY;
  const ttl = cacheTTL !== undefined ? cacheTTL : parseInt(process.env.CATALOG_TTL || String(1 * 24 * 60 * 60), 10);
  
  return await cacheWrapGlobal(cacheKey, async () => {
    try {
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
        `Trakt fetchListItemsById (${listId}, page: ${page}, genre: ${genre || 'none'})`,
        3,
        queueKey
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
      throw err;
    }
  }, ttl, { skipVersion: true });
}


const TRAKT_GENRES_FETCH_TIMEOUT = 3000;

const TRAKT_FALLBACK_GENRES: Record<string, Array<{ name: string; slug: string }>> = {
  movies: [
    {
      "name": "Action",
      "slug": "action"
    },
    {
      "name": "Adventure",
      "slug": "adventure"
    },
    {
      "name": "Animation",
      "slug": "animation"
    },
    {
      "name": "Anime",
      "slug": "anime"
    },
    {
      "name": "Comedy",
      "slug": "comedy"
    },
    {
      "name": "Crime",
      "slug": "crime"
    },
    {
      "name": "Documentary",
      "slug": "documentary"
    },
    {
      "name": "Donghua",
      "slug": "donghua"
    },
    {
      "name": "Drama",
      "slug": "drama"
    },
    {
      "name": "Family",
      "slug": "family"
    },
    {
      "name": "Fantasy",
      "slug": "fantasy"
    },
    {
      "name": "History",
      "slug": "history"
    },
    {
      "name": "Holiday",
      "slug": "holiday"
    },
    {
      "name": "Horror",
      "slug": "horror"
    },
    {
      "name": "Music",
      "slug": "music"
    },
    {
      "name": "Musical",
      "slug": "musical"
    },
    {
      "name": "Mystery",
      "slug": "mystery"
    },
    {
      "name": "None",
      "slug": "none"
    },
    {
      "name": "Romance",
      "slug": "romance"
    },
    {
      "name": "Science Fiction",
      "slug": "science-fiction"
    },
    {
      "name": "Short",
      "slug": "short"
    },
    {
      "name": "Sporting Event",
      "slug": "sporting-event"
    },
    {
      "name": "Superhero",
      "slug": "superhero"
    },
    {
      "name": "Suspense",
      "slug": "suspense"
    },
    {
      "name": "Thriller",
      "slug": "thriller"
    },
    {
      "name": "War",
      "slug": "war"
    },
    {
      "name": "Western",
      "slug": "western"
    }
  ],
  shows: [
    {
      "name": "Action",
      "slug": "action"
    },
    {
      "name": "Adventure",
      "slug": "adventure"
    },
    {
      "name": "Animation",
      "slug": "animation"
    },
    {
      "name": "Anime",
      "slug": "anime"
    },
    {
      "name": "Biography",
      "slug": "biography"
    },
    {
      "name": "Children",
      "slug": "children"
    },
    {
      "name": "Comedy",
      "slug": "comedy"
    },
    {
      "name": "Crime",
      "slug": "crime"
    },
    {
      "name": "Documentary",
      "slug": "documentary"
    },
    {
      "name": "Donghua",
      "slug": "donghua"
    },
    {
      "name": "Drama",
      "slug": "drama"
    },
    {
      "name": "Family",
      "slug": "family"
    },
    {
      "name": "Fantasy",
      "slug": "fantasy"
    },
    {
      "name": "Game Show",
      "slug": "game-show"
    },
    {
      "name": "History",
      "slug": "history"
    },
    {
      "name": "Holiday",
      "slug": "holiday"
    },
    {
      "name": "Home And Garden",
      "slug": "home-and-garden"
    },
    {
      "name": "Horror",
      "slug": "horror"
    },
    {
      "name": "Mini Series",
      "slug": "mini-series"
    },
    {
      "name": "Music",
      "slug": "music"
    },
    {
      "name": "Musical",
      "slug": "musical"
    },
    {
      "name": "Mystery",
      "slug": "mystery"
    },
    {
      "name": "News",
      "slug": "news"
    },
    {
      "name": "None",
      "slug": "none"
    },
    {
      "name": "Reality",
      "slug": "reality"
    },
    {
      "name": "Romance",
      "slug": "romance"
    },
    {
      "name": "Science Fiction",
      "slug": "science-fiction"
    },
    {
      "name": "Short",
      "slug": "short"
    },
    {
      "name": "Soap",
      "slug": "soap"
    },
    {
      "name": "Special Interest",
      "slug": "special-interest"
    },
    {
      "name": "Sporting Event",
      "slug": "sporting-event"
    },
    {
      "name": "Superhero",
      "slug": "superhero"
    },
    {
      "name": "Suspense",
      "slug": "suspense"
    },
    {
      "name": "Talk Show",
      "slug": "talk-show"
    },
    {
      "name": "Thriller",
      "slug": "thriller"
    },
    {
      "name": "War",
      "slug": "war"
    },
    {
      "name": "Western",
      "slug": "western"
    }
  ],
};

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
      const combined = [...movies, ...shows];
      const uniqueMap = new Map();
      combined.forEach(item => {
        if (item && item.slug) {
          uniqueMap.set(item.slug, item);
        }
      });
      const unique = Array.from(uniqueMap.values());
      return unique.sort((a: any, b: any) => a.name.localeCompare(b.name));
    } catch (err) {
      const combined = [...TRAKT_FALLBACK_GENRES.movies, ...TRAKT_FALLBACK_GENRES.shows];
      const uniqueMap = new Map();
      combined.forEach(item => uniqueMap.set(item.slug, item));
      return Array.from(uniqueMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  try {
    const { cacheWrapTraktGenres } = require('../lib/getCache.js');
    return await cacheWrapTraktGenres(type, async () => {
      const url = `${TRAKT_BASE_URL}/genres/${type}`;
      logger.debug(`Fetching Trakt genres from API for type: ${type}`);

      // -----------------------------------------------------------------------
      // PATCH: Wrap the rate-limited request in a timeout so it doesn't block
      // manifest generation when the Trakt queue is paused from a 429.
      // -----------------------------------------------------------------------
      const fetchPromise = makeRateLimitedRequest(
        () => httpGet(url, {
          dispatcher: traktDispatcher,
          headers: {
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': TRAKT_CLIENT_ID
          }
        }),
        `Trakt fetchGenres (${type})`,
        3,
        TRAKT_UNAUTHED_QUEUE_KEY
      );

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Trakt genres fetch timed out after ${TRAKT_GENRES_FETCH_TIMEOUT}ms`)), TRAKT_GENRES_FETCH_TIMEOUT)
      );

      let response: any;
      try {
        response = await Promise.race([fetchPromise, timeoutPromise]);
      } catch (timeoutOrRateLimitError: any) {
        // On timeout or rate limit, return fallback genres instead of empty
        logger.warn(
          `[Trakt] Genres fetch failed for ${type}: ${timeoutOrRateLimitError.message}. ` +
          `Using ${TRAKT_FALLBACK_GENRES[type].length} hardcoded fallback genres.`
        );
        return TRAKT_FALLBACK_GENRES[type] || [];
      }

      if (!Array.isArray(response.data)) {
        logger.warn(`Trakt genres API returned non-array response for ${type}`);
        return TRAKT_FALLBACK_GENRES[type] || [];
      }

      const genres = response.data
        .map((g: any) => ({ name: g.name, slug: g.slug }))
        .filter((g: any) => g.name && g.slug);

      logger.info(`Successfully fetched and cached ${genres.length} ${type} genres from Trakt API`);
      return genres;
    });
  } catch (err: any) {
    logger.error(`Error fetching Trakt genres for ${type}:`, err.message);
    logger.info(`[Trakt] Using fallback genres for ${type}`);
    return TRAKT_FALLBACK_GENRES[type] || [];
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
                  const originalShowPoster = metaResult.meta.poster;
                  const originalThumbnail = upNextVideo.thumbnail;
                  
                  logger.debug(`Up Next: S${upNextEpisode.season}E${upNextEpisode.episode} for ${metaResult.meta.name}: thumbnail="${originalThumbnail}", showPoster="${originalShowPoster}"`);
                  
                  if (upNextVideo.thumbnail && 
                      upNextVideo.thumbnail !== metaResult.meta.poster &&
                      !upNextVideo.thumbnail.includes('/missing_thumbnail.png')) {
                    let thumbnailUrl = upNextVideo.thumbnail;
                    
                    // Extract fallback URL if it's a proxy URL
                    if (thumbnailUrl && thumbnailUrl.includes('/poster/') && thumbnailUrl.includes('fallback=')) {
                    try {
                        const url = new URL(thumbnailUrl);
                      const fallback = url.searchParams.get('fallback');
                      if (fallback) {
                          const extractedFallback = decodeURIComponent(fallback);
                          logger.debug(`Up Next: Extracted fallback URL from proxy: ${extractedFallback}`);
                          thumbnailUrl = extractedFallback;
                      }
                    } catch (e) {
                      consola.warn(`[Meta Route] Failed to extract fallback poster URL: ${e.message}`);
                      }
                    }
                    
                    if (thumbnailUrl && 
                        thumbnailUrl !== originalShowPoster &&
                        !thumbnailUrl.includes('/missing_thumbnail.png')) {
                      logger.info(`Up Next: Using episode thumbnail for S${upNextEpisode.season}E${upNextEpisode.episode}: ${thumbnailUrl}`);
                      metaResult.meta.poster = thumbnailUrl;
                      metaResult.meta._rawPosterUrl = null;
                      metaResult.meta.posterShape = 'landscape';
                    } else {
                      logger.debug(`Up Next: S${upNextEpisode.season}E${upNextEpisode.episode} thumbnail (${thumbnailUrl || 'null'}) is same as show poster (${originalShowPoster}) or missing, keeping show poster for ${metaResult.meta.name}`);
                    }
                  } else {
                    if (!upNextVideo.thumbnail) {
                      logger.debug(`Up Next: S${upNextEpisode.season}E${upNextEpisode.episode} has no thumbnail, keeping show poster (${originalShowPoster}) for ${metaResult.meta.name}`);
                    } else if (upNextVideo.thumbnail === metaResult.meta.poster) {
                      logger.debug(`Up Next: S${upNextEpisode.season}E${upNextEpisode.episode} thumbnail (${originalThumbnail}) matches show poster (${originalShowPoster}), keeping show poster for ${metaResult.meta.name}`);
                    } else if (upNextVideo.thumbnail.includes('/missing_thumbnail.png')) {
                      logger.debug(`Up Next: S${upNextEpisode.season}E${upNextEpisode.episode} has missing_thumbnail placeholder (${originalThumbnail}), keeping show poster (${originalShowPoster}) for ${metaResult.meta.name}`);
                    }
                  }
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
                metaResult.meta.id = cacheId;
              }
            }
            
            return metaResult;
          }, 
          undefined, 
          { enableErrorCaching: true, maxRetries: 2 }, 
          metaType as any, 
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
    const queueKey = accessToken ? accessToken : TRAKT_UNAUTHED_QUEUE_KEY;
    
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
      `Trakt getTraktListDetails (${username}/${listSlug})`,
      3,
      queueKey
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
    const queueKey = accessToken ? accessToken : TRAKT_UNAUTHED_QUEUE_KEY;

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
      `Trakt getTraktListDetailsById (${listId})`,
      3,
      queueKey
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
  days: number,
  cacheTTL?: number
): Promise<{items: any[]}> {
  const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex').substring(0, 16);
  const cacheKey = `trakt-api:calendar:${tokenHash}:${startDate}:${days}`;
  
  const ttl = cacheTTL !== undefined ? cacheTTL : parseInt(process.env.CATALOG_TTL || String(1 * 24 * 60 * 60), 10);
  
  return await cacheWrapGlobal(cacheKey, async () => {
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
        `Trakt fetchCalendarShows (startDate: ${startDate}, days: ${days})`,
        3,
        accessToken
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
  }, ttl);
}

async function getTraktWatchedIds(config: any): Promise<{ movieImdbIds: Set<string>, showImdbIds: Set<string> } | null> {
  try {
    const accessToken = await getTraktAccessToken(config);
    if (!accessToken) return null;

    const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex').substring(0, 16);

    const activitiesCacheKey = `trakt_activities:${tokenHash}`;
    const activities = await cacheWrapGlobal(activitiesCacheKey, async () => {
      return await fetchTraktLastActivity(accessToken);
    }, 300);

    const moviesWatchedAt = activities?.movies?.watched_at || '';
    const episodesWatchedAt = activities?.episodes?.watched_at || '';
    const fingerprint = crypto.createHash('sha256')
      .update(`${moviesWatchedAt}:${episodesWatchedAt}`)
      .digest('hex')
      .substring(0, 16);

    const watchedCacheKey = `trakt_watched_ids:${tokenHash}:${fingerprint}`;
    const watchedData = await cacheWrapGlobal(watchedCacheKey, async () => {
      const [watchedMovies, watchedShows] = await Promise.all([
        fetchTraktWatchedMovies(accessToken),
        fetchTraktWatchedShowsFull(accessToken)
      ]);

      const movieIds: string[] = [];
      for (const item of watchedMovies) {
        const imdbId = item.movie?.ids?.imdb;
        if (imdbId) movieIds.push(imdbId);
      }

      const showIds: string[] = [];
      let partialCount = 0;
      for (const item of watchedShows) {
        const imdbId = item.show?.ids?.imdb;
        if (!imdbId) continue;

        const airedEpisodes = item.show?.aired_episodes || 0;
        if (airedEpisodes === 0) continue;

        let watchedEpisodes = 0;
        if (item.seasons && Array.isArray(item.seasons)) {
          for (const season of item.seasons) {
            if (season.number === 0) continue;
            if (season.episodes && Array.isArray(season.episodes)) {
              watchedEpisodes += season.episodes.length;
            }
          }
        }

        if (watchedEpisodes >= airedEpisodes) {
          showIds.push(imdbId);
        } else {
          partialCount++;
        }
      }

      logger.info(`[Watched IDs] Fetched ${movieIds.length} watched movies, ${showIds.length} fully-watched shows (${partialCount} partial, skipped)`);
      return { movieIds, showIds };
    }, 86400);

    return {
      movieImdbIds: new Set(watchedData.movieIds),
      showImdbIds: new Set(watchedData.showIds)
    };
  } catch (err: any) {
    logger.warn(`[Watched IDs] Error fetching Trakt watched IDs: ${err.message}`);
    return null;
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
  makeAuthenticatedRateLimitedTraktRequest,
  makeAuthenticatedRateLimitedTraktWriteRequest,
  getTraktAccessToken,
  getTraktWatchedIds,
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
    context,
    3,
    TRAKT_UNAUTHED_QUEUE_KEY
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
    context,
    3,
    accessToken
  );
}

/**
 * Wrapper for authenticated write endpoints - serializes writes and enforces 1 write/sec per token.
 * @param url - Full Trakt API URL
 * @param data - POST payload
 * @param accessToken - OAuth access token
 * @param context - Context string for logging
 */
async function makeAuthenticatedRateLimitedTraktWriteRequest(
  url: string,
  data: any,
  accessToken: string,
  context: string = 'Trakt Proxy (Auth Write)'
): Promise<any> {
  return await runSerializedWrite(accessToken, async () => {
    const lastWriteAt = lastWriteAtByToken.get(accessToken) || 0;
    const elapsedMs = Date.now() - lastWriteAt;
    const waitMs = AUTHED_API_WRITE_INTERVAL_MS - elapsedMs;
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    const response = await makeRateLimitedRequest(
      () => httpPost(url, data, {
        dispatcher: traktDispatcher,
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': TRAKT_CLIENT_ID,
          'Authorization': `Bearer ${accessToken}`
        }
      }),
      context,
      3,
      accessToken
    );

    lastWriteAtByToken.set(accessToken, Date.now());
    return response;
  });
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
  genre?: string,
  cacheTTL?: number
): Promise<{items: any[], totalItems?: number, hasMore: boolean, totalPages?: number}> {
  const cacheKey = `trakt-api:most-favorited:${type}:${period}:${page}:${limit}:${genre || ''}`;
  
  const ttl = cacheTTL !== undefined ? cacheTTL : parseInt(process.env.CATALOG_TTL || String(1 * 24 * 60 * 60), 10);
  
  return await cacheWrapGlobal(cacheKey, async () => {
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
        `Trakt fetchMostFavoritedItems (${type}, period: ${period}, page: ${page}, genre: ${genre || 'none'})`,
        3,
        TRAKT_UNAUTHED_QUEUE_KEY
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
  }, ttl, { skipVersion: true });
}

/**
 * Fetch trending items for movies or shows from Trakt
 */
async function fetchTraktTrendingItems(
  type: 'movies' | 'shows',
  page: number = 1,
  limit: number = 20,
  genre?: string,
  cacheTTL?: number
): Promise<{items: any[], totalItems?: number, hasMore: boolean, totalPages?: number}> {
  const cacheKey = `trakt-api:trending:${type}:${page}:${limit}:${genre || ''}`;
  
  const ttl = cacheTTL !== undefined ? cacheTTL : parseInt(process.env.CATALOG_TTL || String(1 * 24 * 60 * 60), 10);
  
  return await cacheWrapGlobal(cacheKey, async () => {
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
        `Trakt fetchTrendingItems (${type}, page: ${page})`,
        3,
        TRAKT_UNAUTHED_QUEUE_KEY
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
      throw err;
    }
  }, ttl, { skipVersion: true });
}

/**
 * Fetch popular items for movies or shows from Trakt
 */
async function fetchTraktPopularItems(
  type: 'movies' | 'shows',
  page: number = 1,
  limit: number = 20,
  genre?: string,
  cacheTTL?: number
): Promise<{items: any[], totalItems?: number, hasMore: boolean, totalPages?: number}> {
  const cacheKey = `trakt-api:popular:${type}:${page}:${limit}:${genre || ''}`;
  
  const ttl = cacheTTL !== undefined ? cacheTTL : parseInt(process.env.CATALOG_TTL || String(1 * 24 * 60 * 60), 10);
  
  return await cacheWrapGlobal(cacheKey, async () => {
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
        `Trakt fetchPopularItems (${type}, page: ${page})`,
        3,
        TRAKT_UNAUTHED_QUEUE_KEY
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
      throw err;
    }
  }, ttl, { skipVersion: true });
}

const refreshLocks = new Map<string, Promise<string | null>>();
/**
 * Get Trakt access token from database with automatic refresh
 * @param config - User configuration object
 * @returns Access token string or null if not available
 */
async function getTraktAccessToken(config: any, forceRefresh: boolean = false): Promise<string | null> {
  if (!config.apiKeys?.traktTokenId) {
    logger.debug(`No Trakt token ID configured for user`);
    return null;
  }
  
  const tokenId = config.apiKeys.traktTokenId;
  logger.debug(`Attempting to retrieve Trakt token: ${tokenId}`);
  
  let tokenData;
  try {
    tokenData = await database.getOAuthToken(tokenId);
  } catch (error: any) {
    logger.error(`Database error while retrieving Trakt token ${tokenId}: ${error.message}`);
    return null;
  }
  
  if (!tokenData) {
    logger.warn(`Trakt token not found in database: ${tokenId}`);
    logger.warn(`This could indicate:`);
    logger.warn(`1. Token was deleted/disconnected`);
    logger.warn(`2. Database connection issue`);
    logger.warn(`3. Configuration mismatch`);
    logger.warn(`Please check your Trakt connection in settings`);
    return null;
  }
  
  logger.debug(`Found Trakt token for user: ${tokenData.user_id}, provider: ${tokenData.provider}`);
  
  const expiresAt = typeof tokenData.expires_at === 'string' ? parseInt(tokenData.expires_at, 10) : tokenData.expires_at;
  
  // Validate token data structure
  if (!tokenData.access_token || typeof tokenData.access_token !== 'string' || tokenData.access_token.startsWith('[object')) {
    logger.error(`Trakt token is corrupted (access_token: ${typeof tokenData.access_token}, value preview: ${String(tokenData.access_token).substring(0, 30)})`);
    logger.error(`Please disconnect and reconnect your Trakt account in settings`);
    return null;
  }
  
  if (!tokenData.refresh_token || typeof tokenData.refresh_token !== 'string') {
    logger.error(`Trakt token is missing refresh_token. Please disconnect and reconnect your Trakt account`);
    return null;
  }
  
  const numericExpiresAt = Number(expiresAt);
  if (!Number.isFinite(numericExpiresAt) || numericExpiresAt <= 0) {
    logger.error(`Trakt token has invalid expires_at (${numericExpiresAt}). Please disconnect and reconnect your Trakt account`);
    return null;
  }
  
  // Check if token is expired or will expire soon (within 1 hour)
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;

  if (forceRefresh || numericExpiresAt < (now + oneHour)) {
    // Prevent concurrent refreshes for the same token
    if (refreshLocks.has(tokenId)) {
      logger.debug(`Trakt token refresh already in progress for ${tokenId}, waiting...`);
      return refreshLocks.get(tokenId)!;
    }

    const refreshPromise = (async (): Promise<string | null> => {
      logger.debug(`Trakt token ${forceRefresh ? 'force refresh requested' : 'expired or expiring soon'} (expires: ${new Date(numericExpiresAt).toISOString()}), refreshing...`);
      try {
        const { TraktClient } = require('../lib/trakt');
        const traktClient = new TraktClient(
          process.env.TRAKT_CLIENT_ID!,
          process.env.TRAKT_CLIENT_SECRET!,
          TRAKT_REDIRECT_URI!
        );
        const newTokens = await traktClient.refreshAccessToken(tokenData.refresh_token);
        const updateSuccess = await database.updateOAuthToken(
          tokenId,
          newTokens.access_token,
          newTokens.refresh_token,
          newTokens.expires_at
        );
        if (!updateSuccess) {
          logger.error(`Failed to update Trakt token in database after refresh`);
          return null;
        }
        logger.debug(`Trakt token refreshed successfully (new expiry: ${new Date(newTokens.expires_at).toISOString()})`);
        return newTokens.access_token;
      } catch (error: any) {
        logger.error(`Failed to refresh Trakt token: ${error.message}`);
        logger.error(`Stack trace:`, error.stack);
        try {
          const stillExists = await database.getOAuthToken(tokenId);
          if (!stillExists) {
            logger.error(`Trakt token was deleted during refresh attempt`);
          }
        } catch (dbError: any) {
          logger.error(`Database error during token existence check: ${dbError.message}`);
        }
        return null;
      }
    })();

    refreshLocks.set(tokenId, refreshPromise);
    try {
      return await refreshPromise;
    } finally {
      refreshLocks.delete(tokenId);
    }
  }
  
  logger.debug(`Using valid Trakt token (expires: ${new Date(expiresAt).toISOString()})`);
  return tokenData.access_token;
}

/**
 * Escape special characters in Trakt search query
 * Trakt treats these as special: + - && || ! ( ) { } [ ] ^ " ~ * ? : /
 * @param query - Search query string
 * @returns Escaped query string
 */
function escapeTraktQuery(query: string): string {
  // Escape special characters that Trakt treats as operators
  const specialChars = /[+\-&|!(){}[\]^"~*?:/\\]/g;
  return query.replace(specialChars, (match) => `\\${match}`);
}

/**
 * Fetch search results from Trakt 
 * Note: Trakt search API doesn't respect the page parameter, only limit.
 * We request 30 items in a single call to avoid wasting API calls.
 * @param type - Content type ('movie' or 'show')
 * @param query - Search query string
 * @param config - Optional user configuration (for age rating filtering)
 * @returns Array of search results (up to 30 items)
 */
async function fetchTraktSearchItems(
  type: 'movie' | 'show',
  query: string,
  config?: any
): Promise<any[]> {
  if (TRAKT_SEARCH_DISABLED) {
    logger.debug('[Trakt Search] Disabled via DISABLE_TRAKT_SEARCH env');
    return [];
  }
  try {
    const searchType = type === 'movie' ? 'movie' : 'show';
    const escapedQuery = escapeTraktQuery(query);
    // Search in title, translations, and overview fields
    const fields = 'title,translations,overview';
    // Trakt search doesn't respect page parameter, only limit. Request 30 items in one call. We will keep the set limit until they hopefully fix it.
    const limit = 30;
    
    const url = `${TRAKT_BASE_URL}/search/${searchType}?query=${encodeURIComponent(escapedQuery)}&fields=${fields}&extended=images&limit=${limit}`;
    
    logger.debug(`Trakt search: type=${searchType}, query="${query}" (escaped: "${escapedQuery}"), fields=${fields}, limit=${limit}`);
    
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, {
        dispatcher: traktDispatcher,
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': TRAKT_CLIENT_ID
        }
      }),
      `Trakt fetchSearchItems (${searchType}, query: "${query}")`,
      3,
      TRAKT_UNAUTHED_QUEUE_KEY
    );

    if (!response.data || !Array.isArray(response.data)) {
      logger.info(`No Trakt search results found for query: "${query}"`);
      return [];
    }

    logger.debug(`Found ${response.data.length} Trakt search results for query: "${query}"`);
    return response.data;
  } catch (err: any) {
    logger.error(`Error fetching Trakt search results for ${type} "${query}":`, err.message);
    return [];
  }
}

/**
 * Fetch person search results from Trakt
 * @param query - Search query string
 * @returns Array of person search results
 */
async function fetchTraktPersonSearch(query: string): Promise<any[]> {
  if (TRAKT_SEARCH_DISABLED) {
    return [];
  }
  try {
    // Escape special characters in query
    const escapedQuery = escapeTraktQuery(query);
    // Person search doesn't need extended info, we only need IDs to fetch credits
    const url = `${TRAKT_BASE_URL}/search/person?query=${encodeURIComponent(escapedQuery)}`;
    
    logger.debug(`Trakt person search: query="${query}" (escaped: "${escapedQuery}")`);
    
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, {
        dispatcher: traktDispatcher,
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': TRAKT_CLIENT_ID
        }
      }),
      `Trakt fetchPersonSearch (query: "${query}")`,
      3,
      TRAKT_UNAUTHED_QUEUE_KEY
    );

    if (!response.data || !Array.isArray(response.data)) {
      logger.info(`No Trakt person results found for query: "${query}"`);
      return [];
    }

    logger.debug(`Found ${response.data.length} Trakt person results for query: "${query}"`);
    return response.data;
  } catch (err: any) {
    logger.error(`Error fetching Trakt person search results for "${query}":`, err.message);
    return [];
  }
}

/**
 * Fetch movies or shows for a person from Trakt
 * @param personId - Trakt person ID
 * @param type - Content type ('movie' or 'show')
 * @returns Array of movies or shows
 */
async function fetchTraktPersonCredits(
  personId: number,
  type: 'movie' | 'show',
  limit?: number
): Promise<any[]> {
  try {
    const url = `${TRAKT_BASE_URL}/people/${personId}/${type === 'movie' ? 'movies' : 'shows'}?extended=full,images`;
    
    logger.debug(`Trakt person credits: personId=${personId}, type=${type}`);
    
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, {
        dispatcher: traktDispatcher,
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': TRAKT_CLIENT_ID
        }
      }),
      `Trakt fetchPersonCredits (personId: ${personId}, type: ${type})`,
      3,
      TRAKT_UNAUTHED_QUEUE_KEY
    );

    if (!response.data || typeof response.data !== 'object') {
      logger.info(`No Trakt credits found for person ${personId}`);
      return [];
    }

    const cast = Array.isArray(response.data.cast) ? response.data.cast : [];
    
    const crewObj = response.data.crew || {};
    const relevantCrewCategories = ['directing', 'writing'];
    const relevantCrewArrays = relevantCrewCategories
      .map(category => crewObj[category])
      .filter(Array.isArray);
    const allCrew = relevantCrewArrays.flat();
    
    const allCredits = [...cast, ...allCrew];
    
    if (allCredits.length === 0) {
      logger.info(`No Trakt credits (cast or crew) found for person ${personId}`);
      return [];
    }

    // Sort by votes (descending) so most popular credits are returned first
    const sortedCredits = allCredits.sort((a, b) => {
      const mediaKey = type === 'movie' ? 'movie' : 'show';
      const aVotes = a[mediaKey]?.votes || 0;
      const bVotes = b[mediaKey]?.votes || 0;
      return bVotes - aVotes; 
    });

    // Extract the movie/show objects from the credit wrappers
    let mediaItems = sortedCredits.map(credit => credit[type === 'movie' ? 'movie' : 'show']).filter(Boolean);

    // Limit results if specified (credits are already sorted by votes, so we take the top N)
    if (limit && limit > 0) {
      mediaItems = mediaItems.slice(0, limit);
    }

    logger.debug(`Found ${mediaItems.length} Trakt credits (${cast.length} cast, ${allCrew.length} crew) for person ${personId}, sorted by votes${limit ? `, limited to ${limit}` : ''}`);
    return mediaItems;
  } catch (err: any) {
    logger.error(`Error fetching Trakt person credits for person ${personId}:`, err.message);
    return [];
  }
}

export async function getTraktToken(tokenId: string): Promise<string | null> {
  if (!tokenId) return null;
  return getTraktAccessToken({ apiKeys: { traktTokenId: tokenId } });
}

export async function checkinMovie(idInput: Record<string, string | number>, accessToken: string): Promise<boolean> {
  try {
    const url = 'https://api.trakt.tv/checkin';
    const payload = {
      movie: {
        ids: idInput
      },
      app_version: "1.0",
      app_date: new Date().toISOString().split('T')[0]
    };
    
    await makeRateLimitedRequest(
      () => httpPost(url, payload, {
        dispatcher: traktDispatcher,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'trakt-api-version': '2',
          'trakt-api-key': process.env.TRAKT_CLIENT_ID
        }
      }),
      'Trakt checkinMovie',
      3,
      accessToken
    );
    logger.info(`[Trakt Checkin] Checked in movie`, { ids: idInput });
    return true;
  } catch (error: any) {
    if (error.response?.status === 409) {
      logger.info('[Trakt Checkin] Already checked in (409 Conflict)');
      return true;
    }
    logger.error(`[Trakt Checkin] Movie check-in failed: ${error.message}`);
    return false;
  }
}

export async function checkinSeries(
  idInput: Record<string, string | number>,
  season: number,
  episode: number,
  accessToken: string
): Promise<boolean> {
  try {
    const url = 'https://api.trakt.tv/checkin';
    const payload = {
      episode: {
        season: season,
        number: episode
      },
      show: {
        ids: idInput
      },
      app_version: "1.0",
      app_date: new Date().toISOString().split('T')[0]
    };

    await makeRateLimitedRequest(
      () => httpPost(url, payload, {
        dispatcher: traktDispatcher,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'trakt-api-version': '2',
          'trakt-api-key': process.env.TRAKT_CLIENT_ID
        }
      }),
      'Trakt checkinSeries',
      3,
      accessToken
    );
    logger.info(`[Trakt Checkin] Checked in episode`, { ids: idInput, season, episode });
    return true;
  } catch (error: any) {
    if (error.response?.status === 409) {
      logger.info('[Trakt Checkin] Already checked in (409 Conflict)');
      return true;
    }
    logger.error(`[Trakt Checkin] Episode check-in failed: ${error.message}`);
    return false;
  }
}

function getTraktMemoryStats() {
  return {
    rateLimitQueues: queueManager.getQueueCount(),
    writeChains: writeChains.size,
    lastWriteAtByToken: lastWriteAtByToken.size,
    refreshLocks: refreshLocks.size,
  };
}

export {
  fetchTraktMostFavoritedItems,
  fetchTraktTrendingItems,
  fetchTraktPopularItems,
  fetchTraktSearchItems,
  fetchTraktPersonSearch,
  fetchTraktPersonCredits,
  traktDispatcher,
  getTraktMemoryStats,
};
