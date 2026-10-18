import consola from 'consola';
import { tmdbImageUrl } from '../../utils/tmdbImageSize';

const logger = consola.withTag('Jellyfin');

const moviedb: any = require('../getTmdb');

export interface Person {
  source: 'tmdb' | 'tvdb';
  id: number;
  name: string;
  photo: string | null;
  biography: string;
  birthday: string | null;
  deathday: string | null;
  birthplace: string | null;
  imdbId?: string | null;
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

async function tmdbPerson(config: any, id: number, fallback: any = null): Promise<Person | null> {
  const language = config?.language || 'en-US';
  let details: any = null;
  try {
    details = await moviedb.personInfo({ id, language }, config);
  } catch (error: any) {
    logger.debug(`Person details unavailable for ${id}: ${error?.message || error}`);
  }
  if (!details && !fallback) return null;
  return {
    source: 'tmdb',
    id,
    name: details?.name || fallback?.name,
    photo: image(details?.profile_path || fallback?.profile_path, 'h632'),
    biography: details?.biography || '',
    birthday: details?.birthday || null,
    deathday: details?.deathday || null,
    birthplace: details?.place_of_birth || null,
    imdbId: details?.imdb_id || null,
    knownFor: KNOWN_FOR[details?.known_for_department || fallback?.known_for_department] ?? null,
  };
}

export async function personByName(config: any, name: string): Promise<Person | null> {
  const language = config?.language || 'en-US';
  const found = await moviedb.searchPerson({ query: name, language }, config);
  const results: any[] = Array.isArray(found?.results) ? found.results : [];
  const exact = results.filter((p) => String(p?.name || '').toLowerCase() === name.toLowerCase());
  const pick = (exact.length ? exact : results).sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
  if (!pick?.id) return null;
  return tmdbPerson(config, pick.id, pick);
}

const TVDB_PEOPLE_TYPES: Record<string, string> = {
  Actor: 'Actor',
  'Guest Star': 'GuestStar',
  Director: 'Director',
  Writer: 'Writer',
  Creator: 'Creator',
  Producer: 'Producer',
  'Executive Producer': 'Producer',
  Showrunner: 'Producer',
};

const tvdbImage = (path: string | null | undefined): string | null =>
  !path ? null : /^https?:\/\//.test(path) ? path : `https://artworks.thetvdb.com${path.startsWith('/') ? '' : '/'}${path}`;

const remoteId = (record: any, source: string): string | null =>
  (record?.remoteIds || []).find((r: any) => r?.sourceName === source)?.id ?? null;

async function tmdbPersonFor(config: any, record: any): Promise<Person | null> {
  const tmdbId = Number(remoteId(record, 'TheMovieDB.com'));
  if (tmdbId > 0) {
    const person = await tmdbPerson(config, tmdbId);
    if (person) return person;
  }
  const imdbId = remoteId(record, 'IMDB');
  if (!imdbId || !/^nm\d+$/.test(imdbId)) return null;
  const { cacheWrapGlobal } = require('../getCache');
  const found = await cacheWrapGlobal(
    `tmdb:find:person:${imdbId}`,
    () => moviedb.find({ id: imdbId, external_source: 'imdb_id' }, config).then((r: any) => ({ person_results: r?.person_results || [] })),
    24 * 60 * 60
  ).catch(() => null);
  const match = found?.person_results?.[0];
  return match?.id ? tmdbPerson(config, match.id, match) : null;
}

async function tvdbPerson(config: any, id: number): Promise<Person | null> {
  const tvdb = require('../tvdb');
  const record = await tvdb.getPersonExtended(String(id), config).catch(() => null);
  if (!record?.id) return null;
  const linked = await tmdbPersonFor(config, record);
  if (linked) return linked;
  const { to3LetterCode } = require('../language-map');
  const lang3 = await to3LetterCode(config?.language || 'en-US', config).catch(() => 'eng');
  const bios: any[] = Array.isArray(record.biographies) ? record.biographies : [];
  const bio = bios.find((b) => b.language === lang3) || bios.find((b) => b.language === 'eng');
  const counts = new Map<string, number>();
  for (const credit of record.characters || []) {
    const kind = TVDB_PEOPLE_TYPES[credit.peopleType];
    const known = kind === 'GuestStar' ? 'Actor' : kind;
    if (known) counts.set(known, (counts.get(known) || 0) + 1);
  }
  const knownFor = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    source: 'tvdb',
    id: Number(record.id),
    name: record.name,
    photo: tvdbImage(record.image),
    biography: bio?.biography || '',
    birthday: record.birth || null,
    deathday: record.death || null,
    birthplace: record.birthPlace || null,
    imdbId: remoteId(record, 'IMDB'),
    knownFor,
  };
}

