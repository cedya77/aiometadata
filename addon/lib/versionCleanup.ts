import redis from './redisClient';
import packageJson from '../../package.json';
import consola from 'consola';

const logger = consola.withTag('Version-Cleanup');

const CURRENT_VERSION = packageJson.version;
const VERSION_KEY = 'system:app_version';

export async function performVersionCleanup(): Promise<void> {
  if (!redis) return;

  try {
    const lastVersion = await redis.get(VERSION_KEY);

    if (lastVersion === CURRENT_VERSION) {
      logger.info(`App version match (${CURRENT_VERSION}). No cleanup needed.`);
      return;
    }

    logger.info(`Version change detected: ${lastVersion || 'none'} -> ${CURRENT_VERSION}`);
    logger.info('Starting background cleanup of old cache keys...');

    await redis.set(VERSION_KEY, CURRENT_VERSION);

    cleanOldKeys(lastVersion).catch(err => {
      logger.error('Background cleanup failed:', err);
    });

  } catch (error: any) {
    logger.error('Failed to check version:', error.message);
  }
}

async function cleanOldKeys(lastVersion: string | null): Promise<void> {
  if (!redis) return;
  const startTime = Date.now();
  let deletedCount = 0;
  let scannedCount = 0;
  
  const currentPrefix = `v${CURRENT_VERSION}:`;
  const globalPrefix = `global:${CURRENT_VERSION}:`;
  const versionRegex = /^v\d+\.\d+\.\d+:/; 

  let cursor = '0';
  do {
    const result = await redis.scan(cursor, 'MATCH', '*', 'COUNT', 1000);
    cursor = result[0];
    const keys = result[1];

    if (keys.length > 0) {
      const keysToDelete: string[] = [];
      
      for (const key of keys) {
        // 1. Check for Standard Cache Keys (vX.X.X:...)
        if (key.startsWith('v')) {
           // If it looks like a versioned key (v1.2.3:...) AND doesn't match current prefix
           if (versionRegex.test(key) && !key.startsWith(currentPrefix)) {
               keysToDelete.push(key);
           }
        }
        // 2. Check for Global Cache Keys (global:X.X.X:...)
        else if (key.startsWith('global:')) {
           if (!key.startsWith(globalPrefix)) {
               const parts = key.split(':');
               if (parts.length > 1 && /^\d+\.\d+\.\d+$/.test(parts[1])) {
                   keysToDelete.push(key);
               }
           }
        }
      }

      if (keysToDelete.length > 0) {
        await redis.del(keysToDelete);
        deletedCount += keysToDelete.length;
        logger.info(`Deleted ${keysToDelete.length} old keys.`);
      }
    }
    scannedCount += keys.length;
    logger.info(`Scanned ${scannedCount} keys.`);
    
    // Sleep briefly every 10k keys to prevent blocking Redis
    if (scannedCount % 10000 === 0) {
       await new Promise(resolve => setTimeout(resolve, 10));
    }

  } while (cursor !== '0');

  const duration = (Date.now() - startTime) / 1000;
  logger.success(`Cleanup complete in ${duration}s. Deleted ${deletedCount} old keys from ${lastVersion || 'unknown'}.`);
}