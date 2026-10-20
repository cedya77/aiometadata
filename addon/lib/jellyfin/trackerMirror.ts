import consola from 'consola';
import { createHash } from 'crypto';
import { envInt } from '../../utils/envNumber';

const logger = consola.withTag('Jellyfin');
const database: any = require('../database');

export type MirrorService = 'simkl' | 'mdblist' | 'publicmetadb' | 'anilist' | 'mal';

/**
 * A tracker account, hashed. The mirror is kept per account, so configurations and
 * profiles signed in to the same one share it.
 */
export function sourceKeyFor(service: string, credential: string): string {
  return createHash('sha256').update(`${service}:${credential}`).digest('hex').substring(0, 16);
}

function credentialHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').substring(0, 16);
}

interface MirrorRow {
  key: string;
  group?: string;
  sub?: string;
  data: any;
}

interface SyncOutcome {
  changed: boolean;
  watermark: any;
  full: boolean;
}

const running = new Map<string, Promise<number>>();

/**
 * Brings a tracker account's mirror up to date from what changed since the last sync,
 * and returns its version, which moves only when something did. The first sync of an
 * account reads its whole library once.
 */
export function syncMirror(service: MirrorService, credential: string, config: any): Promise<number> {
  const key = sourceKeyFor(service, credential);
  const held = running.get(key);
  if (held) return held;
  const work = runSync(service, key, credential, config).finally(() => running.delete(key));
  running.set(key, work);
  return work;
}

/** The version a mirror was last left at, without syncing; 0 when never imported. */
export async function mirrorVersion(service: MirrorService, credential: string): Promise<number> {
  const state = await database.getTrackerSync(sourceKeyFor(service, credential));
  return Number(state?.version) || 0;
}

async function runSync(service: MirrorService, key: string, credential: string, config: any): Promise<number> {
  const state = await database.getTrackerSync(key);
  let watermark: any = null;
  try {
    watermark = state?.watermark ? JSON.parse(state.watermark) : null;
  } catch {
    watermark = null;
  }
  let version = Number(state?.version) || 0;
  // A mirror never filled starts from a full read, whatever its watermark says.
  if (!version) watermark = null;

  const started = Date.now();
  const outcome = service === 'simkl'
    ? await syncSimkl(key, credential, config, watermark)
    : service === 'mdblist'
      ? await syncMdblist(key, credential, watermark)
      : service === 'publicmetadb'
        ? await syncPmdb(key, credential, watermark)
        : await syncAnimeList(service, key, credential, watermark);

  if (outcome.changed) version += 1;
  await database.setTrackerSync(key, service, {
    watermark: JSON.stringify(outcome.watermark ?? null),
    version,
    syncedAt: Date.now(),
    fullAt: outcome.full ? Date.now() : Number(state?.full_at) || 0,
  });
  if (outcome.changed) {
    logger.debug(`${service} mirror ${key} ${outcome.full ? 'imported in full' : 'updated'} to version ${version} in ${Date.now() - started}ms`);
  }
  return version;
}

/** Puts a whole library in place: rows of the given kinds not in it any more go. */
async function replaceMirror(key: string, rows: MirrorRow[], owns: (itemKey: string) => boolean): Promise<void> {
  const keep = new Set(rows.map((row) => row.key));
  const stale = (await database.listTrackerMirrorKeys(key))
    .map((row: any) => String(row.item_key))
    .filter((itemKey: string) => owns(itemKey) && !keep.has(itemKey));
  if (stale.length) await database.deleteTrackerMirror(key, stale);
  if (rows.length) await database.upsertTrackerMirror(key, rows);
}

// --- Simkl -------------------------------------------------------------------------

const SIMKL_TYPES = ['movies', 'shows', 'anime'] as const;
// What the snapshot needs of each item: its episodes with dates, for every status, and
// the next one to watch; English titles, as the list catalogs show them.
const SIMKL_FLAGS = 'extended=full_anime_seasons&episode_watched_at=yes&include_all_episodes=yes&next_watch_info=yes&language=en';

function simklRows(type: string, entries: any[]): MirrorRow[] {
  const rows: MirrorRow[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = (entry?.movie ?? entry?.show)?.ids?.simkl;
    if (id) rows.push({ key: `${type}:${id}`, group: type, data: entry });
  }
  return rows;
}

