const jikan = require('./mal');
const { cacheWrapJikanApi, cacheWrapCatalog } = require('./getCache');
const { parseAnimeCatalogMetaBatch } = require('../utils/parseProps');

// Environment variable configuration with sensible defaults
const WARMUP_MODE = process.env.CACHE_WARMUP_MODE || 'essential'; // 'essential', 'comprehensive'
const WARMUP_CONFIG = {
  // UUID to use for cache warming (uses this user's config for providers, language, etc.)
  uuid: process.env.CACHE_WARMUP_UUID || 'system-cache-warmer', // Default: system-cache-warmer
  
  // Enable/disable warmup entirely
  enabled: process.env.MAL_WARMUP_ENABLED !== 'false' && WARMUP_MODE === 'essential', // Default: true
  
  // Run warmup every N hours (default: 6 hours)
  intervalHours: parseInt(process.env.MAL_WARMUP_INTERVAL_HOURS) || 6,
  
  // Delay in seconds before first warmup after server start (default: 30s)
  initialDelaySeconds: parseInt(process.env.MAL_WARMUP_INITIAL_DELAY_SECONDS) || 30,
  
  // Extra delay between warmup tasks in ms (default: 100ms)
  taskDelayMs: parseInt(process.env.MAL_WARMUP_TASK_DELAY_MS) || 100,
  
  // Enable quiet hours mode (only run during specific UTC hours)
  quietHoursEnabled: process.env.MAL_WARMUP_QUIET_HOURS_ENABLED === 'true', // Default: false
  
  // Quiet hours range in UTC (format: "2-8" means 2:00 AM to 8:00 AM UTC)
  quietHoursRange: process.env.MAL_WARMUP_QUIET_HOURS_RANGE || '2-8',
  
  // Number of pages to warm for high-priority catalogs (default: 2)
  priorityPages: parseInt(process.env.MAL_WARMUP_PRIORITY_PAGES) || 2,
  
  
  // Enable/disable specific catalog types
  warmMetadata: false, // Deprecated: handled by essential content warmer  
  warmPriority: process.env.MAL_WARMUP_PRIORITY !== 'false', // Default: true
  warmSchedule: process.env.MAL_WARMUP_SCHEDULE !== 'false', // Default: true
  warmDecades: process.env.MAL_WARMUP_DECADES === 'true', // Default: false (opt-in)
  
  // SFW mode for warmup requests
  sfw: process.env.MAL_WARMUP_SFW !== 'false', // Default: true
  
  // Log verbosity (silent, normal, verbose)
  logLevel: process.env.MAL_WARMUP_LOG_LEVEL || 'normal',
};

class MALCatalogWarmer {
  constructor() {
    this.isWarming = false;
    this.shouldStop = false; // Flag for graceful stop
    this.warmupStats = {
      lastRun: null,
      itemsWarmed: 0,
      errors: 0,
      duration: 0,
      phase: null,
      nextRun: null
    };
    this.intervalHandle = null;
    this.log('info', `MAL Catalog Warmer initialized with config:`, {
      enabled: WARMUP_CONFIG.enabled,
      intervalHours: WARMUP_CONFIG.intervalHours,
      quietHours: WARMUP_CONFIG.quietHoursEnabled ? WARMUP_CONFIG.quietHoursRange : 'disabled',
      priorityPages: WARMUP_CONFIG.priorityPages
    });
  }

