import { LRUCache } from 'lru-cache';
import { withEpisodeOrder } from '../utils/episodeOrder';

export interface AnimeEpisode {
  malId: number | null;
  anilistId: number | null;
  episode: number;
}

const tmdbEpisodes = new LRUCache<string, { kitsuId: number; episodeNumber: number } | false>({ max: 20000, ttl: 60 * 60 * 1000 });

async function kitsuEpisodeFromTmdb(tmdbId: number, season: number, episode: number, config: any) {
  const key = `${tmdbId}:${season}:${episode}`;
  const held = tmdbEpisodes.get(key);
  if (held !== undefined) return held || null;
  const found = await require('./id-mapper').resolveKitsuEpisodeFromTmdb(tmdbId, season, episode, config).catch(() => null);
  tmdbEpisodes.set(key, found || false);
  return found;
}

const airedPositions = new WeakMap<object, Promise<Map<number, { season: number; episode: number }> | null>>();

function airedPositionsFor(meta: any, tvdbId: number, config: any) {
  let held = airedPositions.get(meta);
  if (!held) {
    held = require('./tvdb').getSeriesEpisodes(String(tvdbId), 'en-US', 'default', config)
      .then((result: any) => new Map((result?.episodes || []).map((e: any) => [Number(e.id), { season: Number(e.seasonNumber), episode: Number(e.number) }])))
      .catch(() => null);
    airedPositions.set(meta, held!);
  }
  return held!;
}

export function positive(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export async function resolveAnimeEpisode(meta: any, video: any, config: any): Promise<AnimeEpisode | null> {
  let season = positive(video?.season);
  let episode = positive(video?.episode);
  if (!season || !episode) return null;
  const mapper = require('./id-mapper');

  if (meta?._metaProvider === 'tvdb' || meta?._metaProvider === 'imdb') {
    let tvdbId: number | null;
    if (meta._metaProvider === 'imdb') {
      const imdbId = meta._imdbId || (typeof meta.id === 'string' && /^tt\d+$/.test(meta.id) ? meta.id : null);
      const found = imdbId ? mapper.getMappingByImdbId(imdbId) : null;
      if (found && !mapper.mappingIsType(found, 'series')) return null;
      tvdbId = positive(found?.tvdb_id) ?? positive(meta._tvdbId);
    } else {
      tvdbId = positive(meta._tvdbId);
      const order = tvdbId ? withEpisodeOrder(config, String(tvdbId)).tvdbSeasonType || 'default' : null;
      if (tvdbId && order !== 'default' && order !== 'official') {
        const episodeId = positive(video._tvdbEpisodeId);
        const aired = episodeId ? (await airedPositionsFor(meta, tvdbId, config))?.get(episodeId) : null;
        if (!positive(aired?.season) || !positive(aired?.episode)) return null;
        ({ season, episode } = aired!);
      }
    }
    if (!tvdbId) return null;
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

  if (meta?._metaProvider === 'tmdb') {
    const tmdbId = positive(meta._tmdbId) ?? positive(String(meta.id || '').replace(/^tmdb:/, ''));
    if (!tmdbId || !mapper.getMappingByTmdbId(tmdbId, 'series')) return null;
    const kitsu = await kitsuEpisodeFromTmdb(tmdbId, season, episode, config);
    const mapping = kitsu ? mapper.getMappingByKitsuId(kitsu.kitsuId) : null;
    const malId = positive(mapping?.mal_id);
    const anilistId = positive(mapping?.anilist_id);
    return malId || anilistId ? { malId, anilistId, episode: kitsu.episodeNumber } : null;
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
