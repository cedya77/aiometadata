import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { createHash } from 'crypto';
import { envInt } from '../../utils/envNumber';
import { credentialFor, sourceFor } from './trackerSource';
import { videoIdFor } from './resume';

const logger = consola.withTag('Jellyfin');

export interface NextUpRow {
  metaId: string;
  /** Set when the tracker names the episode exactly, as anime does. */
  videoId: string | null;
  season: number | null;
  episode: number;
  mediaType: 'anime' | 'series';
  lastWatchedAt: number;
}

export interface WatchedSnapshot {
  /** Video ids in the space the meta publishes, e.g. `kitsu:49002:11`. */
  episodes: Set<string>;
  /** Base ids of watched films. */
  movies: Set<string>;
  /** Watched and total episode counts, keyed by every id the series answers to. */
  series: Map<string, { watched: number; total: number }>;
  nextUp: NextUpRow[];
  fingerprint: string;
}

const EMPTY: WatchedSnapshot = {
  episodes: new Set(),
  movies: new Set(),
  series: new Map(),
  nextUp: [],
  fingerprint: '',
};

// The raw lists live in Redis keyed by the activities digest, the way the
// watched-id lookup already does it, so a refetch happens when Simkl says
// something changed rather than on a timer. Only the hydrated sets are held
// per process, keyed by that same digest.
const hydrated = new LRUCache<string, WatchedSnapshot>({
  max: envInt('JELLYFIN_WATCHED_CACHE_MAX', 200, 1),
  ttl: envInt('JELLYFIN_WATCHED_TTL', 3600, 1) * 1000,
});

/** Every id a series might be addressed by, so a lookup needs no id space. */
function seriesKeys(ids: Record<string, any>): string[] {
  const keys: string[] = [];
  if (ids.imdb) keys.push(String(ids.imdb));
  if (ids.kitsu) keys.push(`kitsu:${ids.kitsu}`);
  if (ids.mal) keys.push(`mal:${ids.mal}`);
  if (ids.anilist) keys.push(`anilist:${ids.anilist}`);
  if (ids.tvdb) keys.push(`tvdb:${ids.tvdb}`);
  if (ids.tmdb) keys.push(`tmdb:${ids.tmdb}`);
  return keys;
}

// `next_to_watch` is `S02E09` for a show and a bare `E6` for anime, which is
// the absolute numbering its own entry uses.
function parseNextToWatch(value: any): { season: number | null; episode: number } | null {
  const text = String(value ?? '').trim();
  const seasoned = /^S(\d+)E(\d+)$/i.exec(text);
  if (seasoned) return { season: Number(seasoned[1]), episode: Number(seasoned[2]) };

  const absolute = /^E(\d+)$/i.exec(text);
  if (absolute) return { season: null, episode: Number(absolute[1]) };

  return null;
}

