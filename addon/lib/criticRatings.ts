import consola from 'consola';
import { LRUCache } from 'lru-cache';
import redis from './redisClient';
import { envInt } from '../utils/envNumber';
import { throttlePublicMetaDb } from '../utils/publicmetadbUtils';

const logger = consola.withTag('Critic Ratings');
const buildInfo: any = require('./buildInfo');

export type RatingKind = 'movie' | 'tv';
export type RatingSource = 'tomatoes' | 'tomatoesAudience' | 'metacritic' | 'letterboxd' | 'rogerebert' | 'trakt' | 'tmdb' | 'mal';
export type Scores = Partial<Record<RatingSource, number>>;

export interface RatingRef {
  kind: RatingKind;
  tmdbId: string;
  recent?: boolean;
}

interface Entry {
  s: Scores;
  f: number;
}

const SOURCE_URL = 'https://api.publicmetadb.com/api/collections/ratings/records';
const PAGE_SIZE = 500;
const KEY_PREFIX = 'critic-ratings:v2:';

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

export const SOURCE_ORDER: RatingSource[] = ['tomatoes', 'tomatoesAudience', 'metacritic', 'letterboxd', 'rogerebert', 'trakt', 'tmdb', 'mal'];

export const SOURCE_SCALE: Record<RatingSource, number> = {
  tomatoes: 100,
  tomatoesAudience: 100,
  metacritic: 100,
  letterboxd: 5,
  rogerebert: 4,
  trakt: 100,
  tmdb: 10,
  mal: 10,
};

const HOUR = 3600 * 1000;

export function criticRatingsEnabled(): boolean {
  return String(process.env.CRITIC_RATINGS_ENABLED ?? 'true').toLowerCase() !== 'false';
}

function ttlMs(found: boolean, recent: boolean): number {
  if (recent) return envInt('CRITIC_RATINGS_RECENT_TTL_HOURS', 12, 1) * HOUR;
  return found ? envInt('CRITIC_RATINGS_TTL_HOURS', 168, 1) * HOUR : envInt('CRITIC_RATINGS_EMPTY_TTL_HOURS', 24, 1) * HOUR;
}

function batchSize(): number {
  return Math.min(150, envInt('CRITIC_RATINGS_BATCH_SIZE', 100, 1));
}

function concurrency(): number {
  return envInt('CRITIC_RATINGS_CONCURRENCY', 2, 1);
}

const keyOf = (ref: RatingRef) => `${ref.kind}:${ref.tmdbId}`;

const memory = new LRUCache<string, Entry>({
  max: envInt('CRITIC_RATINGS_MEMORY_ENTRIES', 20000, 100),
  ttl: envInt('CRITIC_RATINGS_MEMORY_SECONDS', 600, 1) * 1000,
});

const failed = new LRUCache<string, number>({ max: 20000 });

interface Pending {
  ref: RatingRef;
  done: Promise<void>;
  resolve: () => void;
}

const pending = new Map<string, Pending>();
const inflight = new Map<string, Promise<void>>();
let running = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pausedUntil = 0;
let lastWarned = 0;

function queue(ref: RatingRef): Promise<void> | undefined {
  const key = keyOf(ref);
  const busy = inflight.get(key) ?? pending.get(key)?.done;
  if (busy) return busy;
  if ((failed.get(key) ?? 0) > Date.now() || pending.size >= envInt('CRITIC_RATINGS_QUEUE_LIMIT', 5000, 100)) return undefined;
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  pending.set(key, { ref, done, resolve });
  scheduleFlush();
  return done;
}

function scheduleFlush(): void {
  if (pending.size >= batchSize()) {
    drain();
    return;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    drain();
  }, envInt('CRITIC_RATINGS_GATHER_MS', 100, 0));
  flushTimer.unref?.();
}

function drain(): void {
  const wait = pausedUntil - Date.now();
  if (wait > 0) {
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        drain();
      }, wait);
      flushTimer.unref?.();
    }
    return;
  }
  while (running < concurrency() && pending.size > 0) {
    const batch: Pending[] = [];
    for (const [key, item] of pending) {
      pending.delete(key);
      inflight.set(key, item.done);
      batch.push(item);
      if (batch.length >= batchSize()) break;
    }
    running++;
    void runBatch(batch).finally(() => {
      running--;
      for (const item of batch) {
        inflight.delete(keyOf(item.ref));
        item.resolve();
      }
      if (pending.size > 0) scheduleFlush();
    });
  }
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

interface Row {
  tmdb_id: number;
  media_type: string;
  label: string;
  score: number;
  updated?: string;
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
      pausedUntil = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000);
      throw new Error('rate limited');
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
    require('./requestTracker').trackProviderCall('pmdb-ratings', ms, ok);
  } catch {
    return;
  }
}