async function syncSimkl(key: string, tokenId: string, config: any, watermark: any): Promise<SyncOutcome> {
  const { getSimklToken, fetchSimklLastActivities, makeAuthenticatedSimklRequest } = require('../../utils/simklUtils');
  const token = await getSimklToken(tokenId);
  const accessToken = token?.access_token;
  if (!accessToken) throw new Error('No Simkl token');
  // A failed call throws. An answer of null or {} is Simkl's way of saying there is nothing to list.
  const get = async (path: string) =>
    (await makeAuthenticatedSimklRequest(`https://api.simkl.com${path}`, accessToken, 'Simkl mirror'))?.data ?? {};

  const activities = await fetchSimklLastActivities(accessToken, config);
  if (!activities?.all) throw new Error('Simkl activities could not be read');

  if (!watermark?.all) {
    // Type by type, one after another, as Simkl asks of a first sync.
    const rows: MirrorRow[] = [];
    for (const type of SIMKL_TYPES) {
      const data = await get(`/sync/all-items/${type}?${SIMKL_FLAGS}`);
      rows.push(...simklRows(type, data?.[type]));
    }
    await replaceMirror(key, rows, (itemKey) => SIMKL_TYPES.some((type) => itemKey.startsWith(`${type}:`)));
    return { changed: true, watermark: activities, full: true };
  }
  if (activities.all === watermark.all) return { changed: false, watermark, full: false };

  // A changed show comes back whole, episodes and all, so an unmarked episode goes with it.
  // Empty when what moved was a rating or a removal rather than an item.
  const delta = await get(`/sync/all-items?date_from=${encodeURIComponent(watermark.all)}&${SIMKL_FLAGS}`);
  const rows = SIMKL_TYPES.flatMap((type) => simklRows(type, delta?.[type]));
  if (rows.length) await database.upsertTrackerMirror(key, rows);

  // A delta carries arrivals and changes, never departures: those are found by comparing
  // ids, and only when Simkl says something left.
  const bucket: Record<string, string> = { movies: 'movies', shows: 'tv_shows', anime: 'anime' };
  const departed = SIMKL_TYPES.some(
    (type) => (activities?.[bucket[type]]?.removed_from_list ?? null) !== (watermark?.[bucket[type]]?.removed_from_list ?? null)
  );
  if (departed) {
    const ids = await get('/sync/all-items?extended=simkl_ids_only');
    // An empty answer would clear the whole mirror; a library does not empty in one go often
    // enough to risk that on a bad read, so it is left for the next full import.
    if (SIMKL_TYPES.some((type) => Array.isArray(ids?.[type]) && ids[type].length)) {
      const present = new Set(SIMKL_TYPES.flatMap((type) => simklRows(type, ids?.[type]).map((row) => row.key)));
      const gone = (await database.listTrackerMirrorKeys(key))
        .map((row: any) => String(row.item_key))
        .filter((itemKey: string) => SIMKL_TYPES.some((type) => itemKey.startsWith(`${type}:`)) && !present.has(itemKey));
      if (gone.length) await database.deleteTrackerMirror(key, gone);
    }
  }
  return { changed: true, watermark: activities, full: false };
}

// --- MDBList ------------------------------------------------------------------------

const MDBLIST_WATCH_FIELDS = ['watched_at', 'season_watched_at', 'episode_watched_at', 'journal_at'];
const MDBLIST_MIRROR_FORMAT = 3;

function mdblistMovieRow(entry: any): MirrorRow | null {
  const id = entry?.movie?.ids?.mdblist;
  return id ? { key: `movie:${id}`, group: `movie:${id}`, data: entry } : null;
}

function mdblistEpisodeRow(entry: any): MirrorRow | null {
  const show = entry?.episode?.show?.ids?.mdblist;
  const season = entry?.episode?.season;
  const number = entry?.episode?.number;
  if (!show || season === undefined || number === undefined) return null;
  return { key: `ep:${show}:${season}:${number}`, group: `show:${show}`, sub: String(season), data: entry };
}

// A watched show, for its aired episode count.
function mdblistShowRow(entry: any): MirrorRow | null {
  const id = entry?.show?.ids?.mdblist;
  return id ? { key: `showinfo:${id}`, group: `show:${id}`, data: entry } : null;
}

function mdblistActivities(apiKey: string): Promise<any> {
  return require('../../utils/mdbList').fetchMdblistLastActivities(apiKey);
}

