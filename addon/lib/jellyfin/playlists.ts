import { randomBytes } from 'crypto';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { mapWithConcurrency } from '../../utils/concurrency';
import { encodeJellyfinId, decodeJellyfinId, flushPendingJellyfinIds } from './ids';
import { normaliseJellyfinId, type Descriptor } from './idsCodec';
import { buildEpisodes, fetchMeta, metaToBaseItem, recallImages, rememberImages, type ItemImages } from './items';
import { boxSetMembers, collectionById, folderById } from './collections';
import { collectionFolder, itemList, EMPTY_USER_DATA } from './dto';
import { imageTag } from './imageTags';
import { profileKey } from './profiles';
import { loadConfig, serverIdFor } from './context';

// Jellyfin's playlists, kept per user. An entry's PlaylistItemId is its item's id, as in Jellyfin, so a title is in a playlist once.

const database: any = require('../database');

export interface Playlist {
  id: string;
  name: string;
  items: string[];
  createdAt: number;
  updatedAt: number;
}

interface Owner {
  userUUID: string;
  profile: string;
}

/** What the router lends: items built as an Ids lookup builds them, in the order asked. */
export interface PlaylistRouteDeps {
  buildItems: (req: any, ids: string[]) => Promise<any[]>;
}

const NAME_LENGTH = 200;

const playlistsPerUser = () => envInt('JELLYFIN_PLAYLISTS_MAX', 200, 1);
const itemsPerPlaylist = () => envInt('JELLYFIN_PLAYLIST_ITEMS_MAX', 1000, 1);
export const playlistConcurrency = () => envInt('JELLYFIN_PLAYLIST_BUILD_CONCURRENCY', 6, 1);

export const PLAYLISTS_FOLDER_ID = encodeJellyfinId({ k: 'playlists' });

export function playlistItemId(playlist: Pick<Playlist, 'id'>): string {
  return encodeJellyfinId({ k: 'playlist', p: playlist.id });
}

function ownerOf(req: any, config: any): Owner {
  return ownerFor(String(req.params.userUUID), config);
}

function fromRow(row: any): Playlist {
  let items: string[] = [];
  try {
    const parsed = JSON.parse(String(row.items));
    if (Array.isArray(parsed)) items = parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    items = [];
  }
  return { id: String(row.id), name: String(row.name), items, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}

async function listPlaylists(owner: Owner): Promise<Playlist[]> {
  return (await database.listPlaylists(owner.userUUID, owner.profile)).map(fromRow);
}

async function getPlaylist(owner: Owner, id: string): Promise<Playlist | null> {
  const row = await database.getPlaylist(owner.userUUID, owner.profile, id);
  return row ? fromRow(row) : null;
}

async function countPlaylists(owner: Owner): Promise<number> {
  return database.countPlaylists(owner.userUUID, owner.profile);
}

export async function hasPlaylists(req: any, config: any): Promise<boolean> {
  return (await countPlaylists(ownerOf(req, config)).catch(() => 0)) > 0;
}

// One owner's edits run one after another, so two devices changing a playlist at once never overwrite each other.
const turns = new Map<string, Promise<unknown>>();

function inTurn<T>(owner: Owner, work: () => Promise<T>): Promise<T> {
  const key = `${owner.userUUID}|${owner.profile}`;
  const run = (turns.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  turns.set(key, run);
  run.finally(() => {
    if (turns.get(key) === run) turns.delete(key);
  }).catch(() => undefined);
  return run;
}

/** Applies a change to the stored playlist; null from the change leaves it as it is. */
async function changePlaylist(owner: Owner, id: string, change: (playlist: Playlist) => Partial<Pick<Playlist, 'name' | 'items'>> | null): Promise<Playlist | null> {
  return inTurn(owner, async () => {
    const playlist = await getPlaylist(owner, id);
    if (!playlist) return null;
    const patch = change(playlist);
    if (!patch) return playlist;
    const next = { ...playlist, ...patch, updatedAt: Date.now() };
    await database.savePlaylist(owner.userUUID, owner.profile, next);
    return next;
  });
}

const param = (req: any, name: string): unknown => {
  for (const source of [req.query, req.body]) {
    if (!source || typeof source !== 'object') continue;
    const key = Object.keys(source).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key !== undefined) return source[key];
  }
  return undefined;
};

/** Ids sent as an array, repeated, or as a comma list. */
function idsOf(req: any, name: string): string[] {
  const raw = param(req, name);
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return list.map((id) => String(id).trim()).filter(Boolean).map(normaliseJellyfinId);
}

function nameOf(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, NAME_LENGTH) : '';
}

