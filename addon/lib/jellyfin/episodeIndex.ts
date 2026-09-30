import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import redis from '../redisClient';
import type { ContentRating } from '../../utils/contentRating';

/**
 * What the episode builders read from a series meta, and nothing else, so a
 * shelf that walks many shows does not rebuild each full meta to find one
 * episode. Shaped like the meta so the builders take it unchanged.
 */
export interface SeriesIndex {
  id: string;
  name: string;
  type?: string;
  posterShape?: string;
  imdb_id?: string;
  _imdbId?: string;
  _tmdbId?: string | number;
  _tvdbId?: string | number;
  _malId?: string | number;
  _kitsuId?: string | number;
  _anilistId?: string | number;
  _anidbId?: string | number;
  poster?: string | null;
  background?: string | null;
  logo?: string | null;
  landscapePoster?: string | null;
  app_extras?: { certification?: string | null; certificationLocal?: string | null; contentRating?: ContentRating | null };
  videos: Array<{
    id: string;
    season: number | null;
    episode: number;
    title?: string;
    overview?: string;
    released?: string | null;
    runtime?: string | number | null;
    thumbnail?: string | null;
  }>;
}

function ttlSeconds(): number {
  return envInt('JELLYFIN_EPISODE_INDEX_TTL', 6 * 60 * 60, 60);
}

function approximateBytes(index: SeriesIndex): number {
  let bytes = 512;
  for (const video of index.videos) {
    bytes += 64 + video.id.length + (video.title?.length ?? 0) + (video.overview?.length ?? 0) + (video.thumbnail?.length ?? 0);
  }
  return bytes;
}

const memory = new LRUCache<string, SeriesIndex>({
  max: envInt('JELLYFIN_EPISODE_INDEX_MAX', 1000, 1),
  maxSize: envInt('JELLYFIN_EPISODE_INDEX_MEMORY_MB', 64, 1) * 1024 * 1024,
  sizeCalculation: approximateBytes,
  ttl: ttlSeconds() * 1000,
});

const ID_FIELDS = ['imdb_id', '_imdbId', '_tmdbId', '_tvdbId', '_malId', '_kitsuId', '_anilistId', '_anidbId'] as const;

async function configFor(userUUID: string): Promise<any | null> {
  return require('../configApi').loadSharedConfig(userUUID).catch(() => null);
}

function metaHash(config: any, metaId: string): string {
  const { getMetaSmartLockContextHash } = require('../getCache');
  return getMetaSmartLockContextHash(config, metaId, 'series', true, false);
}

function sharedKey(config: any, metaId: string): string {
  return `jf:epx:v2:${metaHash(config, metaId)}:${metaId}`;
}

function memoryKey(userUUID: string, config: any, metaId: string): string {
  return `${userUUID}:${metaHash(config, metaId)}:${metaId}`;
}

function trim(meta: any): SeriesIndex {
  const videos = Array.isArray(meta?.videos) ? meta.videos : [];
  const ids: Record<string, string | number> = {};
  for (const field of ID_FIELDS) if (meta?.[field]) ids[field] = meta[field];
  return {
    id: String(meta.id),
    name: meta.name,
    ...(meta.type ? { type: String(meta.type) } : {}),
    ...(meta.posterShape ? { posterShape: String(meta.posterShape) } : {}),
    ...ids,
    ...(meta.poster ? { poster: String(meta.poster) } : {}),
    ...(meta.background ? { background: String(meta.background) } : {}),
    ...(meta.logo ? { logo: String(meta.logo) } : {}),
    ...(meta.landscapePoster ? { landscapePoster: String(meta.landscapePoster) } : {}),
    ...(meta.app_extras ? { app_extras: {
      certification: meta.app_extras.certification,
      certificationLocal: meta.app_extras.certificationLocal,
      ...(Object.prototype.hasOwnProperty.call(meta.app_extras, 'contentRating') ? { contentRating: meta.app_extras.contentRating } : {}),
    } } : {}),
    videos: videos.map((video: any) => ({
      id: String(video?.id ?? ''),
      season: Number.isInteger(video?.season) ? video.season : null,
      episode: Number(video?.episode),
      ...(video?.title ? { title: video.title } : {}),
      ...(video?.overview ? { overview: video.overview } : {}),
      ...(video?.released ? { released: video.released } : {}),
      ...(video?.runtime ? { runtime: video.runtime } : {}),
      ...(video?.thumbnail ? { thumbnail: video.thumbnail } : {}),
    })),
  };
}

