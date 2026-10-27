import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { normaliseJellyfinId } from './idsCodec';

export interface SeriesRatingIds {
  tmdbId?: string;
  malId?: string;
  imdbId?: string;
  imdbRating: number | null;
}

const known = new LRUCache<string, SeriesRatingIds>({ max: envInt('CRITIC_RATINGS_MEMORY_ENTRIES', 20000, 100) });

export function rememberSeriesRatingIds(seriesId: string, meta: any): void {
  const tmdb = String(meta?._tmdbId ?? '');
  const mal = String(meta?._malId ?? '');
  const tmdbId = /^\d+$/.test(tmdb) ? tmdb : undefined;
  const malId = /^\d+$/.test(mal) ? mal : undefined;
  if (!tmdbId && !malId) return;
  const parsed = parseFloat(String(meta?.imdbRating));
  const imdbRating = Number.isFinite(parsed) ? parsed : null;
  const imdb = String(meta?._imdbId || meta?.imdb_id || '');
  const imdbId = /^tt\d+$/.test(imdb) ? imdb : undefined;
  const key = normaliseJellyfinId(seriesId);
  const held = known.peek(key);
  if (held && held.tmdbId === tmdbId && held.malId === malId && held.imdbId === imdbId && held.imdbRating === imdbRating) return;
  known.set(key, { tmdbId, malId, imdbId, imdbRating });
}

export function seriesRatingIds(seriesId: unknown): SeriesRatingIds | undefined {
  return typeof seriesId === 'string' && seriesId ? known.get(normaliseJellyfinId(seriesId)) : undefined;
}
