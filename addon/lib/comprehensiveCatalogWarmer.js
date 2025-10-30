require('dotenv').config();
const { cacheWrapCatalog, cacheWrapJikanApi } = require('./getCache');
const { parseAnimeCatalogMetaBatch } = require('../utils/parseProps');
const jikan = require('./mal');
const database = require('./database');
const redis = require('./redisClient');
const consola = require('consola');

const logger = consola.create({
  defaults: {
    tag: 'Catalog-Warmer'
  }
});

// Configuration from environment variables
const WARMUP_MODE = process.env.CACHE_WARMUP_MODE || 'essential'; // 'essential', 'comprehensive'

// Parse UUIDs from environment variable (supports single UUID or comma-separated list)
const parseWarmupUUIDs = () => {
  const uuidString = process.env.CACHE_WARMUP_UUIDS || process.env.CACHE_WARMUP_UUID; // Support both for backward compatibility
  if (!uuidString) return [];
  
  const uuids = uuidString.split(',').map(uuid => uuid.trim()).filter(uuid => uuid.length > 0);
  return uuids.slice(0, 5); // Limit to 5 UUIDs max
};

const WARMUP_CONFIG = {
  enabled: !!(process.env.CACHE_WARMUP_UUIDS || process.env.CACHE_WARMUP_UUID) && WARMUP_MODE === 'comprehensive',
  uuids: parseWarmupUUIDs(),
  intervalHours: Math.max(12, parseInt(process.env.CATALOG_WARMUP_INTERVAL_HOURS) || 24), // Daily default, minimum 12h
  initialDelaySeconds: parseInt(process.env.CATALOG_WARMUP_INITIAL_DELAY_SECONDS) || 30000,
  maxPagesPerCatalog: parseInt(process.env.CATALOG_WARMUP_MAX_PAGES_PER_CATALOG) || 100,
  resumeOnRestart: process.env.CATALOG_WARMUP_RESUME_ON_RESTART !== 'false',
  quietHoursEnabled: process.env.CATALOG_WARMUP_QUIET_HOURS_ENABLED === 'true',
  quietHoursRange: process.env.CATALOG_WARMUP_QUIET_HOURS || '02:00-06:00',
  taskDelayMs: parseInt(process.env.CATALOG_WARMUP_TASK_DELAY_MS) || 100,
  logLevel: process.env.CATALOG_WARMUP_LOG_LEVEL || 'info'
};

// Stats tracking - now supports multiple UUIDs
let warmupStats = {
  enabled: WARMUP_CONFIG.enabled,
  lastRun: null,
  nextRun: null,
  isRunning: false,
  totalUUIDs: WARMUP_CONFIG.uuids.length,
  uuidStats: {}, // Will store stats per UUID
  totalCatalogs: 0,
  catalogsWarmed: 0,
  totalPages: 0,
  totalItems: 0,
  duration: null,
  errors: []
};

class ComprehensiveCatalogWarmer {
  constructor() {
    this.config = WARMUP_CONFIG;
    this.stats = {
      enabled: WARMUP_CONFIG.enabled,
      lastRun: null,
      nextRun: null,
      isRunning: false,
      totalUUIDs: WARMUP_CONFIG.uuids.length,
      uuidStats: {},
      totalCatalogs: 0,
      catalogsWarmed: 0,
      totalPages: 0,
      totalItems: 0,
      duration: null,
      errors: []
    };
    this.isRunning = false;
  }

