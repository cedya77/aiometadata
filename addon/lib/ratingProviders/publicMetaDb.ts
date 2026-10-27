import { envInt } from '../../utils/envNumber';
import { throttlePublicMetaDb } from '../../utils/publicmetadbUtils';
import { RatingsPaused, ratingKey, type RatingRef, type RatingSource, type RatingsProvider, type Scores } from './types';

const buildInfo: any = require('../buildInfo');

const SOURCE_URL = 'https://api.publicmetadb.com/api/collections/ratings/records';
const PAGE_SIZE = 500;

const LABELS: Record<string, RatingSource> = {
  RT: 'tomatoes',
  PC: 'tomatoesAudience',
  MC: 'metacritic',
  LB: 'letterboxd',
  RE: 'rogerebert',
  TR: 'trakt',
  TM: 'tmdb',
  ML: 'mal',
  MAL: 'mal',
};

const AVERAGES_OF_VOTES = new Set<RatingSource>(['tmdb', 'trakt', 'letterboxd', 'mal']);

interface Row {
  tmdb_id: number;
  media_type: string;
  label: string;
  score: number;
  updated?: string;
}

function filterFor(refs: RatingRef[]): string {
  const groups = (['movie', 'tv'] as const)
    .map((kind) => {
      const ids = refs.filter((ref) => ref.kind === kind).map((ref) => `tmdb_id=${Number(ref.tmdbId)}`);
      return ids.length ? `(media_type="${kind}" && (${ids.join(' || ')}))` : '';
    })
    .filter(Boolean);
  return `(${groups.join(' || ')}) && label!~"overall"`;
}

async function fetchRows(refs: RatingRef[]): Promise<Row[]> {
  const rows: Row[] = [];
  const filter = encodeURIComponent(filterFor(refs));
  for (let page = 1; page <= 20; page++) {
    await throttlePublicMetaDb();
    const url = `${SOURCE_URL}?page=${page}&perPage=${PAGE_SIZE}&skipTotal=1&fields=tmdb_id,media_type,label,score,updated&filter=${filter}`;
    const started = Date.now();
    const res = await fetch(url, {
      headers: { 'User-Agent': `AIOMetadata/${buildInfo.version} (critic ratings)` },
      signal: AbortSignal.timeout(envInt('CRITIC_RATINGS_TIMEOUT_MS', 10000, 1000)),
    });
    track(Date.now() - started, res.ok);
    if (res.status === 429) {
      const seconds = Number(res.headers.get('Retry-After'));
      throw new RatingsPaused(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000);
    }
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body: any = await res.json();
    const items: Row[] = Array.isArray(body?.items) ? body.items : [];
    rows.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  return rows;
}

function track(ms: number, ok: boolean): void {
  try {
    require('../requestTracker').trackProviderCall('pmdb-ratings', ms, ok);
  } catch {
    return;
  }
}

function consensus(rows: Row[]): Scores {
  const byLabel = new Map<RatingSource, Map<number, { count: number; latest: string }>>();
  for (const row of rows) {
    const source = LABELS[String(row.label ?? '').trim().toUpperCase()];
    const score = row.score === null || row.score === undefined || String(row.score).trim() === '' ? NaN : Number(row.score);
    if (!source || !Number.isFinite(score) || score < 0 || score > 100 || (score === 0 && AVERAGES_OF_VOTES.has(source))) continue;
    const value = Math.round(score * 10) / 10;
    const tally = byLabel.get(source) ?? new Map();
    const seen = tally.get(value) ?? { count: 0, latest: '' };
    seen.count++;
    if ((row.updated ?? '') > seen.latest) seen.latest = row.updated ?? '';
    tally.set(value, seen);
    byLabel.set(source, tally);
  }
  const scores: Scores = {};
  for (const [source, tally] of byLabel) {
    let best: { value: number; count: number; latest: string } | null = null;
    for (const [value, seen] of tally) {
      if (!best || seen.count > best.count || (seen.count === best.count && seen.latest > best.latest)) {
        best = { value, ...seen };
      }
    }
    if (best) scores[source] = best.value;
  }
  return scores;
}

export const publicMetaDbRatings: RatingsProvider = {
  name: 'PublicMetaDB',
  maxBatch: 150,
  async fetch(refs) {
    const grouped = new Map<string, Row[]>();
    for (const row of await fetchRows(refs)) {
      const key = ratingKey({ kind: row.media_type === 'tv' ? 'tv' : 'movie', tmdbId: String(row.tmdb_id) });
      const list = grouped.get(key) ?? [];
      list.push(row);
      grouped.set(key, list);
    }
    const scores = new Map<string, Scores>();
    for (const [key, rows] of grouped) scores.set(key, consensus(rows));
    return scores;
  },
};
