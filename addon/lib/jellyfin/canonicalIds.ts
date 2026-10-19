import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';

type Kind = 'movie' | 'series';

const memo = new LRUCache<string, Record<string, any>>({
  max: envInt('JELLYFIN_RESUME_CACHE_MAX', 500, 1) * 10,
  ttl: envInt('JELLYFIN_ID_RESOLUTION_DAYS', 30, 1) * 24 * 60 * 60 * 1000,
});

function anchorOf(ids: { tvdb?: any; tmdb?: any }, kind: Kind): string | null {
  if (kind === 'movie') return ids?.tmdb ? `tmdb:${ids.tmdb}` : null;
  return ids?.tvdb ? `tvdb:${ids.tvdb}` : ids?.tmdb ? `tmdb:${ids.tmdb}` : null;
}

const identityKey = (kind: Kind, anchor: string): string => `${kind === 'movie' ? 'm' : 's'}|${anchor}`;

export function identityFromIds(ids: { tvdb?: any; tmdb?: any }, kind: Kind): string | null {
  const anchor = anchorOf(ids, kind);
  return anchor ? identityKey(kind, anchor) : null;
}

async function resolve(id: string, kind: Kind, config: any, targets: string[]): Promise<Record<string, any>> {
  const key = `${kind}:${id}:${targets.join(',')}`;
  const held = memo.get(key);
  if (held) return held;
  try {
    const { resolveAllIds } = require('../id-resolver');
    const all = await resolveAllIds(id, kind, config, {}, targets);
    const found = { imdb: all?.imdbId, tmdb: all?.tmdbId, tvdb: all?.tvdbId };
    if (found.imdb || found.tmdb || found.tvdb) memo.set(key, found);
    return found;
  } catch {
    return {};
  }
}

/** The tracker's ids, with the IMDb id the resolver gives its TVDB or TMDB id. */
export async function canonicalIds(ids: Record<string, any>, kind: Kind, config: any): Promise<Record<string, any>> {
  const anchor = anchorOf(ids, kind);
  if (!anchor) return ids ?? {};
  const resolved = await resolve(anchor, kind, config, ['imdb']);
  return {
    ...ids,
    ...(resolved.imdb ? { imdb: resolved.imdb } : {}),
    ...(!ids?.tmdb && resolved.tmdb ? { tmdb: resolved.tmdb } : {}),
    ...(!ids?.tvdb && resolved.tvdb ? { tvdb: resolved.tvdb } : {}),
  };
}

const ANIME_ID_TYPES = ['kitsu', 'mal', 'anilist', 'anidb'];

export function isAnimeId(id: string): boolean {
  return ANIME_ID_TYPES.includes(String(id).split(':')[0]);
}

export function isAnimeTitle(id: string, kind: 'movie' | 'series'): boolean {
  const { parseStremioId } = require('./ids');
  const base = String(parseStremioId(id)?.base ?? id);
  const [prefix, value] = base.split(':');
  if (ANIME_ID_TYPES.includes(prefix)) return true;
  const idMapper = require('../id-mapper');
  if (base.startsWith('tt')) return Boolean(idMapper.getMappingByImdbId(base));
  if (prefix === 'tvdb') return Boolean(idMapper.getMappingByTvdbId(Number(value)));
  if (prefix === 'tmdb') return Boolean(idMapper.getMappingByTmdbId(Number(value), kind));
  return false;
}

/** A show's identity across spellings; anime keeps its own ids. */
export async function showIdentity(metaId: string, config: any): Promise<string> {
  const { parseStremioId } = require('./ids');
  const parsed = parseStremioId(metaId);
  const base = parsed?.base ?? metaId;
  if (!parsed || ANIME_ID_TYPES.includes(parsed.idType)) return base;
  return anchorOf(await resolve(base, 'series', config, ['tvdb', 'tmdb']), 'series') ?? base;
}

/** A video's identity across spellings; anime keeps its own ids. */
export async function titleIdentity(videoId: string, config: any): Promise<string> {
  const { parseStremioId } = require('./ids');
  const parsed = parseStremioId(videoId);
  if (!parsed) return videoId;
  if (ANIME_ID_TYPES.includes(parsed.idType)) return videoId;
  const isEpisode = parsed.episode !== null && parsed.episode !== undefined;
  if (isEpisode) return `${await showIdentity(parsed.base, config)}:${parsed.season ?? ''}:${parsed.episode}`;
  return anchorOf(await resolve(parsed.base, 'movie', config, ['tmdb']), 'movie') ?? parsed.base;
}

const ANIME_LOOKUPS: Record<string, string> = { mal: 'getMappingByMalId', kitsu: 'getMappingByKitsuId', anilist: 'getMappingByAnilistId', anidb: 'getMappingByAnidbId' };

function firstId(value: any): string | null {
  const id = Array.isArray(value) ? value[0] : value;
  return id === undefined || id === null || id === '' ? null : String(id);
}

/** One title however a source spells it: `m|` films by TMDB, `s|` shows by TVDB or TMDB. `anime` marks a per-entry anime id. */
export async function watchlistIdentity(metaId: string, mediaType: 'movie' | 'series' | 'anime', config: any): Promise<{ key: string; anime: boolean }> {
  const { parseStremioId } = require('./ids');
  const base = String(parseStremioId(metaId)?.base ?? metaId);
  const [prefix, value] = base.split(':');
  const idMapper = require('../id-mapper');
  if (ANIME_LOOKUPS[prefix]) {
    const entry = idMapper[ANIME_LOOKUPS[prefix]]?.(value);
    if (!entry) return { key: base, anime: true };
    const movie = entry.type === 'MOVIE' || entry.themoviedb_type === 'movie';
    const tmdb = firstId(entry.themoviedb_id);
    if (movie) return { key: identityFromIds({ tmdb: idMapper.filmIdsFor(entry).tmdbId }, 'movie') ?? base, anime: true };
    const tvdb = firstId(entry.tvdb_id);
    return { key: identityFromIds({ tvdb, tmdb: entry.themoviedb_type === 'tv' ? tmdb : null }, 'series') ?? base, anime: true };
  }
  const movie = mediaType === 'movie' || (mediaType === 'anime' && Boolean(idMapper.filmMappingFor?.({ imdbId: base })));
  return movie
    ? { key: identityKey('movie', await titleIdentity(base, config)), anime: false }
    : { key: identityKey('series', await showIdentity(base, config)), anime: false };
}
