import redis from './redisClient';
import packageJson from '../../package.json';
import consola from 'consola';

const { deleteKeysByPattern } = require('./redisUtils');

const logger = consola.withTag('Version-Cleanup');

const CURRENT_VERSION = packageJson.version;
const VERSION_KEY = 'system:app_version';

const VERSIONED_KEY_REGEX = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?):/;
const GLOBAL_KEY_REGEX = /^global:(\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?):/;

export async function performVersionCleanup(): Promise<void> {
  if (!redis) {
    logger.warn('Redis not available, skipping version cleanup');
    return;
  }

  try {
    // Ensure Redis is connected
    if (redis.status !== 'ready') {
      logger.warn('Redis not ready, skipping version cleanup');
      return;
    }

    const lastVersion = await redis.get(VERSION_KEY);

    if (lastVersion === CURRENT_VERSION) {
      logger.info(`App version match (${CURRENT_VERSION}). No cleanup needed.`);
      return;
    }

    logger.info(`Version change detected: ${lastVersion || 'none'} -> ${CURRENT_VERSION}`);
    logger.info('Starting cleanup of old cache keys...');

    await cleanOldVersionedKeys();

    // Only update version after successful cleanup
    await redis.set(VERSION_KEY, CURRENT_VERSION);
    logger.info(`Version key updated to ${CURRENT_VERSION}`);

  } catch (error: any) {
    logger.error('Failed during version cleanup:', error.message);
    logger.warn('Version key NOT updated - cleanup will retry on next startup');
  }
}

async function cleanOldVersionedKeys(): Promise<void> {
  if (!redis) return;
  
  const startTime = Date.now();
  let totalDeleted = 0;

  try {
    // Clean old versioned keys (v1.2.3:*) - uses targeted SCAN pattern
    const versionedDeleted = await deleteKeysByPattern('v*', {
      scanCount: 1000,
      batchSize: 500,
      filter: (key: string) => {
        const match = VERSIONED_KEY_REGEX.exec(key);
        // Only delete if it's a versioned key AND not the current version
        return match !== null && match[1] !== CURRENT_VERSION;
      }
    });
    totalDeleted += versionedDeleted;
    logger.info(`Deleted ${versionedDeleted} old versioned keys (v*)`);

    // Clean old global versioned keys (global:1.2.3:*)
    const globalDeleted = await deleteKeysByPattern('global:*', {
      scanCount: 1000,
      batchSize: 500,
      filter: (key: string) => {
        const match = GLOBAL_KEY_REGEX.exec(key);
        // Only delete if it's a versioned global key AND not the current version
        return match !== null && match[1] !== CURRENT_VERSION;
      }
    });
    totalDeleted += globalDeleted;
    logger.info(`Deleted ${globalDeleted} old global versioned keys (global:*)`);

    const duration = (Date.now() - startTime) / 1000;
    logger.success(`Cleanup complete in ${duration.toFixed(2)}s. Deleted ${totalDeleted} old versioned keys.`);
  } catch (error: any) {
    const duration = (Date.now() - startTime) / 1000;
    logger.error(`Cleanup failed after ${duration.toFixed(2)}s: ${error.message}`);
    logger.info(`Deleted ${totalDeleted} keys before failure`);
    throw error;
  }
}