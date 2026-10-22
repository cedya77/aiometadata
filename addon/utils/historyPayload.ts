export interface EpisodeRef {
  season: number;
  episode: number;
  ids?: Record<string, number>;
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

  const byId = refs.filter((ref) => ref.ids).map((ref) => ({ ids: ref.ids, ...at }));
  const seasons = new Map<number, number[]>();
  for (const ref of refs) {
    if (ref.ids) continue;
    const list = seasons.get(ref.season) ?? [];
    if (!list.includes(ref.episode)) list.push(ref.episode);
    seasons.set(ref.season, list);
  }
  return {
    ...(seasons.size ? {
      shows: [{
        ids,
        seasons: [...seasons.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([number, list]) => ({ number, episodes: list.sort((a, b) => a - b).map((n) => ({ number: n, ...at })) })),
      }],
    } : {}),
    ...(byId.length ? { episodes: byId } : {}),
  };
}

export interface HistoryWrite {
  ids: Record<string, string | number>;
  season?: number;
  episode?: number;
  episodeIds?: Record<string, number>;
  watchedAt?: string | null;
}

export function historyBatchPayload(writes: HistoryWrite[]): any {
  const movies: any[] = [];
  const byId: any[] = [];
  const shows = new Map<string, { ids: Record<string, string | number>; seasons: Map<number, any[]> }>();
  for (const write of writes) {
    const at = write.watchedAt ? { watched_at: write.watchedAt } : {};
    if (write.episodeIds) {
      byId.push({ ids: write.episodeIds, ...at });
      continue;
    }
    if (write.season == null || write.episode == null) {
      movies.push({ ids: write.ids, ...at });
      continue;
    }
    const key = JSON.stringify(write.ids);
    const show = shows.get(key) ?? { ids: write.ids, seasons: new Map<number, any[]>() };
    const episodes = show.seasons.get(write.season) ?? [];
    if (!episodes.some((e) => e.number === write.episode)) episodes.push({ number: write.episode, ...at });
    show.seasons.set(write.season, episodes);
    shows.set(key, show);
  }
  return {
    ...(movies.length ? { movies } : {}),
    ...(shows.size ? {
      shows: [...shows.values()].map((show) => ({
        ids: show.ids,
        seasons: [...show.seasons.entries()].sort((a, b) => a[0] - b[0]).map(([number, episodes]) => ({ number, episodes: episodes.sort((a, b) => a.number - b.number) })),
      })),
    } : {}),
    ...(byId.length ? { episodes: byId } : {}),
  };
}
