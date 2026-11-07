import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';

type Kind = 'movie' | 'series';
type Sorting = { sortBy?: unknown; sortOrder?: unknown };
type Order = { field: 'popularity' | 'name' | 'date' | 'rating'; descending: boolean };

const TMDB_PAGE = 20;

function orderOf({ sortBy, sortOrder }: Sorting): Order {
  const key = String(sortBy ?? '').split(',')[0].trim().toLowerCase();
  const descending = String(sortOrder ?? '').split(',')[0].trim().toLowerCase().startsWith('desc');
  if (key === 'sortname' || key === 'name') return { field: 'name', descending };
  if (key === 'premieredate' || key === 'productionyear' || key === 'datecreated') return { field: 'date', descending };
  if (key === 'communityrating' || key === 'criticrating') return { field: 'rating', descending: true };
  return { field: 'popularity', descending: true };
}

export function rowYear(row: any): number | null {
  const year = parseInt(String(row?.release_date || row?.first_air_date || '').slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

/** TMDB discover parameters for the titles of the given years, in the client's order. */
export function discoverParams(kind: Kind, years: number[], options: Sorting & { language?: string; page?: number; ageCap?: unknown }): Record<string, unknown> {
  const order = orderOf(options);
  const way = order.descending ? 'desc' : 'asc';
  const field = {
    popularity: 'popularity',
    name: kind === 'movie' ? 'title' : 'name',
    date: kind === 'movie' ? 'primary_release_date' : 'first_air_date',
    rating: 'vote_average',
  }[order.field];
  const params: Record<string, unknown> = {
    include_adult: false,
    ...(kind === 'movie' ? { include_video: false } : {}),
    ...(options.language ? { language: options.language } : {}),
    ...(options.page ? { page: options.page } : {}),
    sort_by: `${field}.${way}`,
    ...(order.field === 'rating' ? { 'vote_count.gte': 20 } : {}),
  };
  const sorted = [...years].sort((a, b) => a - b);
  if (sorted.length === 1) {
    params[kind === 'movie' ? 'primary_release_year' : 'first_air_date_year'] = sorted[0];
  } else {
    const dated = kind === 'movie' ? 'primary_release_date' : 'first_air_date';
    params[`${dated}.gte`] = `${sorted[0]}-01-01`;
    params[`${dated}.lte`] = `${sorted[sorted.length - 1]}-12-31`;
  }
  const cap = typeof options.ageCap === 'string' ? options.ageCap : '';
  if (kind === 'movie' && cap && cap.toLowerCase() !== 'none') {
    params.certification_country = 'US';
    params['certification.lte'] = cap;
  }
  return params;
}

function sortValue(row: any, field: Order['field']): string | number {
  if (field === 'name') return String(row?.title || row?.name || '').toLowerCase();
  if (field === 'date') return String(row?.release_date || row?.first_air_date || '');
  if (field === 'rating') return Number(row?.vote_average) || 0;
  return Number(row?.popularity) || 0;
}

/** Films and shows, each already in discover's order, merged into one list in that order. */
export function mergeRows(films: any[], shows: any[], sorting: Sorting): Array<{ row: any; type: Kind }> {
  const order = orderOf(sorting);
  const before = (a: any, b: any): boolean => {
    const x = sortValue(a, order.field);
    const y = sortValue(b, order.field);
    if (x === y) return true;
    return order.descending ? x > y : x < y;
  };
  const out: Array<{ row: any; type: Kind }> = [];
  let i = 0;
  let j = 0;
  while (i < films.length || j < shows.length) {
    if (j >= shows.length || (i < films.length && before(films[i], shows[j]))) out.push({ row: films[i++], type: 'movie' });
    else out.push({ row: shows[j++], type: 'series' });
  }
  return out;
}

const pages = new LRUCache<string, any>({
  max: envInt('JELLYFIN_DISCOVER_PAGE_CACHE_MAX', 500, 1),
  ttl: envInt('JELLYFIN_DISCOVER_PAGE_TTL', 600, 1) * 1000,
});

async function discoverPage(kind: Kind, params: Record<string, unknown>, config: any): Promise<any> {
  const key = `${config?.apiKeys?.tmdb ?? ''}|${kind}|${JSON.stringify(params)}`;
  const held = pages.get(key);
  if (held) return held;
  const moviedb: any = require('../getTmdb');
  const page = kind === 'movie' ? await moviedb.discoverMovie(params, config) : await moviedb.discoverTv(params, config);
  pages.set(key, page);
  return page;
}

function kindsAsked(includeItemTypes: unknown): Kind[] {
  const wanted = new Set(String(includeItemTypes ?? '').split(',').map((t) => t.trim()).filter(Boolean));
  if (!wanted.size) return ['movie', 'series'];
  return [...(wanted.has('Movie') ? ['movie' as Kind] : []), ...(wanted.has('Series') ? ['series' as Kind] : [])];
}

/**
 * A year's titles from TMDB discover, as person pages read a person's credits: complete for the year, with a real
 * total, in the client's order. Several years that are not one unbroken span are read as their span and filtered,
 * so their total is a page of lookahead until the span runs out.
 */
export async function yearListing(options: {
  config: any;
  userUUID: string;
  serverId: string;
  years: number[];
  includeItemTypes?: unknown;
  sortBy?: unknown;
  sortOrder?: unknown;
  startIndex: number;
  limit: number;
}): Promise<{ items: any[]; total: number }> {
  const { config, userUUID, serverId, years, startIndex, limit } = options;
  const kinds = kindsAsked(options.includeItemTypes);
  if (!kinds.length || !years.length) return { items: [], total: 0 };

  const span = Math.max(...years) - Math.min(...years) + 1;
  const exact = span === new Set(years).size;
  const yearSet = new Set(years);
  const maxPages = envInt('JELLYFIN_DISCOVER_MAX_PAGES', 25, 1);
  const need = startIndex + limit;
  const read: Record<Kind, any[]> = { movie: [], series: [] };
  let total = 0;
  let ended = true;

  for (const kind of kinds) {
    let pageNo = 1;
    let lastPage = 1;
    let kindTotal = 0;
    while (read[kind].length < need && pageNo <= Math.min(lastPage, maxPages)) {
      const params = discoverParams(kind, years, { sortBy: options.sortBy, sortOrder: options.sortOrder, language: config?.language, page: pageNo, ageCap: config?.ageRating });
      const page = await discoverPage(kind, params, config);
      const rows: any[] = Array.isArray(page?.results) ? page.results : [];
      read[kind].push(...(exact ? rows : rows.filter((row) => yearSet.has(rowYear(row) ?? -1))));
      lastPage = Number(page?.total_pages) || pageNo;
      kindTotal = Number(page?.total_results) || 0;
      pageNo += 1;
      if (!rows.length) break;
    }
    total += Math.min(kindTotal, maxPages * TMDB_PAGE);
    if (pageNo <= Math.min(lastPage, maxPages)) ended = false;
  }

  const merged = mergeRows(read.movie, read.series, options);
  const window = merged.slice(startIndex, startIndex + limit);
  const { metaFromTmdbRow } = require('./people');
  const { titleCards } = require('../titleCards');
  const { metaToBaseItem } = require('./items');
  const { keepsUnderProfileCap } = require('./profiles');
  const metas = window.map(({ row, type }) => metaFromTmdbRow(row, type)).filter(Boolean);
  const cards = await titleCards(config, userUUID, metas);
  const items = cards
    .map((card: any, i: number) => metaToBaseItem(card, metas[i].type, serverId, null))
    .filter(keepsUnderProfileCap(config));
  const reached = startIndex + window.length;
  return { items, total: exact ? Math.max(total, reached) : ended && merged.length <= need ? merged.length : reached + limit };
}
