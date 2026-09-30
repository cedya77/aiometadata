import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { createHash } from 'crypto';
import { envInt } from '../../utils/envNumber';
import { credentialFor, sourceFor } from './trackerSource';
import { generationOf, videoIdFor } from './resume';

const logger = consola.withTag('Jellyfin');

/** Shows this server saw finished, newest first; the shelf moves on from the named episode. */
export async function ownNextUpRows(userUUID: string, profile: string): Promise<NextUpRow[]> {
  const database: any = require('../database');
  const { parseStremioId } = require('./ids');
  const { envInt } = require('../../utils/envNumber');
  const { videoIdAliases } = require('./aliases');

  const since = Date.now() - envInt('JELLYFIN_NEXTUP_OWN_DAYS', 120, 1) * 24 * 60 * 60 * 1000;
  const shows = envInt('JELLYFIN_NEXTUP_OWN_LIMIT', 300, 1);
  const scanCap = envInt('JELLYFIN_OWN_PLAYED_LIMIT', 20000, 100);
  const batch = 500;

  const rows: NextUpRow[] = [];
  const seen = new Set<string>();
  let after: { at: number; videoId: string } | null = null;
  for (let scanned = 0; rows.length < shows && scanned < scanCap; scanned += batch) {
    let records: any[];
    try {
      records = await database.listRecentlyPlayed(userUUID, since, batch, profile, after);
    } catch {
      return rows;
    }
    const last = records[records.length - 1];
    if (last) after = { at: Number(last.last_played_at), videoId: String(last.video_id) };
    for (const r of records) {
      if (rows.length >= shows) break;
      const parsed = parseStremioId(String(r.video_id));
      if (!parsed || parsed.episode === null || parsed.episode === undefined || seen.has(parsed.base)) continue;
      seen.add(parsed.base);
      for (const alias of await videoIdAliases(String(r.video_id))) {
        const base = parseStremioId(alias)?.base;
        if (base) seen.add(base);
      }
      rows.push({
        metaId: parsed.base,
        videoId: String(r.video_id),
        season: parsed.season ?? null,
        episode: parsed.episode,
        mediaType: parsed.idType === 'kitsu' || parsed.idType === 'mal' || parsed.idType === 'anilist' ? 'anime' : 'series',
        lastWatchedAt: Number(r.last_played_at) || Number(r.updated_at) || 0,
      });
    }
    if (records.length < batch) break;
  }
  return rows;
}

export interface NextUpRow {
  metaId: string;
  /** Set when the tracker names the episode exactly, as anime does. */
  videoId: string | null;
  season: number | null;
  episode: number;
  mediaType: 'anime' | 'series';
  lastWatchedAt: number;
  /** When the tracker says the episode airs, where it says. */
  airsAt?: number | null;
  /** The tracker says the episode is out: its next airing is a later one, or the show has finished. */
  aired?: boolean;
}

export interface HistoryEntry {
  kind: 'movie' | 'episode';
  id: string;
  metaId?: string;
  mediaType: 'movie' | 'series' | 'anime';
  at: number;
}

function recordWatch(history: Map<string, HistoryEntry>, entry: HistoryEntry): void {
  const held = history.get(entry.id);
  if (!held || entry.at > held.at) history.set(entry.id, entry);
}

function newestFirst(history: Map<string, HistoryEntry>): HistoryEntry[] {
  return [...history.values()].sort((a, b) => b.at - a.at);
}

/**
 * What a tracker account's watched state says, held small: the titles themselves live in
 * the watch index and are asked for a page at a time.
 */
export interface WatchedSnapshot {
  /** The account the watch index is kept under; null when no tracker is read. */
  source: string | null;
  nextUp: NextUpRow[];
  /** Shows the tracker lists as being watched, next episode aired or not. */
  following: Array<{ metaId: string; mediaType: 'anime' | 'series' }>;
  /** Shows the tracker lists as dropped, under every id they answer to. */
  dropped: Set<string>;
  /** The drops could not be read, so `dropped` is not the whole list. */
  droppedUnread?: boolean;
  fingerprint: string;
}

const EMPTY: WatchedSnapshot = { source: null, nextUp: [], following: [], dropped: new Set(), fingerprint: '' };

/** What a tracker library is assembled into before it is written to the watch index. */
interface Collecting {
  /** Video ids in the space the meta publishes, e.g. `kitsu:49002:11`. */
  episodes: Set<string>;
  /** Base ids of watched films. */
  movies: Set<string>;
  /** Watched and total episode counts, keyed by every id the series answers to. */
  series: Map<string, { watched: number; total: number; at?: number }>;
  nextUp: NextUpRow[];
  following: Array<{ metaId: string; mediaType: 'anime' | 'series' }>;
  /** When a video was last watched, by video id, where the tracker says. */
  at: Map<string, number>;
  dropped: Set<string>;
}

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

// A dropped show is kept out under the anime spelling the meta may use as well.
async function droppedKeys(ids: Record<string, any>, config: any = {}): Promise<string[]> {
  if (!ids.imdb && !ids.tvdb && ids.tmdb) {
    try {
      const { resolveAllIds } = require('../id-resolver');
      const found = await resolveAllIds(`tmdb:${ids.tmdb}`, 'series', config, {}, ['imdb', 'tvdb']);
      ids = { ...ids, ...(found?.imdbId ? { imdb: found.imdbId } : {}), ...(found?.tvdbId ? { tvdb: found.tvdbId } : {}) };
    } catch {}
  }
  return seriesKeysWithKitsu(ids);
}

function seriesKeysWithKitsu(ids: Record<string, any>): string[] {
  const keys = seriesKeys(ids);
  if (!ids.kitsu) {
    const idMapper: any = require('../id-mapper');
    const mapping = ids.imdb ? idMapper.getMappingByImdbId(String(ids.imdb)) : ids.tvdb ? idMapper.getMappingByTvdbId(Number(ids.tvdb)) : null;
    if (mapping?.kitsu_id) keys.push(`kitsu:${mapping.kitsu_id}`);
  }
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

function collectShow(entry: any, snapshot: Collecting, isAnime: boolean, history: Map<string, HistoryEntry>): void {
  const ids = entry?.show?.ids ?? {};
  const keys = seriesKeys(ids);

  const metaId = isAnime && ids.kitsu
    ? `kitsu:${ids.kitsu}`
    : (ids.imdb ? String(ids.imdb) : ids.tvdb ? `tvdb:${ids.tvdb}` : null);
  if (metaId && entry?.status === 'watching') {
    snapshot.following.push({ metaId, mediaType: isAnime && ids.kitsu ? 'anime' : 'series' });
  }
  // An older Simkl app is sent `notinteresting` where a newer one gets `dropped`.
  if (entry?.status === 'dropped' || entry?.status === 'notinteresting') for (const key of seriesKeysWithKitsu(ids)) snapshot.dropped.add(key);

  // Simkl names a next episode for every listed show, a planned or dropped one
  // included; only a show being watched belongs on the shelf.
  const next = entry?.status === 'watching' ? parseNextToWatch(entry?.next_to_watch) : null;
  if (next) {
    if (metaId) {
      snapshot.nextUp.push({
        metaId,
        videoId: isAnime && ids.kitsu ? `kitsu:${ids.kitsu}:${next.episode}` : null,
        season: next.season,
        episode: next.episode,
        mediaType: isAnime && ids.kitsu ? 'anime' : 'series',
        lastWatchedAt: Date.parse(entry?.last_watched_at ?? '') || 0,
        airsAt: Date.parse(entry?.next_to_watch_info?.date ?? '') || null,
      });
    }
  }

  const counts = {
    watched: Number(entry?.watched_episodes_count) || 0,
    total: Math.max(0, (Number(entry?.total_episodes_count) || 0) - (Number(entry?.not_aired_episodes_count) || 0)),
    at: Date.parse(entry?.last_watched_at ?? '') || undefined,
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
      const watchedAt = Date.parse(episode?.watched_at ?? '') || 0;
      const mark = (videoId: string) => {
        snapshot.episodes.add(videoId);
        if (watchedAt) snapshot.at.set(videoId, watchedAt);
      };

      if (absolute) mark(`${absolute}:${number}`);
      if (absolute && metaId) {
        recordWatch(history, { kind: 'episode', id: `${absolute}:${number}`, metaId, mediaType: 'anime', at: watchedAt });
      }

      if (!seasoned.length) continue;

      // Anime episodes carry the broadcast numbering the other id spaces use,
      // which is not the numbering the entry counts in.
      const broadcast = episode?.tvdb
        ? { season: Number(episode.tvdb.season), episode: Number(episode.tvdb.episode) }
        : { season: Number(season.number), episode: number };

      if (!Number.isFinite(broadcast.season) || !Number.isFinite(broadcast.episode)) continue;
      for (const base of seasoned) {
        mark(`${base}:${broadcast.season}:${broadcast.episode}`);
      }
      if (!absolute && metaId) {
        recordWatch(history, {
          kind: 'episode',
          id: `${seasoned[0]}:${broadcast.season}:${broadcast.episode}`,
          metaId,
          mediaType: 'series',
          at: watchedAt,
        });
      }
    }
  }
}

