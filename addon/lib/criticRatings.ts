import consola from 'consola';
import { LRUCache } from 'lru-cache';
import redis from './redisClient';
import { envInt } from '../utils/envNumber';
import { publicMetaDbRatings } from './ratingProviders/publicMetaDb';
import { RatingsPaused, ratingKey as keyOf, type RatingRef, type RatingSource, type RatingsProvider, type Scores } from './ratingProviders/types';

export { ratingKey } from './ratingProviders/types';
export type { RatingKind, RatingRef, RatingSource, Scores } from './ratingProviders/types';

const logger = consola.withTag('Critic Ratings');

const provider: RatingsProvider = publicMetaDbRatings;

interface Entry {
  s: Scores;
  f: number;
}

const KEY_PREFIX = 'critic-ratings:v2:';

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
  return Math.min(provider.maxBatch, envInt('CRITIC_RATINGS_BATCH_SIZE', 100, 1));
}

function concurrency(): number {
  return envInt('CRITIC_RATINGS_CONCURRENCY', 2, 1);
}

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

async function runBatch(batch: Pending[]): Promise<void> {
  const refs = batch.map((item) => item.ref);
  let fetched: Map<string, Scores>;
  try {
    fetched = await provider.fetch(refs);
  } catch (error) {
    if (error instanceof RatingsPaused) pausedUntil = Date.now() + error.ms;
    const retryAt = Date.now() + envInt('CRITIC_RATINGS_RETRY_SECONDS', 120, 1) * 1000;
    for (const ref of refs) failed.set(keyOf(ref), retryAt);
    const message = `Could not read ${refs.length} titles from ${provider.name}: ${(error as Error).message}`;
    if (Date.now() - lastWarned > 60_000) {
      lastWarned = Date.now();
      logger.warn(message);
    } else {
      logger.debug(message);
    }
    return;
  }
  const now = Date.now();
  const writes: Array<[string, Entry, number]> = [];
  for (const ref of refs) {
    const key = keyOf(ref);
    const scores = fetched.get(key) ?? {};
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

export function nativeValue(source: RatingSource, score: number): number {
  return Math.round((score * SOURCE_SCALE[source]) / 10) / 10;
}

export function criticRatingsStats(): { cached: number; queued: number; fetching: number; pausedForMs: number } {
  return { cached: memory.size, queued: pending.size, fetching: inflight.size, pausedForMs: Math.max(0, pausedUntil - Date.now()) };
}
