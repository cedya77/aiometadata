import { LRUCache } from 'lru-cache';
import { parseStremioId } from './ids';
import { envInt } from '../../utils/envNumber';

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

export async function kitsuForTmdb(tmdbId: number, season: number, episode: number): Promise<{ kitsuId: number; episodeNumber: number } | null> {
  const found = await idMapper.resolveKitsuEpisodeFromTmdb(tmdbId, season, episode, {}, true).catch(() => null);
  if (!found?.kitsuId) return null;
  const back = await idMapper.resolveTmdbEpisodeFromKitsu(found.kitsuId, found.episodeNumber, {}).catch(() => null);
  const same = Number(back?.tmdbId) === tmdbId && Number(back?.seasonNumber) === season && Number(back?.episodeNumber) === episode;
  return same ? { kitsuId: Number(found.kitsuId), episodeNumber: Number(found.episodeNumber) } : null;
}

async function animeAtTvdb(tvdbId: number, season: number, episode: number): Promise<{ anime: any; episode: number } | null> {
  const anidb = await animeList.resolveAnidbEpisodeFromTvdbEpisode(tvdbId, season, episode);
  const byAnidb = anidb?.anidbId ? idMapper.getMappingByAnidbId(anidb.anidbId) : null;
  const listed = byAnidb?.kitsu_id || byAnidb?.mal_id ? null : idMapper.resolveKitsuEpisodeFromTvdbMapping(tvdbId, season, episode);
  const anime = listed ? idMapper.getMappingByKitsuId(listed.kitsuId) : byAnidb;
  return anime ? { anime, episode: Number(listed ? listed.episodeNumber : anidb.anidbEpisode) } : null;
}

async function tvdbOfPart(mapping: any, episode: number): Promise<{ tvdbId: number; tvdbSeason: number; tvdbEpisode: number } | null> {
  const season = Number(mapping?.season?.tvdb);
  if (mapping?.anidb_id || !mapping?.tvdb_id || !mapping?.kitsu_id || !Number.isInteger(season) || season < 1) return null;
  const tvdbEpisode = episode + (Number(mapping.episode_offset?.tvdb) || 0);
  const back = await animeAtTvdb(Number(mapping.tvdb_id), season, tvdbEpisode);
  return back?.anime?.kitsu_id === mapping.kitsu_id && back.episode === episode ? { tvdbId: Number(mapping.tvdb_id), tvdbSeason: season, tvdbEpisode } : null;
}

async function tmdbSpelling(mapping: any, episode: number): Promise<string | null> {
  const whole = wholeTmdbSeason(mapping);
  if (whole !== null) return `tmdb:${mapping.themoviedb_id}:${whole}:${episode}`;
  if (!mapping?.kitsu_id || !mapping.themoviedb_id || mapping.themoviedb_type !== 'tv') return null;
  const back = await idMapper.resolveTmdbEpisodeFromKitsu(mapping.kitsu_id, episode, {}).catch(() => null);
  if (Number(back?.tmdbId) !== Number(mapping.themoviedb_id)) return null;
  const forward = await kitsuForTmdb(Number(back.tmdbId), Number(back.seasonNumber), Number(back.episodeNumber));
  return forward?.kitsuId === Number(mapping.kitsu_id) && forward.episodeNumber === episode ? `tmdb:${back.tmdbId}:${back.seasonNumber}:${back.episodeNumber}` : null;
}

function filmAliases(videoId: string, parsed: any): string[] {
  const numeric = parseInt(String(parsed.base).split(':')[1], 10);
  const film =
    parsed.idType === 'kitsu' ? idMapper.getMappingByKitsuId(numeric)
    : parsed.idType === 'mal' ? idMapper.getMappingByMalId(numeric) ?? { type: 'MOVIE', mal_id: numeric }
    : parsed.idType === 'anilist' ? idMapper.getMappingByAnilistId(numeric)
    : parsed.idType === 'anidb' ? idMapper.getMappingByAnidbId(numeric)
    : parsed.idType === 'imdb' ? idMapper.filmMappingFor({ imdbId: parsed.base })
    : parsed.idType === 'tmdb' ? idMapper.filmMappingFor({ tmdbId: numeric })
    : null;
  if (!film) return [];
  const { tmdbId, imdbId } = idMapper.filmIdsFor(film);
  if (!tmdbId && !imdbId) return [];
  const out = new Set<string>();
  for (const id of [
    film.kitsu_id && `kitsu:${film.kitsu_id}`,
    film.mal_id && `mal:${film.mal_id}`,
    film.anilist_id && `anilist:${film.anilist_id}`,
    film.anidb_id && `anidb:${film.anidb_id}`,
    imdbId,
    tmdbId && `tmdb:${tmdbId}`,
  ]) {
    if (id && id !== videoId) out.add(String(id));
  }
  return [...out];
}

const aliasMemo = new LRUCache<string, Promise<string[]>>({
  max: envInt('JELLYFIN_ALIAS_MEMO_MAX', 20000, 1),
  ttl: envInt('JELLYFIN_ALIAS_MEMO_TTL', 600, 1) * 1000,
});

export function videoIdAliases(videoId: string): Promise<string[]> {
  let held = aliasMemo.get(videoId);
  if (!held) {
    held = computeVideoIdAliases(videoId);
    aliasMemo.set(videoId, held);
  }
  return held.then((aliases) => [...aliases]);
}

