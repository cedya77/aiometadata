import { allCatalogDefinitions } from '@/data/catalogs';
import { flixpatrolCountries, flixpatrolServices } from '@/data/flixpatrol';
import type { CatalogConfig } from '@/contexts/config';
import type { CatalogBlueprint } from '@shared/catalogReconstruction';

import { SUFFIX_TYPES } from '@shared/types';

export { SUFFIX_TYPES };

/**
 * Catalogs tied to whoever is signed in rather than to whoever built the file.
 * They never travel as blueprints, since that would carry one person's list
 * settings to another, but their ids say exactly what they are: "my watchlist",
 * not the author's. So they can be recreated from the id, given the account.
 *
 * Shapes mirror what the integration dialogs create.
 */
interface PersonalCatalog {
  type: CatalogConfig['type'];
  name: string;
  source: CatalogConfig['source'];
  cacheTTL?: number;
  metadata?: CatalogConfig['metadata'];
}

const TRAKT_PERSONAL: Record<string, PersonalCatalog> = {
  'trakt.watchlist': { type: 'all', name: 'Trakt Watchlist', source: 'trakt' },
  'trakt.watchlist.movies': { type: 'movie', name: 'Trakt Watchlist', source: 'trakt' },
  'trakt.watchlist.series': { type: 'series', name: 'Trakt Watchlist', source: 'trakt' },
  'trakt.favorites.movies': { type: 'movie', name: 'Trakt Favorites', source: 'trakt' },
  'trakt.favorites.shows': { type: 'series', name: 'Trakt Favorites', source: 'trakt' },
  'trakt.recommendations.movies': { type: 'movie', name: 'Trakt Recommendations', source: 'trakt' },
  'trakt.recommendations.shows': { type: 'series', name: 'Trakt Recommendations', source: 'trakt' },
  'trakt.upnext': { type: 'series', name: 'Trakt Up Next', source: 'trakt', cacheTTL: 300 },
  'trakt.unwatched': { type: 'series', name: 'My Recently Aired', source: 'trakt', cacheTTL: 300 },
  'trakt.calendar': { type: 'series', name: 'Airing Soon', source: 'trakt', cacheTTL: 300 },
};

const SIMKL_STATUS_NAMES: Record<string, string> = {
  watching: 'Watching',
  plantowatch: 'Plan to Watch',
  hold: 'On Hold',
  completed: 'Completed',
  dropped: 'Dropped',
};

const SIMKL_TYPES: Record<string, CatalogConfig['type']> = {
  movies: 'movie',
  shows: 'series',
  anime: 'anime',
  all: 'all',
};

function simklPersonal(catalogId: string): PersonalCatalog | undefined {
  if (catalogId === 'simkl.upnext') {
    return {
      type: 'series',
      name: 'Simkl Up Next',
      source: 'simkl',
      cacheTTL: 300,
      metadata: { useShowPosterForUpNext: false, includeAnimeInUpNext: true },
    };
  }

  if (catalogId === 'simkl.upnext.anime') {
    return {
      type: 'anime',
      name: 'Simkl Anime Up Next',
      source: 'simkl',
      cacheTTL: 300,
      metadata: { useShowPosterForUpNext: false },
    };
  }

  const match = /^simkl\.watchlist\.(movies|shows|anime|all)\.([a-z]+)$/.exec(catalogId);
  if (!match) return undefined;

  const [, listType, status] = match;
  const statusName = SIMKL_STATUS_NAMES[status];
  if (!statusName) return undefined;

  return {
    type: SIMKL_TYPES[listType],
    name: listType === 'all' ? `Simkl ${statusName}` : `Simkl ${statusName} ${listType.charAt(0).toUpperCase()}${listType.slice(1)}`,
    source: 'simkl',
    metadata: { status: status as any },
  };
}

/** The credential each account-scoped catalog needs before it can return anything. */
const ACCOUNTS: Array<{
  prefix: string;
  label: string;
  key: 'traktTokenId' | 'simklTokenId';
  lookup: (catalogId: string) => PersonalCatalog | undefined;
}> = [
  { prefix: 'trakt.', label: 'Trakt', key: 'traktTokenId', lookup: id => TRAKT_PERSONAL[id] },
  { prefix: 'simkl.', label: 'Simkl', key: 'simklTokenId', lookup: simklPersonal },
];