interface RawSnapshot {
  episodes: string[];
  movies: string[];
  history?: HistoryEntry[];
  at?: Array<[string, number]>;
  series: Array<[string, { watched: number; total: number; at?: number }]>;
  nextUp: NextUpRow[];
  following?: Array<{ metaId: string; mediaType: 'anime' | 'series' }>;
  dropped?: string[];
  droppedUnread?: boolean;
}

/** A Simkl library, as `/sync/all-items` returns it, made into a snapshot. */
export function assembleSimkl(data: any): RawSnapshot {
  const snapshot: Collecting = {
    episodes: new Set(),
    movies: new Set(),
    series: new Map(),
    nextUp: [],
    following: [],
    at: new Map(),
    dropped: new Set(),
  };
  const history = new Map<string, HistoryEntry>();

  for (const entry of Array.isArray(data?.movies) ? data.movies : []) {
    if (entry?.status !== 'completed') continue;
    const ids = entry?.movie?.ids ?? {};
    const at = Date.parse(entry?.last_watched_at ?? '') || 0;
    if (ids.imdb) snapshot.movies.add(String(ids.imdb));
    if (ids.tmdb) snapshot.movies.add(`tmdb:${ids.tmdb}`);
    if (at && ids.imdb) snapshot.at.set(String(ids.imdb), at);
    if (at && ids.tmdb) snapshot.at.set(`tmdb:${ids.tmdb}`, at);
    const id = ids.imdb ? String(ids.imdb) : ids.tmdb ? `tmdb:${ids.tmdb}` : null;
    if (id) recordWatch(history, { kind: 'movie', id, mediaType: 'movie', at });
  }

  for (const entry of Array.isArray(data?.shows) ? data.shows : []) collectShow(entry, snapshot, false, history);
  for (const entry of Array.isArray(data?.anime) ? data.anime : []) collectShow(entry, snapshot, true, history);

  return {
    episodes: [...snapshot.episodes],
    movies: [...snapshot.movies],
    history: newestFirst(history),
    at: [...snapshot.at],
    series: [...snapshot.series],
    nextUp: snapshot.nextUp.sort((a, b) => b.lastWatchedAt - a.lastWatchedAt),
    following: snapshot.following,
    dropped: [...snapshot.dropped],
  };
}

export interface AnimeListEntry {
  anilist?: number;
  mal?: number;
  status: 'watching' | 'completed' | 'dropped' | 'paused' | 'planning';
  progress: number;
  episodes: number | null;
  movie: boolean;
  updatedAt: number;
  nextAiring?: { episode: number; at: number };
  finished?: boolean;
}

export async function assembleAnimeList(entries: AnimeListEntry[]): Promise<RawSnapshot> {
  const idMapper: any = require('../id-mapper');
  const { videoIdAliases } = require('./aliases');
  const snapshot: Collecting = {
    episodes: new Set(),
    movies: new Set(),
    series: new Map(),
    nextUp: [],
    following: [],
    at: new Map(),
    dropped: new Set(),
  };
  const history = new Map<string, HistoryEntry>();

  for (const entry of entries) {
    const mapping = (entry.anilist ? idMapper.getMappingByAnilistId(entry.anilist) : null)
      ?? (entry.mal ? idMapper.getMappingByMalId(entry.mal) : null);
    const ids: Record<string, any> = {
      kitsu: mapping?.kitsu_id,
      mal: entry.mal ?? mapping?.mal_id,
      anilist: entry.anilist ?? mapping?.anilist_id,
      imdb: mapping?.imdb_id,
      tvdb: mapping?.tvdb_id,
    };
    const metaId = ids.kitsu ? `kitsu:${ids.kitsu}` : ids.mal ? `mal:${ids.mal}` : null;
    if (!metaId) continue;

    if (entry.status === 'dropped') for (const key of seriesKeysWithKitsu(ids)) snapshot.dropped.add(key);
    const watchedCount = entry.status === 'completed' ? Math.max(entry.progress, entry.episodes ?? 0) : entry.progress;

    if (entry.movie) {
      if (entry.status !== 'completed' && watchedCount < 1) continue;
      const spellings = [ids.imdb ? String(ids.imdb) : null, ids.kitsu ? `kitsu:${ids.kitsu}` : null, ids.mal ? `mal:${ids.mal}` : null].filter(Boolean) as string[];
      for (const id of spellings) {
        snapshot.movies.add(id);
        if (entry.updatedAt) snapshot.at.set(id, entry.updatedAt);
      }
      recordWatch(history, { kind: 'movie', id: spellings[0], mediaType: 'movie', at: entry.updatedAt });
      continue;
    }

    for (let number = 1; number <= watchedCount; number += 1) {
      const videoId = `${metaId}:${number}`;
      for (const id of [videoId, ...(await videoIdAliases(videoId))]) snapshot.episodes.add(id);
    }
    if (watchedCount > 0) {
      const last = `${metaId}:${watchedCount}`;
      if (entry.updatedAt) snapshot.at.set(last, entry.updatedAt);
      recordWatch(history, { kind: 'episode', id: last, metaId, mediaType: 'anime', at: entry.updatedAt });
    }

    const aired = entry.nextAiring
      ? entry.nextAiring.episode - (entry.nextAiring.at > Date.now() ? 1 : 0)
      : entry.episodes ?? watchedCount;
    const counts = { watched: watchedCount, total: Math.max(0, aired), at: entry.updatedAt || undefined };
    for (const key of seriesKeys(ids)) snapshot.series.set(key, counts);

    if (entry.status !== 'watching') continue;
    snapshot.following.push({ metaId, mediaType: 'anime' });
    const next = entry.progress + 1;
    if (entry.episodes && next > entry.episodes) continue;
    snapshot.nextUp.push({
      metaId,
      videoId: `${metaId}:${next}`,
      season: null,
      episode: next,
      mediaType: 'anime',
      lastWatchedAt: entry.updatedAt,
      airsAt: entry.nextAiring?.episode === next ? entry.nextAiring.at : null,
      ...((entry.nextAiring && entry.nextAiring.episode > next) || entry.finished ? { aired: true } : {}),
    });
  }

  return {
    episodes: [...snapshot.episodes],
    movies: [...snapshot.movies],
    history: newestFirst(history),
    at: [...snapshot.at],
    series: [...snapshot.series],
    nextUp: snapshot.nextUp.sort((a, b) => b.lastWatchedAt - a.lastWatchedAt),
    following: snapshot.following,
    dropped: [...snapshot.dropped],
  };
}

// MDBList pages its watched history and names an episode by its show's ids and
// a season number, so an anime row needs the same anidb pivot the resume path
// uses before it matches what the meta publishes.
export interface MdblistData {
  movieRows: any[];
  episodeRows: any[];
  /** MDBList's own up-next list; empty when it could not be read. */
  upNext: any[];
  droppedShows: any[];
  droppedUnread: boolean;
}

export async function fetchMdblistUpNext(apiKey: string): Promise<any[]> {
  const upNext: any[] = [];
  try {
    const { fetchMDBListUpNext } = require('../../utils/mdbList');
    for (let page = 1; page <= envInt('JELLYFIN_NEXTUP_MDBLIST_PAGES', 5, 1); page++) {
      const batch = await fetchMDBListUpNext(apiKey, page, 100);
      upNext.push(...batch.items);
      if (!batch.hasMore || !batch.items.length) break;
    }
  } catch (error: any) {
    logger.warn(`MDBList up next failed, seeding from history: ${error?.message || error}`);
  }
  return upNext;
}

