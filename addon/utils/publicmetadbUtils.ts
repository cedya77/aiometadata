import { getMeta } from "../lib/getMeta.js";
import { cacheWrapMetaSmart, cacheWrapGlobal } from "../lib/getCache.js";
import { createHash } from "crypto";
import { resolveAllIds } from "../lib/id-resolver.js";
import { UserConfig } from "../types/index.js";
import consola from 'consola';
import { noteTrackerCall } from "./trackerCalls.js";

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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
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
      noteTrackerCall(url, res.status, undefined, res.headers.get('Retry-After'));

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
      noteTrackerCall(url, 0);
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

// Paged like the watched history; the first page alone dropped every point past 100.
async function fetchResume(apiKey: string): Promise<any[]> {
  const { envInt } = require('./envNumber');
  const maxPages = envInt('PUBLICMETADB_RESUME_MAX_PAGES', 20, 1);
  const items: any[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const data = await makeRequest(`/api/external/resume?page=${page}&perPage=500`, apiKey);
    const batch = Array.isArray(data?.items) ? data.items : [];
    items.push(...batch);
    if (!batch.length || page >= (Number(data?.totalPages) || 1)) break;
  }
  return items;
}

async function fetchDropped(apiKey: string, page: number = 1, perPage: number = 100): Promise<{ items: any[]; total: number; totalPages: number }> {
  const data = await makeRequest(`/api/external/dropped?page=${page}&perPage=${Math.min(Math.max(1, perPage), 100)}`, apiKey);
  return { items: Array.isArray(data?.items) ? data.items : [], total: Number(data?.total) || 0, totalPages: Number(data?.totalPages) || 1 };
}

async function setDropped(apiKey: string, tmdbId: number | string, dropped: boolean): Promise<void> {
  if (dropped) {
    await makeRequest('/api/external/dropped', apiKey, 'POST', { tmdb_id: Number(tmdbId), media_type: 'tv' });
    return;
  }
  await makeRequest(`/api/external/dropped/${encodeURIComponent(String(tmdbId))}/tv`, apiKey, 'DELETE');
}

async function fetchWatched(apiKey: string, page: number = 1, perPage: number = 500): Promise<{ items: any[]; total: number; totalPages: number }> {
  const data = await makeRequest(`/api/external/watched?page=${page}&perPage=${Math.min(Math.max(1, perPage), 500)}`, apiKey);
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    total: Number(data?.total) || 0,
    totalPages: Number(data?.totalPages) || 1,
  };
}

async function tmdbIdFrom(ids: Record<string, any>, mediaType: 'movie' | 'series'): Promise<number | null> {
  if (ids.tmdb) return Number(ids.tmdb) || null;
  if (!ids.imdb) return null;
  const resolved = await resolveAllIds(ids.imdb, mediaType, {}, undefined, ['tmdb']);
  return resolved?.tmdbId ? parseInt(resolved.tmdbId, 10) : null;
}

async function clearResume(apiKey: string, tmdbId: number, mediaType: 'movie' | 'tv', season?: number, episode?: number): Promise<boolean> {
  const matches = (await fetchResume(apiKey)).filter((item: any) =>
    Number(item?.tmdb_id) === Number(tmdbId) &&
    item?.media_type === mediaType &&
    (mediaType === 'movie' || (Number(item?.season) === season && Number(item?.episode) === episode))
  );
  for (const item of matches) {
    if (item?.id) await makeRequest(`/api/external/resume/${encodeURIComponent(item.id)}`, apiKey, 'DELETE');
  }
  return matches.length > 0;
}

async function fetchLists(apiKey: string, page: number = 1, perPage: number = 50): Promise<any> {
  return makeRequest(`/api/external/lists?page=${page}&perPage=${perPage}`, apiKey);
}

type PmdbListType = 'watchlist' | 'custom';

function asListType(value: any): PmdbListType | null {
  return value === 'watchlist' || value === 'custom' ? value : null;
}

async function fetchAllLists(apiKey: string): Promise<any[]> {
  const items: any[] = [];
  for (let page = 1; page <= 20; page++) {
    const data = await fetchLists(apiKey, page, 500);
    items.push(...(data.items || []));
    if (page >= (data.totalPages || 1)) break;
  }
  return items;
}

