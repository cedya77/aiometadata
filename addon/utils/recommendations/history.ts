import consola from 'consola';

const logger = consola.withTag('Recommendations');

/** A day when the watch mirrors can say whether anything moved, minutes when a sync failed. */
const HISTORY_TTL = parseInt(process.env.RECOMMENDATION_HISTORY_TTL || String(24 * 60 * 60), 10);

/** Without a change signal, freshness has to come from the clock. */
const UNWATCHED_TTL = parseInt(process.env.RECOMMENDATION_HISTORY_BLIND_TTL || '900', 10);

export type WatchedKind = 'movie' | 'series' | 'anime';

type SimklStatus = 'completed' | 'watching' | 'hold' | 'dropped' | 'plantowatch';

/**
 * Something on the plan-to-watch list has not been seen, so it says nothing about
 * taste — but recommending it back is a wasted slot, so it still counts as
 * something to leave out.
 */
export function isWatched(row: WatchedRow): boolean {
  return row.status !== 'plantowatch';
}

/** One watched title, flattened across services. Shallow on purpose: everything
 *  here arrives with the history payload. */
export interface WatchedRow {
  /** imdb id where known, else `<source>:<id>`. Used to dedupe across services. */
  key: string;
  imdbId?: string;
  /** Carried by both sources, and what genres and credits are looked up with. */
  tmdbId?: number;
  title: string;
  year?: number;
  kind: WatchedKind;
  /** The user's own score, 1-10. The strongest signal we get, and often absent. */
  rating?: number;
  /** ISO timestamp of the most recent watch, for recency weighting. */
  watchedAt?: string;
  runtime?: number;
  watchedEpisodes?: number;
  totalEpisodes?: number;
  /** 'completed' or 'dropped'. A drop is a negative signal worth as much as a low score. */
  status: string;
  source: 'simkl' | 'mdblist' | 'local';
}

function toYear(value: any): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 1870 ? parsed : undefined;
}

function toRating(value: any): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Simkl returns the show under `show` and a film under `movie`, in the same
 * array shape, so which one is populated is what tells them apart.
 */
function toTmdbId(value: any): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function rowFromSimkl(entry: any, kind: WatchedKind, status: string): WatchedRow | null {
  const media = entry?.show || entry?.movie;
  const title = String(media?.title || '').trim();
  if (!title) return null;

  const ids = media?.ids || {};
  const imdbId = typeof ids.imdb === 'string' && ids.imdb ? ids.imdb : undefined;
  const fallback = ids.simkl ?? ids.tmdb ?? ids.mal ?? title;

  return {
    key: imdbId || `simkl:${fallback}`,
    imdbId,
    tmdbId: toTmdbId(ids.tmdb),
    title,
    year: toYear(media?.year),
    kind,
    rating: toRating(entry?.user_rating),
    watchedAt: entry?.last_watched_at || undefined,
    runtime: toYear(media?.runtime) ? Number(media.runtime) : undefined,
    watchedEpisodes: Number.isFinite(entry?.watched_episodes_count) ? entry.watched_episodes_count : undefined,
    totalEpisodes: Number.isFinite(entry?.total_episodes_count) ? entry.total_episodes_count : undefined,
    status: String(entry?.status || status),
    source: 'simkl',
  };
}

async function collectSimklRows(config: any, tokenId: string): Promise<WatchedRow[]> {
  const { getSimklToken, fetchSimklWatchlistItems }: any = require('../simklUtils');
  const token = await getSimklToken(tokenId);
  const accessToken = token?.access_token;
  if (!accessToken) return [];

  // Simkl only moves a show to `completed` if the user says so, so a finished,
  // highly rated series usually sits in `watching` forever. Reading only
  // `completed` missed the large majority of this library's television.
  // Films have no `watching` or `hold` bucket.
  const wanted: Array<[('movies' | 'shows' | 'anime'), WatchedKind, SimklStatus]> = [
    ['movies', 'movie', 'completed'],
    ['movies', 'movie', 'dropped'],
    ['movies', 'movie', 'plantowatch'],
    ['shows', 'series', 'completed'],
    ['shows', 'series', 'watching'],
    ['shows', 'series', 'hold'],
    ['shows', 'series', 'dropped'],
    ['shows', 'series', 'plantowatch'],
    ['anime', 'anime', 'completed'],
    ['anime', 'anime', 'watching'],
    ['anime', 'anime', 'hold'],
    ['anime', 'anime', 'dropped'],
    ['anime', 'anime', 'plantowatch'],
  ];

  const batches = await Promise.all(wanted.map(async ([type, kind, status]) => {
    try {
      // Every status comes from the one watch mirror, so this is one sync, not a call per list.
      const { items } = await fetchSimklWatchlistItems(accessToken, type, status, undefined, config);
      return (items || []).map((entry: any) => rowFromSimkl(entry, kind, status)).filter(Boolean) as WatchedRow[];
    } catch (error: any) {
      logger.debug(`Simkl ${type}/${status} unavailable: ${error.message}`);
      return [];
    }
  }));

  return batches.flat();
}

