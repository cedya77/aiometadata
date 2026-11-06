import { mapWithConcurrency } from '../../utils/concurrency';
import { asProfile, playOf } from './dashboard';
import { clientRequest } from './context';
import { normaliseJellyfinId } from './idsCodec';
import { imageTag } from './imageTags';
import {
  addTitles,
  createPlaylist,
  deletePlaylist,
  editPlaylist,
  getPlaylist,
  listPlaylists,
  moveTitle,
  ownerFor,
  playlistConcurrency,
  playlistCover,
  playlistLimits,
  removeTitles,
  titlesToAdd,
  withoutRepeats,
  type Playlist,
} from './playlists';

// The dashboard's view of a user's playlists, built from the same items and rules the clients get.

const PLAYLIST_ID = /^[0-9a-f]{16}$/;
const ENTRY_PAGE = 20;

export interface DashboardEntry {
  id: string;
  kind: 'movie' | 'episode';
  title: string;
  subtitle: string | null;
  image: string | null;
  /** Landscape art for a card: an episode's still, a film's backdrop. */
  wide: string | null;
  backdropUrl: string | null;
  logoUrl: string | null;
  overview: string | null;
  year: string | null;
  score: string | null;
  genres: string[];
  /** The title page the entry opens: the film, or the episode's show. */
  open: string;
  played: boolean;
  positionMs: number;
  runtimeMs: number;
}

export const isPlaylistId = (value: unknown): value is string => typeof value === 'string' && PLAYLIST_ID.test(value);

const imageOf = (userUUID: string, id: unknown, tag: unknown, kind = 'Primary'): string | null =>
  id && tag ? `/jellyfin/${encodeURIComponent(userUUID)}/Items/${encodeURIComponent(String(id))}/Images/${kind}?tag=${encodeURIComponent(String(tag))}` : null;

function entryOf(userUUID: string, item: any): DashboardEntry {
  const episode = item.Type === 'Episode';
  const number = episode && Number.isFinite(item.IndexNumber)
    ? `${Number.isFinite(item.ParentIndexNumber) ? `S${item.ParentIndexNumber} ` : ''}E${item.IndexNumber}`
    : null;
  return {
    id: String(item.Id),
    kind: episode ? 'episode' : 'movie',
    title: episode ? String(item.SeriesName ?? item.Name ?? '') : String(item.Name ?? ''),
    subtitle: episode ? [number, item.Name].filter(Boolean).join(' ') || null : item.ProductionYear ? String(item.ProductionYear) : null,
    image: episode
      ? imageOf(userUUID, item.SeriesId, item.SeriesPrimaryImageTag) ?? imageOf(userUUID, item.Id, item.ImageTags?.Primary)
      : imageOf(userUUID, item.Id, item.ImageTags?.Primary),
    wide: episode
      ? imageOf(userUUID, item.Id, item.ImageTags?.Primary)
      : imageOf(userUUID, item.Id, Array.isArray(item.BackdropImageTags) ? item.BackdropImageTags[0] : null, 'Backdrop'),
    backdropUrl: episode
      ? imageOf(userUUID, item.ParentBackdropItemId, Array.isArray(item.ParentBackdropImageTags) ? item.ParentBackdropImageTags[0] : null, 'Backdrop')
      : imageOf(userUUID, item.Id, Array.isArray(item.BackdropImageTags) ? item.BackdropImageTags[0] : null, 'Backdrop'),
    logoUrl: episode ? imageOf(userUUID, item.ParentLogoItemId, item.ParentLogoImageTag, 'Logo') : imageOf(userUUID, item.Id, item.ImageTags?.Logo, 'Logo'),
    overview: typeof item.Overview === 'string' && item.Overview ? item.Overview : null,
    year: item.ProductionYear ? String(item.ProductionYear) : item.PremiereDate ? String(new Date(item.PremiereDate).getUTCFullYear()) : null,
    score: Number.isFinite(Number(item.CommunityRating)) && item.CommunityRating !== null && item.CommunityRating !== undefined ? Number(item.CommunityRating).toFixed(1) : null,
    genres: Array.isArray(item.Genres) ? item.Genres.map(String).slice(0, 3) : [],
    open: String(episode && item.SeriesId ? item.SeriesId : item.Id),
    ...playOf(item.UserData),
    runtimeMs: Math.round((Number(item.RunTimeTicks) || 0) / 10_000),
  };
}

const readItems = (req: any, ids: string[]): Promise<any[]> => require('./index').readItems(req, ids);

async function built(userUUID: string, profile: string | null, ids: string[]): Promise<Map<string, DashboardEntry>> {
  const items: any[] = await readItems(clientRequest(userUUID, profile || null), ids);
  return new Map(items.map((item) => [normaliseJellyfinId(String(item.Id)), entryOf(userUUID, item)]));
}

