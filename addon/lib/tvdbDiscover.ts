import * as tvdb from './tvdb.js';
import type { TvdbFilterResult } from './tvdb.js';
import type { UserConfig } from '../types/index.js';

/**
 * TVDB has no native trending sort. Reuse the built-in catalog's recent-year
 * selection, keeping Discover filters and ranking the combined results before
 * callers paginate them. A requested year narrows, rather than replaces, the
 * current/previous-year window.
 */
export async function fetchTvdbDiscoverResults(
  type: 'movies' | 'series',
  params: Record<string, unknown>,
  config: UserConfig
): Promise<TvdbFilterResult[]> {
  if (params.sort !== 'trending') return tvdb.filter(type, params, config);

  const now = new Date();
  const currentYear = now.getFullYear();
  const requestedYear = Number(params.year);
  const years = [currentYear, currentYear - 1].filter(year =>
    params.year === undefined || params.year === null || params.year === '' || year === requestedYear
  );
  const queryParams: Record<string, unknown> = { ...params, sort: 'score' };
  const ascending = type === 'series' && params.sortType === 'asc';
  if (type === 'series') queryParams.sortType = ascending ? 'asc' : 'desc';
  else delete queryParams.sortType;

  const responses = await Promise.all(years.map(year =>
    tvdb.filter(type, { ...queryParams, year }, config)
  ));

  const nextWeek = new Date(now);
  nextWeek.setDate(now.getDate() + 7);
  const seen = new Set<string>();
  const results: TvdbFilterResult[] = [];
  for (const response of responses) {
    for (const item of response || []) {
      const id = String(item.id);
      if (seen.has(id)) continue;
      seen.add(id);
      if (type === 'series' && (!item.firstAired || !(new Date(item.firstAired) <= nextWeek))) continue;
      results.push(item);
    }
  }

  return results.sort((a, b) => ascending ? a.score - b.score : b.score - a.score);
}
