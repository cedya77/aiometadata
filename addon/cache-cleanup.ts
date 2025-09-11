// Place this in server.ts or a new migrations.ts file
import redisClient from './lib/redisClient.js'; // Your connected Redis client
import consola from 'consola';

const logger = consola.withTag('Cache-Cleanup');

// A permanent key we'll set in Redis to ensure this cleanup only ever runs once.
const CLEANUP_FLAG_KEY = 'cache-migration:v2-composite-key-cleanup-complete';

// The pattern of the OLD, corrupted cache keys that need to be deleted.
const OLD_CACHE_PATTERN = 'id_mapping:*';

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
export async function runCacheCleanup() {
  if (!redisClient || redisClient.status !== 'ready') {
    logger.error('Redis client is not connected. Skipping cache migration.');
    return;
  }

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