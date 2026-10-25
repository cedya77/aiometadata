import { httpGet } from './httpClient.js';

export interface LumiereResult {
  imdbId: string;
  title: string;
  year: number | null;
  originalTitle?: string;
  akas?: string[];
}

// LumiereDB caps queries at 120 runes and limit at 50, and answers anything past either with a 400.
const MAX_QUERY_RUNES = 120;
const MAX_LIMIT = 50;

export async function fetchLumiereSearch(
  baseUrl: string,
  type: string,
  query: string,
  limit: number,
  timeoutMs: number
): Promise<LumiereResult[]> {
  const normalized = Array.from(query.replace(/\s+/g, ' ').trim()).slice(0, MAX_QUERY_RUNES).join('');
  if (!normalized) return [];

  const params = new URLSearchParams({
    query: normalized,
    type: type === 'movie' ? 'movies' : 'series',
    limit: String(Math.min(Math.max(limit, 1), MAX_LIMIT)),
  });
  const url = `${baseUrl.replace(/\/+$/, '')}/search?${params}`;

  const response: any = await httpGet(url, { timeout: timeoutMs });
  const items = response?.data?.items;
  if (!Array.isArray(items)) {
    throw new Error(`LumiereDB returned no result list (status ${response?.status})`);
  }

  return items
    .filter((item: any) => typeof item?.tconst === 'string' && item.tconst.startsWith('tt'))
    .map((item: any) => ({
      imdbId: item.tconst,
      title: item.primaryTitle || '',
      year: typeof item.startYear === 'number' ? item.startYear : null,
      ...(typeof item.originalTitle === 'string' && item.originalTitle ? { originalTitle: item.originalTitle } : {}),
      ...(Array.isArray(item.akaTitles) ? { akas: item.akaTitles.filter((aka: any) => typeof aka === 'string' && aka) } : {}),
    }));
}

const PEOPLE_MAX_QUERY_RUNES = 80;
const PEOPLE_MAX_LIMIT = 200;

export async function fetchLumierePeopleSearch(
  baseUrl: string,
  type: string,
  query: string,
  timeoutMs: number
): Promise<LumiereResult[]> {
  const normalized = Array.from(query.replace(/\s+/g, ' ').trim()).slice(0, PEOPLE_MAX_QUERY_RUNES).join('');
  if (!normalized) return [];

  const params = new URLSearchParams({
    query: normalized,
    type: type === 'movie' ? 'movies' : 'series',
    limit: String(PEOPLE_MAX_LIMIT),
  });
  let response: any;
  try {
    response = await httpGet(`${baseUrl.replace(/\/+$/, '')}/search/people?${params}`, { timeout: timeoutMs });
  } catch (error: any) {
    if (error?.response?.status === 404) return [];
    throw error;
  }
  const items = response?.data?.items;
  if (!Array.isArray(items)) {
    throw new Error(`LumiereDB returned no result list (status ${response?.status})`);
  }

  return items
    .filter((item: any) => typeof item?.tconst === 'string' && item.tconst.startsWith('tt'))
    .map((item: any) => ({
      imdbId: item.tconst,
      title: item.primaryTitle || '',
      year: typeof item.startYear === 'number' ? item.startYear : null,
    }));
}

export interface LumiereSuggestion extends LumiereResult {
  kind: 'movie' | 'series';
}

// /search/suggest takes 2 to 80 runes and at most 15 results, and answers 404 while it is turned off.
const SUGGEST_MIN_QUERY_RUNES = 2;
const SUGGEST_MAX_QUERY_RUNES = 80;
const SUGGEST_MAX_LIMIT = 15;
const SERIES_TITLE_TYPES = new Set(['tvseries', 'tvminiseries']);

/** Titles whose names start with what was typed, best first; null while the instance has suggestions off. */
export async function fetchLumiereSuggest(
  baseUrl: string,
  type: 'movie' | 'series' | null,
  query: string,
  limit: number,
  includeAdult: boolean,
  timeoutMs: number
): Promise<LumiereSuggestion[] | null> {
  const runes = Array.from(query.replace(/\s+/g, ' ').trim());
  if (runes.length < SUGGEST_MIN_QUERY_RUNES) return [];

  const params = new URLSearchParams({
    query: runes.slice(0, SUGGEST_MAX_QUERY_RUNES).join(''),
    limit: String(Math.min(Math.max(limit, 1), SUGGEST_MAX_LIMIT)),
  });
  if (type) params.set('type', type === 'movie' ? 'movies' : 'series');
  if (includeAdult) params.set('include_adult', 'true');

  let response: any;
  try {
    response = await httpGet(`${baseUrl.replace(/\/+$/, '')}/search/suggest?${params}`, { timeout: timeoutMs });
  } catch (error: any) {
    if (error?.response?.status === 404) return null;
    throw error;
  }
  const items = response?.data?.items;
  if (!Array.isArray(items)) {
    throw new Error(`LumiereDB returned no suggestion list (status ${response?.status})`);
  }

  return items
    .filter((item: any) => typeof item?.tconst === 'string' && item.tconst.startsWith('tt'))
    .map((item: any) => ({
      imdbId: item.tconst,
      title: item.primaryTitle || '',
      year: typeof item.startYear === 'number' ? item.startYear : null,
      kind: SERIES_TITLE_TYPES.has(String(item.titleType || '').toLowerCase()) ? 'series' as const : 'movie' as const,
    }));
}
