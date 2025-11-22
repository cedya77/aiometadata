const express = require("express");
const favicon = require('serve-favicon');
const path = require("path");
const crypto = require('crypto');
const addon = express();
// Honor X-Forwarded-* headers from reverse proxies (e.g., Traefik) so req.protocol reflects HTTPS
//addon.set('trust proxy', true);

const { getCatalog } = require("./lib/getCatalog");
const { getSearch } = require("./lib/getSearch");
const { getManifest, DEFAULT_LANGUAGE } = require("./lib/getManifest");
const { getMeta } = require("./lib/getMeta");
const { cacheWrap, cacheWrapMeta, cacheWrapMetaSmart, cacheWrapCatalog, cacheWrapSearch, cacheWrapJikanApi, cacheWrapStaticCatalog, cacheWrapGlobal, getCacheHealth, clearCacheHealth, logCacheHealth, stableStringify } = require("./lib/getCache");
const redis = require("./lib/redisClient");
const { warmEssentialContent, warmPopularContent, scheduleEssentialWarming } = require("./lib/cacheWarmer");
const requestTracker = require("./lib/requestTracker");
const consola = require('consola');

// Configure logging level based on environment
const logLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
consola.level = consola.LogLevels[logLevel.toLowerCase()] ?? (process.env.NODE_ENV === 'production' ? 3 : 4);
const { getMediaRatingFromMDBList } = require("./utils/mdbList");

// Warm user-specific content based on their config
async function warmUserContent(userUUID, contentType) {
  try {
    // Load user config
    const config = await loadConfigFromDatabase(userUUID);
    if (!config) return;
    
    // Add userUUID to config for per-user token caching
    config.userUUID = userUUID;
    
    // Warm popular content based on user's preferences
    const language = config.language || DEFAULT_LANGUAGE;
    
    // Note: Popular content warming is now handled globally by warmPopularContent()
    // which runs every 6 hours and caches trending content for all users
    
    consola.success(`[Cache Warming] User content warmed for ${userUUID} (${contentType})`);
  } catch (error) {
    consola.warn(`[Cache Warming] Failed to warm user content for ${userUUID}:`, error.message);
  }
}
const configApi = require('./lib/configApi');
const database = require('./lib/database');
const { loadConfigFromDatabase } = require('./lib/configApi');
const { getTrending } = require("./lib/getTrending");
const { getRpdbPoster, checkIfExists, parseAnimeCatalogMeta, parseAnimeCatalogMetaBatch } = require("./utils/parseProps");
const { getFavorites, getWatchList } = require("./lib/getPersonalLists");
const { blurImage } = require('./utils/imageProcessor');
const axios = require('axios');
const jikan = require('./lib/mal');
const tvmaze = require('./lib/tvmaze');
const packageJson = require('../package.json');
const ADDON_VERSION = packageJson.version;
const sharp = require('sharp');

function shuffleMetas(metas = []) {
  const shuffled = Array.isArray(metas) ? metas.slice() : [];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Parse JSON and URL-encoded bodies for API routes
addon.use(express.json({ limit: '2mb' }));
addon.use(express.urlencoded({ extended: true }));

// Add request tracking middleware
addon.use(requestTracker.middleware());


const NO_CACHE = process.env.NO_CACHE === 'true';

// Initialize cache warming for public instances (enabled by default)
const ENABLE_CACHE_WARMING = process.env.ENABLE_CACHE_WARMING !== 'false';
const CACHE_WARMING_INTERVAL = parseInt(process.env.CACHE_WARMING_INTERVAL || '30', 10);

if (ENABLE_CACHE_WARMING && !NO_CACHE) {
  consola.info(`[Cache Warming] Initializing essential content warming (interval: ${CACHE_WARMING_INTERVAL} minutes)`);
  
  // Schedule periodic warming (non-blocking)
  scheduleEssentialWarming(CACHE_WARMING_INTERVAL);
  
  // Schedule popular content warming based on CACHE_WARM_INTERVAL_HOURS env (default 24h, minimum 12h)
  const POPULAR_WARM_INTERVAL_HOURS = Math.max(12, parseInt(process.env.CACHE_WARM_INTERVAL_HOURS || '24', 10));
  const POPULAR_WARM_CHECK_INTERVAL = 15 * 60 * 1000; // Check every 15 minutes
  
  consola.info(`[Cache Warming] Scheduling popular content warming (interval: ${POPULAR_WARM_INTERVAL_HOURS}h, check every 15min)`);
  
  // Check immediately on startup
  warmPopularContent().catch(error => {
    consola.warn('[Cache Warming] Initial popular content warming check failed:', error.message);
  });
  
  // Then check periodically (the function itself will decide if warming is needed)
  setInterval(async () => {
    await warmPopularContent().catch(error => {
      consola.warn('[Cache Warming] Popular content warming check failed:', error.message);
    });
  }, POPULAR_WARM_CHECK_INTERVAL);
} else {
  consola.info('[Cache Warming] Cache warming disabled or cache disabled');
}



const getCacheHeaders = function (opts) {
  opts = opts || {};
  let cacheHeaders = {
    cacheMaxAge: "max-age",
    staleRevalidate: "stale-while-revalidate",
    staleError: "stale-if-error",
  };
  const headerParts = Object.keys(cacheHeaders)
    .map((prop) => {
      const value = opts[prop];
      if (value === 0) return cacheHeaders[prop] + "=0"; // Handle zero values
      if (!value) return false;
      return cacheHeaders[prop] + "=" + value;
    })
    .filter((val) => !!val);
  
  return headerParts.length > 0 ? headerParts.join(", ") : false;
};

const respond = function (req, res, data, opts) {
  // Store minimal tracking data in res.locals for success detection
  if (req.path.includes('/catalog/') && data && data.metas) {
    res.locals.resultCount = data.metas.length;
    res.locals.hasResults = data.metas.length > 0;
  }

  if (NO_CACHE) {
    consola.debug('[Cache] Bypassing browser cache for this request.');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  } else {
    const userUUID = req.params.userUUID || '';
    
    // Enhanced ETag generation with config hash for better cache invalidation
    const configString = req.userConfig ? JSON.stringify(req.userConfig) : '';
    const configHash = crypto.createHash('md5').update(configString).digest('hex').substring(0, 8);
    let etagContent = ADDON_VERSION + JSON.stringify(data) + userUUID + configHash;
    
    // Force ETag to change when language changes
    if (req.userConfig && req.userConfig.language) {
        etagContent += ':lang:' + req.userConfig.language;
    }
    
    // Add route-specific cache invalidation factors
    if (req.route && req.route.path) {
      if (req.route.path.includes('/manifest.json')) {
        // Manifest should invalidate when any config changes
        etagContent += ':manifest';
      } else if (req.route.path.includes('/catalog/')) {
        // Catalog should invalidate when catalog-related config changes
        const catalogConfig = req.userConfig ? {
          language: req.userConfig.language,
          providers: req.userConfig.providers,
          sfw: req.userConfig.sfw,
          includeAdult: req.userConfig.includeAdult,
          ageRating: req.userConfig.ageRating,
          hideUnreleasedDigital: req.userConfig.hideUnreleasedDigital,
          exclusionKeywords: req.userConfig.exclusionKeywords,
          regexExclusionFilter: req.userConfig.regexExclusionFilter,
          showMetaProviderAttribution: req.userConfig.showMetaProviderAttribution,
          displayAgeRating: req.userConfig.displayAgeRating,
          apiKeys: { 
            rpdb: req.userConfig.apiKeys?.rpdb || process.env.RPDB_API_KEY || '',
            mdblist: req.userConfig.apiKeys?.mdblist || process.env.MDBLIST_API_KEY || ''
          },
          mal: req.userConfig.mal
        } : {};
        etagContent += crypto.createHash('md5').update(JSON.stringify(catalogConfig)).digest('hex').substring(0, 8);
      } else if (req.route.path.includes('/meta/')) {
        // Meta should invalidate when meta-related config changes
        const metaConfig = req.userConfig ? {
          language: req.userConfig.language,
          providers: req.userConfig.providers,
          tvdbSeasonType: req.userConfig.tvdbSeasonType,
          castCount: req.userConfig.castCount,
          blurThumbs: req.userConfig.blurThumbs,
          showMetaProviderAttribution: req.userConfig.showMetaProviderAttribution,
          displayAgeRating: req.userConfig.displayAgeRating,
          apiKeys: { 
            rpdb: req.userConfig.apiKeys?.rpdb || process.env.RPDB_API_KEY || '',
            mdblist: req.userConfig.apiKeys?.mdblist || process.env.MDBLIST_API_KEY || ''
          },
          mal: req.userConfig.mal
        } : {};
        etagContent += crypto.createHash('md5').update(JSON.stringify(metaConfig)).digest('hex').substring(0, 8);
      }
    }
    
    const etagHash = crypto.createHash('md5').update(etagContent).digest('hex');
    const etag = `W/"${etagHash}"`;

    res.setHeader('ETag', etag);

    // Enhanced cache invalidation strategy
    if (req.headers['if-none-match'] === etag) {
      consola.debug('[Cache] Browser cache hit but forcing refresh for ETag:', etag);
      // Don't return 304, continue to send fresh content
      // This ensures Stremio always gets the latest data when config changes
    }

    // Enhanced aggressive cache control for config-sensitive routes
    let cacheControl;
    if (req.route && req.route.path) {
      if (req.route.path.includes('/manifest.json')) {
        // Manifest: No cache at all - always fresh
        cacheControl = "no-cache, no-store, must-revalidate, max-age=0, s-maxage=0";
        consola.debug('[Cache] Setting manifest Cache-Control:', cacheControl);
      } else if (req.route.path.includes('/catalog/')) {
        // Catalog: Very short cache with aggressive revalidation
        const configVersion = req.userConfig?.configVersion || Date.now();
        res.setHeader('X-Config-Version', configVersion.toString());
        res.setHeader('Last-Modified', new Date(configVersion).toUTCString());
        
        // Use very short cache to force refresh when config changes
        cacheControl = "no-cache, must-revalidate, max-age=0";
        consola.debug('[Cache] Setting catalog Cache-Control:', cacheControl);
      } else if (req.route.path.includes('/meta/')) {
        // Meta: Aggressive cache control to ensure fresh data when config changes
        const configVersion = req.userConfig?.configVersion || Date.now();
        res.setHeader('X-Config-Version', configVersion.toString());
        res.setHeader('Last-Modified', new Date(configVersion).toUTCString());
        
        // Use very short cache to force refresh when config changes
        cacheControl = "no-cache, must-revalidate, max-age=0";
        consola.debug('[Cache] Setting aggressive meta Cache-Control:', cacheControl);
      } else {
        // For other routes, use getCacheHeaders if available, otherwise default
        const defaultCacheControl = getCacheHeaders(opts);
        cacheControl = defaultCacheControl || "public, max-age=3600";
        consola.debug('[Cache] Setting default Cache-Control:', cacheControl);
      }
      } else {
        // For routes without path info, use getCacheHeaders if available, otherwise default
        const defaultCacheControl = getCacheHeaders(opts);
        cacheControl = defaultCacheControl || "public, max-age=3600";
        consola.debug('[Cache] Setting default Cache-Control:', cacheControl);
      }
    
    res.setHeader("Cache-Control", cacheControl);
  }
  
  // Force aggressive cache control for meta routes (final override)
  if (req.route && req.route.path && (req.route.path.includes('/meta/') || req.route.path.includes('/catalog/'))) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Content-Type", "application/json");
  res.send(data);
};

  addon.get("/api/config", (req, res) => {
    const publicEnvConfig = {
      tmdb: process.env.TMDB_API || "",
      tvdb: process.env.TVDB_API_KEY || "",
      fanart: process.env.FANART_API_KEY || "",
      rpdb: process.env.RPDB_API_KEY || "",
      mdblist: process.env.MDBLIST_API_KEY || "",
      gemini: process.env.GEMINI_API_KEY || "",
      customDescriptionBlurb: process.env.CUSTOM_DESCRIPTION_BLURB || "",
      addonVersion: ADDON_VERSION,
      hasBuiltInTvdb: !!(process.env.BUILT_IN_TVDB_API_KEY),
      hasBuiltInTmdb: !!(process.env.BUILT_IN_TMDB_API_KEY),
      catalogTTL: parseInt(process.env.CATALOG_TTL || 24 * 60 * 60, 10), // Default to 24 hours
    };
    
    // No cache to prevent cross-instance contamination
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    res.json(publicEnvConfig);
  });

// --- Configuration Database API Routes ---
addon.post("/api/config/save", configApi.saveConfig.bind(configApi));
addon.post("/api/config/load/:userUUID", configApi.loadConfig.bind(configApi));
addon.put("/api/config/update/:userUUID", configApi.updateConfig.bind(configApi));
addon.post("/api/config/migrate", configApi.migrateFromLocalStorage.bind(configApi));
addon.get('/api/config/is-trusted/:uuid', configApi.isTrusted.bind(configApi));
addon.post("/api/test-keys", configApi.testApiKeys);
// Manual cache clearing endpoint (temporarily disabled due to binding issue)
// addon.post("/api/config/clear-cache/:userUUID", configApi.clearCache.bind(configApi));

// --- ID Mapping Correction Routes (Admin only) ---
addon.get("/api/corrections", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  configApi.getCorrections(req, res);
});