function withoutRepeats(ids: string[], taken: Iterable<string> = []): string[] {
  const seen = new Set(taken);
  return ids.filter((id) => !seen.has(id) && Boolean(seen.add(id)));
}

const aired = (episode: any): boolean => !(Date.parse(String(episode?.PremiereDate ?? '')) > Date.now());

/** The titles that play, in order. As in Jellyfin, a show or a season adds its aired episodes, and a folder what its titles add. */
async function playableIds(userUUID: string, config: any, serverId: string, raw: string[]): Promise<string[]> {
  const limit = itemsPerPlaylist();
  const asked = [...new Set(raw.map(normaliseJellyfinId))].slice(0, limit);
  const width = playlistConcurrency();
  const out: string[] = [];
  // Read a few at a time, in order, and stop once a playlist could hold no more.
  for (let at = 0; at < asked.length && out.length < limit; at += width) {
    const found = await mapWithConcurrency(asked.slice(at, at + width), width, async (id: string) => {
      const descriptor = await decodeJellyfinId(id).catch(() => null);
      return descriptor ? titlesOf(userUUID, config, serverId, id, descriptor).catch(() => [] as string[]) : [];
    });
    out.push(...found.flat());
  }
  return out.slice(0, limit);
}

async function titlesOf(userUUID: string, config: any, serverId: string, id: string, descriptor: Descriptor): Promise<string[]> {
  if (descriptor.k === 'episode') return [id];
  if (descriptor.k === 'movie') {
    const meta = await fetchMeta(userUUID, 'movie', descriptor.i);
    return meta && metaToBaseItem(meta, descriptor.t, serverId, null).Type === 'Movie' ? [id] : [];
  }
  if (descriptor.k === 'series' || descriptor.k === 'season') {
    const meta = await fetchMeta(userUUID, 'series', descriptor.i);
    if (!meta) return [];
    const seriesId = encodeJellyfinId({ k: 'series', t: descriptor.t, i: descriptor.i });
    // A whole show plays its seasons in order; its specials come in only when their own season is added.
    return buildEpisodes(meta, descriptor.t, seriesId, serverId, descriptor.k === 'season' ? descriptor.s : null)
      .filter((episode: any) => aired(episode) && (descriptor.k === 'season' || Number(episode.ParentIndexNumber) > 0))
      .sort((a: any, b: any) => (Number(a.ParentIndexNumber) || 0) - (Number(b.ParentIndexNumber) || 0) || (Number(a.IndexNumber) || 0) - (Number(b.IndexNumber) || 0))
      .map((episode: any) => String(episode.Id));
  }
  if (descriptor.k === 'boxset') {
    const collection = collectionById(config, descriptor.c);
    const folder = folderById(collection, descriptor.f);
    if (!collection || !folder) return [];
    // Its films and its shows' episodes in the folder's own order, read only as far as a playlist can hold.
    const limit = itemsPerPlaylist();
    const page = await boxSetMembers(userUUID, config, serverId, collection, folder, 0, limit);
    const out: string[] = [];
    const width = playlistConcurrency();
    for (let at = 0; at < page.items.length && out.length < limit; at += width) {
      const found = await mapWithConcurrency(page.items.slice(at, at + width), width, async (member: any) => {
        if (member?.Type === 'Movie') return [String(member.Id)];
        const inner = member?.Type === 'Series' ? await decodeJellyfinId(String(member.Id)).catch(() => null) : null;
        return inner?.k === 'series' ? titlesOf(userUUID, config, serverId, String(member.Id), inner).catch(() => [] as string[]) : [];
      });
      out.push(...found.flat());
    }
    return out.slice(0, limit);
  }
  return [];
}