function collectShow(entry: any, snapshot: WatchedSnapshot, isAnime: boolean): void {
  const ids = entry?.show?.ids ?? {};
  const keys = seriesKeys(ids);

  const next = parseNextToWatch(entry?.next_to_watch);
  if (next) {
    const metaId = isAnime && ids.kitsu
      ? `kitsu:${ids.kitsu}`
      : (ids.imdb ? String(ids.imdb) : ids.tvdb ? `tvdb:${ids.tvdb}` : null);
    if (metaId) {
      snapshot.nextUp.push({
        metaId,
        videoId: isAnime && ids.kitsu ? `kitsu:${ids.kitsu}:${next.episode}` : null,
        season: next.season,
        episode: next.episode,
        mediaType: isAnime && ids.kitsu ? 'anime' : 'series',
        lastWatchedAt: Date.parse(entry?.last_watched_at ?? '') || 0,
      });
    }
  }

  const counts = {
    watched: Number(entry?.watched_episodes_count) || 0,
    total: Number(entry?.total_episodes_count) || 0,
  };
  for (const key of keys) snapshot.series.set(key, counts);

  // An anime entry is numbered inside itself, which is how a catalog keyed on
  // kitsu publishes it. The same show keyed on IMDb or TVDB is split into
  // broadcast seasons, and which one a user sees depends on their providers, so
  // a watch is registered under both rather than only the one Simkl counts in.
  const seasoned = [ids.imdb, ids.tvdb ? `tvdb:${ids.tvdb}` : null].filter(Boolean).map(String);
  const absolute = isAnime && ids.kitsu ? `kitsu:${ids.kitsu}` : null;

  if (!seasoned.length && !absolute) return;

  for (const season of Array.isArray(entry?.seasons) ? entry.seasons : []) {
    for (const episode of Array.isArray(season?.episodes) ? season.episodes : []) {
      const number = Number(episode?.number);
      if (!Number.isFinite(number)) continue;

      if (absolute) snapshot.episodes.add(`${absolute}:${number}`);

      if (!seasoned.length) continue;

      // Anime episodes carry the broadcast numbering the other id spaces use,
      // which is not the numbering the entry counts in.
      const broadcast = episode?.tvdb
        ? { season: Number(episode.tvdb.season), episode: Number(episode.tvdb.episode) }
        : { season: Number(season.number), episode: number };

      if (!Number.isFinite(broadcast.season) || !Number.isFinite(broadcast.episode)) continue;
      for (const base of seasoned) {
        snapshot.episodes.add(`${base}:${broadcast.season}:${broadcast.episode}`);
      }
    }
  }
}

interface RawSnapshot {
  episodes: string[];
  movies: string[];
  series: Array<[string, { watched: number; total: number }]>;
  nextUp: NextUpRow[];
}

async function build(accessToken: string): Promise<RawSnapshot> {
  const { fetchSimklAllItems } = require('../../utils/simklUtils');
  const data = await fetchSimklAllItems(accessToken);

  // A failed read is not an empty library. Returning empty here would be cached
  // and served as though nothing had ever been watched, so every tick would
  // disappear until it expired.
  if (!data) throw new Error('The watched library could not be read');

  const snapshot: WatchedSnapshot = {
    episodes: new Set(),
    movies: new Set(),
    series: new Map(),
    nextUp: [],
    fingerprint: '',
  };

  for (const entry of Array.isArray(data?.movies) ? data.movies : []) {
    if (entry?.status !== 'completed') continue;
    const ids = entry?.movie?.ids ?? {};
    if (ids.imdb) snapshot.movies.add(String(ids.imdb));
    if (ids.tmdb) snapshot.movies.add(`tmdb:${ids.tmdb}`);
  }

  for (const entry of Array.isArray(data?.shows) ? data.shows : []) collectShow(entry, snapshot, false);
  for (const entry of Array.isArray(data?.anime) ? data.anime : []) collectShow(entry, snapshot, true);

  return {
    episodes: [...snapshot.episodes],
    movies: [...snapshot.movies],
    series: [...snapshot.series],
    nextUp: snapshot.nextUp.sort((a, b) => b.lastWatchedAt - a.lastWatchedAt),
  };
}