async function listKinds(apiKey: string): Promise<Array<{ id: string; type: PmdbListType }>> {
  const keyHash = createHash('sha256').update(apiKey).digest('hex').substring(0, 16);
  const ttl = parseInt(process.env.PUBLICMETADB_LISTS_TTL || '3600', 10);
  const kinds: Array<{ id: string; type: PmdbListType }> = await cacheWrapGlobal(`publicmetadb:list-kinds:${keyHash}`, async () =>
    (await fetchAllLists(apiKey))
      .map((list: any) => ({ id: list?.id, type: asListType(list?.type) }))
      .filter((k: any): k is { id: string; type: PmdbListType } => Boolean(k.id && k.type)),
  ttl);
  return kinds ?? [];
}

async function resolveListType(apiKey: string, listId: string): Promise<PmdbListType | null> {
  return (await listKinds(apiKey)).find((k) => k.id === listId)?.type ?? null;
}

async function publicMetaDBListType(config: any, catalogId: string): Promise<PmdbListType | null> {
  if (!catalogId.startsWith('publicmetadb.list.')) return null;
  const catalog = config?.catalogs?.find((c: any) => c.id === catalogId);
  const known = asListType(catalog?.metadata?.listType);
  if (known) return known;
  const apiKey = config?.apiKeys?.publicmetadb;
  if (!apiKey) return null;
  try {
    return await resolveListType(apiKey, catalogId.slice('publicmetadb.list.'.length));
  } catch {
    return null;
  }
}

const WATCHLIST_CATALOG_ID = 'publicmetadb.watchlist';

async function accountWatchlistId(config: any): Promise<string | null> {
  if (config?.jellyfinAccounts) return config.jellyfinAccounts.publicmetadbWatchlist ? String(config.jellyfinAccounts.publicmetadbWatchlist) : null;
  const apiKey = config?.apiKeys?.publicmetadb;
  if (!apiKey) return null;
  try {
    const found = (await listKinds(apiKey)).find((k) => k.type === 'watchlist');
    return found ? String(found.id) : null;
  } catch (error: any) {
    logger.warn(`Could not find the PublicMetaDB watchlist: ${error?.message || error}`);
    return null;
  }
}

async function publicMetaDBListId(config: any, catalogId: string): Promise<string | null> {
  if (catalogId === WATCHLIST_CATALOG_ID) return accountWatchlistId(config);
  const { pmdbListIdFor } = require('../lib/accounts');
  return pmdbListIdFor(config, catalogId);
}

async function publicMetaDBWatchlistCatalog(config: any): Promise<any | null> {
  const lists = (config?.catalogs ?? []).filter((c: any) => typeof c?.id === 'string' && c.id.startsWith('publicmetadb.list.'));
  const known = lists.find((c: any) => c?.metadata?.listType === 'watchlist');
  if (known) return known;
  for (const catalog of lists) {
    if (catalog?.metadata?.listType) continue;
    if ((await publicMetaDBListType(config, catalog.id)) === 'watchlist') return catalog;
  }
  return (await accountWatchlistId(config)) ? { id: WATCHLIST_CATALOG_ID, type: 'all' } : null;
}

async function setListItem(apiKey: string, listId: string, tmdbId: number | string, mediaType: 'movie' | 'tv', listed: boolean): Promise<void> {
  if (listed) {
    await makeRequest(`/api/external/lists/${listId}/items`, apiKey, 'POST', { tmdb_id: Number(tmdbId), media_type: mediaType });
    return;
  }
  for (let page = 1; page <= 20; page++) {
    const data = await fetchListItems(apiKey, listId, page, 500);
    const item = (data.items || []).find((i: any) => String(i?.tmdb_id) === String(tmdbId) && i?.media_type === mediaType);
    if (item?.id) {
      await makeRequest(`/api/external/lists/${listId}/items/${item.id}`, apiKey, 'DELETE');
      return;
    }
    if (page >= (data.totalPages || 1)) return;
  }
}

async function fetchListItems(apiKey: string, listId: string, page: number = 1, perPage: number = 20): Promise<any> {
  return makeRequest(`/api/external/lists/${listId}/items?page=${page}&perPage=${perPage}`, apiKey);
}