export async function fetchMdblistDropped(apiKey: string): Promise<{ shows: any[]; unread: boolean }> {
  const { makeRateLimitedMDBListRequest } = require('../../utils/mdbList');
  const pageSize = envInt('JELLYFIN_WATCHED_PAGE_SIZE', 1000, 1);
  const maxPages = envInt('JELLYFIN_WATCHED_MAX_PAGES', 50, 1);
  const shows: any[] = [];
  try {
    for (let offset = 0; offset < maxPages * pageSize; offset += pageSize) {
      const response = await makeRateLimitedMDBListRequest(`https://api.mdblist.com/sync/dropped?limit=${pageSize}&offset=${offset}&apikey=${apiKey}`, apiKey, 'MDBList dropped');
      const page = Array.isArray(response?.data?.shows) ? response.data.shows : [];
      shows.push(...page);
      if (page.length < pageSize) break;
    }
    return { shows, unread: false };
  } catch (error: any) {
    logger.warn(`MDBList dropped shows failed: ${error?.message || error}`);
    return { shows, unread: true };
  }
}

/** Every page of a user's MDBList watched history, optionally only what changed since a time. */
export async function fetchMdblistWatched(apiKey: string, mediatype: 'episode' | 'movie' | 'show', since?: string): Promise<any[]> {
  const { makeRateLimitedMDBListRequest } = require('../../utils/mdbList');
  const pageSize = envInt('JELLYFIN_WATCHED_PAGE_SIZE', 1000, 1);
  const maxPages = envInt('JELLYFIN_WATCHED_MAX_PAGES', 50, 1);
  const collected: any[] = [];
  let cursor = '';

  for (let page = 0; page < maxPages; page += 1) {
    const url =
      `https://api.mdblist.com/sync/watched?mediatype=${mediatype}` +
      `&limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}` +
      // Sent with every page: the cursor alone carries on into older history.
      `${since ? `&since=${encodeURIComponent(since)}` : ''}` +
      `&apikey=${apiKey}`;
    const response = await makeRateLimitedMDBListRequest(url, apiKey, `MDBList watched ${mediatype} page ${page + 1}`);
    const body = response?.data ?? {};
    const batch = body[`${mediatype}s`];
    if (!Array.isArray(batch) || !batch.length) break;

    collected.push(...batch);
    cursor = body?.pagination?.next_cursor ?? '';
    if (!cursor) break;
  }

  return collected;
}

export async function assembleMdblist(data: MdblistData, config: any): Promise<RawSnapshot> {
  const { movieRows, episodeRows, upNext, droppedShows, droppedUnread } = data;
  const { Resolutions } = require('./resolutions');
  const resolutions = new Resolutions();
  await resolutions.preload(
    [
      ...episodeRows.map((entry: any) => [entry?.episode?.show?.ids ?? {}, Number(entry?.episode?.season), Number(entry?.episode?.number)]),
      ...upNext.map((item: any) => [item?.show?.ids ?? {}, Number(item?.next_episode?.season), Number(item?.next_episode?.episode)]),
    ],
    []
  );
  const episodes = new Set<string>();
  const movies = new Set<string>();
  const series = new Map<string, { watched: number; total: number; at?: number }>();
  if (!movieRows.length && !episodeRows.length) logger.debug('No watched history on MDBList');

  const at = new Map<string, number>();
  const history = new Map<string, HistoryEntry>();
  const { canonicalIds } = require('./canonicalIds');
  for (const entry of movieRows) {
    const ids = await canonicalIds(entry?.movie?.ids ?? {}, 'movie', config);
    const seen = Date.parse(entry?.last_watched_at ?? '') || 0;
    if (ids.imdb) movies.add(String(ids.imdb));
    if (ids.tmdb) movies.add(`tmdb:${ids.tmdb}`);
    if (seen && ids.imdb) at.set(String(ids.imdb), seen);
    if (seen && ids.tmdb) at.set(`tmdb:${ids.tmdb}`, seen);
    const id = ids.imdb ? String(ids.imdb) : ids.tmdb ? `tmdb:${ids.tmdb}` : null;
    if (id) recordWatch(history, { kind: 'movie', id, mediaType: 'movie', at: seen });
  }

  const latest = new Map<string, { resolved: any; season: number; number: number; at: number }>();
  for (const entry of episodeRows) {
    const episode = entry?.episode;
    const season = Number(episode?.season);
    const number = Number(episode?.number);
    const ids = episode?.show?.ids ?? {};
    if (!Number.isFinite(season) || !Number.isFinite(number)) continue;

    const resolved = await resolutions.episode(ids, season, number, config);
    if (!resolved) continue;

    episodes.add(resolved.videoId);

    const seen = Date.parse(entry?.last_watched_at ?? '') || 0;
    if (seen) at.set(resolved.videoId, seen);
    recordWatch(history, { kind: 'episode', id: resolved.videoId, metaId: resolved.metaId, mediaType: resolved.mediaType, at: seen });
    const counts = series.get(resolved.metaId) ?? { watched: 0, total: 0 };
    counts.watched += 1;
    if (seen && (!counts.at || seen > counts.at)) counts.at = seen;
    series.set(resolved.metaId, counts);

    const held = latest.get(resolved.metaId);
    if (!held || seen > held.at || (seen === held.at && (season > held.season || (season === held.season && number > held.number)))) {
      latest.set(resolved.metaId, { resolved, season, number, at: seen });
    }
  }

  // MDBList names the next episode itself, the one its own app shows. The
  // history seeds it only when that call fails: the last episode watched, from
  // which the shelf moves on.
  const nextUp: NextUpRow[] = [];
  for (const item of upNext) {
    const season = Number(item?.next_episode?.season);
    const number = Number(item?.next_episode?.episode);
    if (!Number.isFinite(season) || !Number.isFinite(number)) continue;
    const resolved = await resolutions.episode(item?.show?.ids ?? {}, season, number, config);
    if (!resolved) continue;
    const total = Number(item?.progress?.total_episode_count) || 0;
    if (total > 0) {
      const counts = series.get(resolved.metaId) ?? { watched: Number(item?.progress?.watched_episode_count) || 0, total: 0 };
      counts.total = total;
      series.set(resolved.metaId, counts);
    }
    nextUp.push({
      metaId: resolved.metaId,
      videoId: resolved.mediaType === 'anime' ? resolved.videoId : null,
      season: resolved.mediaType === 'anime' ? null : season,
      episode: resolved.mediaType === 'anime' ? Number(String(resolved.videoId).split(':').pop()) : number,
      mediaType: resolved.mediaType,
      lastWatchedAt: Date.parse(item?.last_watched_at ?? '') || 0,
    });
  }
  if (!upNext.length) {
    for (const [metaId, { resolved, season, number, at }] of latest) {
      nextUp.push({
        metaId,
        videoId: resolved.mediaType === 'anime' ? resolved.videoId : null,
        season: resolved.mediaType === 'anime' ? null : season,
        episode: resolved.mediaType === 'anime' ? Number(String(resolved.videoId).split(':').pop()) : number,
        mediaType: resolved.mediaType,
        lastWatchedAt: at,
      });
    }
  }

  const dropped = new Set<string>();
  for (const item of droppedShows) for (const key of seriesKeysWithKitsu(item?.show?.ids ?? {})) dropped.add(key);

  await resolutions.save();

  return {
    episodes: [...episodes],
    movies: [...movies],
    history: newestFirst(history),
    at: [...at],
    series: [...series],
    nextUp: nextUp.sort((a, b) => b.lastWatchedAt - a.lastWatchedAt),
    dropped: [...dropped],
    droppedUnread,
  };
}


// --- The watch store ---------------------------------------------------------------
//
// Each tracker account's library is mirrored in the database and kept current from what
// changed since the last sync (trackerMirror.ts). Each time the mirror moves, it is
// assembled into the watch index: one row per watched film or episode as this server
// publishes it, and the series counts. A page then asks the index for its own titles,
// and what is held per account is only Next Up, the followed and the dropped shows.

type MirroredService = 'simkl' | 'mdblist' | 'publicmetadb' | 'anilist' | 'mal';

// Raised to rebuild indexes written in an older spelling.
const INDEX_FORMAT = 2;

interface SummaryData {
  format?: number;
  nextUp: NextUpRow[];
  following: Array<{ metaId: string; mediaType: 'anime' | 'series' }>;
  dropped: string[];
  droppedUnread?: boolean;
}

const summaries = new LRUCache<string, WatchedSnapshot>({ max: envInt('JELLYFIN_WATCHED_CACHE_MAX', 200, 1) });
// One build per account at a time, each after the last, so two versions never write the index at once.
const indexBuilds = new Map<string, Promise<unknown>>();