async function computeVideoIdAliases(videoId: string): Promise<string[]> {
  const parsed = parseStremioId(videoId);
  if (!parsed) return [];
  if (parsed.episode === null || parsed.episode === undefined) {
    try {
      return filmAliases(videoId, parsed);
    } catch {
      return [];
    }
  }

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

      const tvdb = mapping.anidb_id ? animeList.resolveTvdbEpisodeFromAnidbEpisode(mapping.anidb_id, 1, episode) : await tvdbOfPart(mapping, episode);
      if (tvdb?.tvdbId) {
        add(`tvdb:${tvdb.tvdbId}:${tvdb.tvdbSeason}:${tvdb.tvdbEpisode}`);
        if (mapping.imdb_id) add(`${mapping.imdb_id}:${tvdb.tvdbSeason}:${tvdb.tvdbEpisode}`);
      }
      add(await tmdbSpelling(mapping, episode));
      return [...out];
    }

    if (parsed.idType === 'tmdb' && parsed.season !== null && parsed.season !== undefined) {
      const tmdbId = parseInt(parsed.base.split(':')[1], 10);
      const entries = idMapper.getSeriesMappingsByTmdbId(tmdbId).filter((entry: any) => wholeTmdbSeason(entry) === Number(parsed.season));
      const entry = entries.length === 1 ? entries[0] : null;
      const split = entry || !idMapper.getSeriesMappingsByTmdbId(tmdbId).length ? null : await kitsuForTmdb(tmdbId, Number(parsed.season), Number(parsed.episode));
      const anime = entry?.kitsu_id ? `kitsu:${entry.kitsu_id}:${parsed.episode}` : entry?.mal_id ? `mal:${entry.mal_id}:${parsed.episode}` : split ? `kitsu:${split.kitsuId}:${split.episodeNumber}` : null;
      if (anime) {
        add(anime);
        for (const alias of await videoIdAliases(anime)) add(alias);
      } else if (!idMapper.getSeriesMappingsByTmdbId(tmdbId).length) {
        const regular = idMappings.getByTmdbId?.(String(tmdbId), 'series');
        if (regular?.imdbId) add(`${regular.imdbId}:${parsed.season}:${parsed.episode}`);
        if (regular?.tvdbId) add(`tvdb:${regular.tvdbId}:${parsed.season}:${parsed.episode}`);
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

      let animeFound = false;
      if (tvdbId) {
        if (parsed.idType === 'imdb') add(`tvdb:${tvdbId}:${season}:${episode}`);
        const found = await animeAtTvdb(tvdbId, season, episode);
        const anime = found?.anime;
        const animeEpisode = found?.episode;
        animeFound = Boolean(anime);
        if (anime?.kitsu_id) add(`kitsu:${anime.kitsu_id}:${animeEpisode}`);
        if (anime?.mal_id) add(`mal:${anime.mal_id}:${animeEpisode}`);
        if (anime) add(await tmdbSpelling(anime, Number(animeEpisode)));
      }
      if (parsed.idType === 'tvdb' && mapping?.imdb_id) add(`${mapping.imdb_id}:${season}:${episode}`);
      if (!mapping && !animeFound) {
        const regular = imdbId ? idMappings.getByImdbId?.(imdbId, 'series') : idMappings.getByTvdbId?.(parsed.base.split(':')[1], 'series');
        if (regular?.tmdbId) add(`tmdb:${regular.tmdbId}:${season}:${episode}`);
        if (parsed.idType === 'tvdb' && regular?.imdbId) add(`${regular.imdbId}:${season}:${episode}`);
      }
      return [...out];
    }
  } catch {
    return [...out];
  }
  return [...out];
}

/** The same patch under every spelling of the episode. */
export async function upsertPlaystateEverywhere(userUUID: string, videoId: string, patch: any, profile = '', known: string[] = []): Promise<void> {
  const at = Date.now();
  await database.upsertPlaystate(userUUID, videoId, patch, profile, at);
  const aliases = new Set([...(await videoIdAliases(videoId)), ...known.filter((id) => id && id !== videoId)]);
  for (const alias of aliases) {
    await database.upsertPlaystate(userUUID, alias, patch, profile, at + 1);
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

function otherFilmSpelling(videoId: string): string | null {
  const parsed = parseStremioId(videoId);
  if (!parsed || (parsed.episode !== null && parsed.episode !== undefined)) return null;
  if (parsed.idType === 'imdb') {
    const tmdbId = idMappings.getByImdbId?.(parsed.base, 'movie')?.tmdbId;
    return tmdbId ? `tmdb:${tmdbId}` : null;
  }
  if (parsed.idType === 'tmdb') return idMappings.getByTmdbId?.(String(parsed.base).split(':')[1], 'movie')?.imdbId ?? null;
  return null;
}

export async function filmsHeldElsewhere(userUUID: string, videoIds: string[], profile = ''): Promise<Map<string, any>> {
  const candidates = new Map<string, string>();
  for (const videoId of videoIds) {
    const other = otherFilmSpelling(videoId);
    if (other && other !== videoId) candidates.set(videoId, other);
  }
  const out = new Map<string, any>();
  if (!candidates.size) return out;
  const rows: Map<string, any> = await database.getPlaystates(userUUID, [...new Set(candidates.values())], profile);
  const { fetchMeta } = require('./items');
  for (const [videoId, other] of candidates) {
    const row = rows.get(other);
    if (!row) continue;
    const meta = await fetchMeta(userUUID, 'movie', videoId).catch(() => null);
    const ids = [meta?._imdbId || meta?.imdb_id, meta?._tmdbId && `tmdb:${meta._tmdbId}`].filter(Boolean).map(String);
    if (ids.includes(videoId) && ids.includes(other)) out.set(videoId, row);
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
