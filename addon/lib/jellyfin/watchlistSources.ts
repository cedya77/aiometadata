import consola from 'consola';
import { envInt } from '../../utils/envNumber';
import { ACCOUNT_SERVICES, credentialOf, ownTokenId, trackerConfig } from '../accounts';
import { credentialFor } from './trackerSource';

const logger = consola.withTag('Jellyfin');

export type WatchlistKind = 'movies' | 'series' | 'anime';

export interface WatchlistEntry {
  metaId: string;
  mediaType: 'movie' | 'series' | 'anime';
  /** The shelf the service files it under, which is what a pick names. */
  kind: WatchlistKind;
  addedAt: number;
  film?: boolean;
  identity?: string;
}

export type WatchlistIds = { imdb?: string; tmdb?: number | string; tvdb?: number | string; kitsu?: number | string; mal?: number | string };


export type WatchlistService = 'mdblist' | 'simkl' | 'anilist' | 'mal' | 'publicmetadb';
/** The pick that says a client's favourites are the hearts set here, and nothing else. */
export const WATCHLIST_NONE = 'none';
export const WATCHLIST_SERVER = 'server';
export const WATCHLIST_SERVICES: WatchlistService[] = ['mdblist', 'simkl', 'anilist', 'mal', 'publicmetadb'];
export const SERVICE_KINDS: Record<WatchlistService, WatchlistKind[]> = {
  mdblist: ['movies', 'series'],
  simkl: ['movies', 'series', 'anime'],
  anilist: ['anime'],
  mal: ['anime'],
  publicmetadb: ['movies', 'series'],
};

function connected(config: any, service: WatchlistService): boolean {
  if (service === 'anilist' || service === 'mal') {
    return Boolean(credentialOf(config, service)) && trackerConfig(config, service)?.[ACCOUNT_SERVICES[service].master] !== false;
  }
  // Without a list of its own, a holder would read and write your PublicMetaDB watchlist's id.
  if (service === 'publicmetadb' && config?.jellyfinAccounts && !config.jellyfinAccounts.publicmetadbWatchlist) return false;
  return Boolean(credentialFor(config, service));
}

/**
 * What the configuration's watchlist reads and writes, per service and shelf.
 * A pick is `service` for every shelf or `service:shelf`; none means every
 * connected service in full.
 */
export function watchlistPicks(config: any): Map<WatchlistService, Set<WatchlistKind>> {
  const out = new Map<WatchlistService, Set<WatchlistKind>>();
  const picked: string[] = Array.isArray(config?.jellyfinWatchlistServices) ? config.jellyfinWatchlistServices.map(String) : [];
  if (picked.includes(WATCHLIST_NONE)) return out;
  for (const service of WATCHLIST_SERVICES) {
    if (!connected(config, service)) continue;
    const kinds = new Set<WatchlistKind>();
    for (const token of picked) {
      const [name, shelf] = token.split(':');
      if (name !== service) continue;
      for (const kind of SERVICE_KINDS[service]) {
        if (!shelf || shelf === kind) kinds.add(kind);
      }
    }
    if (!picked.length) for (const kind of SERVICE_KINDS[service]) kinds.add(kind);
    if (kinds.size) out.set(service, kinds);
  }
  return out;
}

export function keepsServerWatchlist(config: any): boolean {
  const picked: string[] = Array.isArray(config?.jellyfinWatchlistServices) ? config.jellyfinWatchlistServices.map(String) : [];
  return picked.includes(WATCHLIST_NONE) || picked.includes(WATCHLIST_SERVER);
}

export function watchlistServices(config: any): WatchlistService[] {
  return [...watchlistPicks(config).keys()];
}

const SHELF_CATALOGS: Record<WatchlistService, Partial<Record<WatchlistKind, { type: string; id: string }>>> = {
  mdblist: { movies: { type: 'movie', id: 'mdblist.watchlist.movies' }, series: { type: 'series', id: 'mdblist.watchlist.series' } },
  simkl: {
    movies: { type: 'movie', id: 'simkl.watchlist.movies.plantowatch' },
    series: { type: 'series', id: 'simkl.watchlist.shows.plantowatch' },
    anime: { type: 'anime', id: 'simkl.watchlist.anime.plantowatch' },
  },
  anilist: { anime: { type: 'anime', id: 'anilist.Planning' } },
  mal: { anime: { type: 'anime', id: 'mal.userlist.plan_to_watch' } },
  publicmetadb: {},
};

