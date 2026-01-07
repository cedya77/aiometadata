import redis from './redisClient';
import packageJson from '../../package.json';
import consola from 'consola';

const { deleteKeysByPattern } = require('./redisUtils');

const logger = consola.withTag('Version-Cleanup');

const CURRENT_VERSION = packageJson.version;
const VERSION_KEY = 'system:app_version';

// Regex to extract version from key patterns
const VERSIONED_KEY_REGEX = /^v(\d+\.\d+\.\d+):/;
const GLOBAL_KEY_REGEX = /^global:(\d+\.\d+\.\d+):/;

export async function performVersionCleanup(): Promise<void> {
  if (!redis) {
    logger.warn('Redis not available, skipping version cleanup');
    return;
  }

  try {
    const lastVersion = await redis.get(VERSION_KEY);

    if (lastVersion === CURRENT_VERSION) {
      logger.info(`App version match (${CURRENT_VERSION}). No cleanup needed.`);
      return;
    }

    logger.info(`Version change detected: ${lastVersion || 'none'} -> ${CURRENT_VERSION}`);
    logger.info('Starting background cleanup of old cache keys...');

    await redis.set(VERSION_KEY, CURRENT_VERSION);

    // Run cleanup in background to not block startup
    cleanOldVersionedKeys().catch(err => {
      logger.error('Background cleanup failed:', err);
    });

  } catch (error: any) {
    logger.error('Failed to check version:', error.message);
  }
}

async function cleanOldVersionedKeys(): Promise<void> {
  if (!redis) return;
  
  const startTime = Date.now();
  let totalDeleted = 0;

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

  const duration = (Date.now() - startTime) / 1000;
  logger.success(`Cleanup complete in ${duration.toFixed(2)}s. Deleted ${totalDeleted} old versioned keys.`);
}