  /**
   * Request to stop warming operations gracefully
   */
  stopWarming() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    
    if (this.isWarming) {
      this.shouldStop = true;
      this.log('info', 'Stop requested - will stop after current operation');
      return { success: true, message: 'MAL warming will stop after current operation' };
    }
    return { success: true, message: 'MAL warming stopped' };
  }

  /**
   * Check if warming should continue
   */
  shouldContinueWarming() {
    return !this.shouldStop;
  }

  log(level, message, data = null) {
    const logLevel = WARMUP_CONFIG.logLevel;
    
    // Silent mode - no logs
    if (logLevel === 'silent') return;
    
    // Normal mode - only info and errors
    if (logLevel === 'normal' && level === 'debug') return;
    
    const prefix = '[MAL Warmer]';
    if (data) {
      console.log(`${prefix} ${message}`, data);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }

  async startBackgroundWarming() {
    if (!WARMUP_CONFIG.enabled) {
      const mode = process.env.CACHE_WARMUP_MODE || 'essential';
      this.log('info', `MAL catalog warming disabled (CACHE_WARMUP_MODE=${mode})`);
      this.log('info', 'MAL warming runs in essential mode only. Set CACHE_WARMUP_MODE=essential to enable');
      return;
    }

    this.log('info', `Starting MAL background catalog warming (mode: ${WARMUP_MODE})...`);
    
    // Check if we need to warm immediately (on startup)
    const intervalMs = WARMUP_CONFIG.intervalHours * 60 * 60 * 1000;
    
    // Check last warmup time and only run if interval has elapsed
    setTimeout(async () => {
      const shouldWarm = await this.shouldWarmup();
      if (shouldWarm) {
        this.runWarmup();
      } else {
        this.log('info', 'Skipping initial warmup - recently warmed');
      }
    }, WARMUP_CONFIG.initialDelaySeconds * 1000);
    
    // Schedule recurring warmups (check interval each time)
    this.intervalHandle = setInterval(async () => {
      const shouldWarm = await this.shouldWarmup();
      if (shouldWarm) {
        this.runWarmup();
      }
    }, intervalMs);
    
    this.log('info', `Warmup scheduled to check every ${WARMUP_CONFIG.intervalHours} hours`);
  }

  async shouldWarmup() {
    const redis = require('./redisClient');
    const WARM_INTERVAL_MS = WARMUP_CONFIG.intervalHours * 60 * 60 * 1000;
    
    try {
      const lastWarmKey = 'cache-warming:last-mal-warm';
      const lastWarm = await redis.get(lastWarmKey);
      
      if (!lastWarm) {
        this.log('info', 'No previous warmup found, warming now');
        return true; // Never warmed before
      }
      
      const lastWarmTime = parseInt(lastWarm, 10);
      const timeSinceLastWarm = Date.now() - lastWarmTime;
      
      if (timeSinceLastWarm >= WARM_INTERVAL_MS) {
        const hoursSince = Math.round(timeSinceLastWarm / 1000 / 60 / 60);
        this.log('info', `${hoursSince}h since last MAL warming (threshold: ${WARMUP_CONFIG.intervalHours}h), warming now`);
        return true;
      }
      
      const minutesSince = Math.round(timeSinceLastWarm / 1000 / 60);
      const minutesUntilNext = Math.round((WARM_INTERVAL_MS - timeSinceLastWarm) / 1000 / 60);
      this.log('info', `MAL catalogs warmed ${minutesSince}min ago, skipping (next in ${minutesUntilNext}min)`);
      
      // Update next run time
      this.warmupStats.nextRun = new Date(lastWarmTime + WARM_INTERVAL_MS);
      return false;
    } catch (error) {
      this.log('info', `Failed to check warming interval: ${error.message}, proceeding with warming`);
      return true; // Warm on error to be safe
    }
  }

  async markWarmed() {
    const redis = require('./redisClient');
    try {
      const lastWarmKey = 'cache-warming:last-mal-warm';
      await redis.set(lastWarmKey, Date.now().toString());
      this.log('debug', 'Marked MAL warmup timestamp in Redis');
    } catch (error) {
      this.log('debug', `Failed to mark warming timestamp: ${error.message}`);
    }
  }

  async runWarmup() {
    if (this.isWarming) {
      this.log('info', 'Warmup already in progress, skipping...');
      return;
    }

    // Check if we're in quiet hours
    if (WARMUP_CONFIG.quietHoursEnabled) {
      const inQuietHours = this.isInQuietHours();
      if (!inQuietHours) {
        const now = new Date();
        this.log('info', `Outside quiet hours (current time: ${now.getUTCHours()}:00 UTC), skipping warmup...`);
        return;
      }
    }

    // Reset stop flag at start
    this.shouldStop = false;
    this.isWarming = true;
    const startTime = Date.now();
    let itemsWarmed = 0;
    let errors = 0;

    this.log('info', '🔥 Starting catalog warmup cycle...');

    try {
          // Phase 1: Metadata warming is handled by essential content warmer
      // (skipping to avoid duplication)
      
      // Phase 2: Warm up high-priority catalogs
      if (WARMUP_CONFIG.warmPriority && this.shouldContinueWarming()) {
        this.warmupStats.phase = 'priority';
        this.log('info', '⭐ Phase 2: Warming high-priority catalogs...');
        const count = await this.warmPriorityCatalogs();
        itemsWarmed += count;
        this.log('debug', `Priority phase complete: ${count} items warmed`);
        
        await this.delay(1000);
      }
      
      // Phase 3: Warm up schedule catalogs
      if (WARMUP_CONFIG.warmSchedule && this.shouldContinueWarming()) {
        this.warmupStats.phase = 'schedule';
        this.log('info', '📅 Phase 3: Warming schedule catalogs...');
        const count = await this.warmScheduleCatalogs();
        itemsWarmed += count;
        this.log('debug', `Schedule phase complete: ${count} items warmed`);
        
        await this.delay(1000);
      }

      // Phase 4: Warm up decade catalogs (optional, off by default)
      if (WARMUP_CONFIG.warmDecades && this.shouldContinueWarming()) {
        this.warmupStats.phase = 'decades';
        this.log('info', '📆 Phase 4: Warming decade catalogs...');
        const count = await this.warmDecadeCatalogs();
        itemsWarmed += count;
        this.log('debug', `Decade phase complete: ${count} items warmed`);
      }

    } catch (error) {
      this.log('info', `❌ Error during warmup: ${error.message}`);
      errors++;
    } finally {
      this.isWarming = false;
      const duration = Date.now() - startTime;
      const stoppedEarly = this.shouldStop;
      this.shouldStop = false; // Reset stop flag
      
      const nextRun = new Date(Date.now() + WARMUP_CONFIG.intervalHours * 60 * 60 * 1000);
      
      this.warmupStats = {
        lastRun: new Date(),
        itemsWarmed,
        errors,
        duration: Math.round(duration / 1000), // seconds
        phase: 'complete',
        nextRun
      };
      
      // Mark this warmup as complete in Redis
      await this.markWarmed();
      
      this.log('info', `${stoppedEarly ? '🛑 Warmup stopped' : '✅ Warmup complete'}: ${itemsWarmed} items, ${errors} errors, ${this.warmupStats.duration}s. Next run: ${nextRun.toISOString()}`);
    }
  }

  isInQuietHours() {
    const now = new Date();
    const hour = now.getUTCHours();
    const [start, end] = WARMUP_CONFIG.quietHoursRange.split('-').map(h => parseInt(h.trim()));
    
    if (start < end) {
      // Normal range: e.g., 2-8 means 2:00 to 8:00
      return hour >= start && hour < end;
    } else {
      // Wrap-around range: e.g., 22-6 means 22:00 to 6:00 next day
      return hour >= start || hour < end;
    }
  }

  async warmMetadata() {
    // Studios and seasons are already warmed by the essential content warmer
    // (see warmEssentialContent in cacheWarmer.js)
    this.log('debug', 'Skipping metadata warming (handled by essential content warmer)');
    return 0;
  }

  async warmPriorityCatalogs() {
    let count = 0;
    const config = { sfw: WARMUP_CONFIG.sfw };
    const pages = WARMUP_CONFIG.priorityPages;
    const language = 'en-US';
    
    // Import required functions
    const { loadConfigFromDatabase } = require('./configApi.js');
    const { ensureSystemConfig } = require('./cacheWarmer.js'); 
    
    // Use configured UUID for warming
    const systemUUID = WARMUP_CONFIG.uuid;

    try {
      await ensureSystemConfig();
    } catch (error) {
      this.log('warn', `Failed to ensure system config exists: ${error.message}`);
    }

    let warmingConfig;
    
    try {
      warmingConfig = await loadConfigFromDatabase(systemUUID);
    } catch (error) {
      this.log('debug', `Failed to load system config: ${error.message}`);
      warmingConfig = config;
    }
    
    // Find catalog config for per-catalog settings (like enableRatingPosters)
    const findCatalogConfig = (catalogId) => {
      return warmingConfig.catalogs?.find(c => c.id === catalogId);
    };
    
    const catalogMap = {
      'airing-now': 'mal.airing',
      'top-anime': 'mal.top_anime',
      'top-movies': 'mal.top_movies',
      'top-series': 'mal.top_series',
      'most-popular': 'mal.most_popular',
      'most-favorites': 'mal.most_favorites',
      '2020s-decade': 'mal.20sDecade'
    };
    
    const catalogFunctions = [
      { fn: () => jikan.getAiringNow, name: 'airing-now', catalogId: 'mal.airing', hasGenreId: false },
      { fn: () => jikan.getTopAnimeByType, name: 'top-anime', catalogId: 'mal.top_anime', args: ['anime'], hasGenreId: false },
      { fn: () => jikan.getTopAnimeByType, name: 'top-movies', catalogId: 'mal.top_movies', args: ['movie'], hasGenreId: false },
      { fn: () => jikan.getTopAnimeByType, name: 'top-series', catalogId: 'mal.top_series', args: ['tv'], hasGenreId: false },
      { fn: () => jikan.getTopAnimeByFilter, name: 'most-popular', catalogId: 'mal.most_popular', args: ['bypopularity'], hasGenreId: false },
      { fn: () => jikan.getTopAnimeByFilter, name: 'most-favorites', catalogId: 'mal.most_favorites', args: ['favorite'], hasGenreId: false },
      { fn: () => jikan.getTopAnimeByDateRange, name: '2020s-decade', catalogId: 'mal.20sDecade', args: ['2020-01-01', '2029-12-31'], hasGenreId: true },
    ];
    
    for (const catalog of catalogFunctions) {
      // Check stop flag before each catalog
      if (!this.shouldContinueWarming()) {
        this.log('info', 'Stop requested - stopping priority catalog warming');
        break;
      }
      
      for (let page = 1; page <= pages; page++) {
        // Check stop flag before each page
        if (!this.shouldContinueWarming()) {
          break;
        }
        
        try {
          this.log('debug', `Warming ${catalog.name} page ${page}...`);
          
          // Build catalog key EXACTLY like the route does:
          // For MAL catalogs: pageSize = 25
          // Page 1: skip=0 (no skip in extraArgs) → {}
          // Page 2: skip=25 → {"skip":"25"}
          const pageSize = 25;
          const skip = page > 1 ? (page - 1) * pageSize : 0;
          const extraArgs = skip > 0 ? { skip: skip.toString() } : {};
          const catalogKey = `${catalog.catalogId}:anime:${JSON.stringify(extraArgs || {})}`;
          
          // Set current catalog config for per-catalog settings (like enableRatingPosters)
          warmingConfig._currentCatalogConfig = findCatalogConfig(catalog.catalogId);
          
          // Wrap in cacheWrapCatalog just like the catalog route
          const result = await cacheWrapCatalog(systemUUID, catalogKey, async () => {
            const fn = catalog.fn();
            const args = catalog.args || [];
            // Function signatures:
            // getAiringNow(page, config)
            // getTopAnimeByType(type, page, config)
            // getTopAnimeByFilter(filter, page, config)
            // getTopAnimeByDateRange(startDate, endDate, page, genreId, config)
            const animeResults = catalog.hasGenreId 
              ? await cacheWrapJikanApi(`mal-${catalog.name}-${page}-${warmingConfig.sfw}`, async () => {
                  return await fn(...args, page, null, warmingConfig);  // Has genreId param
                }, null, { skipVersion: true })
              : await cacheWrapJikanApi(`mal-${catalog.name}-${page}-${warmingConfig.sfw}`, async () => {
                  return await fn(...args, page, warmingConfig);        // No genreId param
                }, null, { skipVersion: true });
            const metas = await parseAnimeCatalogMetaBatch(animeResults, warmingConfig, language);
            return { metas };
          }, { enableErrorCaching: false, maxRetries: 1 });
          
          if (result && result.metas && result.metas.length > 0) {
            this.log('debug', `Cached ${result.metas.length} items from ${catalog.name} page ${page}`);
            count++;
          }
          
          await this.delay(WARMUP_CONFIG.taskDelayMs);
        } catch (error) {
          this.log('debug', `Error warming ${catalog.name} page ${page}: ${error.message}`);
        }
      }
    }
    
    return count;
  }

  async warmScheduleCatalogs() {
    let count = 0;
    const config = { sfw: WARMUP_CONFIG.sfw };
    const language = 'en-US';
    
    const { loadConfigFromDatabase } = require('./configApi.js');
    const { ensureSystemConfig } = require('./cacheWarmer.js'); 

    const systemUUID = WARMUP_CONFIG.uuid;

    try {
      await ensureSystemConfig();
    } catch (error) {
      this.log('warn', `Failed to ensure system config exists: ${error.message}`);
    }

    let warmingConfig;
    
    try {
      warmingConfig = await loadConfigFromDatabase(systemUUID);
    } catch (error) {
      this.log('debug', `Failed to load system config: ${error.message}`);
      warmingConfig = config;
    }
    
    // Set catalog config for mal.schedule
    warmingConfig._currentCatalogConfig = warmingConfig.catalogs?.find(c => c.id === 'mal.schedule');
    
    // Warm current day and next day (most likely to be accessed)
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const today = new Date().getDay();
    const currentDay = days[(today + 6) % 7]; // Convert Sunday=0 to Monday=0
    const nextDay = days[(today + 7) % 7];
    
    for (const day of [currentDay, nextDay]) {
      // Check stop flag before each day
      if (!this.shouldContinueWarming()) {
        this.log('info', 'Stop requested - stopping schedule catalog warming');
        break;
      }
      
      try {
        this.log('debug', `Warming schedule: ${day}...`);
        
        // Build key exactly like route: mal.schedule with genre parameter
        // Capitalize day name to match route (Monday, not monday)
        const dayCapitalized = day.charAt(0).toUpperCase() + day.slice(1);
        const extraArgs = { genre: dayCapitalized };
        const catalogKey = `mal.schedule:anime:${JSON.stringify(extraArgs || {})}`;
        
        const result = await cacheWrapCatalog(systemUUID, catalogKey, async () => {
          // getAiringSchedule(day, page, config)
          const animeResults = await cacheWrapJikanApi(`mal-schedule-${day}-1-${warmingConfig.sfw}`, async () => {
            return await jikan.getAiringSchedule(day, 1, warmingConfig);
          }, null, { skipVersion: true });
          const metas = await parseAnimeCatalogMetaBatch(animeResults, warmingConfig, language);
          return { metas };
        }, { enableErrorCaching: false, maxRetries: 1 });
        
        if (result && result.metas && result.metas.length > 0) {
          this.log('debug', `Cached ${result.metas.length} items from schedule ${day}`);
          count++;
        }
        
        await this.delay(WARMUP_CONFIG.taskDelayMs);
      } catch (error) {
        this.log('debug', `Error warming schedule ${day}: ${error.message}`);
      }
    }
    
    return count;
  }

  async warmDecadeCatalogs() {
    let count = 0;
    const config = { sfw: WARMUP_CONFIG.sfw };
    const language = 'en-US';
    
    const { loadConfigFromDatabase } = require('./configApi.js');
    const { ensureSystemConfig } = require('./cacheWarmer.js'); 
    
    const systemUUID = WARMUP_CONFIG.uuid;

    try {
      await ensureSystemConfig();
    } catch (error) {
      this.log('warn', `Failed to ensure system config exists: ${error.message}`);
    }

    let warmingConfig;
    
    try {
      warmingConfig = await loadConfigFromDatabase(systemUUID);
    } catch (error) {
      this.log('debug', `Failed to load system config: ${error.message}`);
      warmingConfig = config;
    }
    
    // Only warm older decades (80s, 90s, 00s, 10s) - 20s is in priority
    const decades = [
      { id: '2010s', catalogId: 'mal.10sDecade', start: '2010-01-01', end: '2019-12-31' },
      { id: '2000s', catalogId: 'mal.00sDecade', start: '2000-01-01', end: '2009-12-31' },
      { id: '1990s', catalogId: 'mal.90sDecade', start: '1990-01-01', end: '1999-12-31' },
      { id: '1980s', catalogId: 'mal.80sDecade', start: '1980-01-01', end: '1989-12-31' },
    ];
    
    try {
      for (const decade of decades) {
        // Check stop flag before each decade
        if (!this.shouldContinueWarming()) {
          this.log('info', 'Stop requested - stopping decade catalog warming');
          break;
        }
        
        try {
          this.log('debug', `Warming decade: ${decade.id}...`);
          
          // Set current catalog config for per-catalog settings (like enableRatingPosters)
          warmingConfig._currentCatalogConfig = warmingConfig.catalogs?.find(c => c.id === decade.catalogId);
          
          // Decade catalogs are page 1 only, no skip
          const catalogKey = `${decade.catalogId}:anime:{}`;
          
          const result = await cacheWrapCatalog(systemUUID, catalogKey, async () => {
            // getTopAnimeByDateRange(startDate, endDate, page, genreId, config)
            const animeResults = await cacheWrapJikanApi(`mal-${decade.catalogId}-1-${warmingConfig.sfw}`, async () => {
              return await jikan.getTopAnimeByDateRange(decade.start, decade.end, 1, null, warmingConfig);
            }, null, { skipVersion: true });
            const metas = await parseAnimeCatalogMetaBatch(animeResults, warmingConfig, language);
            return { metas };
          }, { enableErrorCaching: false, maxRetries: 1 });
          
          if (result && result.metas && result.metas.length > 0) {
            this.log('debug', `Cached ${result.metas.length} items from decade ${decade.id}`);
            count++;
          }
          
          await this.delay(WARMUP_CONFIG.taskDelayMs);
        } catch (error) {
          this.log('debug', `Error warming decade ${decade.id}: ${error.message}`);
        }
      }
    } catch (error) {
      this.log('info', `Error warming decade catalogs: ${error.message}`);
    }
    
    return count;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStats() {
    return {
      ...this.warmupStats,
      isWarming: this.isWarming,
      enabled: WARMUP_CONFIG.enabled,
      config: {
        enabled: WARMUP_CONFIG.enabled,
        intervalHours: WARMUP_CONFIG.intervalHours,
        quietHoursEnabled: WARMUP_CONFIG.quietHoursEnabled,
        quietHoursRange: WARMUP_CONFIG.quietHoursRange,
        priorityPages: WARMUP_CONFIG.priorityPages,
        phases: {
          metadata: WARMUP_CONFIG.warmMetadata,
          priority: WARMUP_CONFIG.warmPriority,
          schedule: WARMUP_CONFIG.warmSchedule,
          decades: WARMUP_CONFIG.warmDecades,
        }
      }
    };
  }

  /**
   * Force run warmup immediately, bypassing interval check and enabled check
   * Returns a result object for API feedback
   */
  forceRunWarmup() {
    if (this.isWarming) {
      return { success: false, message: 'MAL warming is already running' };
    }

    const wasDisabled = !WARMUP_CONFIG.enabled;
    if (wasDisabled) {
      this.log('info', 'Force run requested - warming is disabled but running anyway');
    } else {
      this.log('info', 'Force run requested - bypassing interval check');
    }
    
    // Run warmup in background (fire-and-forget)
    this.runWarmup();
    
    return { 
      success: true, 
      message: wasDisabled ? 'MAL catalog warming started (forced while disabled)' : 'MAL catalog warming started'
    };
  }

  stop() {
    return this.stopWarming();
  }
}

// Export singleton instance
const warmer = new MALCatalogWarmer();

module.exports = {
  startMALWarmup: () => warmer.startBackgroundWarming(),
  stopMALWarmup: () => warmer.stopWarming(),
  forceRunMALWarmup: () => warmer.forceRunWarmup(),
  getWarmupStats: () => warmer.getStats(),
  warmer // Export instance for testing
};

