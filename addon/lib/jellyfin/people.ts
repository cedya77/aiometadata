import consola from 'consola';
import { tmdbImageUrl } from '../../utils/tmdbImageSize';

const logger = consola.withTag('Jellyfin');

const moviedb: any = require('../getTmdb');

export interface Person {
  id: number;
  name: string;
  photo: string | null;
  biography: string;
  birthday: string | null;
  deathday: string | null;
  birthplace: string | null;
  /** The Jellyfin person type of what TMDB says they are known for. */
  knownFor: string | null;
}

const KNOWN_FOR: Record<string, string> = {
  Acting: 'Actor',
  Directing: 'Director',
  Writing: 'Writer',
  Production: 'Producer',
  Sound: 'Composer',
  Editing: 'Editor',
  Creator: 'Creator',
};

const image = (path: string | null | undefined, size: string): string | null =>
  path ? tmdbImageUrl(size, path) : null;

// Cast entries carry a name and a photo, not a TMDB id, so the name is the key.
export async function personByName(config: any, name: string): Promise<Person | null> {
  const language = config?.language || 'en-US';
  const found = await moviedb.searchPerson({ query: name, language }, config);
  const results: any[] = Array.isArray(found?.results) ? found.results : [];
  const exact = results.filter((p) => String(p?.name || '').toLowerCase() === name.toLowerCase());
  const pick = (exact.length ? exact : results).sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
  if (!pick?.id) return null;

  let details: any = null;
  try {
    details = await moviedb.personInfo({ id: pick.id, language }, config);
  } catch (error: any) {
    logger.debug(`Person details unavailable for ${pick.id}: ${error?.message || error}`);
  }
  return {
    id: pick.id,
    name: details?.name || pick.name,
    photo: image(details?.profile_path || pick.profile_path, 'h632'),
    biography: details?.biography || '',
    birthday: details?.birthday || null,
    deathday: details?.deathday || null,
    birthplace: details?.place_of_birth || null,
    knownFor: KNOWN_FOR[details?.known_for_department || pick.known_for_department] ?? null,
  };
}

/** A TMDB list row as the meta a catalog would hand out, opened by its TMDB id. */
export function metaFromTmdbRow(row: any, type: 'movie' | 'series'): any | null {
  if (!row?.id) return null;
  const date = String(row.release_date || row.first_air_date || '');
  return {
    id: `tmdb:${row.id}`,
    type,
    name: row.title || row.name || '',
    poster: image(row.poster_path, 'w500'),
    background: image(row.backdrop_path, 'w1280'),
    landscapePoster: image(row.backdrop_path, 'w780'),
    description: row.overview || '',
    releaseInfo: date.slice(0, 4),
    released: date || undefined,
    year: date.slice(0, 4),
    imdbRating: row.vote_average ? String(Math.round(row.vote_average * 10) / 10) : undefined,
    genres: [],
    _tmdbId: String(row.id),
  };
}

export async function previewMeta(config: any, userUUID: string, type: 'movie' | 'series', id: string): Promise<any | null> {
  const { cacheWrapMetaSmart } = require('../getCache');
  const { getMeta } = require('../getMeta');
  const { applyMetaArt } = require('../metaArt');
  const scoped = { ...config, userUUID };
  const language = config?.language || 'en-US';
  const result = await cacheWrapMetaSmart(
    userUUID,
    id,
    () => getMeta(type, language, id, scoped, userUUID, false),
    undefined,
    { enableErrorCaching: true, maxRetries: 2, config: scoped },
    type,
    false
  );
  if (!result?.meta) return null;
  const meta = { ...result.meta };
  applyMetaArt(meta, scoped, type, '');
  return meta;
}

const simklImage = (path: string | null | undefined, kind: 'posters' | 'fanart', size: string): string | null =>
  path ? `https://wsrv.nl/?url=https://simkl.in/${kind}/${path}_${size}.webp` : null;

/** A Simkl suggestion as the meta a catalog would hand out, opened by its MAL, TMDB or IMDb id. */
function metaFromSimklRow(row: any): any | null {
  const ids = row?.ids || {};
  const type: 'movie' | 'series' = row?.type === 'movie' || row?.anime_type === 'movie' ? 'movie' : 'series';
  const malId = row?.type === 'anime' ? Number(ids.mal) : NaN;
  const id = malId > 0 ? `mal:${malId}` : ids.tmdb ? `tmdb:${ids.tmdb}` : /^tt\d+$/.test(String(ids.imdb || '')) ? String(ids.imdb) : null;
  if (!id) return null;
  const year = row.year ? String(row.year) : '';
  return {
    id,
    type,
    name: row.en_title || row.title || '',
    poster: simklImage(row.poster, 'posters', 'm'),
    background: simklImage(row.fanart, 'fanart', 'medium'),
    landscapePoster: simklImage(row.fanart, 'fanart', 'mobile'),
    description: '',
    releaseInfo: year,
    year,
    genres: [],
    ...(ids.tmdb ? { _tmdbId: String(ids.tmdb) } : {}),
  };
}

