import consola from 'consola';

const logger = consola.withTag('Recommendations');

/** A day when Simkl can say whether anything moved, minutes when it cannot. The
 *  docs require gating /sync/all-items on /sync/activities. */
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
  source: 'simkl' | 'mdblist';
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

async function collectSimklRows(config: any): Promise<WatchedRow[]> {
  const { getSimklToken, fetchSimklWatchedItems }: any = require('../simklUtils');
  const token = await getSimklToken(config?.apiKeys?.simklTokenId);
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
      const items = await fetchSimklWatchedItems(accessToken, type, status);
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
async function collectMdblistRows(config: any): Promise<WatchedRow[]> {
  const apiKey = config?.apiKeys?.mdblist;
  if (!apiKey) return [];

  const { fetchWatchHistory }: any = require('../mdbList');
  const history = await fetchWatchHistory(apiKey);
  if (!history) return [];

  const rows: WatchedRow[] = [];

  for (const entry of history.movies || []) {
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
  for (const entry of history.episodes || []) {
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
export type HistorySource = 'simkl' | 'mdblist' | 'both';

/** Kept separate from "is it connected": connecting Simkl for watchlist catalogs
 *  should not enrol a viewing history into a model prompt. */
export function resolveSources(config: any): { simkl: boolean; mdblist: boolean; choice: HistorySource } {
  const hasSimkl = !!config?.apiKeys?.simklTokenId;
  const hasMdblist = !!config?.apiKeys?.mdblist;
  const choice: HistorySource = config?.recommendations?.sources || 'both';

  if (choice === 'simkl' && hasSimkl) return { simkl: true, mdblist: false, choice: 'simkl' };
  if (choice === 'mdblist' && hasMdblist) return { simkl: false, mdblist: true, choice: 'mdblist' };
  return { simkl: hasSimkl, mdblist: hasMdblist, choice: 'both' };
}

/** Changes when the Simkl lists do. `completed` per type is enough: a fingerprint
 *  folds in sibling statuses and removals, since a move bumps both ends. */
async function simklFingerprint(config: any): Promise<string> {
  try {
    const { getSimklToken, getSimklActivityFingerprint }: any = require('../simklUtils');
    const token = await getSimklToken(config?.apiKeys?.simklTokenId);
    if (!token?.access_token) return '';

    const parts = await Promise.all((['movies', 'shows', 'anime'] as const)
      .map(type => getSimklActivityFingerprint(token.access_token, type, 'completed')));
    if (!parts.some(Boolean)) return '';

    const { createHash } = require('crypto');
    return createHash('sha256').update(parts.join('|')).digest('hex').substring(0, 16);
  } catch {
    return '';
  }
}

export async function collectWatchedRows(config: any, userUUID?: string): Promise<WatchedRow[]> {
  // The profile pass and the ranking pass both need this, and so does every
  // catalog. Without a hold, one refresh is six Simkl reads and two MDBList
  // calls for a history that changes a few times a day at most.
  if (!userUUID) return readWatchedRows(config);

  const sources = resolveSources(config);

  // MDBList offers nothing equivalent, so a run that reads it keeps the clock.
  const fingerprint = sources.simkl && !sources.mdblist ? await simklFingerprint(config) : '';

  const { cacheWrapGlobal }: any = require('../../lib/getCache');
  return cacheWrapGlobal(
    `recommendations:history:${userUUID}:${sources.choice}${fingerprint ? `:${fingerprint}` : ''}`,
    () => readWatchedRows(config),
    fingerprint ? HISTORY_TTL : UNWATCHED_TTL,
    { sourceList: true }
  );
}

async function readWatchedRows(config: any): Promise<WatchedRow[]> {
  const sources = resolveSources(config);
  const [simkl, mdblist] = await Promise.all([
    sources.simkl ? collectSimklRows(config).catch(() => [] as WatchedRow[]) : Promise.resolve([] as WatchedRow[]),
    sources.mdblist ? collectMdblistRows(config).catch(() => [] as WatchedRow[]) : Promise.resolve([] as WatchedRow[]),
  ]);

  const merged = new Map<string, WatchedRow>();
  for (const row of [...mdblist, ...simkl]) {
    const existing = merged.get(row.key);
    if (!existing) { merged.set(row.key, row); continue; }
    merged.set(row.key, {
      ...existing,
      ...row,
      rating: row.rating ?? existing.rating,
      tmdbId: row.tmdbId ?? existing.tmdbId,
      watchedEpisodes: row.watchedEpisodes ?? existing.watchedEpisodes,
      totalEpisodes: row.totalEpisodes ?? existing.totalEpisodes,
    });
  }

  const rows = [...merged.values()];
  logger.debug(`Collected ${rows.length} watched titles from ${sources.choice} (simkl ${simkl.length}, mdblist ${mdblist.length})`);
  return rows;
}

module.exports = { collectWatchedRows, isWatched, resolveSources };
