import { parseStremioId } from './ids';

const idMapper: any = require('../id-mapper');
const animeList: any = require('../anime-list-mapper');
const idMappings: any = require('../id-mappings');

const database: any = require('../database');

// One episode is spelled differently by each provider: kitsu:50040:6 is also tt37614297:1:6.
function wholeTmdbSeason(mapping: any): number | null {
  const season = Number(mapping?.season?.tmdb);
  if (!mapping?.themoviedb_id || mapping.themoviedb_type !== 'tv' || !Number.isInteger(season) || season < 1) return null;
  const sharing = idMapper.getSeriesMappingsByTmdbId(mapping.themoviedb_id).filter((entry: any) => Number(entry?.season?.tmdb) === season);
  return sharing.length === 1 ? season : null;
}

export async function videoIdAliases(videoId: string): Promise<string[]> {
  const parsed = parseStremioId(videoId);
  // A film's other spelling comes from its meta at write time; Wikidata's pairing is not trusted for it.
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
      const tmdbSeason = wholeTmdbSeason(mapping);
      if (tmdbSeason !== null) add(`tmdb:${mapping.themoviedb_id}:${tmdbSeason}:${episode}`);
      return [...out];
    }

    if (parsed.idType === 'tmdb' && parsed.season !== null && parsed.season !== undefined) {
      const tmdbId = parseInt(parsed.base.split(':')[1], 10);
      const entries = idMapper.getSeriesMappingsByTmdbId(tmdbId).filter((entry: any) => wholeTmdbSeason(entry) === Number(parsed.season));
      const entry = entries.length === 1 ? entries[0] : null;
      const anime = entry?.kitsu_id ? `kitsu:${entry.kitsu_id}:${parsed.episode}` : entry?.mal_id ? `mal:${entry.mal_id}:${parsed.episode}` : null;
      if (anime) {
        add(anime);
        for (const alias of await videoIdAliases(anime)) add(alias);
      }
      return [...out];
    }

    if (parsed.idType === 'imdb' || parsed.idType === 'tvdb') {
      const season = Number(parsed.season);
      const episode = Number(parsed.episode);
      const imdbId = parsed.idType === 'imdb' ? parsed.base : null;
      const found = imdbId ? idMapper.getMappingByImdbId(imdbId) : idMapper.getMappingByTvdbId(parseInt(parsed.base.split(':')[1], 10));
      const mapping = idMapper.mappingIsType(found, 'series') ? found : null;
      const tvdbId = parsed.idType === 'tvdb'
        ? parseInt(parsed.base.split(':')[1], 10)
        : mapping?.thetvdb_id
          || (mapping?.anidb_id ? animeList.resolveTvdbEpisodeFromAnidbEpisode(mapping.anidb_id, 1, 1)?.tvdbId : null)
          || idMappings.getByImdbId?.(imdbId, 'series')?.tvdbId
          || null;

      if (tvdbId) {
        if (parsed.idType === 'imdb') add(`tvdb:${tvdbId}:${season}:${episode}`);
        const anidb = await animeList.resolveAnidbEpisodeFromTvdbEpisode(tvdbId, season, episode);
        const listed = anidb?.anidbId ? null : idMapper.resolveKitsuEpisodeFromTvdbMapping(tvdbId, season, episode);
        const anime = anidb?.anidbId ? idMapper.getMappingByAnidbId(anidb.anidbId) : listed ? idMapper.getMappingByKitsuId(listed.kitsuId) : null;
        const animeEpisode = anidb?.anidbId ? anidb.anidbEpisode : listed?.episodeNumber;
        if (anime?.kitsu_id) add(`kitsu:${anime.kitsu_id}:${animeEpisode}`);
        if (anime?.mal_id) add(`mal:${anime.mal_id}:${animeEpisode}`);
        const tmdbSeason = anime ? wholeTmdbSeason(anime) : null;
        if (tmdbSeason !== null) add(`tmdb:${anime.themoviedb_id}:${tmdbSeason}:${animeEpisode}`);
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
export async function upsertPlaystateEverywhere(userUUID: string, videoId: string, patch: any, profile = '', known: string[] = []): Promise<void> {
  await database.upsertPlaystate(userUUID, videoId, patch, profile);
  const aliases = new Set([...(await videoIdAliases(videoId)), ...known.filter((id) => id && id !== videoId)]);
  for (const alias of aliases) {
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
    let pick: any = null;
    for (const spelling of [id, ...(aliases.get(id) || [])]) {
      const row = rows.get(spelling);
      if (!row) continue;
      if (!pick || (Number(row.updated_at) || 0) > (Number(pick.updated_at) || 0)) pick = row;
    }
    if (pick) out.set(id, pick);
  }
  return out;
}

/** One row per episode across its spellings; the first in the order given is kept. */
export async function dedupeByAlias<T extends { videoId: string }>(rows: T[]): Promise<T[]> {
  const taken = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (taken.has(row.videoId)) continue;
    out.push(row);
    taken.add(row.videoId);
    for (const alias of await videoIdAliases(row.videoId)) taken.add(alias);
  }
  return out;
}

/** Rows grouped by title: known aliases, and the spellings one play through this server wrote together. */
export async function groupBySpelling<T extends { video_id: any; last_played_at?: any; origin?: any }>(rows: T[]): Promise<T[][]> {
  const ids = rows.map((row) => String(row.video_id));
  const parent = new Map<string, string>(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const together = new Map<string, string>();
  for (const [i, row] of rows.entries()) {
    const id = ids[i];
    for (const alias of await videoIdAliases(id).catch(() => [] as string[])) union(id, alias);
    if (row.origin !== 'server' || !row.last_played_at) continue;
    const parsed = parseStremioId(id);
    const at = parsed && parsed.episode !== null && parsed.episode !== undefined ? `${parsed.season ?? ''}:${parsed.episode}` : 'title';
    const key = `${row.last_played_at}|${at}`;
    const first = together.get(key);
    if (first) union(id, first);
    else together.set(key, id);
  }

  const groups = new Map<string, T[]>();
  for (const [i, row] of rows.entries()) {
    const root = find(ids[i]);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(row);
  }
  return [...groups.values()];
}
