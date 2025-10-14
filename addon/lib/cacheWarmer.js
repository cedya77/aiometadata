// lib/cacheWarmer.js

const { cacheWrapGlobal, cacheWrapJikanApi, cacheWrapTvdbApi } = require('./getCache');
const { getGenreList } = require('./getGenreList');
const mal = require('./mal');
const tvdb = require('./tvdb');
const consola = require('consola');
const logger = consola.withTag('Cache-Warming');

// Warming strategies
const WARMING_STRATEGIES = {
  ESSENTIAL: 'essential',
  RELATED: 'related',
  USER_ACTIVITY: 'user_activity'
};

/**
 * Warm essential content that users commonly access
 */
async function warmEssentialContent() {
  try {
    logger.info('[Cache Warming] Warming essential content...');
    
    // Record start time for maintenance tracking
    const startTime = Date.now();
    
    // Warm TMDB genres
    await getGenreList('tmdb', 'en-US', 'movie', {});
    await getGenreList('tmdb', 'en-US', 'series', {});
    
    // Warm TVDB genres
    await getGenreList('tvdb', 'en-US', 'series', {});
    
    // Warm MAL genres
    await cacheWrapJikanApi('anime-genres', async () => {
      return await mal.getAnimeGenres();
    });
    
    // Warm MAL studios
    await cacheWrapJikanApi('mal-studios', async () => {
      return await mal.getStudios(100);
    }, 30 * 24 * 60 * 1000); // Cache for 30 days
    
    // Warm MAL available seasons
    await cacheWrapJikanApi('mal-available-seasons', async () => {
      return await mal.getAvailableSeasons();
    }, 7 * 24 * 60 * 60); // Cache for 7 days (seasons only change quarterly)
    
    // Warm TVDB collections (first page)
    await cacheWrapTvdbApi('collections-list:0', async () => {
      return await tvdb.getCollectionsList({}, 0);
    });
    
    // Record completion for maintenance tracking
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    try {
      const redis = require('./redisClient');
      await redis.setex('maintenance:last_cache_warming', 86400 * 7, startTime.toString());
      logger.success(`[Cache Warming] Maintenance task tracked: cache warming completed in ${duration}ms`);
    } catch (trackingError) {
      logger.warn('[Cache Warming] Failed to track maintenance task:', trackingError.message);
    }
    
    initialWarmingComplete = true;
    logger.success('[Cache Warming] Essential content warming completed');
  } catch (error) {
    logger.error('[Cache Warming] Error warming essential content:', error.message);
  }
}

/**
 * Warm related content based on popular items
 */
async function warmRelatedContent() {
  try {
    logger.info('[Cache Warming] Warming related content...');
    
    // This could be expanded to warm content based on popular movies/series
    // For now, just log that it's called
    
    logger.success('[Cache Warming] Related content warming completed');
  } catch (error) {
    logger.error('[Cache Warming] Error warming related content:', error.message);
  }
}

/**
 * Warm content based on user activity patterns
 */
async function warmFromUserActivity() {
  try {
    logger.info('[Cache Warming] Warming content from user activity...');
    
    // This could analyze user activity logs and warm frequently accessed content
    // For now, just log that it's called
    
    logger.success('[Cache Warming] User activity warming completed');
  } catch (error) {
    logger.error('[Cache Warming] Error warming from user activity:', error.message);
  }
}

/**
 * Schedule essential warming at regular intervals
 */
function scheduleEssentialWarming(intervalMinutes = 30) {
  logger.info(`[Cache Warming] Scheduling periodic warming every ${intervalMinutes} minutes`);
  
  // Schedule recurring warming (initial warming is done separately)
  const intervalMs = intervalMinutes * 60 * 1000;
  setInterval(async () => {
    logger.info('[Cache Warming] Running scheduled essential warming...');
    
    // Track scheduled maintenance task
    try {
      const redis = require('./redisClient');
      await redis.setex('maintenance:last_cache_warming', 86400 * 7, Date.now().toString());
      logger.success('[Cache Warming] Scheduled maintenance task tracked');
    } catch (trackingError) {
      logger.warn('[Cache Warming] Failed to track scheduled maintenance:', trackingError.message);
    }
    
    await warmEssentialContent();
  }, intervalMs);
}

// Track if initial warming is complete
let initialWarmingComplete = false;

/**
 * Check if initial warming is complete
 */
function isInitialWarmingComplete() {
  return initialWarmingComplete;
}



module.exports = {
  warmEssentialContent,
  warmRelatedContent,
  warmFromUserActivity,
  scheduleEssentialWarming,
  isInitialWarmingComplete,
  WARMING_STRATEGIES
};
