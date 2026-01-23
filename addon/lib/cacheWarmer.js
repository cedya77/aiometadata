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

// Stop flag for graceful shutdown
let shouldStopWarming = false;
let isCurrentlyWarming = false;
let lastWarmingRun = null;
let nextWarmingRun = null;
let warmingItemsCount = 0;
let warmingIntervalMinutes = 30; // Default interval

/**
 * Request to stop warming operations
 */
function stopWarming() {
  if (isCurrentlyWarming) {
    shouldStopWarming = true;
    logger.info('[Cache Warming] Stop requested - will stop after current operation');
    return { success: true, message: 'Essential warming will stop after current operation' };
  }
  return { success: true, message: 'Essential warming is not currently running' };
}

/**
 * Check if warming should continue
 */
function shouldContinueWarming() {
  return !shouldStopWarming;
}

/**
 * Warm essential content that users commonly access
 */
async function warmEssentialContent() {
  // Reset stop flag at start
  shouldStopWarming = false;
  isCurrentlyWarming = true;
  
  try {
    logger.info('[Cache Warming] Warming essential content...');
    
    // Record start time for maintenance tracking
    const startTime = Date.now();
    lastWarmingRun = startTime;
    warmingItemsCount = 0;
    
    // Warm TMDB genres
    if (!shouldContinueWarming()) { isCurrentlyWarming = false; return; }
    await getGenreList('tmdb', 'en-US', 'movie', {});
    warmingItemsCount++;
    
    if (!shouldContinueWarming()) { isCurrentlyWarming = false; return; }
    await getGenreList('tmdb', 'en-US', 'series', {});
    warmingItemsCount++;
    
    // Warm TVDB genres
    if (!shouldContinueWarming()) { isCurrentlyWarming = false; return; }
    await getGenreList('tvdb', 'en-US', 'series', {});
    warmingItemsCount++;
    
    // Warm MAL genres
    if (!shouldContinueWarming()) { isCurrentlyWarming = false; return; }
    await cacheWrapJikanApi('anime-genres', async () => {
      return await mal.getAnimeGenres();
    }, null, { skipVersion: true });
    warmingItemsCount++;
    
    // Warm MAL studios
    if (!shouldContinueWarming()) { isCurrentlyWarming = false; return; }
    await cacheWrapJikanApi('mal-studios', async () => {
      return await mal.getStudios(100);
    }, 30 * 24 * 60 * 1000, { skipVersion: true }); // Cache for 30 days
    warmingItemsCount++;
    
    // Warm MAL available seasons
    if (!shouldContinueWarming()) { isCurrentlyWarming = false; return; }
    await cacheWrapJikanApi('mal-available-seasons', async () => {
      return await mal.getAvailableSeasons();
    }, 7 * 24 * 60 * 60, { skipVersion: true }); // Cache for 7 days (seasons only change quarterly)
    warmingItemsCount++;
    
    // Warm TVDB collections (first page)
    if (!shouldContinueWarming()) { isCurrentlyWarming = false; return; }
    await cacheWrapTvdbApi('collections-list:0', async () => {
      return await tvdb.getCollectionsList({}, 0);
    });
    warmingItemsCount++;
    
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
    if (error && error.stack) {
      logger.error('[Cache Warming] Stack:', error.stack);
    }
  } finally {
    isCurrentlyWarming = false;
    shouldStopWarming = false;
  }
}

/**
 * Ensure system cache warmer config exists in database
 */
