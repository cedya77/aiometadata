// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import redis from './redisClient';
import consola from 'consola';

const { deleteKeysByPattern } = require('./redisUtils');
const { getCacheEpoch, isSupersededCacheKey, CACHE_KEY_SCAN_PATTERNS } = require('./cacheEpoch');

const logger = consola.withTag('Epoch-Cleanup');

/** Records the epoch the keyspace was last cleaned to. */
export const EPOCH_STATE_KEY = 'system:cache_epoch';

/**
 * Drops cache entries whose payload shape this build no longer trusts.
 *
 * This used to key off the addon version, so every release emptied the cache
 * whether or not anything had changed shape. It now keys off the cache epoch,
 * which is bumped by hand — so ordinary releases short-circuit here without
 * scanning the keyspace at all, and the cache survives the upgrade.
 *
 * The first run after upgrading past the version-keyed scheme finds no stored
 * epoch and therefore sweeps the legacy `v<semver>:` keys once.
 */
export async function performEpochCleanup(): Promise<void> {
  if (!redis) {
    logger.warn('Redis not available, skipping epoch cleanup');
    return;
  }

  try {
    if (redis.status !== 'ready') {
      logger.warn('Redis not ready, skipping epoch cleanup');
      return;
    }

    const currentEpoch = getCacheEpoch();
    const lastEpoch = await redis.get(EPOCH_STATE_KEY);

    if (lastEpoch === String(currentEpoch)) {
      logger.info(`Cache epoch match (${currentEpoch}). No cleanup needed.`);
      return;
    }

    logger.info(`Cache epoch change detected: ${lastEpoch || 'none'} -> ${currentEpoch}`);
    await cleanSupersededKeys(currentEpoch);

    // Only recorded after a successful sweep, so a failure retries next boot.
    await redis.set(EPOCH_STATE_KEY, String(currentEpoch));
    logger.info(`Cache epoch recorded as ${currentEpoch}`);
  } catch (error: any) {
    logger.error('Failed during epoch cleanup:', error.message);
    logger.warn('Epoch key NOT updated - cleanup will retry on next startup');
  }
}

async function cleanSupersededKeys(currentEpoch: number): Promise<void> {
  if (!redis) return;

  const startTime = Date.now();
  let totalDeleted = 0;

  try {
    for (const pattern of CACHE_KEY_SCAN_PATTERNS) {
      const deleted = await deleteKeysByPattern(pattern, {
        scanCount: 1000,
        batchSize: 500,
        filter: (key: string) => isSupersededCacheKey(key, currentEpoch),
      });
      totalDeleted += deleted;
      logger.info(`Deleted ${deleted} superseded keys matching ${pattern}`);
    }

    const duration = (Date.now() - startTime) / 1000;
    logger.success(`Cleanup complete in ${duration.toFixed(2)}s. Deleted ${totalDeleted} superseded keys.`);
  } catch (error: any) {
    const duration = (Date.now() - startTime) / 1000;
    logger.error(`Cleanup failed after ${duration.toFixed(2)}s: ${error.message}`);
    logger.info(`Deleted ${totalDeleted} keys before failure`);
    throw error;
  }
}

// NOTE: this assignment replaces the whole CommonJS exports object, so every
// symbol consumers need must be listed here — the `export` keywords above do
// not survive it.
module.exports = { EPOCH_STATE_KEY, performEpochCleanup };
