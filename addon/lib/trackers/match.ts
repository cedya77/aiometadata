export interface EpisodeRef {
  season: number;
  episode: number;
}

export interface MatchCandidate {
  ids: Record<string, string | number>;
  title: string;
  year: number | null;
  posterUrl: string | null;
  kind: string;
  episodes: number | null;
}

export interface TargetSeason {
  number: number;
  episodes: Array<{ number: number; title: string | null; airedAt: number | null; sends?: EpisodeRef }>;
}

export type MatchDetail = { ids: Record<string, string | number>; seasons: TargetSeason[]; tvdbSeasons?: TargetSeason[]; tvdbDefault?: boolean };

export async function tmdbSeasons(tmdb: number, config: any): Promise<TargetSeason[]> {
  const { tvInfo, seasonInfo } = require('../getTmdb');
  // A season that could not be read would save as one with nothing to send, so a failed read fails the detail.
  const show = await tvInfo({ id: tmdb, language: 'en-US' }, config);
  if (!show) throw new Error('TMDB did not answer');
  const numbers: number[] = (Array.isArray(show?.seasons) ? show.seasons : [])
    .map((season: any) => Number(season?.season_number))
    .filter((number: number) => Number.isInteger(number) && number >= 0)
    .sort((a: number, b: number) => (a === 0 ? 1 : b === 0 ? -1 : a - b))
    .slice(0, 40);
  return Promise.all(numbers.map(async (number) => {
    const detail = await seasonInfo({ id: tmdb, season_number: number, language: 'en-US' }, config);
    if (!detail) throw new Error(`TMDB did not answer for season ${number}`);
    return {
      number,
      episodes: (Array.isArray(detail?.episodes) ? detail.episodes : []).map((episode: any) => ({
        number: Number(episode.episode_number),
        title: episode.name ? String(episode.name) : null,
        airedAt: Date.parse(episode.air_date ?? '') || null,
      })),
    };
  }));
}