async function ensureSystemConfig() {
  const database = require('./database');
  const crypto = require('crypto');
  const systemUUID = process.env.CACHE_WARMUP_UUID || 'system-cache-warmer';
  const systemPasswordHash = crypto.createHash('sha256').update('system-internal').digest('hex');
  
  try {
    // Check if system config already exists
    const existingConfig = await database.getUserConfig(systemUUID);
    if (existingConfig) {
      // Only auto-update if using the default system config (not a user's custom UUID)
      const isSystemConfig = systemUUID === 'system-cache-warmer';
      if (isSystemConfig) {
        let configUpdated = false;
        
        // Update anime art providers if they're outdated (tvdb -> mal/imdb)
        if (existingConfig.artProviders?.anime?.poster === 'tvdb') {
          logger.info('[System Config] Updating anime art providers to use MAL posters and IMDb backgrounds/logos');
          existingConfig.artProviders.anime = { poster: 'mal', background: 'imdb', logo: 'imdb' };
          configUpdated = true;
        }
        
        // Update language if env variable changed
        const envLanguage = process.env.CACHE_WARM_LANGUAGE || 'en-US';
        if (existingConfig.language !== envLanguage) {
          logger.info(`[System Config] Updating cache warming language from ${existingConfig.language} to ${envLanguage}`);
          existingConfig.language = envLanguage;
          configUpdated = true;
        }
        
        if (configUpdated) {
          await database.saveUserConfig(systemUUID, systemPasswordHash, existingConfig);
        }
      }
      return systemUUID;
    }
    
    // Create default system config
    const systemConfig = {
      language: process.env.CACHE_WARM_LANGUAGE || 'en-US',
      includeAdult: false,
      blurThumbs: false,
      showPrefix: false,
      showMetaProviderAttribution: false,
      displayAgeRating: false,
      castCount: 10,
      sfw: false,
      hideUnreleasedDigital: false,
      hideUnreleasedDigitalSearch: false,
      providers: { 
        movie: 'tmdb', 
        series: 'tvdb', 
        anime: 'mal', 
        anime_id_provider: 'kitsu',
        forceAnimeForDetectedImdb: false 
      },
      artProviders: { 
        movie: { poster: 'meta', background: 'meta', logo: 'meta' },
        series: { poster: 'meta', background: 'meta', logo: 'meta' },
        anime: { poster: 'mal', background: 'imdb', logo: 'imdb' },
        englishArtOnly: false
      },
      tvdbSeasonType: 'default',
      mal: {
        skipFiller: false, 
        skipRecap: false,
        allowEpisodeMarking: false,
        useImdbIdForCatalogAndSearch: false,
      },
      tmdb: {
        scrapeImdb: false,
      },
      apiKeys: { 
        tmdb: process.env.TMDB_API || process.env.BUILT_IN_TMDB_API_KEY || '',
        tvdb: process.env.TVDB_API_KEY || process.env.BUILT_IN_TVDB_API_KEY || '',
        fanart: process.env.FANART_API_KEY || process.env.BUILT_IN_FANART_API_KEY || '',
        rpdb: process.env.RPDB_API_KEY || process.env.BUILT_IN_RPDB_API_KEY || '',
        mdblist: '' 
      },
      ageRating: 'None',
      catalogs: [],
      search: {
        enabled: true,
        ai_enabled: false,
        providers: {},
        engineEnabled: {}
      },
      streaming: []
    };
    
    await database.saveUserConfig(systemUUID, systemPasswordHash, systemConfig);
    await database.trustUUID(systemUUID);
    
    logger.success(`[Cache Warming] System config created with UUID: ${systemUUID}`);
    return systemUUID;
  } catch (error) {
    logger.error('[Cache Warming] Failed to create system config:', error.message);
    throw error;
  }
}

/**
 * Check if popular content warming is needed based on interval
 */
async function shouldWarmPopularContent() {
  const redis = require('./redisClient');
  const WARM_INTERVAL_MS = Math.max(12, parseInt(process.env.CACHE_WARM_INTERVAL_HOURS || '24', 10)) * 60 * 60 * 1000; // Default 24h, minimum 12h
  
  try {
    const lastWarmKey = 'cache-warming:last-popular-warm';
    const lastWarm = await redis.get(lastWarmKey);
    
    if (!lastWarm) {
      return true; // Never warmed before
    }
    
    const lastWarmTime = parseInt(lastWarm, 10);
    const timeSinceLastWarm = Date.now() - lastWarmTime;
    
    if (timeSinceLastWarm >= WARM_INTERVAL_MS) {
      logger.info(`[Cache Warming] ${Math.round(timeSinceLastWarm / 1000 / 60 / 60)}h since last popular warming (threshold: ${WARM_INTERVAL_MS / 1000 / 60 / 60}h)`);
      return true;
    }
    
    logger.info(`[Cache Warming] Popular content was warmed ${Math.round(timeSinceLastWarm / 1000 / 60)}min ago, skipping (next in ${Math.round((WARM_INTERVAL_MS - timeSinceLastWarm) / 1000 / 60)}min)`);
    return false;
  } catch (error) {
    logger.warn('[Cache Warming] Failed to check warming interval, proceeding with warming:', error.message);
    return true; // Warm on error to be safe
  }
}

/**
 * Mark popular content as warmed
 */
async function markPopularContentWarmed() {
  const redis = require('./redisClient');
  try {
    const lastWarmKey = 'cache-warming:last-popular-warm';
    await redis.set(lastWarmKey, Date.now().toString());
  } catch (error) {
    logger.warn('[Cache Warming] Failed to mark warming timestamp:', error.message);
  }
}

/**
 * Warm related content based on popular items
 */
