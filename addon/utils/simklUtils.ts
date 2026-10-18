import { httpGet, httpPost, httpRequest } from "./httpClient.js";
import { historyPayload, type EpisodeRef } from "./historyPayload";
import { noteTrackerCall } from "./trackerCalls";
import { getMeta } from "../lib/getMeta.js";
import { cacheWrapMetaSmart, cacheWrapGlobal, classifyResultAllowEmpty } from "../lib/getCache.js";
import { mapWithLimit } from "./concurrency";
import { envInt } from "./envNumber";
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
const { isSimklV2Token, simklClientIdFor } = require('../lib/simkl');
const { getSetting } = require('../lib/settingsService');
const SIMKL_TRENDING_TTL = 12 * 60 * 60; // 12 hours
const SIMKL_WATCHLIST_TTL = 24 * 60 * 60; // Cache in Redis for 24h, relies on activity check to invalidate
const SIMKL_ACTIVITIES_TTL_DEFAULT = 30 * 60; // Simkl asks callers to throttle sync checks to once per 15-30 min
const SIMKL_LIST_STATUSES = ['plantowatch', 'watching', 'completed', 'hold', 'dropped'];

const SIMKL_SYNC_INTERVAL_MIN_MINUTES = 1;
const SIMKL_SYNC_INTERVAL_MAX_MINUTES = 24 * 60;