/**
 * MDBList reports one row per watched episode, so a season of television arrives
 * as forty entries for a single title. They are folded back into one row per
 * show, counting episodes as the engagement signal Simkl gives us outright.
 */
async function collectMdblistRows(config: any, apiKey: string): Promise<WatchedRow[]> {
  if (!apiKey) return [];

  // The watch mirror holds the key's history and fetches only what changed since its last
  // sync, so a profile build no longer reads the whole history.
  const { syncMirror, mirrorVersion, mirrorRows }: any = require('../../lib/jellyfin/trackerMirror');
  try {
    await syncMirror('mdblist', apiKey, config);
  } catch (error: any) {
    if (!(await mirrorVersion('mdblist', apiKey))) {
      logger.debug(`MDBList history unavailable: ${error?.message || error}`);
      return [];
    }
  }
  const newestFirst = (a: any, b: any) => (Date.parse(b?.last_watched_at ?? '') || 0) - (Date.parse(a?.last_watched_at ?? '') || 0);
  const history = { movies: [] as any[], episodes: [] as any[] };
  for (const row of await mirrorRows('mdblist', apiKey)) {
    if (row.key.startsWith('movie:')) history.movies.push(row.data);
    else if (row.key.startsWith('ep:')) history.episodes.push(row.data);
  }
  history.movies.sort(newestFirst);
  history.episodes.sort(newestFirst);

  const rows: WatchedRow[] = [];

  for (const entry of history.movies) {
    const movie = entry?.movie;
    const title = String(movie?.title || '').trim();
    if (!title) continue;
    const imdbId = movie?.ids?.imdb;
    rows.push({
      key: imdbId || `mdblist:${movie?.ids?.tmdb ?? title}`,
      imdbId,
      tmdbId: toTmdbId(movie?.ids?.tmdb),
      title,
      year: toYear(movie?.year),
      kind: 'movie',
      watchedAt: entry?.last_watched_at || undefined,
      status: 'completed',
      source: 'mdblist',
    });
  }

  const shows = new Map<string, WatchedRow>();
  for (const entry of history.episodes) {
    const show = entry?.episode?.show;
    const title = String(show?.title || '').trim();
    if (!title) continue;
    const imdbId = show?.ids?.imdb;
    const key = imdbId || `mdblist:${show?.ids?.tmdb ?? title}`;
    const existing = shows.get(key);
    const watchedAt = entry?.last_watched_at;

    if (!existing) {
      shows.set(key, {
        key,
        imdbId,
        tmdbId: toTmdbId(show?.ids?.tmdb),
        title,
        year: toYear(show?.year),
        kind: 'series',
        watchedAt: watchedAt || undefined,
        watchedEpisodes: 1,
        status: 'completed',
        source: 'mdblist',
      });
      continue;
    }
    existing.watchedEpisodes = (existing.watchedEpisodes || 0) + 1;
    if (watchedAt && (!existing.watchedAt || watchedAt > existing.watchedAt)) {
      existing.watchedAt = watchedAt;
    }
  }

  return [...rows, ...shows.values()];
}

/** A title can come from both services; the richer row wins, in practice Simkl,
 *  the only one reporting a user rating. */
export type HistorySource = 'simkl' | 'mdblist' | 'both' | 'local';

export interface Viewer {
  key: string;
  profile: string;
  trackers: boolean;
}

