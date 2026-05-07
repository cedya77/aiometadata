const fs: any = require('fs').promises;
const path: any = require('path');
const redis: any = require('./redisClient');

const MIGRATION_VERSION = 'cache-path-fix-v1';
const MIGRATION_KEY = `migration:${MIGRATION_VERSION}`;
const CACHE_DIR = path.join(process.cwd(), 'addon', 'data');
const MIGRATION_FLAG_FILE = path.join(CACHE_DIR, '.migration-completed');

const CACHE_FILES = [
  'anime-list-full.json.cache',
  'imdb_mapping.json.cache',
  'anime-list-full.xml.cache',
  'tv_mappings.csv.cache',
  'movie_mappings.csv.cache'
];

const ETAG_KEYS = [
  'anime-list-etag',
  'kitsu-to-imdb-etag',
  'anime-list-xml-etag',
  'wiki-mapper-series-etag',
  'wiki-mapper-movies-etag'
];

async function runCachePathMigration(): Promise<void> {
  console.log('[Cache Migration] Checking for cache path migration...');

  try {
    try {
      const flagContent = await fs.readFile(MIGRATION_FLAG_FILE, 'utf-8');
      const flagData = JSON.parse(flagContent);
      if (flagData.version === MIGRATION_VERSION && flagData.completed === true) {
        console.log('[Cache Migration] Migration already completed (flag file exists), skipping.');
        return;
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.warn('[Cache Migration] Error reading migration flag:', error.message);
      }
    }

    if (redis && redis.status === 'ready') {
      try {
        const migrationCompleted = await redis.get(MIGRATION_KEY);
        if (migrationCompleted === 'completed') {
          console.log('[Cache Migration] Migration already completed (Redis flag exists), skipping.');
          await fs.writeFile(MIGRATION_FLAG_FILE, JSON.stringify({
            version: MIGRATION_VERSION,
            completed: true,
            timestamp: new Date().toISOString()
          }), 'utf-8');
          return;
        }
      } catch (error: any) {
        console.warn('[Cache Migration] Redis check failed:', error.message);
      }
    }

    let filesFound = false;
    let filesDeleted = 0;

    for (const cacheFile of CACHE_FILES) {
      const filePath = path.join(CACHE_DIR, cacheFile);
      try {
        const stats = await fs.stat(filePath);
        filesFound = true;

        await fs.unlink(filePath);
        filesDeleted++;
        console.log(`[Cache Migration] Deleted old cache file: ${cacheFile} (last modified: ${stats.mtime.toISOString()})`);
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          console.warn(`[Cache Migration] Error checking ${cacheFile}:`, error.message);
        }
      }
    }

    if (redis && redis.status === 'ready') {
      for (const etagKey of ETAG_KEYS) {
        try {
          await redis.del(etagKey);
          console.log(`[Cache Migration] Cleared ETag: ${etagKey}`);
        } catch (error: any) {
          console.warn(`[Cache Migration] Error clearing ETag ${etagKey}:`, error.message);
        }
      }

      try {
        await redis.set(MIGRATION_KEY, 'completed', 'EX', 86400 * 365);
      } catch (error: any) {
        console.warn('[Cache Migration] Failed to set Redis flag:', error.message);
      }
    }

    try {
      await fs.writeFile(MIGRATION_FLAG_FILE, JSON.stringify({
        version: MIGRATION_VERSION,
        completed: true,
        timestamp: new Date().toISOString(),
        filesDeleted: filesDeleted
      }), 'utf-8');
      console.log('[Cache Migration] Created migration flag file.');
    } catch (error: any) {
      console.error('[Cache Migration] CRITICAL: Failed to create migration flag file:', error.message);
      console.error('[Cache Migration] Migration may run again on next restart!');
    }

    console.log(`[Cache Migration] Migration completed. Deleted ${filesDeleted} cache files and cleared ${ETAG_KEYS.length} ETags.`);

    if (filesFound) {
      console.log('[Cache Migration] Fresh data will be downloaded on next initialization.');
    } else {
      console.log('[Cache Migration] No old cache files found.');
    }

  } catch (error: any) {
    console.error('[Cache Migration] Migration failed:', error.message);
    console.error('[Cache Migration] Continuing startup anyway...');
  }
}

export { runCachePathMigration };
module.exports = { runCachePathMigration };
