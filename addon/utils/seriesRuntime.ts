/**
 * The length of a typical episode of a series, in minutes.
 *
 * TMDB no longer fills `episode_run_time` for most shows, so falling back to
 * `last_episode_to_air.runtime` reports a finale or a double episode as the
 * series runtime (The Office 45, Game of Thrones 80). The median of the
 * regular-season episodes is what a viewer expects, and specials, a long
 * pilot or a long finale can't move it.
 */
export interface EpisodeRuntime {
  season_number?: number | null;
  runtime?: number | null;
}

export function typicalEpisodeRuntime(episodes: EpisodeRuntime[] | null | undefined): number | null {
  const minutes = (episodes ?? [])
    .filter((ep) => Number(ep?.season_number) > 0)
    .map((ep) => Number(ep?.runtime))
    .filter((m) => Number.isFinite(m) && m > 0)
    .sort((a, b) => a - b);
  if (!minutes.length) return null;
  const mid = Math.floor(minutes.length / 2);
  return minutes.length % 2 ? minutes[mid] : Math.round((minutes[mid - 1] + minutes[mid]) / 2);
}
