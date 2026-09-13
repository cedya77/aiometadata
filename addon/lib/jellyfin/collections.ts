import { encodeJellyfinId } from './ids';
import { collectionFolder, EMPTY_USER_DATA } from './dto';
import { fetchWindow, includeTypesFilter, metaToBaseItem, rememberImages } from './items';
import { getCatalogs, type CatalogRef } from './views';
import { profileTags } from './profiles';
import type { CollectionDraft, FolderDraft, SourceDraft } from '../collectionBuilder/types';

// A builder collection is a library of box sets; a folder is one box set whose sources are its members.

const IMAGE_URL = /^https?:\/\//i;

function imageOf(value: unknown): string | undefined {
  return typeof value === 'string' && IMAGE_URL.test(value.trim()) ? value.trim() : undefined;
}

export function builderCollections(config: any): CollectionDraft[] {
  const entries = Array.isArray(config?.collections) ? config.collections : [];
  return entries.filter((e: any) => e?.kind === 'collection' && typeof e.id === 'string' && e.id && typeof e.title === 'string');
}

export function collectionById(config: any, id: string): CollectionDraft | null {
  return builderCollections(config).find((c) => c.id === id) ?? null;
}

export function collectionViewId(collection: CollectionDraft): string {
  return encodeJellyfinId({ k: 'collection', c: collection.id });
}

export function boxSetId(collection: CollectionDraft, folder: FolderDraft): string {
  return encodeJellyfinId({ k: 'boxset', c: collection.id, f: folder.id });
}

/** A source names a catalog by manifest id and type; one outside the user's catalogs is not shown. */
function catalogFor(catalogs: CatalogRef[], source: SourceDraft): CatalogRef | null {
  const id = String(source?.catalogId ?? '').trim();
  const type = String(source?.type ?? '').trim().toLowerCase();
  if (!id || !type) return null;
  return catalogs.find((c) => c.id === id && c.type.toLowerCase() === type) ?? null;
}

function visibleSources(catalogs: CatalogRef[], folder: FolderDraft): Array<{ source: SourceDraft; catalog: CatalogRef }> {
  const out: Array<{ source: SourceDraft; catalog: CatalogRef }> = [];
  for (const source of Array.isArray(folder?.sources) ? folder.sources : []) {
    const catalog = catalogFor(catalogs, source);
    if (catalog) out.push({ source, catalog });
  }
  return out;
}

export function collectionView(serverId: string, collection: CollectionDraft, folderCount: number | null): any {
  const id = collectionViewId(collection);
  const backdrop = imageOf(collection.backdropImageUrl);
  if (backdrop) rememberImages(serverId, id, { primary: backdrop, backdrop });
  const view = collectionFolder(id, serverId, collection.title, 'boxsets', folderCount);
  if (backdrop) {
    view.ImageTags = { Primary: 'p' };
    view.BackdropImageTags = ['b'];
  }
  return view;
}

function boxSetItem(serverId: string, collection: CollectionDraft, folder: FolderDraft, sourceCount: number): any {
  const id = boxSetId(collection, folder);
  const cover = imageOf(folder.coverImageUrl);
  const backdrop = imageOf(folder.heroBackdropUrl);
  const logo = imageOf(folder.titleLogoUrl);
  if (cover || backdrop || logo) rememberImages(serverId, id, { primary: cover, backdrop, logo });

  return {
    Name: folder.title,
    ServerId: serverId,
    Id: id,
    Etag: id,
    DateCreated: new Date(0).toISOString(),
    CanDelete: false,
    CanDownload: false,
    SortName: folder.title,
    ExternalUrls: [],
    Path: `/${id}`,
    EnableMediaSourceDisplay: false,
    Taglines: [],
    RemoteTrailers: [],
    ProviderIds: {},
    IsFolder: true,
    ParentId: collectionViewId(collection),
    Type: 'BoxSet',
    People: [],
    Studios: [],
    GenreItems: [],
    Genres: [],
    LocalTrailerCount: 0,
    UserData: { ...EMPTY_USER_DATA, Key: id, ItemId: id },
    ChildCount: sourceCount,
    RecursiveItemCount: null,
    DisplayPreferencesId: id,
    Tags: [],
    PrimaryImageAspectRatio: folder.shape === 'LANDSCAPE' ? 1.7777777777777777 : folder.shape === 'SQUARE' ? 1 : 0.6666666666666666,
    ImageTags: cover ? { Primary: 'p', ...(logo ? { Logo: 'l' } : {}) } : logo ? { Logo: 'l' } : {},
    BackdropImageTags: backdrop ? ['b'] : [],
    ImageBlurHashes: {},
    LocationType: 'FileSystem',
    MediaType: 'Unknown',
    LockedFields: [],
    LockData: false,
  };
}