  log(level, message) {
    const levels = ['debug', 'info', 'success', 'warn', 'error'];
    const configLevel = this.config.logLevel;
    const configLevelIndex = levels.indexOf(configLevel);
    const messageLevelIndex = levels.indexOf(level);

    if (messageLevelIndex >= configLevelIndex) {
      logger[level](message);
    }
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  isQuietHours() {
    if (!this.config.quietHoursEnabled) return false;

    const [startHour, endHour] = this.config.quietHoursRange.split('-').map(t => {
      const [h, m] = t.split(':').map(Number);
      return h + m / 60;
    });

    const now = new Date();
    const currentHour = now.getHours() + now.getMinutes() / 60;

    if (startHour < endHour) {
      return currentHour >= startHour && currentHour < endHour;
    } else {
      return currentHour >= startHour || currentHour < endHour;
    }
  }

  async shouldWarmup() {
    try {
      // Check if any UUID needs warming
      for (const uuid of this.config.uuids) {
        const lastWarmupKey = `catalog-warmup:last-run:${uuid}`;
        const lastRun = await redis.get(lastWarmupKey);

        if (!lastRun) {
          this.log('info', `No previous warmup found for UUID ${uuid} - will run`);
          return true;
        }

        const lastRunTime = parseInt(lastRun);
        const now = Date.now();
        const hoursSinceLastRun = (now - lastRunTime) / (1000 * 60 * 60);
        const shouldRun = hoursSinceLastRun >= this.config.intervalHours;

        if (shouldRun) {
          this.log('info', `UUID ${uuid} last warmup was ${hoursSinceLastRun.toFixed(1)}h ago - will run`);
          return true;
        }
      }

      // If we get here, no UUIDs need warming
      this.log('info', `All UUIDs warmed recently - skipping (next in ${this.config.intervalHours}h)`);
      return false;
    } catch (error) {
      this.log('error', `Failed to check warmup status: ${error.message}`);
      return true;
    }
  }

  async markWarmed(uuid) {
    try {
      const lastWarmupKey = `catalog-warmup:last-run:${uuid}`;
      const statsKey = `catalog-warmup:stats:${uuid}`;
      
      // Save timestamp for this specific UUID
      await redis.set(lastWarmupKey, Date.now().toString());
      
      // Save stats for this UUID
      await redis.set(statsKey, JSON.stringify({
        catalogsWarmed: this.stats.uuidStats[uuid]?.catalogsWarmed || 0,
        totalCatalogs: this.stats.uuidStats[uuid]?.totalCatalogs || 0,
        totalPages: this.stats.uuidStats[uuid]?.totalPages || 0,
        totalItems: this.stats.uuidStats[uuid]?.totalItems || 0,
        duration: this.stats.uuidStats[uuid]?.duration || null,
        errors: this.stats.uuidStats[uuid]?.errors || []
      }));
      
      const nextRunTime = Date.now() + (this.config.intervalHours * 60 * 60 * 1000);
      this.stats.nextRun = new Date(nextRunTime).toISOString();
      this.log('debug', `Marked warmup complete for UUID ${uuid}, next run: ${this.stats.nextRun}`);
    } catch (error) {
      this.log('error', `Failed to mark warmup complete for UUID ${uuid}: ${error.message}`);
    }
  }

  async warmMALCatalog(catalogId, page, config, extraArgs) {
    const language = config.language || 'en-US';
    const { genre: genreName, type_filter } = extraArgs;
    let metas = [];

    // Replicate the exact switch case logic from index.js
    switch (catalogId) {
      case 'mal.airing': {
        const animeResults = await cacheWrapJikanApi(`mal-airing-${page}-${config.sfw}`, async () => {
          return await jikan.getAiringNow(page, config);
        });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
        break;
      }

      case 'mal.upcoming': {
        const animeResults = await cacheWrapJikanApi(`mal-upcoming-${page}-${config.sfw}`, async () => {
          return await jikan.getUpcoming(page, config);
        });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
        break;
      }

      case 'mal.top_movies': {
        const animeResults = await cacheWrapJikanApi(`mal-top-movies-${page}-${config.sfw}`, async () => {
          return await jikan.getTopAnimeByType('movie', page, config);
        });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
        break;
      }

      case 'mal.top_series': {
        const animeResults = await cacheWrapJikanApi(`mal-top-series-${page}-${config.sfw}`, async () => {
          return await jikan.getTopAnimeByType('tv', page, config);
        });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
        break;
      }

      case 'mal.most_popular': {
        const animeResults = await cacheWrapJikanApi(`mal-most-popular-${page}-${config.sfw}`, async () => {
          return await jikan.getTopAnimeByFilter('bypopularity', page, config);
        });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
        break;
      }

      case 'mal.most_favorites': {
        const animeResults = await cacheWrapJikanApi(`mal-most-favorites-${page}-${config.sfw}`, async () => {
          return await jikan.getTopAnimeByFilter('favorite', page, config);
        });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
        break;
      }

      case 'mal.top_anime': {
        const animeResults = await cacheWrapJikanApi(`mal-top-anime-${page}-${config.sfw}`, async () => {
          return await jikan.getTopAnimeByType('anime', page, config);
        });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
        break;
      }

      case 'mal.80sDecade':
      case 'mal.90sDecade':
      case 'mal.00sDecade':
      case 'mal.10sDecade':
      case 'mal.20sDecade': {
        const decadeMap = {
          'mal.80sDecade': ['1980-01-01', '1989-12-31'],
          'mal.90sDecade': ['1990-01-01', '1999-12-31'],
          'mal.00sDecade': ['2000-01-01', '2009-12-31'],
          'mal.10sDecade': ['2010-01-01', '2019-12-31'],
          'mal.20sDecade': ['2020-01-01', '2029-12-31'],
        };
        const [startDate, endDate] = decadeMap[catalogId];
        const allAnimeGenres = await cacheWrapJikanApi('anime-genres', async () => {
          this.log('debug', 'Fetching anime genre list from Jikan...');
          return await jikan.getAnimeGenres();
        });
        const genreNameToFetch = genreName && genreName !== 'None' ? genreName : allAnimeGenres[0]?.name;
        if (genreNameToFetch) {
          const selectedGenre = allAnimeGenres.find(g => g.name === genreNameToFetch);
          if (selectedGenre) {
            const genreId = selectedGenre.mal_id;
            const animeResults = await cacheWrapJikanApi(`mal-decade-${catalogId}-${page}-${genreId}-${config.sfw}`, async () => {
              return await jikan.getTopAnimeByDateRange(startDate, endDate, page, genreId, config);
            });
            metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
          }
        }
        break;
      }

      case 'mal.genres': {
        const mediaType = type_filter || 'series';
        const allAnimeGenres = await cacheWrapJikanApi('anime-genres', async () => {
          this.log('debug', 'Fetching anime genre list from Jikan...');
          return await jikan.getAnimeGenres();
        });
        const genreNameToFetch = genreName || allAnimeGenres[0]?.name;
        if (genreNameToFetch) {
          const selectedGenre = allAnimeGenres.find(g => g.name === genreNameToFetch);
          if (selectedGenre) {
            const genreId = selectedGenre.mal_id;
            const animeResults = await cacheWrapJikanApi(`mal-genre-${genreId}-${mediaType}-${page}-${config.sfw}`, async () => {
              return await jikan.getAnimeByGenre(genreId, mediaType, page, config);
            });
            metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
          }
        }
        break;
      }

      case 'mal.studios': {
        if (genreName) {
          this.log('debug', `Fetching anime for MAL studio: ${genreName}`);
          const studios = await cacheWrapJikanApi('mal-studios', () => jikan.getStudios(100));
          const selectedStudio = studios.find(studio => {
            const defaultTitle = studio.titles.find(t => t.type === 'Default');
            return defaultTitle && defaultTitle.title === genreName;
          });

          if (selectedStudio) {
            const studioId = selectedStudio.mal_id;
            const animeResults = await cacheWrapJikanApi(`mal-studio-${studioId}-${page}-${config.sfw}`, async () => {
              return await jikan.getAnimeByStudio(studioId, page);
            });
            metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
          } else {
            this.log('warn', `Could not find a MAL ID for studio name: ${genreName}`);
          }
        }
        break;
      }

      case 'mal.schedule': {
        const dayOfWeek = genreName || 'Monday';
        const animeResults = await cacheWrapJikanApi(`mal-schedule-${dayOfWeek}-${page}-${config.sfw}`, async () => {
          return await jikan.getAiringSchedule(dayOfWeek, page, config);
        });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
        break;
      }

      case 'mal.seasons': {
        let seasonString = genreName;

        // If no season specified, calculate current season based on today's date
        if (!seasonString) {
          const currentDate = new Date();
          const currentYear = currentDate.getFullYear();
          const currentMonth = currentDate.getMonth(); // 0-11

          let currentSeason;
          if (currentMonth <= 2) currentSeason = 'Winter';
          else if (currentMonth <= 5) currentSeason = 'Spring';
          else if (currentMonth <= 8) currentSeason = 'Summer';
          else currentSeason = 'Fall';

          seasonString = `${currentSeason} ${currentYear}`;
        }

        const parts = seasonString.split(' ');
        const season = parts[0].toLowerCase();
        const year = parseInt(parts[1]);
        const animeResults = await cacheWrapJikanApi(`mal-season-${year}-${season}-${page}-${config.sfw}`, async () => {
          return await jikan.getAnimeBySeason(year, season, page, config);
        });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
        break;
      }

      default:
        this.log('warn', `Unknown MAL catalog: ${catalogId}`);
        break;
    }

    return { metas };
  }

  async warmCatalog(catalog, config, uuid) {
    if (!uuid) {
      throw new Error('UUID is required for catalog warming');
    }
    
    const catalogId = catalog.id;
    const pageSize = catalogId.startsWith('mal.') ? 25 : 20;
    let page = 1;
    let totalItems = 0;
    const maxPages = this.config.maxPagesPerCatalog;

    this.log('debug', `Starting to warm catalog: ${catalogId} with UUID: ${uuid}`);

    while (page <= maxPages) {
      try {
        const skip = page > 1 ? (page - 1) * pageSize : 0;
        const extraArgs = skip > 0 ? { skip: skip.toString() } : {};
        const actualType = catalog.type;
        const catalogKey = `${catalogId}:${actualType}:${JSON.stringify(extraArgs || {})}`;

        const result = await cacheWrapCatalog(uuid, catalogKey, async () => {
          // Check if this is a MAL catalog
          if (catalogId.startsWith('mal.')) {
            const configWithUUID = { ...config, userUUID: uuid };
            return await this.warmMALCatalog(catalogId, page, configWithUUID, extraArgs);
          } else if (catalogId === 'tmdb.trending') {
            // Special handling for tmdb.trending - call getTrending directly
            if (!uuid) {
              throw new Error(`UUID is required for catalog ${catalogId}`);
            }
            const configWithUUID = { ...config, userUUID: uuid };
            const { getTrending } = require('./getTrending');
            return await getTrending(catalog.type, config.language, page, extraArgs.genre || null, configWithUUID, uuid, config.providers?.series !== 'tmdb');
          } else {
            // Everything else goes through getCatalog
            if (!uuid) {
              throw new Error(`UUID is required for catalog ${catalogId}`);
            }
            // Add userUUID to config object for parseStremThruItems
            const configWithUUID = { ...config, userUUID: uuid };
            const { getCatalog } = require('./getCatalog');
            return await getCatalog(catalog.type, config.language, page, catalogId, extraArgs.genre || null, configWithUUID, uuid, config.providers?.series !== 'tmdb');
          }
        }, undefined, { enableErrorCaching: false, maxRetries: 1 });

        if (!result?.metas || result.metas.length === 0) {
          this.log('debug', `Catalog ${catalogId} complete at page ${page}`);
          break;
        }

        totalItems += result.metas.length;
        this.stats.totalPages++;
        this.stats.totalItems += result.metas.length;
        page++;

        await this.delay(this.config.taskDelayMs);
      } catch (error) {
        this.log('error', `Error warming ${catalogId} page ${page}: ${error.message}`);
        break;
      }
    }

    return { pages: page - 1, items: totalItems };
  }

  async runWarmup(force = false) {
    if (this.isRunning) {
      this.log('warn', 'Warmup already running, skipping');
      return;
    }

    if (!this.config.enabled) {
      this.log('debug', 'Catalog warming is disabled');
      return;
    }

    if (!this.config.uuids || this.config.uuids.length === 0) {
      this.log('error', 'Cannot run comprehensive warmup: CACHE_WARMUP_UUIDS is not set');
      return;
    }

    // Check if we should run (skip if force is true)
    if (!force) {
      const shouldRun = await this.shouldWarmup();
      if (!shouldRun) {
        return;
      }
    } else {
      this.log('info', 'Force restart requested - bypassing interval check');
    }

    // Check quiet hours
    if (this.isQuietHours()) {
      this.log('info', 'Skipping warmup during quiet hours');
      return;
    }

    this.isRunning = true;
    this.stats.isRunning = true;
    const startTime = Date.now();

    try {
      this.log('success', `Starting comprehensive catalog warmup for ${this.config.uuids.length} UUID(s)...`);

      // Process each UUID sequentially
      for (const uuid of this.config.uuids) {
        try {
          this.log('info', `Processing UUID: ${uuid}`);
          const uuidStartTime = Date.now();

          // Load user config for this UUID
          const config = await database.getUserConfig(uuid);
          if (!config) {
            this.log('error', `Config not found for UUID: ${uuid}`);
            this.stats.errors.push({ uuid, error: 'Config not found' });
            continue;
          }

          // Get enabled catalogs from user config
          const enabledCatalogs = (config.catalogs || []).filter(c => c.enabled);
          
          // Initialize stats for this UUID
          this.stats.uuidStats[uuid] = {
            totalCatalogs: enabledCatalogs.length,
            catalogsWarmed: 0,
            totalPages: 0,
            totalItems: 0,
            duration: null,
            errors: []
          };

          this.log('info', `Found ${enabledCatalogs.length} enabled catalogs for UUID ${uuid}`);

          // Warm each catalog for this UUID
          for (const catalog of enabledCatalogs) {
            try {
              this.log('info', `Warming catalog: ${catalog.id} (${catalog.name}) for UUID ${uuid}`);
              const result = await this.warmCatalog(catalog, config, uuid);
              this.stats.uuidStats[uuid].catalogsWarmed++;
              this.stats.uuidStats[uuid].totalPages += result.pages;
              this.stats.uuidStats[uuid].totalItems += result.items;
              this.log('success', `✓ ${catalog.id}: ${result.pages} pages, ${result.items} items`);
            } catch (error) {
              this.log('error', `✗ ${catalog.id}: ${error.message}`);
              this.stats.uuidStats[uuid].errors.push({ catalog: catalog.id, error: error.message });
            }
          }

          // Calculate duration for this UUID
          const uuidDuration = Date.now() - uuidStartTime;
          this.stats.uuidStats[uuid].duration = `${Math.floor(uuidDuration / 60000)}m ${Math.floor((uuidDuration % 60000) / 1000)}s`;

          // Mark this UUID as complete
          await this.markWarmed(uuid);

          // Update overall stats
          this.stats.totalCatalogs += this.stats.uuidStats[uuid].totalCatalogs;
          this.stats.catalogsWarmed += this.stats.uuidStats[uuid].catalogsWarmed;
          this.stats.totalPages += this.stats.uuidStats[uuid].totalPages;
          this.stats.totalItems += this.stats.uuidStats[uuid].totalItems;

          this.log('success', `UUID ${uuid} complete: ${this.stats.uuidStats[uuid].catalogsWarmed}/${this.stats.uuidStats[uuid].totalCatalogs} catalogs, ${this.stats.uuidStats[uuid].totalPages} pages, ${this.stats.uuidStats[uuid].totalItems} items in ${this.stats.uuidStats[uuid].duration}`);

        } catch (error) {
          this.log('error', `Failed to process UUID ${uuid}: ${error.message}`);
          this.stats.errors.push({ uuid, error: error.message });
        }
      }

      // Calculate overall duration
      const overallDuration = Date.now() - startTime;
      this.stats.duration = `${Math.floor(overallDuration / 60000)}m ${Math.floor((overallDuration % 60000) / 1000)}s`;
      this.stats.lastRun = new Date().toISOString();

      this.log('success', `Warmup complete! Processed ${this.config.uuids.length} UUID(s), warmed ${this.stats.catalogsWarmed}/${this.stats.totalCatalogs} catalogs, ${this.stats.totalPages} pages, ${this.stats.totalItems} items in ${this.stats.duration}`);
    } catch (error) {
      this.log('error', `Warmup failed: ${error.message}`);
      this.stats.errors.push({ global: error.message });
    } finally {
      this.isRunning = false;
      this.stats.isRunning = false;
    }
  }

  async startBackgroundWarming() {
    if (!process.env.CACHE_WARMUP_UUIDS && !process.env.CACHE_WARMUP_UUID) {
      this.log('info', 'Comprehensive catalog warming disabled - CACHE_WARMUP_UUIDS not set');
      return;
    }

    if (!this.config.enabled) {
      const mode = process.env.CACHE_WARMUP_MODE || 'essential';
      this.log('info', `Comprehensive catalog warming disabled (CACHE_WARMUP_MODE=${mode})`);
      this.log('info', 'Set CACHE_WARMUP_MODE=comprehensive or CACHE_WARMUP_MODE=both to enable');
      return;
    }

    this.log('success', `Comprehensive catalog warming enabled for ${this.config.uuids.length} UUID(s): ${this.config.uuids.join(', ')}`);
    this.log('info', `Mode: ${WARMUP_MODE}, Interval: ${this.config.intervalHours}h, Initial delay: ${this.config.initialDelaySeconds}s`);

    // Calculate next run time based on the earliest UUID that needs warming
    let earliestNextRun = null;
    for (const uuid of this.config.uuids) {
      const lastWarmupKey = `catalog-warmup:last-run:${uuid}`;
      const lastRun = await redis.get(lastWarmupKey);
      if (lastRun) {
        const lastRunTime = parseInt(lastRun);
        const nextRunTime = lastRunTime + (this.config.intervalHours * 60 * 60 * 1000);
        if (!earliestNextRun || nextRunTime < earliestNextRun) {
          earliestNextRun = nextRunTime;
          this.stats.lastRun = new Date(lastRunTime).toISOString();
        }
      }
    }
    
    if (earliestNextRun) {
      this.stats.nextRun = new Date(earliestNextRun).toISOString();
    }

    // Initial delay
    await this.delay(this.config.initialDelaySeconds * 1000);

    // Run warmup immediately
    await this.runWarmup();

    // Schedule recurring warmups
    setInterval(async () => {
      await this.runWarmup();
    }, this.config.intervalHours * 60 * 60 * 1000);
  }

  async getStats() {
    try {
      // Only load persisted stats if we don't have current stats (i.e., at startup)
      if (!this.stats || this.stats.totalCatalogs === 0) {
        // Load stats for each UUID
        for (const uuid of this.config.uuids) {
          const statsKey = `catalog-warmup:stats:${uuid}`;
          const persistedStats = await redis.get(statsKey);
          
          if (persistedStats) {
            const parsedStats = JSON.parse(persistedStats);
            this.stats.uuidStats[uuid] = parsedStats;
          }
        }
      }
    } catch (error) {
      this.log('error', `Failed to load persisted stats: ${error.message}`);
    }
    
    return {
      ...this.stats,
      config: {
        uuids: this.config.uuids,
        intervalHours: this.config.intervalHours,
        maxPagesPerCatalog: this.config.maxPagesPerCatalog,
        resumeOnRestart: this.config.resumeOnRestart
      }
    };
  }
}

// Singleton instance
const warmer = new ComprehensiveCatalogWarmer();

// Export functions
function startComprehensiveCatalogWarming() {
  return warmer.startBackgroundWarming();
}

async function getWarmupStats() {
  return await warmer.getStats();
}

function forceRestartWarmup() {
  return warmer.runWarmup(true);
}

module.exports = {
  startComprehensiveCatalogWarming,
  getWarmupStats,
  forceRestartWarmup
};