function viewOf(source: string, fingerprint: string, data: SummaryData): WatchedSnapshot {
  return {
    source,
    nextUp: data?.nextUp ?? [],
    following: data?.following ?? [],
    dropped: new Set(data?.dropped ?? []),
    droppedUnread: data?.droppedUnread === true,
    fingerprint,
  };
}

async function assembleFromMirror(service: MirroredService, credential: string, config: any): Promise<RawSnapshot> {
  const { mirrorRows } = require('./trackerMirror');
  const rows: Array<{ key: string; data: any }> = await mirrorRows(service, credential);
  const byTime = (field: string) => (a: any, b: any) => (Date.parse(b?.[field] ?? '') || 0) - (Date.parse(a?.[field] ?? '') || 0);

  if (service === 'simkl') {
    const { canonicalIds } = require('./canonicalIds');
    const data: any = { movies: [], shows: [], anime: [] };
    for (const row of rows) {
      const type = row.key.split(':')[0];
      if (!data[type]) continue;
      let entry = row.data;
      const media = entry?.movie ?? entry?.show;
      if (type !== 'anime' && media?.ids) {
        const ids = await canonicalIds(media.ids, type === 'movies' ? 'movie' : 'series', config);
        if (ids.imdb !== media.ids.imdb) entry = { ...entry, [entry.movie ? 'movie' : 'show']: { ...media, ids } };
      }
      data[type].push(entry);
    }
    return assembleSimkl(data);
  }
  if (service === 'mdblist') {
    const movieRows: any[] = [];
    const episodeRows: any[] = [];
    let upNext: any[] = [];
    let dropped: any = { shows: [], unread: false };
    for (const row of rows) {
      if (row.key.startsWith('movie:')) movieRows.push(row.data);
      else if (row.key.startsWith('ep:')) episodeRows.push(row.data);
      else if (row.key === 'upnext') upNext = Array.isArray(row.data) ? row.data : [];
      else if (row.key === 'dropped') dropped = row.data ?? dropped;
    }
    movieRows.sort(byTime('last_watched_at'));
    episodeRows.sort(byTime('last_watched_at'));
    // MDBList names no followed shows.
    return { ...(await assembleMdblist({ movieRows, episodeRows, upNext, droppedShows: dropped.shows ?? [], droppedUnread: dropped.unread === true }, config)), following: [] };
  }
  if (service === 'anilist' || service === 'mal') {
    return assembleAnimeList(rows.filter((row) => row.key.startsWith('entry:')).map((row) => row.data));
  }
  const plays: any[] = [];
  let dropped: any = { items: [], unread: false };
  for (const row of rows) {
    if (row.key.startsWith('play:')) plays.push(row.data);
    else if (row.key === 'dropped') dropped = row.data ?? dropped;
  }
  // Newest first, as PublicMetaDB lists them: the first play of an episode is its latest.
  plays.sort(byTime('watched_at'));
  return assemblePmdb({ rows: plays, droppedItems: dropped.items ?? [], droppedUnread: dropped.unread === true }, config);
}

/** Writes this server made that the tracker has not taken yet, laid over what it holds. */
function withPending(raw: RawSnapshot, pending: Array<{ videoId: string; kind: 'movie' | 'episode'; metaId: string; played: boolean; at: number }>): void {
  if (!pending.length) return;
  const episodes = new Set(raw.episodes);
  const movies = new Set(raw.movies);
  const at = new Map(raw.at ?? []);
  const history = new Map((raw.history ?? []).map((entry) => [entry.id, entry] as const));
  const counts = new Map(raw.series ?? []);
  for (const change of pending) {
    const set = change.kind === 'movie' ? movies : episodes;
    const had = set.has(change.videoId);
    if (change.played === had) continue;
    if (change.played) {
      set.add(change.videoId);
      at.set(change.videoId, change.at);
      history.set(change.videoId, {
        kind: change.kind,
        id: change.videoId,
        ...(change.kind === 'episode' ? { metaId: change.metaId } : {}),
        mediaType: change.kind === 'movie' ? 'movie' : change.videoId.startsWith('kitsu:') ? 'anime' : 'series',
        at: change.at,
      });
    } else {
      set.delete(change.videoId);
      at.delete(change.videoId);
      history.delete(change.videoId);
    }
    // A show's ids share one counts object, so this moves the count under all of them.
    const show = change.kind === 'episode' ? counts.get(change.metaId) : undefined;
    if (show) show.watched = Math.max(0, Math.min(show.total, show.watched + (change.played ? 1 : -1)));
  }
  raw.episodes = [...episodes];
  raw.movies = [...movies];
  raw.at = [...at];
  raw.history = [...history.values()].sort((a, b) => b.at - a.at);
}

type IndexRow = { video_id: string; kind: string; meta_id: string; media_type: string; at: number; listed: number };

/** The assembled library written over the index, as the rows that changed. */
async function writeIndex(source: string, raw: RawSnapshot): Promise<{ added: number; removed: number }> {
  const database: any = require('../database');
  const { parseStremioId } = require('./ids');
  const at = new Map(raw.at ?? []);
  const listed = new Map((raw.history ?? []).map((entry) => [entry.id, entry] as const));
  const want = new Map<string, IndexRow>();
  const add = (id: string, kind: 'episode' | 'movie') => {
    const entry = listed.get(id);
    const base = kind === 'episode' ? parseStremioId(id)?.base ?? id : id;
    want.set(id, {
      video_id: id,
      kind,
      meta_id: entry?.metaId ?? base,
      media_type: entry?.mediaType ?? (kind === 'movie' ? 'movie' : id.startsWith('kitsu:') ? 'anime' : 'series'),
      at: at.get(id) ?? entry?.at ?? 0,
      listed: entry ? 1 : 0,
    });
  };
  for (const id of raw.episodes) add(id, 'episode');
  for (const id of raw.movies) add(id, 'movie');
  for (const entry of raw.history ?? []) if (!want.has(entry.id)) add(entry.id, entry.kind);

  const have = new Map<string, IndexRow>((await database.listWatchIndex(source)).map((row: IndexRow) => [row.video_id, row]));
  const changed: IndexRow[] = [];
  for (const row of want.values()) {
    const held = have.get(row.video_id);
    if (!held || held.kind !== row.kind || held.meta_id !== row.meta_id || held.media_type !== row.media_type || held.at !== Math.round(row.at) || held.listed !== row.listed) changed.push(row);
  }
  const gone = [...have.keys()].filter((id) => !want.has(id));
  if (changed.length) await database.upsertWatchIndex(source, changed);
  if (gone.length) await database.deleteWatchIndex(source, gone);

  const series = new Map(raw.series ?? []);
  // A show's ids share one counts object; the first id it was filed under names the show.
  const groups = new Map<object, string>();
  for (const [key, counts] of series) if (!groups.has(counts)) groups.set(counts, key);
  const heldSeries = new Map<string, any>((await database.listWatchSeries(source)).map((row: any) => [row.series_key, row]));
  const seriesChanged: Array<{ series_key: string; group_key: string; watched: number; total: number; at: number }> = [];
  for (const [key, counts] of series) {
    const held = heldSeries.get(key);
    const row = { series_key: key, group_key: groups.get(counts) ?? key, watched: counts.watched, total: counts.total, at: Math.round(counts.at ?? 0) };
    if (!held || held.group_key !== row.group_key || held.watched !== row.watched || held.total !== row.total || held.at !== row.at) seriesChanged.push(row);
  }
  const seriesGone = [...heldSeries.keys()].filter((key) => !series.has(key));
  if (seriesChanged.length) await database.upsertWatchSeries(source, seriesChanged);
  if (seriesGone.length) await database.deleteWatchSeries(source, seriesGone);
  return { added: changed.length, removed: gone.length };
}

