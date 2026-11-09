import { imageTag } from './imageTags';
import { envInt } from '../../utils/envNumber';
import { encodeJellyfinId } from './ids';
import { collectionFolder, EMPTY_USER_DATA } from './dto';
import { catalogCannotServe, fetchWindow, includeTypesFilter, listFilterKey, type ExtraFilters, type StudioFilter, type Window, isLandscapeCatalog, knownCatalogLength, knownPageLength, learnListLength, metaToBaseItem, rememberImages, servedOrder, showLandscape, warmCatalogLengths } from './items';
import { getCatalogs, requiresGenre, viewIdFor, viewTypeFor, type CatalogRef } from './views';
import { viewerAccountOwner, viewerReadsExtensions } from './viewer';
import { profileTags } from './profiles';
import { walkRecords } from './walkRecords';
import { findFolder, subFolders, type CollectionDraft, type FolderDraft, type SourceDraft } from '../collectionBuilder/types';
import { FOLDER_MERGE_MODE, mergeModeOf, type MergeMode } from '../collectionBuilder/mergeModes';
import { mergedDedupKey, shuffleMetas } from '../../utils/mergedCatalog';

// A builder collection is a library of box sets; a folder is one box set whose sources are its members.

const IMAGE_URL = /^https?:\/\//i;

export function imageOf(value: unknown): string | undefined {
  return typeof value === 'string' && IMAGE_URL.test(value.trim()) ? value.trim() : undefined;
}

export function animatedPosterOf(folder: FolderDraft): string | undefined {
  return folder.focusGifEnabled !== false ? imageOf(folder.focusGifUrl) : undefined;
}

/** An entry with tags is for the users holding one of them; the unrestricted user sees every entry. */
export function entryVisible(entry: any, config: any): boolean {
  const wanted = Array.isArray(entry?.tags) ? entry.tags.filter(Boolean) : [];
  if (!wanted.length) return true;
  const held = new Set(profileTags(config).map((t) => t.toLowerCase()));
  if (!held.size) return true;
  return wanted.some((t: string) => held.has(String(t).toLowerCase()));
}

export function builderCollections(config: any): CollectionDraft[] {
  const entries = Array.isArray(config?.collections) ? config.collections : [];
  return entries.filter((e: any) =>
    e?.kind === 'collection' && typeof e.id === 'string' && e.id && typeof e.title === 'string' && entryVisible(e, config)
  );
}

export function collectionById(config: any, id: string): CollectionDraft | null {
  return builderCollections(config).find((c) => c.id === id) ?? null;
}

export function collectionViewId(collection: CollectionDraft): string {
  return encodeJellyfinId({ k: 'collection', c: collection.id });
}