function getSimklActivitiesTtl(): number {
  const parsed = parseInt(getSetting('SIMKL_ACTIVITIES_TTL') || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SIMKL_ACTIVITIES_TTL_DEFAULT;
}

function simklActivitiesTtlFor(accessToken: string, config?: any): number {
  const minutes = Number(config?.simklSyncInterval);
  if (!isSimklV2Token(accessToken) || !Number.isFinite(minutes) || minutes <= 0) return getSimklActivitiesTtl();
  return Math.round(Math.min(Math.max(minutes, SIMKL_SYNC_INTERVAL_MIN_MINUTES), SIMKL_SYNC_INTERVAL_MAX_MINUTES) * 60);
}
const SIMKL_TRENDING_DATA_URL = 'https://data.simkl.in/discover/trending';
const SIMKL_DISCOVER_DATA_URL = 'https://data.simkl.in/discover';
const SIMKL_APP_NAME = 'aiometadata';

function withAppParams(url: string): string {
  if (/[?&]app-name=/.test(url)) return url;
  const params = new URLSearchParams({ 'app-name': SIMKL_APP_NAME, 'app-version': process.env.npm_package_version || '1.0' });
  return `${url}${url.includes('?') ? '&' : '?'}${params.toString()}`;
}

/** Simkl counts a stop as watched from AIOM's own played threshold on; it accepts 50 to 100. */
function scrobbleUrl(action: string): string {
  const url = `${SIMKL_BASE_URL}/scrobble/${action}`;
  if (action === 'pause') return url;
  const threshold = Math.min(100, Math.max(50, envInt('JELLYFIN_PLAYED_THRESHOLD', 80, 1)));
  return `${url}?min_progress=${threshold}`;
}

function simklDataParams(): string {
  const params = new URLSearchParams({
    'app-name': SIMKL_APP_NAME,
    'app-version': process.env.npm_package_version || '1.0'
  });
  if (simklClientIdFor()) params.set('client_id', simklClientIdFor());
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

const SIMKL_APP_BUCKET = 'app';
const SIMKL_V2_GET_INTERVAL_MS = 100;
const SIMKL_V2_POST_INTERVAL_MS = 1000;
const SIMKL_QUOTA_KEY_PREFIX = 'simkl-quota:';

interface SimklBucket {
  lastRequestTime: number;
  recentRateLimitHits: number;
  cooldownUntil: number;
  pausedUntil: number;
}

const simklBuckets = new Map<string, SimklBucket>();

function simklBucket(key: string): SimklBucket {
  let bucket = simklBuckets.get(key);
  if (!bucket) {
    bucket = { lastRequestTime: 0, recentRateLimitHits: 0, cooldownUntil: 0, pausedUntil: 0 };
    simklBuckets.set(key, bucket);
  }
  return bucket;
}

function simklTokenHash(accessToken: string): string {
  return crypto.createHash('sha256').update(accessToken).digest('hex').substring(0, 16);
}

function simklBucketFor(accessToken?: string): string {
  return accessToken && isSimklV2Token(accessToken) ? `user:${simklTokenHash(accessToken)}` : SIMKL_APP_BUCKET;
}

function nyOffsetMs(at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(at / 1000) * 1000;
}

function nextSimklReset(now: number = Date.now()): number {
  const nyNow = new Date(now + nyOffsetMs(now));
  const nyMidnight = Date.UTC(nyNow.getUTCFullYear(), nyNow.getUTCMonth(), nyNow.getUTCDate() + 1);
  const guess = nyMidnight - nyOffsetMs(now);
  return nyMidnight - nyOffsetMs(guess);
}

export interface SimklQuota {
  limit: number;
  remaining: number;
  resetsAt: number;
  pausedUntil?: number;
  updatedAt: number;
}

async function readSimklQuota(bucketKey: string): Promise<SimklQuota | null> {
  if (!redis || bucketKey === SIMKL_APP_BUCKET) return null;
  try {
    const raw = await redis.get(SIMKL_QUOTA_KEY_PREFIX + bucketKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function writeSimklQuota(bucketKey: string, quota: SimklQuota): Promise<void> {
  if (!redis || bucketKey === SIMKL_APP_BUCKET) return;
  const ttl = Math.max(60, Math.ceil((Math.max(quota.resetsAt, quota.pausedUntil ?? 0) - Date.now()) / 1000));
  await redis.set(SIMKL_QUOTA_KEY_PREFIX + bucketKey, JSON.stringify(quota), 'EX', ttl).catch(() => undefined);
}

async function getSimklQuota(accessToken: string): Promise<SimklQuota | null> {
  const quota = await readSimklQuota(simklBucketFor(accessToken));
  if (!quota || quota.resetsAt <= Date.now()) return null;
  return quota;
}

function headerNumber(headers: any, name: string): number | null {
  const value = headers?.[name];
  const parsed = parseInt(Array.isArray(value) ? value[0] : value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function noteSimklQuota(bucketKey: string, headers: any): Promise<void> {
  if (bucketKey === SIMKL_APP_BUCKET) return;
  const limit = headerNumber(headers, 'x-ratelimit-limit');
  const remaining = headerNumber(headers, 'x-ratelimit-remaining');
  if (limit === null || remaining === null) return;
  const resetsAt = nextSimklReset();
  const pausedUntil = remaining <= 0 ? resetsAt : undefined;
  if (pausedUntil) simklBucket(bucketKey).pausedUntil = pausedUntil;
  await writeSimklQuota(bucketKey, { limit, remaining, resetsAt, pausedUntil, updatedAt: Date.now() });
}

function simklErrorCode(error: any): string | null {
  let data = error?.response?.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return null; }
  }
  return typeof data?.error === 'string' ? data.error : null;
}

function simklQuotaExhausted(until: number): Error {
  const error: any = new Error(`Simkl daily allowance spent until ${new Date(until).toISOString()}`);
  error.code = 'SIMKL_QUOTA_EXHAUSTED';
  error.response = { status: 429, data: { error: 'user_limit_exceeded' } };
  return error;
}

async function simklPausedUntil(bucketKey: string): Promise<number> {
  const bucket = simklBucket(bucketKey);
  const now = Date.now();
  if (bucket.pausedUntil > now) return bucket.pausedUntil;
  const stored = await readSimklQuota(bucketKey);
  if (stored?.pausedUntil && stored.pausedUntil > now) {
    bucket.pausedUntil = stored.pausedUntil;
    return stored.pausedUntil;
  }
  return 0;
}

async function pauseSimklBucket(bucketKey: string, error: any, context: string): Promise<void> {
  const retryAfter = headerNumber(error?.response?.headers, 'retry-after');
  const until = retryAfter && retryAfter > 0 ? Date.now() + retryAfter * 1000 : nextSimklReset();
  simklBucket(bucketKey).pausedUntil = until;
  const who = bucketKey === SIMKL_APP_BUCKET ? "the app's" : "this user's";
  logger.warn(`[Simkl] ${who} daily allowance is spent until ${new Date(until).toISOString()}, skipping Simkl calls until then - ${context}`);
  if (bucketKey !== SIMKL_APP_BUCKET) {
    const previous = await readSimklQuota(bucketKey);
    await writeSimklQuota(bucketKey, {
      limit: previous?.limit ?? 0,
      remaining: 0,
      resetsAt: nextSimklReset(),
      pausedUntil: until,
      updatedAt: Date.now(),
    });
  }
}

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

interface SimklRequestOptions {
  bucket?: string;
  minInterval?: number;
}

async function makeRateLimitedRequest<T>(
  requestFn: () => Promise<T>,
  context: string = 'Simkl',
  retries: number = RATE_LIMIT_CONFIG.maxRetries,
  options: SimklRequestOptions = {}
): Promise<T> {
  const bucketKey = options.bucket ?? SIMKL_APP_BUCKET;
  const minInterval = options.minInterval ?? RATE_LIMIT_CONFIG.minInterval;
  const state = simklBucket(bucketKey);
  let attempt = 0;
  while (attempt < retries) {
    attempt++;
    const isLastAttempt = attempt === retries;

    const pausedUntil = await simklPausedUntil(bucketKey);
    if (pausedUntil) {
      logger.debug(`[Simkl] Daily allowance spent until ${new Date(pausedUntil).toISOString()}, not calling - ${context}`);
      noteTrackerCall(SIMKL_BASE_URL, 429, 'user_limit_exceeded', null, pausedUntil);
      throw simklQuotaExhausted(pausedUntil);
    }

    const now = Date.now();
    if (state.cooldownUntil > now) {
      const waitTime = state.cooldownUntil - now;
      logger.debug(`Rate limit cooldown active, waiting ${waitTime}ms - ${context}`);
      await sleep(waitTime);
    }

    const timeSinceLastRequest = Date.now() - state.lastRequestTime;
    if (timeSinceLastRequest < minInterval) {
      await sleep(minInterval - timeSinceLastRequest);
    }
    state.lastRequestTime = Date.now();
    const startTime = Date.now();

    try {
      const response: any = await requestFn();
      const responseTime = Date.now() - startTime;
      requestTracker.trackProviderCall('simkl', responseTime, true);
      state.recentRateLimitHits = 0;
      await noteSimklQuota(bucketKey, response?.headers);
      return response;
    } catch (error: any) {
      const responseTime = Date.now() - startTime;
      requestTracker.trackProviderCall('simkl', responseTime, false);
      const status = error.response?.status;
      await noteSimklQuota(bucketKey, error.response?.headers);

      if (isPermanentError(error)) {
        logger.error(`[Simkl] Permanent error (${status}): ${context} - ${error.message || String(error)}`);
        throw error;
      }

      const code = status === 429 ? simklErrorCode(error) : null;
      if (code === 'user_limit_exceeded' || code === 'app_limit_exceeded') {
        await pauseSimklBucket(code === 'app_limit_exceeded' ? SIMKL_APP_BUCKET : bucketKey, error, context);
        throw error;
      }

      if (isRateLimitError(error)) {
        state.recentRateLimitHits++;

        if (isLastAttempt) {
          logger.error(`[Simkl] Rate limit exceeded after ${retries} attempts: ${context}`);
          throw error;
        }

        const totalDelay = code === 'rate_limit'
          ? 1000 + Math.random() * 500
          : Math.min(
            getRetryAfterMs(error, RATE_LIMIT_CONFIG.rateLimitDelay * Math.pow(2, state.recentRateLimitHits - 1)),
            RATE_LIMIT_CONFIG.maxDelay
          );

        logger.warn(`[Simkl] Rate limit hit (${status}${code ? ` ${code}` : ''}). Retrying in ${Math.round(totalDelay / 1000)}s (attempt ${attempt}/${retries}) - ${context}`);

        state.cooldownUntil = Date.now() + totalDelay;
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
    if (needsRefresh(token)) return (await refreshSimklToken(tokenId)) ?? token;
    return token;
  } catch (error: any) {
    logger.error(`Error getting Simkl access token: ${error.message}`);
    return null;
  }
}

function needsRefresh(token: any): boolean {
  if (!isSimklV2Token(token?.access_token) || !token?.refresh_token) return false;
  const aheadMs = (parseInt(getSetting('SIMKL_TOKEN_REFRESH_AHEAD'), 10) || 24 * 60 * 60) * 1000;
  return Number(token.expires_at) - Date.now() < aheadMs;
}

const refreshing = new Map<string, Promise<any | null>>();
const refreshFailedUntil = new Map<string, number>();

// A refresh kills the previous access token, so only one runs per grant across replicas.
function refreshSimklToken(tokenId: string): Promise<any | null> {
  const running = refreshing.get(tokenId);
  if (running) return running;
  const work = (async () => {
    if ((refreshFailedUntil.get(tokenId) ?? 0) > Date.now()) return null;
    const lockKey = `simkl-token-refresh:${tokenId}`;
    const locked = redis ? await redis.set(lockKey, '1', 'PX', 30000, 'NX').catch(() => 'OK') : 'OK';
    try {
      if (locked !== 'OK') {
        for (let waited = 0; waited < 10000; waited += 500) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const fresh = await database.getOAuthToken(tokenId);
          if (fresh && !needsRefresh(fresh)) return fresh;
        }
        return null;
      }
      const current = await database.getOAuthToken(tokenId);
      if (!current || !needsRefresh(current)) return current;

      const { simklV2Credentials, refreshSimklV2Token } = require('../lib/simkl');
      const { clientId, clientSecret } = simklV2Credentials();
      if (!clientId) {
        logger.warn('A Simkl token needs refreshing but SIMKL_V2_CLIENT_ID is not set');
        return null;
      }
      const tokens = await refreshSimklV2Token(clientId, clientSecret, current.refresh_token);
      const expiresAt = Date.now() + tokens.expires_in * 1000;
      await database.updateOAuthToken(tokenId, tokens.access_token, tokens.refresh_token, expiresAt);
      logger.debug(`Simkl token ${tokenId} refreshed until ${new Date(expiresAt).toISOString()}`);
      return { ...current, access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: expiresAt };
    } catch (error: any) {
      const retryMs = (parseInt(getSetting('SIMKL_TOKEN_REFRESH_RETRY'), 10) || 300) * 1000;
      refreshFailedUntil.set(tokenId, Date.now() + retryMs);
      logger.warn(`Simkl token ${tokenId} could not be refreshed: ${error?.message || error}${error?.code === 'invalid_grant' ? '; the user has to reconnect Simkl' : ''}`);
      return null;
    } finally {
      if (locked === 'OK' && redis) await redis.del(lockKey).catch(() => undefined);
    }
  })().finally(() => refreshing.delete(tokenId));
  refreshing.set(tokenId, work);
  return work;
}

async function makeAuthenticatedSimklRequest(
  url: string,
  accessToken: string,
  context: string = 'Simkl (Auth)',
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: any,
  timeout?: number
): Promise<any> {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'simkl-api-key': simklClientIdFor(accessToken)
  };
  url = withAppParams(url);
  const bucket = simklBucketFor(accessToken);
  const minInterval = bucket === SIMKL_APP_BUCKET
    ? undefined
    : method === 'GET' ? SIMKL_V2_GET_INTERVAL_MS : SIMKL_V2_POST_INTERVAL_MS;
  const extra = timeout ? { timeout } : {};

  if (method === 'DELETE') {
    return await makeRateLimitedRequest(
      () => httpRequest(url, { method: 'DELETE', headers, dispatcher: simklDispatcher, ...extra }),
      context,
      undefined,
      { bucket, minInterval }
    );
  } else if (method === 'POST') {
    return await makeRateLimitedRequest(
      () => httpPost(url, body || {}, { headers, dispatcher: simklDispatcher, ...extra }),
      context,
      undefined,
      { bucket, minInterval }
    );
  } else {
    return await makeRateLimitedRequest(
      () => httpGet(url, { headers, dispatcher: simklDispatcher, ...extra }),
      context,
      undefined,
      { bucket, minInterval }
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

// Paused sessions across every type, which is the shape a continue watching
// row wants. Anime entries carry their own kitsu numbering alongside the TVDB
// one, so an episode needs no mapping to name it the way the meta does.
async function fetchPlaybackSessions(accessToken: string): Promise<any[]> {
  if (!accessToken) return [];

  try {
    const response = await makeAuthenticatedSimklRequest(
      `${SIMKL_BASE_URL}/sync/playback`,
      accessToken,
      'Simkl fetchPlaybackSessions'
    );
    return Array.isArray(response?.data) ? response.data : [];
  } catch (error: any) {
    logger.error(`[Simkl] Fetching playback sessions failed: ${error.message}`);
    return [];
  }
}

// With a user's token it goes as that user, which a V2 app requires of every request.
async function makeRateLimitedSimklRequest(url: string, context: string = 'Simkl Proxy', accessToken?: string | null): Promise<any> {
  if (accessToken) return makeAuthenticatedSimklRequest(url, accessToken, context);
  const headers = {
    'Content-Type': 'application/json',
    'simkl-api-key': simklClientIdFor()
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
  page: number = 1,
  accessToken?: string | null
): Promise<any[]> {
  try {
    // Simkl clamps rather than rejecting: limit tops out at 50 and page at 20.
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const safePage = Math.min(Math.max(page, 1), 20);
    const url = `${SIMKL_BASE_URL}/search/${type}?q=${encodeURIComponent(query)}&limit=${safeLimit}&page=${safePage}&extended=full&${simklDataParams()}`;
    const response: any = await makeRateLimitedSimklRequest(url, `Simkl search (${type}, query: "${query}")`, accessToken);

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

function simklDetailTtl(): number {
  return parseInt(getSetting('SIMKL_DETAIL_TTL'), 10) || 24 * 60 * 60;
}

/**
 * Search answers with an index row, so anything beyond title, year, poster and ids
 * has to come from here. This is also the only place a simkl id turns into an imdb
 * or tvdb one, which search omits.
 */
async function fetchSimklItemDetail(type: 'movie' | 'tv' | 'anime', simklId: string | number, accessToken?: string | null): Promise<any> {
  if (!simklId) return null;
  const segment = type === 'movie' ? 'movies' : type;
  return cacheWrapGlobal(
    `simkl:detail:${segment}:${simklId}`,
    async () => {
      try {
        const url = `${SIMKL_BASE_URL}/${segment}/${simklId}?extended=full&${simklDataParams()}`;
        const response: any = await makeRateLimitedSimklRequest(url, `Simkl detail (${segment}/${simklId})`, accessToken);
        return response?.data ?? null;
      } catch (err: any) {
        logger.debug(`Simkl detail lookup failed for ${segment}/${simklId}: ${err.message}`);
        return null;
      }
    },
    simklDetailTtl(),
    { resultClassifier: classifyResultAllowEmpty }
  );
}

type SimklTitleRef = { segment: 'movie' | 'tv' | 'anime'; id: number } | { missing: true };

// Simkl answers an external id with a redirect to the title's page, and an unknown one with its home page.
async function resolveSimklTitle(param: 'mal' | 'imdb' | 'tmdb', value: string, kind?: 'movie' | 'show'): Promise<SimklTitleRef> {
  const query = `${param}=${encodeURIComponent(value)}${kind ? `&type=${kind}` : ''}`;
  return cacheWrapGlobal(
    `simkl:redirect:${query}`,
    async () => {
      const url = `${SIMKL_BASE_URL}/redirect?to=simkl&${query}&${simklDataParams()}`;
      const location: string = await makeRateLimitedRequest(async () => {
        try {
          await httpRequest(url, { headers: { 'simkl-api-key': simklClientIdFor() }, dispatcher: simklDispatcher });
          return '';
        } catch (error: any) {
          const header = error?.response?.headers?.location;
          if (header) return String(header);
          throw error;
        }
      }, `Simkl redirect (${query})`);
      const match = location.match(/simkl\.com\/(movies|tv|anime)\/(\d+)/);
      return match ? { segment: match[1] === 'movies' ? 'movie' : match[1], id: Number(match[2]) } : { missing: true };
    },
    simklDetailTtl(),
    { resultClassifier: classifyResultAllowEmpty }
  );
}

/**
 * What Simkl suggests next to a title: what its users recommend alongside it,
 * or when there are none, the titles in the same genres its page shows.
 */
async function fetchSimklRecommendations(ids: { mal?: any; imdb?: any; tmdb?: any }, type: 'movie' | 'series'): Promise<any[]> {
  const lookups: Array<[param: 'mal' | 'imdb' | 'tmdb', value: any, kind?: 'movie' | 'show']> = [
    ['mal', ids.mal],
    ['imdb', ids.imdb],
    ['tmdb', ids.tmdb, type === 'movie' ? 'movie' : 'show'],
  ];
  for (const [param, value, kind] of lookups) {
    if (!value) continue;
    const title = await resolveSimklTitle(param, String(value), kind);
    if ('missing' in title) continue;
    const detail = await fetchSimklItemDetail(title.segment, title.id);
    if (!detail) return [];
    const viewers = Array.isArray(detail.users_recommendations) ? detail.users_recommendations : [];
    return viewers.length ? viewers : Array.isArray(detail.similar) ? detail.similar : [];
  }
  return [];
}

/**
 * The token a public read has to carry. A V1 app answers on its client id alone,
 * so none is needed (undefined) and none is billed to the user; a V2 app refuses
 * anything without a user's token, so it is the connected account's, or null
 * when there is none and the read cannot be made.
 */
async function simklUserTokenIfRequired(config: any): Promise<string | null | undefined> {
  if (String(process.env.SIMKL_CLIENT_ID || '').trim()) return undefined;
  const tokenId = config?.apiKeys?.simklTokenId;
  if (!tokenId) return null;
  const token = await getSimklToken(tokenId);
  return token?.access_token || null;
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

async function fetchSimklLastActivities(accessToken: string, config?: any): Promise<any> {
  const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex').substring(0, 16);
  const cacheKey = `simkl-api-last-activities:${tokenHash}`;
  
  // Cached so that rapid pagination requests share one "state of truth"
  // instead of hitting the API once per page.
  return await cacheWrapGlobal(
    cacheKey,
    async () => {
      const url = `${SIMKL_BASE_URL}/sync/activities`;
      // GET, not POST: Simkl allows 10 GET/sec but only 1 POST/sec.
      const response: any = await makeAuthenticatedSimklRequest(
        url,
        accessToken,
        'Simkl fetchLastActivities'
      );
      return response.data;
    },
    simklActivitiesTtlFor(accessToken, config),
    { upstream: true }
  );
}

async function getSimklActivityFingerprint(
  accessToken: string,
  type: 'movies' | 'shows' | 'anime',
  status: string,
  config?: any
): Promise<string> {
  try {
    const activities = await fetchSimklLastActivities(accessToken, config);
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
 * One status of a Simkl library, read from the watch mirror: the account's library kept
 * in the database and brought up to date from what changed since its last sync, the
 * same copy the Jellyfin server reads. A catalog, Up Next and the hide-watched filter
 * therefore ask Simkl only what changed, once for all of them.
 */
async function fetchSimklWatchlistItems(
  accessToken: string,
  type: 'movies' | 'shows' | 'anime',
  status: 'watching' | 'plantowatch' | 'hold' | 'completed' | 'dropped',
  cacheTTL: number = SIMKL_WATCHLIST_TTL,
  config?: any
): Promise<{items: any[]}> {
  try {
    const tokenId = config?.apiKeys?.simklTokenId;
    if (!tokenId) {
      logger.debug(`Simkl ${status}: no Simkl connection on this configuration`);
      return { items: [] };
    }

    const { syncMirror, mirrorVersion, sourceKeyFor } = require('../lib/jellyfin/trackerMirror');
    let version: number;
    try {
      version = await syncMirror('simkl', tokenId, config);
    } catch (error: any) {
      version = await mirrorVersion('simkl', tokenId);
      if (!version) throw error;
      logger.warn(`Simkl ${status}: sync failed, serving the library as last synced: ${error?.message || error}`);
    }

    const source = sourceKeyFor('simkl', tokenId);
    const items: any[] = await cacheWrapGlobal(`simkl-watchlist-mirror:${source}:v${version}:${type}:${status}`, async () => {
      const database: any = require('../lib/database');
      const out: any[] = [];
      for (const row of await database.listTrackerMirrorGroup(source, type)) {
        let entry: any;
        try {
          entry = JSON.parse(row.data);
        } catch {
          continue;
        }
        if (entry?.status !== status) continue;
        // The episode lists are the watch store's; no list reader looks at them.
        const { seasons, mapped_tvdb_seasons, ...item } = entry;
        out.push(item);
      }
      return out;
    }, cacheTTL, { upstream: true, resultClassifier: classifyResultAllowEmpty });

    const finalItems = [...(items ?? [])];
    // Plan to Watch and On Hold by the date added, the others by the last watch.
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

export async function addToHistory(
  idInput: Record<string, string | number>,
  accessToken: string,
  season?: number,
  episode?: number,
  episodes?: EpisodeRef[]
): Promise<boolean> {
  const payload = historyPayload(idInput, season, episode, episodes);

  try {
    const response = await makeAuthenticatedSimklRequest(
      `${SIMKL_BASE_URL}/sync/history`, accessToken, 'Simkl add to history', 'POST', payload, 10000
    );
    if (response.status >= 200 && response.status < 300) {
      logger.info('[Simkl] Added to history', { ids: idInput, season, episode });
      return true;
    }
    logger.warn(`[Simkl] Add to history answered ${response.status}`);
    return false;
  } catch (error: any) {
    logger.error(`[Simkl] Failed to add to history: ${error.message}`);
    return false;
  }
}

/** True when a playback entry is the title, and for a show the episode, named. */
export function playbackEntryMatches(
  entry: any,
  idInput: Record<string, string | number>,
  season?: number,
  episode?: number
): boolean {
  const ids = (entry?.anime ?? entry?.show ?? entry?.movie)?.ids ?? {};
  const shared = Object.entries(idInput).some(([key, value]) => ids[key] != null && String(ids[key]) === String(value));
  if (!shared) return false;
  if (season == null || episode == null) return !entry?.episode;

  const ep = entry?.episode;
  if (!ep) return false;
  return (Number(ep.season) === season && Number(ep.number) === episode)
    || (Number(ep.tvdb_season) === season && Number(ep.tvdb_number) === episode);
}

/** Drops the paused session so the title leaves continue watching. */
export async function clearPlayback(
  idInput: Record<string, string | number>,
  accessToken: string,
  season?: number,
  episode?: number
): Promise<boolean> {
  const sessions = await fetchPlaybackSessions(accessToken);
  const matches = sessions.filter((entry) => entry?.id && playbackEntryMatches(entry, idInput, season, episode));
  if (!matches.length) {
    logger.debug(`[Simkl] No paused session to clear for ${JSON.stringify(idInput)}${season != null ? ` S${season}E${episode}` : ''} among ${sessions.length}`);
    return true;
  }

  try {
    for (const entry of matches) {
      await makeAuthenticatedSimklRequest(
        `${SIMKL_BASE_URL}/sync/playback/${entry.id}`, accessToken, 'Simkl clear playback', 'DELETE', undefined, 10000
      );
    }
    logger.info('[Simkl] Cleared the resume point', { ids: idInput, season, episode });
    return true;
  } catch (error: any) {
    logger.error(`[Simkl] Clearing the resume point failed: ${error.message}`);
    return false;
  }
}

// A show sent with no seasons is removed from the library entirely, so an
// episode always names both its season and its number.
export async function removeFromHistory(
  idInput: Record<string, string | number>,
  accessToken: string,
  season?: number,
  episode?: number,
  episodes?: EpisodeRef[]
): Promise<boolean> {
  const payload = historyPayload(idInput, season, episode, episodes);

  try {
    const response = await makeAuthenticatedSimklRequest(
      `${SIMKL_BASE_URL}/sync/history/remove`, accessToken, 'Simkl remove from history', 'POST', payload, 10000
    );
    if (response.status >= 200 && response.status < 300) {
      logger.info('[Simkl] Removed from history', { ids: idInput, season, episode });
      return true;
    }
    logger.warn(`[Simkl] Remove from history answered ${response.status}`);
    return false;
  } catch (error: any) {
    logger.error(`[Simkl] Failed to remove from history: ${error.message}`);
    return false;
  }
}

export interface SimklScrobbleOptions {
  /** checkin is fire and forget and self-completes; start and stop are a session. */
  action?: 'checkin' | 'start' | 'pause' | 'stop';
  /** 0-100. Simkl marks an item watched on stop at the played threshold or above. */
  progress?: number;
}

async function checkinMovie(
  idInput: MovieIdInput,
  accessToken: string,
  options: SimklScrobbleOptions = {}
): Promise<boolean> {
  const action = options.action ?? 'checkin';
  const progress = typeof options.progress === 'number' ? options.progress : 1;
  const normalizedIds = normalizeMovieIdInput(idInput);

  if (!normalizedIds || !accessToken) {
    logger.debug('[Simkl Checkin] Missing ID or accessToken for checkinMovie', {
      id: idInput,
      hasToken: !!accessToken
    });
    return false;
  }

  try {

    const url = scrobbleUrl(action);
    const watchedAt = new Date().toISOString();

    const payload = {
      progress,
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
  fallbackData?: any, // Made optional
  options: SimklScrobbleOptions = {}
): Promise<boolean> {
  const action = options.action ?? 'checkin';
  const progress = typeof options.progress === 'number' ? options.progress : 1;
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
    'simkl-api-key': simklClientIdFor(accessToken)
  };

  const doCheckin = async (ids: Record<string, string | number>, attemptLabel: string, seasonNumber: number, episodeNumber:number) => {
      const url = withAppParams(scrobbleUrl(action));
      const payload = {
        progress,
        show: { ids: ids },
        episode: { season: seasonNumber, number: episodeNumber }
      };

      logger.debug(`[Simkl Checkin] ${attemptLabel} - ids: ${formatIdSummary(ids)}, S${seasonNumber}E${episodeNumber}`);

      const bucket = simklBucketFor(accessToken);
      const response = await httpPost(url, payload, { 
        headers, 
        dispatcher: simklDispatcher,
        timeout: 10000 
      }).catch(async (error: any) => {
        await noteSimklQuota(bucket, error?.response?.headers);
        throw error;
      });
      await noteSimklQuota(bucket, response.headers);
  
      if (response.status >= 200 && response.status < 300) {
        logger.info(`[Simkl ${action}] Reported episode (${attemptLabel})`, { ids, seasonNumber, episodeNumber });
        return true;
      }

      // Stopping a session Simkl already finalised in the past hour answers 409.
      // A client reporting one stop twice is expected, so that is the same
      // outcome as having stopped it, not a failure to retry.
      if (action === 'stop' && response.status === 409) {
        logger.debug(`[Simkl stop] Session already finalised (${attemptLabel})`);
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


export type SimklListsError = 'premium_only' | 'needs_v2';

// Custom Lists need a V2 token on a PRO or VIP account; a free one gets HTTP 200 carrying `premium_only`.
function simklListsError(status: number | undefined, data: any): SimklListsError | null {
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = null; }
  }
  if (data?.error === 'premium_only') return 'premium_only';
  if (status === 403 && data?.error === 'oauth2_token_required') return 'needs_v2';
  return null;
}

async function fetchSimklUserLists(accessToken: string, userId: string | number): Promise<{ lists: any[]; error?: SimklListsError }> {
  if (!isSimklV2Token(accessToken)) return { lists: [], error: 'needs_v2' };
  const lists: any[] = [];
  for (let page = 1; page <= 20; page++) {
    let response: any;
    try {
      response = await makeAuthenticatedSimklRequest(`${SIMKL_BASE_URL}/lists/user/${encodeURIComponent(String(userId))}?limit=500&page=${page}`, accessToken, 'Simkl user lists');
    } catch (error: any) {
      const failure = simklListsError(error?.response?.status, error?.response?.data);
      if (failure) return { lists, error: failure };
      throw error;
    }
    const failure = simklListsError(response?.status, response?.data);
    if (failure) return { lists, error: failure };
    lists.push(...(Array.isArray(response?.data?.lists) ? response.data.lists : []));
    if (page >= (Number(response?.data?.pagination?.total_pages) || 1)) break;
  }
  return { lists };
}

/** Simkl clamps `limit` above this silently, so the cap has to be ours. */
const SIMKL_LIST_MAX_LIMIT = 500;
const SIMKL_LIST_PAGE_REACH = 10000;

/** Reads are billed per request to the user's own daily allowance. `page` times `limit` may not exceed 10000 either way. */
function simklListBlockSize(pageSize: number): number {
  const configured = parseInt(getSetting('SIMKL_LIST_BLOCK_SIZE'), 10);
  const size = Number.isFinite(configured) && configured > 0 ? configured : SIMKL_LIST_MAX_LIMIT;
  return Math.max(pageSize, Math.min(size, SIMKL_LIST_MAX_LIMIT));
}

function simklListBlockTtl(): number {
  const floor = parseInt(getSetting('SIMKL_LIST_MIN_TTL'), 10) || 300;
  const catalog = parseInt(process.env.CATALOG_TTL || '', 10) || 24 * 60 * 60;
  return Math.max(floor, catalog);
}

class SimklListFailure extends Error {
  constructor(public reason: SimklListsError) { super(reason); }
}

async function fetchSimklListBlock(accessToken: string, listId: string, blockPage: number, blockSize: number): Promise<{ list: any; items: any[]; totalPages: number }> {
  const cacheKey = `simkl-list-block:${simklTokenHash(accessToken)}:${listId}:${blockPage}:${blockSize}`;

  return cacheWrapGlobal(cacheKey, async () => {
    // No sort: sending one turns the direction default to desc.
    const url = `${SIMKL_BASE_URL}/lists/${encodeURIComponent(listId)}?limit=${blockSize}&page=${blockPage}`;
    let response: any;
    try {
      response = await makeAuthenticatedSimklRequest(url, accessToken, `Simkl list ${listId} block ${blockPage}`);
    } catch (error: any) {
      const failure = simklListsError(error?.response?.status, error?.response?.data);
      if (failure) throw new SimklListFailure(failure);
      throw error;
    }
    const failure = simklListsError(response?.status, response?.data);
    if (failure) throw new SimklListFailure(failure);

    const remaining = response?.headers?.['x-ratelimit-remaining'];
    if (remaining !== undefined) logger.debug(`[Simkl] List ${listId} block ${blockPage} of ${blockSize}: ${remaining} requests left today`);

    const data = response?.data ?? {};
    return {
      list: data,
      items: Array.isArray(data.items) ? data.items : [],
      totalPages: Number(data.pagination?.total_pages) || 0,
    };
  }, simklListBlockTtl(), { maxRetries: 0 });
}

async function fetchSimklListPage(accessToken: string, listId: string, page: number, limit: number): Promise<{ list: any; items: any[]; totalPages: number; hasMore: boolean; error?: SimklListsError }> {
  if (!isSimklV2Token(accessToken)) return { list: null, items: [], totalPages: 0, hasMore: false, error: 'needs_v2' };

  const blockSize = simklListBlockSize(limit);
  const start = (page - 1) * limit;
  const blockPage = Math.floor(start / blockSize) + 1;
  if (blockPage * blockSize > SIMKL_LIST_PAGE_REACH) return { list: null, items: [], totalPages: 0, hasMore: false };

  let block: { list: any; items: any[]; totalPages: number };
  try {
    block = await fetchSimklListBlock(accessToken, listId, blockPage, blockSize);
  } catch (error: any) {
    if (error instanceof SimklListFailure) return { list: null, items: [], totalPages: 0, hasMore: false, error: error.reason };
    throw error;
  }

  const within = start - (blockPage - 1) * blockSize;
  const items = block.items.slice(within, within + limit);
  const hasMore = within + limit < block.items.length ? true : blockPage < block.totalPages;

  // total_pages counts blocks, so it converts only once a block is the last.
  const lastBlock = block.items.length < blockSize || blockPage >= block.totalPages;
  const totalItems = lastBlock ? (blockPage - 1) * blockSize + block.items.length : undefined;

  return {
    list: block.list,
    items,
    totalPages: totalItems !== undefined ? Math.ceil(totalItems / limit) : 0,
    hasMore,
  };
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
      types.map(type => getSimklActivityFingerprint(accessToken, type, 'completed', config))
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
        const { items } = await fetchSimklWatchlistItems(accessToken, type, 'completed', undefined, config);
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
    }, SIMKL_WATCHLIST_TTL, { resultClassifier: classifyResultAllowEmpty });

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
  // Simkl sends its ids as strings.
  const malId = Number(ids.mal);
  if (Number.isInteger(malId) && malId > 0) return malId;
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
    const animeItems: { index: number; malId: number; stub: any }[] = [];
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
          animeItems.push({ index: i, malId, stub: {
            mal_id: malId,
            type: itemType,
            title: (item.title || '').replace(/\\'/g, "'"),
            year,
            duration: item.runtime,
            synopsis: item.overview,
            images: { jpg: { large_image_url: posterUrl } },
            aired: { from: airedFrom, to: airedTo },
            status: item.status
          } });
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
      // Simkl carries no synopsis or genres, so the batch reads MAL's own record,
      // through the cache the meta page fills. Kitsu builds from its own records,
      // and an IMDb-id catalog from getMeta, so those titles need none.
      const provider = config.providers?.anime || 'mal';
      const imdbIds = (config as any).mal?.useImdbIdForCatalogAndSearch === true;
      const needsRecord = ({ malId, stub }: { malId: number; stub: any }): boolean => {
        const mapping = idMapper.getMappingByMalId(malId);
        if (provider === 'kitsu') return !mapping?.kitsu_id;
        if (!imdbIds) return true;
        const imdbId = stub.type === 'movie' ? idMapper.getTraktAnimeMovieByMalId(malId)?.externals?.imdb : mapping?.imdb_id;
        return !imdbId;
      };
      const { getAnimeDetailsCached } = require('../lib/mal');
      const records = await mapWithLimit(animeItems, async (entry) => {
        if (!needsRecord(entry)) return entry.stub;
        const details = await getAnimeDetailsCached(entry.malId).catch(() => null);
        return details?.mal_id ? { ...details, mal_id: entry.malId } : entry.stub;
      });
      const batchMetas = await Utils.parseAnimeCatalogMetaBatch(records, config, config.language, includeVideos);

      // The batch leaves out a title it cannot build or the age rating hides, so
      // its metas go back to their items by MAL id; one that does not name it
      // takes the next empty slot.
      const slotsByMal = new Map<string, number[]>();
      for (const { index, malId } of animeItems) {
        const slots = slotsByMal.get(String(malId)) ?? [];
        slots.push(index);
        slotsByMal.set(String(malId), slots);
      }
      const unplaced: any[] = [];
      for (const meta of batchMetas) {
        const at = slotsByMal.get(String(meta?._malId ?? ''))?.shift();
        if (at !== undefined) result[at] = meta;
        else if (meta) unplaced.push(meta);
      }
      for (const { index } of animeItems) {
        if (result[index] === null && unplaced.length) result[index] = unplaced.shift();
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
    const clientId = simklClientIdFor();
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
    const { items } = await fetchSimklWatchlistItems(accessToken, bucket, 'watching', undefined, config);
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
  fetchSimklRecommendations,
  fetchSimklWatchlistItems,
  fetchSimklUpNextItems,
  parseSimklUpNextItems,
  parseSimklItems,
  makeAuthenticatedSimklRequest,
  getSimklRatings,
  getSimklToken,
  fetchPlaybackSessions,
  fetchSimklLastActivities,
  getSimklWatchedIds,
  fetchSimklUserLists,
  fetchSimklListPage,
  simklUserTokenIfRequired,
  getSimklActivityFingerprint,
  fetchSimklTrendingItems,
  fetchSimklRecipeItems,
  fetchSimklDvdReleases,
  fetchSimklGenreItems,
  fetchSimklCalendarItems,
  fetchSimklCalendarMonth,
  checkinMovie,
  checkinSeries,
  getSimklQuota,
  nextSimklReset
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

/** One month of Simkl's calendar. */
async function fetchSimklCalendarMonth(
  type: 'tv' | 'anime' | 'movie_release',
  year: number,
  month: number,
  cacheTTL: number = 21600
): Promise<any[]> {
  try {
    return await cacheWrapGlobal(
      `simkl-calendar:${type}:${year}-${month}`,
      async () => {
        const url = `https://data.simkl.in/calendar/${year}/${month}/${type}.json?${simklDataParams()}`;
        const response: any = await makeRateLimitedRequest(
          () => httpGet(url, { dispatcher: simklDispatcher }),
          `Simkl Calendar (${type} ${year}-${month})`
        );
        return Array.isArray(response.data) ? response.data : [];
      },
      cacheTTL,
      { upstream: true }
    );
  } catch (err: any) {
    logger.warn(`Simkl calendar ${type} ${year}-${month} failed: ${err.message}`);
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