export function viewerOf(config: any, userUUID: string): Viewer {
  const { viewerProfile }: any = require('../../lib/jellyfin/viewer');
  const { accountOwner }: any = require('../../lib/accounts');
  const owner = accountOwner(config);
  const profile = viewerProfile() || owner;
  return { key: profile ? `${userUUID}#${profile}` : userUUID, profile, trackers: !profile || owner === profile };
}

export function viewerKey(config: any, userUUID: string): string {
  return viewerOf(config, userUUID).key;
}

function trackerKeys(config: any): { simkl?: string; mdblist?: string } {
  if (!viewerOf(config, '').trackers) return {};
  const { credentialOf }: any = require('../../lib/accounts');
  return { simkl: credentialOf(config, 'simkl'), mdblist: credentialOf(config, 'mdblist') };
}

export function trackerAvailability(config: any): { simkl: boolean; mdblist: boolean } {
  const keys = trackerKeys(config);
  return { simkl: !!keys.simkl, mdblist: !!keys.mdblist };
}

export function runAsProfile<T>(config: any, userUUID: string, profileId: string | null | undefined, fn: (viewerConfig: any) => T): T {
  const { runInViewerScope, noteProfile }: any = require('../../lib/jellyfin/viewer');
  const { listProfiles, profileKey, scopeConfigToProfile }: any = require('../../lib/jellyfin/profiles');
  const { withAccountOwner }: any = require('../../lib/accounts');
  const id = profileId && listProfiles(config, userUUID).some((profile: any) => profile.id === profileId) ? profileId : null;
  const key = id ? profileKey(scopeConfigToProfile(config, userUUID, id)) : '';
  const viewerConfig = id ? withAccountOwner(config, id) : config;
  return runInViewerScope(false, () => {
    noteProfile(key);
    return fn(viewerConfig);
  });
}

export function canReadHistory(config: any): boolean {
  if (config?.apiKeys?.simklTokenId || config?.apiKeys?.mdblist) return true;
  const { getSetting }: any = require('../../lib/settingsService');
  return String(getSetting('JELLYFIN_API_ENABLED') || '').trim().toLowerCase() === 'true';
}

type Sources = { simkl: boolean; mdblist: boolean; local: boolean; choice: HistorySource | 'all' };

/** Kept separate from "is it connected": connecting Simkl for watchlist catalogs
 *  should not enrol a viewing history into a model prompt. */
export function resolveSources(config: any, everything = false): Sources {
  const keys = trackerKeys(config);
  const hasSimkl = !!keys.simkl;
  const hasMdblist = !!keys.mdblist;
  if (everything) return { simkl: hasSimkl, mdblist: hasMdblist, local: true, choice: 'all' };
  const { profile } = viewerOf(config, '');
  const own = profile ? config?.recommendations?.profiles?.[profile]?.sources : undefined;
  const choice: HistorySource = (own && own !== 'same' ? own : config?.recommendations?.sources) || 'both';

  if (choice === 'simkl' && hasSimkl) return { simkl: true, mdblist: false, local: false, choice: 'simkl' };
  if (choice === 'mdblist' && hasMdblist) return { simkl: false, mdblist: true, local: false, choice: 'mdblist' };
  if (choice === 'local') return { simkl: false, mdblist: false, local: true, choice: 'local' };
  return { simkl: hasSimkl, mdblist: hasMdblist, local: true, choice: 'both' };
}

/**
 * Changes when any history does: the watch mirrors' versions, which move only when
 * a sync found something new, and the local play state. Empty when a sync failed,
 * so the clock takes over.
 */
async function historyFingerprint(config: any, userUUID: string, sources: { simkl: boolean; mdblist: boolean; local: boolean }): Promise<string> {
  const { syncMirror }: any = require('../../lib/jellyfin/trackerMirror');
  const { localPlayVersion }: any = require('./localHistory');
  const keys = trackerKeys(config);
  try {
    const parts: string[] = [];
    if (sources.simkl) parts.push(`s${await syncMirror('simkl', keys.simkl, config)}`);
    if (sources.mdblist) parts.push(`m${await syncMirror('mdblist', keys.mdblist, config)}`);
    if (sources.local) parts.push(`l${await localPlayVersion(userUUID, viewerOf(config, userUUID).profile)}`);
    return parts.join('.');
  } catch {
    return '';
  }
}