export function playlistsFolder(serverId: string, count: number): any {
  return {
    ...collectionFolder(PLAYLISTS_FOLDER_ID, serverId, 'Playlists', 'playlists', count),
    Type: 'ManualPlaylistsFolder',
  };
}

export interface PlaylistCover {
  /** The item whose art pictures the playlist: its first title, or that episode's show. */
  pictured: string;
  images: ItemImages | undefined;
}

// A cover changes only with the playlist's first title, so it is read once per first title, not on every listing.
const covers = new LRUCache<string, PlaylistCover>({ max: envInt('JELLYFIN_RESUME_CACHE_MAX', 500, 1) * 4, ttlAutopurge: true });
const coverTtlMs = () => envInt('JELLYFIN_PLAYLIST_COVER_TTL', 21600, 60) * 1000;

export async function playlistCover(req: any, buildItems: PlaylistRouteDeps['buildItems'], playlist: Pick<Playlist, 'items'>): Promise<PlaylistCover | null> {
  const firstId = playlist.items[0];
  if (!firstId) return null;
  const serverId = serverIdFor(String(req.params.userUUID));
  const key = `${serverId}:${firstId}`;
  const held = covers.get(key);
  if (held) return held;
  const [first] = await buildItems(req, [firstId]).catch(() => []);
  if (!first) return null;
  const pictured = first.Type === 'Episode' && first.SeriesId ? String(first.SeriesId) : String(first.Id);
  const images = (await recallImages(serverId, pictured)) ?? (await recallImages(serverId, String(first.Id)));
  const cover = { pictured, images };
  covers.set(key, cover, { ttl: coverTtlMs() });
  return cover;
}

/** A playlist, pictured by its first title, or that episode's show. */
async function playlistDto(req: any, deps: PlaylistRouteDeps, playlist: Playlist): Promise<any> {
  const serverId = serverIdFor(String(req.params.userUUID));
  const id = playlistItemId(playlist);
  const images = (await playlistCover(req, deps.buildItems, playlist))?.images;
  if (images) rememberImages(serverId, id, images);
  const primary = images?.primary ?? images?.thumb;
  const count = playlist.items.length;
  return {
    Name: playlist.name,
    ServerId: serverId,
    Id: id,
    Etag: `${id}${playlist.updatedAt}`,
    DateCreated: new Date(playlist.createdAt).toISOString(),
    DateLastMediaAdded: new Date(playlist.updatedAt).toISOString(),
    CanDelete: true,
    CanDownload: false,
    SortName: playlist.name.toLowerCase(),
    Path: `/playlists/${playlist.id}`,
    IsFolder: true,
    ParentId: PLAYLISTS_FOLDER_ID,
    Type: 'Playlist',
    MediaType: 'Video',
    ChildCount: count,
    RecursiveItemCount: count,
    DisplayPreferencesId: id,
    PrimaryImageAspectRatio: 2 / 3,
    UserData: { ...EMPTY_USER_DATA, Key: id, ItemId: id },
    ImageTags: primary ? { Primary: imageTag(primary) } : {},
    BackdropImageTags: images?.backdrop ? [imageTag(images.backdrop)] : [],
    ImageBlurHashes: {},
    LocationType: 'FileSystem',
    ProviderIds: {},
    Tags: [],
    Genres: [],
    People: [],
    Studios: [],
    GenreItems: [],
    LockedFields: [],
    LockData: false,
  };
}

/** The art a playlist item's images route serves: its first title's. */
export async function playlistImages(req: any, deps: PlaylistRouteDeps, descriptor: Descriptor): Promise<any | undefined> {
  if (descriptor.k !== 'playlist') return undefined;
  const config = await loadConfig(req);
  const playlist = config ? await getPlaylist(ownerOf(req, config), descriptor.p) : null;
  if (!playlist) return undefined;
  await playlistDto(req, deps, playlist);
  return recallImages(serverIdFor(String(req.params.userUUID)), playlistItemId(playlist));
}

