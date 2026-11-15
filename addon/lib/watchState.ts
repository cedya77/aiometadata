// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { createHash } from 'crypto';
import { envInt } from '../utils/envNumber';

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

/**
 * What this addon knows about the user's viewing, in the shape the reader
 * expects: in-progress rows from the trackers and this server's own table, the
 * watched library from the tracker the shelves read, and the watchlist the
 * favourites come from. `watched` is left out when the reader already holds
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
  const watchlist = held?.complete
    ? held.entries.map((entry: any) => ({
        type: entryItemType(entry) === 'Movie' ? ('movie' as const) : ('series' as const),
        metaId: entry.metaId,
        ...(entry.addedAt > 0 ? { at: seconds(entry.addedAt) } : {}),
      }))
    : undefined;

  const service = sourceFor(config) ?? 'none';
  const snapshot = await watchedSnapshot(userUUID, config, { patient: true });
  // Drops kept here move no tracker's fingerprint, so they are folded in or a new one would never be sent.
  const kept = dropsKeptHere(config) ? [...(await localDrops(userUUID, config))].sort().join(',') : '';
  const version = snapshot.fingerprint
    ? createHash('sha256').update(`${service}|${snapshot.fingerprint}${kept ? `|${kept}` : ''}`).digest('hex').slice(0, 16)
    : '';

  if (!version || since === version) return { version, items, ...(watchlist ? { watchlist } : {}) };

  const { allWatched, allSeriesCounts } = require('./jellyfin/watched');
  const whole = await allWatched(snapshot);
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
      nextUp: snapshot.nextUp.map((row: any) => ({
        type: 'series' as const,
        metaId: row.metaId,
        videoId: row.videoId || (row.season === null ? `${row.metaId}:${row.episode}` : `${row.metaId}:${row.season}:${row.episode}`),
        season: row.season,
        episode: row.episode,
        at: seconds(row.lastWatchedAt),
      })),
      ...(snapshot.droppedUnread ? {} : { dropped: [...snapshot.dropped] }),
    },
    ...(watchlist ? { watchlist } : {}),
  };
}
