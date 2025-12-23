const fs = require('fs').promises;
const path = require('path');
const redis = require('./redisClient');

/**
 * One-time migration to fix cache files after the path bug fix.
 * 
 * Background: Cache files were incorrectly written to /app/dist/data instead of /app/addon/data
 * due to using __dirname in compiled files. This caused cache files to be lost on restarts.
 */

const MIGRATION_VERSION = 'cache-path-fix-v1';
const MIGRATION_KEY = `migration:${MIGRATION_VERSION}`;
const CACHE_DIR = path.join(process.cwd(), 'addon', 'data');
const MIGRATION_FLAG_FILE = path.join(CACHE_DIR, '.migration-completed');

// Cache files that need migration
const CACHE_FILES = [
  'anime-list-full.json.cache',
  'imdb_mapping.json.cache',
  'anime-list-full.xml.cache',
  'tv_mappings.csv.cache',
  'movie_mappings.csv.cache'
];

// Related Redis ETag keys to clear
const ETAG_KEYS = [
  'anime-list-etag',
  'kitsu-to-imdb-etag',
  'anime-list-xml-etag',
  'wiki-mapper-series-etag',
  'wiki-mapper-movies-etag'
];

async function runCachePathMigration() {
  console.log('[Cache Migration] Checking for cache path migration...');

  try {
    // Check if migration already completed (via filesystem flag - primary check)
    try {
      const flagContent = await fs.readFile(MIGRATION_FLAG_FILE, 'utf-8');
      const flagData = JSON.parse(flagContent);
      if (flagData.version === MIGRATION_VERSION && flagData.completed === true) {
        console.log('[Cache Migration] Migration already completed (flag file exists), skipping.');
        return;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[Cache Migration] Error reading migration flag:', error.message);
      }
      // File doesn't exist, proceed with migration
    }

    // Double-check via Redis if available (backup check)
    if (redis && redis.status === 'ready') {
      try {
        const migrationCompleted = await redis.get(MIGRATION_KEY);
        if (migrationCompleted === 'completed') {
          console.log('[Cache Migration] Migration already completed (Redis flag exists), skipping.');
          // Also create the filesystem flag for future checks
          await fs.writeFile(MIGRATION_FLAG_FILE, JSON.stringify({
            version: MIGRATION_VERSION,
            completed: true,
            timestamp: new Date().toISOString()
          }), 'utf-8');
          return;
        }
      } catch (error) {
        console.warn('[Cache Migration] Redis check failed:', error.message);
      }
    }

    // Check if any cache files exist
    let filesFound = false;
    let filesDeleted = 0;

    for (const cacheFile of CACHE_FILES) {
      const filePath = path.join(CACHE_DIR, cacheFile);
      try {
        const stats = await fs.stat(filePath);
        filesFound = true;
        
        // Delete the file (we'll force fresh downloads)
        await fs.unlink(filePath);
        filesDeleted++;
        console.log(`[Cache Migration] Deleted old cache file: ${cacheFile} (last modified: ${stats.mtime.toISOString()})`);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.warn(`[Cache Migration] Error checking ${cacheFile}:`, error.message);
        }
        // File doesn't exist, skip
      }
    }

    // Clear ETags from Redis to force fresh downloads
    if (redis && redis.status === 'ready') {
      for (const etagKey of ETAG_KEYS) {
        try {
          await redis.del(etagKey);
          console.log(`[Cache Migration] Cleared ETag: ${etagKey}`);
        } catch (error) {
          console.warn(`[Cache Migration] Error clearing ETag ${etagKey}:`, error.message);
        }
      }

      // Mark migration as completed in Redis
      try {
        await redis.set(MIGRATION_KEY, 'completed', 'EX', 86400 * 365); // Keep for 1 year
      } catch (error) {
        console.warn('[Cache Migration] Failed to set Redis flag:', error.message);
      }
    }

    // ALWAYS create filesystem flag to prevent re-running migration
    try {
      await fs.writeFile(MIGRATION_FLAG_FILE, JSON.stringify({
        version: MIGRATION_VERSION,
        completed: true,
        timestamp: new Date().toISOString(),
        filesDeleted: filesDeleted
      }), 'utf-8');
      console.log('[Cache Migration] Created migration flag file.');
    } catch (error) {
      console.error('[Cache Migration] CRITICAL: Failed to create migration flag file:', error.message);
      console.error('[Cache Migration] Migration may run again on next restart!');
    }

    console.log(`[Cache Migration] Migration completed. Deleted ${filesDeleted} cache files and cleared ${ETAG_KEYS.length} ETags.`);

    if (filesFound) {
      console.log('[Cache Migration] Fresh data will be downloaded on next initialization.');
    } else {
      console.log('[Cache Migration] No old cache files found.');
    }

  } catch (error) {
    console.error('[Cache Migration] Migration failed:', error.message);
    console.error('[Cache Migration] Continuing startup anyway...');
  }
}

module.exports = { runCachePathMigration };