async function fetchPublicListByLink(apiKey: string, user: string, slug: string, page: number = 1, perPage: number = 20): Promise<any> {
  return makeRequest(`/api/external/lists/u/${encodeURIComponent(user)}/${encodeURIComponent(slug)}/items?page=${page}&perPage=${perPage}`, apiKey);
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
  episode?: number,
  watchedAt?: string | null
): Promise<any> {
  const body: any = { tmdb_id: tmdbId, media_type: mediaType, ...(watchedAt !== undefined ? { watched_at: watchedAt } : {}) };
  if (mediaType === 'tv' && season != null && episode != null) {
    body.season = season;
    body.episode = episode;
  }
  return makeRequest('/api/external/watched?dedupe=true', apiKey, 'POST', body);
}

async function setWatchedDate(apiKey: string, playId: string, watchedAt: string): Promise<any> {
  return makeRequest(`/api/external/watched/${encodeURIComponent(playId)}`, apiKey, 'PATCH', { watched_at: watchedAt });
}

async function removePlay(apiKey: string, playId: string): Promise<any> {
  return makeRequest(`/api/external/watched/${encodeURIComponent(playId)}`, apiKey, 'DELETE');
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

export interface PmdbPlaybackOptions {
  /** Omitted, this stays the immediate mark-watched the subtitle trigger sends. */
  action?: 'watched' | 'stop' | 'unwatch';
  /** Whether the sender judged it finished. Only meaningful with action 'stop'. */
  played?: boolean;
  positionMs?: number;
  runtimeMs?: number;
  watchedAt?: string | null;
}

async function createRating(apiKey: string, tmdbId: number, mediaType: 'movie' | 'tv', score: number): Promise<string | null> {
  const data = await makeRequest('/api/external/ratings', apiKey, 'POST', { tmdb_id: tmdbId, media_type: mediaType, score, label: 'Overall' });
  return data?.item?.id ? String(data.item.id) : null;
}

async function deleteRating(apiKey: string, id: string): Promise<void> {
  await makeRequest(`/api/external/ratings/${encodeURIComponent(id)}`, apiKey, 'DELETE');
}

async function createEpisodeRating(apiKey: string, tmdbId: number, season: number, episode: number, score: number): Promise<string | null> {
  const data = await makeRequest('/api/external/episode-ratings', apiKey, 'POST', { tmdb_id: tmdbId, media_type: 'tv', season, episode, score, label: 'overall' });
  return data?.item?.id ? String(data.item.id) : null;
}

async function ratingsOf(apiKey: string, path: string): Promise<any[]> {
  const data = await makeRequest(path, apiKey);
  return Array.isArray(data?.items) ? data.items : [];
}

async function fetchTitleRatings(apiKey: string, tmdbId: number, mediaType: 'movie' | 'tv'): Promise<any[]> {
  return ratingsOf(apiKey, `/api/external/ratings?tmdb_id=${tmdbId}&media_type=${mediaType}&label=Overall`);
}

async function fetchEpisodeRatings(apiKey: string, tmdbId: number, season: number, episode: number): Promise<any[]> {
  return ratingsOf(apiKey, `/api/external/episode-ratings?tmdb_id=${tmdbId}&media_type=tv&season=${season}&episode=${episode}&label=overall`);
}

async function deleteEpisodeRating(apiKey: string, id: string): Promise<void> {
  await makeRequest(`/api/external/episode-ratings/${encodeURIComponent(id)}`, apiKey, 'DELETE');
}

// Each mark-watched creates a play rather than setting a flag, so unmarking
// deletes them all: removing one by record id would leave a rewatch behind.
async function removeWatched(
  apiKey: string,
  tmdbId: number,
  mediaType: 'movie' | 'tv',
  season?: number,
  episode?: number
): Promise<any> {
  const params = new URLSearchParams({ tmdb_id: String(tmdbId), media_type: mediaType });
  if (mediaType === 'tv' && season != null && episode != null) {
    params.set('season', String(season));
    params.set('episode', String(episode));
  }
  return makeRequest(`/api/external/watched?${params.toString()}`, apiKey, 'DELETE');
}

/**
 * Saves a playback position. Under 2% is ignored by the server, and at 80% or
 * above the resume point is deleted and `action: 'completed'` comes back, which
 * is a prompt to mark it watched rather than the server having done so.
 */
async function saveResume(
  apiKey: string,
  tmdbId: number,
  mediaType: 'movie' | 'tv',
  positionMs: number,
  runtimeMs: number,
  season?: number,
  episode?: number
): Promise<any> {
  // A film's point is stored under season 0, episode 0, and only matches an
  // existing one when both are sent; left out, a second save is a duplicate.
  const body: any = {
    tmdb_id: tmdbId,
    media_type: mediaType,
    season: mediaType === 'tv' && season != null ? season : 0,
    episode: mediaType === 'tv' && episode != null ? episode : 0,
    position_ms: Math.max(0, Math.round(positionMs)),
    runtime_ms: Math.max(1, Math.round(runtimeMs)),
  };
  return makeRequest('/api/external/resume', apiKey, 'POST', body);
}

/**
 * A stop saves the position; only one the sender called played is also marked
 * watched. Without options this is the old behaviour, which marks watched the
 * moment a title is opened.
 */
async function reportPlayback(
  apiKey: string,
  tmdbId: number,
  mediaType: 'movie' | 'tv',
  options: PmdbPlaybackOptions,
  season?: number,
  episode?: number
): Promise<boolean> {
  if (options.action === 'unwatch') {
    const result = await removeWatched(apiKey, tmdbId, mediaType, season, episode);
    logger.info(`[Watch Tracking] Cleared ${result?.deleted ?? 0} play(s): tmdb:${tmdbId}`);
    return result?.success !== false;
  }

  if (options.action === 'stop') {
    const position = options.positionMs ?? 0;
    const runtime = options.runtimeMs ?? 0;
    if (runtime > 0) {
      const result = await saveResume(apiKey, tmdbId, mediaType, position, runtime, season, episode);
      logger.debug(`[Watch Tracking] Resume point ${result?.action ?? 'sent'} for tmdb:${tmdbId}`);
    }
    if (!options.played) return true;
  }

  const result = await markWatched(apiKey, tmdbId, mediaType, season, episode, options.watchedAt);
  return !!result?.success;
}

async function checkinMovie(
  ids: Record<string, any>,
  apiKey: string,
  options: PmdbPlaybackOptions = {}
): Promise<boolean> {
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

    const ok = await reportPlayback(apiKey, tmdbId, 'movie', options);
    if (!ok) {
      logger.warn(`[Watch Tracking] Movie watch not confirmed: tmdb:${tmdbId}`);
      return false;
    }
    logger.info(`[Watch Tracking] Movie reported: tmdb:${tmdbId}`);
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
  apiKey: string,
  options: PmdbPlaybackOptions = {}
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

    const ok = await reportPlayback(apiKey, tmdbId, 'tv', options, season, episode);
    if (!ok) {
      logger.warn(`[Watch Tracking] Episode watch not confirmed: tmdb:${tmdbId} S${season}E${episode}`);
      return false;
    }
    logger.info(`[Watch Tracking] Episode reported: tmdb:${tmdbId} S${season}E${episode}`);
    return true;
  } catch (err: any) {
    logger.error(`[Watch Tracking] Episode tracking failed: ${err.message}`);
    return false;
  }
}