// MDBList pages its watched history and names an episode by its show's ids and
// a season number, so an anime row needs the same anidb pivot the resume path
// uses before it matches what the meta publishes.
async function buildMdblist(apiKey: string): Promise<RawSnapshot> {
  const { httpGet } = require('../../utils/httpClient');
  const pageSize = envInt('JELLYFIN_WATCHED_PAGE_SIZE', 1000, 1);
  const maxPages = envInt('JELLYFIN_WATCHED_MAX_PAGES', 10, 1);

  const episodes = new Set<string>();
  const movies = new Set<string>();
  const series = new Map<string, { watched: number; total: number }>();

  const read = async (mediatype: 'episode' | 'movie'): Promise<any[]> => {
    const collected: any[] = [];
    let cursor = '';

    for (let page = 0; page < maxPages; page += 1) {
      const url =
        `https://api.mdblist.com/sync/watched?mediatype=${mediatype}` +
        `&limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}` +
        `&apikey=${apiKey}`;
      const response = await httpGet(url, { timeout: envInt('JELLYFIN_RESUME_TIMEOUT_MS', 10000, 1000) });
      const body = response?.data ?? {};
      const batch = mediatype === 'episode' ? body.episodes : body.movies;
      if (!Array.isArray(batch) || !batch.length) break;

      collected.push(...batch);
      cursor = body?.pagination?.next_cursor ?? '';
      if (!cursor) break;
    }

    return collected;
  };

  const movieRows = await read('movie');
  const episodeRows = await read('episode');
  if (!movieRows.length && !episodeRows.length) {
    throw new Error('The watched history could not be read');
  }

  for (const entry of movieRows) {
    const ids = entry?.movie?.ids ?? {};
    if (ids.imdb) movies.add(String(ids.imdb));
    if (ids.tmdb) movies.add(`tmdb:${ids.tmdb}`);
  }

  for (const entry of episodeRows) {
    const episode = entry?.episode;
    const season = Number(episode?.season);
    const number = Number(episode?.number);
    const ids = episode?.show?.ids ?? {};
    if (!Number.isFinite(season) || !Number.isFinite(number)) continue;

    const resolved = await videoIdFor(ids, season, number);
    if (!resolved) continue;

    episodes.add(resolved.videoId);

    const counts = series.get(resolved.metaId) ?? { watched: 0, total: 0 };
    counts.watched += 1;
    series.set(resolved.metaId, counts);
  }

  return {
    episodes: [...episodes],
    movies: [...movies],
    series: [...series],
    nextUp: await mdblistNextUp(apiKey),
  };
}

// MDBList names the next episode by the show's TMDB id and a season number, so
// an anime row goes through the same pivot the resume path uses and everything
// else is fetched by TMDB, which the meta route resolves to its own id.
async function mdblistNextUp(apiKey: string): Promise<NextUpRow[]> {
  const { fetchMDBListUpNext } = require('../../utils/mdbList');
  const rows: NextUpRow[] = [];

  try {
    const { items } = await fetchMDBListUpNext(apiKey, 1, envInt('JELLYFIN_NEXTUP_LIMIT', 100, 1), true);

    for (const item of Array.isArray(items) ? items : []) {
      const ids = item?.show?.ids ?? {};
      const season = Number(item?.next_episode?.season);
      const episode = Number(item?.next_episode?.episode);
      if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;

      const resolved = await videoIdFor(ids, season, episode);
      if (!resolved) continue;

      rows.push({
        metaId: resolved.metaId,
        videoId: resolved.mediaType === 'anime' ? resolved.videoId : null,
        season: resolved.mediaType === 'anime' ? null : season,
        episode,
        mediaType: resolved.mediaType,
        lastWatchedAt: Date.parse(item?.last_watched_at ?? '') || 0,
      });
    }
  } catch (error: any) {
    logger.warn(`MDBList up next failed: ${error?.message || error}`);
  }

  return rows.sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);
}

/**
 * Simkl suspends a client_id for polling the whole library, so a refetch is
 * gated on the activities digest and the snapshot is otherwise served from
 * cache however often a client asks.
 */
export async function watchedSnapshot(userUUID: string, config: any): Promise<WatchedSnapshot> {
  const service = sourceFor(config);
  if (!service) return EMPTY;

  const credential = credentialFor(config, service);
  if (!credential) return EMPTY;

  if (service === 'mdblist') return mdblistSnapshot(userUUID, credential);
  if (service !== 'simkl') return EMPTY;

  const tokenId = credential;

  try {
    const { getSimklToken, getSimklActivityFingerprint } = require('../../utils/simklUtils');
    const token = await getSimklToken(tokenId);
    if (!token?.access_token) return EMPTY;

    const accessToken = token.access_token;
    const parts = await Promise.all(
      (['movies', 'shows', 'anime'] as const).map((type) =>
        getSimklActivityFingerprint(accessToken, type, 'completed')
      )
    );
    const tokenHash = createHash('sha256').update(accessToken).digest('hex').substring(0, 16);
    const fingerprint = createHash('sha256').update(parts.join('|')).digest('hex').substring(0, 16);

    const key = `${tokenHash}:${fingerprint}`;
    const memo = hydrated.get(key);
    if (memo) return memo;

    const { cacheWrapGlobal } = require('../getCache');
    const raw: RawSnapshot = await cacheWrapGlobal(
      `jellyfin_watched_v1:${key}`,
      () => build(accessToken),
      envInt('JELLYFIN_WATCHED_REDIS_TTL', 24 * 60 * 60, 60),
      { upstream: true }
    );

    const snapshot: WatchedSnapshot = {
      episodes: new Set(raw?.episodes ?? []),
      movies: new Set(raw?.movies ?? []),
      series: new Map(raw?.series ?? []),
      nextUp: raw?.nextUp ?? [],
      fingerprint,
    };
    if (snapshot.episodes.size || snapshot.movies.size || snapshot.series.size) hydrated.set(key, snapshot);
    logger.debug(
      `Watched snapshot for ${userUUID}: ${snapshot.episodes.size} episodes, ${snapshot.movies.size} films`
    );
    return snapshot;
  } catch (error: any) {
    logger.warn(`Watched snapshot failed: ${error?.message || error}`);
    return EMPTY;
  }
}