addon.post("/api/corrections/add", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  configApi.addCorrection(req, res);
});

addon.post("/api/corrections/remove", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  configApi.removeCorrection(req, res);
});

// --- Admin Configuration Routes ---
addon.get("/api/config/stats", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  configApi.getStats(req, res);
});

// --- Cache Warming Endpoints (Admin only) ---
addon.post("/api/cache/warm", async (req, res) => {
  // Simple admin check - you might want to implement proper authentication
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    consola.info('[API] Manual essential content warming requested');
    const results = await warmEssentialContent();
    res.json({ 
      success: true, 
      message: 'Essential content warming completed',
      results 
    });
  } catch (error) {
    consola.error('[API] Essential content warming failed:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

addon.get("/api/cache/status", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { isInitialWarmingComplete } = require('./lib/cacheWarmer');
  
  res.json({
    cacheEnabled: !NO_CACHE,
    warmingEnabled: ENABLE_CACHE_WARMING,
    warmingInterval: CACHE_WARMING_INTERVAL,
    initialWarmingComplete: isInitialWarmingComplete(),
    addonVersion: ADDON_VERSION
  });
});

// Cache health monitoring endpoints
addon.get("/api/cache/health", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const health = getCacheHealth();
  res.json({
    success: true,
    health,
    timestamp: new Date().toISOString()
  });
});

addon.post("/api/cache/health/clear", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  clearCacheHealth();
  res.json({
    success: true,
    message: 'Cache health statistics cleared'
  });
});

addon.post("/api/cache/health/log", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  logCacheHealth();
  res.json({
    success: true,
    message: 'Cache health logged to console'
  });
});

// Clear specific cache key
addon.delete("/api/cache/clear/:key", async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { key } = req.params;
  const { pattern } = req.query;
  
  try {
    if (pattern === 'true') {
      // Clear all keys matching pattern
      const keys = await redis.keys(key);
      if (keys.length > 0) {
        await redis.del(...keys);
        consola.info(`[Cache] Cleared ${keys.length} keys matching pattern: ${key}`);
        res.json({
          success: true,
          message: `Cleared ${keys.length} cache keys matching pattern: ${key}`,
          keysCleared: keys.length
        });
      } else {
        res.json({
          success: true,
          message: `No cache keys found matching pattern: ${key}`,
          keysCleared: 0
        });
      }
    } else {
      // Clear specific key
      const result = await redis.del(key);
      consola.info(`[Cache] Cleared cache key: ${key} (result: ${result})`);
      res.json({
        success: true,
        message: result > 0 ? `Cache key cleared: ${key}` : `Cache key not found: ${key}`,
        keyCleared: result > 0
      });
    }
  } catch (error) {
    consola.error(`[Cache] Error clearing cache key ${key}:`, error);
    res.status(500).json({
      error: 'Failed to clear cache key',
      details: error.message
    });
  }
});

// --- Static, Auth, and Configuration Routes ---
addon.get("/", function (_, res) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0'); 
    res.redirect("/configure"); 
});
// --- Basic Manifest Route ---
addon.get("/stremio/manifest.json", function (req, res) {
  const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;
    const basicManifest = {
        id: "com.aio.metadata",
        version: packageJson.version,
        name: "AIO Metadata",
        description: "A metadata addon for power users. AIOMetadata uses TMDB, TVDB, TVMaze, MyAnimeList, IMDB and Fanart.tv to provide accurate data for movies, series, and anime. You choose the source.",
        logo: `${host}/logo.png`,
        types: ["movie", "series"],
        catalogs: [],
        resources: [],
        idPrefixes: [],
        configurationRequired: true
    };
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.json(basicManifest);
});

// --- Database-Only Manifest Route ---
addon.get("/stremio/:userUUID/manifest.json", async function (req, res) {
    const { userUUID } = req.params;
    try {
        // Load config from database
        const config = await database.getUserConfig(userUUID);
        if (!config) {
            consola.debug(`[Manifest] No config found for user: ${userUUID}`);
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Headers', '*');
            return res.status(404).send({ err: "User configuration not found." });
        }
        
        consola.debug(`[Manifest] Building fresh manifest for user: ${userUUID}`);
        const manifest = await getManifest(config);
            if (!manifest) {
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Headers', '*');
                return res.status(500).send({ err: "Failed to build manifest." });
            }
            
        // Pass config to request object for ETag generation
        req.userConfig = config;
        
        // Add configVersion to manifest for cache busting when language changes
        if (config.configVersion) {
            manifest.configVersion = config.configVersion;
        }
        
        // Add language to manifest for additional cache busting
        manifest.language = config.language || DEFAULT_LANGUAGE;
        
        // Add aggressive cache-busting headers specifically for manifest
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0, s-maxage=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('X-Manifest-Language', config.language || DEFAULT_LANGUAGE);
        res.setHeader('X-Manifest-Version', config.configVersion ? config.configVersion.toString() : Date.now().toString());
        
        // Add a comment in the manifest to help with debugging
        manifest._debug = {
            language: config.language || DEFAULT_LANGUAGE,
            configVersion: config.configVersion || Date.now(),
            timestamp: new Date().toISOString()
        };
        
        // Add a timestamp to force cache invalidation
        manifest._timestamp = Date.now();
        
        // Use shorter cache time and add cache-busting for catalog changes
        const cacheOpts = { 
            cacheMaxAge: 0, // No cache to force immediate refresh
            staleRevalidate: 5 * 60, // 5 minutes stale-while-revalidate
            staleError: 24 * 60 * 60 // 24 hours stale-if-error
        };
            respond(req, res, manifest, cacheOpts);
    } catch (error) {
        consola.error(`[Manifest] Error for user ${userUUID}:`, error);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.status(500).send({ err: "Failed to build manifest." });
    }
});



