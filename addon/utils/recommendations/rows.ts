import type { WatchedRow } from './history';
import type { FactMap } from './enrich';

/**
 * How a title left unfinished should be read.
 *
 * Stalling is the weakest evidence in a history: people stop because they lost
 * interest, but also because a season ended, or they simply forgot. So how much
 * it counts is the viewer's call, not ours.
 */
export type StalledWeight = 'ignore' | 'note' | 'mild' | 'dislike';

export interface Tuning {
  /** Days without an episode before an unfinished title is read as put down. */
  staleDays: number;
  stalledWeight: StalledWeight;
}

export const DEFAULT_TUNING: Tuning = { staleDays: 180, stalledWeight: 'note' };

export function tuningFrom(config: any): Tuning {
  const settings = config?.recommendations || {};
  const weights: StalledWeight[] = ['ignore', 'note', 'mild', 'dislike'];
  const days = Number(settings.stale_after_days);
  return {
    staleDays: Number.isFinite(days) && days >= 7 ? days : DEFAULT_TUNING.staleDays,
    stalledWeight: weights.includes(settings.stalled_weight)
      ? settings.stalled_weight
      : DEFAULT_TUNING.stalledWeight,
  };
}

export type Standing = 'completed' | 'watching' | 'stalled' | 'hold' | 'dropped' | 'planned';

function isStale(row: WatchedRow, tuning: Tuning): boolean {
  const last = Date.parse(String(row.watchedAt || ''));
  if (!Number.isFinite(last)) return false;
  return Date.now() - last > tuning.staleDays * 24 * 60 * 60 * 1000;
}

/**
 * @param total episodes the series has, where the source did not say. MDBList
 * has no watch states of its own and reports everything as completed, so for it
 * the only evidence a series was put down is progress against a total, and the
 * total has to be looked up.
 */
export function standingOf(row: WatchedRow, total?: number, tuning: Tuning = DEFAULT_TUNING): Standing {
  if (row.status === 'dropped') return 'dropped';
  if (row.status === 'hold') return 'hold';
  if (row.status === 'plantowatch') return 'planned';

  const stale = tuning.stalledWeight !== 'ignore' && isStale(row, tuning);
  if (row.status === 'watching') return stale ? 'stalled' : 'watching';

  // An explicit "completed" from a source that tracks states is taken at its
  // word; one that says it about everything is not.
  const episodes = row.totalEpisodes || total;
  const unfinished = row.source === 'mdblist'
    && !!episodes && !!row.watchedEpisodes && row.watchedEpisodes < episodes;
  if (unfinished) return stale ? 'stalled' : 'watching';

  return 'completed';
}

/**
 * Everything the profile can read as a title not enjoyed. A stall only counts
 * once the viewer has said it should: at the lighter settings it is written
 * down but not held against the title.
 */
export function isNegative(row: WatchedRow, total?: number, tuning: Tuning = DEFAULT_TUNING): boolean {
  const standing = standingOf(row, total, tuning);
  if (standing === 'dropped' || standing === 'hold') return true;
  if (standing === 'stalled') return tuning.stalledWeight === 'mild' || tuning.stalledWeight === 'dislike';
  return !!row.rating && row.rating <= 4;
}

/**
 * How many titles reach the model. Taste saturates well before a full library
 * does, and which titles are sent matters more than how many: the strata below
 * carry current taste, durable taste and dislikes, which a flat "most recent N"
 * would lose.
 */
const DEFAULT_LIMIT = 200;

export interface HistoryStats {
  total: number;
  movies: number;
  series: number;
  anime: number;
  rated: number;
  dropped: number;
  /** Put down without being finished: dropped, stalled or on hold. */
  abandoned: number;
  decades: Record<string, number>;
  meanRating?: number;
}

function byRecency(a: WatchedRow, b: WatchedRow): number {
  return String(b.watchedAt || '').localeCompare(String(a.watchedAt || ''));
}

export function summarise(rows: WatchedRow[], tuning: Tuning = DEFAULT_TUNING): HistoryStats {
  const decades: Record<string, number> = {};
  let ratingSum = 0;
  let rated = 0;

  for (const row of rows) {
    if (row.year) {
      const decade = `${Math.floor(row.year / 10) * 10}s`;
      decades[decade] = (decades[decade] || 0) + 1;
    }
    if (row.rating) { ratingSum += row.rating; rated += 1; }
  }

  return {
    total: rows.length,
    movies: rows.filter(row => row.kind === 'movie').length,
    series: rows.filter(row => row.kind === 'series').length,
    anime: rows.filter(row => row.kind === 'anime').length,
    rated,
    dropped: rows.filter(row => row.status === 'dropped').length,
    abandoned: rows.filter(row => {
      const standing = standingOf(row, undefined, tuning);
      return standing === 'dropped' || standing === 'stalled' || standing === 'hold';
    }).length,
    decades,
    meanRating: rated ? Number((ratingSum / rated).toFixed(1)) : undefined,
  };
}

