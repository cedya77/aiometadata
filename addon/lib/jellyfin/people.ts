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
}

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

/** What TMDB recommends next to a title. */
export async function similarTitles(config: any, tmdbId: string, type: 'movie' | 'series'): Promise<any[]> {
  const language = config?.language || 'en-US';
  const page = type === 'movie'
    ? await moviedb.movieRecommendations({ id: tmdbId, language }, config)
    : await moviedb.tvRecommendations({ id: tmdbId, language }, config);
  return (page?.results || []).map((row: any) => metaFromTmdbRow(row, type)).filter(Boolean);
}

/** Every title the person is credited on, as the metas the catalogs hand out. */
export async function personCredits(config: any, personId: number): Promise<any[]> {
  const language = config?.language || 'en-US';
  const [movies, shows] = await Promise.all([
    moviedb.personMovieCredits({ id: personId, language }, config).catch(() => null),
    moviedb.personTvCredits({ id: personId, language }, config).catch(() => null),
  ]);
  const seen = new Set<string>();
  const metas: any[] = [];
  const add = (rows: any[], type: 'movie' | 'series') => {
    for (const row of rows) {
      const meta = metaFromTmdbRow(row, type);
      if (!meta || seen.has(`${type}:${meta.id}`)) continue;
      seen.add(`${type}:${meta.id}`);
      metas.push(meta);
    }
  };
  add([...(movies?.cast || []), ...(movies?.crew || [])], 'movie');
  add([...(shows?.cast || []), ...(shows?.crew || [])], 'series');
  metas.sort((a, b) => String(b.released || '').localeCompare(String(a.released || '')));
  return metas;
}
