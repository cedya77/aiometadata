import { getMeta } from "../lib/getMeta.js";
import { cacheWrapMetaSmart } from "../lib/getCache.js";
import { resolveAllIds } from "../lib/id-resolver.js";
import { UserConfig } from "../types/index.js";
import consola from 'consola';

const logger = consola.withTag('PublicMetaDB');

const BASE_URL = 'https://publicmetadb.com';

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// --- Rate limiting (matches mdbList.ts pattern) ---

const RATE_LIMIT_CONFIG = {
  maxRetries: 5,
  baseDelay: 1000,
  maxDelay: 30000,
  rateLimitDelay: 5000,
  minInterval: 35, // 300 req/10s = ~33ms per request, leave headroom
  backoffMultiplier: 2,
};

interface RateLimitState {
  recentRateLimitHits: number;
  lastRateLimitTime: number;
  isRateLimited: boolean;
  rateLimitResetTime: number;
}

const rateLimitStates = new Map<string, RateLimitState>();

let globalLastRequestTime = 0;
let globalRequestPromise = Promise.resolve();

async function globalThrottle(): Promise<void> {
  const currentRequest = globalRequestPromise.then(async () => {
    const now = Date.now();
    const timeSinceLast = now - globalLastRequestTime;
    if (timeSinceLast < RATE_LIMIT_CONFIG.minInterval) {
      await sleep(RATE_LIMIT_CONFIG.minInterval - timeSinceLast);
    }
    globalLastRequestTime = Date.now();
  });
  globalRequestPromise = currentRequest;
  await currentRequest;
}

function getRateLimitState(apiKey: string): RateLimitState {
  if (!rateLimitStates.has(apiKey)) {
    rateLimitStates.set(apiKey, {
      recentRateLimitHits: 0,
      lastRateLimitTime: 0,
      isRateLimited: false,
      rateLimitResetTime: 0,
    });
  }
  return rateLimitStates.get(apiKey)!;
}

function isPermanentError(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}

