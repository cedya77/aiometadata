import type { Tracker } from './types';

export interface CopyItem {
  ids: string[];
  kind: 'movie' | 'episode';
  metaId: string;
  season: number | null;
  episode: number | null;
  at: number | null;
  native?: { tmdb: number; imdb: string | null; season: number | null; episode: number | null };
}

export type CopyTarget = { ids: Record<string, any>; season?: number; episode?: number; episodeIds?: Record<string, number>; fallback?: { ids: Record<string, any>; season: number; episode: number } | null };
export type WatchOutcome = { done: number; sent: number; failed: number; skipped?: number; wait?: number; error?: string; lost?: number[]; stalled?: boolean };
export type MirrorRow = { key: string; data: any };

export interface TmdbWatch {
  kind: 'movie' | 'episode';
  tmdb: number;
  imdb: string | null;
  showTvdb: string | number | null;
  season: number | null;
  episode: number | null;
  tvdb: { series?: any; season?: any; episode?: any } | null;
  at: number | null;
}

export const nativeKey = (kind: string, tmdb: number, season: number | null, episode: number | null) => (kind === 'movie' ? `movie:${tmdb}` : `tv:${tmdb}:${season}:${episode}`);
export const isoAt = (at: number | null) => (at ? new Date(at).toISOString() : null);

export const sharesId = (a: Record<string, any> = {}, b: Record<string, any> = {}): boolean =>
  Object.entries(a).some(([key, value]) => value != null && b[key] != null && String(b[key]) === String(value));

export function spellingsOf(watch: TmdbWatch): string[] {
  if (watch.kind === 'movie') return [watch.imdb, `tmdb:${watch.tmdb}`].filter(Boolean) as string[];
  const spellings: string[] = [];
  const named = watch.tvdb;
  if (named?.series && Number.isFinite(Number(named.season)) && Number.isFinite(Number(named.episode))) {
    spellings.push(`tvdb:${named.series}:${named.season}:${named.episode}`);
    if (watch.imdb && String(watch.showTvdb ?? '') === String(named.series)) spellings.push(`${watch.imdb}:${named.season}:${named.episode}`);
  } else if (watch.imdb) {
    spellings.push(`${watch.imdb}:${watch.season}:${watch.episode}`);
  }
  spellings.push(`tmdb:${watch.tmdb}:${watch.season}:${watch.episode}`);
  return spellings;
}

export function heldKeysOf(watch: TmdbWatch): string[] {
  const keys = [nativeKey(watch.kind, watch.tmdb, watch.season, watch.episode)];
  if (watch.imdb) keys.push(watch.kind === 'movie' ? `imdb:${watch.imdb}` : `imdb:${watch.imdb}:${watch.season}:${watch.episode}`);
  if (watch.kind === 'episode' && watch.tvdb?.series) keys.push(`tvdb:${watch.tvdb.series}:${watch.tvdb.season}:${watch.tvdb.episode}`);
  return keys;
}

export function aliasesOf(watch: TmdbWatch): Array<[string, string]> {
  if (watch.kind !== 'episode' || !watch.tmdb || !Number.isFinite(watch.season) || !Number.isFinite(watch.episode)) return [];
  const tmdb = `tmdb:${watch.tmdb}:${watch.season}:${watch.episode}`;
  const named = watch.tvdb;
  if (named?.series) return [[`tvdb:${named.series}:${named.season}:${named.episode}`, tmdb], ...(watch.imdb ? [[`${watch.imdb}:${named.season}:${named.episode}`, tmdb] as [string, string]] : [])];
  return watch.imdb ? [[`${watch.imdb}:${watch.season}:${watch.episode}`, tmdb]] : [];
}

export async function copyTarget(tracker: Tracker, item: CopyItem, config: any): Promise<CopyTarget | null> {
  const tmdbNumbered = Boolean(tracker.tmdbWatches);
  if (item.native && tmdbNumbered) {
    const ids: Record<string, any> = { tmdb: item.native.tmdb, ...(item.native.imdb ? { imdb: item.native.imdb } : {}) };
    return item.kind === 'movie' ? { ids } : { ids, season: item.native.season ?? undefined, episode: item.native.episode ?? undefined };
  }
  const { parseMediaId, historyTarget } = require('../subtitleHandler');
  const { spellingsFor } = require('../jellyfin/trackerDrift');
  let target: CopyTarget | null = null;
  for (const spelling of spellingsFor(tracker.id, item.ids) as string[]) {
    const parsed = parseMediaId(spelling);
    target = parsed ? await historyTarget(parsed, config, tracker.id).catch(() => null) : null;
    if (target) break;
  }
  if (!target) return null;
  if (tracker.takesEpisodeIds && target.episodeIds) return target;
  if (tmdbNumbered) {
    const { tmdbIdFrom } = require('../../utils/publicmetadbUtils');
    const tmdb = target.ids.tmdb ?? await tmdbIdFrom(target.ids, item.kind === 'movie' ? 'movie' : 'series').catch(() => null);
    if (!tmdb) return null;
    target.ids = { ...target.ids, tmdb };
  }
  return target;
}

export async function targetsFor(tracker: Tracker, items: CopyItem[], config: any): Promise<{ writes: any[]; from: number[]; lost: number[] }> {
  const writes: any[] = [];
  const from: number[] = [];
  const lost: number[] = [];
  for (const [i, item] of items.entries()) {
    const target = await copyTarget(tracker, item, config);
    if (!target) lost.push(i);
    else {
      writes.push({ ...target, watchedAt: isoAt(item.at) });
      from.push(i);
    }
  }
  return { writes, from, lost };
}
