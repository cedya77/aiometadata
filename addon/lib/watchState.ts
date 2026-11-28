// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { createHash } from 'crypto';
import consola from 'consola';
import { envInt } from '../utils/envNumber';

const logger = consola.withTag('WatchState');

/** How long a reader may reuse an answer before asking again. */
export function watchStatePullTtl(): number {
  return envInt('WATCH_STATE_PULL_TTL', 300, 0);
}

export interface WatchStateItem {
  type: 'movie' | 'series';
  metaId: string;
  videoId: string;
  season: number | null;
  episode: number | null;
  progressPercent: number;
  positionMs?: number;
  durationMs?: number;
  played: boolean;
  at: number;
}

export interface WatchStatePull {
  version: string;
  items: WatchStateItem[];
  watched?: {
    movies: string[];
    episodes: string[];
    counts: Record<string, { watched: number; total: number; at?: number }>;
    nextUp: Array<{ type: 'series'; metaId: string; videoId: string; season: number | null; episode: number; at: number }>;
    dropped?: string[];
  };
  watchlist?: Array<{ type: 'movie' | 'series'; metaId: string; at?: number }>;
}

function seconds(ms: number): number {
  return Math.floor((Number(ms) || 0) / 1000);
}

/** The most ids one list may carry; past it the reader refuses the whole answer, so the list is left out. */
function maxWatched(): number {
  return envInt('WATCH_STATE_PULL_MAX_WATCHED', 50000, 1);
}

function fits(userUUID: string, what: string, size: number | string): boolean {
  if (typeof size === 'number' && size <= maxWatched()) return true;
  logger.warn(`Watch state for ${userUUID}: ${size} ${what} is past ${maxWatched()} (WATCH_STATE_PULL_MAX_WATCHED), so they are left out and the reader keeps what it has`);
  return false;
}

const nextUpOf = (row: any) => ({
  type: 'series' as const,
  metaId: row.metaId,
  videoId: row.videoId || (row.season === null ? `${row.metaId}:${row.episode}` : `${row.metaId}:${row.season}:${row.episode}`),
  season: row.season,
  episode: row.episode,
  at: seconds(row.lastWatchedAt),
});

/**
 * The watched library from this server's own records, for a profile that reads no tracker.
 * Every id a play was written under is listed, as a tracker's are, so the reader matches
 * whichever spelling its titles carry. Null when it is past what one answer may list.
 */
async function ownWatched(userUUID: string, config: any, drops: Set<string>): Promise<NonNullable<WatchStatePull['watched']> | null> {
  const database: any = require('./database');
  const { profileKey } = require('./jellyfin/profiles');
  const { parseStremioId } = require('./jellyfin/ids');
  const { ownNextUpRows } = require('./jellyfin/watched');
  const profile = profileKey(config);
  const limit = maxWatched();

  // Films and episodes are capped apart, so twice the cap and one more tells that one is past it.
  const rows: Array<{ video_id: string; at: number }> = await database.listPlayedWithTimes(userUUID, limit * 2 + 1, profile);
  if (rows.length > limit * 2) {
    fits(userUUID, 'played rows', `more than ${limit * 2}`);
    return null;
  }

  const movies = new Set<string>();
  const episodes = new Set<string>();
  const counts: Record<string, { watched: number; total: number; at?: number }> = {};
  for (const row of rows) {
    const parsed = parseStremioId(row.video_id);
    if (!parsed) continue;
    if (parsed.episode === null || parsed.episode === undefined) {
      movies.add(row.video_id);
      continue;
    }
    if (episodes.has(row.video_id)) continue;
    episodes.add(row.video_id);
    // A total this server does not know is sent as 0, as the reader allows.
    const count = (counts[parsed.base] ??= { watched: 0, total: 0 });
    count.watched++;
    const at = seconds(row.at);
    if (at > (count.at ?? 0)) count.at = at;
  }
  if (!fits(userUUID, 'watched films', movies.size) || !fits(userUUID, 'watched episodes', episodes.size) || !fits(userUUID, 'dropped shows', drops.size)) return null;

  const nextUp = await ownNextUpRows(userUUID, profile);
  return {
    movies: [...movies],
    episodes: [...episodes],
    counts,
    nextUp: nextUp.map(nextUpOf),
    dropped: [...drops],
  };
}

/**
 * What this addon knows about the user's viewing, in the shape the reader
 * expects: in-progress rows from the trackers and this server's own table, the
 * watched library from the tracker the shelves read (this server's own records
 * when they read none), and the watchlist the favourites come from. `watched` is left out when the reader already holds
 * this version, or when the source could not be read, since an empty block
 * would be taken as nothing ever watched. The watchlist and the drops are left
 * out the same way when any service behind them failed.
 */