function getMemoryStats() {
  return { rateLimitStates: rateLimitStates.size };
}

export interface PmdbSkip {
  intro_start_ms?: number | null;
  intro_end_ms?: number | null;
  credits_start_ms?: number | null;
  credits_end_ms?: number | null;
  source?: string;
}

async function fetchSkips(
  apiKey: string,
  query: { tmdbId: string | number; mediaType: 'movie' | 'tv'; season?: number | null; episode?: number | null }
): Promise<PmdbSkip[]> {
  const params = new URLSearchParams({ tmdb_id: String(query.tmdbId), media_type: query.mediaType });
  if (query.mediaType === 'tv') {
    if (query.season !== null && query.season !== undefined) params.set('season', String(query.season));
    if (query.episode !== null && query.episode !== undefined) params.set('episode', String(query.episode));
  }
  const data = await makeRequest(`/api/external/skips?${params.toString()}`, apiKey);
  return Array.isArray(data?.items) ? data.items : [];
}

export {
  globalThrottle as throttlePublicMetaDb,
  validateKey,
  fetchSkips,
  fetchResume,
  fetchDropped,
  fetchWatched,
  setWatchedDate,
  removePlay,
  saveResume,
  clearResume,
  tmdbIdFrom,
  removeWatched,
  createRating,
  deleteRating,
  createEpisodeRating,
  deleteEpisodeRating,
  fetchTitleRatings,
  fetchEpisodeRatings,
  fetchLists,
  fetchListItems,
  fetchPublicListByLink,
  publicMetaDBListType,
  publicMetaDBWatchlistCatalog,
  publicMetaDBListId,
  WATCHLIST_CATALOG_ID,
  setListItem,
  setDropped,
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
