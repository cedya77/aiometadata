export interface EpisodeRef {
  season: number;
  episode: number;
}

export function historyPayload(
  ids: Record<string, string | number>,
  season?: number,
  episode?: number,
  episodes?: EpisodeRef[],
  watchedAt?: string
): any {
  const at = watchedAt ? { watched_at: watchedAt } : {};
  const refs: EpisodeRef[] = episodes?.length
    ? episodes
    : season != null && episode != null
      ? [{ season, episode }]
      : [];
  if (!refs.length) return { movies: [{ ids, ...at }] };

  const seasons = new Map<number, number[]>();
  for (const ref of refs) {
    const list = seasons.get(ref.season) ?? [];
    if (!list.includes(ref.episode)) list.push(ref.episode);
    seasons.set(ref.season, list);
  }
  return {
    shows: [{
      ids,
      seasons: [...seasons.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([number, list]) => ({ number, episodes: list.sort((a, b) => a - b).map((n) => ({ number: n, ...at })) })),
    }],
  };
}