/** The folders of a collection this user can see anything in. */
export async function boxSetsFor(userUUID: string, config: any, serverId: string, collection: CollectionDraft): Promise<any[]> {
  const catalogs = await getCatalogs(userUUID, config);
  const out: any[] = [];
  for (const folder of Array.isArray(collection.folders) ? collection.folders : []) {
    if (!folder?.id || typeof folder.title !== 'string') continue;
    const sources = visibleSources(catalogs, folder);
    if (!sources.length) continue;
    out.push(boxSetItem(serverId, collection, folder, sources.length));
  }
  return out;
}

export async function allBoxSets(userUUID: string, config: any, serverId: string): Promise<any[]> {
  const out: any[] = [];
  for (const collection of builderCollections(config)) {
    out.push(...(await boxSetsFor(userUUID, config, serverId, collection)));
  }
  return out;
}

/** Every collection as a library, with only the folders the user can see. */
export async function collectionViews(userUUID: string, config: any, serverId: string): Promise<any[]> {
  const views: any[] = [];
  for (const collection of builderCollections(config)) {
    const folders = await boxSetsFor(userUUID, config, serverId, collection);
    if (!folders.length) continue;
    views.push(collectionView(serverId, collection, folders.length));
  }
  return views;
}

export interface MembersPage {
  items: any[];
  hasMore: boolean;
}

// Sources walked in order with one running offset, deduped by id.
export async function boxSetMembers(
  userUUID: string,
  config: any,
  serverId: string,
  collection: CollectionDraft,
  folder: FolderDraft,
  startIndex: number,
  limit: number,
  includeItemTypes?: string
): Promise<MembersPage> {
  const sources = visibleSources(await getCatalogs(userUUID, config), folder);
  const parentId = boxSetId(collection, folder);
  const tags = profileTags(config);

  const seen = new Set<string>();
  const collected: any[] = [];
  let offset = 0;
  let more = false;

  outer: for (const { source, catalog } of sources) {
    const extras: Record<string, string> = {};
    if (typeof source.genre === 'string' && source.genre && source.genre !== 'None') extras.genre = source.genre;
    const keep = includeTypesFilter(catalog.type, includeItemTypes);

    let from = 0;
    for (;;) {
      if (collected.length >= limit) {
        more = true;
        break outer;
      }
      const want = limit - collected.length + Math.max(0, startIndex - offset);
      const page = await fetchWindow(userUUID, catalog, from, want, extras, keep, tags)
        .catch(() => ({ items: [] as any[], hasMore: false }));

      for (const meta of page.items) {
        if (!meta?.id || seen.has(String(meta.id))) continue;
        seen.add(String(meta.id));
        if (offset >= startIndex && collected.length < limit) {
          collected.push(metaToBaseItem(meta, catalog.type, serverId, parentId));
        }
        offset += 1;
      }

      if (!page.hasMore || page.items.length === 0) break;
      from += page.items.length;
    }
  }

  return { items: collected, hasMore: more };
}

/** The pixel box a folder's cover is cropped to, matching the tile shape a client draws. */
export function folderCoverSize(config: any, collectionId: string, folderId: string): { width: number; height: number } {
  const folder = (collectionById(config, collectionId)?.folders ?? []).find((f: any) => f?.id === folderId);
  const shape = folder?.shape;
  if (shape === 'LANDSCAPE') return { width: 960, height: 540 };
  if (shape === 'SQUARE') return { width: 600, height: 600 };
  return { width: 600, height: 900 };
}