// --- Catalog Route under /stremio/:userUUID prefix ---
addon.get("/stremio/:userUUID/catalog/:type/:id/:extra?.json", async function (req, res) {
  const { userUUID, type, id, extra } = req.params;
  
  // Load config from database
  const config = await loadConfigFromDatabase(userUUID);
  if (!config) {
    return res.status(404).send({ error: "User configuration not found" });
  }
  
  // Add userUUID to config for per-user token caching
  config.userUUID = userUUID;
  
  // Find the catalog in config and use original type (not displayType)
  // The 'type' parameter from URL could be either the original type or displayType from manifest
  // Match by id AND either type matches original type OR displayType
  const catalogConfig = config.catalogs?.find(c => 
    c.id === id && (c.type === type || c.displayType === type)
  );
  const actualType = catalogConfig ? catalogConfig.type : type;
  
  const hasRpdbKey =
    (config.apiKeys?.rpdb && config.apiKeys.rpdb.trim().length > 0);

  if (catalogConfig && !hasRpdbKey) {
    catalogConfig.enableRPDB = false;
  }

  //consola.debug(`[CATALOG ROUTE] catalogConfig:`, JSON.stringify(catalogConfig));
  //consola.debug(`[CATALOG ROUTE] enableRPDB value:`, catalogConfig?.enableRPDB, `(type: ${typeof catalogConfig?.enableRPDB})`);
  
  // Add current catalog config to global config for per-catalog settings (like enableRPDB)
  config._currentCatalogConfig = catalogConfig;
  
  const language = config.language || DEFAULT_LANGUAGE;
  const sessionId = config.sessionId;

  // Pass config to req for ETag generation
  req.userConfig = config;
  let extraArgs = {};
  if (extra) {
    if (id.includes('search') && extra.startsWith('search=')) {
      // Take everything after 'search=' as the query, and decode it.
      extraArgs = { search: decodeURIComponent(extra.substring('search='.length)) };
    } else {
      // For regular catalogs, decode the entire string first
      extraArgs = Object.fromEntries(new URLSearchParams(req.url.split("/").pop().split("?")[0].slice(0, -5)).entries());
    }
  }
  const cacheWrapper = cacheWrapCatalog;

  extraArgs = extraArgs || {};
  if (id === 'tvmaze.schedule') {
    // Format date in user's local timezone
    // Uses server's local timezone (better than UTC for most users)
    // If a timezone header is provided, we could use that, but Stremio doesn't send it
    const getLocalDateString = () => {
      const now = new Date();
      // Get local date components (not UTC) - uses server's timezone
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    
    const dateString = extraArgs.date || getLocalDateString();
    extraArgs.date = dateString;
    extraArgs.genre = !extraArgs.genre || extraArgs.genre === 'None' ? '' : extraArgs.genre.toUpperCase();
  }

  const catalogKey = `${id}:${actualType}:${stableStringify(extraArgs)}`;
  
  const cacheOptions = {
    enableErrorCaching: true,
    maxRetries: 2,
  };
  
  try {
    let responseData;
      
      if (id === 'search') {
      // Determine which search engine is being used based on type
      let searchEngine = null;
      if (actualType === 'movie') {
        searchEngine = config.search?.providers?.movie;
      } else if (actualType === 'series') {
        searchEngine = config.search?.providers?.series;
      } else if (actualType === 'anime.series') {
        searchEngine = config.search?.providers?.anime_series;
      } else if (actualType === 'anime.movie') {
        searchEngine = config.search?.providers?.anime_movie;
      } else if (actualType === 'collection') {
        searchEngine = 'tvdb.collections.search';
      }
      config._currentSearchEngine = searchEngine;
      
      // Use search-specific cache wrapper
      const searchKey = `${id}:${actualType}:${stableStringify(extraArgs)}`;
      
      responseData = await cacheWrapSearch(userUUID, searchKey, async () => {
        const searchResult = await getSearch(id, actualType, language, extraArgs, config);
        return { metas: searchResult.metas || [] };
      }, searchEngine, cacheOptions);
      } else {
      // Use regular catalog cache wrapper
      responseData = await cacheWrapper(userUUID, catalogKey, async () => {
        let metas = [];
        const { genre: genreName, type_filter,  skip } = extraArgs;
        const pageSize = id.includes(`mal.`) ? 25 : 
                         (id.startsWith('stremthru.') || id.startsWith('mdblist.') || id.startsWith('custom.') || (id.startsWith('tvdb.') && !id.startsWith('tvdb.collection.'))) ? 
                         parseInt(process.env.CATALOG_LIST_ITEMS_SIZE || '20') : 20;
        const page = skip ? Math.floor(parseInt(skip) / pageSize) + 1 : 1;
        const args = [actualType, language, page];
        switch (id) {
          case "tmdb.trending":
            //consola.debug(`[CATALOG ROUTE 2] tmdb.trending called with type=${actualType}, language=${language}, page=${page}`);
            metas = (await getTrending(...args, genreName, config, userUUID, false)).metas;
            break;
          case "tmdb.favorites":
            metas = (await getFavorites(...args, genreName, sessionId, config, userUUID, false)).metas;
            break;
          case "tmdb.watchlist":
            metas = (await getWatchList(...args, genreName, sessionId, config, userUUID, false)).metas;
            break;
          case "tvdb.genres": {
            metas = (await getCatalog(actualType, language, page, id, genreName, config, userUUID, false)).metas;
            break;
          }
          case "tvdb.collections": {
            // TVDB expects 0-based page
            const tvdbPage = Math.max(0, page - 1);
            metas = (await getCatalog(actualType, language, tvdbPage, id, genreName, config, userUUID)).metas;
            break;
          }
          case 'mal.airing':
          case 'mal.upcoming':
          case 'mal.top_movies':
          case 'mal.top_series':
          case 'mal.most_favorites':
          case 'mal.most_popular':
          case 'mal.top_anime':
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
            if (id === 'mal.airing') {
              const animeResults = await cacheWrapJikanApi(`mal-airing-${page}-${config.sfw}`, async () => {
                return await jikan.getAiringNow(page, config);
              });
              metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            } else if (id === 'mal.upcoming') {
              const animeResults = await cacheWrapJikanApi(`mal-upcoming-${page}-${config.sfw}`, async () => {
                return await jikan.getUpcoming(page, config);
              });
              metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            } else if (id === 'mal.top_movies') {
              const animeResults = await cacheWrapJikanApi(`mal-top-movies-${page}-${config.sfw}`, async () => {
                return await jikan.getTopAnimeByType('movie', page, config);
              });
              metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            } else if (id === 'mal.top_series') {
              const animeResults = await cacheWrapJikanApi(`mal-top-series-${page}-${config.sfw}`, async () => {
                return await jikan.getTopAnimeByType('tv', page, config);
              });
              metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            } else if (id === 'mal.most_popular') {
              //consola.debug(`[CATALOG ROUTE 2] mal.most_popular called with type=${actualType}, language=${language}, page=${page}`);
              const animeResults = await cacheWrapJikanApi(`mal-most-popular-${page}-${config.sfw}`, async () => {
                return await jikan.getTopAnimeByFilter('bypopularity', page, config);
              });
              metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            } else if (id === 'mal.most_favorites') {
              const animeResults = await cacheWrapJikanApi(`mal-most-favorites-${page}-${config.sfw}`, async () => {
                return await jikan.getTopAnimeByFilter('favorite', page, config);
              });
              metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            } else if (id === 'mal.top_anime') {
              const animeResults = await cacheWrapJikanApi(`mal-top-anime-${page}-${config.sfw}`, async () => {
                return await jikan.getTopAnimeByType('anime', page, config);
              });
              metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            } else {
            const [startDate, endDate] = decadeMap[id];
            const allAnimeGenres = await cacheWrapJikanApi('anime-genres', async () => {
              //consola.debug('[Cache Miss] Fetching fresh anime genre list from Jikan...');
              return await jikan.getAnimeGenres();
             });
                const genreNameToFetch = genreName && genreName !== 'None' ? genreName : allAnimeGenres[0]?.name;
            if (genreNameToFetch) {
              const selectedGenre = allAnimeGenres.find(g => g.name === genreNameToFetch);
              if (selectedGenre) {
                const genreId = selectedGenre.mal_id;
                    const animeResults = await cacheWrapJikanApi(`mal-${id}-${page}-${genreId}-${config.sfw}`, async () => {
                  return await jikan.getTopAnimeByDateRange(startDate, endDate, page, genreId, config);
                });
                    metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
                }
              }
              
            }
            break;
          }
          case 'tvmaze.schedule': {
            const scheduleDate = extraArgs.date;
            const scheduleCountry = extraArgs.genre;
            const scheduleEntries = await tvmaze.getFullSchedule(scheduleDate, scheduleCountry);

            if (!Array.isArray(scheduleEntries) || scheduleEntries.length === 0) {
              metas = [];
              break;
            }

            const stripHtml = (text) => text ? text.replace(/<[^>]*>?/gm, '') : '';

            // Filter out news shows
            const filteredEntries = scheduleEntries.filter(entry => {
              const showType = entry?.show?.type;
              return showType && showType.toLowerCase() !== 'news' && showType.toLowerCase() !== 'talk show';
            });

            const uniqueByShow = new Map();
            for (const entry of filteredEntries) {
              const showId = entry?.show?.id;
              if (!showId || uniqueByShow.has(showId)) continue;
              uniqueByShow.set(showId, entry);
            }

            const dedupedEntries = Array.from(uniqueByShow.values()).sort((a, b) => {
              const timeA = a?.airstamp ? new Date(a.airstamp).getTime() : 0;
              const timeB = b?.airstamp ? new Date(b.airstamp).getTime() : 0;
              return timeA - timeB;
            });

            const metasFromSchedule = await Promise.all(dedupedEntries.map(async (entry) => {
              const show = entry?.show;
              if (!show?.id) return null;

              const stremioId = `tvmaze:${show.id}`;
              let meta;

              try {
                const result = await cacheWrapMetaSmart(userUUID, stremioId, async () => {
                  return await getMeta('series', language, stremioId, config, userUUID, true);
                }, undefined, { enableErrorCaching: true, maxRetries: 2 }, 'series', true);

                meta = result?.meta;
              } catch (error) {
                consola.warn(`[Catalog Route] Failed to fetch meta for schedule entry ${stremioId}: ${error.message}`);
              }
              return meta;
            }));

            const validScheduleMetas = metasFromSchedule.filter(Boolean);
            const startIndex = (page - 1) * pageSize;
            const endIndex = startIndex + pageSize;
            metas = validScheduleMetas.slice(startIndex, endIndex);
            break;
          }
          case 'mal.genres': {
            const mediaType = type_filter || 'series';
            const allAnimeGenres = await cacheWrapJikanApi('anime-genres', async () => {
              //consola.debug('[Cache Miss] Fetching fresh anime genre list from Jikan...');
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
                //consola.debug(`[Catalog] Fetching anime for MAL studio: ${genreName}`);
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
                    consola.warn(`[Catalog] Could not find a MAL ID for studio name: ${genreName}`);
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
            // Parse season string like "Winter 2024" into season and year
            let seasonString = genreName;
            
            // If no season specified, calculate current season based on today's date
            if (!seasonString) {
              const currentDate = new Date();
              const currentYear = currentDate.getFullYear();
              const currentMonth = currentDate.getMonth(); // 0-11
              
              let currentSeason;
              if (currentMonth <= 2) currentSeason = 'Winter'; // Jan-Mar
              else if (currentMonth <= 5) currentSeason = 'Spring'; // Apr-Jun
              else if (currentMonth <= 8) currentSeason = 'Summer'; // Jul-Sep
              else currentSeason = 'Fall'; // Oct-Dec
              
              seasonString = `${currentSeason} ${currentYear}`;
            }
            
            const parts = seasonString.split(' ');
            const season = parts[0].toLowerCase(); // winter, spring, summer, fall
            const year = parseInt(parts[1]);
            const animeResults = await cacheWrapJikanApi(`mal-season-${year}-${season}-${page}-${config.sfw}`, async () => {
              return await jikan.getAnimeBySeason(year, season, page, config);
            });
            metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            break;
          }
          default:
            metas = (await getCatalog(actualType, language, page, id, genreName, config, userUUID, false)).metas;
            break;
      }
      return { metas: metas || [] };
    }, undefined, cacheOptions);
    }
    
    if (catalogConfig?.randomizePerPage && Array.isArray(responseData?.metas) && responseData.metas.length > 1) {
      responseData = {
        ...responseData,
        metas: shuffleMetas(responseData.metas)
      };
    }

    const httpCacheOpts = { cacheMaxAge: 0, staleRevalidate: 5 * 60 }; // No cache for regular catalogs, 5 min stale-while-revalidate
    respond(req, res, responseData, httpCacheOpts);

  } catch (e) {
    consola.error(`Error in catalog route for id "${id}" and type "${actualType}":`, e);
    return res.status(500).send("Internal Server Error");
  }
});
// --- Meta Route (with enhanced caching) ---
addon.get("/stremio/:userUUID/meta/:type/:id.json", async function (req, res) {
  const { userUUID, type, id: stremioId } = req.params;
  
  // Load config from database
  const config = await loadConfigFromDatabase(userUUID);
  if (!config) {
    return res.status(404).send({ error: "User configuration not found" });
  }
  
  // Add userUUID to config for per-user token caching
  config.userUUID = userUUID;
  
  const language = config.language || DEFAULT_LANGUAGE;
  const fullConfig = config; 
  
  // Pass config to req for ETag generation
  req.userConfig = config; 
  // Enhanced caching options for better error handling
  const cacheOptions = {
    enableErrorCaching: true,
    maxRetries: 2, // Allow retries for temporary failures
  };
  
  try {
    const result = await cacheWrapMetaSmart(userUUID, stremioId, async () => {
      return await getMeta(type, language, stremioId, fullConfig, userUUID, true);
    }, undefined, cacheOptions, type, true);

    if (!result || !result.meta) {
      return respond(req, res, { meta: null });
    } /*else if (result && result.meta) {
      // cache wrap the ratings
      if(result.meta.mal_id) {
        try {
          const ratings = await cacheWrapGlobal(`mdblist-ratings:mal:${type}:${result.meta.mal_id}`, async () => {
              return await getMediaRatingFromMDBList('mal', type === 'movie' ? 'movie' : type === 'series' ? 'show' : 'any', result.meta.mal_id, config.apiKeys?.mdblist);
            }, 7 * 24 * 60 * 60); // 7 days TTL
          result.meta.app_extras = result.meta.app_extras || {};
          result.meta.app_extras.ratings = ratings;
        } catch (error) {
          // Skip MDBList ratings if rate limited (429) or any other error
          if (error.response?.status === 429) {
            consola.warn(`[MDBList] Rate limited for MAL ID ${result.meta.mal_id}, skipping ratings`);
          } else {
            consola.warn(`[MDBList] Error fetching ratings for MAL ID ${result.meta.mal_id}:`, error.message);
          }
        }
      }
      else if(result.meta.imdb_id) {
        try {
          const ratings = await cacheWrapGlobal(`mdblist-ratings:imdb:${type}:${result.meta.imdb_id}`, async () => {
              return await getMediaRatingFromMDBList('imdb', type === 'movie' ? 'movie' : type === 'series' ? 'show' : 'any', result.meta.imdb_id, config.apiKeys?.mdblist);
            }, 7 * 24 * 60 * 60); // 7 days TTL
          result.meta.app_extras = result.meta.app_extras || {};
          result.meta.app_extras.ratings = ratings;
        } catch (error) {
          // Skip MDBList ratings if rate limited (429) or any other error
          if (error.response?.status === 429) {
            consola.warn(`[MDBList] Rate limited for IMDb ID ${result.meta.imdb_id}, skipping ratings`);
          } else {
            consola.warn(`[MDBList] Error fetching ratings for IMDb ID ${result.meta.imdb_id}:`, error.message);
          }
        }
      }
    }*/
    
    // Extract actual poster URL from RPDB proxy URL for meta route
    // Only remove RPDB proxy if enableRPDBForLibrary is disabled
    // Meta routes (continue watching/library) should keep RPDB if the option is enabled
    if (result.meta.poster && result.meta.poster.includes('/poster/') && result.meta.poster.includes('fallback=')) {
      // Check if RPDB should be kept for library items (continue watching/library)
      const keepRPDBForLibrary = config.enableRPDBForLibrary !== false; // Default to true
      
      if (!keepRPDBForLibrary) {
        // User has disabled RPDB for library items, extract fallback URL
        try {
          const url = new URL(result.meta.poster);
          const fallback = url.searchParams.get('fallback');
          if (fallback) {
            result.meta.poster = decodeURIComponent(fallback);
          }
        } catch (e) {
          // Keep original if URL parsing fails
          consola.warn(`[Meta Route] Failed to extract fallback poster URL: ${e.message}`);
        }
      }
      // If keepRPDBForLibrary is true (default), keep the RPDB proxy URL as-is
    }
    
    // Note: Popular content warming is now handled globally by warmPopularContent()
    // which runs every 6 hours in the background
    
    // Warm user's frequently accessed content in background
    if (!NO_CACHE) {
      warmUserContent(userUUID, type).catch(error => {
        consola.warn(`[Cache Warming] User content warming failed for ${userUUID}:`, error.message);
      });
    }
    
    // Use aggressive cache control for meta routes to ensure fresh data when config changes
    // Don't pass cacheOpts to let the respond function use the aggressive cache control
    respond(req, res, result);
    
  } catch (error) {
    consola.error(`CRITICAL ERROR in meta route for ${stremioId}:`, error);
    
    // Log error for dashboard
    try {
      await requestTracker.logError('error', `Meta route failed for ${stremioId}`, {
        stremioId,
        type,
        error: error.message,
        stack: error.stack
      });
    } catch (logError) {
      consola.warn('Failed to log error:', logError.message);
    }
    
    res.status(500).send("Internal Server Error");
  }
});

// --- Subtitle Route (for watch tracking) ---
// Route pattern matches Stremio's subtitle URL format: /:id/:extra?.json
// where extra contains filename, videoSize, and videoHash parameters
addon.get("/stremio/:userUUID/subtitles/:type/:id/:extra?.json", async function (req, res) {
  const { userUUID, type, id } = req.params;
  
  // Debug logging for all watch tracking attempts with media ID and user UUID
  consola.debug(`[Watch Tracking] Subtitle route matched - userUUID: ${userUUID}, type: ${type}, id: ${id}, extra: ${req.params.extra || 'none'}`);
  
  try {
    // Load config from database
    const config = await loadConfigFromDatabase(userUUID);
    if (!config) {
      consola.debug(`[Watch Tracking] No config found for user: ${userUUID}`);
      // Use Promise.resolve() for immediate response
      return respond(req, res, { subtitles: [] }, { cacheMaxAge: 0 });
    }
    
    // Check if watch tracking is enabled and MDBList API key exists
    const hasApiKey = config?.apiKeys?.mdblist;
    const trackingEnabled = !!config?.mdblistWatchTracking;
    
    if (hasApiKey && trackingEnabled) {
      // Import and call subtitle handler
      const { handleSubtitleRequest } = require('./lib/subtitleHandler');
      
      // Call handler synchronously (no await)
      const result = handleSubtitleRequest(type, id, config, userUUID);
      
      // Return empty subtitle response immediately
      return respond(req, res, result, { cacheMaxAge: 0 });
    } else {
      // Watch tracking disabled or no API key - return empty subtitles
      consola.debug(`[Watch Tracking] Skipped for user ${userUUID} - hasApiKey: ${!!hasApiKey}, trackingEnabled: ${trackingEnabled}`);
      return respond(req, res, { subtitles: [] }, { cacheMaxAge: 0 });
    }
  } catch (error) {
    consola.error(`[Watch Tracking] Subtitle route error - userUUID: ${userUUID}, type: ${type}, id: ${id}, error: ${error.message}`, {
      stack: error.stack,
      extra: req.params.extra
    });
    
    return respond(req, res, { subtitles: [] }, { cacheMaxAge: 0 });
  }
});

// Proxy endpoint for fetching manifests from internal Docker network URLs
addon.get("/api/proxy-manifest", async function (req, res) {
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  try {
    const { httpGet } = require('./utils/httpClient');
    const manifestData = await httpGet(url, {
      timeout: 10000
    });
    
    // Set CORS headers to allow frontend access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.json(manifestData.data);
  } catch (error) {
    consola.error(`[Proxy Manifest] Failed to fetch manifest from ${url}:`, error.message);
    res.status(error.response?.status || 500).json({ 
      error: error.message || 'Failed to fetch manifest' 
    });
  }
});

// API endpoint to auto-detect page size for external addon catalogs
addon.get("/api/detect-page-size", async function (req, res) {
  const { catalogUrl } = req.query;
  
  if (!catalogUrl) {
    return res.status(400).json({ error: 'Missing catalogUrl parameter' });
  }

  try {
    const { httpGet } = require('./utils/httpClient');
    
    // For the first page, Stremio doesn't include skip parameter at all
    // Fetch the base catalog URL directly without any skip parameter
    const response = await httpGet(catalogUrl, { timeout: 10000 });
    
    if (!response.data || !response.data.metas) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.json({ pageSize: 100, detected: false, error: 'Invalid response format' });
      return;
    }
    
    const pageSize = response.data.metas.length;
    
    if (pageSize === 0) {
      // If first page is empty, return error
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.json({ pageSize: 100, detected: false, error: 'No items found in first page' });
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.json({ pageSize, detected: true });
    }
  } catch (error) {
    consola.error(`[Detect Page Size] Failed to detect page size for ${catalogUrl}:`, error.message);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(error.response?.status || 500).json({ 
      pageSize: 100,
      detected: false,
      error: error.message || 'Failed to detect page size' 
    });
  }
});

addon.get("/poster/:type/:id", async function (req, res) {
  const { type, id } = req.params;
  const { fallback, lang, key } = req.query;
  if (!key) {
    return res.redirect(302, fallback);
  }

  const [idSource, idValue] = id.startsWith('tt') ? ['imdb', id] : id.split(':');
  const ids = {
    tmdbId: idSource === 'tmdb' ? idValue : null,
    tvdbId: idSource === 'tvdb' ? idValue : null,
    imdbId: idSource === 'imdb' ? idValue : null,
  };

  try {
    const rpdbUrl = getRpdbPoster(type, ids, lang, key);

    if (rpdbUrl && await checkIfExists(rpdbUrl)) {
      //console.log("Success! Pipe the image from RPDB directly to the user.");
      const imageResponse = await axios({
        method: 'get',
        url: rpdbUrl,
        responseType: 'stream'
      });
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
      imageResponse.data.pipe(res);
    } else {
      res.redirect(302, fallback);
    }
  } catch (error) {
    consola.error(`Error in poster proxy for ${id}:`, error.message);
    res.redirect(302, fallback);
  }
});


// --- Image Processing Routes ---
addon.get("/api/image/blur", async function (req, res) {
  const imageUrl = req.query.url;
  if (!imageUrl) { return res.status(400).send('Image URL not provided'); }
  
  // Add security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  try {
    const blurredImageBuffer = await blurImage(imageUrl);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(blurredImageBuffer);
  } catch (error) {
    consola.error('Error in blur route:', error);
    res.status(500).send('Error processing image');
  }
});

