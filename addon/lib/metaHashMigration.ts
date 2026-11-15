// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import redis from './redisClient';
import consola from 'consola';

const { deleteKeysByPattern } = require('./redisUtils');
const { getCacheEpoch } = require('./cacheEpoch');

const logger = consola.withTag('Meta-Hash-Migration');

/** Per-component key prefixes the meta cache used before it moved to one hash per title. */
export const LEGACY_META_COMPONENT_PREFIXES = [
  'meta-basic', 'meta-poster', 'meta-raw-poster', 'meta-background', 'meta-landscape-poster',
  'meta-logo', 'meta-videos', 'meta-cast', 'meta-director', 'meta-writer',
  'meta-links', 'meta-trailers', 'meta-extras',
];

/** Records the epoch whose legacy component keys have been swept. */
export const META_HASH_MIGRATION_STATE_KEY = 'system:meta_hash_migration';

/**
 * Nothing reads the per-component keys any more; under volatile-lfu they would
 * be evicted first and otherwise expire within META_TTL. Deleting them at once
 * hands that memory back straight after the upgrade. Recorded only after a
 * clean sweep, so a failure retries on the next boot.
 */
export async function sweepLegacyMetaComponentKeys(): Promise<number> {
  if (!redis || redis.status !== 'ready') {
    logger.warn('Redis not ready, skipping legacy meta key sweep');
    return 0;
  }

  const epoch = String(getCacheEpoch());
  if ((await redis.get(META_HASH_MIGRATION_STATE_KEY)) === epoch) return 0;

  let total = 0;
  for (const prefix of LEGACY_META_COMPONENT_PREFIXES) {
    total += await deleteKeysByPattern(`e${epoch}:${prefix}:*`, { scanCount: 1000, batchSize: 500 });
  }

  await redis.set(META_HASH_MIGRATION_STATE_KEY, epoch);
  logger.info(`Removed ${total} per-component meta keys left from before the hash layout`);
  return total;
}

// NOTE: this assignment replaces the whole CommonJS exports object, so every
// symbol consumers need must be listed here.
module.exports = { LEGACY_META_COMPONENT_PREFIXES, META_HASH_MIGRATION_STATE_KEY, sweepLegacyMetaComponentKeys };