function pageOf(req: any, total: number): { start: number; end: number } {
  const start = Math.max(0, parseInt(String(param(req, 'StartIndex') ?? 0), 10) || 0);
  const asked = param(req, 'Limit');
  const limit = asked === undefined ? total : Math.max(0, parseInt(String(asked), 10) || 0);
  return { start, end: start + limit };
}

/** Its entries as list rows, each with PlaylistItemId; one that no longer builds is left out. */
async function entries(req: any, deps: PlaylistRouteDeps, playlist: Playlist): Promise<any> {
  const { start, end } = pageOf(req, playlist.items.length);
  const ids = playlist.items.slice(start, end);
  const built = await deps.buildItems(req, ids);
  const byId = new Map(built.map((item) => [normaliseJellyfinId(String(item.Id)), item]));
  const items = ids.flatMap((id) => (byId.has(id) ? [{ ...byId.get(id), PlaylistItemId: id }] : []));
  return itemList(items, playlist.items.length, start);
}

function sortPlaylists(req: any, items: any[]): any[] {
  const by = String(param(req, 'SortBy') ?? '').split(',')[0].trim().toLowerCase();
  const key = by === 'sortname' || by === 'name'
    ? (item: any) => String(item.SortName)
    : by === 'datecreated'
      ? (item: any) => String(item.DateCreated)
      : by === 'datelastcontentadded'
        ? (item: any) => String(item.DateLastMediaAdded)
        : null;
  if (!key) return items;
  const sorted = [...items].sort((a, b) => key(a).localeCompare(key(b)));
  return String(param(req, 'SortOrder') ?? '').toLowerCase().startsWith('desc') ? sorted.reverse() : sorted;
}