async function warmPopularContent(force = false) {
  try {
    // Check cache warmup mode - skip if comprehensive only
    const warmupMode = process.env.CACHE_WARMUP_MODE || 'essential';
    if (warmupMode === 'comprehensive') {
      logger.debug('[Cache Warming] Essential warming disabled (CACHE_WARMUP_MODE=comprehensive)');
      return;
    }
    
    // Check if popular warming is disabled
    if (process.env.TMDB_POPULAR_WARMING_ENABLED === 'false') {
      logger.debug('[Cache Warming] TMDB popular content warming is disabled');
      return;
    }
    
    // Check if warming is needed
    if (!force && !(await shouldWarmPopularContent())) {
      return;
    }
    
    const builtInApiKey = process.env.TMDB_API || process.env.BUILT_IN_TMDB_API_KEY;
    if (!builtInApiKey) {
      logger.warn('[Cache Warming] BUILT_IN_TMDB_API_KEY not set, skipping popular content warming');
      return;
    }

    logger.info('[Cache Warming] Warming popular content from TMDB...');
    
    // Ensure system config exists in database
    const systemUUID = await ensureSystemConfig();
    
    const moviedb = require('./getTmdb.js');
    const { cacheWrapMetaSmart } = require('./getCache.js');
    const { loadConfigFromDatabase } = require('./configApi.js');
    
    // Load the system config from database
    const warmingConfig = await loadConfigFromDatabase(systemUUID);
    
    let totalWarmed = 0;

    // Warm trending movies (day) - fetch 10 pages for better coverage
    try {
      for (let page = 1; page <= 10; page++) {
        const trendingMovies = await moviedb.trending(
          { media_type: 'movie', time_window: 'day', page }, 
          warmingConfig
        );
        
        if (trendingMovies?.results) {
          for (const movie of trendingMovies.results) {
            try {
              const stremioId = `tmdb:${movie.id}`;
              await cacheWrapMetaSmart(systemUUID, stremioId, async () => {
                const { getMeta } = require('./getMeta.js');
                return await getMeta('movie', warmingConfig.language, stremioId, warmingConfig, systemUUID, false);
              }, undefined, { enableErrorCaching: false, maxRetries: 1 }, 'movie', false);
              totalWarmed++;
            } catch (err) {
              logger.debug(`[Cache Warming] Failed to warm movie ${movie.id}: ${err.message}`);
            }
          }
        }
      }
    } catch (err) {
      logger.warn(`[Cache Warming] Failed to fetch trending movies: ${err.message}`);
    }

    // Warm trending series (day) - fetch 10 pages for better coverage
    try {
      for (let page = 1; page <= 10; page++) {
        const trendingSeries = await moviedb.trending(
          { media_type: 'tv', time_window: 'day', page }, 
          warmingConfig
        );
        
        if (trendingSeries?.results) {
          for (const series of trendingSeries.results) {
            try {
              const stremioId = `tmdb:${series.id}`;
              await cacheWrapMetaSmart(systemUUID, stremioId, async () => {
                const { getMeta } = require('./getMeta.js');
                return await getMeta('series', warmingConfig.language, stremioId, warmingConfig, systemUUID, false);
              }, undefined, { enableErrorCaching: false, maxRetries: 1 }, 'series', false);
              totalWarmed++;
            } catch (err) {
              logger.debug(`[Cache Warming] Failed to warm series ${series.id}: ${err.message}`);
            }
          }
        }
      }
    } catch (err) {
      logger.warn(`[Cache Warming] Failed to fetch trending series: ${err.message}`);
    }
    
    logger.success(`[Cache Warming] Popular content warming completed (${totalWarmed} items cached)`);
    
    // Mark warming as complete
    await markPopularContentWarmed();
  } catch (error) {
    logger.error('[Cache Warming] Error warming popular content:', error.message);
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
  warmingIntervalMinutes = intervalMinutes;
  logger.info(`[Cache Warming] Scheduling periodic warming every ${intervalMinutes} minutes`);
  
  // Calculate initial next run time
  nextWarmingRun = Date.now() + (intervalMinutes * 60 * 1000);
  
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
    
    // Update next run time after warming completes
    nextWarmingRun = Date.now() + intervalMs;
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



/**
 * Get warming stats for dashboard
 */
function getWarmupStats() {
  return {
    enabled: process.env.ENABLE_CACHE_WARMING !== 'false',
    isWarming: isCurrentlyWarming,
    lastRun: lastWarmingRun,
    nextRun: nextWarmingRun,
    intervalMinutes: warmingIntervalMinutes,
    totalItems: warmingItemsCount,
    mode: process.env.CACHE_WARMUP_MODE || 'essential',
    tmdbPopularEnabled: process.env.TMDB_POPULAR_WARMING_ENABLED !== 'false'
  };
}

module.exports = {
  warmEssentialContent,
  warmPopularContent,
  warmFromUserActivity,
  scheduleEssentialWarming,
  isInitialWarmingComplete,
  getWarmupStats,
  stopWarming,
  WARMING_STRATEGIES,
  ensureSystemConfig
};