/**
 * Picks the titles worth spending tokens on, in four strata: what they watched
 * last, what they scored highest, what they scored lowest or abandoned, and a
 * spread of the rest so the sample is not all one era. Dislikes are kept even
 * when they are few, because they are the only thing that says what to avoid.
 */
export function stratify(rows: WatchedRow[], limit = DEFAULT_LIMIT, tuning: Tuning = DEFAULT_TUNING): WatchedRow[] {
  const picked = new Map<string, WatchedRow>();
  const take = (candidates: WatchedRow[], count: number) => {
    for (const row of candidates) {
      if (picked.size >= limit) return;
      if (!picked.has(row.key)) picked.set(row.key, row);
      if (picked.size >= limit) return;
      count -= 1;
      if (count <= 0) return;
    }
  };

  const rated = rows.filter(row => row.rating);
  const disliked = rows.filter(row => isNegative(row, undefined, tuning));

  take([...rows].sort(byRecency), Math.round(limit * 0.3));
  take([...rated].sort((a, b) => (b.rating || 0) - (a.rating || 0)), Math.round(limit * 0.3));
  take([...disliked].sort((a, b) => (a.rating || 0) - (b.rating || 0)), Math.round(limit * 0.2));

  // Whatever is left, spread across the library rather than taken off the top.
  const remaining = rows.filter(row => !picked.has(row.key));
  if (remaining.length && picked.size < limit) {
    const step = Math.max(1, Math.floor(remaining.length / (limit - picked.size)));
    for (let index = 0; index < remaining.length && picked.size < limit; index += step) {
      picked.set(remaining[index].key, remaining[index]);
    }
  }

  return [...picked.values()];
}

/**
 * One line per title. Compact on purpose: the model knows these titles, so a
 * plot summary mostly adds tokens and pulls attention toward plot keywords
 * rather than taste. Episode counts say more than a synopsis ever would.
 */
export function formatRow(row: WatchedRow, facts?: FactMap, tuning: Tuning = DEFAULT_TUNING): string {
  const found = facts?.get(row.key);
  const total = row.totalEpisodes || found?.episodes;

  const parts = [row.title];
  if (row.year) parts.push(`(${row.year})`);
  if (row.kind === 'anime') parts.push('[anime]');

  if (row.watchedEpisodes && total) {
    parts.push(`${row.watchedEpisodes}/${total} eps`);
  } else if (row.watchedEpisodes) {
    parts.push(`${row.watchedEpisodes} eps`);
  }

  if (row.rating) parts.push(`★${row.rating}`);
  // Their own score where they gave one, otherwise how it is rated elsewhere, so
  // a library with a handful of ratings still says something about standards.
  else if (found?.score) parts.push(`(${found.score}/100 elsewhere)`);

  const standing = standingOf(row, found?.episodes, tuning);
  if (standing === 'dropped') parts.push('— dropped');
  else if (standing === 'stalled') {
    // At the lightest setting the mark is a fact about the viewing, not a verdict.
    parts.push(tuning.stalledWeight === 'note' ? '— set aside, not resumed' : '— stalled, not resumed');
  } else if (standing === 'hold') parts.push('— on hold');
  else if (standing === 'watching') parts.push('— still watching');

  if (found?.genres?.length) parts.push(`· ${found.genres.slice(0, 3).join(', ')}`);

  return parts.join(' ');
}

export function formatHistory(
  rows: WatchedRow[],
  limit: number = DEFAULT_LIMIT,
  facts?: FactMap,
  chosen?: WatchedRow[],
  tuning: Tuning = DEFAULT_TUNING,
): {
  lines: string;
  stats: HistoryStats;
  used: number;
  sample: WatchedRow[];
} {
  // Stats describe the whole library; only the sample is written out. The caller
  // may pass the sample it already has, so it is not chosen twice.
  const stats = summarise(rows, tuning);
  const sample = chosen || stratify(rows, limit, tuning);
  return {
    lines: sample.map(row => formatRow(row, facts, tuning)).join('\n'),
    stats,
    used: sample.length,
    sample,
  };
}

module.exports = {
  summarise, stratify, formatRow, formatHistory, standingOf, isNegative,
  tuningFrom, DEFAULT_TUNING, DEFAULT_LIMIT,
};