async function buildIndex(service: MirroredService, credential: string, config: any, source: string, version: number): Promise<WatchedSnapshot> {
  const database: any = require('../database');
  const fingerprint = `store:${source}:v${version}`;
  const stored = await database.getWatchSummary(source);
  if (stored?.version === version && stored.data?.format === INDEX_FORMAT) return viewOf(source, fingerprint, stored.data);

  const started = Date.now();
  const raw = await assembleFromMirror(service, credential, config);
  const { pendingWatches } = require('../trackerOutbox');
  withPending(raw, await pendingWatches(service, credential).catch(() => []));
  const written = await writeIndex(source, raw);
  const data: SummaryData = { format: INDEX_FORMAT, nextUp: raw.nextUp ?? [], following: raw.following ?? [], dropped: raw.dropped ?? [], droppedUnread: raw.droppedUnread === true };
  // Written last: an index left half-written by a crash is rebuilt, since its version never lands.
  await database.putWatchSummary(source, version, data);
  logger.debug(`Watch index for ${service} ${source.slice(-8)} at version ${version}: ${raw.episodes.length} episodes, ${raw.movies.length} films, ${written.added} rows written and ${written.removed} removed in ${Date.now() - started}ms`);
  return viewOf(source, fingerprint, data);
}

async function storeSnapshot(userUUID: string, config: any, service: MirroredService, credential: string): Promise<WatchedSnapshot> {
  const { syncMirror, mirrorVersion, sourceKeyFor } = require('./trackerMirror');
  const source = sourceKeyFor(service, credential);
  let version: number;
  try {
    version = await syncMirror(service, credential, config);
  } catch (error: any) {
    // A failed sync leaves the mirror as it was, which is still the best answer held.
    version = await mirrorVersion(service, credential);
    logger.warn(`Watch store sync from ${service} failed for ${userUUID}: ${error?.message || error}${version ? '; serving the mirror as last synced' : ''}`);
    if (!version) {
      const database: any = require('../database');
      const stored = await database.getWatchSummary(source).catch(() => null);
      return stored ? viewOf(source, `store:${source}:v${stored.version}`, stored.data) : EMPTY;
    }
  }

  const key = `store:${source}:v${version}`;
  const memo = summaries.get(key);
  if (memo) return memo;
  const prior = indexBuilds.get(source) ?? Promise.resolve();
  const work = prior.catch(() => undefined).then(async () => {
    const again = summaries.get(key);
    if (again) return again;
    const view = await buildIndex(service, credential, config, source, version);
    summaries.set(key, view);
    return view;
  });
  const settled = work.finally(() => {
    if (indexBuilds.get(source) === settled) indexBuilds.delete(source);
  });
  indexBuilds.set(source, settled);
  return work;
}

async function readWatchedSnapshot(userUUID: string, config: any): Promise<WatchedSnapshot> {
  const { readsTrackers } = require('./profiles');
  if (!readsTrackers(config)) return EMPTY;
  const service = sourceFor(config);
  const credential = service ? credentialFor(config, service) : undefined;
  if (!service || !credential) return EMPTY;
  return storeSnapshot(userUUID, config, service, credential);
}

/** The watched titles among these ids, with when each was watched, 0 where the tracker does not say. */
export async function watchedAmong(snapshot: WatchedSnapshot, ids: string[]): Promise<Map<string, number>> {
  if (!snapshot.source || !ids.length) return new Map();
  const database: any = require('../database');
  const rows: Array<{ video_id: string; at: number }> = await database.watchIndexAmong(snapshot.source, ids).catch(() => []);
  return new Map(rows.map((row) => [row.video_id, row.at]));
}

export async function seriesCountsAmong(snapshot: WatchedSnapshot, keys: string[]): Promise<Map<string, { watched: number; total: number; at: number }>> {
  if (!snapshot.source || !keys.length) return new Map();
  const database: any = require('../database');
  const rows: any[] = await database.watchSeriesAmong(snapshot.source, keys).catch(() => []);
  return new Map(rows.map((row) => [row.series_key, { watched: row.watched, total: row.total, at: row.at }]));
}

/** Watched films and episodes, one per title, newest first. */
export async function watchedHistory(snapshot: WatchedSnapshot, kinds: Array<'movie' | 'episode'>, limit: number): Promise<HistoryEntry[]> {
  if (!snapshot.source || !kinds.length) return [];
  const database: any = require('../database');
  const rows: any[] = await database.listWatchHistory(snapshot.source, kinds, limit).catch(() => []);
  return rows.map((row) => ({
    kind: row.kind,
    id: row.video_id,
    ...(row.kind === 'episode' ? { metaId: row.meta_id } : {}),
    mediaType: row.media_type,
    at: row.at,
  }));
}

/** Each show the tracker counts as fully watched, once. */
export async function finishedSeries(snapshot: WatchedSnapshot): Promise<Array<{ id: string; at: number }>> {
  if (!snapshot.source) return [];
  const database: any = require('../database');
  const rows: any[] = await database.listFinishedSeries(snapshot.source).catch(() => []);
  return rows.map((row) => ({ id: row.series_key, at: row.at }));
}

/** Every watched id, for the few readers that compare whole lists. Read, used and let go. */
export async function allWatched(snapshot: WatchedSnapshot): Promise<{ episodes: string[]; movies: string[]; at: Map<string, number> }> {
  if (!snapshot.source) return { episodes: [], movies: [], at: new Map() };
  const database: any = require('../database');
  const rows: IndexRow[] = await database.listWatchIndex(snapshot.source);
  return {
    episodes: rows.filter((row) => row.kind === 'episode').map((row) => row.video_id),
    movies: rows.filter((row) => row.kind === 'movie').map((row) => row.video_id),
    at: new Map(rows.filter((row) => row.at > 0).map((row) => [row.video_id, row.at])),
  };
}

export async function allSeriesCounts(snapshot: WatchedSnapshot): Promise<Map<string, { watched: number; total: number; at: number }>> {
  if (!snapshot.source) return new Map();
  const database: any = require('../database');
  const rows: any[] = await database.listWatchSeries(snapshot.source);
  return new Map(rows.map((row) => [row.series_key, { watched: row.watched, total: row.total, at: row.at }]));
}

/** A followed show's next episode as the tracker names it, with when it airs. */
export type UpcomingRow = Omit<NextUpRow, 'lastWatchedAt'>;

/**
 * Shows the tracker follows with an episode on the way, and that episode: watchlisted,
 * in progress or caught up. Whether one counts as upcoming is the shelf's call.
 */
export async function upcomingFollowed(config: any, days: number): Promise<UpcomingRow[]> {
  const { readsTrackers } = require('./profiles');
  if (!readsTrackers(config)) return [];
  const apiKey = credentialFor(config, 'mdblist');
  if (!apiKey) return [];

  const { cacheWrapGlobal, classifyResultAllowEmpty } = require('../getCache');
  const keyHash = createHash('sha256').update(apiKey).digest('hex').substring(0, 16);
  try {
    return await cacheWrapGlobal(
      `jellyfin_upcoming_mdblist_v3:${keyHash}:${days}`,
      async () => {
        const { fetchMDBListUpcoming } = require('../../utils/mdbList');
        const out: UpcomingRow[] = [];
        for (const item of await fetchMDBListUpcoming(apiKey, days)) {
          const season = Number(item?.next_episode?.season);
          const episode = Number(item?.next_episode?.episode);
          if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;
          const resolved = await videoIdFor(item?.show?.ids ?? {}, season, episode, config);
          if (!resolved) continue;
          // Numbered as Next Up numbers them: anime by its own video, the rest by season and episode.
          out.push({
            metaId: resolved.metaId,
            mediaType: resolved.mediaType,
            videoId: resolved.mediaType === 'anime' ? resolved.videoId : null,
            season: resolved.mediaType === 'anime' ? null : season,
            episode,
            airsAt: Date.parse(item?.next_episode?.air_date ?? '') || null,
          });
        }
        return out;
      },
      envInt('JELLYFIN_UPCOMING_TTL', 6 * 60 * 60, 60),
      { upstream: true }
    );
  } catch (error: any) {
    logger.warn(`MDBList upcoming failed: ${error?.message || error}`);
    return [];
  }
}

// The newest play of a show seeds Next Up, which moves on from it.
export interface PmdbData {
  rows: any[];
  droppedItems: any[];
  droppedUnread: boolean;
}

export async function fetchPmdbDropped(apiKey: string): Promise<{ items: any[]; unread: boolean }> {
  const { fetchDropped } = require('../../utils/publicmetadbUtils');
  const maxPages = envInt('JELLYFIN_WATCHED_MAX_PAGES', 50, 1);
  const items: any[] = [];
  try {
    for (let page = 1; page <= maxPages; page += 1) {
      const result = await fetchDropped(apiKey, page, 100);
      items.push(...result.items);
      if (page >= result.totalPages || !result.items.length) break;
    }
    return { items, unread: false };
  } catch (error: any) {
    logger.warn(`PublicMetaDB dropped shows failed: ${error?.message || error}`);
    return { items, unread: true };
  }
}

