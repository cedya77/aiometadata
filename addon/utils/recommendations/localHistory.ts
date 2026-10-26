import consola from 'consola';
import type { WatchedKind, WatchedRow } from './history';

const logger = consola.withTag('Recommendations');

const ANIME_IDS = /^(kitsu|mal|anilist|anidb):/;

function envInt(name: string, fallback: number, min: number): number {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function preferredBase(bases: string[]): string {
  return bases.find((id) => id.startsWith('tt')) ?? bases.find((id) => id.startsWith('tmdb:')) ?? bases[0];
}

function yearOf(meta: any): number | undefined {
  const year = parseInt(String(meta?.year ?? meta?.releaseInfo ?? '').slice(0, 4), 10);
  return Number.isFinite(year) && year > 1870 ? year : undefined;
}

export async function localPlayVersion(userUUID: string, profile: string): Promise<string> {
  const database: any = require('../../lib/database');
  return database.playstateVersion(userUUID, profile);
}

/** A play's IMDb and TMDB ids, from its own id and the mapping tables already in memory. */
function mappedIds(parsed: any, series: boolean): { imdb?: string; tmdb?: string } {
  if (!parsed?.base) return {};
  const idMapper: any = require('../../lib/id-mapper');
  const idMappings: any = require('../../lib/id-mappings');
  const id = parsed.idType === 'imdb' ? parsed.base : String(parsed.base).split(':')[1];
  if (parsed.idType === 'imdb' || parsed.idType === 'tmdb' || parsed.idType === 'tvdb' || parsed.idType === 'tvmaze') {
    let ids: any;
    try {
      const type = series ? 'series' : 'movie';
      ids = parsed.idType === 'imdb' ? idMappings.getByImdbId(id, type)
        : parsed.idType === 'tmdb' ? idMappings.getByTmdbId(id, type)
        : parsed.idType === 'tvdb' ? idMappings.getByTvdbId(id, type)
        : idMappings.getSeriesByTvmaze(id);
    } catch { /* the mapping file is not loaded yet */ }
    return {
      imdb: parsed.idType === 'imdb' ? id : ids?.imdbId || undefined,
      tmdb: parsed.idType === 'tmdb' ? id : ids?.tmdbId || undefined,
    };
  }
  const anime: Record<string, (id: number) => any> = {
    kitsu: idMapper.getMappingByKitsuId,
    mal: idMapper.getMappingByMalId,
    anilist: idMapper.getMappingByAnilistId,
    anidb: idMapper.getMappingByAnidbId,
  };
  if (!anime[parsed.idType]) return {};
  const numeric = parseInt(id, 10);
  const mapping = anime[parsed.idType](numeric) ?? (parsed.idType === 'mal' && !series ? { type: 'MOVIE', mal_id: numeric } : null);
  if (series) {
    return {
      imdb: typeof mapping?.imdb_id === 'string' ? mapping.imdb_id : undefined,
      tmdb: mapping?.themoviedb_type === 'tv' && mapping.themoviedb_id ? String(mapping.themoviedb_id) : undefined,
    };
  }
  if (!mapping) return {};
  const film = idMapper.filmIdsFor(mapping);
  return { imdb: film.imdbId || undefined, tmdb: film.tmdbId || undefined };
}

/** Metadata only if it is already cached; nothing is fetched to answer. */
async function cachedMeta(config: any, userUUID: string, type: string, id: string): Promise<any> {
  const { cacheWrapMetaSmart }: any = require('../../lib/getCache');
  return (await cacheWrapMetaSmart(userUUID, id, async () => ({ meta: null }), undefined, { config }, type, false))?.meta ?? null;
}

/** Every title the profile played, keyed as titleKeys keys a pick. Read off the ids and the caches, so nothing is asked upstream. */
export async function localWatchedKeys(config: any, userUUID: string, profile: string): Promise<string[]> {
  const database: any = require('../../lib/database');
  const { parseStremioId }: any = require('../../lib/jellyfin/ids');
  const { mapWithConcurrency }: any = require('../concurrency');

  const keys = new Set<string>();
  const unmapped = new Map<string, { parsed: any; series: boolean; imdb?: string; tmdb?: string }>();
  for (const row of (await database.listPlayedForProfile(userUUID, profile)) as any[]) {
    if (Number(row.played) !== 1) continue;
    const parsed = parseStremioId(String(row.video_id));
    if (!parsed?.base) continue;
    const series = parsed.episode !== null && parsed.episode !== undefined;
    const { imdb, tmdb } = mappedIds(parsed, series);
    if (imdb) keys.add(`imdb:${imdb}`);
    if (tmdb) keys.add(`${series ? 'tv' : 'movie'}:${tmdb}`);
    if ((!imdb || !tmdb) && !ANIME_IDS.test(parsed.base)) unmapped.set(`${series}|${parsed.base}`, { parsed, series, imdb, tmdb });
  }

  // What the mapping file lacks, the id resolver's cache may hold for any title it
  // has resolved, and failing that the title's cached metadata. That cache only
  // keeps mappings that have a TMDB id, so an IMDb-only title is read from the metadata.
  const redisIdCache: any = require('../../lib/redis-id-cache');
  await mapWithConcurrency([...unmapped.values()], envInt('RECOMMENDATION_ENRICH_CONCURRENCY', 6, 1), async ({ parsed, series, imdb, tmdb }: any) => {
    const id = parsed.idType === 'imdb' ? parsed.base : String(parsed.base).split(':')[1];
    const cached = await redisIdCache.getCachedIdMapping(
      series ? 'series' : 'movie',
      tmdb ?? null,
      parsed.idType === 'tvdb' ? id : null,
      imdb ?? null,
      parsed.idType === 'tvmaze' ? id : null,
    ).catch(() => null);
    imdb ??= cached?.imdb_id || undefined;
    tmdb ??= cached?.tmdb_id ? String(cached.tmdb_id) : undefined;
    if (!imdb || !tmdb) {
      const meta = await cachedMeta(config, userUUID, series ? 'series' : 'movie', parsed.base).catch(() => null);
      imdb ??= [meta?._imdbId, meta?.imdb_id].find((value) => typeof value === 'string' && value.startsWith('tt'));
      const fromMeta = Number(meta?._tmdbId);
      tmdb ??= Number.isFinite(fromMeta) && fromMeta > 0 ? String(fromMeta) : undefined;
    }
    if (imdb) keys.add(`imdb:${imdb}`);
    if (tmdb) keys.add(`${series ? 'tv' : 'movie'}:${tmdb}`);
  });
  return [...keys];
}

export async function collectLocalRows(config: any, userUUID: string, profile: string): Promise<WatchedRow[]> {
  const database: any = require('../../lib/database');
  const { groupBySpelling }: any = require('../../lib/jellyfin/aliases');
  const { parseStremioId }: any = require('../../lib/jellyfin/ids');
  const lookup = (type: string, id: string) => cachedMeta(config, userUUID, type, id);
  const { mapWithConcurrency }: any = require('../concurrency');

  const plays = (await database.listPlayedForProfile(userUUID, profile)) as any[];
  if (!plays.length) return [];

  type Title = { bases: Set<string>; episode: boolean; episodes: Set<string>; played: boolean; at: number };
  const titles = new Map<string, Title>();
  const titleOf = new Map<string, string>();
  for (const group of (await groupBySpelling(plays)) as any[][]) {
    const bases = new Set<string>();
    let number: string | null = null;
    for (const row of group) {
      const parsed = parseStremioId(String(row.video_id));
      if (!parsed?.base) continue;
      bases.add(parsed.base);
      if (parsed.episode !== null && parsed.episode !== undefined) number ??= `${parsed.season ?? ''}:${parsed.episode}`;
    }
    if (!bases.size) continue;
    const key = [...bases].map((base) => titleOf.get(base)).find(Boolean) ?? [...bases][0];
    const title = titles.get(key) ?? { bases: new Set<string>(), episode: false, episodes: new Set<string>(), played: false, at: 0 };
    for (const base of bases) {
      const other = titleOf.get(base);
      const absorbed = other && other !== key ? titles.get(other) : undefined;
      if (absorbed) {
        for (const id of absorbed.bases) { title.bases.add(id); titleOf.set(id, key); }
        for (const episode of absorbed.episodes) title.episodes.add(episode);
        title.episode ||= absorbed.episode;
        title.played ||= absorbed.played;
        title.at = Math.max(title.at, absorbed.at);
        titles.delete(other!);
      }
      title.bases.add(base);
      titleOf.set(base, key);
    }
    const played = group.some((row) => Number(row.played) === 1);
    if (number !== null) {
      title.episode = true;
      if (played) title.episodes.add(number);
    }
    title.played ||= played;
    title.at = Math.max(title.at, ...group.map((row) => Number(row.last_played_at) || Number(row.updated_at) || 0));
    titles.set(key, title);
  }

  const ratings = new Map<string, number>();
  for (const row of (await database.listProfileRatings(userUUID, profile, 5000).catch(() => [])) as any[]) {
    if (!ratings.has(String(row.meta_id))) ratings.set(String(row.meta_id), Number(row.rating));
  }

  const ordered = [...titles.values()]
    .filter((title) => title.played)
    .sort((a, b) => b.at - a.at);
  const max = envInt('RECOMMENDATION_LOCAL_HISTORY_MAX', 500, 1);
  const width = envInt('RECOMMENDATION_ENRICH_CONCURRENCY', 6, 1);

  const merged = new Map<string, { row: WatchedRow; episodic: boolean; episodes: Set<string> }>();
  let looked = 0;
  let unnamed = 0;
  for (let at = 0; at < ordered.length && merged.size < max; at += width * 4) {
    const batch = ordered.slice(at, at + width * 4);
    looked += batch.length;
    const resolved = await mapWithConcurrency(batch, width, async (title: Title) => {
      const meta = await lookup(title.episode ? 'series' : 'movie', preferredBase([...title.bases])).catch(() => null);
      const name = String(meta?.name || '').trim();
      return name ? { title, meta, name } : null;
    });
    for (const found of resolved) {
      if (!found) { unnamed += 1; continue; }
      const { title, meta, name } = found;
      const bases = [...title.bases];
      const anime = bases.some((id) => ANIME_IDS.test(id));
      const kind: WatchedKind = anime ? 'anime' : title.episode ? 'series' : 'movie';
      const mapped = bases.map((id) => mappedIds(parseStremioId(id), title.episode));
      const imdbId = bases.find((id) => id.startsWith('tt'))
        ?? [meta?.imdb_id, meta?._imdbId].find((id) => typeof id === 'string' && id.startsWith('tt'))
        ?? mapped.find((ids) => ids.imdb)?.imdb;
      const tmdbId = Number(bases.find((id) => id.startsWith('tmdb:'))?.slice(5) ?? meta?._tmdbId ?? mapped.find((ids) => ids.tmdb)?.tmdb);
      const hasTmdb = Number.isFinite(tmdbId) && tmdbId > 0;
      const key = imdbId || (hasTmdb ? `local:${kind}:tmdb:${tmdbId}` : `local:${meta?.id || preferredBase(bases)}`);
      const rating = [...bases, meta?.id, imdbId].map((id) => (id ? ratings.get(String(id)) : undefined)).find((value) => Number.isFinite(value) && value! > 0);
      const held = merged.get(key);
      if (held) {
        held.episodic ||= title.episode;
        for (const episode of title.episodes) held.episodes.add(episode);
        held.row.rating ??= rating;
        if (title.at && (!held.row.watchedAt || new Date(title.at).toISOString() > held.row.watchedAt)) held.row.watchedAt = new Date(title.at).toISOString();
        continue;
      }
      if (merged.size >= max) continue;
      merged.set(key, {
        episodic: title.episode,
        episodes: new Set(title.episodes),
        row: {
          key,
          imdbId,
          tmdbId: hasTmdb ? tmdbId : undefined,
          tmdbType: hasTmdb ? (title.episode ? 'tv' : 'movie') : undefined,
          title: name,
          year: yearOf(meta),
          kind,
          rating,
          watchedAt: title.at ? new Date(title.at).toISOString() : undefined,
          status: 'completed',
          source: 'local',
        },
      });
    }
  }

  logger.debug(`Read ${merged.size} titles from ${plays.length} Jellyfin plays (${ordered.length} found, ${looked} looked up, ${unnamed} without a name)`);
  return [...merged.values()].map(({ row, episodic, episodes }) => (episodic ? { ...row, watchedEpisodes: episodes.size } : row));
}

module.exports = { collectLocalRows, localPlayVersion, localWatchedKeys };
