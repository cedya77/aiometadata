import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { credentialFor, sourceFor } from './trackerSource';

const logger = consola.withTag('Jellyfin');
const database: any = require('../database');

const held = new LRUCache<string, Set<string>>({
  max: envInt('JELLYFIN_RESUME_CACHE_MAX', 500, 1),
  ttl: envInt('JELLYFIN_RESUME_TTL', 60, 1) * 1000,
});

const changed = new LRUCache<string, Map<string, { keys: string[]; dropped: boolean }>>({
  max: envInt('JELLYFIN_RESUME_CACHE_MAX', 500, 1),
  ttl: envInt('JELLYFIN_DROP_HOLD', 600, 10) * 1000,
});

export function forgetHeldDrops(userUUID: string): void {
  for (const key of [...held.keys()]) {
    if (key.startsWith(`${userUUID}:`)) held.delete(key);
  }
}

export function withHeldDrops(userUUID: string, config: any, dropped: Set<string>): Set<string> {
  const { profileKey } = require('./profiles');
  const key = `${userUUID}:${profileKey(config)}`;
  const shows = changed.get(key);
  if (!shows?.size) return dropped;
  const out = new Set(dropped);
  for (const [show, change] of shows) {
    if (change.keys.some((k) => dropped.has(k)) === change.dropped) {
      shows.delete(show);
      continue;
    }
    for (const k of change.keys) {
      if (change.dropped) out.add(k);
      else out.delete(k);
    }
  }
  if (!shows.size) changed.delete(key);
  return out;
}

// Simkl, MDBList and PublicMetaDB report their dropped shows back.
export function dropsKeptHere(config: any): boolean {
  const { readsTrackers } = require('./profiles');
  const source = readsTrackers(config) ? sourceFor(config) : null;
  return source !== 'simkl' && source !== 'mdblist' && source !== 'publicmetadb';
}

export async function localDrops(userUUID: string, config: any): Promise<Set<string>> {
  const { profileKey } = require('./profiles');
  const key = `${userUUID}:${profileKey(config)}`;
  const cached = held.get(key);
  if (cached) return cached;
  const rows: any[] = await database.listDropped(userUUID, profileKey(config)).catch(() => []);
  const drops = new Set(rows.map((row) => String(row.meta_id)));
  held.set(key, drops);
  return drops;
}

export async function clearLocalDrop(userUUID: string, config: any, metaId: string): Promise<boolean> {
  const { fetchMeta } = require('./items');
  const { idsFor } = require('./watchlist');
  const { profileKey } = require('./profiles');
  const meta = await fetchMeta(userUUID, 'series', metaId);
  if (!meta) return false;
  const keys = showKeys(String(meta.id), idsFor(meta, 'series'));
  const local = await localDrops(userUUID, config);
  if (!keys.some((key) => local.has(key))) return false;
  await database.setDropped(userUUID, profileKey(config), keys, false);
  held.delete(`${userUUID}:${profileKey(config)}`);
  return true;
}

function showKeys(metaId: string, ids: Record<string, any>): string[] {
  const keys = new Set<string>([metaId]);
  if (ids.imdb) keys.add(String(ids.imdb));
  if (ids.tvdb) keys.add(`tvdb:${ids.tvdb}`);
  if (ids.tmdb) keys.add(`tmdb:${ids.tmdb}`);
  if (ids.kitsu) keys.add(`kitsu:${ids.kitsu}`);
  if (ids.mal) keys.add(`mal:${ids.mal}`);
  return [...keys];
}

export function itemKeys(item: any, metaId: string): string[] {
  const ids = item?.ProviderIds ?? {};
  return showKeys(metaId, { imdb: ids.Imdb, tvdb: ids.Tvdb, tmdb: ids.Tmdb, kitsu: ids.Kitsu, mal: ids.MyAnimeList });
}