/** A user's PublicMetaDB plays and drops made into a snapshot; plays newest first. */
export async function assemblePmdb(data: PmdbData, config: any): Promise<RawSnapshot> {
  const { rows, droppedItems, droppedUnread } = data;
  const { Resolutions } = require('./resolutions');
  const resolutions = new Resolutions();
  await resolutions.preload(
    rows.filter((row: any) => row?.tmdb_id && row.media_type !== 'movie').map((row: any) => [{ tmdb: row.tmdb_id }, Number(row?.season), Number(row?.episode)]),
    rows.filter((row: any) => row?.tmdb_id && row.media_type === 'movie').map((row: any) => row.tmdb_id)
  );
  if (!rows.length) logger.debug('No watched history on PublicMetaDB');

  const episodes = new Set<string>();
  const movies = new Set<string>();
  const seen = new Map<string, number>();
  const series = new Map<string, { watched: number; total: number; at?: number }>();
  const latest = new Map<string, { row: any; at: number }>();
  const history = new Map<string, HistoryEntry>();
  const followedSince = Date.now() - envInt('JELLYFIN_NEXTUP_OWN_DAYS', 120, 1) * 24 * 60 * 60 * 1000;

  for (const row of rows) {
    if (!row?.tmdb_id) continue;
    const at = Date.parse(row?.watched_at ?? '') || 0;
    if (row.media_type === 'movie') {
      const base = await resolutions.movie(row.tmdb_id, config);
      movies.add(base);
      movies.add(`tmdb:${row.tmdb_id}`);
      if (at) {
        seen.set(base, at);
        seen.set(`tmdb:${row.tmdb_id}`, at);
      }
      recordWatch(history, { kind: 'movie', id: base, mediaType: 'movie', at });
      continue;
    }
    const season = Number(row?.season);
    const episode = Number(row?.episode);
    if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;
    const resolved = await resolutions.episode({ tmdb: row.tmdb_id }, season, episode, config);
    if (!resolved) continue;
    if (episodes.has(resolved.videoId)) continue;
    episodes.add(resolved.videoId);
    if (at) seen.set(resolved.videoId, at);
    recordWatch(history, { kind: 'episode', id: resolved.videoId, metaId: resolved.metaId, mediaType: resolved.mediaType, at });

    const counts = series.get(resolved.metaId) ?? { watched: 0, total: 0 };
    counts.watched += 1;
    series.set(resolved.metaId, counts);

    const held = latest.get(resolved.metaId);
    if (!held || at > held.at) latest.set(resolved.metaId, { row: { ...resolved, season, episode }, at });
  }

  const nextUp: NextUpRow[] = [];
  const following: Array<{ metaId: string; mediaType: 'anime' | 'series' }> = [];
  for (const [metaId, { row, at }] of latest) {
    nextUp.push({
      metaId,
      videoId: row.mediaType === 'anime' ? row.videoId : null,
      season: row.mediaType === 'anime' ? null : row.season,
      episode: row.mediaType === 'anime' ? Number(String(row.videoId).split(':').pop()) : row.episode,
      mediaType: row.mediaType,
      lastWatchedAt: at,
    });
    if (at >= followedSince) following.push({ metaId, mediaType: row.mediaType });
  }

  const dropped = new Set<string>();
  for (const item of droppedItems) {
    if (item?.tmdb_id && (item?.media_type ?? 'tv') === 'tv') for (const key of await droppedKeys({ tmdb: item.tmdb_id }, config)) dropped.add(key);
  }

  await resolutions.save();

  return {
    episodes: [...episodes],
    movies: [...movies],
    history: newestFirst(history),
    at: [...seen],
    series: [...series],
    nextUp: nextUp.sort((a, b) => b.lastWatchedAt - a.lastWatchedAt),
    following,
    dropped: [...dropped],
    droppedUnread,
  };
}

// A request answers from the snapshot held here and a refresh follows behind it, so a
// tracker slow to answer never holds up a client; only the first read waits on one.
const served = new LRUCache<string, { snapshot: WatchedSnapshot; at: number }>({
  max: envInt('JELLYFIN_WATCHED_CACHE_MAX', 200, 1),
});
const refreshing = new Set<string>();

/** The tracker credential a snapshot is read with, hashed, which invalidation also knows. */
function sourceHash(service: string, credential: string): string {
  return createHash('sha256').update(`${service}:${credential}`).digest('hex').substring(0, 16);
}

function servedKey(userUUID: string, config: any): string | null {
  const service = sourceFor(config);
  const credential = service ? credentialFor(config, service) : undefined;
  if (!userUUID || !service || !credential) return null;
  const { profileKey } = require('./profiles');
  return `${sourceHash(service, credential)}:${userUUID}:${profileKey(config)}`;
}

async function readAndFollow(userUUID: string, config: any): Promise<WatchedSnapshot> {
  const snapshot = await readWatchedSnapshot(userUUID, config);
  // Titles unmarked on the tracker are cleared here behind the answer, not before it.
  if (snapshot.fingerprint) {
    followTrackerUnmarks(userUUID, config, snapshot).catch(() => undefined);
  }
  return snapshot;
}

function refreshServed(key: string, userUUID: string, config: any): void {
  if (refreshing.has(key)) return;
  refreshing.add(key);
  readAndFollow(userUUID, config)
    .then((snapshot) => served.set(key, { snapshot, at: Date.now() }))
    .catch((error: any) => logger.debug(`Watched snapshot refresh failed for ${userUUID}: ${error?.message || error}`))
    .finally(() => refreshing.delete(key));
}

const firstReads = new Map<string, Promise<WatchedSnapshot>>();

function firstRead(key: string, userUUID: string, config: any): Promise<WatchedSnapshot> {
  let pending = firstReads.get(key);
  if (!pending) {
    pending = readAndFollow(userUUID, config)
      .then((snapshot) => {
        served.set(key, { snapshot, at: Date.now() });
        return snapshot;
      })
      .finally(() => firstReads.delete(key));
    pending.catch(() => undefined);
    firstReads.set(key, pending);
  }
  return pending;
}

async function withinFirstWait(key: string, userUUID: string, config: any): Promise<WatchedSnapshot> {
  const reading = firstRead(key, userUUID, config);
  const waitMs = envInt('JELLYFIN_WATCHED_FIRST_WAIT', 8, 0) * 1000;
  if (waitMs <= 0) return reading;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
  const first = await Promise.race([reading, late]).finally(() => clearTimeout(timer));
  if (first) return first;
  logger.info(`Watched state for ${userUUID} is still being read from the tracker after ${waitMs}ms; answering without it meanwhile`);
  return EMPTY;
}

export function warmChangedSources(userUUID: string, before: any, after: any): void {
  if (!userUUID || !after) return;
  const { holderCards } = require('../accounts');
  const { scopeConfigToProfile } = require('./profiles');
  const views = (config: any): any[] => [
    { ...config, userUUID },
    ...holderCards(config).map((card: any) => ({ ...scopeConfigToProfile(config, userUUID, card.id), userUUID })),
  ];
  const known = new Set(before ? views(before).map((config) => servedKey(userUUID, config)).filter(Boolean) : []);
  for (const config of views(after)) {
    const key = servedKey(userUUID, config);
    if (!key || known.has(key) || served.has(key) || firstReads.has(key)) continue;
    logger.debug(`Reading a newly connected tracker account for ${userUUID} ahead of its first shelf`);
    firstRead(key, userUUID, config).catch((error: any) => logger.debug(`Early tracker read failed for ${userUUID}: ${error?.message || error}`));
  }
}

export async function watchedSnapshot(userUUID: string, config: any, opts: { patient?: boolean } = {}): Promise<WatchedSnapshot> {
  const key = servedKey(userUUID, config);
  let snapshot: WatchedSnapshot;
  const held = key ? served.get(key) : undefined;
  if (held) {
    snapshot = held.snapshot;
    if (Date.now() - held.at >= envInt('JELLYFIN_WATCHED_REFRESH', 30, 5) * 1000) refreshServed(key!, userUUID, config);
  } else if (!key) {
    snapshot = await readAndFollow(userUUID, config);
  } else {
    snapshot = opts.patient ? await firstRead(key, userUUID, config) : await withinFirstWait(key, userUUID, config);
  }

  // Kept out of what is held: a drop made here shows on the next read.
  const { dropsKeptHere, localDrops } = require('./dropped');
  if (!userUUID || !dropsKeptHere(config)) return snapshot;
  const local: Set<string> = await localDrops(userUUID, config);
  return local.size ? { ...snapshot, dropped: new Set([...snapshot.dropped, ...local]) } : snapshot;
}