function findPersonal(catalogId: string) {
  for (const account of ACCOUNTS) {
    if (!catalogId.startsWith(account.prefix)) continue;
    const catalog = account.lookup(catalogId);
    if (catalog) return { account, catalog };
  }
  return undefined;
}

/**
 * A manifest id can carry the original type as a suffix, so a source pointing at
 * `tmdb.top_movie` still has to resolve back to the `tmdb.top` definition.
 */
function findDefinition(catalogId: string, type: string) {
  const direct = allCatalogDefinitions.find(def => def.id === catalogId && def.type === type);
  if (direct) return direct;

  for (const suffix of SUFFIX_TYPES) {
    if (!catalogId.endsWith(`_${suffix}`)) continue;
    const base = catalogId.slice(0, -(suffix.length + 1));
    const match = allCatalogDefinitions.find(def => def.id === base && def.type === suffix);
    if (match) return match;
  }
  return undefined;
}

const FLIXPATROL_ID = /^flixpatrol\.(.+)\.([a-z]{2}|world)\.(movie|series|all)(?:\.([a-z0-9-]+))?$/;
const MDBLIST_LIST_ID = /^mdblist\.(\d+)$/;

interface ImportedSource {
  catalogId: string;
  type: string;
  name?: string;
  baseType?: string;
}

/**
 * Ids that describe their own catalog completely, so a file written by another app
 * still rebuilds without a blueprint. FlixPatrol needs its country slug looked up or
 * the fetch falls back to a two letter code the upstream does not accept.
 */
function reconstructFromId(source: ImportedSource): CatalogConfig | undefined {
  const flix = FLIXPATROL_ID.exec(source.catalogId);
  if (flix) {
    const [, serviceId, countryId, kind, variant] = flix;
    const service = flixpatrolServices.find(entry => entry.id === serviceId);
    const country = flixpatrolCountries.find(entry => entry.id === countryId);
    if (!service || !country) return undefined;

    const label = kind === 'movie' ? 'Movies ' : kind === 'series' ? 'TV Shows ' : '';
    const derived = `Top 10 ${label}on ${service.name} (${country.name})`;
    return {
      id: source.catalogId,
      type: kind === 'movie' ? 'movie' : kind === 'series' ? 'series' : 'all',
      name: source.name?.trim() || (variant ? `${derived} ${variant}` : derived),
      source: 'flixpatrol',
      enabled: true,
      showInHome: true,
      enableRatingPosters: true,
      metadata: { countrySlug: country.slug },
    };
  }

  const list = MDBLIST_LIST_ID.exec(source.catalogId);
  if (list) {
    const base = source.baseType || source.type;
    return {
      id: source.catalogId,
      type: base === 'movie' ? 'movie' : 'series',
      name: source.name?.trim() || `MDBList ${list[1]}`,
      source: 'mdblist',
      enabled: true,
      showInHome: true,
      sort: 'default',
      order: 'asc',
      genreSelection: 'standard',
      enableRatingPosters: true,
    };
  }

  return undefined;
}

export interface CatalogAdditions {
  /** Catalogs to append, already deduped against the config. */
  added: CatalogConfig[];
  /** Keys of catalogs the config already has but has switched off. */
  enabled: string[];
  /** `catalogId:type` of every imported source these additions account for. */
  resolved: Set<string>;
  /** Services whose own catalogs the file uses, but which are not connected. */
  needsAccount: string[];
  /**
   * The subset of `resolved` an apply will not actually add, because the account
   * it belongs to is not connected. Accounted for, but not staged.
   */
  needsAccountKeys: Set<string>;
  /** Existing catalogs to fold into a rebuilt merge, keyed `id:type`. */
  absorbed: Array<{ key: string; parentId: string }>;
  /** Merges rebuilt with fewer sources than the author had. */
  partialMerges: Array<{ name: string; kept: number; dropped: number }>;
}

export function additionCount(additions: CatalogAdditions): number {
  return additions.added.length + additions.enabled.length;
}

interface MergeChild {
  catalogId: string;
  catalogType: string;
}

/** A merge needs at least two sources; the app dissolves anything smaller. */
const MIN_MERGE_SOURCES = 2;

