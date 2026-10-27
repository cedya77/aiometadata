// Place this in server.ts or a new migrations.ts file
import redisClient from './lib/redisClient.js'; // Your connected Redis client
import consola from 'consola';

const logger = consola.withTag('Cache-Cleanup');

// A permanent key we'll set in Redis to ensure this cleanup only ever runs once.
const CLEANUP_FLAG_KEY = 'cache-migration:v2-composite-key-cleanup-complete';

// The pattern of the OLD, corrupted cache keys that need to be deleted.
const OLD_CACHE_PATTERN = 'id_mapping:*';

const JIKAN_DETAILS_FLAG_KEY = 'cache-migration:jikan-details-ttl-v1';
const JIKAN_DETAILS_PATTERN = 'global:*jikan-api:v2:anime-details-*';

/**
 * A helper function to safely find all keys matching a pattern using SCAN.
 */
async function findKeysByPattern(pattern: string): Promise<string[]> {
  if (!redisClient) return [];
  
  const foundKeys: string[] = [];
  let cursor = '0';
  do {
    const [newCursor, keys] = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', '1000');
    cursor = newCursor;
    foundKeys.push(...keys);
  } while (cursor !== '0');
  return foundKeys;
}

/**
 * Checks if the old cache format exists and clears it if necessary.
 * This function is designed to run only ONCE.
 */
async function holdJikanDetailsToTheirTtl(): Promise<void> {
  if (!redisClient || await redisClient.get(JIKAN_DETAILS_FLAG_KEY)) return;
  const { decodeCachePayload } = require('./lib/cacheCodec');
  const { detailsTtl } = require('./lib/mal');
  let held = 0;
  for (const key of await findKeysByPattern(JIKAN_DETAILS_PATTERN)) {
    const [raw, ttl] = await Promise.all([redisClient.getBuffer(key), redisClient.ttl(key)]);
    const details = raw ? await decodeCachePayload(raw).catch(() => null) : null;
    const allowed = details ? detailsTtl(details) : 0;
    if (allowed <= 0 || ttl <= allowed) continue;
    await redisClient.expire(key, Math.floor(allowed / 2 + Math.random() * allowed / 2));
    held++;
  }
  await redisClient.set(JIKAN_DETAILS_FLAG_KEY, 'true');
  logger.info(`Held ${held} cached MAL detail(s) to the time their airing status allows.`);
}

export async function runCacheCleanup() {
  if (!redisClient || redisClient.status !== 'ready') {
    logger.error('Redis client is not connected. Skipping cache migration.');
    return;
  }

  await holdJikanDetailsToTheirTtl().catch((error) => logger.warn(`Could not recheck cached MAL details: ${error?.message || error}`));

  logger.info('Checking cache schema version...');
  
  try {
    const cleanupAlreadyDone = await redisClient.get(CLEANUP_FLAG_KEY);

    if (cleanupAlreadyDone) {
      logger.success('Cache is already clean. No action needed.');
      return;
    }

    logger.info('Old cache format may exist. Starting one-time cleanup process...');

    const keysToDelete = await findKeysByPattern(OLD_CACHE_PATTERN);

    if (keysToDelete.length > 0) {
      logger.info(`Found ${keysToDelete.length} old cache keys to delete.`);
      await redisClient.del(keysToDelete);
      logger.success(`Successfully deleted ${keysToDelete.length} old cache keys.`);
    } else {
      logger.info('No old-format cache keys were found.');
    }

    // Set the flag permanently (no TTL) so this never runs again.
    await redisClient.set(CLEANUP_FLAG_KEY, 'true');
    logger.success('Cache cleanup complete. Flag set to prevent future runs.');

  } catch (error) {
    logger.error('A critical error occurred during cache cleanup:', error);
    // We'll let the app continue, but this is a serious warning.
  }
}

module.exports = { runCacheCleanup };