function withArt(shared: SeriesIndex, config: any): SeriesIndex {
  const { applyMetaArt } = require('../metaArt');
  const index = { ...shared, videos: shared.videos.map((video) => ({ ...video })) };
  applyMetaArt(index, config, 'series', '');
  return index;
}

/** Keeps the index of a series meta read for another reason, so a listing finds it held. */
export function rememberSeriesIndex(userUUID: string, metaId: string, meta: any): void {
  if (!meta || !Array.isArray(meta.videos)) return;
  void configFor(userUUID).then((config) => {
    if (!config) return;
    const key = memoryKey(userUUID, config, metaId);
    if (!memory.has(key)) memory.set(key, trim(meta));
  });
}

async function build(userUUID: string, config: any, metaId: string): Promise<SeriesIndex | null> {
  const { fetchMetaBeforeArt } = require('./items');
  const meta = await fetchMetaBeforeArt(userUUID, 'series', metaId);
  if (!meta) return null;
  const shared = trim(meta);
  if (redis) {
    redis.set(sharedKey(config, metaId), JSON.stringify(shared), 'EX', ttlSeconds()).catch(() => undefined);
  }
  const index = withArt(shared, config);
  memory.set(memoryKey(userUUID, config, metaId), index);
  return index;
}

/** The series' episodes as this configuration publishes them; fetched once per TTL. With `held`, only what is already stored. */
export async function seriesIndex(userUUID: string, metaId: string, opts: { held?: boolean } = {}): Promise<SeriesIndex | null> {
  const config = await configFor(userUUID);
  if (!config) return null;
  const key = memoryKey(userUUID, config, metaId);
  const held = memory.get(key);
  if (held) return held;
  if (redis) {
    try {
      const stored = await redis.get(sharedKey(config, metaId));
      if (stored) {
        const index = withArt(JSON.parse(stored) as SeriesIndex, config);
        memory.set(key, index);
        return index;
      }
    } catch {
      // fall through to a fresh build
    }
  }
  if (opts.held) return null;
  return build(userUUID, config, metaId);
}

/** Warms the memory copy for many shows in one Redis read; misses are left for seriesIndex to build. */
export async function warmSeriesIndex(userUUID: string, metaIds: string[]): Promise<void> {
  if (!redis) return;
  const config = await configFor(userUUID);
  if (!config) return;
  const wanted = [...new Set(metaIds)].filter((id) => !memory.has(memoryKey(userUUID, config, id)));
  if (!wanted.length) return;
  try {
    const stored: Array<string | null> = await redis.mget(...wanted.map((id) => sharedKey(config, id)));
    stored.forEach((value, i) => {
      if (!value) return;
      try {
        memory.set(memoryKey(userUUID, config, wanted[i]), withArt(JSON.parse(value) as SeriesIndex, config));
      } catch {
        // a bad entry is rebuilt on read
      }
    });
  } catch {
    // Redis unavailable: each show is read on its own
  }
}

/** The same, read again from the meta: for an episode the tracker names that the held index lacks. */
export async function refreshSeriesIndex(userUUID: string, metaId: string): Promise<SeriesIndex | null> {
  const config = await configFor(userUUID);
  return config ? build(userUUID, config, metaId) : null;
}

/** Builds whatever the Next Up candidates of a configuration lack, off the request path. */
export async function warmNextUpIndex(userUUID: string, config: any): Promise<number> {
  const { watchedSnapshot, ownNextUpRows } = require('./watched');
  const { profileKey } = require('./profiles');
  const { mapWithConcurrency } = require('../../utils/concurrency');
  const snapshot = await watchedSnapshot(userUUID, config, { patient: true });
  const own = await ownNextUpRows(userUUID, profileKey(config));
  const metaIds = [...new Set([...own, ...snapshot.nextUp].map((row: any) => String(row.metaId)))];
  await warmSeriesIndex(userUUID, metaIds);
  const stored = await configFor(userUUID);
  if (!stored) return 0;
  const missing = metaIds.filter((id) => !memory.has(memoryKey(userUUID, stored, id)));
  await mapWithConcurrency(missing, envInt('JELLYFIN_SHELF_META_CONCURRENCY', 4, 1), (id: string) => build(userUUID, stored, id).catch(() => null));
  return missing.length;
}