/** A playlist as the dashboard lists it, pictured as the clients picture it. */
async function summaryOf(userUUID: string, profile: string | null, playlist: Playlist) {
  const cover = await playlistCover(clientRequest(userUUID, profile || null), readItems, playlist).catch(() => null);
  const primary = cover?.images?.primary ?? cover?.images?.thumb;
  return {
    id: playlist.id,
    name: playlist.name,
    count: playlist.items.length,
    createdAt: playlist.createdAt,
    updatedAt: playlist.updatedAt,
    image: cover && primary ? imageOf(userUUID, cover.pictured, imageTag(primary)) : null,
  };
}

export function dashboardPlaylists(userUUID: string, profile: string | null) {
  return asProfile(userUUID, profile, async (config) => {
    const playlists = await listPlaylists(ownerFor(userUUID, config));
    return { playlists: await mapWithConcurrency(playlists, playlistConcurrency(), (playlist) => summaryOf(userUUID, profile, playlist)), limits: playlistLimits() };
  });
}

/** A title the playlist holds that no longer builds, kept in its place so positions line up and it can be removed. */
function unavailable(id: string): DashboardEntry {
  return { id, kind: 'movie', title: 'Not available', subtitle: 'This title could not be read', image: null, wide: null, backdropUrl: null, logoUrl: null, overview: null, year: null, score: null, genres: [], open: id, played: false, positionMs: 0, runtimeMs: 0 };
}

/** One playlist with a page of its entries, one row per position. */
export function dashboardPlaylist(userUUID: string, profile: string | null, id: string, offset = 0, limit = ENTRY_PAGE) {
  return asProfile(userUUID, profile, async (config) => {
    const playlist = await getPlaylist(ownerFor(userUUID, config), id);
    if (!playlist) return { missing: true as const };
    const ids = playlist.items.slice(offset, offset + limit);
    const entries = await built(userUUID, profile, ids);
    return {
      ...(await summaryOf(userUUID, profile, playlist)),
      offset,
      entries: ids.map((entry, i) => ({ ...(entries.get(entry) ?? unavailable(entry)), position: offset + i })),
      more: offset + limit < playlist.items.length,
      limits: playlistLimits(),
    };
  });
}

/** What adding these items would do to each playlist, before anything is written. */
export function dashboardPlaylistPreview(userUUID: string, profile: string | null, itemIds: string[]) {
  return asProfile(userUUID, profile, async (config) => {
    const owner = ownerFor(userUUID, config);
    const titles = withoutRepeats(await titlesToAdd(owner, config, itemIds));
    const playlists = await listPlaylists(owner);
    return {
      titles: titles.length,
      playlists: await mapWithConcurrency(playlists, playlistConcurrency(), async (playlist) => {
        const held = new Set(playlist.items);
        const adds = titles.filter((title) => !held.has(title)).length;
        return { id: playlist.id, name: playlist.name, count: playlist.items.length, has: titles.length - adds, adds, fits: playlist.items.length + adds <= playlistLimits().items };
      }),
    };
  });
}

export type PlaylistChange =
  | { op: 'create'; name: string; itemIds: string[] }
  | { op: 'rename'; id: string; name: string }
  | { op: 'delete'; id: string }
  | { op: 'add'; id: string; itemIds: string[]; position: number | null }
  | { op: 'remove'; id: string; itemIds: string[] }
  | { op: 'move'; id: string; itemId: string; to: number };

export type ChangeOutcome = { ok: true; id?: string; added?: number } | { ok: false; status: 400 | 404; error: string };

export function dashboardPlaylistChange(userUUID: string, profile: string | null, change: PlaylistChange) {
  return asProfile(userUUID, profile, async (config): Promise<ChangeOutcome> => {
    const owner = ownerFor(userUUID, config);
    const gone: ChangeOutcome = { ok: false, status: 404, error: 'No such playlist' };
    switch (change.op) {
      case 'create': {
        const created = await createPlaylist(owner, config, change.name, change.itemIds);
        return created ? { ok: true, id: created.id, added: created.items.length } : { ok: false, status: 400, error: `This user already has ${playlistLimits().playlists} playlists` };
      }
      case 'rename':
        return (await editPlaylist(owner, config, change.id, { name: change.name })) ? { ok: true } : gone;
      case 'delete':
        return (await deletePlaylist(owner, change.id)) ? { ok: true } : gone;
      case 'add': {
        const outcome = await addTitles(owner, config, change.id, change.itemIds, change.position);
        if (outcome === 'missing') return gone;
        if (outcome === 'full') return { ok: false, status: 400, error: `A playlist holds up to ${playlistLimits().items} titles` };
        return { ok: true, added: outcome.added };
      }
      case 'remove':
        return (await removeTitles(owner, change.id, change.itemIds)) ? { ok: true } : gone;
      case 'move':
        return (await moveTitle(owner, change.id, change.itemId, change.to)) ? { ok: true } : gone;
    }
  });
}