async function makeRequest(
  endpoint: string,
  apiKey: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: any
): Promise<any> {
  const state = getRateLimitState(apiKey);
  let attempt = 0;

  while (attempt < RATE_LIMIT_CONFIG.maxRetries) {
    attempt++;
    const isLastAttempt = attempt === RATE_LIMIT_CONFIG.maxRetries;

    // Check per-key penalty box
    const now = Date.now();
    if (state.isRateLimited && state.rateLimitResetTime > now) {
      const waitTime = state.rateLimitResetTime - now;
      logger.debug(`[Rate Limit] Penalty box active, waiting ${waitTime}ms`);
      await sleep(waitTime);
    }
    state.isRateLimited = false;

    await globalThrottle();

    const url = `${BASE_URL}${endpoint}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
    };
    if (body) headers['Content-Type'] = 'application/json';

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.ok) {
        state.recentRateLimitHits = 0;
        return res.json();
      }

      if (isPermanentError(res.status)) {
        const text = await res.text().catch(() => '');
        throw new Error(`PublicMetaDB ${method} ${endpoint} returned ${res.status}: ${text}`);
      }

      if (res.status === 429) {
        state.lastRateLimitTime = Date.now();
        state.recentRateLimitHits++;

        if (isLastAttempt) {
          throw new Error(`PublicMetaDB ${method} ${endpoint} rate limited after ${RATE_LIMIT_CONFIG.maxRetries} attempts`);
        }

        const retryAfterHeader = res.headers.get('Retry-After');
        let backoffTime = 0;
        if (retryAfterHeader) {
          const retrySeconds = parseInt(retryAfterHeader, 10);
          if (!isNaN(retrySeconds)) backoffTime = retrySeconds * 1000;
        }
        if (!backoffTime) {
          backoffTime = RATE_LIMIT_CONFIG.rateLimitDelay * Math.pow(2, state.recentRateLimitHits - 1);
          backoffTime = Math.min(backoffTime + Math.random() * 1000, RATE_LIMIT_CONFIG.maxDelay);
        }

        logger.warn(`[Rate Limit] 429 on ${endpoint}, retrying in ${Math.round(backoffTime)}ms (attempt ${attempt}/${RATE_LIMIT_CONFIG.maxRetries})`);
        state.isRateLimited = true;
        state.rateLimitResetTime = Date.now() + backoffTime;
        await sleep(backoffTime);
        continue;
      }

      // Other non-ok status (5xx, etc.)
      const text = await res.text().catch(() => '');
      if (isLastAttempt) {
        throw new Error(`PublicMetaDB ${method} ${endpoint} returned ${res.status}: ${text}`);
      }

      const delay = Math.min(
        RATE_LIMIT_CONFIG.baseDelay * Math.pow(RATE_LIMIT_CONFIG.backoffMultiplier, attempt - 1),
        RATE_LIMIT_CONFIG.maxDelay
      );
      logger.debug(`[Retry] ${endpoint} returned ${res.status}, retrying in ${delay}ms (attempt ${attempt}/${RATE_LIMIT_CONFIG.maxRetries})`);
      await sleep(delay);
    } catch (err: any) {
      // Network errors (fetch throws)
      if (err.message?.startsWith('PublicMetaDB')) throw err; // re-throw our own errors
      if (isLastAttempt) {
        throw new Error(`PublicMetaDB ${method} ${endpoint} failed after ${RATE_LIMIT_CONFIG.maxRetries} attempts: ${err.message}`);
      }
      const delay = Math.min(
        RATE_LIMIT_CONFIG.baseDelay * Math.pow(RATE_LIMIT_CONFIG.backoffMultiplier, attempt - 1),
        RATE_LIMIT_CONFIG.maxDelay
      );
      logger.debug(`[Retry] ${endpoint} network error, retrying in ${delay}ms (attempt ${attempt}/${RATE_LIMIT_CONFIG.maxRetries}): ${err.message}`);
      await sleep(delay);
    }
  }

  throw new Error(`PublicMetaDB ${method} ${endpoint}: all ${RATE_LIMIT_CONFIG.maxRetries} attempts failed`);
}

// --- API Functions ---

async function validateKey(apiKey: string): Promise<boolean> {
  try {
    await makeRequest('/api/external/lists?perPage=1', apiKey);
    return true;
  } catch {
    return false;
  }
}

async function fetchResume(apiKey: string): Promise<any[]> {
  const data = await makeRequest('/api/external/resume', apiKey);
  return data.items || [];
}

async function fetchLists(apiKey: string, page: number = 1, perPage: number = 50): Promise<any> {
  return makeRequest(`/api/external/lists?page=${page}&perPage=${perPage}`, apiKey);
}

async function fetchListItems(apiKey: string, listId: string, page: number = 1, perPage: number = 20): Promise<any> {
  return makeRequest(`/api/external/lists/${listId}/items?page=${page}&perPage=${perPage}`, apiKey);
}

async function fetchPicks(apiKey: string): Promise<any> {
  return makeRequest('/api/external/catalogs', apiKey);
}

async function fetchPickItems(apiKey: string, pickId: string, page: number = 1): Promise<any> {
  return makeRequest(`/api/external/catalogs/${pickId}/items?page=${page}`, apiKey);
}

async function markWatched(
  apiKey: string,
  tmdbId: number,
  mediaType: 'movie' | 'tv',
  season?: number,
  episode?: number
): Promise<any> {
  const body: any = { tmdb_id: tmdbId, media_type: mediaType };
  if (mediaType === 'tv' && season != null && episode != null) {
    body.season = season;
    body.episode = episode;
  }
  return makeRequest('/api/external/watched?dedupe=true', apiKey, 'POST', body);
}

// --- Parse functions for catalog ---

async function parseResumeItems(
  items: any[],
  type: string,
  language: string,
  config: UserConfig,
  useShowPoster: boolean = false
): Promise<any[]> {
  logger.info(`Parsing ${items.length} resume items`);

  const metas = await Promise.all(
    items.map(async (item: any) => {
      try {
        const stremioType = item.media_type === 'movie' ? 'movie' : 'series';
        if (type !== 'all' && type !== stremioType) return null;

        const stremioId = `tmdb:${item.tmdb_id}`;
        const epIdPart = item.media_type === 'tv' ? `S${item.season}E${item.episode}` : '';
        const cacheId = `pmdb_resume_${stremioId}_${epIdPart}`;

        const result = await cacheWrapMetaSmart(
          (config as any).userUUID,
          cacheId,
          async () => {
            const includeVideos = stremioType === 'series';
            const metaResult = await getMeta(stremioType, language, stremioId, config, (config as any).userUUID, includeVideos);

            if (metaResult?.meta && item.media_type === 'tv' && metaResult.meta.videos) {
              const upNextVideo = metaResult.meta.videos.find((v: any) =>
                v.season === item.season && v.episode === item.episode
              );

              if (upNextVideo) {
                metaResult.meta.videos = [upNextVideo];
                metaResult.meta.behaviorHints = metaResult.meta.behaviorHints || {};
                metaResult.meta.behaviorHints.defaultVideoId = upNextVideo.id;

                if (!useShowPoster && upNextVideo.thumbnail &&
                    upNextVideo.thumbnail !== metaResult.meta.poster &&
                    !upNextVideo.thumbnail.includes('/missing_thumbnail.png')) {
                  let thumbnailUrl = upNextVideo.thumbnail;
                  if (thumbnailUrl.includes('/poster/') && thumbnailUrl.includes('fallback=')) {
                    try {
                      const url = new URL(thumbnailUrl);
                      const fallback = url.searchParams.get('fallback');
                      if (fallback) thumbnailUrl = decodeURIComponent(fallback);
                    } catch {}
                  }
                  if (thumbnailUrl && thumbnailUrl !== metaResult.meta.poster && !thumbnailUrl.includes('/missing_thumbnail.png')) {
                    metaResult.meta.poster = thumbnailUrl;
                    metaResult.meta._rawPosterUrl = null;
                    metaResult.meta.posterShape = 'landscape';
                  }
                }

                metaResult.meta.name = `${metaResult.meta.name} - S${item.season}E${item.episode}`;
                metaResult.meta.id = cacheId;
              }
            }

            return metaResult;
          },
          undefined, { enableErrorCaching: true, maxRetries: 2, config }, stremioType as any, stremioType === 'series'
        );

        return result?.meta || null;
      } catch (err: any) {
        logger.warn(`Failed to parse resume item tmdb:${item.tmdb_id}: ${err.message}`);
        return null;
      }
    })
  );

  return metas.filter(Boolean);
}

async function parseListItems(
  items: any[],
  type: string,
  language: string,
  config: UserConfig
): Promise<any[]> {
  logger.info(`Parsing ${items.length} list items`);

  const metas = await Promise.all(
    items.map(async (item: any) => {
      try {
        const stremioType = item.media_type === 'movie' ? 'movie' : 'series';
        if (type !== 'all' && type !== stremioType) return null;

        const stremioId = `tmdb:${item.tmdb_id}`;
        const cacheId = `pmdb_list_${stremioId}`;

        const result = await cacheWrapMetaSmart(
          (config as any).userUUID,
          cacheId,
          async () => getMeta(stremioType, language, stremioId, config, (config as any).userUUID, false),
          undefined, { enableErrorCaching: true, maxRetries: 2, config }, stremioType as any, false
        );

        return result?.meta || null;
      } catch (err: any) {
        logger.warn(`Failed to parse list item tmdb:${item.tmdb_id}: ${err.message}`);
        return null;
      }
    })
  );

  return metas.filter(Boolean);
}

async function parsePickItems(
  items: any[],
  type: string,
  language: string,
  config: UserConfig
): Promise<any[]> {
  logger.info(`Parsing ${items.length} pick items`);

  const metas = await Promise.all(
    items.map(async (item: any) => {
      try {
        const stremioType = item.media_type === 'movie' ? 'movie' : 'series';
        if (type !== 'all' && type !== stremioType) return null;

        const stremioId = `tmdb:${item.tmdb_id}`;
        const cacheId = `pmdb_pick_${stremioId}`;

        const result = await cacheWrapMetaSmart(
          (config as any).userUUID,
          cacheId,
          async () => getMeta(stremioType, language, stremioId, config, (config as any).userUUID, false),
          undefined, { enableErrorCaching: true, maxRetries: 2, config }, stremioType as any, false
        );

        return result?.meta || null;
      } catch (err: any) {
        logger.warn(`Failed to parse pick item tmdb:${item.tmdb_id}: ${err.message}`);
        return null;
      }
    })
  );

  return metas.filter(Boolean);
}

// --- Watch tracking (called from subtitleHandler) ---

async function checkinMovie(ids: Record<string, any>, apiKey: string): Promise<boolean> {
  try {
    let tmdbId = ids.tmdb;
    if (!tmdbId && ids.imdb) {
      const resolved = await resolveAllIds(ids.imdb, 'movie', {}, undefined, ['tmdb']);
      tmdbId = resolved?.tmdbId ? parseInt(resolved.tmdbId, 10) : null;
    }
    if (!tmdbId) {
      logger.debug(`[Watch Tracking] Could not resolve TMDB ID for movie: ${JSON.stringify(ids)}`);
      return false;
    }

    const result = await markWatched(apiKey, tmdbId, 'movie');
    if (!result?.success) {
      logger.warn(`[Watch Tracking] Movie watch not confirmed: tmdb:${tmdbId}`);
      return false;
    }
    logger.info(`[Watch Tracking] Movie marked as watched: tmdb:${tmdbId}`);
    return true;
  } catch (err: any) {
    logger.error(`[Watch Tracking] Movie tracking failed: ${err.message}`);
    return false;
  }
}

async function checkinEpisode(
  ids: Record<string, any>,
  season: number,
  episode: number,
  apiKey: string
): Promise<boolean> {
  try {
    let tmdbId = ids.tmdb;
    if (!tmdbId && ids.imdb) {
      const resolved = await resolveAllIds(ids.imdb, 'series', {}, undefined, ['tmdb']);
      tmdbId = resolved?.tmdbId ? parseInt(resolved.tmdbId, 10) : null;
    }
    if (!tmdbId) {
      logger.debug(`[Watch Tracking] Could not resolve TMDB ID for series: ${JSON.stringify(ids)}`);
      return false;
    }

    const result = await markWatched(apiKey, tmdbId, 'tv', season, episode);
    if (!result?.success) {
      logger.warn(`[Watch Tracking] Episode watch not confirmed: tmdb:${tmdbId} S${season}E${episode}`);
      return false;
    }
    logger.info(`[Watch Tracking] Episode marked as watched: tmdb:${tmdbId} S${season}E${episode}`);
    return true;
  } catch (err: any) {
    logger.error(`[Watch Tracking] Episode tracking failed: ${err.message}`);
    return false;
  }
}

function getMemoryStats() {
  return { rateLimitStates: rateLimitStates.size };
}

export {
  validateKey,
  fetchResume,
  fetchLists,
  fetchListItems,
  fetchPicks,
  fetchPickItems,
  markWatched,
  parseResumeItems,
  parseListItems,
  parsePickItems,
  checkinMovie,
  checkinEpisode,
  getMemoryStats,
};
