import crypto from 'crypto';
// @ts-ignore
import { cacheWrapGlobal } from '../lib/getCache';
// @ts-ignore
import { httpGet } from './httpClient';
// @ts-ignore
import { consola } from 'consola';

const logger = consola.withTag('mdblist-utils');

async function fetchMdblistLastActivities(apiKey: string): Promise<any> {
  const url = `https://api.mdblist.com/sync/last_activities?apikey=${apiKey}`;
  const response = await httpGet(url, {
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'AioMetadata/1.0' }
  });
  return response?.data || {};
}

export async function getMdblistWatchedIds(config: any): Promise<{ movieImdbIds: Set<string>, showImdbIds: Set<string>, tmdbIds: Set<number>, mdblistIds: Set<string> } | null> {
  try {
    const mdblist = config.apiKeys?.mdblist;
    if (!mdblist) return null;

    const keyHash = crypto.createHash('sha256').update(mdblist).digest('hex').substring(0, 16);

    const activitiesCacheKey = `mdblist_activities:${keyHash}`;
    const activities = await cacheWrapGlobal(activitiesCacheKey, async () => {
      return await fetchMdblistLastActivities(mdblist);
    }, 300);

    const watchedAt = activities?.watched_at || '';
    const episodeWatchedAt = activities?.episode_watched_at || '';
    const fingerprint = crypto.createHash('sha256')
      .update(`${watchedAt}:${episodeWatchedAt}`)
      .digest('hex')
      .substring(0, 16);

    const watchedCacheKey = `mdblist_watched_ids:${keyHash}:${fingerprint}`;
    const watchedData = await cacheWrapGlobal(watchedCacheKey, async () => {
      const movieImdbIds: string[] = [];
      const tmdbIds: number[] = [];
      const mdblistIds: string[] = [];

      const showAiredMap = new Map<string, number>();
      const showIdsMap = new Map<string, { imdb?: string, tmdb?: number, mdblist?: string }>();
      const showWatchedEpisodes = new Map<string, Set<string>>();

      let offset = 0;
      const limit = 1000;
      let hasMore = true;

      while (hasMore) {
        const url = `https://api.mdblist.com/sync/watched?apikey=${mdblist}&offset=${offset}&limit=${limit}`;
        const response = await httpGet(url, {
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'AioMetadata/1.0' }
        });

        if (response && response.data) {
          const { movies = [], shows = [], episodes = [], pagination } = response.data;

          for (const item of movies) {
            if (item.movie?.ids?.imdb) movieImdbIds.push(item.movie.ids.imdb);
            if (item.movie?.ids?.tmdb) tmdbIds.push(item.movie.ids.tmdb);
            if (item.movie?.ids?.mdblist) mdblistIds.push(item.movie.ids.mdblist);
          }

          for (const item of shows) {
            const imdbId = item.show?.ids?.imdb;
            if (imdbId) {
              showAiredMap.set(imdbId, item.show.total_aired_episodes || 0);
              showIdsMap.set(imdbId, item.show.ids);
            }
          }

          for (const item of episodes) {
            const imdbId = item.episode?.show?.ids?.imdb;
            if (imdbId) {
              if (!showWatchedEpisodes.has(imdbId)) {
                showWatchedEpisodes.set(imdbId, new Set());
              }
              const epKey = `S${String(item.episode.season).padStart(2, '0')}E${String(item.episode.number).padStart(2, '0')}`;
              showWatchedEpisodes.get(imdbId)?.add(epKey);

              if (!showIdsMap.has(imdbId)) {
                showIdsMap.set(imdbId, item.episode.show.ids);
              }
            }
          }

          hasMore = pagination?.has_more || false;
          offset += limit;
        } else {
          hasMore = false;
        }
      }

      const finalShowImdbIds: string[] = [];
      for (const [imdbId, watchedSet] of showWatchedEpisodes.entries()) {
        const airedCount = showAiredMap.get(imdbId) || 0;
        const watchedCount = watchedSet.size;

        if (airedCount > 0 && watchedCount >= airedCount) {
          finalShowImdbIds.push(imdbId);
          const ids = showIdsMap.get(imdbId);
          if (ids?.tmdb) tmdbIds.push(ids.tmdb);
          if (ids?.mdblist) mdblistIds.push(ids.mdblist);
        }
      }

      logger.info(`[Watched IDs] MDBList sync complete: ${movieImdbIds.length} movies, ${finalShowImdbIds.length} shows fully watched.`);
      return {
        movieImdbIds,
        showImdbIds: finalShowImdbIds,
        tmdbIds,
        mdblistIds
      };
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