interface Shelf {
  type: string;
  id: string;
  keep?: (meta: any) => boolean;
  kind?: WatchlistKind;
}

async function shelfCatalog(config: any, service: WatchlistService, kind: WatchlistKind): Promise<{ type: string; id: string; keep?: (meta: any) => boolean } | null> {
  if (service !== 'publicmetadb') return SHELF_CATALOGS[service][kind] ?? null;
  const { publicMetaDBWatchlistCatalog } = require('../../utils/publicmetadbUtils');
  const catalog = await publicMetaDBWatchlistCatalog(config);
  if (!catalog) return null;
  const wanted = kind === 'movies' ? 'movie' : 'series';
  return { type: catalog.type, id: catalog.id, keep: (meta: any) => meta?.type === wanted };
}

function mdblistSplitOnly(config: any): boolean {
  const ids = new Set((config?.catalogs ?? []).map((c: any) => c?.id));
  return !ids.has('mdblist.watchlist') && (ids.has('mdblist.watchlist.movies') || ids.has('mdblist.watchlist.series'));
}

async function shelvesFor(config: any, service: WatchlistService, kinds: Set<WatchlistKind>): Promise<Shelf[]> {
  if (service === 'mdblist' && kinds.has('movies') && kinds.has('series') && !mdblistSplitOnly(config)) {
    return [{ type: 'all', id: 'mdblist.watchlist' }];
  }
  const shelves: Shelf[] = [];
  for (const kind of kinds) {
    const catalog = await shelfCatalog(config, service, kind);
    if (catalog) shelves.push({ ...catalog, kind });
  }
  return shelves;
}

async function pickedShelves(config: any): Promise<Shelf[]> {
  const shelves: Shelf[] = [];
  for (const [service, kinds] of watchlistPicks(config)) shelves.push(...(await shelvesFor(config, service, kinds)));
  return shelves;
}

export async function shelfCacheWindowMs(config: any): Promise<number> {
  const { getSetting } = require('../settingsService');
  const fallback = Number(getSetting('CATALOG_TTL')) || 24 * 60 * 60;
  let longest = 0;
  for (const shelf of await pickedShelves(config)) {
    const own = (config?.catalogs ?? []).find((c: any) => c?.id === shelf.id)?.cacheTTL;
    const ttl = Number.isFinite(own) && own >= 0 ? own : fallback;
    longest = Math.max(longest, ttl);
  }
  const hold = Number(getSetting('JELLYFIN_WATCHLIST_HOLD')) || 600;
  return Math.max(longest, hold) * 1000;
}

async function shelfEntries(userUUID: string, config: any, catalog: Shelf, need: number): Promise<{ rows: WatchlistEntry[]; ok: boolean; exhausted: boolean }> {
  const { fetchWindow } = require('./items');
  const { profileTags } = require('./profiles');
  const max = Math.min(envInt('JELLYFIN_WATCHLIST_MAX_ITEMS', 5000, 100), Math.max(1, need));
  try {
    const window = await fetchWindow(userUUID, { id: catalog.id, type: catalog.type, name: catalog.id, pageSize: 0, extra: [] }, 0, max, {}, catalog.keep, profileTags(config));
    const rows: WatchlistEntry[] = [];
    window.items.forEach((meta: any, rank: number) => {
      if (!meta?.id) return;
      const kind: WatchlistKind = catalog.kind ?? (meta.type === 'movie' ? 'movies' : 'series');
      const mediaType: WatchlistEntry['mediaType'] = kind === 'anime' ? 'anime' : meta.type === 'movie' ? 'movie' : 'series';
      rows.push({ metaId: String(meta.id), mediaType, kind, addedAt: Date.parse(meta._listedAt ?? '') || -rank, ...(kind === 'anime' && meta.type === 'movie' ? { film: true } : {}) });
    });
    return { rows, ok: !window.failed, exhausted: !window.hasMore };
  } catch (error: any) {
    logger.warn(`Watchlist ${catalog.id} failed: ${error?.message || error}`);
    return { rows: [], ok: false, exhausted: false };
  }
}