export async function buildWatchStatePull(userUUID: string, config: any, since: string | null): Promise<WatchStatePull> {
  const { resumeSnapshot } = require('./jellyfin/resume');
  const { watchedSnapshot } = require('./jellyfin/watched');
  const { sourceFor } = require('./jellyfin/trackerSource');
  const { parseStremioId } = require('./jellyfin/ids');
  const { runtimeFromMeta } = require('./jellyfin/playstateSync');
  const { entryItemType, watchlistEntries } = require('./jellyfin/watchlist');
  const { dropsKeptHere, localDrops } = require('./jellyfin/dropped');

  const listed = watchlistEntries(userUUID, config).catch(() => null);

  const rows = await resumeSnapshot(userUUID, config);
  const items: WatchStateItem[] = [];
  for (const row of rows.slice(0, envInt('WATCH_STATE_PULL_ITEMS', 100, 1))) {
    const parsed = parseStremioId(row.videoId);
    const episode = row.kind === 'episode' && parsed ? Number(parsed.episode) : null;
    const season = row.kind === 'episode' && parsed && parsed.season !== null && parsed.season !== undefined ? Number(parsed.season) : null;

    // A percentage alone is not a position to a reader, so the runtime is
    // filled from the meta where the tracker sent none.
    const durationMs = (row.runtimeMinutes ?? 0) * 60000 || (await runtimeFromMeta(userUUID, row));
    items.push({
      type: row.kind === 'movie' ? 'movie' : 'series',
      metaId: row.metaId,
      videoId: row.videoId,
      season,
      episode,
      progressPercent: Math.round(row.progress * 10) / 10,
      ...(durationMs > 0 ? { positionMs: Math.round((durationMs * row.progress) / 100), durationMs } : {}),
      played: false,
      at: seconds(row.updatedAt),
    });
  }

  const held = await listed;
  const watchlist = held?.complete && fits(userUUID, 'watchlist titles', held.entries.length)
    ? held.entries.map((entry: any) => ({
        type: entryItemType(entry) === 'Movie' ? ('movie' as const) : ('series' as const),
        metaId: entry.metaId,
        ...(entry.addedAt > 0 ? { at: seconds(entry.addedAt) } : {}),
      }))
    : undefined;

  const tracker = sourceFor(config);
  const service = tracker ?? 'none';
  const drops: Set<string> = dropsKeptHere(config) ? await localDrops(userUUID, config) : new Set();
  // Drops kept here move no tracker's fingerprint, so they are folded in or a new one would never be sent.
  const kept = [...drops].sort().join(',');

  // No tracker behind the shelves: the library is this server's own records, versioned by their own changes.
  if (!tracker) {
    const { profileKey } = require('./jellyfin/profiles');
    const database: any = require('./database');
    const signal = await database.playedSignal(userUUID, profileKey(config)).catch(() => null);
    const version = signal
      ? createHash('sha256').update(`own:v1|${signal.count}|${signal.latest}${kept ? `|${kept}` : ''}`).digest('hex').slice(0, 16)
      : '';
    if (!version || since === version) return { version, items, ...(watchlist ? { watchlist } : {}) };
    const watched = await ownWatched(userUUID, config, drops).catch((error: any) => {
      logger.debug(`Own watched library unavailable for ${userUUID}: ${error?.message || error}`);
      return null;
    });
    return { version, items, ...(watched ? { watched } : {}), ...(watchlist ? { watchlist } : {}) };
  }

  const snapshot = await watchedSnapshot(userUUID, config, { patient: true });
  const version = snapshot.fingerprint
    ? createHash('sha256').update(`${service}|${snapshot.fingerprint}${kept ? `|${kept}` : ''}`).digest('hex').slice(0, 16)
    : '';

  if (!version || since === version) return { version, items, ...(watchlist ? { watchlist } : {}) };

  const { allWatched, allSeriesCounts } = require('./jellyfin/watched');
  const whole = await allWatched(snapshot);
  const dropped = snapshot.droppedUnread ? null : [...snapshot.dropped];
  if (!fits(userUUID, 'watched films', whole.movies.length) || !fits(userUUID, 'watched episodes', whole.episodes.length) || !fits(userUUID, 'dropped shows', dropped?.length ?? 0)) {
    return { version, items, ...(watchlist ? { watchlist } : {}) };
  }
  const counts: Record<string, { watched: number; total: number; at?: number }> = {};
  for (const [id, value] of await allSeriesCounts(snapshot)) {
    counts[id] = { watched: value.watched, total: value.total, ...(value.at ? { at: seconds(value.at) } : {}) };
  }

  return {
    version,
    items,
    watched: {
      movies: whole.movies,
      episodes: whole.episodes,
      counts,
      nextUp: snapshot.nextUp.map(nextUpOf),
      ...(dropped ? { dropped } : {}),
    },
    ...(watchlist ? { watchlist } : {}),
  };
}