export function folderById(collection: CollectionDraft | null, folderId: string): FolderDraft | null {
  return collection ? findFolder(Array.isArray(collection.folders) ? collection.folders : [], folderId) ?? null : null;
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

export function visibleSources(catalogs: CatalogRef[], folder: FolderDraft): Array<{ source: SourceDraft; catalog: CatalogRef }> {
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
  if (collection.hideTitle) view.Tags = [HIDE_TITLE_TAG];
  if (backdrop) {
    view.ImageTags = { Primary: imageTag(backdrop) };
    view.BackdropImageTags = [imageTag(backdrop)];
  }
  return view;
}

export const HIDE_TITLE_TAG = 'hide-title';

function visibleDeep(catalogs: CatalogRef[], folder: FolderDraft): number {
  return visibleSources(catalogs, folder).length + subFolders(folder).reduce((sum, child) => sum + visibleDeep(catalogs, child), 0);
}

interface CountScope {
  userUUID: string;
  tags: string[];
}

// Titles are counted once a folder's one source has been read to its end; several
// sources share titles, so their lengths add up to more than the folder shows.
function childCount(scope: CountScope, catalogs: CatalogRef[], folder: FolderDraft): number | null {
  const sources = visibleSources(catalogs, folder);
  if (sources.length > 1) return null;
  const folders = subFolders(folder).filter((child) => visibleDeep(catalogs, child) > 0).length;
  if (sources.length === 0) return folders;
  const { source, catalog } = sources[0];
  const genre = pinnedGenre(source);
  const known = knownCatalogLength(scope.userUUID, catalog, genre ? { genre } : {}, scope.tags);
  return known === undefined ? null : folders + known;
}

async function countScope(userUUID: string, config: any, catalogs: CatalogRef[], folders: FolderDraft[]): Promise<CountScope> {
  const tags = profileTags(config);
  const unpinned = new Map<string, CatalogRef>();
  const walk = (list: FolderDraft[]) => {
    for (const folder of list) {
      for (const { source, catalog } of visibleSources(catalogs, folder)) {
        if (!pinnedGenre(source)) unpinned.set(`${catalog.type}|${catalog.id}`, catalog);
      }
      walk(subFolders(folder));
    }
  };
  walk(folders);
  await warmCatalogLengths(userUUID, [...unpinned.values()], {}, tags);
  return { userUUID, tags };
}

function sourceRows(catalogs: CatalogRef[], folder: FolderDraft): Array<{ id: string; name: string; genre?: string; collectionType?: string }> {
  return visibleSources(catalogs, folder).map(({ source, catalog }) => {
    const pinned = pinnedGenre(source);
    const name = source.name?.trim() || catalog.name;
    const options = catalogGenres(catalog);
    const genre = pinned ?? (requiresGenre(catalog) ? (catalogOffersNone(catalog) ? 'None' : options[0]) : undefined);
    const collectionType = viewTypeFor(catalog);
    return {
      id: viewIdFor(catalog),
      name: pinned ? `${name} · ${pinned}` : name,
      ...(genre ? { genre } : {}),
      ...(collectionType ? { collectionType } : {}),
    };
  });
}

function boxSetItem(serverId: string, catalogs: CatalogRef[], collection: CollectionDraft, folder: FolderDraft, childCount: number | null, parentId: string): any {
  const id = boxSetId(collection, folder);
  const cover = imageOf(folder.coverImageUrl);
  const backdrop = imageOf(folder.heroBackdropUrl);
  const logo = imageOf(folder.titleLogoUrl);
  const animated = animatedPosterOf(folder);
  const sources = viewerReadsExtensions() ? sourceRows(catalogs, folder) : [];
  const extensions = {
    ...(animated ? { animatedPoster: animated } : {}),
    ...(sources.length ? { sources } : {}),
  };
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
    ParentId: parentId,
    Type: 'BoxSet',
    People: [],
    Studios: [],
    GenreItems: [],
    Genres: [],
    LocalTrailerCount: 0,
    UserData: { ...EMPTY_USER_DATA, Key: id, ItemId: id },
    ChildCount: childCount,
    RecursiveItemCount: null,
    DisplayPreferencesId: id,
    Tags: folder.hideTitle ? [HIDE_TITLE_TAG] : [],
    PrimaryImageAspectRatio: folder.shape === 'LANDSCAPE' ? 1.7777777777777777 : folder.shape === 'SQUARE' ? 1 : 0.6666666666666666,
    ImageTags: { ...(cover ? { Primary: imageTag(cover) } : {}), ...(logo ? { Logo: imageTag(logo) } : {}) },
    BackdropImageTags: backdrop ? [imageTag(backdrop)] : [],
    ImageBlurHashes: {},
    LocationType: 'FileSystem',
    MediaType: 'Unknown',
    LockedFields: [],
    LockData: false,
    ...(Object.keys(extensions).length ? { aiostreams: extensions } : {}),
  };
}

function boxSetsOf(scope: CountScope, catalogs: CatalogRef[], serverId: string, collection: CollectionDraft, folders: FolderDraft[], parentId: string, deep: boolean): any[] {
  const out: any[] = [];
  for (const folder of folders) {
    if (!folder?.id || typeof folder.title !== 'string') continue;
    const set = boxSetItem(serverId, catalogs, collection, folder, childCount(scope, catalogs, folder), parentId);
    out.push(set);
    if (deep) out.push(...boxSetsOf(scope, catalogs, serverId, collection, subFolders(folder), set.Id, true));
  }
  return out;
}

/** The folders of a collection, including those with nothing this user can see. */
export async function boxSetsFor(userUUID: string, config: any, serverId: string, collection: CollectionDraft): Promise<any[]> {
  const catalogs = await getCatalogs(userUUID, config);
  const folders = Array.isArray(collection.folders) ? collection.folders : [];
  return boxSetsOf(await countScope(userUUID, config, catalogs, folders), catalogs, serverId, collection, folders, collectionViewId(collection), false);
}