/**
 * MDBList publishes the same kind of digest Simkl does, and its own docs say to
 * read it before deciding what changed, so the key is those timestamps rather
 * than a clock: a watch marked elsewhere lands on the next request.
 */
async function mdblistFingerprint(apiKey: string): Promise<string> {
  const { httpGet } = require('../../utils/httpClient');
  const { cacheWrapGlobal } = require('../getCache');
  const keyHash = createHash('sha256').update(apiKey).digest('hex').substring(0, 16);

  const activities = await cacheWrapGlobal(
    `mdblist_last_activities:${keyHash}`,
    async () => {
      const response = await httpGet(
        `https://api.mdblist.com/sync/last_activities?apikey=${apiKey}`,
        { timeout: envInt('JELLYFIN_RESUME_TIMEOUT_MS', 10000, 1000) }
      );
      return response?.data ?? {};
    },
    envInt('MDBLIST_ACTIVITIES_TTL', 300, 30),
    { upstream: true }
  );

  // server_time moves on every call and would defeat the whole point.
  const parts = ['watched_at', 'season_watched_at', 'episode_watched_at', 'journal_at']
    .map((field) => activities?.[field] ?? '')
    .join('|');

  return createHash('sha256').update(parts).digest('hex').substring(0, 16);
}

async function mdblistSnapshot(userUUID: string, apiKey: string): Promise<WatchedSnapshot> {
  const keyHash = createHash('sha256').update(apiKey).digest('hex').substring(0, 16);
  const key = `${keyHash}:${await mdblistFingerprint(apiKey)}`;

  const memo = hydrated.get(key);
  if (memo) return memo;

  try {
    const { cacheWrapGlobal } = require('../getCache');
    const raw: RawSnapshot = await cacheWrapGlobal(
      `jellyfin_watched_mdblist_v1:${key}`,
      () => buildMdblist(apiKey),
      envInt('JELLYFIN_WATCHED_REDIS_TTL', 24 * 60 * 60, 60),
      { upstream: true }
    );

    const snapshot: WatchedSnapshot = {
      episodes: new Set(raw?.episodes ?? []),
      movies: new Set(raw?.movies ?? []),
      series: new Map(raw?.series ?? []),
      nextUp: raw?.nextUp ?? [],
      fingerprint: key,
    };
    if (snapshot.episodes.size || snapshot.movies.size || snapshot.series.size) hydrated.set(key, snapshot);
    logger.debug(
      `Watched snapshot for ${userUUID} from mdblist: ${snapshot.episodes.size} episodes, ${snapshot.movies.size} films`
    );
    return snapshot;
  } catch (error: any) {
    logger.warn(`Watched snapshot from mdblist failed: ${error?.message || error}`);
    return EMPTY;
  }
}

/**
 * A watch reported to this server has already reached the tracker, but the
 * activities digest it is keyed on is cached for minutes, so the snapshot would
 * keep serving the state from before. Dropping the digest lets the next request
 * see the change instead of waiting out the throttle.
 */