const unmarksFollowed = new LRUCache<string, string>({ max: envInt('JELLYFIN_WATCHED_CACHE_MAX', 200, 1) });
const unmarksInFlight = new Map<string, Promise<void>>();

// A title that left the tracker's list since the last read was unmarked there.
async function followTrackerUnmarks(userUUID: string, config: any, snapshot: WatchedSnapshot): Promise<void> {
  const service = sourceFor(config);
  const credential = service ? credentialFor(config, service) : undefined;
  if (!service || !credential) return;

  const { profileKey } = require('./profiles');
  const profile = profileKey(config);
  const source = createHash('sha256').update(`${service}:${credential}`).digest('hex').substring(0, 16);
  const key = `${userUUID}:${profile}:${source}`;
  if (unmarksFollowed.get(key) === snapshot.fingerprint) return;

  const running = unmarksInFlight.get(key);
  if (running) return running;
  const started = (async () => {
    try {
      await reconcileUnmarks(userUUID, profile, service, key, config, snapshot);
      unmarksFollowed.set(key, snapshot.fingerprint);
    } catch (error: any) {
      logger.debug(`Tracker unmarks not followed for ${userUUID}: ${error?.message || error}`);
    } finally {
      unmarksInFlight.delete(key);
    }
  })();
  unmarksInFlight.set(key, started);
  return started;
}

async function reconcileUnmarks(userUUID: string, profile: string, service: string, key: string, config: any, snapshot: WatchedSnapshot): Promise<void> {
  const database: any = require('../database');
  if (!(await database.listPlayedVideoIds(userUUID, 1, profile)).length) return;

  const whole = await allWatched(snapshot);
  const ids = [...whole.episodes, ...whole.movies];
  if (!ids.length) return;

  const { readGlobalCache, writeGlobalCache } = require('../getCache');
  const storeKey = `jellyfin_tracker_seen_v1:${key}`;
  const held = await readGlobalCache(storeKey);
  if (held?.fingerprint === snapshot.fingerprint) return;

  if (Array.isArray(held?.ids)) {
    const cleared = await clearUnmarked(userUUID, profile, config, held.ids, Number(held.seenAt) || 0, new Set(ids));
    if (cleared) {
      const { invalidateResume } = require('./resume');
      invalidateResume(userUUID);
      logger.info(`${cleared} title(s) unmarked on ${service} cleared from the playstate of ${userUUID}`);
    }
  }
  await writeGlobalCache(storeKey, { fingerprint: snapshot.fingerprint, seenAt: Date.now(), ids }, envInt('JELLYFIN_TRACKER_SEEN_DAYS', 30, 1) * 24 * 60 * 60);
}

async function clearUnmarked(userUUID: string, profile: string, config: any, before: string[], seenAt: number, current: Set<string>): Promise<number> {
  const gone = before.filter((id) => !current.has(id));
  if (!gone.length) return 0;
  // A list that lost most of itself is a short read, not a user's doing.
  if (gone.length > Math.max(10, before.length / 2)) {
    logger.warn(`Tracker history for ${userUUID} lost ${gone.length} of ${before.length} titles at once; not treated as unmarks`);
    return 0;
  }

  const database: any = require('../database');
  const { parseStremioId } = require('./ids');
  const { videoIdAliases } = require('./aliases');
  let cleared = 0;
  for (const id of gone) {
    const parsed = parseStremioId(id);
    const isEpisode = Boolean(parsed && parsed.episode !== null && parsed.episode !== undefined);
    const spellings = [id, ...(isEpisode ? await videoIdAliases(id) : await movieSpellings(id, config))];
    if (spellings.some((spelling) => current.has(spelling))) continue;

    const rows = [...(await database.getPlaystates(userUUID, spellings, profile)).values()].filter((row: any) => row.played);
    if (!rows.length) continue;
    if (rows.some((row: any) => Number(row.position_ms) > 0 || Number(row.last_played_at) > seenAt)) continue;

    for (const row of rows) {
      await database.upsertPlaystate(userUUID, row.video_id, { positionMs: 0, played: false, lastPlayedAt: null }, profile);
    }
    cleared += 1;
  }
  return cleared;
}

async function movieSpellings(id: string, config: any): Promise<string[]> {
  try {
    const { resolveAllIds } = require('../id-resolver');
    const ids = await resolveAllIds(id, 'movie', config, {}, [id.startsWith('tmdb:') ? 'imdb' : 'tmdb']);
    return [ids?.imdbId, ids?.tmdbId ? `tmdb:${ids.tmdbId}` : null].filter((spelling): spelling is string => Boolean(spelling) && spelling !== id);
  } catch {
    return [];
  }
}

/**
 * A watch or an unwatch made here goes into the watch index at once, rather than waiting
 * for the tracker to take it and the mirror to follow; the next build from the mirror
 * replaces it with what the tracker then holds.
 */
export async function applyLocalWatch(
  config: any,
  change: { videoId: string; metaId: string; kind: 'movie' | 'episode'; played: boolean }
): Promise<void> {
  try {
    const service = sourceFor(config);
    const credential = service ? credentialFor(config, service) : undefined;
    if (!service || !credential) return;
    const { sourceKeyFor } = require('./trackerMirror');
    const source = sourceKeyFor(service, credential);
    const database: any = require('../database');

    const had = (await database.watchIndexAmong(source, [change.videoId])).length > 0;
    if (change.played === had) return;
    if (change.played) {
      await database.upsertWatchIndex(source, [{
        video_id: change.videoId,
        kind: change.kind,
        meta_id: change.kind === 'episode' ? change.metaId : change.videoId,
        media_type: change.kind === 'movie' ? 'movie' : change.videoId.startsWith('kitsu:') ? 'anime' : 'series',
        at: Date.now(),
        listed: 1,
      }]);
    } else {
      await database.deleteWatchIndex(source, [change.videoId]);
    }
    if (change.kind !== 'episode') return;
    const counts = (await database.watchSeriesAmong(source, [change.metaId]))[0];
    if (!counts) return;
    const watched = Math.max(0, Math.min(counts.total, counts.watched + (change.played ? 1 : -1)));
    await database.upsertWatchSeries(source, [{ series_key: change.metaId, group_key: counts.group_key, watched, total: counts.total, at: Date.now() }]);
  } catch (error: any) {
    logger.debug(`Could not record the local watch in the watch index: ${error?.message || error}`);
  }
}

export async function invalidateWatched(config: any): Promise<void> {
  const service = sourceFor(config);
  if (!service) return;

  const credential = credentialFor(config, service);
  if (!credential) return;

  // What this server just changed must show on the next read, not after a refresh.
  const prefix = `${sourceHash(service, credential)}:`;
  for (const key of [...served.keys()]) {
    if (String(key).startsWith(prefix)) served.delete(key);
  }

  try {
    if (service === 'anilist' || service === 'mal') {
      const { animeListCacheKey } = require('./trackerMirror');
      const redis: any = require('../redisClient');
      if (redis) await redis.del(`global:${animeListCacheKey(service, credential)}`);
      return;
    }
    let seed = credential;
    if (service === 'simkl') {
      const { getSimklToken } = require('../../utils/simklUtils');
      const token = await getSimklToken(credential);
      if (!token?.access_token) return;
      seed = token.access_token;
    }

    const keyHash = createHash('sha256').update(seed).digest('hex').substring(0, 16);

    // An upstream key is stored as global:<key>, so it is deleted by name; a
    // pattern with a leading wildcard walked the whole keyspace per watch.
    const name = service === 'simkl'
      ? `simkl-api-last-activities:${keyHash}`
      : service === 'publicmetadb'
        ? `pmdb_watched_head:${keyHash}`
        : `mdblist_last_activities:${keyHash}`;
    const redis: any = require('../redisClient');
    if (redis) await redis.del(`global:${name}`);
  } catch (error: any) {
    logger.debug(`Could not invalidate the watched snapshot: ${error?.message || error}`);
  }
}


/**
 * Fills in watch state on items already built. Identity comes back out of the
 * item's own guid, so this stays one pass over a finished list rather than a
 * parameter threaded through every builder.
 */