/**
 * Works out what a config is missing for an imported layout: catalogs the file
 * carries a blueprint for, and built-in catalogs the user simply has turned off.
 */
export function resolveCatalogAdditions(
  existing: CatalogConfig[],
  blueprints: CatalogBlueprint[],
  unknownSources: ImportedSource[],
  apiKeys: Record<string, any> = {},
  /**
   * Source keys that arrived this session, from an import or a conversion.
   * Rebuilding a catalog from its id alone is for those: a source already in the
   * user's saved design has an id just as self describing, and rebuilding that one
   * resurrects a catalog they deliberately deleted. Null keeps every source
   * eligible, which is what the import preview wants before anything is committed.
   */
  rebuildableKeys: Set<string> | null = null
): CatalogAdditions {
  const mayRebuild = (source: ImportedSource): boolean =>
    rebuildableKeys === null || rebuildableKeys.has(`${source.catalogId}:${source.type}`);

  const byKey = new Map(existing.map(catalog => [`${catalog.id}:${catalog.type}`, catalog]));

  const added: CatalogConfig[] = [];
  const enabled: string[] = [];
  const claimed = new Set<string>();
  const resolved = new Set<string>();

  // Only what the design in front of the user still points at. A file can carry
  // far more than is kept, and deleting a tile has to take its catalog with it.
  const wanted = new Set(unknownSources.map(source => source.catalogId));
  // Merges are handled below instead: adding the parent verbatim here would claim it
  // before its children have been rebuilt.
  const usable = blueprints.filter(
    blueprint => wanted.has(blueprint.id) && !blueprint.id.startsWith('merged.')
  );
  const blueprintIds = new Set(usable.map(blueprint => blueprint.id));

  for (const blueprint of usable) {
    const key = `${blueprint.id}:${blueprint.type}`;
    if (claimed.has(key)) continue;
    claimed.add(key);

    const match = byKey.get(key);
    if (!match) {
      added.push({ ...blueprint } as CatalogConfig);
      continue;
    }
    if (!match.enabled) enabled.push(key);
  }

  const needsAccount = new Set<string>();
  const needsAccountKeys = new Set<string>();
  const absorbed: Array<{ key: string; parentId: string }> = [];
  const partialMerges: Array<{ name: string; kept: number; dropped: number }> = [];
  const blueprintById = new Map(blueprints.map(blueprint => [blueprint.id, blueprint]));

  const take = (key: string): boolean => {
    if (claimed.has(key)) return false;
    claimed.add(key);
    const match = byKey.get(key);
    if (!match) return true;
    if (!match.enabled) enabled.push(key);
    return false;
  };

  /** Existing catalog, shipped blueprint, self describing id, or built-in. */
  const resolveChild = (child: MergeChild): CatalogConfig | 'existing' | undefined => {
    const key = `${child.catalogId}:${child.catalogType}`;
    if (byKey.has(key)) return 'existing';

    const blueprint = blueprintById.get(child.catalogId);
    if (blueprint) return { ...blueprint } as CatalogConfig;

    const rebuilt = reconstructFromId({ catalogId: child.catalogId, type: child.catalogType });
    if (rebuilt) return rebuilt;

    const definition = findDefinition(child.catalogId, child.catalogType);
    if (!definition) return undefined;
    return {
      id: definition.id,
      type: definition.type,
      name: definition.name,
      source: definition.source as CatalogConfig['source'],
      enabled: true,
      showInHome: false,
    };
  };

  for (const source of unknownSources) {
    // A merge is a composition of other catalogs, so it only comes back if enough of
    // them do. The id is a hash, so without the parent's blueprint there is nothing
    // to go on.
    if (source.catalogId.startsWith('merged.')) {
      const parent = blueprintById.get(source.catalogId) as any;
      const children: MergeChild[] = Array.isArray(parent?.metadata?.mergedSources)
        ? parent.metadata.mergedSources
        : [];
      if (children.length < MIN_MERGE_SOURCES) continue;

      const kept: MergeChild[] = [];
      const staged: CatalogConfig[] = [];
      let dropped = 0;

      for (const child of children) {
        const outcome = resolveChild(child);
        if (!outcome) { dropped += 1; continue; }
        kept.push({ catalogId: child.catalogId, catalogType: child.catalogType });
        if (outcome !== 'existing') staged.push(outcome);
      }

      if (kept.length < MIN_MERGE_SOURCES) continue;

      const parentKey = `${source.catalogId}:${parent.type}`;
      resolved.add(`${source.catalogId}:${source.type}`);
      if (!take(parentKey)) continue;

      for (const child of staged) {
        const childKey = `${child.id}:${child.type}`;
        if (claimed.has(childKey)) continue;
        claimed.add(childKey);
        added.push({ ...child, mergedInto: source.catalogId, showInHome: false });
      }
      for (const child of kept) {
        const childKey = `${child.catalogId}:${child.catalogType}`;
        if (byKey.has(childKey)) absorbed.push({ key: childKey, parentId: source.catalogId });
      }

      added.push({
        ...(parent as CatalogConfig),
        enabled: true,
        metadata: {
          ...(parent.metadata || {}),
          mergedSources: kept.map(child => ({
            catalogId: child.catalogId,
            catalogType: child.catalogType,
            originalEnabled: true,
            originalShowInHome: false,
          })),
        },
      });

      if (dropped > 0) {
        partialMerges.push({ name: parent.name || source.catalogId, kept: kept.length, dropped });
      }
      continue;
    }

    // A displayType renames the type in the manifest but not in the config, so a
    // source is matched to its blueprint on the id alone.
    if (blueprintIds.has(source.catalogId)) {
      resolved.add(`${source.catalogId}:${source.type}`);
      continue;
    }

    if (!mayRebuild(source)) continue;

    const personal = findPersonal(source.catalogId);
    if (personal) {
      // Reported either way: unconnected ones are explained by needsAccount, so
      // they must not also surface as catalogs nothing knows how to rebuild.
      // They are still not being added, which needsAccountKeys keeps sayable.
      const key = `${source.catalogId}:${source.type}`;
      resolved.add(key);
      if (!String(apiKeys?.[personal.account.key] || '').trim()) {
        needsAccount.add(personal.account.label);
        needsAccountKeys.add(key);
        continue;
      }
      if (take(`${source.catalogId}:${personal.catalog.type}`)) {
        added.push({
          id: source.catalogId,
          enabled: true,
          showInHome: true,
          ...personal.catalog,
        });
      }
      continue;
    }

    const rebuilt = reconstructFromId(source);
    if (rebuilt) {
      resolved.add(`${source.catalogId}:${source.type}`);
      if (take(`${rebuilt.id}:${rebuilt.type}`)) added.push(rebuilt);
      continue;
    }

    // Files written by another app carry no blueprints, but a built-in catalog is
    // defined the same everywhere, so it can still be resolved from its id.
    const definition = findDefinition(source.catalogId, source.type);
    if (!definition) continue;
    resolved.add(`${source.catalogId}:${source.type}`);

    if (take(`${definition.id}:${definition.type}`)) {
      added.push({
        id: definition.id,
        type: definition.type,
        name: definition.name,
        source: definition.source,
        enabled: true,
        showInHome: definition.showOnHomeByDefault !== false,
      });
    }
  }

  return { added, enabled, resolved, needsAccount: [...needsAccount], needsAccountKeys, absorbed, partialMerges };
}

/** Applies the additions, leaving every other catalog and the ordering alone. */
export function applyCatalogAdditions(
  existing: CatalogConfig[],
  additions: CatalogAdditions
): CatalogConfig[] {
  const toEnable = new Set(additions.enabled);
  const toAbsorb = new Map(additions.absorbed.map(entry => [entry.key, entry.parentId]));
  const updated = existing.map(catalog => {
    const key = `${catalog.id}:${catalog.type}`;
    let next = toEnable.has(key) ? { ...catalog, enabled: true } : catalog;
    const parentId = toAbsorb.get(key);
    if (parentId) next = { ...next, mergedInto: parentId, showInHome: false };
    return next;
  });
  return [...updated, ...additions.added];
}

/** Names for the confirm step, capped for display. */
export function additionLabels(additions: CatalogAdditions, limit = 8): string[] {
  return additions.added.slice(0, limit).map(catalog => catalog.name || catalog.id);
}
