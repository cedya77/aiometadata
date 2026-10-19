import { withEpisodeOrder } from '../utils/episodeOrder';

export interface AnimeEpisode {
  malId: number | null;
  anilistId: number | null;
  episode: number;
}

export function positive(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export async function resolveAnimeEpisode(meta: any, video: any, config: any): Promise<AnimeEpisode | null> {
  const season = positive(video?.season);
  const episode = positive(video?.episode);
  if (!season || !episode) return null;
  const mapper = require('./id-mapper');

  if (meta?._metaProvider === 'tvdb') {
    const tvdbId = positive(meta._tvdbId);
    if (!tvdbId) return null;
    const order = withEpisodeOrder(config, String(tvdbId)).tvdbSeasonType || 'default';
    if (order !== 'default' && order !== 'official') return null;
    const animeList = require('./anime-list-mapper');
    const anidb = await animeList.resolveAnidbEpisodeFromTvdbEpisode(tvdbId, season, episode);
    if (!positive(anidb?.anidbId) || !positive(anidb?.anidbEpisode) || Number(anidb.anidbSeason) !== 1) return null;
    // Only a mapping that leads back to the same TVDB episode is trusted.
    const back = animeList.resolveTvdbEpisodeFromAnidbEpisode(anidb.anidbId, 1, anidb.anidbEpisode);
    if (Number(back?.tvdbId) !== tvdbId || Number(back?.tvdbSeason) !== season || Number(back?.tvdbEpisode) !== episode) return null;
    const mapping = mapper.getMappingByAnidbId(anidb.anidbId);
    const malId = positive(mapping?.mal_id);
    const anilistId = positive(mapping?.anilist_id);
    return malId || anilistId ? { malId, anilistId, episode: anidb.anidbEpisode } : null;
  }

  if ((meta?._metaProvider === 'kitsu' || meta?._metaProvider === 'mal') && season === 1) {
    const mapping = meta._kitsuId ? mapper.getMappingByKitsuId(meta._kitsuId) : null;
    const malId = positive(meta._malId) ?? positive(mapping?.mal_id);
    const anilistId = positive(meta._anilistId) ?? positive(mapping?.anilist_id)
      ?? (malId ? positive(mapper.getMappingByMalId(malId)?.anilist_id) : null);
    return malId || anilistId ? { malId, anilistId, episode } : null;
  }

  return null;
}