function airedFrom(videos: any[]): string[] {
  const now = Date.now();
  const dates = videos.some((v: any) => Number(v?.season) !== 0 && Number.isFinite(Date.parse(v?.released ?? v?.firstAired ?? '')));
  return videos
    .filter((v: any) => {
      if (Number(v?.season) === 0) return false;
      const at = Date.parse(v?.released ?? v?.firstAired ?? '');
      if (!Number.isFinite(at)) return !dates;
      return at <= now;
    })
    .map((v: any) => String(v?.id ?? ''))
    .filter(Boolean);
}

/**
 * A show's aired episode ids from the episode index, or null when it is not held.
 * A listing never builds one: that is a full meta read per show on the page, all
 * competing with the page itself. Opening the show stores it.
 */
async function airedEpisodeIds(userUUID: string, descriptor: any): Promise<string[] | null> {
  const { seriesIndex } = require('./episodeIndex');
  const indexed = await seriesIndex(userUUID, String(descriptor.i), { held: true }).catch(() => null);
  return indexed ? airedFrom(Array.isArray(indexed.videos) ? indexed.videos : []) : null;
}

const ownPlayedMemo = new LRUCache<string, Set<string>>({
  max: envInt('JELLYFIN_RESUME_CACHE_MAX', 500, 1),
  ttl: envInt('JELLYFIN_RESUME_TTL', 60, 1) * 1000,
});

async function ownPlayedEpisodes(userUUID: string, profile: string): Promise<Set<string>> {
  const key = `${userUUID}:${profile}:${generationOf(userUUID)}`;
  const held = ownPlayedMemo.get(key);
  if (held) return held;
  const played = new Set<string>();
  try {
    const database: any = require('../database');
    const ids = await database.listPlayedVideoIds(userUUID, envInt('JELLYFIN_OWN_PLAYED_LIMIT', 20000, 100), profile);
    for (const id of ids) if (/:\d+:\d+$/.test(id)) played.add(id);
  } catch {
    return played;
  }
  ownPlayedMemo.set(key, played);
  return played;
}

export async function applyWatchedState(
  items: any[],
  snapshot: WatchedSnapshot,
  userUUID?: string,
  profile = '',
  config?: any
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
      const { getPlaystatesAcross } = require('./aliases');
      own = await getPlaystatesAcross(userUUID, videoIds, profile);
    } catch {
      own = new Map();
    }
  }

  const { trackerPositions, trackerPositionWins } = require('./resume');
  const paused: Map<string, any> = userUUID && config && [...descriptors.values()].some((d) => d.k === 'movie' || d.k === 'episode')
    ? await trackerPositions(userUUID, config).catch(() => new Map())
    : new Map();

  const ownPlayed = userUUID && [...descriptors.values()].some((d) => d.k === 'series')
    ? await ownPlayedEpisodes(userUUID, profile)
    : new Set<string>();

  // The page's titles are asked of the watch index together: each film and episode, the
  // series counts, then each held show's aired episodes, other spellings only for a miss.
  const seriesDescriptors = [...descriptors.values()].filter((d) => d.k === 'series');
  const seriesCounts = await seriesCountsAmong(snapshot, seriesDescriptors.map((d) => String(d.i)));
  const airedBySeries = new Map<string, string[] | null>();
  if (userUUID) {
    await Promise.all(seriesDescriptors.map(async (d) => {
      if (seriesCounts.has(String(d.i)) || ownPlayed.size) airedBySeries.set(String(d.i), await airedEpisodeIds(userUUID, d));
    }));
  }
  const direct = [
    ...[...descriptors.values()].filter((d) => d.k === 'movie' || d.k === 'episode').map((d) => stremioIdFor(d)).filter(Boolean) as string[],
    ...[...airedBySeries.values()].flatMap((ids) => ids ?? []),
  ];
  const watched = await watchedAmong(snapshot, direct);
  const aliasesOf = new Map<string, string[]>();
  const { videoIdAliases } = require('./aliases');
  for (const videoId of new Set([...airedBySeries.values()].flatMap((ids) => ids ?? []))) {
    if (!watched.has(videoId) && !ownPlayed.has(videoId)) aliasesOf.set(videoId, await videoIdAliases(videoId));
  }
  for (const [id, at] of await watchedAmong(snapshot, [...aliasesOf.values()].flat())) watched.set(id, at);
  const playedUnderAnySpelling = (videoId: string): boolean =>
    watched.has(videoId) || ownPlayed.has(videoId) || (aliasesOf.get(videoId) ?? []).some((alias) => watched.has(alias) || ownPlayed.has(alias));

  await Promise.all(
    items.map(async (item: any) => {
      const descriptor = descriptors.get(String(item?.Id));
      if (!descriptor) return;

      if (descriptor.k === 'series') {
        const { itemKeys } = require('./dropped');
        if (snapshot.dropped.size && itemKeys(item, String(descriptor.i)).some((key: string) => snapshot.dropped.has(key))) {
          item.UserData = { ...item.UserData, Likes: false };
        }
        const held = seriesCounts.get(String(descriptor.i));
        const counts = held ?? (ownPlayed.size ? { watched: 0, total: 0 } : null);
        if (!counts) return;
        // The show's aired episodes are the whole, specials and what has not
        // aired left out; a tracker's own counts stand in only when the meta
        // has none. Without either nothing is claimed, since zero unplayed
        // reads as fully watched.
        const aired = userUUID ? airedBySeries.get(String(descriptor.i)) ?? null : [];
        const total = aired?.length || counts.total;
        if (total <= 0) return;
        const watchedCount = aired?.length
          ? aired.filter((videoId) => playedUnderAnySpelling(videoId)).length
          : Math.min(counts.watched, total);
        if (!watchedCount && !held) return;
        const unplayed = Math.max(0, total - watchedCount);
        item.UserData = {
          ...item.UserData,
          UnplayedItemCount: unplayed,
          Played: unplayed === 0,
          PlayedPercentage: Math.min(100, (watchedCount / total) * 100),
        };
        return;
      }

      const stremioId = stremioIdFor(descriptor);
      if (!stremioId) return;

      const record = own.get(stremioId);
      // The most recent action wins: a watch the tracker dates after this row's
      // last change was made elsewhere since, so it answers instead of the row.
      const trackerAt = watched.get(stremioId) ?? 0;
      const pause = paused.get(stremioId);
      if (pause && pause.updatedAt > trackerAt && trackerPositionWins(pause, record)) {
        const runtime = Number(item.RunTimeTicks) || (pause.runtimeMinutes ? pause.runtimeMinutes * 60 * 1000 * 10000 : 0);
        const played = Boolean(record?.played) || watched.has(stremioId);
        item.UserData = {
          ...item.UserData,
          Played: played,
          PlayCount: Math.max(played ? 1 : 0, Number(record?.play_count) || 0),
          PlaybackPositionTicks: Math.round((runtime * pause.progress) / 100),
          PlayedPercentage: pause.progress,
          LastPlayedDate: new Date(pause.updatedAt).toISOString(),
        };
        return;
      }
      if (record && trackerAt > (Number(record.updated_at) || 0)) {
        item.UserData = {
          ...item.UserData,
          Played: true,
          PlayCount: Math.max(1, Number(record.play_count) || 0),
          PlaybackPositionTicks: 0,
          PlayedPercentage: 100,
          LastPlayedDate: new Date(trackerAt).toISOString(),
        };
        return;
      }
      if (record) {
        const runtime = Number(record.runtime_ms) || Number(item.RunTimeTicks || 0) / 10000;
        const position = Number(record.position_ms) || 0;
        // A position on a finished title is a rewatch under way.
        item.UserData = {
          ...item.UserData,
          Played: Boolean(record.played),
          PlayCount: Number(record.play_count) || 0,
          PlaybackPositionTicks: Math.round(position * 10000),
          PlayedPercentage: position > 0 && runtime > 0 ? (position / runtime) * 100 : record.played ? 100 : 0,
          ...(record.last_played_at ? { LastPlayedDate: new Date(Number(record.last_played_at)).toISOString() } : {}),
        };
        return;
      }

      if (!watched.has(stremioId)) return;
      item.UserData = { ...item.UserData, Played: true, PlayCount: 1 };
    })
  );

  if (userUUID && config) {
    const { applyWatchlistState } = require('./watchlist');
    await applyWatchlistState(items, userUUID, config, descriptors).catch((error: any) =>
      logger.debug(`Watchlist state unavailable: ${error?.message || error}`)
    );
  }
}