async function mdblistUpNextMark(apiKey: string): Promise<{ upnext_at: number; upnext_next: number | null }> {
  const { fetchMDBListUpcoming } = require('../../utils/mdbList');
  const now = Date.now();
  const airs = (await fetchMDBListUpcoming(apiKey, 90))
    .map((item: any) => Date.parse(item?.next_episode?.air_date ?? ''))
    .filter((at: number) => Number.isFinite(at) && at > now);
  return { upnext_at: now, upnext_next: airs.length ? Math.min(...airs) : null };
}

function mdblistUpNextDue(watermark: any): boolean {
  const now = Date.now();
  const next = Number(watermark?.upnext_next) || 0;
  const stale = now - (Number(watermark?.upnext_at) || 0) >= envInt('JELLYFIN_MDBLIST_UPNEXT_REFRESH_HOURS', 24, 1) * 60 * 60 * 1000;
  return stale || (next > 0 && now >= next);
}

async function mdblistFull(key: string, apiKey: string, activities: any): Promise<SyncOutcome> {
  const { fetchMdblistWatched, fetchMdblistUpNext, fetchMdblistDropped } = require('./watched');
  const movies = await fetchMdblistWatched(apiKey, 'movie');
  const episodes = await fetchMdblistWatched(apiKey, 'episode');
  const shows = await fetchMdblistWatched(apiKey, 'show');
  const upNext = await fetchMdblistUpNext(apiKey);
  const dropped = await fetchMdblistDropped(apiKey);
  const rows: MirrorRow[] = [
    ...movies.map(mdblistMovieRow).filter(Boolean),
    ...episodes.map(mdblistEpisodeRow).filter(Boolean),
    ...shows.map(mdblistShowRow).filter(Boolean),
    { key: 'upnext', data: upNext },
    { key: 'dropped', data: dropped },
  ] as MirrorRow[];
  await replaceMirror(key, rows, () => true);
  return { changed: true, watermark: { ...activities, ...(await mdblistUpNextMark(apiKey)), format: MDBLIST_MIRROR_FORMAT }, full: true };
}

async function syncMdblist(key: string, apiKey: string, watermark: any): Promise<SyncOutcome> {
  const activities = await mdblistActivities(apiKey);
  if (!activities?.server_time) throw new Error('MDBList activities could not be read');
  if (!watermark?.server_time || watermark.format !== MDBLIST_MIRROR_FORMAT) return mdblistFull(key, apiKey, activities);

  const moved = (field: string) => (activities?.[field] ?? '') !== (watermark?.[field] ?? '');
  const watched = MDBLIST_WATCH_FIELDS.some(moved);
  const dropped = moved('dropped_at');
  if (!watched && !dropped) {
    if (!mdblistUpNextDue(watermark)) return { changed: false, watermark, full: false };
    const { fetchMdblistUpNext } = require('./watched');
    const upNext = await fetchMdblistUpNext(apiKey);
    if (upNext.length) await database.upsertTrackerMirror(key, [{ key: 'upnext', data: upNext }]);
    return { changed: upNext.length > 0, watermark: { ...watermark, ...(await mdblistUpNextMark(apiKey)), format: MDBLIST_MIRROR_FORMAT }, full: false };
  }

  const { makeRateLimitedMDBListRequest } = require('../../utils/mdbList');
  if (watched) {
    // The journal holds each item's latest state, removals included; replayed from the
    // last sync, it says what left. What arrived is read whole from the history, whose
    // since filters on the watch date, so a watch dated before the last sync needs a full read.
    const removals: any[] = [];
    let backdated = false;
    let cursor = '';
    for (let page = 0; page < envInt('JELLYFIN_WATCHED_MAX_PAGES', 50, 1); page += 1) {
      const query = cursor
        ? `cursor=${encodeURIComponent(cursor)}`
        : `since=${encodeURIComponent(watermark.server_time)}`;
      const response = await makeRateLimitedMDBListRequest(`https://api.mdblist.com/sync/journal?${query}&limit=1000&apikey=${apiKey}`, apiKey, 'MDBList journal');
      const body = response?.data ?? {};
      // Past the journal's thirty days only a full read is right.
      if (body?.requires_full_sync) return mdblistFull(key, apiKey, activities);
      for (const row of Array.isArray(body?.journal) ? body.journal : []) {
        if (row?.category === 'watched' && row?.status === 'removed') removals.push(row);
        if (row?.category === 'watched' && row?.status === 'added' && row?.value_at && row.value_at < watermark.server_time) backdated = true;
      }
      cursor = body?.pagination?.next_cursor ?? '';
      if (!cursor) break;
    }
    if (backdated) return mdblistFull(key, apiKey, activities);

    // A season or show is journaled as removed when it stops being complete.
    for (const row of removals) {
      const show = row?.ids?.mdblist;
      if (!show) continue;
      if (row.item_type === 'movie') await database.deleteTrackerMirror(key, [`movie:${show}`]);
      else if (row.item_type === 'episode') await database.deleteTrackerMirror(key, [`ep:${show}:${row.season}:${row.episode}`]);
    }

    const { fetchMdblistWatched } = require('./watched');
    const movies = await fetchMdblistWatched(apiKey, 'movie', watermark.server_time);
    const episodes = await fetchMdblistWatched(apiKey, 'episode', watermark.server_time);
    const shows = await fetchMdblistWatched(apiKey, 'show', watermark.server_time);
    const rows = [...movies.map(mdblistMovieRow), ...episodes.map(mdblistEpisodeRow), ...shows.map(mdblistShowRow)].filter(Boolean) as MirrorRow[];
    if (rows.length) await database.upsertTrackerMirror(key, rows);
  }
  if (dropped) {
    const { fetchMdblistDropped } = require('./watched');
    await database.upsertTrackerMirror(key, [{ key: 'dropped', data: await fetchMdblistDropped(apiKey) }]);
  }
  // MDBList works out what is next itself and leaves dropped shows out; it moves with any watch or drop.
  const { fetchMdblistUpNext } = require('./watched');
  const upNext = await fetchMdblistUpNext(apiKey);
  if (upNext.length || watched) await database.upsertTrackerMirror(key, [{ key: 'upnext', data: upNext }]);
  const upNextMark = watched || dropped
    ? await mdblistUpNextMark(apiKey)
    : { upnext_at: watermark?.upnext_at ?? 0, upnext_next: watermark?.upnext_next ?? null };
  return { changed: true, watermark: { ...activities, ...upNextMark, format: MDBLIST_MIRROR_FORMAT }, full: false };
}

