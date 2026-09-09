import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { encodeJellyfinId } from './ids';
import { collectionFolder } from './dto';

const { getManifest } = require('../getManifest');

const logger = consola.withTag('Jellyfin');

export interface CatalogRef {
  id: string;
  type: string;
  name: string;
  pageSize: number;
  extra: any[];
  showInHome?: boolean;
}

function viewsTtlSeconds(): number {
  return envInt('JELLYFIN_VIEWS_TTL', 300, 0);
}

const catalogCache = new LRUCache<string, CatalogRef[]>({
  max: envInt('JELLYFIN_VIEWS_CACHE_MAX', 500, 1),
  ttl: Math.max(1, viewsTtlSeconds()) * 1000,
});

/**
 * Jellyfin only understands a handful of library kinds. Anything AIOM types
 * outside movies and shows is left without a CollectionType, which renders as a
 * mixed library rather than one wearing the wrong chrome.
 *
 * `anime` is one of those: it carries movies and series alike, so mal.top_movies
 * and mal.top_series share it. Items still render by their own Type.
 */
export function collectionTypeFor(type: string): string | null {
  switch (type) {
    case 'movie':
    case 'anime.movie':
      return 'movies';
    case 'series':
    case 'anime.series':
      return 'tvshows';
    default:
      return null;
  }
}

export async function getCatalogs(userUUID: string, config: any): Promise<CatalogRef[]> {
  const key = `${userUUID}:${config?.configVersion ?? ''}`;
  const cached = catalogCache.get(key);
  if (cached) return cached;

  try {
    const manifest = await getManifest(config, { tags: [] });
    const catalogs: CatalogRef[] = Array.isArray(manifest?.catalogs) ? manifest.catalogs : [];
    catalogCache.set(key, catalogs);
    return catalogs;
  } catch (error: any) {
    logger.warn(`Failed to build catalogs for ${userUUID}: ${error?.message || error}`);
    return [];
  }
}

/**
 * A catalog with a required extra cannot be listed, only queried: the four
 * search catalogs, MAL's va_id and genre_id lookups, and calendar-videos all
 * declare one. They make empty libraries, so only the rest become views.
 */
export function isBrowsable(catalog: CatalogRef): boolean {
  return !(catalog.extra ?? []).some((e: any) => e?.isRequired);
}

export function requiredExtras(catalog: CatalogRef): string[] {
  return (catalog.extra ?? []).filter((e: any) => e?.isRequired).map((e: any) => e.name);
}

export function getSearchCatalogs(catalogs: CatalogRef[]): CatalogRef[] {
  return catalogs.filter((c) => {
    const required = requiredExtras(c);
    return required.length === 1 && required[0] === 'search';
  });
}

export function viewIdFor(catalog: CatalogRef): string {
  return encodeJellyfinId({ k: 'view', t: catalog.type, c: catalog.id });
}

export async function buildViews(
  userUUID: string,
  serverId: string,
  config: any
): Promise<any[]> {
  const catalogs = (await getCatalogs(userUUID, config)).filter(isBrowsable);
  return catalogs.map((catalog) =>
    collectionFolder(
      viewIdFor(catalog),
      serverId,
      catalog.name,
      collectionTypeFor(catalog.type),
      null
    )
  );
}

export async function findCatalogByViewId(
  userUUID: string,
  config: any,
  type: string,
  catalogId: string
): Promise<CatalogRef | null> {
  const catalogs = await getCatalogs(userUUID, config);
  return catalogs.find((c) => c.type === type && c.id === catalogId) ?? null;
}