// Convert banner to background image
addon.get("/api/image/banner-to-background", async function (req, res) {
  const imageUrl = req.query.url;
  if (!imageUrl) { return res.status(400).send('Image URL not provided'); }
  
  try {
    const { convertBannerToBackground } = require('./utils/imageProcessor');
    
    // Parse options from query parameters
    const options = {
      width: parseInt(req.query.width) || 1920,
      height: parseInt(req.query.height) || 1080,
      blur: parseFloat(req.query.blur) || 0,
      brightness: parseFloat(req.query.brightness) || 1,
      contrast: parseFloat(req.query.contrast) || 1,
      position: req.query.position || 'center' // Add position parameter
    };
    
    const processedImage = await convertBannerToBackground(imageUrl, options);
    if (processedImage) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
      res.send(processedImage);
    } else {
      res.status(500).send('Failed to process image');
    }
  } catch (error) {
    consola.error(`Error converting banner to background for ${imageUrl}:`, error.message);
    res.status(500).send('Internal server error');
  }
});

// Add gradient overlay to image
addon.get("/api/image/gradient-overlay", async function (req, res) {
  const imageUrl = req.query.url;
  if (!imageUrl) { return res.status(400).send('Image URL not provided'); }
  
  try {
    const { addGradientOverlay } = require('./utils/imageProcessor');
    
    const options = {
      gradient: req.query.gradient || 'dark',
      opacity: parseFloat(req.query.opacity) || 0.7
    };
    
    const processedImage = await addGradientOverlay(imageUrl, options);
    if (processedImage) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
      res.send(processedImage);
    } else {
      res.status(500).send('Failed to process image');
    }
  } catch (error) {
    consola.error(`Error adding gradient overlay for ${imageUrl}:`, error.message);
    res.status(500).send('Internal server error');
  }
});