// --- PublicMetaDB -------------------------------------------------------------------
//
// PublicMetaDB has no way to ask what changed. Its history comes newest first, so new
// plays are read from the top until one already held; when the count held then differs
// from its total, a play was deleted or one was back-dated, and the history is read again.

interface PmdbHead {
  total: number;
  firstId: string;
  firstAt: string;
  droppedTotal: number;
}

function parseHead(value: string): PmdbHead {
  const [total, firstId, firstAt, droppedTotal] = String(value ?? '').split('|');
  return { total: Number(total) || 0, firstId: firstId ?? '', firstAt: firstAt ?? '', droppedTotal: Number(droppedTotal) || 0 };
}

async function pmdbHead(apiKey: string): Promise<string> {
  const { cacheWrapGlobal, classifyResultAllowEmpty } = require('../getCache');
  // The same cache the watched digest reads, which a watch recorded here clears.
  return cacheWrapGlobal(
    `pmdb_watched_head:${credentialHash(apiKey)}`,
    async () => {
      const { fetchWatched, fetchDropped } = require('../../utils/publicmetadbUtils');
      const [page, dropped] = await Promise.all([
        fetchWatched(apiKey, 1, 1),
        fetchDropped(apiKey, 1, 1).catch(() => ({ items: [], total: 0, totalPages: 0 })),
      ]);
      const first = page.items[0];
      return `${page.total}|${first?.id ?? ''}|${first?.watched_at ?? ''}|${dropped.total}`;
    },
    envInt('PMDB_ACTIVITIES_TTL', 300, 30),
    { upstream: true, resultClassifier: classifyResultAllowEmpty }
  );
}

function pmdbPlayRow(row: any): MirrorRow | null {
  return row?.id ? { key: `play:${row.id}`, group: `${row.media_type ?? ''}:${row.tmdb_id ?? ''}`, data: row } : null;
}

async function pmdbAllPlays(key: string, apiKey: string): Promise<void> {
  const { fetchWatched } = require('../../utils/publicmetadbUtils');
  const rows: MirrorRow[] = [];
  for (let page = 1; page <= envInt('JELLYFIN_WATCHED_MAX_PAGES', 50, 1); page += 1) {
    const result = await fetchWatched(apiKey, page, 500);
    rows.push(...(result.items.map(pmdbPlayRow).filter(Boolean) as MirrorRow[]));
    if (page >= result.totalPages || !result.items.length) break;
  }
  await replaceMirror(key, rows, (itemKey) => itemKey.startsWith('play:'));
}

