// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
/**
 * Cache of loaded user configs. Redis is the shared layer, so a save on one
 * replica is seen by the others; a short in-process layer spares hot users a
 * Redis read and decode on every request. A missing-key memo lets a request
 * for a config that does not exist answer without another database read.
 */
import { LRUCache } from 'lru-cache';
import consola from 'consola';
import redis from './redisClient';
import { decodeCachePayload, encodeCachePayload } from './cacheCodec';
import { envInt } from '../utils/envNumber';

const logger = consola.withTag('ConfigCache');

const KEY_PREFIX = 'user-config:';
const DEFAULT_REDIS_TTL_SEC = 300;
const MIN_REDIS_TTL_SEC = 10;
const DEFAULT_MEMORY_TTL_SEC = 30;
const DEFAULT_MISSING_TTL_SEC = 60;
const MEMORY_MAX_ENTRIES = 2000;
const MISSING_MAX_ENTRIES = 5000;
const SCAN_COUNT = 1000;

type Loader = () => Promise<any>;

interface PendingLoad {
  promise: Promise<any>;
}

const memory = new LRUCache<string, any>({ max: MEMORY_MAX_ENTRIES });
const missing = new LRUCache<string, true>({ max: MISSING_MAX_ENTRIES });
const pendingLoads = new Map<string, PendingLoad>();

function redisKey(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

function shortKey(key: string): string {
  return String(key).slice(0, 8);
}

function errorMessage(error: unknown): string {
  return (error as any)?.message || String(error);
}

function redisTtlSec(): number {
  const parsed = Number.parseInt(String(process.env.CONFIG_CACHE_TTL_SEC), 10);
  return Number.isFinite(parsed) && parsed >= MIN_REDIS_TTL_SEC ? parsed : DEFAULT_REDIS_TTL_SEC;
}

function memoryTtlMs(): number {
  return envInt('CONFIG_MEMORY_TTL_SEC', DEFAULT_MEMORY_TTL_SEC, 1) * 1000;
}

function missingTtlMs(): number {
  return envInt('CONFIG_MISSING_TTL_SEC', DEFAULT_MISSING_TTL_SEC, 1) * 1000;
}

function compressionEnabled(): boolean {
  return process.env.CONFIG_CACHE_COMPRESSION_ENABLED !== 'false';
}

function redisReady(): boolean {
  return !!redis && String(redis.status) === 'ready';
}

function holdInMemory(key: string, value: any): void {
  memory.set(key, value, { ttl: memoryTtlMs() });
}

async function forEachRedisKeyBatch(cb: (keys: string[]) => Promise<void>): Promise<void> {
  if (!redis) return;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', SCAN_COUNT);
    cursor = next;
    if (keys && keys.length > 0) await cb(keys);
  } while (cursor !== '0');
}

async function get(key: string): Promise<any> {
  const held = memory.get(key);
  if (held !== undefined) return held;

  if (!redisReady()) return null;

  try {
    const payload = await redis!.getBuffer(redisKey(key));
    if (payload === null || payload === undefined) return null;
    const value = await decodeCachePayload(payload);
    if (value === null || value === undefined) return null;
    holdInMemory(key, value);
    return value;
  } catch (error) {
    logger.warn(`Config cache read failed for ${shortKey(key)}...: ${errorMessage(error)}`);
    return null;
  }
}

async function set(key: string, value: any): Promise<void> {
  if (value === undefined) return;
  if (value === null) {
    memory.delete(key);
    return;
  }

  missing.delete(key);
  holdInMemory(key, value);

  if (!redisReady()) return;

  try {
    const payload = await encodeCachePayload(value, { compressionEnabled: compressionEnabled() });
    await redis!.set(redisKey(key), payload, 'EX', redisTtlSec());
  } catch (error) {
    logger.warn(`Config cache write failed for ${shortKey(key)}...: ${errorMessage(error)}`);
  }
}

async function del(key: string): Promise<void> {
  memory.delete(key);
  missing.delete(key);
  pendingLoads.delete(key);

  if (!redisReady()) return;

  try {
    await redis!.del(redisKey(key));
  } catch (error) {
    logger.warn(`Config cache delete failed for ${shortKey(key)}...: ${errorMessage(error)}`);
  }
}

async function clear(): Promise<void> {
  memory.clear();
  missing.clear();
  pendingLoads.clear();

  if (!redisReady()) return;

  try {
    await forEachRedisKeyBatch(async (keys) => {
      await redis!.unlink(...keys);
    });
  } catch (error) {
    logger.warn(`Config cache clear failed: ${errorMessage(error)}`);
  }
}

async function loadDirect(loader: Loader): Promise<any> {
  return loader();
}

function getOrLoad(key: string, loader: Loader): Promise<any> {
  // Without Redis the in-process copy cannot be kept in step with saves on
  // other replicas, so every load goes straight to the loader and nothing is
  // served from or stored in memory.
  if (!redisReady()) return loadDirect(loader);

  const inFlight = pendingLoads.get(key);
  if (inFlight) return inFlight.promise;

  const record = {} as PendingLoad;
  record.promise = (async () => {
    if (!redisReady()) return loader();

    const cached = await get(key);
    if (cached !== null && cached !== undefined) return cached;

    const value = await loader();
    // A del() or clear() while the loader ran drops this record; the value is
    // still returned to the waiting callers but not cached, since it may predate
    // the change that caused the del. If Redis went away during the load the
    // value is not held in memory either.
    if (value !== null && value !== undefined && pendingLoads.get(key) === record && redisReady()) {
      set(key, value).catch((error) => {
        logger.warn(`Config cache store failed for ${shortKey(key)}...: ${errorMessage(error)}`);
      });
    }
    return value;
  })().finally(() => {
    if (pendingLoads.get(key) === record) pendingLoads.delete(key);
  });

  pendingLoads.set(key, record);
  return record.promise;
}

function isLoadPending(key: string): boolean {
  return pendingLoads.has(key);
}

function rememberMissing(key: string): void {
  missing.set(key, true, { ttl: missingTtlMs() });
}

function isMissing(key: string): boolean {
  return missing.get(key) === true;
}

async function stats(options: { countRedisEntries?: boolean } = {}): Promise<{ pendingLoads: number; entries: number | null }> {
  const result = { pendingLoads: pendingLoads.size, entries: null as number | null };
  if (!options.countRedisEntries || !redisReady()) return result;

  try {
    let count = 0;
    await forEachRedisKeyBatch(async (keys) => {
      count += keys.length;
    });
    result.entries = count;
  } catch (error) {
    logger.warn(`Config cache entry count failed: ${errorMessage(error)}`);
  }
  return result;
}

if (redis) {
  logger.debug(`Config cache is Redis-backed (TTL ${redisTtlSec()}s).`);
} else {
  logger.warn('Redis is unavailable; config cache is disabled and every lookup falls through to the loader.');
}

const configCache = {
  get,
  set,
  del,
  clear,
  getOrLoad,
  isLoadPending,
  rememberMissing,
  isMissing,
  stats,
  // In-process state, read synchronously by the dashboard heap profile.
  cache: memory,
  pendingLoads,
};

export default configCache;
module.exports = configCache;
