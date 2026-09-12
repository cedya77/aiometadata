import { parseStremioId } from './ids';

const idMapper: any = require('../id-mapper');
const animeList: any = require('../anime-list-mapper');
const wiki: any = require('../wiki-mapper');

const database: any = require('../database');

// One episode is spelled differently by each provider: kitsu:50040:6 is also tt37614297:1:6.
export async function videoIdAliases(videoId: string): Promise<string[]> {
  const parsed = parseStremioId(videoId);
  if (!parsed || parsed.episode === null || parsed.episode === undefined) return [];

  const out = new Set<string>();
  const add = (id: string | null | undefined) => {
    if (id && id !== videoId) out.add(id);
  };

  try {
    if (parsed.idType === 'kitsu' || parsed.idType === 'mal' || parsed.idType === 'anilist' || parsed.idType === 'anidb') {
      const numeric = parseInt(parsed.base.split(':')[1], 10);
      const mapping =
        parsed.idType === 'kitsu' ? idMapper.getMappingByKitsuId(numeric)
        : parsed.idType === 'mal' ? idMapper.getMappingByMalId(numeric)
        : parsed.idType === 'anilist' ? idMapper.getMappingByAnilistId(numeric)
        : idMapper.getMappingByAnidbId(numeric);
      if (!mapping) return [];

      const episode = Number(parsed.episode);
      if (mapping.kitsu_id) add(`kitsu:${mapping.kitsu_id}:${episode}`);
      if (mapping.mal_id) add(`mal:${mapping.mal_id}:${episode}`);

      const tvdb = mapping.anidb_id ? animeList.resolveTvdbEpisodeFromAnidbEpisode(mapping.anidb_id, 1, episode) : null;
      if (tvdb?.tvdbId) {
        add(`tvdb:${tvdb.tvdbId}:${tvdb.tvdbSeason}:${tvdb.tvdbEpisode}`);
        if (mapping.imdb_id) add(`${mapping.imdb_id}:${tvdb.tvdbSeason}:${tvdb.tvdbEpisode}`);
      }
      return [...out];
    }

    if (parsed.idType === 'imdb' || parsed.idType === 'tvdb') {
      const season = Number(parsed.season);
      const episode = Number(parsed.episode);
      const imdbId = parsed.idType === 'imdb' ? parsed.base : null;
      const mapping = imdbId ? idMapper.getMappingByImdbId(imdbId) : idMapper.getMappingByTvdbId(parseInt(parsed.base.split(':')[1], 10));
      const tvdbId = parsed.idType === 'tvdb'
        ? parseInt(parsed.base.split(':')[1], 10)
        : mapping?.thetvdb_id
          || (mapping?.anidb_id ? animeList.resolveTvdbEpisodeFromAnidbEpisode(mapping.anidb_id, 1, 1)?.tvdbId : null)
          || wiki.getByImdbId?.(imdbId, 'series')?.tvdbId
          || null;

      if (tvdbId) {
        if (parsed.idType === 'imdb') add(`tvdb:${tvdbId}:${season}:${episode}`);
        const anidb = await animeList.resolveAnidbEpisodeFromTvdbEpisode(tvdbId, season, episode);
        const anime = anidb?.anidbId ? idMapper.getMappingByAnidbId(anidb.anidbId) : null;
        if (anime?.kitsu_id) add(`kitsu:${anime.kitsu_id}:${anidb.anidbEpisode}`);
        if (anime?.mal_id) add(`mal:${anime.mal_id}:${anidb.anidbEpisode}`);
      }
      if (parsed.idType === 'tvdb' && mapping?.imdb_id) add(`${mapping.imdb_id}:${season}:${episode}`);
      return [...out];
    }
  } catch {
    return [...out];
  }
  return [...out];
}

/** The same patch under every spelling of the episode. */
export async function upsertPlaystateEverywhere(userUUID: string, videoId: string, patch: any, profile = ''): Promise<void> {
  await database.upsertPlaystate(userUUID, videoId, patch, profile);
  for (const alias of await videoIdAliases(videoId)) {
    await database.upsertPlaystate(userUUID, alias, patch, profile);
  }
}

/** Rows for the ids asked for, found under any spelling, keyed by the id asked for. */
export async function getPlaystatesAcross(userUUID: string, videoIds: string[], profile = ''): Promise<Map<string, any>> {
  const aliases = new Map<string, string[]>();
  for (const id of videoIds) aliases.set(id, await videoIdAliases(id));

  const lookup = new Set<string>(videoIds);
  for (const list of aliases.values()) for (const alias of list) lookup.add(alias);

  const rows: Map<string, any> = await database.getPlaystates(userUUID, [...lookup], profile);
  const out = new Map<string, any>();
  for (const id of videoIds) {
    const own = rows.get(id);
    const other = (aliases.get(id) || []).map((alias) => rows.get(alias)).find(Boolean);
    // The newest write wins when the spellings disagree.
    const pick = own && other
      ? (Number(own.updated_at) >= Number(other.updated_at) ? own : other)
      : own || other;
    if (pick) out.set(id, pick);
  }
  return out;
}
