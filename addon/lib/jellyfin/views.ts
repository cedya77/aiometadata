import consola from 'consola';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { encodeJellyfinId } from './ids';
import { collectionFolder } from './dto';
import { profileTags } from './profiles';
import { viewerReadsExtensions } from './viewer';
import { isCollectionCatalogId } from '../collectionBuilder/aiostreamsCollections';
import { configCatalogFor, placeCollections, rowOptionsOf } from '../collectionBuilder/homeOrder';
import type { CatalogRowOptions } from '../collectionBuilder/types';
import { accountOwner, servedAccountsKey } from '../accounts';

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

// Types outside movies and shows are left without a CollectionType, which
// renders as a mixed library rather than one wearing the wrong chrome.
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

const BOXSET_CATALOGS = new Set(['tvdb.collections']);

export function isBoxSetCatalog(catalog: { id: string }): boolean {
  return BOXSET_CATALOGS.has(catalog.id.replace(/_(movie|series|anime|all)$/, ''));
}

export function viewTypeFor(catalog: { id: string; type: string }): string | null {
  return isBoxSetCatalog(catalog) ? 'boxsets' : collectionTypeFor(catalog.type);
}

export async function getCatalogs(userUUID: string, config: any): Promise<CatalogRef[]> {
  const tags = profileTags(config);
  const shape = createHash('md5').update(JSON.stringify(config?.catalogs ?? null)).digest('hex').slice(0, 12);
  const key = `${userUUID}:${tags.map((t) => t.toLowerCase()).sort().join(',')}:${shape}:${accountOwner(config)}:${servedAccountsKey(config)}`;
  const cached = catalogCache.get(key);
  if (cached) return cached;

  try {
    const manifest = await getManifest(config, { tags, userUUID });
    // Builder collections are served here as box sets already, not as their AIOStreams catalogs.
    const catalogs: CatalogRef[] = (Array.isArray(manifest?.catalogs) ? manifest.catalogs : [])
      .filter((c: CatalogRef) => !isCollectionCatalogId(c.id));
    catalogCache.set(key, catalogs);
    return catalogs;
  } catch (error: any) {
    logger.warn(`Failed to build catalogs for ${userUUID}: ${error?.message || error}`);
    return [];
  }
}

// A catalog with a required extra cannot be listed, only queried, so it would
// make an empty library.
export function isBrowsable(catalog: CatalogRef): boolean {
  const readsExtensions = viewerReadsExtensions();
  return !(catalog.extra ?? []).some((e: any) => e?.isRequired && !(readsExtensions && e.name === 'genre' && hasGenreOption(e)));
}

function hasGenreOption(extra: any): boolean {
  return Array.isArray(extra?.options) && extra.options.some((o: any) => typeof o === 'string' && o.length > 0);
}

export function requiresGenre(catalog: CatalogRef): boolean {
  return (catalog.extra ?? []).some((e: any) => e?.name === 'genre' && e?.isRequired);
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

// Everything accepting a search term, not only the catalogs that demand one.
export function getSearchableCatalogs(catalogs: CatalogRef[]): CatalogRef[] {
  return catalogs.filter((c) =>
    (c.extra ?? []).some((e: any) => e?.name === 'search')
  );
}

export function viewIdFor(catalog: CatalogRef): string {
  return encodeJellyfinId({ k: 'view', t: catalog.type, c: catalog.id });
}

export function rowFor(config: any, catalog: CatalogRef): CatalogRowOptions | null {
  return rowOptionsOf(configCatalogFor(config, catalog));
}

export function catalogView(catalog: CatalogRef, serverId: string, row: any = null): any {
  const { HIDE_TITLE_TAG } = require('./collections');
  const extensions = {
    ...(requiresGenre(catalog) ? { genreRequired: true } : {}),
    ...(row?.numbered === true ? { ranked: true } : {}),
  };
  const title = typeof row?.title === 'string' && row.title.trim() ? row.title.trim() : catalog.name;
  return {
    ...collectionFolder(viewIdFor(catalog), serverId, title, viewTypeFor(catalog), null),
    ...(row?.hideTitle === true ? { Tags: [HIDE_TITLE_TAG] } : {}),
    ...(Object.keys(extensions).length > 0 ? { aiostreams: extensions } : {}),
  };
}

export async function buildViews(
  userUUID: string,
  serverId: string,
  config: any
): Promise<any[]> {
  const { boxSetsFor, builderCollections, collectionView } = require('./collections');
  const catalogs = (await getCatalogs(userUUID, config)).filter(isBrowsable);

  const collections: Array<{ id: string; view: any }> = [];
  for (const collection of builderCollections(config)) {
    const folders = await boxSetsFor(userUUID, config, serverId, collection);
    if (folders.length) collections.push({ id: collection.id, view: collectionView(serverId, collection, folders.length) });
  }
  const placed = placeCollections(config, catalogs, (catalog) => configCatalogFor(config, catalog), collections, (collection) => collection.id);
  return placed.map((slot) => ('view' in slot ? slot.view : catalogView(slot, serverId, rowFor(config, slot))));
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