async function syncPmdb(key: string, apiKey: string, watermark: any): Promise<SyncOutcome> {
  const headValue = await pmdbHead(apiKey);
  const head = parseHead(headValue);
  const { fetchPmdbDropped } = require('./watched');

  if (!watermark?.head) {
    await pmdbAllPlays(key, apiKey);
    await database.upsertTrackerMirror(key, [{ key: 'dropped', data: await fetchPmdbDropped(apiKey) }]);
    return { changed: true, watermark: { head: headValue }, full: true };
  }
  if (headValue === watermark.head) return { changed: false, watermark, full: false };

  const before = parseHead(watermark.head);
  let full = false;
  if (head.total !== before.total || head.firstId !== before.firstId) {
    const { fetchWatched } = require('../../utils/publicmetadbUtils');
    const fresh: MirrorRow[] = [];
    let reachedKnown = false;
    for (let page = 1; page <= envInt('JELLYFIN_WATCHED_MAX_PAGES', 50, 1) && !reachedKnown; page += 1) {
      const result = await fetchWatched(apiKey, page, 100);
      const rows = result.items.map(pmdbPlayRow).filter(Boolean) as MirrorRow[];
      const held = await database.hasTrackerMirrorKeys(key, rows.map((row) => row.key));
      for (const row of rows) {
        if (held.has(row.key)) {
          reachedKnown = true;
          break;
        }
        fresh.push(row);
      }
      if (page >= result.totalPages || !result.items.length) break;
    }
    if (fresh.length) await database.upsertTrackerMirror(key, fresh);

    const plays = (await database.listTrackerMirrorKeys(key)).filter((row: any) => String(row.item_key).startsWith('play:')).length;
    if (plays !== head.total) {
      logger.debug(`PublicMetaDB mirror ${key} holds ${plays} of ${head.total} plays; reading the history again`);
      await pmdbAllPlays(key, apiKey);
      full = true;
    }
  }
  if (head.droppedTotal !== before.droppedTotal) {
    await database.upsertTrackerMirror(key, [{ key: 'dropped', data: await fetchPmdbDropped(apiKey) }]);
  }
  return { changed: true, watermark: { head: headValue }, full };
}

// --- AniList and MyAnimeList --------------------------------------------------------

export function animeListCacheKey(service: 'anilist' | 'mal', tokenId: string): string {
  return `${service}_list:${credentialHash(tokenId)}`;
}

async function readAnimeList(service: 'anilist' | 'mal', tokenId: string): Promise<any[]> {
  const { cacheWrapGlobal, classifyResultAllowEmpty } = require('../getCache');
  return cacheWrapGlobal(
    animeListCacheKey(service, tokenId),
    async () => {
      const tracker: any = service === 'anilist' ? require('../anilistTracker') : require('../malTracker');
      const accessToken = await tracker.getAccessTokenById(tokenId);
      if (!accessToken) throw new Error(`No ${service} token`);
      return tracker.fetchAnimeList(accessToken);
    },
    envInt('JELLYFIN_ANIME_LIST_TTL', 900, 60),
    { upstream: true, resultClassifier: classifyResultAllowEmpty }
  );
}

async function syncAnimeList(service: 'anilist' | 'mal', key: string, tokenId: string, watermark: any): Promise<SyncOutcome> {
  const entries = await readAnimeList(service, tokenId);
  if (!Array.isArray(entries)) throw new Error(`${service} list could not be read`);
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex').substring(0, 32);
  if (watermark?.digest === digest) return { changed: false, watermark, full: false };
  const rows: MirrorRow[] = entries.map((entry) => ({ key: `entry:${entry.anilist ?? entry.mal}`, data: entry }));
  await replaceMirror(key, rows, (itemKey) => itemKey.startsWith('entry:'));
  return { changed: true, watermark: { digest }, full: true };
}

/** A mirror's rows, parsed, for the snapshot builders. */
export async function mirrorRows(service: MirrorService, credential: string): Promise<Array<{ key: string; data: any }>> {
  const rows = await database.listTrackerMirror(sourceKeyFor(service, credential));
  const out: Array<{ key: string; data: any }> = [];
  for (const row of rows) {
    try {
      out.push({ key: String(row.item_key), data: JSON.parse(row.data) });
    } catch {
      // A row that cannot be read is skipped rather than failing the whole library.
    }
  }
  return out;
}
