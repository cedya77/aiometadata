export type TmdbTrendingWindow = 'day' | 'week';

const TMDB_TRENDING_SORT_PATTERN = /^trending\.(day|week)$/;

export function getTmdbTrendingWindow(sortBy: unknown): TmdbTrendingWindow | null {
  const match = typeof sortBy === 'string' ? sortBy.trim().match(TMDB_TRENDING_SORT_PATTERN) : null;
  return (match?.[1] as TmdbTrendingWindow | undefined) || null;
}