// --- Image Resize Route ---
addon.get('/resize-image', async function (req, res) {
  const imageUrl = req.query.url;
  const fit = req.query.fit || 'cover';
  const output = req.query.output || 'jpg';
  const quality = parseInt(req.query.q, 10) || 95;

  if (!imageUrl) {
    return res.status(400).send('Image URL not provided');
  }

  // Import the validation function
  const { validateImageUrl } = require('./utils/imageProcessor');
  
  // Validate URL before processing
  if (!validateImageUrl(imageUrl)) {
    return res.status(400).send('Invalid or unauthorized image URL');
  }

  try {
    const response = await axios.get(imageUrl, { 
      responseType: 'arraybuffer',
      timeout: 10000,
      maxContentLength: 10 * 1024 * 1024, // 10MB limit
      maxBodyLength: 10 * 1024 * 1024
    });
    let transformer = sharp(response.data).resize({
      width: 1280, // You can adjust or make this configurable
      height: 720,
      fit: fit
    });
    if (output === 'jpg' || output === 'jpeg') {
      transformer = transformer.jpeg({ quality });
      res.setHeader('Content-Type', 'image/jpeg');
    } else if (output === 'png') {
      transformer = transformer.png({ quality });
      res.setHeader('Content-Type', 'image/png');
    } else if (output === 'webp') {
      transformer = transformer.webp({ quality });
      res.setHeader('Content-Type', 'image/webp');
    } else {
      return res.status(400).send('Unsupported output format');
    }
    const buffer = await transformer.toBuffer();
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buffer);
  } catch (error) {
    consola.error('Error in resize-image route:', error);
    res.status(500).send('Error processing image');
  }
});




// Support Stremio settings opening under /stremio/:uuid/:config/configure
  addon.get('/stremio/:userUUID/configure', function (req, res) {
    // No cache to prevent cross-instance contamination
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, '../dist/index.html'));
  });

addon.use(favicon(path.join(__dirname, '../public/favicon.png')));
addon.use('/configure', express.static(path.join(__dirname, '../dist')));
addon.use(express.static(path.join(__dirname, '../public')));
addon.use(express.static(path.join(__dirname, '../dist')));

