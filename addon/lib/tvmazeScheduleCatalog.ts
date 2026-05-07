import consola from 'consola';
import * as tvmaze from './tvmaze.js';
import { resolveAllIds } from './id-resolver.js';
import { getMeta } from './getMeta.js';
import { cacheWrapMetaSmart } from './getCache.js';
import type { UserConfig, MetaData } from '../types/index.js';

interface TvmazeScheduleShow {
  id?: number | string;
  type?: string;
}

interface TvmazeScheduleEntry {
  airstamp?: string;
  show?: TvmazeScheduleShow;
}

interface TvmazeScheduleCatalogOptions {
  date: string;
  country?: string;
  page?: number;
  pageSize?: number;
  language?: string;
  config?: UserConfig;
  userUUID: string;
  includeVideos?: boolean;
  enableErrorCaching?: boolean;
  maxRetries?: number;
}

interface TvmazeScheduleCatalogResult {
  metas: MetaData[];
}

async function getTvmazeScheduleCatalog({
  date,
  country = '',
  page = 1,
  pageSize = 20,
  language = 'en-US',
  config = {},
  userUUID,
  includeVideos = false,
  enableErrorCaching = true,
  maxRetries = 2,
}: TvmazeScheduleCatalogOptions): Promise<TvmazeScheduleCatalogResult> {
  const scheduleEntries = await tvmaze.getFullSchedule(date, country) as TvmazeScheduleEntry[];

  if (!Array.isArray(scheduleEntries) || scheduleEntries.length === 0) {
    return { metas: [] };
  }

  const filteredEntries = scheduleEntries.filter((entry) => {
    const showType = entry?.show?.type;
    return showType && showType.toLowerCase() !== 'news' && showType.toLowerCase() !== 'talk show';
  });

  const uniqueByShow = new Map<string | number, TvmazeScheduleEntry>();
  for (const entry of filteredEntries) {
    const showId = entry?.show?.id;
    if (!showId || uniqueByShow.has(showId)) continue;
    uniqueByShow.set(showId, entry);
  }

  const dedupedEntries = Array.from(uniqueByShow.values()).sort((a, b) => {
    const timeA = a?.airstamp ? new Date(a.airstamp).getTime() : 0;
    const timeB = b?.airstamp ? new Date(b.airstamp).getTime() : 0;
    return timeA - timeB;
  });

  const resolveScheduleEntryMeta = async (entry: TvmazeScheduleEntry): Promise<MetaData | null> => {
    const show = entry?.show;
    if (!show?.id) return null;

    let stremioId = `tvmaze:${show.id}`;
    try {
      const allIds = await resolveAllIds(stremioId, 'series', config);
      if (allIds) {
        if (allIds.imdbId) {
          stremioId = allIds.imdbId;
        } else if (allIds.tvdbId) {
          stremioId = `tvdb:${allIds.tvdbId}`;
        } else if (allIds.tmdbId) {
          stremioId = `tmdb:${allIds.tmdbId}`;
        }
      }
    } catch (e) {
      // Fallback to original TVMaze ID if resolution fails.
    }

    try {
      const result = await cacheWrapMetaSmart(userUUID, stremioId, async () => {
        return await getMeta('series', language, stremioId, config, userUUID, includeVideos);
      }, undefined, { enableErrorCaching, maxRetries, config }, 'series', includeVideos);

      return result?.meta || null;
    } catch (error: any) {
      consola.warn(`[TVMaze Schedule] Failed to fetch meta for schedule entry ${stremioId}: ${error.message}`);
      return null;
    }
  };

  const startIndex = (page - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  const pageEntries = dedupedEntries.slice(startIndex, endIndex);
  const metasFromSchedule = await Promise.all(pageEntries.map(resolveScheduleEntryMeta));

  return { metas: metasFromSchedule.filter((meta): meta is MetaData => Boolean(meta)) };
}

module.exports = { getTvmazeScheduleCatalog };