export async function invalidateWatched(config: any): Promise<void> {
  const service = sourceFor(config);
  if (!service || (service !== 'simkl' && service !== 'mdblist')) return;

  const credential = credentialFor(config, service);
  if (!credential) return;

  try {
    let seed = credential;
    if (service === 'simkl') {
      const { getSimklToken } = require('../../utils/simklUtils');
      const token = await getSimklToken(credential);
      if (!token?.access_token) return;
      seed = token.access_token;
    }

    const keyHash = createHash('sha256').update(seed).digest('hex').substring(0, 16);
    for (const key of [...hydrated.keys()]) {
      if (String(key).startsWith(`${keyHash}:`)) hydrated.delete(key);
    }

    const { deleteKeysByPattern } = require('../getCache');
    const pattern = service === 'simkl'
      ? `*simkl-api-last-activities:${keyHash}`
      : `*mdblist_last_activities:${keyHash}`;
    await deleteKeysByPattern(pattern);
  } catch (error: any) {
    logger.debug(`Could not invalidate the watched snapshot: ${error?.message || error}`);
  }
}


export function isWatched(snapshot: WatchedSnapshot, stremioId: string): boolean {
  return snapshot.episodes.has(stremioId) || snapshot.movies.has(stremioId);
}

/**
 * Fills in watch state on items already built. Identity comes back out of the
 * item's own guid, so this stays one pass over a finished list rather than a
 * parameter threaded through every builder.
 */
export async function applyWatchedState(
  items: any[],
  snapshot: WatchedSnapshot,
  userUUID?: string
): Promise<void> {
  if (!items.length) return;

  const { decodeJellyfinId } = require('./ids');
  const { stremioIdFor } = require('./idsCodec');

  const descriptors = new Map<string, any>();
  await Promise.all(
    items.map(async (item: any) => {
      if (item?.Id && item.UserData) {
        const d = await decodeJellyfinId(String(item.Id));
        if (d) descriptors.set(String(item.Id), d);
      }
    })
  );

  let own = new Map<string, any>();
  if (userUUID) {
    const videoIds = [...descriptors.values()]
      .filter((d) => d.k === 'movie' || d.k === 'episode')
      .map((d) => stremioIdFor(d))
      .filter(Boolean) as string[];
    try {
      const database: any = require('../database');
      own = await database.getPlaystates(userUUID, videoIds);
    } catch {
      own = new Map();
    }
  }

  await Promise.all(
    items.map(async (item: any) => {
      const descriptor = descriptors.get(String(item?.Id));
      if (!descriptor) return;

      if (descriptor.k === 'series') {
        const counts = snapshot.series.get(String(descriptor.i));
        // Without a total there is no unplayed count to state, and claiming
        // zero would read as a series fully watched.
        if (!counts || counts.total <= 0) return;
        const unplayed = Math.max(0, counts.total - counts.watched);
        item.UserData = {
          ...item.UserData,
          UnplayedItemCount: unplayed,
          Played: counts.total > 0 && unplayed === 0,
          PlayedPercentage: counts.total > 0 ? (counts.watched / counts.total) * 100 : 0,
        };
        return;
      }

      const stremioId = stremioIdFor(descriptor);
      if (!stremioId) return;

      const record = own.get(stremioId);
      if (record) {
        const runtime = Number(record.runtime_ms) || Number(item.RunTimeTicks || 0) / 10000;
        const position = Number(record.position_ms) || 0;
        // A position on a finished title is a rewatch under way.
        item.UserData = {
          ...item.UserData,
          Played: Boolean(record.played),
          PlayCount: Number(record.play_count) || 0,
          PlaybackPositionTicks: position * 10000,
          PlayedPercentage: position > 0 && runtime > 0 ? (position / runtime) * 100 : record.played ? 100 : 0,
          ...(record.last_played_at ? { LastPlayedDate: new Date(Number(record.last_played_at)).toISOString() } : {}),
        };
        return;
      }

      if (!isWatched(snapshot, stremioId)) return;
      item.UserData = { ...item.UserData, Played: true, PlayCount: 1 };
    })
  );
}