export interface TrackerWatchlist {
  rows: WatchlistEntry[];
  complete: boolean;
  /** Every shelf ended inside the window, so the rows are the whole watchlist. */
  exhausted: boolean;
}

export function perEntryAnime(config: any): boolean {
  return ['kitsu', 'mal'].includes(config?.providers?.anime || 'mal');
}

export function watchlistSlot(identity: { key: string; anime: boolean }, metaId: string, config: any): string {
  return perEntryAnime(config) && identity.anime ? `${identity.key}#${metaId}` : identity.key;
}

/**
 * One entry per title across sources. Where an anime entry and a whole show meet, the anime
 * meta provider decides: a grouped one (TVDB, TMDB, IMDb) keeps the show, Kitsu or MAL keeps
 * the per-entry anime ids.
 */
export async function dedupeWatchlist(rows: WatchlistEntry[], config: any): Promise<WatchlistEntry[]> {
  const { watchlistIdentity } = require('./canonicalIds');
  const { mapWithConcurrency } = require('../../utils/concurrency');
  const perEntry = perEntryAnime(config);
  const named: Array<{ row: WatchlistEntry; key: string; anime: boolean }> = await mapWithConcurrency(rows, 8, async (row: WatchlistEntry) => {
    const identity = await watchlistIdentity(row.metaId, row.mediaType, config).catch(() => ({ key: row.metaId, anime: false }));
    return { row, ...identity };
  });
  const animeShows = new Set(named.filter((entry) => entry.anime).map((entry) => entry.key));
  const kept = new Map<string, { row: WatchlistEntry; anime: boolean }>();
  for (const { row, key, anime } of named) {
    if (perEntry && !anime && animeShows.has(key)) continue;
    const slot = watchlistSlot({ key, anime }, row.metaId, config);
    const held = kept.get(slot);
    const addedAt = Math.max(row.addedAt, held?.row.addedAt ?? -Infinity);
    if (!held || (held.anime && !anime) || (held.anime === anime && row.addedAt > held.row.addedAt)) {
      kept.set(slot, { row: { ...row, addedAt, identity: slot }, anime });
    } else {
      held.row = { ...held.row, addedAt };
    }
  }
  return [...kept.values()].map((entry) => entry.row);
}

export async function trackerWatchlist(config: any, userUUID: string, need = Number.MAX_SAFE_INTEGER): Promise<TrackerWatchlist> {
  const shelves = await pickedShelves(config);
  const parts = await Promise.all(shelves.map((shelf) => shelfEntries(userUUID, config, shelf, need)));
  const merged = new Map<string, WatchlistEntry>();
  for (const row of parts.flatMap((part) => part.rows)) {
    const held = merged.get(row.metaId);
    if (!held || row.addedAt > held.addedAt) merged.set(row.metaId, row);
  }
  return {
    rows: (await dedupeWatchlist([...merged.values()], config)).sort((a, b) => b.addedAt - a.addedAt),
    complete: parts.every((part) => part.ok),
    exhausted: parts.every((part) => part.exhausted),
  };
}