function consensus(rows: Row[]): Scores {
  const byLabel = new Map<RatingSource, Map<number, { count: number; latest: string }>>();
  for (const row of rows) {
    const source = LABELS[String(row.label ?? '').trim().toUpperCase()];
    const score = Number(row.score);
    if (!source || !Number.isFinite(score) || score <= 0 || score > 100) continue;
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

async function runBatch(batch: Pending[]): Promise<void> {
  const refs = batch.map((item) => item.ref);
  let rows: Row[];
  try {
    rows = await fetchRows(refs);
  } catch (error) {
    const retryAt = Date.now() + envInt('CRITIC_RATINGS_RETRY_SECONDS', 120, 1) * 1000;
    for (const ref of refs) failed.set(keyOf(ref), retryAt);
    const message = `Could not read ${refs.length} titles from PublicMetaDB: ${(error as Error).message}`;
    if (Date.now() - lastWarned > 60_000) {
      lastWarned = Date.now();
      logger.warn(message);
    } else {
      logger.debug(message);
    }
    return;
  }
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.media_type === 'tv' ? 'tv' : 'movie'}:${row.tmdb_id}`;
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  const now = Date.now();
  const writes: Array<[string, Entry, number]> = [];
  for (const ref of refs) {
    const key = keyOf(ref);
    const scores = consensus(grouped.get(key) ?? []);
    const ttl = ttlMs(Object.keys(scores).length > 0, Boolean(ref.recent));
    const entry: Entry = { s: scores, f: now + ttl };
    memory.set(key, entry);
    writes.push([key, entry, ttl]);
  }
  await save(writes);
}

async function save(writes: Array<[string, Entry, number]>): Promise<void> {
  if (!redis || redis.status !== 'ready' || writes.length === 0) return;
  try {
    const pipeline = redis.pipeline();
    for (const [key, entry, ttl] of writes) {
      pipeline.set(KEY_PREFIX + key, JSON.stringify(entry), 'PX', ttl * 2);
    }
    await pipeline.exec();
  } catch (error) {
    logger.debug(`Could not store ratings: ${(error as Error).message}`);
  }
}

async function load(keys: string[]): Promise<Map<string, Entry>> {
  const found = new Map<string, Entry>();
  if (!redis || redis.status !== 'ready' || keys.length === 0) return found;
  try {
    const values = await redis.mget(...keys.map((key) => KEY_PREFIX + key));
    values.forEach((value, index) => {
      if (!value) return;
      try {
        const entry = JSON.parse(value) as Entry;
        if (entry && typeof entry.f === 'number' && entry.s && typeof entry.s === 'object') {
          found.set(keys[index], entry);
          memory.set(keys[index], entry);
        }
      } catch {
        return;
      }
    });
  } catch (error) {
    logger.debug(`Could not read ratings: ${(error as Error).message}`);
  }
  return found;
}

export interface CachedRatings {
  found: Map<string, Scores>;
  missing: RatingRef[];
}

export function cachedRatings(refs: RatingRef[]): CachedRatings {
  const found = new Map<string, Scores>();
  const missing: RatingRef[] = [];
  const now = Date.now();
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = keyOf(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = memory.get(key);
    if (!entry) {
      missing.push(ref);
      continue;
    }
    found.set(key, entry.s);
    if (entry.f <= now) queue(ref);
  }
  return { found, missing };
}

export async function loadRatings(refs: RatingRef[], waitMs = 0): Promise<Map<string, Scores>> {
  const found = new Map<string, Scores>();
  const entries = await load(refs.map(keyOf));
  const now = Date.now();
  const waiting: Promise<void>[] = [];
  const unresolved: RatingRef[] = [];
  for (const ref of refs) {
    const key = keyOf(ref);
    const entry = entries.get(key);
    if (entry) {
      found.set(key, entry.s);
      if (entry.f <= now) queue(ref);
      continue;
    }
    const done = queue(ref);
    if (done && waitMs > 0) {
      waiting.push(done);
      unresolved.push(ref);
    }
  }
  if (waiting.length > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(waiting),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    clearTimeout(timer);
    for (const ref of unresolved) {
      const entry = memory.get(keyOf(ref));
      if (entry) found.set(keyOf(ref), entry.s);
    }
  }
  return found;
}

export function ratingKey(ref: RatingRef): string {
  return keyOf(ref);
}

export function nativeValue(source: RatingSource, score: number): number {
  return Math.round((score * SOURCE_SCALE[source]) / 10) / 10;
}

export function criticRatingsStats(): { cached: number; queued: number; fetching: number; pausedForMs: number } {
  return { cached: memory.size, queued: pending.size, fetching: inflight.size, pausedForMs: Math.max(0, pausedUntil - Date.now()) };
}
