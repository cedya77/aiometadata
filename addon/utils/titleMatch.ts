import consola from 'consola';
import { envInt } from './envNumber';

const logger = consola.withTag('TitleMatch');

export type TitleQuery = { title: string; year?: number; kind: 'movie' | 'series'; strict?: boolean };

export type TitleMatch = { hit: any; imdbId?: string; matchedBy: 'lumiere' | 'tmdb' };

function closestYear<T>(entries: T[], yearOf: (entry: T) => number, year?: number): T | undefined {
  if (!year) return entries[0];
  return entries.find((entry) => yearOf(entry) === year)
    ?? entries.find((entry) => yearOf(entry) && Math.abs(yearOf(entry) - year) <= 1);
}

export function comparable(title: string): string {
  return title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function onlyOne<T>(entries: T[], yearOf: (entry: T) => number, year: number | undefined, spelledAsAsked: (entry: T) => boolean): T | undefined {
  const sameYear = year ? entries.filter((entry) => yearOf(entry) === year) : entries;
  const pool = sameYear.length || !year ? sameYear : entries.filter((entry) => yearOf(entry) && Math.abs(yearOf(entry) - year) <= 1);
  if (pool.length <= 1) return pool[0];
  const exact = pool.filter(spelledAsAsked);
  return exact.length === 1 ? exact[0] : undefined;
}

const spelledAs = (pick: TitleQuery) => {
  const asked = pick.title.trim().toLowerCase();
  return (...titles: Array<string | undefined>) => titles.some((title) => title?.trim().toLowerCase() === asked);
};

async function matchOnLumiere(pick: TitleQuery, config: any): Promise<any | null> {
  const { lumiereApiBase }: any = require('./lumiereLists');
  const base = lumiereApiBase();
  if (!base) return null;
  const { getSetting }: any = require('../lib/settingsService');
  const { fetchLumiereSearch }: any = require('./lumiereSearch');
  const { cacheWrapGlobal }: any = require('../lib/getCache');
  const type = pick.kind === 'series' ? 'series' : 'movie';
  const timeoutMs = parseInt(getSetting('LUMIERE_SEARCH_TIMEOUT_MS'), 10) || 5000;
  const ttl = parseInt(getSetting('LUMIERE_SEARCH_TTL_SECONDS'), 10);
  const search = () => fetchLumiereSearch(base, type, pick.title, 10, timeoutMs);
  const results: Array<{ imdbId: string; year: number | null; title?: string; originalTitle?: string; akas?: string[] }> = (ttl > 0
    ? await cacheWrapGlobal(`recommendations:lumiere:v2:${type}:${pick.title.toLowerCase().trim()}`, search, ttl)
    : await search()) || [];
  const wanted = comparable(pick.title);
  const yearOf = (entry: (typeof results)[number]) => entry.year || 0;
  const named = results.filter((entry) => [entry.title, entry.originalTitle, ...(entry.akas ?? [])].some((title) => title && comparable(title) === wanted));
  const match = pick.strict
    ? onlyOne(named, yearOf, pick.year, (entry) => spelledAs(pick)(entry.title, entry.originalTitle))
    : closestYear(named, yearOf, pick.year)
      ?? named.find((entry) => (entry.akas ?? []).some((title) => comparable(title) === wanted))
      ?? closestYear(results, yearOf, pick.year);
  if (!match) return null;

  const { find }: any = require('../lib/getTmdb');
  const found = await cacheWrapGlobal(
    `recommendations:find:${match.imdbId}`,
    () => find({ id: match.imdbId, external_source: 'imdb_id' }, config),
    envInt('RECOMMENDATION_FACT_TTL', 30 * 24 * 60 * 60, 60),
    {
      resultClassifier: (result: any) => (result?.movie_results?.length || result?.tv_results?.length
        ? { type: 'SUCCESS', ttl: null }
        : { type: 'EMPTY_RESULT', ttl: 60 * 60 }),
    },
  );
  const hit = (pick.kind === 'series' ? found?.tv_results : found?.movie_results)?.[0];
  return hit?.id ? { hit, imdbId: match.imdbId } : null;
}

const tmdbYearOf = (entry: any) => Number(String(entry.release_date || entry.first_air_date || '').slice(0, 4));

const tmdbNamed = (pick: TitleQuery, entries: any[]) => {
  const wanted = comparable(pick.title);
  return entries.filter((entry: any) => entry?.id && [entry.title, entry.name, entry.original_title, entry.original_name].some((title) => title && comparable(title) === wanted));
};

async function tmdbSearch(pick: TitleQuery, config: any, withYear: boolean): Promise<any[]> {
  const { searchMovie, searchTv }: any = require('../lib/getTmdb');
  const params: any = { query: pick.title, include_adult: false };
  if (withYear && pick.year) params[pick.kind === 'series' ? 'first_air_date_year' : 'year'] = pick.year;
  const response = pick.kind === 'series' ? await searchTv(params, config) : await searchMovie(params, config);
  return response?.results || [];
}

async function searchTmdb(pick: TitleQuery, config: any): Promise<any | null> {
  const results = await tmdbSearch(pick, config, true);
  const spelled = (entry: any) => spelledAs(pick)(entry.title, entry.name, entry.original_title, entry.original_name);
  const first = pick.strict ? onlyOne(tmdbNamed(pick, results), tmdbYearOf, pick.year, spelled) : results[0];
  if (first?.id || !pick.year) return first?.id ? first : null;
  const loose = await tmdbSearch(pick, config, false);
  if (pick.strict) return onlyOne(tmdbNamed(pick, loose), tmdbYearOf, pick.year, spelled) ?? null;
  return closestYear(loose.filter((entry: any) => entry?.id), tmdbYearOf, pick.year) ?? null;
}

export async function titleChoices(pick: TitleQuery, config: any, limit = 6): Promise<any[]> {
  const near = (entries: any[]) => tmdbNamed(pick, entries).filter((entry) => !pick.year || (tmdbYearOf(entry) && Math.abs(tmdbYearOf(entry) - pick.year) <= 1));
  const dated = near(await tmdbSearch(pick, config, true));
  const found = dated.length || !pick.year ? dated : near(await tmdbSearch(pick, config, false));
  return found.slice(0, limit);
}

export async function matchTitle(pick: TitleQuery, config: any): Promise<TitleMatch | null> {
  const lumiere = await matchOnLumiere(pick, config).catch((error: any) => {
    logger.debug(`LumiereDB could not match "${pick.title}": ${error.message}`);
    return null;
  });
  if (lumiere?.hit?.id) return { hit: lumiere.hit, imdbId: lumiere.imdbId, matchedBy: 'lumiere' };
  const hit = await searchTmdb(pick, config);
  return hit?.id ? { hit, matchedBy: 'tmdb' } : null;
}
