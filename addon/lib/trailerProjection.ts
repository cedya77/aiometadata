// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { createHash } from 'crypto';
import { httpGet } from '../utils/httpClient';
import { envInt } from '../utils/envNumber';
import { mapWithConcurrency } from '../utils/concurrency';
import { withGlobalEpoch } from './cacheEpoch';
import { decodeCachePayload, encodeCachePayload } from './cacheCodec';
const redis: any = require('./redisClient');
const consola: any = require('consola');

const logger = consola.withTag('Trailer-Addon');

const MANIFEST_FILE = 'manifest.json';
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const HTTP_URL = /^https?:\/\//i;
/** A link that expires is dropped from the cache this long before it does. */
const EXPIRY_MARGIN_SECONDS = 5 * 60;
const MIN_TTL_SECONDS = 60;

interface AddonTrailer {
  title: string;
  ytId?: string;
  url?: string;
}

type AddonResource = 'stream' | 'meta';

interface TitleTarget {
  type: 'movie' | 'series';
  imdbId: string;
}

type Fetched =
  | { outcome: 'ok'; data: any }
  /** The addon said it has nothing at this address. */
  | { outcome: 'missing' }
  /** It answered, but not with JSON. */
  | { outcome: 'odd' }
  | { outcome: 'failed' };

function requestTimeoutMs(): number {
  return envInt('TRAILER_ADDON_TIMEOUT_MS', 5000, 1);
}

function answerTtl(): number {
  return envInt('TRAILER_ADDON_TTL', 86400, MIN_TTL_SECONDS);
}

function emptyAnswerTtl(): number {
  return envInt('TRAILER_ADDON_EMPTY_TTL', 86400, MIN_TTL_SECONDS);
}

function catalogWaitMs(): number {
  return envInt('TRAILER_ADDON_CATALOG_WAIT_MS', 1500, 0);
}

function warmConcurrency(): number {
  return envInt('TRAILER_ADDON_WARM_CONCURRENCY', 4, 1);
}

/** The manifest URL of the config's trailer addon, or null when it takes trailers from the metadata provider. */
function trailerAddonManifestUrl(config: any): string | null {
  if (config?.trailerProvider !== 'addon') return null;
  const url = typeof config.trailerAddonUrl === 'string' ? config.trailerAddonUrl.trim() : '';
  if (!HTTP_URL.test(url) || !url.endsWith(`/${MANIFEST_FILE}`)) return null;
  return url;
}

function usesTrailerAddon(config: any): boolean {
  return trailerAddonManifestUrl(config) !== null;
}

function addonHash(manifestUrl: string): string {
  return createHash('sha1').update(manifestUrl).digest('hex').slice(0, 12);
}

function resourceCacheKey(hash: string): string {
  return withGlobalEpoch(`trailer-addon:resource:${hash}`);
}

function titleCacheKey(hash: string, target: TitleTarget): string {
  return withGlobalEpoch(`trailer-addon:title:${hash}:${target.type}:${target.imdbId}`);
}

function resourceUrl(manifestUrl: string, resource: AddonResource, target: TitleTarget): string {
  const base = manifestUrl.slice(0, -MANIFEST_FILE.length);
  return `${base}${resource}/${target.type}/${encodeURIComponent(target.imdbId)}.json`;
}

function titleTargetOf(meta: any): TitleTarget | null {
  if (!meta || typeof meta !== 'object') return null;
  let imdbId: string | null = null;
  for (const candidate of [meta.imdb_id, meta._imdbId]) {
    if (typeof candidate === 'string' && /^tt\d+$/.test(candidate)) {
      imdbId = candidate;
      break;
    }
  }
  if (!imdbId && typeof meta.id === 'string') imdbId = meta.id.match(/^tt\d+/)?.[0] || null;
  if (!imdbId) return null;
  const type = meta.type === 'movie' || meta.type === 'anime.movie' ? 'movie' : 'series';
  return { type, imdbId };
}

const inFlight = new Map<string, Promise<any>>();

function shared<T>(key: string, work: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key);
  if (running) return running;
  const started: Promise<T> = Promise.resolve()
    .then(work)
    .finally(() => {
      if (inFlight.get(key) === started) inFlight.delete(key);
    });
  inFlight.set(key, started);
  return started;
}

async function readCached(key: string): Promise<any> {
  if (!redis) return null;
  try {
    const stored = await redis.getBuffer(key);
    return stored ? await decodeCachePayload(stored) : null;
  } catch {
    return null;
  }
}

async function writeCached(key: string, value: any, ttl: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(key, await encodeCachePayload(value), 'EX', ttl);
  } catch (error: any) {
    logger.warn(`Could not store ${key}: ${error?.message}`);
  }
}

