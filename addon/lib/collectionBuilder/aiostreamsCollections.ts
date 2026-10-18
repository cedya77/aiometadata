import { animatedPosterOf, builderCollections, collectionById, folderById, imageOf, visibleSources } from '../jellyfin/collections';
import { getCatalogs, type CatalogRef } from '../jellyfin/views';
import { getCollectionImagePrefix } from '../posterCache/config';
import { proxyCollectionImages } from './imageProxy';
import { subFolders, type CollectionDraft, type FolderDraft } from './types';

// Builder collections served as AIOStreams collection metas:
// https://docs.aiostreams.viren070.me/reference/addon-protocol/collections/
// Each collection is a catalog of its folders, and each folder a meta whose
// `collection` block names its catalogs and holds its subfolders.

export const COLLECTION_TYPE = 'collection';
export const COLLECTION_META_PREFIX = 'aiom.collection:';
const COLLECTION_CATALOG_PREFIX = 'aiom.collection.';
const SHAPES: Record<string, string> = { LANDSCAPE: 'landscape', SQUARE: 'square' };

/** A folder is only reachable through the meta resource. */
export function collectionsServed(config: any): boolean {
  return !config?.catalogModeOnly && config?.collectionCatalogs !== false;
}

export function isCollectionCatalogId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(COLLECTION_CATALOG_PREFIX);
}

/** Tag-scoped, with images through the image cache as the exports serve them. */
function scoped(config: any, tags: string[]): any {
  const prefix = config?.collectionImagesViaCache ? getCollectionImagePrefix() : '';
  const collections = prefix && Array.isArray(config.collections) ? proxyCollectionImages(config.collections, prefix) : config?.collections;
  return { ...config, collections, jellyfinProfileTags: tags };
}

export function collectionCatalogs(config: any, tags: string[]): any[] {
  if (!collectionsServed(config)) return [];
  return builderCollections(scoped(config, tags)).map((collection) => {
    const art = imageOf(collection.backdropImageUrl);
    return {
      id: `${COLLECTION_CATALOG_PREFIX}${collection.id}`,
      type: COLLECTION_TYPE,
      name: collection.title,
      // A required genre keeps it off a home board, and showInHome off one that ignores that; AIOStreams reads `None` as no genre.
      extra: [{ name: 'genre', options: ['None'], isRequired: true }],
      showInHome: false,
      ...(art ? { poster: art, background: art } : {}),
    };
  });
}

function namedFolders(folders: FolderDraft[]): FolderDraft[] {
  return folders.filter((folder) => folder?.id && typeof folder.title === 'string');
}

function folderMeta(catalogs: CatalogRef[], collection: CollectionDraft, folder: FolderDraft, full: boolean): any {
  const cover = imageOf(folder.coverImageUrl);
  const animated = animatedPosterOf(folder);
  const shape = SHAPES[folder.shape] ?? 'poster';
  const meta: any = {
    id: `${COLLECTION_META_PREFIX}${collection.id}:${folder.id}`,
    type: COLLECTION_TYPE,
    name: folder.title,
    poster: cover,
    ...(shape === 'landscape' && cover ? { landscapePoster: cover } : {}),
    ...(animated ? { animatedPoster: animated } : {}),
    posterShape: shape,
    background: imageOf(folder.heroBackdropUrl) ?? imageOf(collection.backdropImageUrl),
    logo: imageOf(folder.titleLogoUrl),
    collection: {},
  };
  if (!full) return meta;

  const items = namedFolders(subFolders(folder)).map((child) => folderMeta(catalogs, collection, child, false));
  // AIOStreams matches a type exactly, so it goes out as the manifest spells it now.
  const sources = visibleSources(catalogs, folder).map(({ source, catalog }) => ({
    type: catalog.type,
    catalogId: catalog.id,
    ...(source.genre && source.genre !== 'None' ? { genre: source.genre } : {}),
  }));
  meta.collection = { ...(items.length ? { items } : {}), ...(sources.length ? { sources } : {}) };
  return meta;
}

/** A collection catalog's page: the collection's top-level folders, empty ones included. */
export async function collectionCatalogMetas(userUUID: string, config: any, tags: string[], catalogId: string, skip: number): Promise<any[] | null> {
  if (!collectionsServed(config) || !isCollectionCatalogId(catalogId)) return null;
  const view = scoped(config, tags);
  const collection = collectionById(view, catalogId.slice(COLLECTION_CATALOG_PREFIX.length));
  if (!collection) return null;
  if (skip > 0) return [];
  const catalogs = await getCatalogs(userUUID, view);
  return namedFolders(collection.folders || []).map((folder) => folderMeta(catalogs, collection, folder, false));
}

export async function collectionMeta(userUUID: string, config: any, tags: string[], id: string): Promise<any | null> {
  if (!collectionsServed(config) || !id.startsWith(COLLECTION_META_PREFIX)) return null;
  const [collectionId, folderId] = id.slice(COLLECTION_META_PREFIX.length).split(':');
  const view = scoped(config, tags);
  const collection = collectionById(view, collectionId ?? '');
  const folder = folderById(collection, folderId ?? '');
  if (!collection || !folder) return null;
  return folderMeta(await getCatalogs(userUUID, view), collection, folder, true);
}
