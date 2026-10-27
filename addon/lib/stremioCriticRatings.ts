import {
  cachedRatings,
  criticRatingsEnabled,
  loadRatings,
  malRating,
  ratingEntries,
  ratingKey,
  recentRelease,
  type RatingRef,
  type Scores,
} from './criticRatings';
import { envInt } from '../utils/envNumber';

const NUMERIC_ID = /^\d+$/;
const IMDB_ID = /^tt\d+$/;

interface Rated {
  index: number;
  ref?: RatingRef;
  malId?: string;
}

function ratedOf(meta: any, index: number, single: boolean): Rated | null {
  if (!meta || typeof meta !== 'object' || (meta.type !== 'movie' && meta.type !== 'series')) return null;
  const tmdbId = String(meta._tmdbId ?? '');
  if (NUMERIC_ID.test(tmdbId)) {
    return { index, ref: { kind: meta.type === 'series' ? 'tv' : 'movie', tmdbId, recent: recentRelease(meta.released) } };
  }
  const malId = String(meta._malId ?? '');
  return single && NUMERIC_ID.test(malId) ? { index, malId } : null;
}

function withRatings(meta: any, scores: Scores | undefined): any {
  if (!scores || Object.keys(scores).length === 0) return meta;
  const imdb = parseFloat(String(meta.imdbRating));
  const imdbId = [meta._imdbId, meta.imdb_id].find((id) => IMDB_ID.test(String(id ?? '')));
  const ratings = ratingEntries(scores, Number.isFinite(imdb) ? imdb : null, imdbId);
  return { ...meta, app_extras: { ...(meta.app_extras ?? {}), ratings } };
}

async function rate(metas: any[], single: boolean): Promise<any[]> {
  const rated: Rated[] = [];
  metas.forEach((meta, index) => {
    const entry = ratedOf(meta, index, single);
    if (entry) rated.push(entry);
  });
  if (rated.length === 0) return metas;

  const { found, missing } = cachedRatings(rated.flatMap((entry) => (entry.ref ? [entry.ref] : [])));
  const needsMal = rated.filter((entry) => !entry.ref && entry.malId);
  let loaded = new Map<string, Scores>();
  const mals = new Map<Rated, number | undefined>();
  if (missing.length > 0 || needsMal.length > 0) {
    const wait = single ? envInt('CRITIC_RATINGS_DETAIL_WAIT_MS', 1500, 0) : 0;
    const [fromStore, malScores] = await Promise.all([
      missing.length > 0 ? loadRatings(missing, wait) : loaded,
      Promise.all(needsMal.map((entry) => malRating(entry.malId!, wait))),
    ]);
    loaded = fromStore;
    needsMal.forEach((entry, index) => mals.set(entry, malScores[index]));
  }

  let out = metas;
  for (const entry of rated) {
    const mal = mals.get(entry);
    const scores = entry.ref ? found.get(ratingKey(entry.ref)) ?? loaded.get(ratingKey(entry.ref)) : typeof mal === 'number' ? { mal } : undefined;
    const next = withRatings(metas[entry.index], scores);
    if (next === metas[entry.index]) continue;
    if (out === metas) out = metas.slice();
    out[entry.index] = next;
  }
  return out;
}

export function criticRatingsWanted(config: any, req: any): boolean {
  return config?.criticRatings === true && req?.params?.forJellyfin !== '1' && criticRatingsEnabled();
}

export function metasWithCriticRatings(metas: any[]): Promise<any[]> {
  return rate(metas, false);
}

export async function metaWithCriticRatings(meta: any): Promise<any> {
  return (await rate([meta], true))[0];
}