async function fetchJson(url: string): Promise<Fetched> {
  const limit = requestTimeoutMs();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${limit}ms`)), limit);
  });
  const request = httpGet(url, { timeout: limit, headers: { Accept: 'application/json' } });
  // Still settles after the deadline has won the race.
  request.catch(() => {});

  try {
    const response = await Promise.race([request, deadline]);
    let data = response.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        return { outcome: 'odd' };
      }
    }
    return { outcome: 'ok', data };
  } catch (error: any) {
    if (error?.response?.status === 404) return { outcome: 'missing' };
    logger.debug(`Request failed: ${error?.message}`);
    return { outcome: 'failed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function offersStreams(manifest: any): boolean {
  if (!Array.isArray(manifest?.resources)) return false;
  return manifest.resources.some((entry: any) => (typeof entry === 'string' ? entry : entry?.name) === 'stream');
}

/** Which resource the addon is asked for; null when its manifest could not be read this time. */
async function resourceOf(manifestUrl: string, hash: string): Promise<AddonResource | null> {
  const key = resourceCacheKey(hash);
  return shared(key, async () => {
    const cached = await readCached(key);
    if (cached?.resource === 'stream' || cached?.resource === 'meta') return cached.resource as AddonResource;

    const fetched = await fetchJson(manifestUrl);
    if (fetched.outcome === 'failed') return null;
    const resource: AddonResource = fetched.outcome === 'ok' && offersStreams(fetched.data) ? 'stream' : 'meta';
    await writeCached(key, { resource }, answerTtl());
    return resource;
  });
}

function textOf(...candidates: any[]): string {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const text = candidate.trim();
    if (text) return text;
  }
  return '';
}

function toTrailer(title: string, ytId: any, url: any): AddonTrailer | null {
  const name = title || 'Trailer';
  if (typeof ytId === 'string' && YOUTUBE_ID.test(ytId.trim())) return { title: name, ytId: ytId.trim() };
  if (typeof url === 'string' && HTTP_URL.test(url.trim())) return { title: name, url: url.trim() };
  return null;
}

function trailersFromEntries(entries: any): AddonTrailer[] {
  if (!Array.isArray(entries)) return [];
  const trailers: AddonTrailer[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const trailer = toTrailer(textOf(entry.title, entry.name), entry.ytId, entry.url);
    if (trailer) trailers.push(trailer);
  }
  return trailers;
}

function trailersFromMeta(meta: any): AddonTrailer[] {
  if (!meta || typeof meta !== 'object') return [];
  const trailers = trailersFromEntries(meta.trailerStreams);
  for (const link of Array.isArray(meta.links) ? meta.links : []) {
    if (!link || typeof link !== 'object') continue;
    const trailer = toTrailer(textOf(link.title, link.provider, link.name), undefined, link.trailers);
    if (trailer) trailers.push(trailer);
  }
  if (trailers.length) return trailers;

  for (const entry of Array.isArray(meta.trailers) ? meta.trailers : []) {
    if (!entry || typeof entry !== 'object') continue;
    const trailer = toTrailer(textOf(entry.title, entry.name), entry.source ?? entry.ytId, undefined);
    if (trailer) trailers.push(trailer);
  }
  return trailers;
}

/** Seconds an answer may be kept: the configured lifetime, cut short of the first link to expire. */
function lifetimeOf(trailers: AddonTrailer[]): number {
  let ttl = answerTtl();
  const now = Math.floor(Date.now() / 1000);
  for (const trailer of trailers) {
    if (!trailer.url) continue;
    let expire: string | null = null;
    try {
      expire = new URL(trailer.url).searchParams.get('expire');
    } catch {
      continue;
    }
    if (!expire || !/^\d+$/.test(expire)) continue;
    const usable = Number(expire) - now - EXPIRY_MARGIN_SECONDS;
    ttl = Math.min(ttl, Math.max(MIN_TTL_SECONDS, usable));
  }
  return ttl;
}

/** Asks the addon and stores what it said. Null when it gave no answer this time, and then nothing is stored. */
async function fetchTitleTrailers(manifestUrl: string, hash: string, target: TitleTarget): Promise<AddonTrailer[] | null> {
  const resource = await resourceOf(manifestUrl, hash);
  if (!resource) return null;

  const fetched = await fetchJson(resourceUrl(manifestUrl, resource, target));
  if (fetched.outcome === 'failed' || fetched.outcome === 'odd') return null;

  let trailers: AddonTrailer[] = [];
  if (fetched.outcome === 'ok') {
    trailers = resource === 'stream' ? trailersFromEntries(fetched.data?.streams) : trailersFromMeta(fetched.data?.meta);
  }
  await writeCached(titleCacheKey(hash, target), { trailers }, trailers.length ? lifetimeOf(trailers) : emptyAnswerTtl());
  return trailers;
}

/** The addon's trailers for a title, from the cache when it holds them. Null when there is no answer to go by. */
async function trailersFor(manifestUrl: string, target: TitleTarget): Promise<AddonTrailer[] | null> {
  const hash = addonHash(manifestUrl);
  const key = titleCacheKey(hash, target);
  try {
    return await shared(key, async () => {
      const cached = await readCached(key);
      if (Array.isArray(cached?.trailers)) return cached.trailers as AddonTrailer[];
      return fetchTitleTrailers(manifestUrl, hash, target);
    });
  } catch (error: any) {
    logger.debug(`Lookup failed for ${target.imdbId}: ${error?.message}`);
    return null;
  }
}

function setTrailers(meta: any, trailers: AddonTrailer[] | null): void {
  if (!trailers || trailers.length === 0) return;
  meta.trailerStreams = trailers.map((trailer) => ({ ...trailer }));
  const youtube = trailers.filter((trailer) => trailer.ytId);
  if (youtube.length) {
    meta.trailers = youtube.map((trailer) => ({ source: trailer.ytId, type: 'Trailer', name: trailer.title }));
  }
}

/**
 * Applied as the meta goes out, never to what is cached: the cached components
 * are shared by every config, and only some of them name a trailer addon.
 */
async function applyAddonTrailersProjection(meta: any, config: any): Promise<any> {
  const manifestUrl = trailerAddonManifestUrl(config);
  if (!manifestUrl) return meta;
  const target = titleTargetOf(meta);
  if (!target) return meta;
  setTrailers(meta, await trailersFor(manifestUrl, target));
  return meta;
}

/**
 * A page waits only so long for the addon. Titles still unanswered keep the
 * provider's trailer in this response; their lookups carry on and fill the cache.
 */
async function applyAddonTrailersToList(metas: any[], config: any): Promise<any[]> {
  const manifestUrl = trailerAddonManifestUrl(config);
  if (!manifestUrl || !Array.isArray(metas) || metas.length === 0) return metas;

  let open = true;
  const lookups: Promise<void>[] = [];
  for (const meta of metas) {
    const target = titleTargetOf(meta);
    if (!target) continue;
    lookups.push(trailersFor(manifestUrl, target).then((trailers) => {
      if (open) setTrailers(meta, trailers);
    }));
  }
  if (lookups.length === 0) return metas;

  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, catalogWaitMs());
  });
  await Promise.race([Promise.all(lookups), waited]);
  if (timer) clearTimeout(timer);
  open = false;
  return metas;
}

/**
 * Re-asks the addon for the titles whose cached answer is missing or would
 * lapse before `nextRunAt` (epoch ms). Returns how many answers were fetched.
 */
async function warmAddonTrailers(metas: any[], config: any, nextRunAt: number): Promise<number> {
  const manifestUrl = trailerAddonManifestUrl(config);
  if (!manifestUrl || !redis || !Array.isArray(metas) || metas.length === 0) return 0;

  const hash = addonHash(manifestUrl);
  const targets = new Map<string, TitleTarget>();
  for (const meta of metas) {
    const target = titleTargetOf(meta);
    if (target) targets.set(titleCacheKey(hash, target), target);
  }
  if (targets.size === 0) return 0;

  const keys = [...targets.keys()];
  let due: string[];
  try {
    const replies = await redis.pipeline(keys.map((key) => ['pttl', key])).exec();
    const readAt = Date.now();
    due = keys.filter((_key, index) => {
      const [error, remaining] = replies?.[index] || [];
      if (error) throw error;
      // -1 is a key that never expires, -2 one that is not there.
      const lasts = remaining === -1 || (typeof remaining === 'number' && remaining > 0 && readAt + remaining > nextRunAt);
      return !lasts;
    });
  } catch (error: any) {
    logger.warn(`Could not read trailer lifetimes, warming none: ${error?.message}`);
    return 0;
  }
  if (due.length === 0) return 0;

  const width = warmConcurrency();
  // An addon that has stopped answering is not asked for the rest of the page.
  let unanswered = 0;
  const answered = await mapWithConcurrency(due, width, async (key) => {
    if (unanswered >= width * 2) return false;
    const target = targets.get(key) as TitleTarget;
    const trailers = await shared(`refresh:${key}`, () => fetchTitleTrailers(manifestUrl, hash, target)).catch(() => null);
    if (trailers === null) {
      unanswered++;
      return false;
    }
    unanswered = 0;
    return true;
  });
  return answered.filter(Boolean).length;
}

export {
  applyAddonTrailersProjection,
  applyAddonTrailersToList,
  warmAddonTrailers,
  usesTrailerAddon,
};
module.exports = {
  applyAddonTrailersProjection,
  applyAddonTrailersToList,
  warmAddonTrailers,
  usesTrailerAddon,
};