export async function boxSetsUnder(userUUID: string, config: any, serverId: string, collection: CollectionDraft, folder: FolderDraft): Promise<any[]> {
  const catalogs = await getCatalogs(userUUID, config);
  return boxSetsOf(await countScope(userUUID, config, catalogs, subFolders(folder)), catalogs, serverId, collection, subFolders(folder), boxSetId(collection, folder), false);
}

export async function boxSetsDeep(userUUID: string, config: any, serverId: string, collection: CollectionDraft): Promise<any[]> {
  const catalogs = await getCatalogs(userUUID, config);
  const folders = Array.isArray(collection.folders) ? collection.folders : [];
  return boxSetsOf(await countScope(userUUID, config, catalogs, folders), catalogs, serverId, collection, folders, collectionViewId(collection), true);
}

export async function allBoxSets(userUUID: string, config: any, serverId: string): Promise<any[]> {
  const out: any[] = [];
  for (const collection of builderCollections(config)) {
    out.push(...(await boxSetsDeep(userUUID, config, serverId, collection)));
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
  truncated?: boolean;
  /** How many titles the folder's sources hold together, where each is known. */
  listed?: number;
  /** The folder's length, for a page asked past its end. */
  length?: number;
}

/**
 * At most how many titles the folder's sources hold together, or undefined while one is unknown. A title several
 * sources share is served once, so the sum is the folder's length only when a single source can serve it.
 */
async function folderLength(userUUID: string, sources: Array<{ catalog: CatalogRef; genre: string | null }>, includeItemTypes: string | undefined, tags: string[], filterKey: string): Promise<{ bound: number; exact: boolean } | undefined> {
  let total = 0;
  let counted = 0;
  for (const { catalog, genre } of sources) {
    if (catalogCannotServe(catalog, includeItemTypes)) continue;
    const known = await learnListLength(userUUID, catalog, genre ? { genre } : {}, tags, filterKey);
    if (known === undefined) return undefined;
    total += known;
    counted += 1;
  }
  return { bound: total, exact: counted <= 1 };
}

interface MemberCursor {
  sourceIndex: number;
  sourceOffset: number;
  failures: number;
}

// A catalog that fails this many reads in a row is passed over, as one that stays down would block the rest.
const FAILED_READS_BEFORE_SKIP = 2;

// Both walks share one budget of shown titles; their keys never meet.
const walks = walkRecords<MemberCursor | MixCursor>({
  max: 1000,
  maxIds: envInt('JELLYFIN_FOLDER_CURSOR_IDS', 200000, 25001),
  ttlMs: envInt('JELLYFIN_FOLDER_CURSOR_TTL', 600, 30) * 1000,
});
const MEMBER_CURSOR_MAX_IDS = 25000;

const catalogPageSize = (): number => envInt('CATALOG_LIST_ITEMS_SIZE', 20, 1);

// An anime season entry carries its series' IMDb id, which its sibling seasons share, so it is known by its own id.
const ANIME_ID = /^(mal|kitsu|anilist|anidb):/;

function firstSight(seen: Set<string>, meta: any, added: string[]): boolean {
  const key = ANIME_ID.test(String(meta?.id ?? '')) ? String(meta.id) : mergedDedupKey(meta);
  if (!key || seen.has(key)) return false;
  seen.add(key);
  added.push(key);
  return true;
}

function memberItem(meta: any, catalog: CatalogRef, serverId: string, parentId: string, landscape: boolean): any {
  const item = metaToBaseItem(meta, catalog.type, serverId, parentId);
  if (landscape) showLandscape([item]);
  return item;
}

function catalogOffersNone(catalog: CatalogRef): boolean {
  const extra = (catalog.extra ?? []).find((e: any) => e?.name === 'genre');
  return Array.isArray(extra?.options) && extra.options.includes('None');
}

function catalogGenres(catalog: CatalogRef): string[] {
  const extra = (catalog.extra ?? []).find((e: any) => e?.name === 'genre');
  const options = Array.isArray(extra?.options) ? extra.options : [];
  return options.filter((g: any) => typeof g === 'string' && g && g !== 'None');
}

const pinnedGenre = (source: SourceDraft): string | null =>
  typeof source.genre === 'string' && source.genre && source.genre !== 'None' ? source.genre : null;

function genreFor(source: SourceDraft, catalog: CatalogRef, wanted: string): string | null {
  const pinned = pinnedGenre(source);
  if (pinned) return pinned.toLowerCase() === wanted.toLowerCase() ? pinned : null;
  return catalogGenres(catalog).find((g) => g.toLowerCase() === wanted.toLowerCase()) ?? null;
}

export async function boxSetGenres(
  userUUID: string,
  config: any,
  folder: FolderDraft
): Promise<{ catalog: CatalogRef | null; genres: string[] }> {
  const sources = visibleSources(await getCatalogs(userUUID, config), folder);
  const seen = new Map<string, string>();
  for (const { source, catalog } of sources) {
    const pinned = pinnedGenre(source);
    for (const genre of pinned ? [pinned] : catalogGenres(catalog)) {
      if (!seen.has(genre.toLowerCase())) seen.set(genre.toLowerCase(), genre);
    }
  }
  return { catalog: sources[0]?.catalog ?? null, genres: [...seen.values()] };
}

/** The filters a box set listing applies beside its types, genre and ratings. */
export interface MemberFilters {
  years?: unknown;
  studios?: StudioFilter | null;
  extra?: ExtraFilters | null;
}

export async function boxSetMembers(
  userUUID: string,
  config: any,
  serverId: string,
  collection: CollectionDraft,
  folder: FolderDraft,
  startIndex: number,
  limit: number,
  includeItemTypes?: string,
  genre?: string,
  officialRatings?: string,
  filters: MemberFilters = {}
): Promise<MembersPage> {
  const sources = visibleSources(await getCatalogs(userUUID, config), folder)
    .map((entry) => ({ ...entry, genre: genre ? genreFor(entry.source, entry.catalog, genre) : pinnedGenre(entry.source) }))
    .filter((entry) => !genre || entry.genre);
  const parentId = boxSetId(collection, folder);
  const tags = profileTags(config);
  const extrasOf = (entry: { genre: string | null }): Record<string, string> => (entry.genre ? { genre: entry.genre } : {});
  const filterKey = listFilterKey(includeItemTypes, officialRatings, filters.years, filters.studios, filters.extra);

  const cursorKey = JSON.stringify([
    userUUID, collection.id, folder.id, filterKey, genre ?? '', tags, viewerAccountOwner(),
    sources.map(({ catalog, genre: served }) => [catalog.type, catalog.id, served ?? '']),
  ]);
  const mode = mergeModeOf(folder.mergeMode, FOLDER_MERGE_MODE);
  const shuffled = Boolean(folder.randomizePerPage) && folder.sources.length > 1;
  // The sum of the sources' lengths bounds the folder; it is worked out once a request.
  let lengthRead: { bound: number; exact: boolean } | undefined;
  const length = async () => (lengthRead ??= await folderLength(userUUID, sources, includeItemTypes, tags, filterKey));
  // Asked past where its sources end together, the folder has nothing more, however its sources would be read.
  if (startIndex > 0) {
    const known = await length();
    if (known && startIndex >= known.bound) return { items: [], hasMore: false, length: known.bound };
  }
  // Only a folder's single source gives its length outright: shared titles leave a sum of several above what it serves.
  const withLength = async (page: MembersPage): Promise<MembersPage> => {
    const known = page.hasMore ? await length() : undefined;
    return known?.exact ? { ...page, listed: known.bound } : page;
  };
  if (sources.length > 1 && mode !== 'sequential') {
    const page = await withLength(await mixedMembers({
      userUUID, config, serverId, parentId, sources, mode, startIndex, limit, includeItemTypes, officialRatings, filters, tags, filterKey,
      cursorKey: `${mode}:${cursorKey}`,
    }));
    return shuffled ? { ...page, items: shuffleMetas(page.items) } : page;
  }
  // Each page resumes only at the place a walk stopped, so a read elsewhere in the folder leaves it be.
  const found = walks.resume(cursorKey, startIndex);
  const resumed = found && found.place.at === startIndex ? found : null;
  const held = resumed?.place.state as MemberCursor | undefined;

  let sourceIndex = 0;
  let from = 0;
  let seen: Set<string>;
  let toSkip = 0;
  let failures = 0;
  const added: string[] = [];
  if (resumed && held) {
    sourceIndex = held.sourceIndex;
    from = held.sourceOffset;
    failures = held.failures ?? 0;
    seen = resumed.seen;
  } else if (sources.length > 1) {
    seen = new Set<string>();
    toSkip = startIndex;
  } else {
    seen = new Set<string>();
    let passed = 0;
    while (sourceIndex < sources.length) {
      const { catalog } = sources[sourceIndex];
      const known = knownCatalogLength(userUUID, catalog, extrasOf(sources[sourceIndex]), tags, filterKey);
      if (known === undefined || passed + known > startIndex) break;
      passed += known;
      sourceIndex += 1;
    }
    from = Math.max(0, startIndex - passed);
  }

  const collected: any[] = [];
  let nextIndex = startIndex;
  let truncated = false;

  while (sourceIndex < sources.length && collected.length < limit) {
    const { catalog } = sources[sourceIndex];
    if (catalogCannotServe(catalog, includeItemTypes)) {
      sourceIndex += 1;
      from = 0;
      continue;
    }
    const extras = extrasOf(sources[sourceIndex]);
    const keep = includeTypesFilter(catalog.type, includeItemTypes, officialRatings, filters.years, filters.studios, filters.extra);
    const landscape = isLandscapeCatalog(config, catalog);
    const page = await fetchWindow(userUUID, catalog, from, toSkip + limit - collected.length, extras, keep, tags, filterKey)
      .catch((): Window => ({ items: [], hasMore: false, failed: true }));

    const served: any[] = [];
    for (const meta of page.items) {
      if (!meta?.id || !firstSight(seen, meta, added)) continue;
      if (toSkip > 0) {
        toSkip -= 1;
        continue;
      }
      served.push(meta);
    }
    for (const meta of servedOrder(served, page)) {
      collected.push(memberItem(meta, catalog, serverId, parentId, landscape));
      nextIndex += 1;
    }
    from += page.items.length;
    // A failed read is tried again on the next page, unless nothing has filled this one, which would end the client's paging.
    if (page.failed) {
      failures += 1;
      if (collected.length > 0 && failures < FAILED_READS_BEFORE_SKIP) break;
    } else {
      failures = 0;
    }
    // A source its read budget cut short is read on from here on the next ask.
    if (page.truncated) {
      truncated = true;
      break;
    }

    if (page.failed || !page.hasMore || page.items.length === 0) {
      sourceIndex += 1;
      from = 0;
      failures = 0;
    }
  }

  const more = sourceIndex < sources.length;
  if (more && collected.length > 0 && seen.size <= MEMBER_CURSOR_MAX_IDS) {
    walks.save(cursorKey, resumed, added, nextIndex, { sourceIndex, sourceOffset: from, failures });
  }

  return withLength({ items: shuffled ? shuffleMetas(collected) : collected, hasMore: more, ...(truncated ? { truncated: true } : {}) });
}

// Where a mixed walk stopped: each source's position, whose turn is next, and
// for alternating how much of that source's page is still to come.
interface MixCursor {
  offsets: number[];
  done: boolean[];
  turn: number;
  runLeft: number;
  failures: number[];
}

/** Several sources taken in turn: one title each when interleaved, one page each when alternating. */
async function mixedMembers(args: {
  userUUID: string;
  config: any;
  serverId: string;
  parentId: string;
  sources: Array<{ source: SourceDraft; catalog: CatalogRef; genre: string | null }>;
  mode: Exclude<MergeMode, 'sequential'>;
  startIndex: number;
  limit: number;
  includeItemTypes?: string;
  officialRatings?: string;
  filters: MemberFilters;
  tags: string[];
  filterKey: string;
  cursorKey: string;
}): Promise<MembersPage> {
  const { userUUID, config, serverId, parentId, sources, mode, startIndex, limit, includeItemTypes, officialRatings, filters, tags, filterKey, cursorKey } = args;
  const count = sources.length;
  const extrasOf = (i: number): Record<string, string> => (sources[i].genre ? { genre: sources[i].genre as string } : {});
  const runLength = (i: number): number => knownPageLength(userUUID, sources[i].catalog, extrasOf(i), tags) ?? catalogPageSize();
  const found = walks.resume(cursorKey, startIndex);
  const at = found && found.place.at === startIndex ? found : null;
  const resumed = at?.place.state as MixCursor | undefined;
  const offsets = resumed ? [...resumed.offsets] : sources.map(() => 0);
  const done = resumed ? [...resumed.done] : sources.map(({ catalog }) => catalogCannotServe(catalog, includeItemTypes));
  const seen = at?.seen ?? new Set<string>();
  const added: string[] = [];
  let turn = resumed?.turn ?? 0;
  // -1 starts a source's page, measured once its first window has been read.
  let runLeft = resumed?.runLeft ?? -1;
  // A window placed by count is rebuilt from the start, since repeats shift every later position.
  let toSkip = resumed ? 0 : startIndex;

  const buffers: any[][] = sources.map(() => []);
  const ended = sources.map(() => false);
  const landscapes = sources.map(({ catalog }) => isLandscapeCatalog(config, catalog));
  const stalled = sources.map(() => false);
  const cut = sources.map(() => false);
  let paused = false;
  const failures = resumed?.failures ? [...resumed.failures] : sources.map(() => 0);
  const chunk = Math.max(10, Math.ceil((toSkip + limit) / count));
  const randomized = new Set<number>();
  const sourceOf: number[] = [];

  // Positions count every title a source handed over, repeats too, so the next window starts where this one stopped.
  const fill = async (i: number): Promise<void> => {
    if (buffers[i].length || ended[i] || done[i]) return;
    const { catalog } = sources[i];
    const keep = includeTypesFilter(catalog.type, includeItemTypes, officialRatings, filters.years, filters.studios, filters.extra);
    const size = mode === 'alternating' ? Math.max(chunk, runLeft > 0 ? runLeft : runLength(i)) : chunk;
    // A filtered walk reads on from its nearest place before this one, so a source its budget cut short goes on from there.
    const window = await fetchWindow(userUUID, catalog, offsets[i], size, extrasOf(i), keep, tags, filterKey)
      .catch(() => null);
    buffers[i] = window?.items ?? [];
    // A read that failed keeps what it got and is read again from there on the next page, until it has failed too often.
    if (!window || window.failed) {
      failures[i] += 1;
      stalled[i] = failures[i] < FAILED_READS_BEFORE_SKIP;
      ended[i] = true;
      return;
    }
    failures[i] = 0;
    cut[i] = window.truncated === true;
    if (window.randomize) randomized.add(i);
    if (!window.hasMore) ended[i] = true;
  };
  // A source its read budget cut short holds the page there, as the titles it has yet to find come next.
  const take = async (i: number): Promise<any | undefined> => {
    if (!buffers[i].length && cut[i]) {
      paused = true;
      return undefined;
    }
    await fill(i);
    if (!buffers[i].length) {
      if (cut[i]) paused = true;
      else done[i] = true;
      return undefined;
    }
    offsets[i] += 1;
    return buffers[i].shift();
  };
  if (mode === 'interleaved') await Promise.all(sources.map((_, i) => fill(i)));
  const pass = () => {
    turn = (turn + 1) % count;
    runLeft = -1;
  };

  const collected: any[] = [];
  let nextIndex = startIndex;
  while (collected.length < limit && done.some((d) => !d)) {
    const i = turn % count;
    if (done[i]) {
      pass();
      continue;
    }
    const meta = await take(i);
    if (paused) break;
    if (meta === undefined) {
      pass();
      continue;
    }
    if (mode === 'interleaved') pass();
    else {
      if (runLeft < 0) runLeft = runLength(i);
      runLeft -= 1;
      if (runLeft <= 0) pass();
    }
    if (!meta?.id || !firstSight(seen, meta, added)) continue;
    if (toSkip > 0) {
      toSkip -= 1;
      continue;
    }
    collected.push(memberItem(meta, sources[i].catalog, serverId, parentId, landscapes[i]));
    sourceOf.push(i);
    nextIndex += 1;
  }
  // A catalog that shuffles its own pages has its titles shuffled among the places they took.
  const spots = collected.map((_, k) => k).filter((k) => randomized.has(sourceOf[k]));
  const mixed = shuffleMetas(spots.map((k) => collected[k]));
  spots.forEach((k, j) => {
    collected[k] = mixed[j];
  });

  const finished = sources.map((_, i) => !stalled[i] && (done[i] || (ended[i] && buffers[i].length === 0)));
  const more = finished.some((f) => !f);
  if (more && collected.length > 0 && seen.size <= MEMBER_CURSOR_MAX_IDS) {
    walks.save(cursorKey, at, added, nextIndex, { offsets, done: finished, turn, runLeft, failures });
  }
  return { items: collected, hasMore: more, ...(paused ? { truncated: true } : {}) };
}
