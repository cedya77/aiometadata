// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import crypto from 'crypto';
// @ts-ignore
import { cacheWrapGlobal } from '../lib/getCache';
// @ts-ignore
import { consola } from 'consola';

const logger = consola.withTag('mdblist-utils');

/**
 * What the key's MDBList history says is watched: films, and shows with every aired
 * episode watched. Read from the watch mirror, which fetches only what changed since
 * its last sync, so a watch no longer re-reads the whole history.
 */
export async function getMdblistWatchedIds(config: any): Promise<{ movieImdbIds: Set<string>, showImdbIds: Set<string>, tmdbIds: Set<number>, mdblistIds: Set<string> } | null> {
  try {
    const mdblist = config.apiKeys?.mdblist;
    if (!mdblist) return null;

    const { syncMirror, mirrorVersion, mirrorRows, sourceKeyFor } = require('../lib/jellyfin/trackerMirror');
    let version: number;
    try {
      version = await syncMirror('mdblist', mdblist, config);
    } catch (error: any) {
      version = await mirrorVersion('mdblist', mdblist);
      if (!version) throw error;
      logger.warn(`[Watched IDs] MDBList sync failed, using the mirror as last synced: ${error?.message || error}`);
    }

    const watchedData = await cacheWrapGlobal(`mdblist_watched_ids_v2:${sourceKeyFor('mdblist', mdblist)}:v${version}`, async () => {
      const movieImdbIds: string[] = [];
      const tmdbIds: number[] = [];
      const mdblistIds: string[] = [];
      const episodesPerShow = new Map<string, number>();
      const shows = new Map<string, any>();

      for (const row of await mirrorRows('mdblist', mdblist)) {
        if (row.key.startsWith('movie:')) {
          const ids = row.data?.movie?.ids ?? {};
          if (ids.imdb) movieImdbIds.push(ids.imdb);
          if (ids.tmdb) tmdbIds.push(ids.tmdb);
          if (ids.mdblist) mdblistIds.push(ids.mdblist);
        } else if (row.key.startsWith('ep:')) {
          const show = row.key.split(':')[1];
          episodesPerShow.set(show, (episodesPerShow.get(show) ?? 0) + 1);
        } else if (row.key.startsWith('showinfo:')) {
          shows.set(row.key.slice('showinfo:'.length), row.data?.show ?? {});
        }
      }

      const showImdbIds: string[] = [];
      for (const [id, show] of shows) {
        const aired = Number(show?.total_aired_episodes) || 0;
        if (!show?.ids?.imdb || aired <= 0 || (episodesPerShow.get(id) ?? 0) < aired) continue;
        showImdbIds.push(show.ids.imdb);
        if (show.ids.tmdb) tmdbIds.push(show.ids.tmdb);
        if (show.ids.mdblist) mdblistIds.push(show.ids.mdblist);
      }

      logger.info(`[Watched IDs] MDBList: ${movieImdbIds.length} movies, ${showImdbIds.length} shows fully watched.`);
      return { movieImdbIds, showImdbIds, tmdbIds, mdblistIds };
    }, 86400);

    return {
      movieImdbIds: new Set(watchedData.movieImdbIds),
      showImdbIds: new Set(watchedData.showImdbIds),
      tmdbIds: new Set(watchedData.tmdbIds),
      mdblistIds: new Set(watchedData.mdblistIds)
    };
  } catch (err: any) {
    logger.warn(`[Watched IDs] Error fetching MDBList watched IDs: ${err.message}`);
    return null;
  }
}

/**
 * Instance owners rarely set a key of their own, since MDBList is paid past
 * 1000 calls a day, so in practice the supplied one is what answers.
 */
export function resolveMdblistKey(supplied: unknown): string {
  const value = String(supplied || '').trim();
  return value || process.env.MDBLIST_API_KEY || process.env.BUILT_IN_MDBLIST_API_KEY || '';
}

/** Keyed per api key, so one user's allowance never serves another's request. */
export function mdblistCacheKey(parts: string[], apikey: string): string {
  const fingerprint = crypto.createHash('sha256').update(String(apikey)).digest('hex').slice(0, 16);
  return `mdblist:${parts.join(':')}:${fingerprint}`;
}