/** What the chosen source recommends next to a title. Simkl falls back to TMDB when it has nothing for it. */
export async function similarTitles(config: any, meta: any, type: 'movie' | 'series'): Promise<any[]> {
  if (config?.jellyfinSimilarSource === 'simkl') {
    const { fetchSimklRecommendations } = require('../../utils/simklUtils');
    const rows: any[] = await fetchSimklRecommendations(
      { mal: meta?._malId, imdb: meta?._imdbId || meta?.imdb_id, tmdb: meta?._tmdbId },
      type
    ).catch((error: any) => {
      logger.debug(`Simkl similar titles unavailable for ${meta?.id}: ${error?.message || error}`);
      return [];
    });
    const metas = rows.map(metaFromSimklRow).filter(Boolean);
    if (metas.length) return metas;
  }
  if (!meta?._tmdbId) return [];
  const language = config?.language || 'en-US';
  const page = type === 'movie'
    ? await moviedb.movieRecommendations({ id: meta._tmdbId, language }, config)
    : await moviedb.tvRecommendations({ id: meta._tmdbId, language }, config);
  return (page?.results || []).map((row: any) => metaFromTmdbRow(row, type)).filter(Boolean);
}

// Talk, news and reality shows, where an actor appears as themselves.
const UNSCRIPTED_TV = new Set([10763, 10764, 10767]);
const DOCUMENTARY = 99;
const AS_THEMSELVES = /^(self|himself|herself|themselves|themself)\b/i;

function playsThemselves(row: any, type: 'movie' | 'series'): boolean {
  const genres: number[] = row.genre_ids || [];
  const character = String(row.character || '').trim();
  if (type === 'series' && genres.some((g) => UNSCRIPTED_TV.has(g))) return true;
  if (genres.includes(DOCUMENTARY) && (!character || /^(self|him|her|them)/i.test(character))) return true;
  return AS_THEMSELVES.test(character);
}

/** The Jellyfin person types a TMDB credit counts as. */
function creditTypes(row: any, credit: 'cast' | 'crew', type: 'movie' | 'series'): string[] {
  if (credit === 'cast') return playsThemselves(row, type) ? [] : ['Actor', 'GuestStar'];
  const job = String(row.job || '');
  const types: string[] = [];
  if (job === 'Director') types.push('Director');
  if (row.department === 'Writing') types.push('Writer');
  if (row.department === 'Creator') types.push('Creator');
  if (/producer/i.test(job)) types.push('Producer');
  if (/composer/i.test(job) || job === 'Music') types.push('Composer');
  if (job === 'Editor') types.push('Editor');
  return types;
}

/**
 * Every title the person is credited on, as the metas the catalogs hand out,
 * each with the Jellyfin person types it was credited as in `_personTypes`.
 */
export async function personCredits(config: any, personId: number): Promise<any[]> {
  const language = config?.language || 'en-US';
  const [movies, shows] = await Promise.all([
    moviedb.personMovieCredits({ id: personId, language }, config).catch(() => null),
    moviedb.personTvCredits({ id: personId, language }, config).catch(() => null),
  ]);
  const seen = new Map<string, any>();
  const metas: any[] = [];
  const add = (rows: any[], credit: 'cast' | 'crew', type: 'movie' | 'series') => {
    for (const row of rows) {
      const key = `${type}:${row?.id}`;
      let meta = seen.get(key);
      if (!meta) {
        meta = metaFromTmdbRow(row, type);
        if (!meta) continue;
        meta._personTypes = [];
        seen.set(key, meta);
        metas.push(meta);
      }
      for (const kind of creditTypes(row, credit, type)) {
        if (!meta._personTypes.includes(kind)) meta._personTypes.push(kind);
      }
    }
  };
  add(movies?.cast || [], 'cast', 'movie');
  add(movies?.crew || [], 'crew', 'movie');
  add(shows?.cast || [], 'cast', 'series');
  add(shows?.crew || [], 'crew', 'series');
  metas.sort((a, b) => String(b.released || '').localeCompare(String(a.released || '')));
  return metas;
}
