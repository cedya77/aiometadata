export interface MarkItem {
  kind: 'movie' | 'series' | 'season' | 'episode';
  ids: Record<string, any>;
  season: number | null;
  episode: number | null;
  rating: number | null;
  at: number | null;
  metaId: string;
  anime: boolean;
  later?: boolean;
}

export interface MarkSide {
  service: string;
  credential: string;
  scoped: any;
}

export type MarkOutcome = { done: number; sent: number; failed: number; skipped?: number; wait?: number; error?: string; stalled?: boolean };
export type MarkWrite = 'sent' | 'skipped' | 'failed';

const ID_KEYS = ['imdb', 'tmdb', 'tvdb', 'mal', 'anilist', 'kitsu', 'anidb', 'simkl'];
const TYPED = new Set(['tmdb', 'tvdb', 'simkl']);
export const TITLE_KEYS = ['imdb', 'tmdb', 'tvdb'];

export const dateOf = (value: unknown): number | null => {
  const at = Date.parse(String(value ?? '').replace(' ', 'T'));
  return Number.isFinite(at) ? at : null;
};
export const iso = (at: number | null) => (at ? new Date(at).toISOString() : undefined);

export function cleanIds(raw: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of ID_KEYS) {
    const value = raw?.[key];
    if (value === null || value === undefined || value === '') continue;
    if (key === 'imdb') {
      if (/^tt\d+$/.test(String(value))) out.imdb = String(value);
    } else if (Number(value) > 0) {
      out[key] = Number(value);
    }
  }
  return out;
}

export function markKeys(item: Pick<MarkItem, 'kind' | 'ids' | 'season' | 'episode'>): string[] {
  const type = item.kind === 'movie' ? 'movie' : 'show';
  const suffix = item.kind === 'season' ? `#${item.season}` : item.kind === 'episode' ? `#${item.season}:${item.episode}` : '';
  return Object.entries(item.ids)
    .filter(([key, value]) => ID_KEYS.includes(key) && value)
    .map(([key, value]) => (TYPED.has(key) ? `${key}:${type}:${value}${suffix}` : `${key}:${value}${suffix}`));
}

export function keysOf(entries: MarkItem[]): Set<string> {
  const keys = new Set<string>();
  entries.forEach((entry) => markKeys(entry).forEach((key) => keys.add(key)));
  return keys;
}

export function markItem(kind: MarkItem['kind'], ids: Record<string, any>, extra: Partial<MarkItem> = {}): MarkItem | null {
  if (!Object.keys(ids).length) return null;
  const made: MarkItem = { kind, ids, season: null, episode: null, rating: null, at: null, metaId: '', anime: Boolean(ids.mal || ids.anilist || ids.kitsu), ...extra };
  made.metaId = markKeys(made)[0];
  return made;
}

export function scoreOf(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(10, Math.max(1, Math.round(number * 2) / 2)) : null;
}

export async function mirrored(service: string, credential: string, key: string): Promise<any> {
  const { mirrorRows } = require('../jellyfin/trackerMirror');
  return ((await mirrorRows(service, credential)) as Array<{ key: string; data: any }>).find((row) => row.key === key)?.data ?? null;
}

export const titleIds = (entry: MarkItem) => Object.fromEntries(TITLE_KEYS.filter((key) => entry.ids[key] && !(key === 'tvdb' && entry.kind === 'movie')).map((key) => [key, entry.ids[key]]));
export const notFoundCount = (missed: any) => (typeof missed === 'number' ? missed : ['movies', 'shows', 'seasons', 'episodes', 'anime'].reduce((n, key) => n + (Array.isArray(missed?.[key]) ? missed[key].length : Number(missed?.[key]) || 0), 0));

export function ratingKeys(item: MarkItem): string[] {
  const { imdb, tvdb, tmdb, kitsu, mal } = item.ids;
  return [imdb, tvdb && item.kind === 'series' ? `tvdb:${tvdb}` : null, tmdb ? `tmdb:${tmdb}` : null, kitsu ? `kitsu:${kitsu}` : null, mal ? `mal:${mal}` : null].filter(Boolean) as string[];
}