/** The playlists, or one's entries, for an /Items listing that asks for them; false leaves the listing to the library. */
export async function answerPlaylistListing(req: any, res: any, deps: PlaylistRouteDeps, config: any): Promise<boolean> {
  const parentId = param(req, 'ParentId');
  const parent = parentId ? await decodeJellyfinId(String(parentId)).catch(() => null) : null;
  const types = String(param(req, 'IncludeItemTypes') ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  const asksForPlaylists = parent?.k === 'playlists' || (!parentId && types.length === 1 && types[0] === 'playlist' && !param(req, 'Ids') && !param(req, 'SearchTerm'));
  if (parent?.k !== 'playlist' && !asksForPlaylists) return false;
  const owner = ownerOf(req, config);

  if (parent?.k === 'playlist') {
    const playlist = await getPlaylist(owner, parent.p);
    res.json(playlist ? await entries(req, deps, playlist) : itemList([], 0, 0));
    return true;
  }

  const playlists = await listPlaylists(owner);
  const built = sortPlaylists(req, await mapWithConcurrency(playlists, playlistConcurrency(), (playlist: Playlist) => playlistDto(req, deps, playlist)));
  const { start, end } = pageOf(req, built.length);
  res.json(itemList(built.slice(start, end), built.length, start));
  return true;
}

/** The playlist folder or a playlist as a single item; null when the id is neither or it is gone. */
export async function playlistAsItem(req: any, deps: PlaylistRouteDeps, descriptor: Descriptor): Promise<any | null> {
  if (descriptor.k !== 'playlist' && descriptor.k !== 'playlists') return null;
  const config = await loadConfig(req);
  if (!config) return null;
  const owner = ownerOf(req, config);
  const serverId = serverIdFor(owner.userUUID);
  if (descriptor.k === 'playlists') return playlistsFolder(serverId, await countPlaylists(owner));
  const playlist = await getPlaylist(owner, descriptor.p);
  return playlist ? playlistDto(req, deps, playlist) : null;
}

/** Whose playlists these are: a configuration and one of its users. */
export function ownerFor(userUUID: string, config: any): Owner {
  return { userUUID, profile: profileKey(config) };
}

export { listPlaylists, getPlaylist, withoutRepeats };

/** The titles these ids would add, in order, before any already held are left out. */
export function titlesToAdd(owner: Owner, config: any, ids: string[]): Promise<string[]> {
  return playableIds(owner.userUUID, config, serverIdFor(owner.userUUID), ids);
}

export type AddOutcome = { playlist: Playlist; added: number } | 'missing' | 'full';

/** Null when the user already has as many as allowed. */
export async function createPlaylist(owner: Owner, config: any, name: string, ids: string[]): Promise<Playlist | null> {
  const items = withoutRepeats(await playableIds(owner.userUUID, config, serverIdFor(owner.userUUID), ids));
  const created = await inTurn(owner, async () => {
    if ((await countPlaylists(owner)) >= playlistsPerUser()) return null;
    const now = Date.now();
    const playlist: Playlist = { id: randomBytes(8).toString('hex'), name: nameOf(name), items, createdAt: now, updatedAt: now };
    await database.savePlaylist(owner.userUUID, owner.profile, playlist);
    return playlist;
  });
  // Its id is read back through the id table, so it is written now rather than with the next batch.
  if (created) {
    playlistItemId(created);
    await flushPendingJellyfinIds();
  }
  return created;
}

/** A rename, and with ids a new list of titles; null when the playlist is gone. */
export async function editPlaylist(owner: Owner, config: any, id: string, change: { name?: string; ids?: string[] }): Promise<Playlist | null> {
  const name = nameOf(change.name);
  const items = change.ids ? withoutRepeats(await playableIds(owner.userUUID, config, serverIdFor(owner.userUUID), change.ids)) : null;
  return changePlaylist(owner, id, () => (name || items ? { ...(name ? { name } : {}), ...(items ? { items } : {}) } : null));
}

/** Adds what is not there yet at a position, or at the end. */
export async function addTitles(owner: Owner, config: any, id: string, ids: string[], position: number | null = null): Promise<AddOutcome> {
  const added = await playableIds(owner.userUUID, config, serverIdFor(owner.userUUID), ids);
  let full = false;
  let count = 0;
  const updated = await changePlaylist(owner, id, (current) => {
    const fresh = withoutRepeats(added, current.items);
    if (!fresh.length) return null;
    if (current.items.length + fresh.length > itemsPerPlaylist()) {
      full = true;
      return null;
    }
    const at = position === null || !Number.isFinite(position) ? current.items.length : Math.min(Math.max(0, position), current.items.length);
    const items = [...current.items];
    items.splice(at, 0, ...fresh);
    count = fresh.length;
    return { items };
  });
  if (!updated) return 'missing';
  if (full) return 'full';
  return { playlist: updated, added: count };
}

export async function removeTitles(owner: Owner, id: string, entryIds: string[]): Promise<Playlist | null> {
  const removed = new Set(entryIds.map(normaliseJellyfinId));
  return changePlaylist(owner, id, (current) => {
    const items = current.items.filter((entry) => !removed.has(entry));
    return items.length === current.items.length ? null : { items };
  });
}

export async function moveTitle(owner: Owner, id: string, entryId: string, to: number): Promise<Playlist | null> {
  const entry = normaliseJellyfinId(entryId);
  return changePlaylist(owner, id, (current) => {
    const from = current.items.indexOf(entry);
    if (from < 0 || !Number.isInteger(to)) return null;
    const items = current.items.filter((held) => held !== entry);
    items.splice(Math.min(Math.max(0, to), items.length), 0, entry);
    return { items };
  });
}

export async function deletePlaylist(owner: Owner, id: string): Promise<boolean> {
  return inTurn(owner, () => database.deletePlaylist(owner.userUUID, owner.profile, id));
}

export const playlistLimits = () => ({ playlists: playlistsPerUser(), items: itemsPerPlaylist() });

export function registerPlaylistRoutes(router: any, deps: PlaylistRouteDeps): void {
  const withPlaylist = (handler: (req: any, res: any, owner: Owner, playlist: Playlist, config: any) => Promise<void>) => async (req: any, res: any) => {
    const config = await loadConfig(req);
    const descriptor = await decodeJellyfinId(String(req.params.playlistId)).catch(() => null);
    const playlist = config && descriptor?.k === 'playlist' ? await getPlaylist(ownerOf(req, config), descriptor.p) : null;
    if (!playlist) {
      res.status(404).json({ Message: 'Playlist not found' });
      return;
    }
    await handler(req, res, ownerOf(req, config), playlist, config);
  };
  const missing = (res: any) => res.status(404).json({ Message: 'Playlist not found' });

  router.post('/Playlists', async (req: any, res: any) => {
    const config = await loadConfig(req);
    if (!config) {
      res.status(401).end();
      return;
    }
    const name = nameOf(param(req, 'Name'));
    if (!name) {
      res.status(400).json({ Message: 'A playlist needs a name' });
      return;
    }
    const created = await createPlaylist(ownerOf(req, config), config, name, idsOf(req, 'Ids'));
    if (!created) {
      res.status(400).json({ Message: `You can have up to ${playlistsPerUser()} playlists` });
      return;
    }
    res.json({ Id: playlistItemId(created) });
  });

  router.get('/Playlists/:playlistId', withPlaylist(async (_req, res, _owner, playlist) => {
    res.json({ OpenAccess: false, Shares: [], ItemIds: playlist.items });
  }));

  // A rename, and with Ids a new list of titles.
  router.post('/Playlists/:playlistId', withPlaylist(async (req, res, owner, playlist, config) => {
    const updated = await editPlaylist(owner, config, playlist.id, { name: param(req, 'Name') as string | undefined, ids: param(req, 'Ids') !== undefined ? idsOf(req, 'Ids') : undefined });
    if (!updated) missing(res);
    else res.status(204).end();
  }));

  router.get('/Playlists/:playlistId/Items', withPlaylist(async (req, res, _owner, playlist) => {
    res.json(await entries(req, deps, playlist));
  }));

  router.post('/Playlists/:playlistId/Items', withPlaylist(async (req, res, owner, playlist, config) => {
    const asked = param(req, 'Position');
    const position = asked === undefined || asked === '' ? null : parseInt(String(asked), 10);
    const outcome = await addTitles(owner, config, playlist.id, idsOf(req, 'Ids'), position);
    if (outcome === 'missing') missing(res);
    else if (outcome === 'full') res.status(400).json({ Message: `A playlist holds up to ${itemsPerPlaylist()} titles` });
    else res.status(204).end();
  }));

  router.delete('/Playlists/:playlistId/Items', withPlaylist(async (req, res, owner, playlist) => {
    if (!(await removeTitles(owner, playlist.id, idsOf(req, 'EntryIds')))) missing(res);
    else res.status(204).end();
  }));

  router.post('/Playlists/:playlistId/Items/:entryId/Move/:newIndex', withPlaylist(async (req, res, owner, playlist) => {
    if (!(await moveTitle(owner, playlist.id, String(req.params.entryId), Number(req.params.newIndex)))) missing(res);
    else res.status(204).end();
  }));

  // Playlists are not shared between users here, so the owner is the only one.
  router.get('/Playlists/:playlistId/Users', withPlaylist(async (_req, res) => {
    res.json([]);
  }));
  router.get('/Playlists/:playlistId/Users/:userId', withPlaylist(async (req, res) => {
    res.json({ UserId: String(req.params.userId), CanEdit: true });
  }));
  router.post('/Playlists/:playlistId/Users/:userId', (_req: any, res: any) => {
    res.status(403).json({ Message: 'Playlists are not shared here' });
  });
  router.delete('/Playlists/:playlistId/Users/:userId', (_req: any, res: any) => {
    res.status(403).json({ Message: 'Playlists are not shared here' });
  });

  // Only playlists can be deleted; anything else goes on to the routes after.
  const removePlaylists = async (req: any, res: any, next: any, ids: string[]) => {
    const descriptors = await Promise.all(ids.map((id) => decodeJellyfinId(id).catch(() => null)));
    if (!ids.length || descriptors.some((d) => d?.k !== 'playlist')) return next();
    const config = await loadConfig(req);
    if (!config) {
      res.status(401).end();
      return;
    }
    const owner = ownerOf(req, config);
    let removed = 0;
    for (const descriptor of descriptors) {
      if (descriptor?.k === 'playlist' && (await deletePlaylist(owner, descriptor.p))) removed++;
    }
    if (removed) res.status(204).end();
    else res.status(404).json({ Message: 'Item not found' });
  };
  router.delete('/Items/:itemId', (req: any, res: any, next: any) => removePlaylists(req, res, next, [String(req.params.itemId)]));
  router.delete('/Items', (req: any, res: any, next: any) => removePlaylists(req, res, next, idsOf(req, 'Ids')));
}

/** An entry as a history file carries it: the title itself, so the file reads back on any server. */
export interface PlaylistTitle {
  kind: 'movie' | 'episode';
  type: string;
  id: string;
  season?: number | null;
  episode?: number;
}

export interface PlaylistExport {
  profile: string;
  name: string;
  items: PlaylistTitle[];
  createdAt: number;
  updatedAt: number;
}

export async function playlistsForExport(userUUID: string): Promise<PlaylistExport[]> {
  const rows: any[] = await database.listAllPlaylists(userUUID);
  return mapWithConcurrency(rows, playlistConcurrency(), async (row: any) => {
    const playlist = fromRow(row);
    const items: PlaylistTitle[] = [];
    for (const id of playlist.items) {
      const d = await decodeJellyfinId(id).catch(() => null);
      if (d?.k === 'movie') items.push({ kind: 'movie', type: d.t, id: d.i });
      else if (d?.k === 'episode') items.push({ kind: 'episode', type: d.t, id: d.i, season: d.s, episode: d.e });
    }
    return { profile: String(row.profile ?? ''), name: playlist.name, items, createdAt: playlist.createdAt, updatedAt: playlist.updatedAt };
  });
}

export function playlistTitleId(title: PlaylistTitle): string {
  return title.kind === 'movie'
    ? encodeJellyfinId({ k: 'movie', t: title.type, i: title.id })
    : encodeJellyfinId({ k: 'episode', t: title.type, i: title.id, s: title.season ?? null, e: Number(title.episode) });
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** What importing a playlist does to the ones held: a name already there takes the titles it lacks, else it is made. */
export function importOutcome(held: Array<Pick<Playlist, 'name' | 'items'>>, incoming: { name: string; items: string[] }): { kind: 'added' | 'updated' | 'unchanged' | 'full'; adds: string[] } {
  const into = held.find((playlist) => sameName(playlist.name, incoming.name));
  const room = itemsPerPlaylist() - (into?.items.length ?? 0);
  const adds = withoutRepeats(incoming.items, into?.items ?? []).slice(0, Math.max(0, room));
  if (into) return { kind: adds.length ? 'updated' : 'unchanged', adds };
  if (held.length >= playlistsPerUser()) return { kind: 'full', adds: [] };
  return { kind: 'added', adds };
}

export async function heldPlaylists(userUUID: string): Promise<Map<string, Playlist[]>> {
  const out = new Map<string, Playlist[]>();
  for (const row of await database.listAllPlaylists(userUUID)) {
    const profile = String(row.profile ?? '');
    out.set(profile, [...(out.get(profile) ?? []), fromRow(row)]);
  }
  return out;
}

/** Writes one imported playlist, deciding again against what is held by then. */
export async function importPlaylist(userUUID: string, profile: string, incoming: { name: string; items: string[]; createdAt: number }): Promise<void> {
  const owner = { userUUID, profile };
  await inTurn(owner, async () => {
    const held = await listPlaylists(owner);
    const { kind, adds } = importOutcome(held, incoming);
    if (kind === 'updated') {
      const into = held.find((playlist) => sameName(playlist.name, incoming.name))!;
      await database.savePlaylist(userUUID, profile, { ...into, items: [...into.items, ...adds], updatedAt: Date.now() });
    } else if (kind === 'added') {
      const now = Date.now();
      const playlist: Playlist = { id: randomBytes(8).toString('hex'), name: incoming.name.trim().slice(0, NAME_LENGTH), items: adds, createdAt: incoming.createdAt || now, updatedAt: now };
      await database.savePlaylist(userUUID, profile, playlist);
      playlistItemId(playlist);
      await flushPendingJellyfinIds();
    }
  });
}
