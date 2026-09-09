import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import {
  CODEC_VERSION,
  Descriptor,
  hashJellyfinId,
  isHashedJellyfinId,
  normaliseJellyfinId,
  packJellyfinId,
  unpackJellyfinId,
} from './idsCodec';

const database: any = require('../database');

const logger = consola.withTag('JellyfinIds');

const cache = new LRUCache<string, Descriptor>({
  max: envInt('JELLYFIN_ID_CACHE_MAX', 100000, 1),
});

const persisted = new LRUCache<string, true>({
  max: envInt('JELLYFIN_ID_PERSISTED_MAX', 50000, 1),
});

let pending: Array<{ id: string; payload: Descriptor; codecVersion: number }> = [];
let flushTimer: NodeJS.Timeout | null = null;

function flushDelay(): number {
  return envInt('JELLYFIN_ID_FLUSH_DELAY_MS', 250, 0);
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const batch = pending;
    pending = [];
    if (!batch.length) return;

    try {
      await database.rememberJellyfinIds(batch);
    } catch (error: any) {
      logger.warn(`Failed to persist ${batch.length} id mappings: ${error?.message || error}`);
      for (const row of batch) persisted.delete(row.id);
    }
  }, flushDelay());
  flushTimer.unref?.();
}

export function encodeJellyfinId(d: Descriptor): string {
  const packed = packJellyfinId(d);
  if (packed) return packed;

  const id = hashJellyfinId(d);
  cache.set(id, d);

  if (!persisted.has(id)) {
    persisted.set(id, true);
    pending.push({ id, payload: d, codecVersion: CODEC_VERSION });
    scheduleFlush();
  }

  return id;
}

export async function decodeJellyfinId(raw: string): Promise<Descriptor | null> {
  const id = normaliseJellyfinId(raw);
  if (!/^[0-9a-f]{32}$/.test(id)) return null;

  const unpacked = unpackJellyfinId(id);
  if (unpacked) return unpacked;

  if (!isHashedJellyfinId(id)) return null;

  const cached = cache.get(id);
  if (cached) return cached;

  try {
    const stored = await database.lookupJellyfinId(id);
    if (stored) {
      cache.set(id, stored);
      return stored;
    }
  } catch (error: any) {
    logger.warn(`Failed to look up id ${id}: ${error?.message || error}`);
  }

  return null;
}

export async function flushPendingJellyfinIds(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const batch = pending;
  pending = [];
  if (!batch.length) return;

  try {
    await database.rememberJellyfinIds(batch);
  } catch (error: any) {
    logger.warn(`Failed to flush ${batch.length} id mappings: ${error?.message || error}`);
    for (const row of batch) persisted.delete(row.id);
  }
}

export * from './idsCodec';
