import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { tmdbCertificationFilter } from '../../utils/ageRating';

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

/** The discover parameters that keep one year, or the span of several. */
function yearParams(kind: Kind, years: number[]): Record<string, unknown> {
  const sorted = [...years].sort((a, b) => a - b);
  if (sorted.length === 1) return { [kind === 'movie' ? 'primary_release_year' : 'first_air_date_year']: sorted[0] };
  if (!sorted.length) return {};
  const dated = kind === 'movie' ? 'primary_release_date' : 'first_air_date';
  return { [`${dated}.gte`]: `${sorted[0]}-01-01`, [`${dated}.lte`]: `${sorted[sorted.length - 1]}-12-31` };
}

/** TMDB discover parameters for the titles of the given years, in the client's order. */
export function discoverParams(kind: Kind, years: number[], options: Sorting & { language?: string; page?: number; ageCap?: unknown; includeAdult?: unknown }): Record<string, unknown> {
  const order = orderOf(options);
  const way = order.descending ? 'desc' : 'asc';
  const field = {
    popularity: 'popularity',
    name: kind === 'movie' ? 'title' : 'name',
    date: kind === 'movie' ? 'primary_release_date' : 'first_air_date',
    rating: 'vote_average',
  }[order.field];
  const params: Record<string, unknown> = {
    include_adult: options.includeAdult === true,
    ...(kind === 'movie' ? { include_video: false } : {}),
    ...(options.language ? { language: options.language } : {}),
    ...(options.page ? { page: options.page } : {}),
    sort_by: `${field}.${way}`,
    ...(order.field === 'rating' ? { 'vote_count.gte': 20 } : {}),
  };
  Object.assign(params, yearParams(kind, years));
  const certificationFilter = tmdbCertificationFilter(options.ageCap, kind === 'movie' ? 'movie' : 'tv');
  if (certificationFilter) Object.assign(params, certificationFilter);
  return params;
}

