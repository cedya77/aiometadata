type Episode = { season_number?: number; runtime?: number | null; episode_type?: string | null };
type Aired = { runtime?: number | null; episode_type?: string | null } | null | undefined;

const minutes = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** A series' usual episode length from its episodes: the median of its regular-season standard episodes, or of all its regular-season ones. */
export function runtimeFromEpisodes(episodes: Episode[]): number | null {
  const regular = episodes.filter((episode) => Number(episode?.season_number) > 0 && minutes(episode?.runtime) !== null);
  const standard = regular.filter((episode) => !episode.episode_type || episode.episode_type === 'standard');
  return median((standard.length ? standard : regular).map((episode) => minutes(episode.runtime) as number));
}

/**
 * Without its episodes: TMDB's own episode length, else an aired or coming episode that is not a finale, else any.
 * TMDB leaves episode_run_time empty for most shows now, and the last aired episode is usually a finale.
 */
export function runtimeFromDetails(details: { episode_run_time?: unknown[]; last_episode_to_air?: Aired; next_episode_to_air?: Aired } | null | undefined): number | null {
  if (!details) return null;
  const own = minutes(details.episode_run_time?.[0]);
  if (own !== null) return own;
  const aired = [details.last_episode_to_air, details.next_episode_to_air];
  const standard = aired.find((episode) => episode && episode.episode_type === 'standard' && minutes(episode.runtime) !== null);
  if (standard) return minutes(standard.runtime);
  const any = aired.find((episode) => episode && minutes(episode.runtime) !== null);
  return any ? minutes(any.runtime) : null;
}

const runtimeKey = (tmdbId: unknown): string => `tmdb-series-runtime:v1:${tmdbId}`;

/** Keeps the length worked out from a series' episodes, for the reads that only have its details. */
export async function rememberSeriesRuntime(tmdbId: unknown, runtime: number | null): Promise<void> {
  if (!tmdbId || runtime === null) return;
  const { redis } = require('./getCache');
  const ttl = parseInt(process.env.META_TTL || '', 10) || 7 * 24 * 60 * 60;
  await redis?.set(runtimeKey(tmdbId), String(runtime), 'EX', ttl).catch(() => undefined);
}

/** The length a series' episodes gave, where it was worked out, else the best its details give. */
export async function seriesRuntime(tmdbId: unknown, details: Parameters<typeof runtimeFromDetails>[0]): Promise<number | null> {
  const { redis } = require('./getCache');
  const held = tmdbId ? minutes(await redis?.get(runtimeKey(tmdbId)).catch(() => null)) : null;
  return held ?? runtimeFromDetails(details);
}
