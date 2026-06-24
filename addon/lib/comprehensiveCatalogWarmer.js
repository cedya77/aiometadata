require('dotenv').config();
const {
  cacheWrapCatalog,
  cacheWrapJikanApi,
  stableStringify,
  projectCatalogPayloadForCache,
  writeMetaComponentsBatchWithConfig,
} = require('./getCache');
const { getGenreList } = require('./getGenreList');
const { parseAnimeCatalogMetaBatch } = require('../utils/parseProps');
const jikan = require('./mal');
const database = require('./database');
const redis = require('./redisClient');
const consola = require('consola');
const { loadConfigFromDatabase } = require('./configApi.js');
const { resolveDynamicTmdbDiscoverParams } = require('./tmdbDiscoverDateTokens');
const { getTvmazeScheduleCatalog } = require('./tvmazeScheduleCatalog');
const buildInfo = require('./buildInfo');
const crypto = require('crypto');
const { runWithRequestContext } = require('./logBuffer.js');

function extractIdsFromWarmerMeta(meta) {
  const ids = {};
  if (!meta) return ids;
  const id = meta.id || '';
  if (id) ids.id = id;
  if (id.startsWith('tmdb:')) ids.tmdbId = id.slice(5);
  else if (id.startsWith('tvdb:')) ids.tvdbId = id.slice(5);
  else if (id.startsWith('kitsu:')) ids.kitsuId = id.slice(6);
  else if (id.startsWith('mal:')) ids.malId = id.slice(4);
  else if (id.startsWith('anilist:')) ids.anilistId = id.slice(8);
  else if (id.startsWith('anidb:')) ids.anidbId = id.slice(6);
  else if (id.startsWith('tt')) ids.imdbId = id;
  if (meta.imdb_id) ids.imdbId = meta.imdb_id;
  if (meta._tmdbId && !ids.tmdbId) ids.tmdbId = meta._tmdbId;
  if (meta._tvdbId && !ids.tvdbId) ids.tvdbId = meta._tvdbId;
  if (meta._imdbId && !ids.imdbId) ids.imdbId = meta._imdbId;
  if (meta._malId && !ids.malId) ids.malId = meta._malId;
  if (meta._kitsuId && !ids.kitsuId) ids.kitsuId = meta._kitsuId;
  if (meta._anilistId && !ids.anilistId) ids.anilistId = meta._anilistId;
  if (meta._anidbId && !ids.anidbId) ids.anidbId = meta._anidbId;
  return ids;
}

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
  intervalHours: Math.max(12, parseFloat(process.env.CATALOG_WARMUP_INTERVAL_HOURS) || 24), // Daily default, minimum 12h (supports fractional hours like 0.5)
  initialDelaySeconds: parseInt(process.env.CATALOG_WARMUP_INITIAL_DELAY_SECONDS) || 300,
  maxPagesPerCatalog: parseInt(process.env.CATALOG_WARMUP_MAX_PAGES_PER_CATALOG) || 100,
  resumeOnRestart: process.env.CATALOG_WARMUP_RESUME_ON_RESTART !== 'false',
  quietHoursEnabled: process.env.CATALOG_WARMUP_QUIET_HOURS_ENABLED === 'true',
  quietHoursRange: process.env.CATALOG_WARMUP_QUIET_HOURS || '02:00-06:00',
  taskDelayMs: parseInt(process.env.CATALOG_WARMUP_TASK_DELAY_MS) || 100,
  logLevel: process.env.CATALOG_WARMUP_LOG_LEVEL || 'info',
  autoOnVersionChange: process.env.CATALOG_WARMUP_AUTO_ON_VERSION_CHANGE === 'true'
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
    this.shouldStop = false; // Flag for graceful stop
  }

  /**
   * Request to stop warming operations gracefully
   */
  stopWarming() {
    if (this.isRunning) {
      this.shouldStop = true;
      this.log('info', 'Stop requested - will stop after current catalog');
      return { success: true, message: 'Comprehensive warming will stop after current catalog' };
    }
    return { success: true, message: 'Comprehensive warming is not currently running' };
  }

  /**
   * Check if warming should continue
   */
  shouldContinueWarming() {
    return !this.shouldStop;
  }

  /**
   * Recompute env-derived config from the live process.env. This module is
   * imported before dashboard settings are loaded from the database into
   * process.env, so the import-time WARMUP_CONFIG can be stale when values
   * are configured via the dashboard rather than env vars.
   */
  syncConfigFromEnv() {
    this.config.uuids = parseWarmupUUIDs();
    this.config.enabled = !!(process.env.CACHE_WARMUP_UUIDS || process.env.CACHE_WARMUP_UUID) && (process.env.CACHE_WARMUP_MODE || 'essential') === 'comprehensive';
    this.config.intervalHours = Math.max(12, parseFloat(process.env.CATALOG_WARMUP_INTERVAL_HOURS) || 24);
    this.config.maxPagesPerCatalog = parseInt(process.env.CATALOG_WARMUP_MAX_PAGES_PER_CATALOG) || 100;
    this.config.quietHoursEnabled = process.env.CATALOG_WARMUP_QUIET_HOURS_ENABLED === 'true';
    this.config.quietHoursRange = process.env.CATALOG_WARMUP_QUIET_HOURS || '02:00-06:00';
    this.config.taskDelayMs = parseInt(process.env.CATALOG_WARMUP_TASK_DELAY_MS) || 100;
    this.config.logLevel = process.env.CATALOG_WARMUP_LOG_LEVEL || 'info';
    this.config.autoOnVersionChange = process.env.CATALOG_WARMUP_AUTO_ON_VERSION_CHANGE === 'true';
    this.stats.enabled = this.config.enabled;
    this.stats.totalUUIDs = this.config.uuids.length;
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

  formatNextRunTime(nextRunTime) {
    const date = new Date(nextRunTime);
    const now = Date.now();
    const diffMs = nextRunTime - now;
    const diffMinutes = Math.round(diffMs / 60000);
    const diffHours = Math.round(diffMs / 3600000);
    
    // Format local time - manually format to ensure local timezone is used
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const localTime = `${month}/${day}/${year}, ${hours}:${minutes}:${seconds}`;
    
    // Calculate relative time
    let relativeTime;
    if (diffMinutes < 60) {
      relativeTime = `in ${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''}`;
    } else if (diffHours < 24) {
      relativeTime = `in ${diffHours} hour${diffHours !== 1 ? 's' : ''}`;
    } else {
      const diffDays = Math.round(diffHours / 24);
      relativeTime = `in ${diffDays} day${diffDays !== 1 ? 's' : ''}`;
    }
    
    return `${localTime} (${relativeTime})`;
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
      await redis.del('catalog-warmup:in-progress');

      for (const uuid of this.config.uuids) {
        const lastWarmupKey = `catalog-warmup:last-run:${uuid}`;
        const lastRun = await redis.get(lastWarmupKey);

        if (!lastRun) {
          this.log('info', `No previous warmup found for UUID ${uuid} - will run`);
          return true;
        }

        const hoursSinceLastRun = (Date.now() - parseInt(lastRun)) / (1000 * 60 * 60);

        if (hoursSinceLastRun >= this.config.intervalHours) {
          this.log('info', `UUID ${uuid} last warmup was ${hoursSinceLastRun.toFixed(1)}h ago - will run`);
          return true;
        }
      }

      this.log('info', `All UUIDs warmed recently - skipping (next in ${this.config.intervalHours}h)`);
      return false;
    } catch (error) {
      this.log('error', `Failed to check warmup status: ${error.message}`);
      return true;
    }
  }

  async markWarmed(uuid, runStartedAt = null) {
    try {
      const lastWarmupKey = `catalog-warmup:last-run:${uuid}`;
      const statsKey = `catalog-warmup:stats:${uuid}`;
      const recordedStart = typeof runStartedAt === 'number' ? runStartedAt : Date.now();
      
      // Save timestamp for this specific UUID
      await redis.set(lastWarmupKey, recordedStart.toString());
      
      // Save stats for this UUID
      await redis.set(statsKey, JSON.stringify({
        catalogsWarmed: this.stats.uuidStats[uuid]?.catalogsWarmed || 0,
        totalCatalogs: this.stats.uuidStats[uuid]?.totalCatalogs || 0,
        totalPages: this.stats.uuidStats[uuid]?.totalPages || 0,
        totalItems: this.stats.uuidStats[uuid]?.totalItems || 0,
        duration: this.stats.uuidStats[uuid]?.duration || null,
        errors: this.stats.uuidStats[uuid]?.errors || []
      }));
      
      const nextRunTime = recordedStart + (this.config.intervalHours * 60 * 60 * 1000);
      this.stats.nextRun = new Date(nextRunTime).toISOString();
      this.log('debug', `Marked warmup complete for UUID ${uuid}, next run: ${this.formatNextRunTime(nextRunTime)}`);
    } catch (error) {
      this.log('error', `Failed to mark warmup complete for UUID ${uuid}: ${error.message}`);
    }
  }

  async persistFullMetasAndProjectCatalog(result, config, type, options = {}) {
    const metas = Array.isArray(result?.metas) ? result.metas : [];

    if (metas.length > 0) {
      try {
        const stats = await writeMetaComponentsBatchWithConfig({
          config,
          metas,
          type,
          useShowPoster: !!options.useShowPoster,
          overwrite: false,
        });
        this.log('debug', `[Catalog Cache] Processed ${stats.written} meta component set(s), skipped ${stats.skipped}`);
      } catch (error) {
        this.log('warn', `[Catalog Cache] Failed to write meta components before catalog projection: ${error.message}`);
      }
    }

    return projectCatalogPayloadForCache(result);
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
        }, 24 * 60 * 60, { skipVersion: true });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language, true);
        break;
      }

      case 'mal.upcoming': {
        const animeResults = await cacheWrapJikanApi(`mal-upcoming-${page}-${config.sfw}`, async () => {
          return await jikan.getUpcoming(page, config);
        }, 24 * 60 * 60);
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language, true);
        break;
      }

      case 'mal.top_movies': {
        const animeResults = await cacheWrapJikanApi(`mal-top-movies-${page}-${config.sfw}`, async () => {
          return await jikan.getTopAnimeByType('movie', page, config);
        }, null, { skipVersion: true });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language, true);
        break;
      }

      case 'mal.top_series': {
        const animeResults = await cacheWrapJikanApi(`mal-top-series-${page}-${config.sfw}`, async () => {
          return await jikan.getTopAnimeByType('tv', page, config);
        }, null, { skipVersion: true });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language, true);
        break;
      }

      case 'mal.most_popular': {
        const animeResults = await cacheWrapJikanApi(`mal-most-popular-${page}-${config.sfw}`, async () => {
          return await jikan.getTopAnimeByFilter('bypopularity', page, config);
        }, null, { skipVersion: true });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language, true);
        break;
      }

      case 'mal.most_favorites': {
        const animeResults = await cacheWrapJikanApi(`mal-most-favorites-${page}-${config.sfw}`, async () => {
          return await jikan.getTopAnimeByFilter('favorite', page, config);
        }, null, { skipVersion: true });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language, true);
        break;
      }

      case 'mal.top_anime': {
        const animeResults = await cacheWrapJikanApi(`mal-top-anime-${page}-${config.sfw}`, async () => {
          return await jikan.getTopAnimeByType('anime', page, config);
        }, null, { skipVersion: true });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language, true);
        break;
      }

      case 'mal.season_top': {
        const animeResults = await cacheWrapJikanApi(`mal-season-top-${page}-${config.sfw}`, async () => {
          return await jikan.getSeasonTopRated(page, config);
        }, 24 * 60 * 60, { skipVersion: true });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language, true);
        break;
      }

      case 'mal.season_top_new': {
        const animeResults = await cacheWrapJikanApi(`mal-season-top-new-${page}-${config.sfw}`, async () => {
          return await jikan.getSeasonTopNew(page, config);
        }, 24 * 60 * 60, { skipVersion: true });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language, true);
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
        }, null, { skipVersion: true });
        const genreNameToFetch = genreName && genreName !== 'None' ? genreName : allAnimeGenres[0]?.name;
        if (genreNameToFetch) {
          const selectedGenre = allAnimeGenres.find(g => g.name === genreNameToFetch);
          if (selectedGenre) {
            const genreId = selectedGenre.mal_id;
            const animeResults = await cacheWrapJikanApi(`mal-decade-${catalogId}-${page}-${genreId}-${config.sfw}`, async () => {
              return await jikan.getTopAnimeByDateRange(startDate, endDate, page, genreId, config);
            }, null, { skipVersion: true });
            metas = await parseAnimeCatalogMetaBatch(animeResults, config, language, true);
          }
        }
        break;
      }

      case 'mal.genres': {
        const mediaType = type_filter || 'series';
        const allAnimeGenres = await cacheWrapJikanApi('anime-genres', async () => {
          this.log('debug', 'Fetching anime genre list from Jikan...');
          return await jikan.getAnimeGenres();
        }, null, { skipVersion: true });
        const genreNameToFetch = genreName || allAnimeGenres[0]?.name;
        if (genreNameToFetch) {
          const selectedGenre = allAnimeGenres.find(g => g.name === genreNameToFetch);
          if (selectedGenre) {
            const genreId = selectedGenre.mal_id;
            const animeResults = await cacheWrapJikanApi(`mal-genre-${genreId}-${mediaType}-${page}-${config.sfw}`, async () => {
              return await jikan.getAnimeByGenre(genreId, mediaType, page, config);
            }, null, { skipVersion: true });
            metas = await parseAnimeCatalogMetaBatch(animeResults, config, language, true);
          }
        }
        break;
      }

      case 'mal.studios': {
        if (genreName) {
          this.log('debug', `Fetching anime for MAL studio: ${genreName}`);
          const studios = await cacheWrapJikanApi('mal-studios', () => jikan.getStudios(100), null, { skipVersion: true });
          const selectedStudio = studios.find(studio => {
            const defaultTitle = studio.titles.find(t => t.type === 'Default');
            return defaultTitle && defaultTitle.title === genreName;
          });

          if (selectedStudio) {
            const studioId = selectedStudio.mal_id;
            const animeResults = await cacheWrapJikanApi(`mal-studio-${studioId}-${page}-${config.sfw}`, async () => {
              return await jikan.getAnimeByStudio(studioId, page);
            }, null, { skipVersion: true });
            metas = await parseAnimeCatalogMetaBatch(animeResults, config, language, true);
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
        }, null, { skipVersion: true });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language, true);
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
        }, null, { skipVersion: true });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language, true);
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
    
    // Set current catalog config for per-catalog settings (like enableRatingPosters)
    config._currentCatalogConfig = catalog;
    
    const catalogId = catalog.id;
    // Determine if manifest will include a "None" genre option for this catalog
    // When showInHome=false and catalog type adds "None", Stremio will send genre=None
    const shouldIncludeGenreNone = (
      catalog.showInHome === false && (
        catalogId.startsWith('mdblist.') ||
        catalogId.startsWith('trakt.') ||
        catalogId.startsWith('anilist.') ||
        catalogId.startsWith('letterboxd.') ||
        catalogId.startsWith('flixpatrol.') ||
        catalogId.startsWith('stremthru.') ||
        catalogId.startsWith('custom.') ||
        catalogId.startsWith('streaming.') ||
        catalogId.startsWith('simkl.') ||
        catalogId.startsWith('publicmetadb.') ||
        catalogId.startsWith('tmdb.discover') ||
        catalogId.startsWith('tvdb.discover') ||
        catalogId.startsWith('mal.discover')  ||
        catalogId.startsWith('anilist.discover') ||
        catalogId === 'tmdb.top' ||
        catalogId === 'tvmaze.schedule' ||
        catalogId === 'tmdb.airing_today' ||
        catalogId === 'tmdb.top_rated' ||
        (catalogId.startsWith('mal.') && !catalogId.includes(['mal.genres', 'mal.studios', 'mal.schedule', 'mal.seasons']))
      )
    );

    // Use the genre value that Stremio will actually send
    // For tvdb.genres, when showInHome is false the manifest does not add a 'None' option so the client defaults to the first genre.
    // For MAL catalogs (except mal.genres) we use 'None' when showInHome is false.
    let genreValue = null;
    if (catalog.showInHome === false) {
      if (catalogId === 'tmdb.trending') {
        genreValue = 'Day';
      }
      // TVDB genres and tvdb.trending use the first genre when showInHome is false
      else if (catalogId === 'tvdb.genres' || catalogId === 'tvdb.trending') {
        try {
          const genres = await getGenreList('tvdb', config.language, catalog.type, config);
          let genreNames = genres.map(genre => genre.name).sort();
          if (genreNames && genreNames.length > 0) {
            genreValue = genreNames[0];
          }
        } catch (e) {
          // leave as null and let fallback happen
        }
      }
      // MAL special catalogs default to the first option instead of 'None' when showInHome is false
      else if (catalogId === 'mal.schedule') {
        genreValue = 'Monday';
      } else if (catalogId === 'mal.seasons') {
        // Use cached seasons if available, otherwise generate a season list similar to manifest
        if (global.availableSeasons && global.availableSeasons.length > 0) {
          genreValue = global.availableSeasons[0];
        } else {
          const seasons = ['Winter', 'Spring', 'Summer', 'Fall'];
          const currentDate = new Date();
          const currentYear = currentDate.getFullYear();
          const currentMonth = currentDate.getMonth(); // 0-11
          let currentSeasonIndex;
          if (currentMonth <= 2) currentSeasonIndex = 0; // Winter
          else if (currentMonth <= 5) currentSeasonIndex = 1; // Spring
          else if (currentMonth <= 8) currentSeasonIndex = 2; // Summer
          else currentSeasonIndex = 3; // Fall
          const firstSeason = `${seasons[currentSeasonIndex]} ${currentYear}`;
          genreValue = firstSeason;
        }
      } else if (catalogId === 'mal.studios') {
        try {
          // Use the same cache key and TTL as `getManifest` to avoid redundant API calls and keep cache consistent
          const studios = await cacheWrapJikanApi('mal-studios', async () => await jikan.getStudios(100), 30 * 24 * 60 * 60);
          let studioNames = studios.map(studio => {
          const defaultTitle = studio.titles.find(t => t.type === 'Default');
          return defaultTitle ? defaultTitle.title : null;
        }).filter(Boolean);
          if (studioNames && studioNames.length > 0) {
            genreValue = studioNames[0];
          }
        } catch (e) {
          // fallback to null
        }
      } else if (catalogId === 'mal.genres') {
        try {
          // Use the same cache key as getManifest for available anime genres
          const animeGenres = await cacheWrapJikanApi('anime-genres', async () => await jikan.getAnimeGenres(), 30 * 24 * 60 * 60, { skipVersion: true });
          if (animeGenres && animeGenres.length > 0) {
            let animeGenreNames = animeGenres.filter(Boolean).map(genre => genre.name).sort();
            if (animeGenreNames.length > 0) {
              genreValue = animeGenreNames[0];
            }
          }
        } catch (e) {
          // fallback to null
        }
      }
      // For catalogs where manifest adds 'None' (e.g., mdblist/stremthru/custom/streaming/tmdb.top/tmdb.airing_today), use 'None'
      else if (shouldIncludeGenreNone) {
        genreValue = 'None';
      }
    }

    this.log('debug', `Starting to warm catalog: ${catalogId} with UUID: ${uuid}${shouldIncludeGenreNone ? ' (with genre=None)' : ''}`);

    if (catalogId.startsWith('stremthru.') || catalogId.startsWith('custom.')) {
      return await this.warmExternalAddonCatalog(catalogId, catalog, genreValue, config, uuid);
    }

    let currentPage = 1;
    let totalItems = 0;
    const maxPages = this.config.maxPagesPerCatalog;
    let posterWarmingChain = Promise.resolve();

    while (currentPage <= maxPages) {
      try {
        // Construct extraArgs with page instead of skip
        const extraArgs = {};
        if (currentPage > 1) extraArgs.page = currentPage;
        if (genreValue) extraArgs.genre = genreValue;
        const catalogConfig = config.catalogs?.find(c => c.id === catalogId);
        if (catalogId.startsWith('trakt.') || catalogId.startsWith('anilist.') || catalogId.startsWith('streaming.') || catalogId.startsWith('tmdb.year') || catalogId.startsWith('tmdb.language')) {
          if (catalogConfig) {
            if (catalogConfig.sort) extraArgs.sort = catalogConfig.sort;
            if (catalogConfig.sortDirection) extraArgs.sortDirection = catalogConfig.sortDirection;
          }
        }
        else if (catalogId.startsWith('tmdb.discover.') || catalogId.startsWith('tvdb.discover.') || catalogId.startsWith('simkl.discover.') || catalogId.startsWith('anilist.discover.') || catalogId.startsWith('mal.discover.')) {
          const discoverParams =
            catalogConfig?.metadata?.discover?.params ||
            catalogConfig?.metadata?.discoverParams ||
            null;
          if (discoverParams && typeof discoverParams === 'object') {
            const discoverParamsForSignature = catalogId.startsWith('tmdb.discover.')
              ? resolveDynamicTmdbDiscoverParams(discoverParams, { timezone: config.timezone })
              : discoverParams;
            const discoverSignature = crypto
              .createHash('md5')
              .update(stableStringify(discoverParamsForSignature))
              .digest('hex')
              .substring(0, 8);
            extraArgs.discoverSig = discoverSignature;
          }
        }
        else if (catalogId.startsWith('mdblist.')) {
          if (catalogConfig) {
            if (catalogConfig.sort) extraArgs.sort = catalogConfig.sort;
            if (catalogConfig.order) extraArgs.order = catalogConfig.order;
            // Add score filters for MDBList external lists
            if (catalogConfig.source === 'mdblist' && catalogConfig.sourceUrl && catalogConfig.sourceUrl.includes('/external/lists/')) {
              if (typeof catalogConfig.filter_score_min === 'number') {
                extraArgs.filter_score_min = catalogConfig.filter_score_min;
              }
              if (typeof catalogConfig.filter_score_max === 'number') {
                extraArgs.filter_score_max = catalogConfig.filter_score_max;
              }
            }
          }
        }
        if (catalogId === 'trakt.upnext' || catalogId === 'mdblist.upnext' || catalogId === 'publicmetadb.upnext') {
          extraArgs.useShowPoster = typeof catalogConfig?.metadata?.useShowPosterForUpNext === 'boolean'
              ? catalogConfig.metadata.useShowPosterForUpNext
              : false;
        }
        if (catalogId === 'mdblist.upnext') {
          if (catalogConfig?.metadata?.hideUnreleased !== undefined) {
            extraArgs.hideUnreleased = catalogConfig.metadata.hideUnreleased;
          }
        }

        if (catalogId === 'trakt.calendar') {
          const getUserTimezone = () => config.timezone || process.env.TZ || 'UTC';
          const getTodayInTimezone = (tz) => {
            const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
            return formatter.format(new Date());
          };
          extraArgs.date = getTodayInTimezone(getUserTimezone());
          extraArgs.days = typeof catalogConfig?.metadata?.airingSoonDays === 'number' 
            ? catalogConfig.metadata.airingSoonDays 
            : 1;
        }
        
        if (catalogId.startsWith('simkl.calendar')) {
          const getUserTimezone = () => config.timezone || process.env.TZ || 'UTC';
          const getTodayInTimezone = (tz) => {
            const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
            return formatter.format(new Date());
          };
          extraArgs.date = getTodayInTimezone(getUserTimezone());
          extraArgs.days = typeof catalogConfig?.metadata?.airingSoonDays === 'number'
            ? catalogConfig.metadata.airingSoonDays
            : 1;
        }

        if (catalogId === 'tvmaze.schedule') {
          const getUserTimezone = () => config.timezone || process.env.TZ || 'UTC';
          const getTodayInTimezone = (tz) => {
            const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
            return formatter.format(new Date());
          };
          const dateString = extraArgs.date || getTodayInTimezone(getUserTimezone());
          extraArgs.date = dateString;
          extraArgs.genre = !extraArgs.genre || extraArgs.genre === 'None' ? '' : extraArgs.genre.toUpperCase();
        }

          const derivedPage = currentPage;
          const actualType = catalog.type;
          const catalogKey = `${catalogId}:${actualType}:${stableStringify(extraArgs || {})}`;

          const result = await cacheWrapCatalog(uuid, catalogKey, async () => {
          // Check if this is a MAL catalog
          if (catalogId.startsWith('mal.')) {
            const configWithUUID = { ...config, userUUID: uuid };
            const fullResult = await this.warmMALCatalog(catalogId, derivedPage, configWithUUID, extraArgs);
            return await this.persistFullMetasAndProjectCatalog(fullResult, configWithUUID, actualType);
          } else if (catalogId === 'tmdb.trending') {
            // Special handling for tmdb.trending - call getTrending directly
            if (!uuid) {
              throw new Error(`UUID is required for catalog ${catalogId}`);
            }
            const configWithUUID = { ...config, userUUID: uuid };
            const { getTrending } = require('./getTrending');
            const fullResult = await getTrending(catalog.type, config.language, derivedPage, extraArgs.genre || null, configWithUUID, uuid, true);
            return await this.persistFullMetasAndProjectCatalog(fullResult, configWithUUID, actualType);
          } else if (catalogId === 'tvmaze.schedule') {
            const configWithUUID = { ...config, userUUID: uuid };
            const fullResult = await getTvmazeScheduleCatalog({
              date: extraArgs.date,
              country: extraArgs.genre || '',
              page: derivedPage,
              pageSize: 20,
              language: config.language || 'en-US',
              config: configWithUUID,
              userUUID: uuid,
              includeVideos: true,
              enableErrorCaching: false,
              maxRetries: 1,
            });
            return await this.persistFullMetasAndProjectCatalog(fullResult, configWithUUID, actualType);
          } else {
            // Everything else goes through getCatalog
            if (!uuid) {
              throw new Error(`UUID is required for catalog ${catalogId}`);
            }
            // Add userUUID to config object for parseStremThruItems
            const configWithUUID = { ...config, userUUID: uuid };
            const { getCatalog } = require('./getCatalog');
            const fullResult = await getCatalog(catalog.type, config.language, derivedPage, catalogId, extraArgs.genre || null, configWithUUID, uuid, true);
            return await this.persistFullMetasAndProjectCatalog(fullResult, configWithUUID, actualType, {
              useShowPoster: !!extraArgs.useShowPoster,
            });
          }
          }, { enableErrorCaching: false, maxRetries: 1, config });

          const rawMetaCount = result?.metas?.length || 0;

          const posterWarmupUrl = (process.env.POSTER_WARMUP_URL || process.env.POSTER_PROXY_PREFIX_URL || '').replace(/\/+$/, '');
          if (posterWarmupUrl && rawMetaCount > 0) {
            const { resolveCustomArtUrl, getDefaultPosterPattern, getPosterRatingApiKey, isRatingPostersEnabled } = require('../utils/parseProps');
            const ratingPostersEnabled = isRatingPostersEnabled(config);
            const posterPattern = ratingPostersEnabled ? (config.customPosterUrlPattern || (config.posterRatingProvider && config.posterRatingProvider !== 'custom' ? getDefaultPosterPattern(config.posterRatingProvider) : null)) : null;
            const proxyApiKey = ratingPostersEnabled && config.usePosterProxy ? getPosterRatingApiKey(config) : null;
            const addonHost = process.env.HOST_NAME ? (process.env.HOST_NAME.startsWith('http') ? process.env.HOST_NAME : `https://${process.env.HOST_NAME}`) : '';
            const posterUrls = [];

            for (const meta of result.metas) {
              const ids = extractIdsFromWarmerMeta(meta);
              const type = meta.type || catalog.type;
              const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));

              if (posterPattern && proxyId) {
                if (proxyApiKey) {
                  posterUrls.push(`${addonHost}/poster/${type}/${proxyId}?fallback=${encodeURIComponent(meta.poster || '')}&lang=${config.language || 'en-US'}&key=${proxyApiKey}`);
                } else {
                  const resolved = resolveCustomArtUrl(posterPattern, ids, type, config);
                  if (resolved) {
                    if (config.usePosterProxy) {
                      posterUrls.push(`${addonHost}/poster/${type}/${proxyId}?fallback=${encodeURIComponent(meta.poster || '')}&url=${encodeURIComponent(resolved)}`);
                    } else {
                      posterUrls.push(resolved);
                    }
                  }
                }
              } else if (meta.poster) {
                posterUrls.push(meta.poster);
              }
            }

            if (posterUrls.length > 0) {
              const posterDelay = parseInt(process.env.POSTER_WARMUP_DELAY_MS) || 50;
              const posterConcurrency = Math.max(1, parseInt(process.env.POSTER_WARMUP_CONCURRENCY) || 1);
              const pageCatalogId = catalogId;
              posterWarmingChain = posterWarmingChain.then(async () => {
                let warmed = 0;
                for (let i = 0; i < posterUrls.length; i += posterConcurrency) {
                  const batch = posterUrls.slice(i, i + posterConcurrency);
                  const results = await Promise.allSettled(
                    batch.map(url => fetch(`${posterWarmupUrl}/${url}`, { method: 'HEAD' }))
                  );
                  warmed += results.filter(r => r.status === 'fulfilled').length;
                  if (posterDelay > 0) await new Promise(r => setTimeout(r, posterDelay));
                }
                this.log('debug', `[Poster Warming] Pre-warmed ${warmed} poster images for catalog ${pageCatalogId}`);
              });
            }
          }

          if (rawMetaCount === 0) {
            this.log('debug', `Catalog ${catalogId}${genreValue ? ' (genre: '+genreValue+')' : ''} complete at page ${currentPage}`);
            break;
          }

          totalItems += rawMetaCount;
          currentPage++;

          await this.delay(this.config.taskDelayMs);
      } catch (error) {
          this.log('error', `Error warming ${catalogId}${genreValue ? ' (genre: '+genreValue+')' : ''} page ${currentPage}: ${error.message}`);
          break;
      }
    }

    return { pages: currentPage - 1, items: totalItems };
  }

  async warmExternalAddonCatalog(catalogId, catalog, genreValue, config, uuid) {
    const configWithUUID = { ...config, userUUID: uuid };
    const { getCatalog } = require('./getCatalog');
    const maxPages = this.config.maxPagesPerCatalog;
    let currentSkip = 0;
    let pagesWarmed = 0;
    let totalItems = 0;
    let posterWarmingChain = Promise.resolve();

    while (pagesWarmed < maxPages) {
      try {
        const fullResult = await getCatalog(catalog.type, config.language, 1, catalogId, genreValue || null, configWithUUID, uuid, true, currentSkip);
        const result = await this.persistFullMetasAndProjectCatalog(fullResult, configWithUUID, catalog.type);

        const rawMetaCount = result?.metas?.length || 0;

        const posterWarmupUrl = (process.env.POSTER_WARMUP_URL || process.env.POSTER_PROXY_PREFIX_URL || '').replace(/\/+$/, '');
        if (posterWarmupUrl && rawMetaCount > 0) {
          const { resolveCustomArtUrl, getDefaultPosterPattern, getPosterRatingApiKey, isRatingPostersEnabled } = require('../utils/parseProps');
          const ratingPostersEnabled = isRatingPostersEnabled(config);
          const posterPattern = ratingPostersEnabled ? (config.customPosterUrlPattern || (config.posterRatingProvider && config.posterRatingProvider !== 'custom' ? getDefaultPosterPattern(config.posterRatingProvider) : null)) : null;
          const proxyApiKey = ratingPostersEnabled && config.usePosterProxy ? getPosterRatingApiKey(config) : null;
          const addonHost = process.env.HOST_NAME ? (process.env.HOST_NAME.startsWith('http') ? process.env.HOST_NAME : `https://${process.env.HOST_NAME}`) : '';
          const posterUrls = [];

          for (const meta of result.metas) {
            const ids = extractIdsFromWarmerMeta(meta);
            const type = meta.type || catalog.type;
            const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));

            if (posterPattern && proxyId) {
              if (proxyApiKey) {
                posterUrls.push(`${addonHost}/poster/${type}/${proxyId}?fallback=${encodeURIComponent(meta.poster || '')}&lang=${config.language || 'en-US'}&key=${proxyApiKey}`);
              } else {
                const resolved = resolveCustomArtUrl(posterPattern, ids, type, config);
                if (resolved) {
                  if (config.usePosterProxy) {
                    posterUrls.push(`${addonHost}/poster/${type}/${proxyId}?fallback=${encodeURIComponent(meta.poster || '')}&url=${encodeURIComponent(resolved)}`);
                  } else {
                    posterUrls.push(resolved);
                  }
                }
              }
            } else if (meta.poster) {
              posterUrls.push(meta.poster);
            }
          }

          if (posterUrls.length > 0) {
            const posterDelay = parseInt(process.env.POSTER_WARMUP_DELAY_MS) || 50;
            const posterConcurrency = Math.max(1, parseInt(process.env.POSTER_WARMUP_CONCURRENCY) || 1);
            posterWarmingChain = posterWarmingChain.then(async () => {
              let warmed = 0;
              for (let i = 0; i < posterUrls.length; i += posterConcurrency) {
                const batch = posterUrls.slice(i, i + posterConcurrency);
                const results = await Promise.allSettled(
                  batch.map(url => fetch(`${posterWarmupUrl}/${url}`, { method: 'HEAD' }))
                );
                warmed += results.filter(r => r.status === 'fulfilled').length;
                if (posterDelay > 0) await new Promise(r => setTimeout(r, posterDelay));
              }
              this.log('debug', `[Poster Warming] Pre-warmed ${warmed} poster images for catalog ${catalogId}`);
            });
          }
        }

        if (rawMetaCount === 0) {
          this.log('debug', `Catalog ${catalogId}${genreValue ? ' (genre: '+genreValue+')' : ''} complete at skip=${currentSkip}`);
          break;
        }

        totalItems += rawMetaCount;
        pagesWarmed++;

        const cursorKey = `catalog-cursor:${uuid}:${catalogId}:${catalog.type}:${genreValue || 'all'}`;
        const raw = await redis.get(cursorKey);
        if (raw) {
          const cursor = JSON.parse(raw);
          currentSkip = cursor.served;
        } else {
          break;
        }

        await this.delay(this.config.taskDelayMs);
      } catch (error) {
        this.log('error', `Error warming ${catalogId}${genreValue ? ' (genre: '+genreValue+')' : ''} at skip=${currentSkip}: ${error.message}`);
        break;
      }
    }

    return { pages: pagesWarmed, items: totalItems };
  }

  async runWarmup(force = false) {
    if (this.isRunning) {
      this.log('warn', 'Warmup already running, skipping');
      return false;
    }

    this.syncConfigFromEnv();

    if (!this.config.enabled) {
      this.log('debug', 'Catalog warming is disabled');
      return false;
    }

    if (!this.config.uuids || this.config.uuids.length === 0) {
      this.log('error', 'Cannot run comprehensive warmup: CACHE_WARMUP_UUIDS is not set');
      return false;
    }

    // Check if we should run (skip if force is true)
    if (!force) {
      const shouldRun = await this.shouldWarmup();
      if (!shouldRun) {
        return false;
      }
    } else {
      this.log('info', 'Force restart requested - bypassing interval check');
    }

    // Check quiet hours
    if (this.isQuietHours()) {
      this.log('info', 'Skipping warmup during quiet hours');
      return false;
    }

    // Reset stop flag at start
    this.shouldStop = false;
    this.isRunning = true;
    this.stats.isRunning = true;
    this.stats.totalUUIDs = this.config.uuids.length;
    const startTime = Date.now();

    await redis.set('catalog-warmup:in-progress', Date.now().toString());

    try {
      this.log('success', `Starting comprehensive catalog warmup for ${this.config.uuids.length} UUID(s)...`);

      // Reset overall stats for this run (don't accumulate from previous runs)
      const userConfigs = {};
      let grandTotalCatalogs = 0;
      for (const uuid of this.config.uuids) {
        try {
          const config = await database.getUserConfig(uuid);
          if (config) {
            const allCatalogs = config.catalogs || [];
            const mergedChildIds = new Set();
            for (const c of allCatalogs) {
              if (c.enabled && c.source === 'merged' && c.metadata?.mergedSources) {
                for (const src of c.metadata.mergedSources) {
                  mergedChildIds.add(`${src.catalogId}:${src.catalogType}`);
                }
              }
            }
            const skipIds = new Set(['trakt.upnext', 'mdblist.upnext', 'publicmetadb.upnext']);
            const enabledCatalogs = allCatalogs.filter(c =>
              c.source !== 'merged' && !skipIds.has(c.id) &&
              (c.enabled || mergedChildIds.has(`${c.id}:${c.type}`))
            );
            userConfigs[uuid] = { config, enabledCatalogs };
            grandTotalCatalogs += enabledCatalogs.length;
            
            // Initialize UUID stats container
            this.stats.uuidStats[uuid] = {
              totalCatalogs: enabledCatalogs.length,
              catalogsWarmed: 0,
              totalPages: 0,
              totalItems: 0,
              duration: null,
              errors: []
            };
          }
        } catch (error) {
          this.log('error', `Failed to load config for pre-calc UUID ${uuid}: ${error.message}`);
        }
      }

      this.stats.totalCatalogs = grandTotalCatalogs;
      this.stats.catalogsWarmed = 0;
      this.stats.totalPages = 0;
      this.stats.totalItems = 0;
      this.stats.errors = [];

      // Process each UUID sequentially
      for (const uuid of this.config.uuids) {
        if (!this.shouldContinueWarming()) {
          this.log('info', 'Stop requested - stopping warmup');
          break;
        }
        
        const userData = userConfigs[uuid];
        if (!userData) {
          this.stats.errors.push({ uuid, error: 'Config not found during processing' });
          continue;
        }

        const freshConfig = await loadConfigFromDatabase(uuid);
        const enabledCatalogs = userData.enabledCatalogs;
        const config = freshConfig;

        await runWithRequestContext(uuid, async () => {
        try {
          this.log('info', `Processing UUID: ${uuid} (${enabledCatalogs.length} catalogs)`);
          const uuidStartTime = Date.now();

          let uuidWarmingInterrupted = false;
          for (const catalog of enabledCatalogs) {
            if (!this.shouldContinueWarming()) {
              this.log('info', 'Stop requested - stopping catalog warming');
              uuidWarmingInterrupted = true;
              break;
            }

            try {
              this.log('info', `Warming catalog: ${catalog.id} (${catalog.name}) for UUID ${uuid}`);
              this.stats.uuidStats[uuid].currentCatalog = catalog.name || catalog.id;
              const result = await this.warmCatalog(catalog, config, uuid);

              // Update Instance Stats (UUID)
              this.stats.uuidStats[uuid].catalogsWarmed++;
              this.stats.uuidStats[uuid].totalPages += result.pages;
              this.stats.uuidStats[uuid].totalItems += result.items;

              // Update Global Stats
              this.stats.catalogsWarmed++;
              this.stats.totalPages += result.pages;
              this.stats.totalItems += result.items;

              this.log('success', `✓ ${catalog.id}: ${result.pages} pages, ${result.items} items`);
            } catch (error) {
              this.log('error', `✗ ${catalog.id}: ${error.message}`);
              this.stats.uuidStats[uuid].errors.push({ catalog: catalog.id, error: error.message });
            }
          }

          delete this.stats.uuidStats[uuid].currentCatalog;
          const uuidDuration = Date.now() - uuidStartTime;
          this.stats.uuidStats[uuid].duration = `${Math.floor(uuidDuration / 60000)}m ${Math.floor((uuidDuration % 60000) / 1000)}s`;

          if (!uuidWarmingInterrupted) {
            await this.markWarmed(uuid, uuidStartTime);
            this.log('success', `UUID ${uuid} complete: ${this.stats.uuidStats[uuid].catalogsWarmed}/${this.stats.uuidStats[uuid].totalCatalogs} catalogs, ${this.stats.uuidStats[uuid].totalPages} pages, ${this.stats.uuidStats[uuid].totalItems} items in ${this.stats.uuidStats[uuid].duration}`);
          } else {
            this.log('warn', `UUID ${uuid} interrupted: ${this.stats.uuidStats[uuid].catalogsWarmed}/${this.stats.uuidStats[uuid].totalCatalogs} catalogs warmed before stop`);
          }
        } catch (error) {
          this.log('error', `Failed to process UUID ${uuid}: ${error.message}`);
          this.stats.errors.push({ uuid, error: error.message });
        }
        });
      }

      // Calculate overall duration
      const overallDuration = Date.now() - startTime;
      this.stats.duration = `${Math.floor(overallDuration / 60000)}m ${Math.floor((overallDuration % 60000) / 1000)}s`;
      this.stats.lastRun = new Date(startTime).toISOString();

      const stoppedEarly = this.shouldStop;
      this.log('success', `Warmup ${stoppedEarly ? 'stopped' : 'complete'}! Processed ${this.config.uuids.length} UUID(s), warmed ${this.stats.catalogsWarmed}/${this.stats.totalCatalogs} catalogs, ${this.stats.totalPages} pages, ${this.stats.totalItems} items in ${this.stats.duration}`);
      
      // Update nextRun time after successful warmup (for both scheduled and forced runs)
      const intervalMs = this.config.intervalHours * 60 * 60 * 1000;
      const nextRunTime = startTime + intervalMs;
      this.stats.nextRun = new Date(nextRunTime).toISOString();
      this.log('info', `Next warmup scheduled for ${this.formatNextRunTime(nextRunTime)}`);
      
      return true;
    } catch (error) {
      this.log('error', `Warmup failed: ${error.message}`);
      this.stats.errors.push({ global: error.message });
      return false;
    } finally {
      this.isRunning = false;
      this.stats.isRunning = false;
      this.shouldStop = false; // Reset stop flag
      await redis.del('catalog-warmup:in-progress').catch(() => {});
    }
  }

  async checkVersionAndWarmIfNeeded() {
    if (!this.config.autoOnVersionChange) {
      return false;
    }

    const currentVersion = buildInfo.version;
    const versionKey = 'catalog-warmup:last-version';
    
    try {
      const lastVersion = await redis.get(versionKey);
      
      if (lastVersion && lastVersion !== currentVersion) {
        this.log('success', `App version changed from ${lastVersion} to ${currentVersion} - triggering automatic warmup`);
        // Run warmup immediately (force=true bypasses interval checks)
        const warmupCompleted = await this.runWarmup(true);
        
        if (warmupCompleted) {
          // Store new version after successful warmup
          await redis.set(versionKey, currentVersion);
          this.log('success', `Version change warmup completed. Updated stored version to ${currentVersion}`);
          return true;
        } else {
          this.log('warn', 'Version change warmup was skipped or failed');
          return false;
        }
      } else if (!lastVersion) {
        await redis.set(versionKey, currentVersion);
        this.log('info', `Storing initial app version: ${currentVersion}`);
      }
      
      return false;
    } catch (error) {
      this.log('error', `Error checking version: ${error.message}`);
      return false;
    }
  }

  async startBackgroundWarming() {
    this.syncConfigFromEnv();

    if (!process.env.CACHE_WARMUP_UUIDS && !process.env.CACHE_WARMUP_UUID) {
      this.log('info', 'Comprehensive catalog warming disabled - CACHE_WARMUP_UUIDS not set');
      return;
    }

    if (!this.config.enabled) {
      this.log('info', 'Comprehensive catalog warming disabled (CACHE_WARMUP_MODE is not set to "comprehensive")');
      this.log('info', 'Set CACHE_WARMUP_MODE=comprehensive to enable');
      return;
    }

    this.log('success', `Comprehensive catalog warming enabled for ${this.config.uuids.length} UUID(s): ${this.config.uuids.join(', ')}`);
    this.log('info', `Interval: ${this.config.intervalHours}h, Initial delay: ${this.config.initialDelaySeconds}s`);
    
    if (this.config.autoOnVersionChange) {
      this.log('info', 'Auto-warmup on version change: enabled');
    }

    const versionWarmupRan = await this.checkVersionAndWarmIfNeeded();
    
    // If version warmup ran, we still want to schedule the next regular warmup
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

    if (!versionWarmupRan) {
      await this.delay(this.config.initialDelaySeconds * 1000);
    }

    // Schedule warmup with proper sequencing
    await this.scheduleNextWarmup();
  }

  async scheduleNextWarmup() {
    // Run warmup and schedule the next one after it completes
    this.log('info', 'Starting warmup cycle...');
    const didRun = await this.runWarmup();
    
    // nextRun is already updated by runWarmup() if it executed
    // Calculate delay until next scheduled run
    const MIN_RETRY_DELAY_MS = 60 * 1000;
    let delayMs;
    if (this.stats.nextRun) {
      // Calculate delay based on the scheduled nextRun time
      const nextRunTime = new Date(this.stats.nextRun).getTime();
      const now = Date.now();
      delayMs = Math.max(MIN_RETRY_DELAY_MS, nextRunTime - now);
      
      const delayMinutes = Math.round(delayMs / 60000);
      this.log('info', `Next check scheduled in ${delayMinutes} minutes`);
    } else {
      // Fallback to interval if nextRun is not set
      delayMs = this.config.intervalHours * 60 * 60 * 1000;
      this.log('info', `Next check scheduled in ${this.config.intervalHours} hours`);
    }
    
    if (!didRun && delayMs < MIN_RETRY_DELAY_MS) {
      delayMs = MIN_RETRY_DELAY_MS;
      this.log('info', 'Warmup skipped - retrying in 1 minute');
    }
    
    // Schedule the next check based on calculated delay
    setTimeout(async () => {
      await this.scheduleNextWarmup();
    }, delayMs);
  }

  async getStats() {
    this.syncConfigFromEnv();
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
        
        // Aggregate totals from per-UUID stats
        let totalCatalogs = 0;
        let catalogsWarmed = 0;
        let totalPages = 0;
        let totalItems = 0;
        
        for (const uuid of this.config.uuids) {
          const uuidStats = this.stats.uuidStats[uuid];
          if (uuidStats) {
            totalCatalogs += uuidStats.totalCatalogs || 0;
            catalogsWarmed += uuidStats.catalogsWarmed || 0;
            totalPages += uuidStats.totalPages || 0;
            totalItems += uuidStats.totalItems || 0;
          }
        }
        
        this.stats.totalCatalogs = totalCatalogs;
        this.stats.catalogsWarmed = catalogsWarmed;
        this.stats.totalPages = totalPages;
        this.stats.totalItems = totalItems;
      }
      
      // Recalculate nextRun if not set or if it has passed
      if (!this.stats.nextRun || new Date(this.stats.nextRun) < new Date()) {
        let earliestNextRun = null;
        let latestLastRun = null;
        
        for (const uuid of this.config.uuids) {
          const lastWarmupKey = `catalog-warmup:last-run:${uuid}`;
          const lastRun = await redis.get(lastWarmupKey);
          
          if (lastRun) {
            const lastRunTime = parseInt(lastRun);
            const nextRunTime = lastRunTime + (this.config.intervalHours * 60 * 60 * 1000);
            
            if (!earliestNextRun || nextRunTime < earliestNextRun) {
              earliestNextRun = nextRunTime;
            }
            
            if (!latestLastRun || lastRunTime > latestLastRun) {
              latestLastRun = lastRunTime;
            }
          }
        }
        
        if (earliestNextRun) {
          this.stats.nextRun = new Date(earliestNextRun).toISOString();
        }
        
        if (latestLastRun) {
          this.stats.lastRun = new Date(latestLastRun).toISOString();
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

function stopComprehensiveWarming() {
  return warmer.stopWarming();
}

module.exports = {
  startComprehensiveCatalogWarming,
  getWarmupStats,
  forceRestartWarmup,
  stopComprehensiveWarming
};