// Dedicated Dashboard Page Route
addon.get("/dashboard", (req, res) => {
  // Serve the same HTML but with dashboard-specific handling
  const indexPath = path.join(__dirname, '../dist/index.html');
  const fs = require('fs');
  
  try {
    let html = fs.readFileSync(indexPath, 'utf8');
    
    // Inject dashboard-specific meta tags and title
    html = html.replace(
      /<title>.*?<\/title>/,
      '<title>AIO Metadata Dashboard</title>'
    );
    
    // Add dashboard-specific script to auto-navigate to dashboard
    html = html.replace(
      '</head>',
      `  <script>
        window.DASHBOARD_MODE = true;
        window.addEventListener('DOMContentLoaded', function() {
          // Auto-navigate to dashboard tab when page loads
          setTimeout(function() {
            const dashboardTab = document.querySelector('[data-value="dashboard"], [value="dashboard"]');
            if (dashboardTab) {
              dashboardTab.click();
            }
          }, 100);
        });
      </script>
      </head>`
    );
    
    res.send(html);
  } catch (error) {
    consola.error('Error serving dashboard page:', error);
    res.status(500).send('Error loading dashboard');
  }
});

// Dashboard with trailing slash
addon.get("/dashboard/", (req, res) => {
  res.redirect('/dashboard');
});

addon.get('/api/config/addon-info', (req, res) => {
  res.setHeader('Cache-Control', 'private, max-age=300');

  res.json({
    requiresAddonPassword: !!process.env.ADDON_PASSWORD,
    addonVersion: ADDON_VERSION
  });
});