// TMDB, TVDB and Jikan rows each spell these differently.
function sortValue(row: any, field: Order['field']): string | number {
  if (field === 'name') return String(row?.title || row?.name || '').toLowerCase();
  if (field === 'date') return String(row?.release_date || row?.first_air_date || row?.firstAired || row?.year || '');
  if (field === 'rating') return Number(row?.vote_average ?? row?.score) || 0;
  return Number(row?.popularity ?? row?.score ?? row?.members) || 0;
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

const pageTtl = (): number => envInt('JELLYFIN_DISCOVER_PAGE_TTL', 600, 1);

const pages = new LRUCache<string, { load: Promise<any>; by: string }>({
  max: envInt('JELLYFIN_DISCOVER_PAGE_CACHE_MAX', 500, 1),
  ttl: pageTtl() * 1000,
});

/**
 * A page held while it loads, so callers asking at once share one request; a failed load is not kept. `by` is the
 * key the load was asked with: a caller with another key that joined a failed load asks again with its own.
 */
function heldPage(key: string, by: string, load: () => Promise<any>): Promise<any> {
  const held = pages.get(key);
  if (held) return held.by === by ? held.load : held.load.catch(() => load());
  const page = load();
  pages.set(key, { load: page, by });
  page.catch(() => {
    if (pages.get(key)?.load === page) pages.delete(key);
  });
  return page;
}

// Discover answers the same for any TMDB key, so every user shares a page.
function discoverPage(kind: Kind, params: Record<string, unknown>, config: any): Promise<any> {
  const key = `jf-discover:${kind}:${JSON.stringify(params)}`;
  return heldPage(key, String(config?.apiKeys?.tmdb ?? ''), () => {
    const { cacheWrapGlobal } = require('../getCache');
    const moviedb: any = require('../getTmdb');
    return cacheWrapGlobal(key, () => (kind === 'movie' ? moviedb.discoverMovie(params, config) : moviedb.discoverTv(params, config)), pageTtl());
  });
}

function kindsAsked(includeItemTypes: unknown): Kind[] {
  const wanted = new Set(String(includeItemTypes ?? '').split(',').map((t) => t.trim()).filter(Boolean));
  if (!wanted.size) return ['movie', 'series'];
  return [...(wanted.has('Movie') ? ['movie' as Kind] : []), ...(wanted.has('Series') ? ['series' as Kind] : [])];
}

type Listing = Sorting & { config: any; userUUID: string; serverId: string; includeItemTypes?: unknown; startIndex: number; limit: number };

/** Where a listing's titles come from: one paged list per kind, its rows, and how a row becomes a meta. */
interface Source {
  kinds: Kind[];
  read(kind: Kind, pageNo: number): Promise<{ rows: any[]; total: number | null; lastPage: number | null; pageSize: number }>;
  toMeta(row: any, kind: Kind): any | null;
  /** Whether the provider's totals count exactly the rows listed. */
  exact: boolean;
}

// Whether a title is shown under a profile's cap, held so a later page counts the rows before it without building them again.
const shownUnderCap = new LRUCache<string, boolean>({
  max: 20000,
  ttl: pageTtl() * 1000,
});

/**
 * Reads each kind's pages up to the asked window, merges them in the client's order and builds the window's items.
 * Positions count only the titles that can be shown, so a row the profile's cap drops shifts no later page.
 */
async function listingFrom(source: Source, options: Listing): Promise<{ items: any[]; total: number }> {
  const { config, userUUID, serverId, startIndex, limit } = options;
  const kinds = source.kinds.filter((kind) => kindsAsked(options.includeItemTypes).includes(kind));
  if (!kinds.length) return { items: [], total: 0 };

  const maxPages = envInt('JELLYFIN_DISCOVER_MAX_PAGES', 25, 1);
  const read: Record<Kind, any[]> = { movie: [], series: [] };
  const state = Object.fromEntries(kinds.map((kind) => [kind, { pageNo: 1, lastPage: null as number | null, counted: null as number | null, pageSize: TMDB_PAGE, done: false }])) as Record<Kind, { pageNo: number; lastPage: number | null; counted: number | null; pageSize: number; done: boolean }>;

  const readTo = async (need: number): Promise<void> => {
    for (const kind of kinds) {
      const at = state[kind];
      while (!at.done && read[kind].length < need && at.pageNo <= Math.min(at.lastPage ?? Infinity, maxPages)) {
        const page = await source.read(kind, at.pageNo);
        read[kind].push(...page.rows);
        at.lastPage = page.lastPage;
        at.counted = page.total;
        at.pageSize = page.pageSize;
        at.pageNo += 1;
        // A page shorter than the provider's page size is its last.
        if (page.rows.length < page.pageSize) at.done = true;
      }
      // The page limit is as far as a listing goes, so reaching it is its end.
      if ((at.lastPage !== null && at.pageNo > at.lastPage) || at.pageNo > maxPages) at.done = true;
    }
  };
  const merged = (): Array<{ row: any; type: Kind }> =>
    kinds.length === 2 ? mergeRows(read.movie, read.series, options) : read[kinds[0]].map((row) => ({ row, type: kinds[0] }));
  // Rows past what every unfinished kind has read could still move once more is read.
  const settled = (rows: number): number => Math.min(rows, ...kinds.filter((kind) => !state[kind].done).map((kind) => read[kind].length));

  const { titleCards } = require('../titleCards');
  const { metaToBaseItem } = require('./items');
  const { keepsUnderProfileCap } = require('./profiles');
  const { hasAgeRatingCap } = require('../../utils/ageRating');
  const underCap = keepsUnderProfileCap(config);
  const capped = hasAgeRatingCap(config);
  const verdictKey = (meta: any): string => `${userUUID}|${config?.ageRating}|${meta.type}:${meta.id}`;

  const build = async (rows: Array<{ row: any; type: Kind }>): Promise<Array<any | null>> => {
    const metas = rows.map(({ row, type }) => source.toMeta(row, type));
    const present = metas.flatMap((meta, i) => (meta ? [i] : []));
    const cards = await titleCards(config, userUUID, present.map((i) => metas[i]));
    const out: Array<any | null> = rows.map(() => null);
    present.forEach((at, j) => {
      const item = metaToBaseItem(cards[j], metas[at].type, serverId, null);
      const shown = underCap(item);
      if (capped) shownUnderCap.set(verdictKey(metas[at]), shown);
      if (shown) out[at] = item;
    });
    return out;
  };
  const counts = async (rows: Array<{ row: any; type: Kind }>): Promise<boolean[]> => {
    const metas = rows.map(({ row, type }) => source.toMeta(row, type));
    if (!capped) return metas.map(Boolean);
    const unknown = rows.filter((_, i) => metas[i] && !shownUnderCap.has(verdictKey(metas[i])));
    if (unknown.length) await build(unknown);
    return metas.map((meta) => Boolean(meta) && shownUnderCap.get(verdictKey(meta)) !== false);
  };

  const wanted = startIndex + limit;
  const items: any[] = [];
  let kept = 0;
  let examined = 0;
  let dropped = false;
  // A provider can list a title on more than one of its pages; it is shown where it first appears.
  const listed = new Set<string>();
  const firstListing = ({ row, type }: { row: any; type: Kind }): boolean => {
    const key = `${type}:${row?.id ?? row?.mal_id}`;
    if (listed.has(key)) return false;
    listed.add(key);
    return true;
  };
  await readTo(wanted);
  let rows = merged();
  while (kept < wanted) {
    if (examined >= settled(rows.length)) {
      if (kinds.every((kind) => state[kind].done) && examined >= rows.length) break;
      await readTo(examined + wanted - kept);
      rows = merged();
      if (examined >= settled(rows.length)) break;
    }
    const before = kept < startIndex;
    const batch = rows.slice(examined, Math.min(settled(rows.length), examined + (before ? startIndex - kept : wanted - kept)));
    examined += batch.length;
    const fresh = batch.filter(firstListing);
    if (before) {
      const shown = (await counts(fresh)).filter(Boolean).length;
      kept += shown;
      if (shown < batch.length) dropped = true;
    } else {
      const built = (await build(fresh)).filter(Boolean);
      items.push(...built);
      kept += built.length;
      if (built.length < batch.length) dropped = true;
    }
  }

  let total = 0;
  let totals = true;
  for (const kind of kinds) {
    const { counted, pageSize } = state[kind];
    if (counted === null) totals = false;
    else total += Math.min(counted, maxPages * pageSize);
  }
  const ended = kinds.every((kind) => state[kind].done);
  const reached = startIndex + items.length;
  const more = examined < rows.length || !ended || (source.exact && totals && total > examined);
  if (!more) return { items, total: kept };
  // A title the profile's cap drops leaves the provider's count above what can be shown.
  if (dropped || !(source.exact && totals)) return { items, total: reached + limit };
  return { items, total: Math.max(total, reached) };
}

function tmdbSource(kinds: Kind[], filter: (kind: Kind) => Record<string, unknown>, options: Listing, keep?: (row: any) => boolean): Source {
  return {
    kinds,
    exact: !keep,
    async read(kind, pageNo) {
      const params = {
        ...discoverParams(kind, [], { sortBy: options.sortBy, sortOrder: options.sortOrder, language: options.config?.language, page: pageNo, ageCap: options.config?.ageRating, includeAdult: options.config?.includeAdult }),
        ...filter(kind),
      };
      const page = await discoverPage(kind, params, options.config);
      const rows: any[] = Array.isArray(page?.results) ? page.results : [];
      return { rows: keep ? rows.filter(keep) : rows, total: Number(page?.total_results) || 0, lastPage: Number(page?.total_pages) || pageNo, pageSize: keep ? 0 : TMDB_PAGE };
    },
    toMeta(row, kind) {
      return require('./people').metaFromTmdbRow(row, kind);
    },
  };
}

/**
 * A year's titles from TMDB discover, as person pages read a person's credits: complete for the year, with a real
 * total, in the client's order. Several years that are not one unbroken span are read as their span and filtered,
 * so their total is a page of lookahead until the span runs out.
 */
export async function yearListing(options: Listing & { years: number[] }): Promise<{ items: any[]; total: number }> {
  const { years } = options;
  if (!years.length) return { items: [], total: 0 };
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  const span = sorted[sorted.length - 1] - sorted[0] + 1 === sorted.length;
  const yearSet = new Set(sorted);
  return listingFrom(tmdbSource(['movie', 'series'], (kind) => yearParams(kind, sorted), options, span ? undefined : (row) => yearSet.has(rowYear(row) ?? -1)), options);
}

type StudioRef = { name: string; source: 'tmdb-company' | 'tmdb-network' | 'tvdb' | 'mal'; id: number };

const resolved = new LRUCache<string, { ref: StudioRef | null }>({
  max: envInt('JELLYFIN_STUDIO_LOOKUP_CACHE_MAX', 2000, 1),
  ttl: envInt('JELLYFIN_STUDIO_LOOKUP_TTL', 86400, 60) * 1000,
});

async function companyNamed(name: string, wanted: string, config: any): Promise<StudioRef | null> {
  const found = await require('../getTmdb').searchCompany({ query: name }, config);
  const company = (Array.isArray(found?.results) ? found.results : []).find((entry: any) => String(entry?.name ?? '').trim().toLowerCase() === wanted);
  return company?.id ? { name, source: 'tmdb-company', id: Number(company.id) } : null;
}

async function networkNamed(name: string, wanted: string): Promise<StudioRef | null> {
  const networks = await require('../tmdb-network-index').searchTmdbNetworks(name, 5);
  const network = (Array.isArray(networks) ? networks : []).find((entry: any) => String(entry?.label ?? '').trim().toLowerCase() === wanted);
  return network?.id ? { name, source: 'tmdb-network', id: Number(network.id) } : null;
}

/**
 * A studio named without its provider, looked up at TMDB by exact name: as a company and then a network, or network
 * first for a TVDB name, as TVDB names a show's network among its companies. Answers, misses included, are held;
 * a failed lookup is not.
 */
async function resolveStudio(name: string, config: any, networkFirst: boolean): Promise<StudioRef | null> {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const key = `${networkFirst ? 'n' : 'c'}|${wanted}`;
  const held = resolved.get(key);
  if (held) return held.ref;
  let failed = false;
  const asked = (lookup: Promise<StudioRef | null>): Promise<StudioRef | null> => lookup.catch(() => {
    failed = true;
    return null;
  });
  const ref = networkFirst
    ? (await asked(networkNamed(name, wanted))) ?? (await asked(companyNamed(name, wanted, config)))
    : (await asked(companyNamed(name, wanted, config))) ?? (await asked(networkNamed(name, wanted)));
  // A lookup that failed, for a bad key or a provider that is down, is no answer to hold for everyone.
  if (ref || !failed) resolved.set(key, { ref });
  return ref;
}

/**
 * Jikan can only match one audience rating exactly, not cap them, so ratings are capped after loading. Its sfw switch
 * does leave out adult entries, which no cap below NC-17 would let through anyway.
 */
function leavesOutAdult(config: any): boolean {
  if (config?.sfw === true) return true;
  const { hasAgeRatingCap } = require('../../utils/ageRating');
  return hasAgeRatingCap(config) && String(config.ageRating).toUpperCase() !== 'NC-17';
}

function malPage(params: Record<string, unknown>, pageNo: number): Promise<any> {
  const key = `jf-mal-studio-${JSON.stringify(params)}-${pageNo}`;
  return heldPage(key, '', () => {
    const { cacheWrapJikanApi } = require('../getCache');
    return cacheWrapJikanApi(key, () => require('../mal').fetchDiscover(params, pageNo), pageTtl());
  });
}

function malOrder(sorting: Sorting): { order_by: string; sort: string } {
  const order = orderOf(sorting);
  if (order.field === 'name') return { order_by: 'title', sort: order.descending ? 'desc' : 'asc' };
  if (order.field === 'date') return { order_by: 'start_date', sort: order.descending ? 'desc' : 'asc' };
  if (order.field === 'rating') return { order_by: 'score', sort: 'desc' };
  return { order_by: 'members', sort: 'desc' };
}

/**
 * Jikan lists a studio's films and shows as one list. Asked for one kind, its rows are filtered to that kind, which
 * leaves Jikan's count covering both, so that listing's total is left open until the list ends.
 */
function malSource(id: number, options: Listing, only: Kind | null): Source {
  const mal = require('../mal');
  const pageSize = mal.malPageSize();
  const params = { producers: id, ...malOrder(options), ...(leavesOutAdult(options.config) ? { sfw: true } : {}) };
  const kindOf = (row: any): Kind => (row?.type === 'Movie' ? 'movie' : 'series');
  return {
    kinds: [only ?? 'series'],
    exact: !only,
    async read(_kind, pageNo) {
      const page = await malPage(params, pageNo);
      const all: any[] = Array.isArray(page?.items) ? page.items : [];
      const rows = only ? all.filter((row) => kindOf(row) === only) : all;
      return { rows, total: only ? null : Number(page?.total) || all.length, lastPage: page?.hasMore ? null : pageNo, pageSize: only ? 0 : pageSize };
    },
    toMeta(row) {
      if (!row?.mal_id) return null;
      return {
        id: `mal:${row.mal_id}`,
        type: kindOf(row),
        name: row.title_english || row.title || '',
        poster: row.images?.jpg?.large_image_url || null,
        description: row.synopsis || '',
        year: row.year ? String(row.year) : '',
        releaseInfo: row.year ? String(row.year) : '',
        _malId: String(row.mal_id),
      };
    },
  };
}

/**
 * A studio's titles from the provider that named it: TMDB discover for TMDB companies and networks, Jikan for
 * MyAnimeList studios. TVDB's filter lists one country of origin and one original language at a time and its rating
 * filter matches a single rating, so a TVDB company, like a studio known only by name, is looked up at TMDB by name.
 * One no provider knows, an Id from before studio Ids decoded, or several studios, which the catalogs match as any of
 * them, give null and are left to the catalogs.
 */
export async function studioListing(options: Listing & { filter: { names: Set<string>; legacy: Set<string>; refs: StudioRef[] } }): Promise<{ items: any[]; total: number } | null> {
  const { names, legacy, refs } = options.filter;
  if (legacy.size || names.size !== 1 || refs.length > 1) return null;
  const named = refs[0];
  const ref = named && named.source !== 'tvdb'
    ? named
    : await resolveStudio(named ? named.name : [...names][0], options.config, named?.source === 'tvdb');
  if (!ref) return null;
  if (ref.source === 'tmdb-company') return listingFrom(tmdbSource(['movie', 'series'], () => ({ with_companies: ref.id }), options), options);
  if (ref.source === 'tmdb-network') return listingFrom(tmdbSource(['series'], () => ({ with_networks: ref.id }), options), options);
  const asked = kindsAsked(options.includeItemTypes);
  return fewMalListingsAtOnce(() => listingFrom(malSource(ref.id, options, asked.length === 1 ? asked[0] : null), options));
}

let malListings = 0;
const malWaiting: Array<() => void> = [];

// Jikan has one queue for the whole server, so a few studio listings at once leave room for the rest of anime.
async function fewMalListingsAtOnce<T>(run: () => Promise<T>): Promise<T> {
  if (malListings >= envInt('JELLYFIN_MAL_STUDIO_LISTINGS_MAX', 4, 1)) await new Promise<void>((go) => malWaiting.push(go));
  else malListings += 1;
  try {
    return await run();
  } finally {
    const next = malWaiting.shift();
    if (next) next();
    else malListings -= 1;
  }
}