export async function writeWatchlist(config: any, userUUID: string, ids: WatchlistIds, kind: 'movie' | 'show', listed: boolean, only?: string): Promise<void> {
  const { shouldTrackServiceMediaType } = require('../watchTracking');
  const mediaType = kind === 'movie' ? 'movie' : 'series';
  const body = kind === 'movie' ? { movies: [{ ids }] } : { shows: [{ ids }] };
  const picks = watchlistPicks(config);
  const anime = Boolean(ids.kitsu || ids.mal);
  const shelf: WatchlistKind = kind === 'movie' ? 'movies' : 'series';
  // MDBList files anime with films and shows; Simkl, AniList and MAL keep it apart.
  const takes = (service: WatchlistService, own: WatchlistKind) => (!only || only === service) && (picks.get(service)?.has(own) ?? false);

  if (takes('mdblist', shelf) && shouldTrackServiceMediaType(config, 'mdblist', mediaType) && config?.apiKeys?.mdblist) {
    try {
      const { makeRateLimitedMDBListPost } = require('../../utils/mdbList');
      await makeRateLimitedMDBListPost(`https://api.mdblist.com/watchlist/items/${listed ? 'add' : 'remove'}?apikey=${config.apiKeys.mdblist}`, body, config.apiKeys.mdblist, `MDBList watchlist ${listed ? 'add' : 'remove'}`);
    } catch (error: any) {
      logger.warn(`MDBList watchlist ${listed ? 'add' : 'remove'} failed: ${error?.message || error}`);
    }
  }

  if (takes('simkl', anime ? 'anime' : shelf) && shouldTrackServiceMediaType(config, 'simkl', mediaType) && config?.apiKeys?.simklTokenId) {
    try {
      const { getSimklToken, makeAuthenticatedSimklRequest } = require('../../utils/simklUtils');
      const token = await getSimklToken(config.apiKeys.simklTokenId);
      if (token?.access_token) {
        if (listed) {
          const planned = kind === 'movie' ? { movies: [{ ids, to: 'plantowatch' }] } : { shows: [{ ids, to: 'plantowatch' }] };
          await makeAuthenticatedSimklRequest('https://api.simkl.com/sync/add-to-list', token.access_token, 'Simkl watchlist add', 'POST', planned);
        } else {
          // Simkl's removal drops the whole entry, history included, so only a title still
          // planned is removed; the planned shelf alone is read, not the library.
          // An anime film is filed with anime, never with movies.
          const types = kind === 'movie' ? (anime ? ['movies', 'anime'] : ['movies']) : ['shows', 'anime'];
          const shelves = await Promise.all(types.map((type) =>
            makeAuthenticatedSimklRequest(`https://api.simkl.com/sync/all-items/${type}/plantowatch?extended=ids_only`, token.access_token, 'Simkl watchlist check').then((response: any) => response?.data?.[type] ?? [])
          ));
          const planned = shelves.flat().some((entry: any) => matches(entry?.movie?.ids ?? entry?.show?.ids ?? {}, ids));
          if (planned) await makeAuthenticatedSimklRequest('https://api.simkl.com/sync/history/remove', token.access_token, 'Simkl watchlist remove', 'POST', body);
        }
      }
    } catch (error: any) {
      logger.warn(`Simkl watchlist ${listed ? 'add' : 'remove'} failed: ${error?.message || error}`);
    }
  }

  if (takes('publicmetadb', shelf) && shouldTrackServiceMediaType(config, 'publicmetadb', mediaType) && config?.apiKeys?.publicmetadb && ids.tmdb) {
    try {
      const { publicMetaDBWatchlistCatalog, publicMetaDBListId, setListItem } = require('../../utils/publicmetadbUtils');
      const catalog = await publicMetaDBWatchlistCatalog(config);
      const listId = catalog ? await publicMetaDBListId(config, catalog.id) : null;
      if (listId) await setListItem(config.apiKeys.publicmetadb, listId, ids.tmdb, kind === 'movie' ? 'movie' : 'tv', listed);
    } catch (error: any) {
      logger.warn(`PublicMetaDB watchlist ${listed ? 'add' : 'remove'} failed: ${error?.message || error}`);
    }
  }

  if (takes('anilist', 'anime') && ids.kitsu) {
    try {
      const anilist = require('../anilistTracker');
      const idMapper: any = require('../id-mapper');
      const accessToken = await anilist.getValidAccessToken(userUUID, ownTokenId(config, 'anilist'));
      const anilistId = idMapper.getMappingByKitsuId(Number(ids.kitsu))?.anilist_id;
      if (accessToken && anilistId) await anilist.setPlanning(anilistId, listed, accessToken);
    } catch (error: any) {
      logger.warn(`AniList watchlist ${listed ? 'add' : 'remove'} failed: ${error?.message || error}`);
    }
  }

  if (takes('mal', 'anime') && ids.mal) {
    try {
      const mal = require('../malTracker');
      const accessToken = await mal.getValidAccessToken(userUUID, ownTokenId(config, 'mal'));
      if (accessToken) await mal.setPlanToWatch(Number(ids.mal), listed, accessToken);
    } catch (error: any) {
      logger.warn(`MAL watchlist ${listed ? 'add' : 'remove'} failed: ${error?.message || error}`);
    }
  }

}

function matches(have: Record<string, any>, want: WatchlistIds): boolean {
  return Object.entries(want).some(([key, value]) => value != null && have[key] != null && String(have[key]) === String(value));
}