// --- Admin: Prune all ID mappings ---
addon.post('/api/admin/prune-id-mappings', async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    await database.pruneAllIdMappings();
    res.json({ success: true, message: 'All id_mappings pruned.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- Admin: User Management Endpoints ---

// Get all users with basic info
addon.get('/api/admin/users', async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const users = await database.getAllUsersWithStats();
    res.json({ users });
  } catch (error) {
    consola.error('[Admin API] Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get detailed user information
addon.get('/api/admin/users/:userUUID', async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const { userUUID } = req.params;
    const userDetails = await database.getUserDetails(userUUID);
    
    if (!userDetails) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ user: userDetails });
  } catch (error) {
    consola.error('[Admin API] Error fetching user details:', error);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

// Reset user password
addon.post('/api/admin/users/:userUUID/reset-password', async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const { userUUID } = req.params;
    const newPassword = await database.resetUserPassword(userUUID);
    
    if (!newPassword) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ newPassword });
  } catch (error) {
    consola.error('[Admin API] Error resetting password:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Delete user
addon.delete('/api/admin/users/:userUUID', async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const { userUUID } = req.params;
    const success = await database.deleteUser(userUUID);
    
    if (!success) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    consola.error('[Admin API] Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Export all user data
addon.get('/api/admin/users/export', async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const userData = await database.exportAllUserData();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=users-export-${new Date().toISOString().split('T')[0]}.json`);
    res.json(userData);
  } catch (error) {
    consola.error('[Admin API] Error exporting user data:', error);
    res.status(500).json({ error: 'Failed to export user data' });
  }
});

// Bulk delete inactive users
addon.post('/api/admin/users/bulk-delete-inactive', async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const { days = 30 } = req.body;
    const deletedCount = await database.deleteInactiveUsers(days);
    res.json({ deletedCount, message: `${deletedCount} inactive users deleted` });
  } catch (error) {
    consola.error('[Admin API] Error deleting inactive users:', error);
    res.status(500).json({ error: 'Failed to delete inactive users' });
  }
});

// Debug endpoint to help troubleshoot catalog issues
addon.get("/api/debug/catalogs/:userUUID", async function (req, res) {
  const { userUUID } = req.params;
  try {
    const config = await database.getUserConfig(userUUID);
    if (!config) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const streamingCatalogs = config.catalogs?.filter(c => c.source === 'streaming') || [];
    const mdblistCatalogs = config.catalogs?.filter(c => c.source === 'mdblist') || [];
    
    res.json({
      userUUID,
      streaming: config.streaming || [],
      catalogs: {
        total: config.catalogs?.length || 0,
        streaming: streamingCatalogs.length,
        mdblist: mdblistCatalogs.length,
        other: (config.catalogs?.length || 0) - streamingCatalogs.length - mdblistCatalogs.length
      },
      streamingCatalogs: streamingCatalogs.map(c => ({
        id: c.id,
        type: c.type,
        enabled: c.enabled,
        showInHome: c.showInHome
      })),
      mdblistCatalogs: mdblistCatalogs.map(c => ({
        id: c.id,
        type: c.type,
        enabled: c.enabled,
        showInHome: c.showInHome
      })),
      manifest: await getManifest(config)
    });
  } catch (error) {
    consola.error(`[Debug] Error for user ${userUUID}:`, error);
    res.status(500).json({ error: "Failed to get debug info" });
  }
});

// --- Delete user account and all associated data ---
addon.delete('/api/config/delete-user/:userUUID', async (req, res) => {
  const { userUUID } = req.params;
  const { password } = req.body;

  if (!userUUID || !password) {
    return res.status(400).json({ error: 'User UUID and password are required' });
  }

  try {
    // Verify the user exists and password is correct
    const user = await database.getUser(userUUID);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify password
    const isValidPassword = await database.verifyPassword(userUUID, password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    // Check if addon password is required
    if (process.env.ADDON_PASSWORD) {
      const addonPassword = req.body.addonPassword;
      if (!addonPassword || addonPassword !== process.env.ADDON_PASSWORD) {
        return res.status(401).json({ error: 'Invalid addon password' });
      }
    }

    // Delete user and all associated data
    await database.deleteUser(userUUID);
    
    consola.info(`[Delete User] Successfully deleted user ${userUUID} and all associated data`);
    
    res.json({ 
      success: true, 
      message: 'User account and all associated data have been permanently deleted' 
    });

  } catch (error) {
    consola.error(`[Delete User] Error deleting user ${userUUID}:`, error);
    res.status(500).json({ 
      error: 'Failed to delete user account',
      details: error.message 
    });
  }
});

// --- Cache Management Endpoints ---

// Clean bad cache entries
addon.post('/api/cache/clean-bad', async (req, res) => {
  try {
    const cacheValidator = require('./lib/cacheValidator');
    const result = await cacheValidator.cleanAllBadCache();
    
    res.json({
      success: true,
      message: 'Cache cleaning completed',
      results: result
    });
  } catch (error) {
    consola.error('[Cache Clean] Error:', error);
    res.status(500).json({ 
      error: 'Failed to clean cache',
      details: error.message 
    });
  }
});

// Get cache health statistics
addon.get('/api/cache/health', async (req, res) => {
  try {
    const { getCacheHealth } = require('./lib/getCache');
    const health = getCacheHealth();
    
    res.json({
      success: true,
      health: health
    });
  } catch (error) {
    consola.error('[Cache Health] Error:', error);
    res.status(500).json({ 
      error: 'Failed to get cache health',
      details: error.message 
    });
  }
});

// Test granular caching
addon.post('/api/cache/test-granular', async (req, res) => {
  try {
    const { userUUID, metaId, type } = req.body;
    
    if (!userUUID || !metaId || !type) {
      return res.status(400).json({ error: 'userUUID, metaId, and type are required' });
    }
    
    const { cacheWrapMetaSmart, reconstructMetaFromComponents } = require('./lib/getCache');
    
    // Test reconstruction
    const reconstructed = await reconstructMetaFromComponents(userUUID, metaId, undefined, {}, type);
    
    res.json({
      success: true,
      reconstructed: !!reconstructed,
      componentCount: reconstructed ? 'varies' : 0,
      message: reconstructed ? 'Components found and reconstructed' : 'No cached components found'
    });
  } catch (error) {
    consola.error('[Cache Test] Error:', error);
    res.status(500).json({ 
      error: 'Failed to test granular caching',
      details: error.message 
    });
  }
});

// Invalidate user's cache when config changes
addon.post('/api/cache/invalidate-user/:userUUID', async (req, res) => {
  try {
    const { userUUID } = req.params;
    const { password } = req.body;
    
    if (!userUUID || !password) {
      return res.status(400).json({ error: 'userUUID and password are required' });
    }
    
    // Verify the user exists and password is correct
    const user = await database.getUser(userUUID);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const isValidPassword = await database.verifyPassword(userUUID, password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    
    // Clear all cache entries for this user
    const userCachePattern = `*${userUUID}*`;
    const keys = await redis.keys(userCachePattern);
    
    if (keys.length > 0) {
      await redis.del(...keys);
      consola.info(`[Cache Invalidation] Cleared ${keys.length} cache entries for user ${userUUID}`);
      
      res.json({
        success: true,
        message: `Cache invalidated for user ${userUUID}`,
        cacheEntriesCleared: keys.length
      });
    } else {
      res.json({
        success: true,
        message: `No cache entries found for user ${userUUID}`,
        cacheEntriesCleared: 0
      });
    }
    
  } catch (error) {
    consola.error('[Cache Invalidation] Error:', error);
    res.status(500).json({ 
      error: 'Failed to invalidate cache',
      details: error.message 
    });
  }
});

// Get cache invalidation status for a user
// Test if essential cache keys exist
addon.get('/api/cache/test-essential', async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const essentialKeys = [
      `global:${ADDON_VERSION}:jikan-api:anime-genres`,
      `global:${ADDON_VERSION}:jikan-api:mal-studios`,
      `global:${ADDON_VERSION}:genre:tmdb:en-US:movie`,
      `global:${ADDON_VERSION}:genre:tmdb:en-US:series`,
      `global:${ADDON_VERSION}:genre:tvdb:en-US:series`,
      `global:${ADDON_VERSION}:languages:en-US`
    ];
    
    const results = {};
    for (const key of essentialKeys) {
      const exists = await redis.exists(key);
      results[key] = exists === 1;
    }
    
    const allCached = Object.values(results).every(exists => exists);
    
    res.json({
      success: true,
      allEssentialContentCached: allCached,
      cacheStatus: results,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    consola.error('[Cache Test] Error:', error);
    res.status(500).json({ 
      error: 'Failed to test cache',
      details: error.message 
    });
  }
});

addon.get('aapi/cache/invalidation-status/:userUUID', async (req, res) => {
  try {
    const { userUUID } = req.params;
    
    // Count cache entries for this user
    const userCachePattern = `*${userUUID}*`;
    const keys = await redis.keys(userCachePattern);
    
    // Group by cache type
    const cacheStats = {
      total: keys.length,
      byType: {}
    };
    
    keys.forEach(key => {
      if (key.includes('meta-')) {
        cacheStats.byType.meta = (cacheStats.byType.meta || 0) + 1;
      } else if (key.includes('catalog')) {
        cacheStats.byType.catalog = (cacheStats.byType.catalog || 0) + 1;
      } else if (key.includes('manifest')) {
        cacheStats.byType.manifest = (cacheStats.byType.manifest || 0) + 1;
      } else {
        cacheStats.byType.other = (cacheStats.byType.other || 0) + 1;
      }
    });
    
    res.json({
      success: true,
      userUUID,
      cacheStats
    });
    
  } catch (error) {
    consola.error('[Cache Status] Error:', error);
    res.status(500).json({ 
      error: 'Failed to get cache status',
      details: error.message 
    });
  }
});

// --- Dashboard API Routes (Admin only) ---
const DashboardAPI = require('./lib/dashboardApi');

// Create a singleton instance of DashboardAPI that persists across requests
let dashboardApiInstance = null;

function getDashboardAPI() {
  if (!dashboardApiInstance) {
    dashboardApiInstance = new DashboardAPI(redis, null, {}, database, requestTracker);
  }
  return dashboardApiInstance;
}

// Middleware to prevent caching on dynamic, instance-specific routes
const noCache = (req, res, next) => {
  // Instructs not to store the response in any cache.
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  // For older HTTP/1.0 caches.
  res.setHeader('Pragma', 'no-cache');
  // Tells proxies the response is immediately stale.
  res.setHeader('Expires', '0');
  next();
};

// Apply the no-cache middleware to all dashboard and dashboard API routes
addon.use('/dashboard', noCache);
addon.use('/api/dashboard', noCache);


addon.get("/api/dashboard/overview", (req, res) => {
  
  try {
    const dashboardApi = getDashboardAPI();
    dashboardApi.getAllDashboardData()
      .then(data => res.json(data))
      .catch(error => {
        consola.error('[Dashboard API] Error:', error);
        res.status(500).json({ error: 'Failed to fetch dashboard data' });
      });
  } catch (error) {
    consola.error('[Dashboard API] Error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

addon.get("/api/dashboard/stats", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const dashboardApi = getDashboardAPI();
    Promise.all([
      dashboardApi.getQuickStats(),
      dashboardApi.getCachePerformance(),
      dashboardApi.getProviderPerformance()
    ]).then(([quickStats, cachePerformance, providerPerformance]) => {
      res.json({ quickStats, cachePerformance, providerPerformance });
    }).catch(error => {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to fetch dashboard stats' });
    });
  } catch (error) {
    consola.error('[Dashboard API] Error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

addon.get("/api/dashboard/system", (req, res) => {
  
  try {
    const dashboardApi = getDashboardAPI();
    Promise.all([
      dashboardApi.getSystemConfig(),
      dashboardApi.getResourceUsage(),
      dashboardApi.getProviderStatus(),
      dashboardApi.getRecentActivity()
    ]).then(([systemConfig, resourceUsage, providerStatus, recentActivity]) => {
      res.json({ systemConfig, resourceUsage, providerStatus, recentActivity });
    }).catch(error => {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to fetch system data' });
    });
  } catch (error) {
    consola.error('[Dashboard API] Error:', error);
    res.status(500).json({ error: 'Failed to fetch system data' });
  }
});

addon.get("/api/dashboard/operations", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const dashboardApi = getDashboardAPI();
    Promise.all([
      dashboardApi.getErrorLogs(),
      dashboardApi.getMaintenanceTasks(),
      dashboardApi.getCachePerformance()
    ]).then(([errorLogs, maintenanceTasks, cacheStats]) => {
      res.json({ errorLogs, maintenanceTasks, cacheStats });
    }).catch(error => {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to fetch operations data' });
    });
  } catch (error) {
    consola.error('[Dashboard API] Error:', error);
    res.status(500).json({ error: 'Failed to fetch operations data' });
  }
});

// Enhanced timing metrics API endpoint
addon.get("/api/dashboard/timing", async (req, res) => {
  try {
    const timingMetrics = require('./lib/timing-metrics');
    
    // Get comprehensive timing data
    const [dashboardData, providerBreakdown, resolutionBreakdown] = await Promise.all([
      timingMetrics.getDashboardData(),
      timingMetrics.getProviderTimingBreakdown(),
      timingMetrics.getResolutionTimingBreakdown()
    ]);
    
    // Get timing trends for key metrics
    const timingTrends = {};
    const keyMetrics = ['id_resolution_total', 'search_operation', 'api_lookup'];
    
    for (const metric of keyMetrics) {
      timingTrends[metric] = await timingMetrics.getTimingTrends(metric);
    }
    
    // Add IMDb ratings stats
    let imdbRatingsStats = null;
    try {
      const { getRatingsStats } = require('./lib/imdbRatings.js');
      imdbRatingsStats = getRatingsStats();
    } catch (err) {
      consola.warn('[Dashboard API] Failed to get IMDb ratings stats:', err);
    }
    
    res.json({
      dashboard: dashboardData,
      providerBreakdown,
      resolutionBreakdown,
      timingTrends,
      imdbRatingsStats,
      lastUpdated: new Date().toISOString()
    });
  } catch (error) {
    consola.error('[Timing API] Error:', error);
    res.status(500).json({ error: 'Failed to fetch timing data' });
  }
});

addon.post("/api/dashboard/cache/clear", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const { type } = req.body;
    if (!type) {
      return res.status(400).json({ error: 'Cache type is required' });
    }
    
    const dashboardApi = getDashboardAPI();
    dashboardApi.clearCache(type)
      .then(result => res.json(result))
      .catch(error => {
        consola.error('[Dashboard API] Error:', error);
        res.status(500).json({ error: 'Failed to clear cache' });
      });
  } catch (error) {
    consola.error('[Dashboard API] Error:', error);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

addon.post("/api/dashboard/users/clear", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const dashboardApi = getDashboardAPI();
    
    // Call the new method to clear inflated user data
    if (dashboardApi.requestTracker && dashboardApi.requestTracker.clearActiveUserData) {
      dashboardApi.requestTracker.clearActiveUserData()
        .then(result => res.json(result))
        .catch(error => {
          consola.error('[Dashboard API] User data clear error:', error);
          res.status(500).json({ error: 'Failed to clear user data' });
        });
    } else {
      res.status(500).json({ error: 'Request tracker not available' });
    }
  } catch (error) {
    consola.error('[Dashboard API] Error:', error);
    res.status(500).json({ error: 'Failed to clear user data' });
  }
});

addon.get("/api/dashboard/analytics", async (req, res) => {
  
  try {
    const { getPerformanceStats } = require('./lib/id-resolver.js');
    
    const [stats, hourlyStats, topEndpoints, providerHourlyData, idResolverStats] = await Promise.all([
      requestTracker.getStats(),
      requestTracker.getHourlyStats(24),
      requestTracker.getTopEndpoints(10),
      requestTracker.getHourlyProviderStats(24),
      Promise.resolve(getPerformanceStats())
    ]);

    res.json({ 
      requestStats: stats, 
      hourlyData: hourlyStats,
      topEndpoints: topEndpoints,
      providerHourlyData: providerHourlyData,
      idResolverPerformance: idResolverStats
    });
  } catch (error) {
    consola.error('[Dashboard API] Error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics data' });
  }
});

addon.post("/api/dashboard/uptime/reset", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    // Reset the persistent uptime counter
    redis.set('addon:start_time', Date.now().toString()).then(() => {
      res.json({ 
        success: true, 
        message: 'Uptime counter reset successfully',
        newStartTime: new Date().toISOString()
      });
    }).catch(error => {
      consola.error('[Dashboard API] Error resetting uptime:', error);
      res.status(500).json({ error: 'Failed to reset uptime counter' });
    });
  } catch (error) {
    consola.error('[Dashboard API] Error:', error);
    res.status(500).json({ error: 'Failed to reset uptime counter' });
  }
});

// Test endpoint to generate sample error logs
addon.post("/api/dashboard/test-errors", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    // Generate some test error logs
    requestTracker.logError('error', 'Test error: Failed to fetch from AniList API', {
      endpoint: '/anime/12345',
      status: 500,
      responseTime: 2500
    });
    
    requestTracker.logError('warning', 'Test warning: TMDB rate limit approaching', {
      remaining: 5,
      resetTime: Date.now() + 3600000
    });
    
    requestTracker.logError('info', 'Test info: Cache warming completed', {
      itemsWarmed: 150,
      duration: '2.5s'
    });
    
    res.json({ 
      success: true, 
      message: 'Test error logs generated successfully'
    });
  } catch (error) {
    consola.error('[Dashboard API] Error generating test errors:', error);
    res.status(500).json({ error: 'Failed to generate test errors' });
  }
});

addon.get("/api/dashboard/content", (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    Promise.all([
      requestTracker.getPopularContent(10),
      requestTracker.getSearchPatterns(limit),
      requestTracker.getStats() // For content quality metrics
    ]).then(([popularContent, searchPatterns, stats]) => {
      res.json({ 
        popularContent,
        searchPatterns,
        contentQuality: {
          missingMetadata: 0, // TODO: Implement real tracking
          failedMappings: 0,  // TODO: Implement real tracking
          correctionRequests: 0, // TODO: Implement real tracking
          successRate: parseFloat(100 - stats.errorRate)
        }
      });
    }).catch(error => {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to fetch content data' });
    });
  } catch (error) {
    consola.error('[Dashboard API] Error:', error);
    res.status(500).json({ error: 'Failed to fetch content data' });
  }
});

addon.get("/api/dashboard/users", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const dashboardApi = getDashboardAPI();
    dashboardApi.getUserStats()
      .then(data => res.json(data))
      .catch(error => {
        consola.error('[Dashboard API] Error:', error);
        res.status(500).json({ error: 'Failed to fetch user data' });
      });
  } catch (error) {
    consola.error('[Dashboard API] Error:', error);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});

// MAL Catalog Warmup Stats endpoint
addon.get("/api/dashboard/mal-warmup", (req, res) => {
  try {
    const { getWarmupStats } = require('./lib/malCatalogWarmer');
    const stats = getWarmupStats();
    res.json(stats);
  } catch (error) {
    consola.error('[MAL Warmer API] Error:', error);
    res.status(500).json({ error: 'Failed to fetch MAL warmup stats' });
  }
});

// Comprehensive Catalog Warmup Stats endpoint
addon.get("/api/dashboard/catalog-warmup", (req, res) => {
  try {
    const { getWarmupStats } = require('./lib/comprehensiveCatalogWarmer');
    const stats = getWarmupStats();
    res.json(stats);
  } catch (error) {
    consola.error('[Catalog Warmer API] Error:', error);
    res.status(500).json({ error: 'Failed to fetch catalog warmup stats' });
  }
});

// Comprehensive Warming Dashboard - combines all warming systems
addon.get("/api/dashboard/warming", (req, res) => {
  try {
    // Get stats from all warming systems
    const { getWarmupStats: getMALStats } = require('./lib/malCatalogWarmer');
    const { getWarmupStats: getCatalogStats } = require('./lib/comprehensiveCatalogWarmer');
    const { getWarmupStats: getEssentialStats } = require('./lib/cacheWarmer');
    
    const malStats = getMALStats();
    const catalogStats = getCatalogStats();
    const essentialStats = getEssentialStats();
    
    // Get current environment configuration
    const config = {
      mode: process.env.CACHE_WARMUP_MODE || 'essential',
      uuid: process.env.CACHE_WARMUP_UUID || 'system-cache-warmer',
      malEnabled: process.env.MAL_WARMUP_ENABLED !== 'false',
      tmdbPopularEnabled: process.env.TMDB_POPULAR_WARMING_ENABLED !== 'false',
      catalogInterval: parseInt(process.env.CATALOG_WARMUP_INTERVAL_HOURS) || 24,
      malInterval: parseInt(process.env.MAL_WARMUP_INTERVAL_HOURS) || 6,
    };
    
    res.json({
      config,
      systems: {
        essential: essentialStats,
        mal: malStats,
        comprehensive: catalogStats
      },
      overall: {
        isAnyRunning: malStats.isWarming || catalogStats.isRunning || essentialStats.isWarming,
        lastRun: Math.max(
          malStats.lastRun || 0,
          catalogStats.lastRun || 0,
          essentialStats.lastRun || 0
        ),
        totalItems: (malStats.totalItems || 0) + (catalogStats.totalItems || 0) + (essentialStats.totalItems || 0)
      }
    });
  } catch (error) {
    consola.error('[Warming Dashboard API] Error:', error);
    res.status(500).json({ error: 'Failed to fetch warming dashboard data' });
  }
});

// Warming Control Endpoints
addon.post("/api/dashboard/warming/control", (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const { action, system } = req.body;
    
    if (!action || !system) {
      return res.status(400).json({ error: 'Action and system are required' });
    }
    
    let result = { success: false, message: '' };
    
    switch (system) {
      case 'mal':
        if (action === 'start') {
          const { startMALWarmup } = require('./lib/malCatalogWarmer');
          startMALWarmup();
          result = { success: true, message: 'MAL warming started' };
        } else if (action === 'stop') {
          // MAL warmer doesn't have a stop method, but we can log it
          result = { success: true, message: 'MAL warming will stop after current task' };
        }
        break;
        
      case 'comprehensive':
        if (action === 'start') {
          const { startComprehensiveCatalogWarming } = require('./lib/comprehensiveCatalogWarmer');
          startComprehensiveCatalogWarming();
          result = { success: true, message: 'Comprehensive warming started' };
        } else if (action === 'stop') {
          // Comprehensive warmer doesn't have a stop method, but we can log it
          result = { success: true, message: 'Comprehensive warming will stop after current task' };
        }
        break;
        
      case 'essential':
        if (action === 'start') {
          const { warmEssentialContent } = require('./lib/cacheWarmer');
          warmEssentialContent();
          result = { success: true, message: 'Essential warming started' };
        } else if (action === 'stop') {
          result = { success: true, message: 'Essential warming will stop after current task' };
        }
        break;
        
      default:
        return res.status(400).json({ error: 'Invalid system specified' });
    }
    
    res.json(result);
  } catch (error) {
    consola.error('[Warming Control API] Error:', error);
    res.status(500).json({ error: 'Failed to control warming system' });
  }
});

// Maintenance Task Execution endpoint
addon.post("/api/dashboard/maintenance/execute", async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const { taskId, action } = req.body;
    
    if (!taskId || !action) {
      return res.status(400).json({ error: 'Task ID and action are required' });
    }
    
    let result = { success: false, message: '' };
    
    // Handle warming tasks
    if (taskId === 1) { // Clear expired cache entries
      if (action === 'restart' || action === 'enable') {
        try {
          const dashboardApi = getDashboardAPI();
          result = await dashboardApi.clearExpiredCacheEntries();
        } catch (error) {
          consola.error('[Maintenance Task] Error clearing expired cache:', error);
          result = { success: false, message: `Failed to clear expired cache: ${error.message}` };
        }
      } else if (action === 'stop') {
        result = { success: true, message: 'Cache cleanup task completed' };
      }
    } else if (taskId === 7) { // Essential Cache Warming
      if (action === 'restart' || action === 'enable') {
        const { warmEssentialContent } = require('./lib/cacheWarmer');
        warmEssentialContent();
        result = { success: true, message: 'Essential cache warming started' };
      } else if (action === 'stop') {
        result = { success: true, message: 'Essential warming will stop after current task' };
      }
    } else if (taskId === 8) { // MAL Catalog Warming
      if (action === 'restart' || action === 'enable') {
        const { startMALWarmup } = require('./lib/malCatalogWarmer');
        startMALWarmup();
        result = { success: true, message: 'MAL catalog warming started' };
      } else if (action === 'stop') {
        result = { success: true, message: 'MAL warming will stop after current task' };
      }
    } else if (taskId === 9) { // Comprehensive Catalog Warming
      if (action === 'restart' || action === 'enable') {
        const { forceRestartWarmup } = require('./lib/comprehensiveCatalogWarmer');
        forceRestartWarmup();
        result = { success: true, message: 'Comprehensive catalog warming started (force restart)' };
      } else if (action === 'stop') {
        result = { success: true, message: 'Comprehensive warming will stop after current task' };
      }
    } else if (taskId === 10) { // Cache Cleanup Scheduler Control
      const { getCacheCleanupScheduler } = require('./lib/cacheCleanupScheduler');
      const scheduler = getCacheCleanupScheduler();
      
      if (action === 'restart' || action === 'enable') {
        if (scheduler) {
          scheduler.start();
          result = { success: true, message: 'Cache cleanup scheduler started' };
        } else {
          result = { success: false, message: 'Cache cleanup scheduler not available' };
        }
      } else if (action === 'stop') {
        if (scheduler) {
          scheduler.stop();
          result = { success: true, message: 'Cache cleanup scheduler stopped' };
        } else {
          result = { success: false, message: 'Cache cleanup scheduler not available' };
        }
      }
    } else {
      // Handle other maintenance tasks (cache cleanup, etc.)
      result = { success: false, message: 'Task execution not implemented yet' };
    }
    
    res.json(result);
  } catch (error) {
    consola.error('[Maintenance Task API] Error:', error);
    res.status(500).json({ error: 'Failed to execute maintenance task' });
  }
});

// Blocking startup function that waits for cache warming
async function startServerWithCacheWarming() {
  if (ENABLE_CACHE_WARMING && !NO_CACHE) {
    consola.info('[Server Startup] Waiting for initial cache warming to complete...');
    const { warmEssentialContent } = require("./lib/cacheWarmer");
    
    try {
      await warmEssentialContent();
      consola.success('[Server Startup] Initial cache warming completed successfully');
    } catch (error) {
      consola.error('[Server Startup] Initial cache warming failed:', error.message);
      consola.info('[Server Startup] Continuing with server startup despite cache warming failure');
    }
  }
  
  consola.success('[Server Startup] Server ready to accept requests');
  return addon;
}

module.exports = { addon, startServerWithCacheWarming, getDashboardAPI };
