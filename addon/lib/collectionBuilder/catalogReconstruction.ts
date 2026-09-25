import type { SourceDraft } from './types';
import { isPrivateList, isUserSpecific } from './catalogSharing';

/**
 * A catalog carried inside a collection file, in the shape the config stores it.
 * Structural on purpose: the frontend's CatalogConfig is not reachable from here.
 */
export interface CatalogBlueprint {
  id: string;
  type: 'movie' | 'series' | 'anime' | 'all';
  name: string;
  source: string;
  enabled: boolean;
  showInHome: boolean;
  cacheTTL?: number;
  sort?: string;
  sortDirection?: 'asc' | 'desc';
  metadata?: Record<string, any>;
}

/** Key our own exports write onto an addon source, alongside Nuvio's own fields. */
export const BLUEPRINT_KEY = 'aiometadata';
export const BLUEPRINT_VERSION = 1;

export interface ReconstructionSuccess {
  ok: true;
  blueprint: CatalogBlueprint;
  source: SourceDraft;
}

export interface ReconstructionFailure {
  ok: false;
  reason: string;
}

export type Reconstruction = ReconstructionSuccess | ReconstructionFailure;

function trimmed(value: unknown): string {
  return String(value ?? '').trim();
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Ids have to be stable across importers so the same file twice, or two users
 * sharing a setup, converge on one catalog instead of accumulating duplicates.
 * The builder dialog uses Date.now() for this, which cannot be reused here.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

function fingerprint(value: unknown): string {
  const json = canonical(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function slug(value: string): string {
  return trimmed(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'catalog';
}

function toStremioType(mediaType: unknown): 'movie' | 'series' | null {
  const normalized = trimmed(mediaType).toUpperCase();
  if (normalized === 'MOVIE' || normalized === 'MOVIES') return 'movie';
  if (normalized === 'TV' || normalized === 'SERIES' || normalized === 'SHOW') return 'series';
  return null;
}

/**
 * Nuvio's builder writes TMDB's discover parameters in camelCase and drops the
 * dotted operators. Everything here is the same query TMDB would take, so the
 * mapping is a rename plus the two date fields TMDB names per media type.
 *
 * Only parameters our own builder can also produce are accepted: one it cannot
 * show would be dropped the first time the catalog is edited and saved.
 */
const FILTER_PARAMS: Record<string, string> = {
  withGenres: 'with_genres',
  withoutGenres: 'without_genres',
  withKeywords: 'with_keywords',
  withoutKeywords: 'without_keywords',
  withCompanies: 'with_companies',
  withoutCompanies: 'without_companies',
  withNetworks: 'with_networks',
  withOriginalLanguage: 'with_original_language',
  withOriginCountry: 'with_origin_country',
  withWatchProviders: 'with_watch_providers',
  watchRegion: 'watch_region',
  withPeople: 'with_people',
  voteCountGte: 'vote_count.gte',
  voteAverageGte: 'vote_average.gte',
  voteAverageLte: 'vote_average.lte',
  withRuntimeGte: 'with_runtime.gte',
  collectionIds: 'collection_ids',
  withRuntimeLte: 'with_runtime.lte',
  includeAdult: 'include_adult',
};

const DATE_PARAMS: Record<'movie' | 'series', { gte: string; lte: string }> = {
  movie: { gte: 'primary_release_date.gte', lte: 'primary_release_date.lte' },
  series: { gte: 'first_air_date.gte', lte: 'first_air_date.lte' },
};

/** Nuvio's "keep the order the API returned" choice, which TMDB has no value for. */
const UNSORTED = 'original';

export function toDiscoverParams(
  filters: unknown,
  type: 'movie' | 'series',
  sortBy?: unknown
): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {};

  const dates = DATE_PARAMS[type];

  if (isRecord(filters)) {
    for (const [key, value] of Object.entries(filters)) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'string' && !value.trim()) continue;

      const param = key === 'releaseDateGte' ? dates.gte
        : key === 'releaseDateLte' ? dates.lte
        : FILTER_PARAMS[key];
      if (!param) continue;

      params[param] = typeof value === 'number' || typeof value === 'boolean' ? value : trimmed(value);
    }

    // TMDB's year parameter has no field in our builder, so it is expressed as
    // the range it stands for and survives an edit. Explicit bounds win.
    const year = parseInt(trimmed((filters as Record<string, unknown>).year), 10);
    if (Number.isFinite(year) && !params[dates.gte] && !params[dates.lte]) {
      params[dates.gte] = `${year}-01-01`;
      params[dates.lte] = `${year}-12-31`;
    }
  }

  const sort = trimmed(sortBy);
  if (sort && sort !== UNSORTED) params.sort_by = sort;

  return params;
}

const DISCOVER_CACHE_TTL = 3600;

/** Mirrors the builder's own ceiling, above which no runtime filter is written. */
const MAX_RUNTIME_MINUTES = 400;

/**
 * TMDB reads `,` as AND and `|` as OR, which is the whole of the builder's join
 * mode (joinSelectionValues in DiscoverBuilderDialog).
 */
function selection(value: unknown): { items: Array<{ id: number; label: string }>; mode: 'and' | 'or' } {
  const raw = trimmed(value);
  const mode = raw.includes('|') ? 'or' : 'and';
  const items = raw
    .split(/[,|]/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => ({ id: Number(part), label: part }))
    .filter(item => Number.isFinite(item.id));
  return { items, mode };
}

/**
 * Without a formState the catalogs list shows no edit action for a discover
 * catalog (isDiscover in CatalogsSettings), so an imported one could not be
 * opened. Every field the builder reads is optional, so covering exactly the
 * parameters produced here is enough, and means a re-save rebuilds the same
 * query rather than dropping what the form could not show.
 */
function discoverFormState(
  params: Record<string, string | number | boolean>,
  name: string,
  type: 'movie' | 'series'
): Record<string, any> {
  const state: Record<string, any> = {
    catalogName: name,
    discoverSource: 'tmdb',
    catalogType: type,
    cacheTTL: DISCOVER_CACHE_TTL,
  };

  if (params.sort_by) state.sortBy = params.sort_by;
  if (params.with_original_language) state.originalLanguage = params.with_original_language;
  if (params.with_origin_country) state.originCountry = params.with_origin_country;
  if (params.watch_region) state.watchRegion = params.watch_region;
  if (params.include_adult !== undefined) state.includeAdult = Boolean(params.include_adult);
  if (params['vote_count.gte'] !== undefined) state.voteCountMin = Number(params['vote_count.gte']);

  if (params['vote_average.gte'] !== undefined || params['vote_average.lte'] !== undefined) {
    state.voteAverageRange = [
      Number(params['vote_average.gte'] ?? 0),
      Number(params['vote_average.lte'] ?? 10),
    ];
  }

  if (params['with_runtime.gte'] !== undefined || params['with_runtime.lte'] !== undefined) {
    state.runtimeRange = [
      Number(params['with_runtime.gte'] ?? 0),
      Number(params['with_runtime.lte'] ?? MAX_RUNTIME_MINUTES),
    ];
  }

  const genres = selection(params.with_genres);
  if (genres.items.length > 0) {
    state.includeGenres = genres.items;
    state.genreJoinMode = genres.mode;
  }
  const withoutGenres = selection(params.without_genres);
  if (withoutGenres.items.length > 0) state.excludeGenres = withoutGenres.items;

  for (const [param, field, modeField] of [
    ['with_companies', 'withCompanies', 'companyJoinMode'],
    ['without_companies', 'withoutCompanies', ''],
    ['with_networks', 'withNetworks', ''],
    ['with_keywords', 'withKeywords', 'keywordJoinMode'],
    ['without_keywords', 'withoutKeywords', ''],
    ['with_people', 'selectedPeople', 'peopleJoinMode'],
    ['with_watch_providers', 'watchProviders', 'providerJoinMode'],
  ] as const) {
    const picked = selection(params[param]);
    if (picked.items.length === 0) continue;
    state[field] = picked.items;
    if (modeField) state[modeField] = picked.mode;
  }

  const [fromParam, toParam, presetField, fromField, toField] = type === 'movie'
    ? ['primary_release_date.gte', 'primary_release_date.lte', 'movieDatePreset', 'primaryReleaseFrom', 'primaryReleaseTo']
    : ['first_air_date.gte', 'first_air_date.lte', 'seriesDatePreset', 'firstAirFrom', 'firstAirTo'];

  if (params[fromParam] || params[toParam]) {
    state[presetField] = 'custom';
    if (params[fromParam]) state[fromField] = params[fromParam];
    if (params[toParam]) state[toField] = params[toParam];
  }

  return state;
}

function discoverBlueprint(
  raw: Record<string, any>,
  type: 'movie' | 'series',
  extraParams: Record<string, string | number | boolean> = {}
): CatalogBlueprint {
  const params = { ...toDiscoverParams(raw.filters, type, raw.sortBy), ...extraParams };
  const name = trimmed(raw.title) || 'Imported catalog';
  return {
    id: `tmdb.discover.${type}.${slug(name)}.${fingerprint({ type, params })}`,
    type,
    name,
    source: 'tmdb',
    enabled: true,
    showInHome: false,
    cacheTTL: DISCOVER_CACHE_TTL,
    metadata: {
      description: `TMDB Discover (${type === 'movie' ? 'movie' : 'tv'})`,
      discover: {
        version: 2,
        source: 'tmdb',
        mediaType: type === 'movie' ? 'movie' : 'tv',
        params,
        formState: discoverFormState(params, name, type),
      },
    },
  };
}

function tmdbListBlueprint(raw: Record<string, any>, type: 'movie' | 'series'): Reconstruction {
  const listId = trimmed(raw.tmdbId);
  if (!listId) return { ok: false, reason: 'a TMDB list source with no list id' };

  const name = trimmed(raw.title) || `TMDB List ${listId}`;
  return ok({
    id: `tmdb.list.${listId}.${type === 'movie' ? 'movies' : 'series'}`,
    type,
    name,
    source: 'tmdb',
    enabled: true,
    showInHome: false,
    cacheTTL: 7200,
    metadata: {
      listId,
      listName: name,
      url: `https://www.themoviedb.org/list/${listId}`,
    },
  });
}

/**
 * A TMDB collection is a fixed set of films, so it only exists as a movie
 * catalog. Nuvio's own ordering value is the API's arbitrary part order, which
 * has no equivalent here: the catalog reads release order, and only the explicit
 * reverse is carried across.
 */
function tmdbCollectionBlueprint(raw: Record<string, any>, type: 'movie' | 'series'): Reconstruction {
  if (type !== 'movie') {
    return { ok: false, reason: 'a TMDB collection source that is not a movie source' };
  }

  const collectionId = trimmed(raw.tmdbId);
  if (!collectionId) return { ok: false, reason: 'a TMDB collection source with no collection id' };

  const name = trimmed(raw.title) || trimmed(raw.name) || `TMDB Collection ${collectionId}`;
  const descending = trimmed(raw.sortBy).toLowerCase() === 'release_date.desc'
    || trimmed(raw.sortOrder).toLowerCase() === 'desc';

  return ok({
    id: `tmdb.collection.${collectionId}`,
    type: 'movie',
    name,
    source: 'tmdb',
    enabled: true,
    showInHome: false,
    metadata: {
      listId: collectionId,
      listName: name,
      sortDirection: descending ? 'desc' : 'asc',
      url: `https://www.themoviedb.org/collection/${collectionId}`,
    },
  });
}

/**
 * Trakt's own sort values, which Nuvio stores verbatim. Anything else is left to
 * the catalog default rather than passed through to the API.
 */
const TRAKT_SORTS = new Set([
  'rank', 'added', 'title', 'released', 'runtime', 'popularity',
  'percentage', 'votes', 'my_rating', 'random', 'watched', 'collected',
]);

function traktListBlueprint(raw: Record<string, any>, type: 'movie' | 'series'): Reconstruction {
  const listId = trimmed(raw.traktListId);
  if (!listId) return { ok: false, reason: 'a Trakt source with no list id' };

  const sort = trimmed(raw.sortBy).toLowerCase();
  const name = trimmed(raw.title) || `Trakt List ${listId}`;
  return ok({
    // The split form keeps the movie and series halves of one list apart. The
    // catalog route reads the id from the third segment either way.
    id: `trakt.list.${listId}.${type === 'movie' ? 'movies' : 'series'}`,
    type,
    name,
    source: 'trakt',
    enabled: true,
    showInHome: false,
    ...(TRAKT_SORTS.has(sort) && { sort }),
    sortDirection: trimmed(raw.sortHow).toLowerCase() === 'desc' ? 'desc' : 'asc',
    metadata: {
      privacy: 'public',
      url: `https://trakt.tv/lists/${listId}`,
    },
  });
}

function ok(blueprint: CatalogBlueprint): ReconstructionSuccess {
  return {
    ok: true,
    blueprint,
    source: {
      catalogId: blueprint.id,
      type: blueprint.type,
      name: blueprint.name,
      genre: null,
    },
  };
}

/**
 * Rebuilds an AIOMetadata catalog from a source Nuvio resolves itself. Their
 * builder stores the whole query on the source, so a TMDB discover, company or
 * list source, and a Trakt list source, each carry everything the catalog needs.
 */
export function fromNativeSource(raw: unknown): Reconstruction {
  if (!isRecord(raw)) return { ok: false, reason: 'a source that is not an object' };

  const provider = trimmed(raw.provider).toLowerCase();
  const type = toStremioType(raw.mediaType);
  if (!type) return { ok: false, reason: `a ${provider || 'unknown'} source with no media type` };

  if (provider === 'trakt') return traktListBlueprint(raw, type);

  if (provider !== 'tmdb') {
    return { ok: false, reason: `a ${provider || 'unknown'} source, which has no AIOMetadata equivalent` };
  }

  const sourceType = trimmed(raw.tmdbSourceType).toUpperCase();
  if (sourceType === 'DISCOVER') return ok(discoverBlueprint(raw, type));
  if (sourceType === 'LIST') return tmdbListBlueprint(raw, type);
  if (sourceType === 'COMPANY') {
    const companyId = trimmed(raw.tmdbId);
    if (!companyId) return { ok: false, reason: 'a TMDB company source with no company id' };
    return ok(discoverBlueprint(raw, type, { with_companies: companyId }));
  }
  if (sourceType === 'COLLECTION') return tmdbCollectionBlueprint(raw, type);

  return { ok: false, reason: `a TMDB ${sourceType || 'unknown'} source, which has no AIOMetadata equivalent` };
}

const FUSION_NATIVE_KINDS = new Set(['traktList', 'tmdbDiscover', 'traktRecommendations']);

const FUSION_NATIVE_LABELS: Record<string, string> = {
  traktList: 'TRAKT LIST',
  traktRecommendations: 'TRAKT RECOMMENDATIONS',
  tmdbDiscover: 'TMDB DISCOVER',
};

function fusionTraktListBlueprint(payload: Record<string, any>): Reconstruction {
  const listId = trimmed(payload.traktId);
  const username = trimmed(payload.username);
  const listSlug = trimmed(payload.listSlug);

  const id = listId
    ? `trakt.list.${listId}`
    : username && listSlug ? `trakt.${username}.${listSlug}` : '';
  if (!id) return { ok: false, reason: 'a Trakt list source with no list id, owner or slug' };

  const name = trimmed(payload.listName) || (listId ? `Trakt List ${listId}` : listSlug);
  return ok({
    id,
    type: 'all',
    name,
    source: 'trakt',
    enabled: true,
    showInHome: false,
    metadata: {
      privacy: 'public',
      url: username && listSlug
        ? `https://trakt.tv/users/${username}/lists/${listSlug}`
        : `https://trakt.tv/lists/${listId}`,
      ...(username && { username }),
      ...(name && { listName: name }),
    },
  });
}

export function fromFusionNativeSource(raw: unknown): Reconstruction {
  if (!isRecord(raw)) return { ok: false, reason: 'a source that is not an object' };

  const kind = trimmed(raw.kind);
  const payload = isRecord(raw.payload) ? raw.payload : {};

  if (kind === 'traktList') return fusionTraktListBlueprint(payload);
  if (kind === 'traktRecommendations') {
    return { ok: false, reason: 'a Trakt recommendations source, which belongs to whoever is signed in' };
  }
  if (kind === 'tmdbDiscover') {
    return { ok: false, reason: 'a TMDB discover source, whose filters have no exact AIOMetadata equivalent' };
  }
  return { ok: false, reason: `a ${kind || 'unknown'} source, which has no AIOMetadata equivalent` };
}

export type NativeOrigin = 'nuvio' | 'fusion';

/** Marks an id as belonging to a client-resolved source rather than a catalog. */
export const NATIVE_ID_PREFIXES: Record<NativeOrigin, string> = {
  nuvio: 'nuvio:',
  fusion: 'fusion:',
};

/** Keeps a client-resolved source as it was: the id only keys and labels the row. */
export function nativePassthrough(raw: unknown): SourceDraft | null {
  if (!isRecord(raw)) return null;

  const provider = trimmed(raw.provider).toLowerCase();
  if (provider !== 'tmdb' && provider !== 'trakt') return null;

  const kind = trimmed(raw.tmdbSourceType).toUpperCase();
  const type = toStremioType(raw.mediaType) || 'movie';
  const label = [provider.toUpperCase(), kind || null].filter(Boolean).join(' ');

  return {
    catalogId: `${NATIVE_ID_PREFIXES.nuvio}${provider}.${(kind || 'list').toLowerCase()}.${fingerprint(raw)}`,
    type,
    name: trimmed(raw.title) || label,
    genre: null,
    native: { ...raw },
  };
}

export function fusionNativePassthrough(raw: unknown): SourceDraft | null {
  if (!isRecord(raw)) return null;

  const kind = trimmed(raw.kind);
  if (!FUSION_NATIVE_KINDS.has(kind)) return null;

  const payload = isRecord(raw.payload) ? raw.payload : {};
  const name = trimmed(payload.listName) || trimmed(payload.title) || trimmed(payload.name);

  return {
    catalogId: `${NATIVE_ID_PREFIXES.fusion}${kind}.${fingerprint(raw)}`,
    type: 'all',
    name: name || FUSION_NATIVE_LABELS[kind] || kind,
    genre: null,
    native: { ...raw },
  };
}

export function isNativeSource(source: { native?: unknown; catalogId?: string }): boolean {
  return Boolean(source?.native)
    || Object.values(NATIVE_ID_PREFIXES).some(prefix => String(source?.catalogId || '').startsWith(prefix));
}

export function nativeOrigin(source: { native?: unknown; catalogId?: string }): NativeOrigin | null {
  const id = String(source?.catalogId || '');
  for (const origin of Object.keys(NATIVE_ID_PREFIXES) as NativeOrigin[]) {
    if (id.startsWith(NATIVE_ID_PREFIXES[origin])) return origin;
  }

  const native = source?.native;
  if (!isRecord(native)) return null;
  if (trimmed(native.provider)) return 'nuvio';
  if (trimmed(native.kind)) return 'fusion';
  return null;
}

export function isStrandedNative(
  source: { native?: unknown; catalogId?: string },
  target: NativeOrigin
): boolean {
  return isNativeSource(source) && nativeOrigin(source) !== target;
}

export function fromAnyNativeSource(raw: unknown, origin: NativeOrigin | null): Reconstruction {
  if (origin === 'fusion') return fromFusionNativeSource(raw);
  if (origin === 'nuvio') return fromNativeSource(raw);
  return { ok: false, reason: 'a source with no recognisable client' };
}

/** How the row describes itself, since there is no catalog to name it. */
export function nativeLabel(source: SourceDraft): string {
  const raw = source.native || {};

  if (nativeOrigin(source) === 'fusion') {
    const kind = trimmed(raw.kind);
    return FUSION_NATIVE_LABELS[kind] || kind.toUpperCase() || 'NATIVE';
  }

  const provider = trimmed(raw.provider).toUpperCase();
  const kind = trimmed(raw.tmdbSourceType).toUpperCase();
  return kind ? `${provider} ${kind}` : provider || 'NATIVE';
}

function readBlueprint(raw: unknown, fallbackName = ''): CatalogBlueprint | null {
  if (!isRecord(raw)) return null;
  if (!trimmed(raw.id) || !trimmed(raw.type) || !trimmed(raw.source)) return null;

  // Older files still carry these, and rebuilding one gives the importer a dead catalog.
  if (isUserSpecific(trimmed(raw.id)) || isPrivateList(raw as any)) return null;

  // An exporter with nothing better to write puts the id in the name field, which
  // would otherwise become the catalog's name on import. The tile carrying it is
  // the closest thing to a name the file has.
  const declared = trimmed(raw.name);
  const id = trimmed(raw.id);
  return {
    ...raw,
    name: (declared && declared !== id ? declared : trimmed(fallbackName)) || declared || id,
    enabled: raw.enabled !== false,
    showInHome: Boolean(raw.showInHome),
  } as CatalogBlueprint;
}

/**
 * Reads back what the writer put on one of our own addon sources: the source's own
 * catalog, then anything that catalog is composed of. *fallbackName* is the title
 * of the tile carrying it, used when the file names a catalog after its own id.
 */
export function fromEmbedded(raw: unknown, fallbackName = ''): CatalogBlueprint[] {
  if (!isRecord(raw)) return [];
  const carrier = raw[BLUEPRINT_KEY];
  if (!isRecord(carrier)) return [];

  const blueprints: CatalogBlueprint[] = [];
  // Only the source's own catalog: what it is composed of has its own names, and
  // the tile names the whole, not each part.
  const parent = readBlueprint(carrier.catalog, fallbackName);
  if (parent) blueprints.push(parent);

  if (Array.isArray(carrier.requires)) {
    for (const entry of carrier.requires) {
      const child = readBlueprint(entry);
      if (child) blueprints.push(child);
    }
  }

  return blueprints;
}

/** Catalogs to travel with a file, keyed by how a source addresses them. */
export type BlueprintLookup = Record<string, CatalogBlueprint>;

/**
 * Exports lowercase a source's type, so a design that has been through a file once
 * no longer spells a displayType the way the config does. The type is folded here
 * rather than at each call site so both sides of the lookup agree.
 */
export function lookupKey(catalogId: unknown, type: unknown): string {
  return `${trimmed(catalogId)}:${trimmed(type).toLowerCase()}`;
}

export function blueprintKey(blueprint: { id: string; type: string }): string {
  return lookupKey(blueprint.id, blueprint.type);
}

/**
 * Nuvio keeps a source's definition on the source itself rather than in an
 * envelope, and its normalizer rebuilds addon sources from the fields it knows.
 * Following that shape lets a catalog travel with the tile that uses it without
 * changing what Nuvio reads.
 *
 * An importer reads the whole file before deciding what to add, so one copy per
 * catalog is enough however many tiles use it.
 */
export function createBlueprintWriter(lookup: BlueprintLookup) {
  const written = new Set<string>();

  // The lookup is keyed by how a source addresses a catalog, but a merge names its
  // parts the way the config does, so they need an index of their own.
  const byOwnKey = new Map<string, CatalogBlueprint>();
  for (const blueprint of Object.values(lookup)) {
    const key = blueprintKey(blueprint);
    if (!byOwnKey.has(key)) byOwnKey.set(key, blueprint);
  }

  /**
   * A merge is only a list of ids, and an id like `simkl.recipe.hiddengems.movies`
   * says nothing to an importer that does not already have it, so the parts travel
   * with the parent.
   */
  const partsOf = (blueprint: CatalogBlueprint): CatalogBlueprint[] => {
    const parts = blueprint.metadata?.mergedSources;
    if (!Array.isArray(parts)) return [];

    const carried: CatalogBlueprint[] = [];
    for (const part of parts) {
      if (!isRecord(part)) continue;
      const child = byOwnKey.get(lookupKey(part.catalogId, part.catalogType));
      if (!child) continue;
      const childId = blueprintKey(child);
      if (written.has(childId)) continue;
      written.add(childId);
      carried.push(child);
    }
    return carried;
  };

  return function attach<T extends Record<string, any>>(source: T, key: string): T {
    const blueprint = lookup[key];
    if (!blueprint) return source;

    const id = blueprintKey(blueprint);
    if (written.has(id)) return source;
    written.add(id);

    const requires = partsOf(blueprint);
    return {
      ...source,
      [BLUEPRINT_KEY]: {
        version: BLUEPRINT_VERSION,
        catalog: blueprint,
        ...(requires.length > 0 && { requires }),
      },
    };
  };
}

/**
 * The catalogs part of a file needs: those its sources address, and the parts of
 * any merge among them. A file carries each catalog once, on the first tile that
 * uses it, so this is decided from the blueprints of the whole file. A source may
 * address a catalog by its manifest spelling, `<id>_<type>` under a displayType.
 */
export function blueprintsUsedBy(
  blueprints: CatalogBlueprint[],
  sources: Array<{ catalogId?: unknown }>
): CatalogBlueprint[] {
  const addressed = new Set(sources.map(source => trimmed(source.catalogId)).filter(Boolean));
  const byOwnKey = new Map(blueprints.map(blueprint => [blueprintKey(blueprint), blueprint]));
  const kept = new Map<string, CatalogBlueprint>();
  const queue = blueprints.filter(blueprint =>
    addressed.has(blueprint.id) || addressed.has(`${blueprint.id}_${blueprint.type}`)
  );

  while (queue.length > 0) {
    const blueprint = queue.shift()!;
    const key = blueprintKey(blueprint);
    if (kept.has(key)) continue;
    kept.set(key, blueprint);
    const parts = blueprint.metadata?.mergedSources;
    for (const part of Array.isArray(parts) ? parts : []) {
      if (!isRecord(part)) continue;
      const child = byOwnKey.get(lookupKey(part.catalogId, part.catalogType));
      if (child) queue.push(child);
    }
  }

  return blueprints.filter(blueprint => kept.has(blueprintKey(blueprint)));
}

export function dedupeBlueprints(blueprints: CatalogBlueprint[]): CatalogBlueprint[] {
  const seen = new Map<string, CatalogBlueprint>();
  for (const blueprint of blueprints) {
    const key = blueprintKey(blueprint);
    if (!seen.has(key)) seen.set(key, blueprint);
  }
  return [...seen.values()];
}