export async function collectWatchedRows(config: any, userUUID?: string, options: { everything?: boolean } = {}): Promise<WatchedRow[]> {
  // The profile pass and the ranking pass both need this, and so does every
  // catalog, so it is held until one of the histories changes.
  const everything = options.everything === true;
  if (!userUUID) return readWatchedRows(config, undefined, everything);

  const sources = resolveSources(config, everything);
  const fingerprint = await historyFingerprint(config, userUUID, sources);

  const { cacheWrapGlobal }: any = require('../../lib/getCache');
  return cacheWrapGlobal(
    `recommendations:history:v2:${viewerKey(config, userUUID)}:${sources.choice}${fingerprint ? `:${fingerprint}` : ''}`,
    () => readWatchedRows(config, userUUID, everything),
    fingerprint ? HISTORY_TTL : UNWATCHED_TTL,
    { sourceList: true }
  );
}

async function readWatchedRows(config: any, userUUID?: string, everything = false): Promise<WatchedRow[]> {
  const sources = resolveSources(config, everything);
  const keys = trackerKeys(config);
  const { collectLocalRows }: any = require('./localHistory');
  const [simkl, mdblist, local] = await Promise.all([
    sources.simkl ? collectSimklRows(config, keys.simkl!).catch(() => [] as WatchedRow[]) : Promise.resolve([] as WatchedRow[]),
    sources.mdblist ? collectMdblistRows(config, keys.mdblist!).catch(() => [] as WatchedRow[]) : Promise.resolve([] as WatchedRow[]),
    sources.local && userUUID
      ? collectLocalRows(config, userUUID, viewerOf(config, userUUID).profile, everything ? Infinity : undefined).catch(() => [] as WatchedRow[])
      : Promise.resolve([] as WatchedRow[]),
  ]);

  const merged = new Map<string, WatchedRow>();
  for (const row of [...local, ...mdblist, ...simkl]) {
    const existing = merged.get(row.key);
    if (!existing) { merged.set(row.key, row); continue; }
    if (!isWatched(row) && isWatched(existing)) {
      merged.set(row.key, { ...existing, imdbId: existing.imdbId ?? row.imdbId, tmdbId: existing.tmdbId ?? row.tmdbId });
      continue;
    }
    const newest = isWatched(existing) && String(existing.watchedAt || '') > String(row.watchedAt || '') ? existing.watchedAt : row.watchedAt;
    merged.set(row.key, {
      ...existing,
      ...row,
      watchedAt: newest,
      rating: row.rating ?? existing.rating,
      tmdbId: row.tmdbId ?? existing.tmdbId,
      watchedEpisodes: row.watchedEpisodes ?? existing.watchedEpisodes,
      totalEpisodes: row.totalEpisodes ?? existing.totalEpisodes,
    });
  }

  const rows = [...merged.values()];
  logger.debug(`Collected ${rows.length} watched titles from ${sources.choice} (simkl ${simkl.length}, mdblist ${mdblist.length}, local ${local.length})`);
  return rows;
}

export function titleKeys(entry: { kind: string; tmdbId?: number; imdbId?: string; title?: string; year?: number }): string[] {
  const keys: string[] = [];
  if (entry.tmdbId) {
    if (entry.kind !== 'series') keys.push(`movie:${entry.tmdbId}`);
    if (entry.kind !== 'movie') keys.push(`tv:${entry.tmdbId}`);
  }
  if (entry.imdbId) keys.push(`imdb:${entry.imdbId}`);
  if (entry.title) keys.push(`title:${entry.title.toLowerCase()}|${entry.year || ''}`);
  return keys;
}

export async function watchedIndex(config: any, userUUID: string): Promise<{ rows: WatchedRow[]; keys: Set<string> }> {
  const rows = await collectWatchedRows(config, userUUID, { everything: true });
  const keys = new Set<string>();
  for (const row of rows) for (const key of titleKeys(row)) keys.add(key);
  return { rows, keys };
}

module.exports = { collectWatchedRows, isWatched, resolveSources, viewerKey, viewerOf, trackerAvailability, runAsProfile, canReadHistory, titleKeys, watchedIndex };