export async function writeDropped(config: any, ids: Record<string, any>, dropped: boolean, only?: string): Promise<void> {
  const showIds = { ...(ids.imdb ? { imdb: ids.imdb } : {}), ...(ids.tmdb ? { tmdb: Number(ids.tmdb) } : {}), ...(ids.tvdb ? { tvdb: Number(ids.tvdb) } : {}) };
  const verb = dropped ? 'drop' : 'undrop';

  const simklToken = credentialFor(config, 'simkl');
  if (simklToken && (!only || only === 'simkl')) {
    try {
      const { getSimklToken, makeAuthenticatedSimklRequest } = require('../../utils/simklUtils');
      const token = await getSimklToken(simklToken);
      const simklIds = { ...showIds, ...(ids.mal ? { mal: Number(ids.mal) } : {}), ...(ids.kitsu ? { kitsu: Number(ids.kitsu) } : {}) };
      // Simkl has no undrop.
      if (token?.access_token) {
        await makeAuthenticatedSimklRequest('https://api.simkl.com/sync/add-to-list', token.access_token, `Simkl ${verb}`, 'POST', { shows: [{ ids: simklIds, to: dropped ? 'dropped' : 'watching' }] });
      }
    } catch (error: any) {
      logger.warn(`Simkl ${verb} failed: ${error?.message || error}`);
    }
  }

  const mdblistKey = credentialFor(config, 'mdblist');
  if (mdblistKey && Object.keys(showIds).length && (!only || only === 'mdblist')) {
    try {
      const { makeRateLimitedMDBListPost } = require('../../utils/mdbList');
      const show = dropped ? { ids: showIds, dropped_at: new Date().toISOString() } : { ids: showIds };
      await makeRateLimitedMDBListPost(`https://api.mdblist.com/sync/dropped${dropped ? '' : '/remove'}?apikey=${mdblistKey}`, { shows: [show] }, mdblistKey, `MDBList ${verb}`);
    } catch (error: any) {
      logger.warn(`MDBList ${verb} failed: ${error?.message || error}`);
    }
  }

  const pmdbKey = credentialFor(config, 'publicmetadb');
  if (pmdbKey && ids.tmdb && (!only || only === 'publicmetadb')) {
    try {
      const { setDropped } = require('../../utils/publicmetadbUtils');
      await setDropped(pmdbKey, ids.tmdb, dropped);
    } catch (error: any) {
      logger.warn(`PublicMetaDB ${verb} failed: ${error?.message || error}`);
    }
  }
}

export function undropOnWatch(userUUID: string, config: any, seriesIds: string[]): void {
  const unique = [...new Set(seriesIds.filter(Boolean).map(String))];
  if (!unique.length) return;
  (async () => {
    const { watchedSnapshot } = require('./watched');
    const snapshot = await watchedSnapshot(userUUID, config, { patient: true });
    for (const id of unique) {
      if (snapshot.dropped.has(id)) await rateSeries(userUUID, config, { k: 'series', i: id }, true);
    }
  })().catch((error: any) => logger.debug(`Undrop on watch failed: ${error?.message || error}`));
}

// Likes false drops the show; true or a cleared rating undrops it. Reports whether it
// changed anything.
export async function rateSeries(userUUID: string, config: any, descriptor: any, likes: boolean | null): Promise<boolean> {
  if (descriptor?.k !== 'series' && descriptor?.k !== 'season' && descriptor?.k !== 'episode') return false;
  const { fetchMeta } = require('./items');
  const { idsFor } = require('./watchlist');
  const { profileKey, writesTrackers } = require('./profiles');
  const { watchedSnapshot } = require('./watched');

  const meta = await fetchMeta(userUUID, 'series', descriptor.i);
  if (!meta) return false;
  const ids = idsFor(meta, 'series');
  const keys = showKeys(String(meta.id), ids);
  const dropping = likes === false;
  if (!dropping) {
    const snapshot = await watchedSnapshot(userUUID, config, { patient: true });
    if (!keys.some((key) => snapshot.dropped.has(key))) return false;
  }

  await database.setDropped(userUUID, profileKey(config), keys, dropping);
  held.delete(`${userUUID}:${profileKey(config)}`);
  const heldKey = `${userUUID}:${profileKey(config)}`;
  const shows = changed.get(heldKey) ?? new Map();
  shows.set(String(meta.id), { keys, dropped: dropping });
  changed.set(heldKey, shows);
  if (writesTrackers(config)) {
    const { enqueueTrackerWrites } = require('../trackerOutbox');
    const services = (['simkl', 'mdblist', 'publicmetadb'] as const).filter((service) => credentialFor(config, service));
    await enqueueTrackerWrites(userUUID, config, services.map((service) => ({
      service, op: 'dropped', item: String(meta.id), coalesce: `dropped:${meta.id}`, payload: { ids, dropped: dropping },
    })));
  }
  const { invalidateResume } = require('./resume');
  invalidateResume(userUUID);
  logger.info(`${dropping ? 'Dropped' : 'Undropped'} ${meta.name || meta.id} for ${userUUID}`);
  return true;
}