export function personById(config: any, source: 'tmdb' | 'tvdb', id: number): Promise<Person | null> {
  return source === 'tvdb' ? tvdbPerson(config, id) : tmdbPerson(config, id);
}

export async function resolvePerson(config: any, ref: { n: string; s?: 'tmdb' | 'tvdb'; x?: number }): Promise<Person | null> {
  if (ref.x) {
    const person = ref.s === 'tvdb' ? await tvdbPerson(config, ref.x) : ref.s === 'tmdb' ? await tmdbPerson(config, ref.x) : null;
    if (person) return person;
  }
  return personByName(config, ref.n);
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
    _artSource: 'tmdb',
    ...(row.original_language ? { _originalLanguage: row.original_language } : {}),
  };
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
    ...(/^tt\d+$/.test(String(ids.imdb || '')) ? { _imdbId: String(ids.imdb) } : {}),
    _artSource: 'simkl',
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

const creditDate = (meta: any): string => String(meta.released || meta.year || '');

async function tvdbCredits(config: any, personId: number): Promise<any[]> {
  const tvdb = require('../tvdb');
  const record = await tvdb.getPersonExtended(String(personId), config).catch(() => null);
  const seen = new Map<string, any>();
  const metas: any[] = [];
  for (const credit of record?.characters || []) {
    const type: 'movie' | 'series' = credit.seriesId ? 'series' : 'movie';
    const titleId = credit.seriesId || credit.movieId;
    if (!titleId) continue;
    const key = `${type}:${titleId}`;
    let meta = seen.get(key);
    if (!meta) {
      const title = (type === 'series' ? credit.series : credit.movie) || {};
      const year = /^\d{4}$/.test(String(title.year || '')) ? String(title.year) : '';
      meta = {
        id: `tvdb:${titleId}`,
        type,
        name: title.name || '',
        poster: tvdbImage(title.image),
        description: '',
        releaseInfo: year,
        year,
        genres: [],
        _tvdbId: String(titleId),
        _artSource: 'tvdb',
        _personTypes: [],
      };
      seen.set(key, meta);
      metas.push(meta);
    }
    const kind = TVDB_PEOPLE_TYPES[credit.peopleType];
    for (const each of kind === 'Actor' || kind === 'GuestStar' ? ['Actor', 'GuestStar'] : kind ? [kind] : []) {
      if (!meta._personTypes.includes(each)) meta._personTypes.push(each);
    }
  }
  return metas;
}

async function tmdbCredits(config: any, personId: number): Promise<any[]> {
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
      meta._votes = Math.max(meta._votes || 0, Number(row.vote_count) || 0);
      for (const kind of creditTypes(row, credit, type)) {
        if (!meta._personTypes.includes(kind)) meta._personTypes.push(kind);
      }
    }
  };
  add(movies?.cast || [], 'cast', 'movie');
  add(movies?.crew || [], 'crew', 'movie');
  add(shows?.cast || [], 'cast', 'series');
  add(shows?.crew || [], 'crew', 'series');
  return metas;
}

/**
 * Every title the person is credited on, as the metas the catalogs hand out,
 * each with the Jellyfin person types it was credited as in `_personTypes`.
 */
export async function personCredits(config: any, person: Person): Promise<any[]> {
  const metas = person.source === 'tvdb' ? await tvdbCredits(config, person.id) : await tmdbCredits(config, person.id);
  return metas.sort((a, b) => creditDate(b).localeCompare(creditDate(a)));
}

export const hasCreditDate = (meta: any): boolean => creditDate(meta) !== '';
