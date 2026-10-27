import {
  SOURCE_ORDER,
  SOURCE_SCALE,
  cachedRatings,
  criticRatingsEnabled,
  loadRatings,
  nativeValue,
  ratingKey,
  type RatingRef,
  type Scores,
} from '../criticRatings';
import { envInt } from '../../utils/envNumber';
import { seriesRatingIds, type SeriesRatingIds } from './seriesRatingIds';

const RATED = new Set(['Movie', 'Series']);
const NUMERIC_ID = /^\d+$/;
const IMDB_ID = /^tt\d+$/;

interface Rated {
  item: any;
  ref?: RatingRef;
  malId?: string;
  series?: SeriesRatingIds;
}

function recentOf(item: any): boolean {
  const premiere = Date.parse(item.PremiereDate ?? '');
  return Number.isFinite(premiere) && premiere > Date.now() - envInt('CRITIC_RATINGS_RECENT_DAYS', 30, 0) * 24 * 3600 * 1000;
}

function ratedOf(item: any, single: boolean): Rated | null {
  if (!item || typeof item !== 'object') return null;
  if (item.Type === 'Episode') {
    if (!single) return null;
    const series = seriesRatingIds(item.SeriesId);
    if (!series) return null;
    return {
      item,
      series,
      ...(series.tmdbId ? { ref: { kind: 'tv' as const, tmdbId: series.tmdbId } } : series.malId ? { malId: series.malId } : {}),
    };
  }
  if (!RATED.has(item.Type)) return null;
  const tmdbId = String(item.ProviderIds?.Tmdb ?? '');
  if (NUMERIC_ID.test(tmdbId)) {
    return { item, ref: { kind: item.Type === 'Series' ? 'tv' : 'movie', tmdbId, recent: recentOf(item) } };
  }
  const malId = String(item.ProviderIds?.MyAnimeList ?? '');
  return single && NUMERIC_ID.test(malId) ? { item, malId } : null;
}

function itemsOf(body: any, oneAsked: boolean): { items: any[]; single: boolean } {
  if (Array.isArray(body)) return { items: body, single: false };
  if (body && Array.isArray(body.Items)) return { items: body.Items, single: oneAsked && body.Items.length === 1 };
  if (body && typeof body === 'object' && (RATED.has(body.Type) || body.Type === 'Episode')) return { items: [body], single: true };
  return { items: [], single: false };
}

function apply({ item, series }: Rated, scores: Scores): void {
  const ratings: Array<{ source: string; value: number; scale: number; url?: string }> = [];
  const imdb = series ? series.imdbRating : item.CommunityRating;
  const imdbId = series ? series.imdbId : IMDB_ID.test(String(item.ProviderIds?.Imdb ?? '')) ? item.ProviderIds.Imdb : undefined;
  if (typeof imdb === 'number') ratings.push({ source: 'imdb', value: imdb, scale: 10, ...(imdbId ? { url: `https://www.imdb.com/title/${imdbId}/` } : {}) });
  for (const source of SOURCE_ORDER) {
    const score = scores[source];
    if (typeof score !== 'number') continue;
    ratings.push({ source, value: nativeValue(source, score), scale: SOURCE_SCALE[source] });
  }
  if (ratings.length === 0) return;
  if (series) {
    item.aiostreams = { ...(item.aiostreams ?? {}), seriesRatings: ratings };
    return;
  }
  if (typeof scores.tomatoes === 'number') item.CriticRating = Math.round(scores.tomatoes);
  item.aiostreams = { ...(item.aiostreams ?? {}), ratings };
}

async function malScore(malId: string, waitMs: number): Promise<number | undefined> {
  const { getAnimeDetailsCached }: any = require('../mal');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const details = await Promise.race([
    getAnimeDetailsCached(malId).catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), waitMs);
    }),
  ]);
  clearTimeout(timer);
  const score = Number(details?.score);
  return Number.isFinite(score) && score > 0 ? Math.round(score * 100) / 10 : undefined;
}

export function oneIdAsked(query: any): boolean {
  const raw = query?.ids ?? query?.Ids;
  const ids = (Array.isArray(raw) ? raw.join(',') : String(raw ?? '')).split(',').filter(Boolean);
  return ids.length === 1;
}

export function withCriticRatings(body: any, oneAsked = false): Promise<void> | null {
  if (!criticRatingsEnabled()) return null;
  const { items, single } = itemsOf(body, oneAsked);
  if (items.length === 0) return null;
  const rated: Rated[] = [];
  for (const item of items) {
    const entry = ratedOf(item, single);
    if (entry) rated.push(entry);
  }
  if (rated.length === 0) return null;

  const withRef = rated.filter((entry) => entry.ref);
  const { found, missing } = cachedRatings(withRef.map((entry) => entry.ref!));
  const needsMal = rated.filter((entry) => !entry.ref && entry.malId);
  if (missing.length === 0 && needsMal.length === 0) {
    for (const entry of withRef) {
      const scores = found.get(ratingKey(entry.ref!));
      if (scores) apply(entry, scores);
    }
    return null;
  }

  const wait = single ? envInt('CRITIC_RATINGS_DETAIL_WAIT_MS', 1500, 0) : 0;
  return Promise.all([
    missing.length > 0 ? loadRatings(missing, wait) : Promise.resolve(new Map<string, Scores>()),
    Promise.all(needsMal.map((entry) => malScore(entry.malId!, wait))),
  ]).then(([loaded, malScores]) => {
    const mals = new Map(needsMal.map((entry, index) => [entry, malScores[index]]));
    for (const entry of rated) {
      const scores: Scores = entry.ref ? { ...(found.get(ratingKey(entry.ref)) ?? loaded.get(ratingKey(entry.ref)) ?? {}) } : {};
      const mal = mals.get(entry);
      if (typeof mal === 'number') scores.mal = mal;
      apply(entry, scores);
    }
  });
}
