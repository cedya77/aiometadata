const express = require("express");
const favicon = require('serve-favicon');
const fs = require('fs');
const path = require("path");
const crypto = require('crypto');
const v8 = require('v8');
const addon = express();
// Honor X-Forwarded-* headers from reverse proxies (e.g., Traefik) so req.protocol reflects HTTPS
//addon.set('trust proxy', true);

const { getCatalog } = require("./lib/getCatalog");
const anilist = require("./lib/anilist");
const { getSearch } = require("./lib/getSearch");
const { getManifest, DEFAULT_LANGUAGE } = require("./lib/getManifest");
const { getMeta } = require("./lib/getMeta");
const { cacheWrapMetaSmart, cacheWrapCatalog, cacheWrapSearch, cacheWrapJikanApi, cacheWrapStaticCatalog, cacheWrapGlobal, getCacheHealth, clearCacheHealth, logCacheHealth, stableStringify, deleteKeysByPattern, scanKeys } = require("./lib/getCache");
const redis = require("./lib/redisClient");
const { warmEssentialContent, warmPopularContent, scheduleEssentialWarming } = require("./lib/cacheWarmer");
const requestTracker = require("./lib/requestTracker");
const consola = require('consola');
const { stripReleaseAvailabilityForResponse } = require('./utils/releaseAvailability');

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
const { getRpdbPoster, getRatingPosterUrl, parseAnimeCatalogMeta, parseAnimeCatalogMetaBatch } = require("./utils/parseProps");
const { getFavorites, getWatchList } = require("./lib/getPersonalLists");
const { resolveDynamicTmdbDiscoverParams } = require('./lib/tmdbDiscoverDateTokens');
const { blurImage, convertBannerToBackground } = require('./utils/imageProcessor');
const { TraktClient } = require('./lib/trakt');
const { SimklClient } = require('./lib/simkl');
const axios = require('axios');
const getCountryISO3 = require('country-iso-2-to-3');
const jikan = require('./lib/mal');
const { getTvmazeScheduleCatalog } = require('./lib/tvmazeScheduleCatalog');
const buildInfo = require('./lib/buildInfo');
const { clientDistDir, clientIndexPath, publicDir } = require('./lib/runtimePaths');
const ADDON_VERSION = buildInfo.version;
const sharp = require('sharp');
const idMapper = require('./lib/id-mapper');
const wikiMappings = require('./lib/wiki-mapper.js');

// Normalize redirect URIs to always include a scheme
const normalizeRedirectUri = (uri) => {
  if (!uri) return uri;
  const trimmed = uri.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  return `https://${trimmed.replace(/^\/+/, '')}`;
};
const usedTraktCodes = new Set();
const pendingTraktOAuthStates = new Map();
const TRAKT_OAUTH_STATE_TTL_MS = parseInt(process.env.TRAKT_OAUTH_STATE_TTL_MS || String(10 * 60 * 1000), 10);
const usedAnilistCodes = new Set();

function createTraktOAuthState() {
  const state = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + TRAKT_OAUTH_STATE_TTL_MS;
  pendingTraktOAuthStates.set(state, expiresAt);

  // Opportunistic cleanup to keep the in-memory map bounded.
  const now = Date.now();
  for (const [storedState, storedExpiresAt] of pendingTraktOAuthStates.entries()) {
    if (storedExpiresAt <= now) {
      pendingTraktOAuthStates.delete(storedState);
    }
  }

  return state;
}

function consumeTraktOAuthState(state) {
  if (!state || typeof state !== 'string') return false;
  const expiresAt = pendingTraktOAuthStates.get(state);
  if (!expiresAt) return false;
  pendingTraktOAuthStates.delete(state);
  return expiresAt > Date.now();
}

function shuffleMetas(metas = []) {
  const shuffled = Array.isArray(metas) ? metas.slice() : [];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Extract IDs from a catalog meta object for custom art URL resolution.
 * Handles id formats: "tmdb:123", "tvdb:456", "tt1234567", "kitsu:123", "mal:123", "anilist:123", "anidb:123"
 */
function extractIdsFromMeta(meta) {
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

  // Pick up additional IDs from meta properties
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

// Parse JSON and URL-encoded bodies for API routes
addon.use(express.json({ limit: '2mb' }));
addon.use(express.urlencoded({ extended: true }));

// Global CORS middleware: ensure every response includes CORS headers
// This prevents browser blocks when a route returns early or on errors
addon.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  // Reply to preflight immediately
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Add request tracking middleware
addon.use(requestTracker.middleware());

const TEST_KEYS_RATE_LIMIT_PER_MIN = parseInt(process.env.TEST_KEYS_RATE_LIMIT_PER_MIN || '60', 10);

async function testKeysRateLimitMiddleware(req, res, next) {
  // If Redis is disabled/unavailable, do not block requests.
  if (!redis) {
    return next();
  }

  try {
    const minuteBucket = Math.floor(Date.now() / 60000);
    const rateKey = `rate-limit:test-keys:${minuteBucket}`;
    const currentCount = await redis.incr(rateKey);

    // First hit in this minute bucket: set a short TTL.
    if (currentCount === 1) {
      await redis.expire(rateKey, 70);
    }

    if (currentCount > TEST_KEYS_RATE_LIMIT_PER_MIN) {
      return res.status(429).json({ error: 'Too many API key validation requests. Please try again shortly.' });
    }
  } catch (error) {
    consola.warn('[Rate Limit] /api/test-keys limiter failed, allowing request:', error.message);
  }

  next();
}


const NO_CACHE = process.env.NO_CACHE === 'true';
const POSTER_PROXY_PREFIX_URL = (process.env.POSTER_PROXY_PREFIX_URL || '').replace(/\/+$/, '');

// Initialize cache warming for public instances (enabled by default)
const ENABLE_CACHE_WARMING = process.env.ENABLE_CACHE_WARMING !== 'false';
const CACHE_WARMING_INTERVAL = parseInt(process.env.CACHE_WARMING_INTERVAL || '720', 10);

if (ENABLE_CACHE_WARMING && !NO_CACHE) {
  consola.info(`[API Cache Warming] Initializing API cache warming (interval: ${CACHE_WARMING_INTERVAL} minutes)`);

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

    const routePath = req.route?.path || '';
    const isCatalogOrMetaRoute = routePath.includes('/catalog/') || routePath.includes('/meta/');

    if (!isCatalogOrMetaRoute) {
      // Preserve rich ETag behavior for non-hot routes (e.g., manifest/debug endpoints).
      const configHash = req.userConfig?.configHash
        || crypto.createHash('md5').update(req.userConfig ? JSON.stringify(req.userConfig) : '').digest('hex').substring(0, 8);
      let etagContent = ADDON_VERSION + JSON.stringify(data) + userUUID + configHash;

      if (req.userConfig && req.userConfig.language) {
        etagContent += ':lang:' + req.userConfig.language;
      }

      if (req.route && req.route.path && req.route.path.includes('/manifest.json')) {
        etagContent += ':manifest';
      }

      const etagHash = crypto.createHash('md5').update(etagContent).digest('hex');
      const etag = `W/"${etagHash}"`;

      res.setHeader('ETag', etag);

      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }
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

  // Prefix poster URLs with reverse proxy URL for local caching
  if (POSTER_PROXY_PREFIX_URL && data) {
    const prefixPoster = (url) => {
      if (!url || url.startsWith(POSTER_PROXY_PREFIX_URL)) return url;
      return `${POSTER_PROXY_PREFIX_URL}/${url}`;
    };
    if (data.meta?.poster) {
      data.meta.poster = prefixPoster(data.meta.poster);
    }
    if (data.metas) {
      for (const meta of data.metas) {
        if (meta.poster) {
          meta.poster = prefixPoster(meta.poster);
        }
      }
    }
  }

  stripReleaseAvailabilityForResponse(data);
  res.send(data);
};

  addon.get("/api/config", (req, res) => {
    // Simkl trending page size options: comma-separated, e.g. "50,100" or "50,100,200,500"
    const simklPageSizeStr = process.env.SIMKL_TRENDING_PAGE_SIZE_OPTIONS || "50,100";
    const simklTrendingPageSizeOptions = simklPageSizeStr
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n) && n >= 1 && n <= 500)
      .sort((a, b) => a - b);
    const fallbackOptions = [50, 100];
    const resolvedOptions = simklTrendingPageSizeOptions.length > 0 ? simklTrendingPageSizeOptions : fallbackOptions;

    const publicEnvConfig = {
      tmdb: process.env.TMDB_API || "",
      tvdb: process.env.TVDB_API_KEY || "",
      fanart: process.env.FANART_API_KEY || "",
      rpdb: process.env.RPDB_API_KEY || "",
      mdblist: process.env.MDBLIST_API_KEY || "",
      gemini: process.env.GEMINI_API_KEY || "",
      trakt: process.env.TRAKT_CLIENT_ID || "",
      simkl: process.env.SIMKL_CLIENT_ID || "",
      customDescriptionBlurb: process.env.CUSTOM_DESCRIPTION_BLURB || "",
      addonVersion: ADDON_VERSION,
      hasBuiltInTvdb: !!(process.env.BUILT_IN_TVDB_API_KEY),
      hasBuiltInTmdb: !!(process.env.BUILT_IN_TMDB_API_KEY),
      catalogTTL: parseInt(process.env.CATALOG_TTL || 24 * 60 * 60, 10), // Default to 24 hours
      simklTrendingPageSizeOptions: resolvedOptions,
      traktSearchEnabled: process.env.DISABLE_TRAKT_SEARCH !== 'true',
    };
    
    // No cache to prevent cross-instance contamination
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    res.json(publicEnvConfig);
  });

  addon.get("/health", (req, res) => {
    res.status(200).json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      version: ADDON_VERSION,
    });
  });

// --- Configuration Database API Routes ---
addon.post("/api/config/save", configApi.saveConfig.bind(configApi));
addon.post("/api/config/load/:userUUID", configApi.loadConfig.bind(configApi));
addon.put("/api/config/update/:userUUID", configApi.updateConfig.bind(configApi));
addon.post("/api/config/migrate", configApi.migrateFromLocalStorage.bind(configApi));
addon.get('/api/config/is-trusted/:uuid', configApi.isTrusted.bind(configApi));
addon.post("/api/test-keys", testKeysRateLimitMiddleware, configApi.testApiKeys);

// --- Trakt OAuth Routes ---
addon.get("/api/auth/trakt/authorize", async (req, res) => {
  try {
    const clientId = process.env.TRAKT_CLIENT_ID;
    const clientSecret = process.env.TRAKT_CLIENT_SECRET;
    const redirectUri = normalizeRedirectUri(process.env.TRAKT_REDIRECT_URI || `${process.env.HOST_NAME}/api/auth/trakt/callback`);
    
    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: "Trakt OAuth not configured. Please set TRAKT_CLIENT_ID and TRAKT_CLIENT_SECRET environment variables." });
    }
    
    const traktClient = new TraktClient(clientId, clientSecret, redirectUri);
    
    const state = createTraktOAuthState();
    const authUrl = traktClient.getAuthorizationUrl(state);
    
    res.redirect(authUrl);
  } catch (error) {
    consola.error("[Trakt OAuth] Authorization error:", error);
    res.status(500).json({ error: "Failed to initiate Trakt authorization" });
  }
});

const pendingTraktExchanges = new Map();

// Helper: sleep with ms
function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function exchangeWithRetry(traktClient, code, maxRetries = 3) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const tokens = await traktClient.exchangeCodeForToken(code);
      return tokens;
    } catch (error) {
      lastError = error;

      if (error.response?.status === 429) {
        if (attempt >= maxRetries) {
          throw error;
        }

        const retryAfterHeader = error.response.headers?.['retry-after'];
        let waitSeconds;

        if (retryAfterHeader && !isNaN(parseInt(retryAfterHeader, 10))) {
          waitSeconds = parseInt(retryAfterHeader, 10);
        } else {
          waitSeconds = Math.min(10 * Math.pow(3, attempt), 120);
        }

        waitSeconds = Math.min(waitSeconds, 300);

        consola.warn(
          `[Trakt OAuth] Rate limited on token exchange (attempt ${attempt + 1}/${maxRetries + 1}). ` +
          `Waiting ${waitSeconds}s before retry...`
        );

        await sleepMs(waitSeconds * 1000);
        continue;
      }

      throw error;
    }
  }

  throw lastError;
}


addon.get("/api/auth/trakt/callback", async (req, res) => {
  try {
    const code = Array.isArray(req.query.code) ? req.query.code[0] : req.query.code;
    const state = Array.isArray(req.query.state) ? req.query.state[0] : req.query.state;

    if (!code) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Trakt OAuth Error</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>❌ OAuth Error</h1>
          <p>Invalid callback parameters - missing authorization code.</p>
        </body>
        </html>
      `);
    }

    if (usedTraktCodes.has(code)) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Trakt OAuth Error</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>⚠️ Code Already Used</h1>
          <p>This authorization code has already been exchanged. Please try authenticating again.</p>
          <a href="/api/auth/trakt/authorize" style="display:inline-block;margin-top:20px;padding:12px 30px;background:#ed1c24;color:white;text-decoration:none;border-radius:5px;">Reconnect Trakt</a>
        </body>
        </html>
      `);
    }

    if (!state || !consumeTraktOAuthState(state)) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Trakt OAuth Error</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>OAuth State Error</h1>
          <p>The OAuth state is missing, expired, or invalid. Please try again.</p>
          <a href="/api/auth/trakt/authorize" style="display:inline-block;margin-top:20px;padding:12px 30px;background:#ed1c24;color:white;text-decoration:none;border-radius:5px;">Reconnect Trakt</a>
        </body>
        </html>
      `);
    }

    if (pendingTraktExchanges.has(code)) {
      consola.info(`[Trakt OAuth] Duplicate callback for code ${code.substring(0, 8)}... — waiting on existing exchange`);
      try {
        await pendingTraktExchanges.get(code);

        return res.send(`
          <!DOCTYPE html>
          <html>
          <head><title>Trakt OAuth</title></head>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h1>⏳ Processing</h1>
            <p>Your Trakt authorization is already being processed. Please check your other tab/window.</p>
          </body>
          </html>
        `);
      } catch {
        return res.status(500).send(`
          <!DOCTYPE html>
          <html>
          <head><title>Trakt OAuth Error</title></head>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h1>❌ Exchange Failed</h1>
            <p>The token exchange failed. Please try authenticating again.</p>
            <a href="/api/auth/trakt/authorize" style="display:inline-block;margin-top:20px;padding:12px 30px;background:#ed1c24;color:white;text-decoration:none;border-radius:5px;">Reconnect Trakt</a>
          </body>
          </html>
        `);
      }
    }

    const clientId = process.env.TRAKT_CLIENT_ID;
    const clientSecret = process.env.TRAKT_CLIENT_SECRET;
    const redirectUri = normalizeRedirectUri(
      process.env.TRAKT_REDIRECT_URI || `${process.env.HOST_NAME}/api/auth/trakt/callback`
    );

    if (!clientId || !clientSecret) {
      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Trakt OAuth Error</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>⚠️ Configuration Error</h1>
          <p>Trakt OAuth is not configured on this server.</p>
        </body>
        </html>
      `);
    }

    const traktClient = new TraktClient(clientId, clientSecret, redirectUri);

    let tokens;
    const exchangePromise = exchangeWithRetry(traktClient, code);
    pendingTraktExchanges.set(code, exchangePromise);
    try {
      tokens = await exchangePromise;
    } catch (tokenError) {
      consola.error("[Trakt OAuth] Exchange Error:", {
        message: tokenError.message,
        status: tokenError.response?.status,
        data: tokenError.response?.data
      });

      if (tokenError.response?.status === 429) {
        const retryAfter = tokenError.response.headers?.['retry-after'] || 60;
        const waitSeconds = Math.min(Math.max(Number(retryAfter), 30), 300);
        return res.status(429).send(`
          <!DOCTYPE html>
          <html>
          <head><title>Trakt Rate Limited</title></head>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h1>⏳ Rate Limited</h1>
            <p>Trakt's API is temporarily rate-limited. Please wait and try again.</p>
            <p>Estimated wait: <strong>${waitSeconds} seconds</strong></p>
            <a href="/api/auth/trakt/authorize" style="display:inline-block;margin-top:20px;padding:12px 30px;background:#ed1c24;color:white;text-decoration:none;border-radius:5px;">Try Again</a>
            <br><br>
            <a href="/configure" style="color: #666; text-decoration: underline;">Return to configuration</a>
          </body>
          </html>
        `);
      }

      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Trakt OAuth Error</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>❌ Exchange Failed</h1>
          <p>Failed to exchange authorization code: ${tokenError.message}</p>
          <a href="/api/auth/trakt/authorize" style="display:inline-block;margin-top:20px;padding:12px 30px;background:#ed1c24;color:white;text-decoration:none;border-radius:5px;">Try Again</a>
        </body>
        </html>
      `);
    } finally {
      pendingTraktExchanges.delete(code);
    }

    usedTraktCodes.add(code);
    setTimeout(() => usedTraktCodes.delete(code), 120000);


    const user = await traktClient.getMe(tokens.access_token);
    const existingTokens = await database.getOAuthTokensByProvider('trakt');
    const existingToken = existingTokens.find(t => t.user_id.toLowerCase() === user.username.toLowerCase());

    let tokenId;
    let saved;
    if (existingToken) {
      tokenId = existingToken.id;
      consola.info(`[Trakt OAuth] Updating existing token - tokenId: ${tokenId}, user: ${user.username}`);
      saved = await database.updateOAuthToken(
        tokenId,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_at
      );
    } else {
      tokenId = crypto.randomUUID();
      consola.info(`[Trakt OAuth] Creating new token - tokenId: ${tokenId}, user: ${user.username}`);
      saved = await database.saveOAuthToken(
        tokenId,
        'trakt',
        user.username,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_at,
        tokens.scope || ''
      );
    }

    if (!saved) {
      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Trakt OAuth Error</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>❌ Database Error</h1>
          <p>Failed to save OAuth token to database.</p>
        </body>
        </html>
      `);
    }

    try {
      const userTraktTokens = existingTokens.filter(t => t.user_id.toLowerCase() === user.username.toLowerCase());
      const oldTokenIds = userTraktTokens.map(t => t.id).filter(id => id !== tokenId);
      if (oldTokenIds.length > 0) {
        const affectedUsers = await database.getUsersByOAuthTokenIds('traktTokenId', oldTokenIds);
        for (const dbUser of affectedUsers) {
          dbUser.config.apiKeys.traktTokenId = tokenId;
          await database.saveUserConfig(dbUser.id, dbUser.password_hash, dbUser.config);
          configCache.del(dbUser.id);
          consola.info(`[Trakt OAuth] Updated user ${dbUser.id} config to use new token ${tokenId}`);
        }
      }
    } catch (configError) {
      consola.warn(`[Trakt OAuth] Warning: Could not auto-update user configs - ${configError.message}`);
    }

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Trakt OAuth Success</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          h1 { color: #ed1c24; }
          .token-box { background: #f9f9f9; border: 2px dashed #ed1c24; padding: 20px; margin: 20px 0; border-radius: 5px; word-break: break-all; }
          .token { font-family: monospace; font-size: 14px; color: #333; }
          button { background: #ed1c24; color: white; border: none; padding: 12px 30px; font-size: 16px; cursor: pointer; border-radius: 5px; margin: 10px; }
          button:hover { background: #c41a20; }
          .instructions { text-align: left; margin-top: 30px; padding: 20px; background: #f0f8ff; border-left: 4px solid #007acc; }
          .instructions ol { padding-left: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>✅ Trakt OAuth Successful</h1>
          <p>Your Trakt account <strong>${user.username}</strong> has been authorized!</p>
          <div class="token-box">
            <div class="token" id="tokenId">${tokenId}</div>
          </div>
          <button onclick="copyToken()">📋 Copy Token ID</button>
          <div class="instructions">
            <h3>📝 Next Steps:</h3>
            <ol>
              <li>Copy the Token ID above</li>
              <li>Go to your addon configuration page</li>
              <li>Find the <strong>Trakt Integration</strong> section</li>
              <li>Paste this Token ID in the <strong>Trakt Token ID</strong> field</li>
              <li>Save your configuration</li>
            </ol>
            <p><strong>⚠️ Important:</strong> Keep this Token ID private. Anyone with this ID can access your Trakt account through this addon.</p>
          </div>
        </div>
        <script>
          function copyToken() {
            const tokenText = document.getElementById('tokenId').textContent;
            navigator.clipboard.writeText(tokenText).then(() => {
              const btn = event.target;
              btn.textContent = '✅ Copied!';
              setTimeout(() => btn.textContent = '📋 Copy Token ID', 2000);
            });
          }
        </script>
      </body>
      </html>
    `);

  } catch (error) {
    consola.error("[Trakt OAuth] Unexpected callback error:", error);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Trakt OAuth Error</title></head>
      <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
        <h1>❌ Unexpected Error</h1>
        <p>${error.message || 'An unexpected error occurred during authorization.'}</p>
        <a href="/api/auth/trakt/authorize" style="display:inline-block;margin-top:20px;padding:12px 30px;background:#ed1c24;color:white;text-decoration:none;border-radius:5px;">Try Again</a>
      </body>
      </html>
    `);
  }
});

// Generic OAuth token info endpoint
const configCache = require('./lib/configCache');

// Generic OAuth token info endpoint
addon.post("/api/oauth/token/info", async (req, res) => {
  try {
    const { tokenId } = req.body;
    if (!tokenId) {
      return res.status(400).json({ error: "tokenId is required" });
    }
    const token = await database.getOAuthToken(tokenId);
    if (!token) {
      return res.status(404).json({ error: "Token not found" });
    }
    res.json({ provider: token.provider, username: token.user_id, expiresAt: token.expires_at });
  } catch (error) {
    consola.error("[OAuth] Token info fetch error:", error);
    res.status(500).json({ error: "Failed to fetch token info" });
  }
});

// --- Simkl OAuth Routes ---
addon.get("/api/auth/simkl/authorize", async (req, res) => {
  try {
    const clientId = process.env.SIMKL_CLIENT_ID;
    const clientSecret = process.env.SIMKL_CLIENT_SECRET;
    const redirectUri = normalizeRedirectUri(process.env.SIMKL_REDIRECT_URI || `${process.env.HOST_NAME}/api/auth/simkl/callback`);
    
    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: "Simkl OAuth not configured. Please set SIMKL_CLIENT_ID and SIMKL_CLIENT_SECRET environment variables." });
    }
    
    const simklClient = new SimklClient(clientId, clientSecret, redirectUri);
    
    // Get authorization URL
    const authUrl = simklClient.getAuthorizationUrl();
    
    res.redirect(authUrl);
  } catch (error) {
    consola.error("[Simkl OAuth] Authorization error:", error);
    res.status(500).json({ error: "Failed to initiate Simkl authorization" });
  }
});

addon.get("/api/auth/simkl/callback", async (req, res) => {
  try {
    const { code } = req.query;
    
    if (!code) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Simkl OAuth Error</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>❌ OAuth Error</h1>
          <p>Invalid callback parameters - missing authorization code.</p>
        </body>
        </html>
      `);
    }
    
    const clientId = process.env.SIMKL_CLIENT_ID;
    const clientSecret = process.env.SIMKL_CLIENT_SECRET;
    const redirectUri = normalizeRedirectUri(process.env.SIMKL_REDIRECT_URI || `${process.env.HOST_NAME}/api/auth/simkl/callback`);
    
    if (!clientId || !clientSecret) {
      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Simkl OAuth Error</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>⚠️ Configuration Error</h1>
          <p>Simkl OAuth is not configured on this server.</p>
        </body>
        </html>
      `);
    }
    
    const simklClient = new SimklClient(clientId, clientSecret, redirectUri);
    
    // Exchange code for tokens (Simkl tokens never expire)
    const tokens = await simklClient.exchangeCodeForToken(code);
    
    // Get user info
    const user = await simklClient.getMe(tokens.access_token);
    
    // Check if this Simkl user already has a token in the database
    const existingTokens = await database.getOAuthTokensByProvider('simkl');
    const existingToken = existingTokens.find(t => t.user_id.toLowerCase() === user.username.toLowerCase());
    
    let tokenId;
    let saved;
    
    if (existingToken) {
      // Update existing token
      tokenId = existingToken.id;
      consola.info(`[Simkl OAuth] Updating existing token - tokenId: ${tokenId}, user: ${user.username}`);
      
      // Simkl tokens don't expire, so we don't have expires_at
      saved = await database.updateOAuthToken(
        tokenId,
        tokens.access_token,
        '', 
        0 
      );
    } else {
      // Create new token
      tokenId = crypto.randomUUID();
      consola.info(`[Simkl OAuth] Creating new token - tokenId: ${tokenId}, user: ${user.username}`);
      
      saved = await database.saveOAuthToken(
        tokenId,
        'simkl',
        user.username,
        tokens.access_token,
        '', 
        0, 
        '' 
      );
    }
    
    if (!saved) {
      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Simkl OAuth Error</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>❌ Database Error</h1>
          <p>Failed to save OAuth token to database.</p>
        </body>
        </html>
      `);
    }
    
    try {
      const userSimklTokens = existingTokens.filter(t => t.user_id.toLowerCase() === user.username.toLowerCase());
      const oldTokenIds = userSimklTokens.map(t => t.id).filter(id => id !== tokenId);
      if (oldTokenIds.length > 0) {
        const affectedUsers = await database.getUsersByOAuthTokenIds('simklTokenId', oldTokenIds);
        for (const dbUser of affectedUsers) {
          dbUser.config.apiKeys.simklTokenId = tokenId;
          await database.saveUserConfig(dbUser.id, dbUser.password_hash, dbUser.config);
          configCache.del(dbUser.id);
          consola.info(`[Simkl OAuth] Updated user ${dbUser.id} config to use new token ${tokenId}`);
        }
      }
    } catch (configError) {
      consola.warn(`[Simkl OAuth] Warning: Could not auto-update user configs - ${configError.message}`);
    }
    
    // Display success page with token ID
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Simkl OAuth Success</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          h1 { color: #ff6b35; }
          .token-box { background: #f9f9f9; border: 2px dashed #ff6b35; padding: 20px; margin: 20px 0; border-radius: 5px; word-break: break-all; }
          .token { font-family: monospace; font-size: 14px; color: #333; }
          button { background: #ff6b35; color: white; border: none; padding: 12px 30px; font-size: 16px; cursor: pointer; border-radius: 5px; margin: 10px; }
          button:hover { background: #e55a2b; }
          .instructions { text-align: left; margin-top: 30px; padding: 20px; background: #f0f8ff; border-left: 4px solid #007acc; }
          .instructions ol { padding-left: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>✅ Simkl OAuth Successful</h1>
          <p>Your Simkl account <strong>${user.username}</strong> has been authorized!</p>
          
          <div class="token-box">
            <div class="token" id="tokenId">${tokenId}</div>
          </div>
          
          <button onclick="copyToken()">📋 Copy Token ID</button>
          
          <div class="instructions">
            <h3>📝 Next Steps:</h3>
            <ol>
              <li>Copy the Token ID above</li>
              <li>Go to your addon configuration page</li>
              <li>Find the <strong>Simkl Integration</strong> section</li>
              <li>Paste this Token ID in the <strong>Simkl Token ID</strong> field</li>
              <li>Save your configuration</li>
            </ol>
            <p><strong>⚠️ Important:</strong> Keep this Token ID private. Anyone with this ID can access your Simkl account through this addon.</p>
          </div>
        </div>
        
        <script>
          function copyToken() {
            const tokenText = document.getElementById('tokenId').textContent;
            navigator.clipboard.writeText(tokenText).then(() => {
              alert('✅ Token ID copied to clipboard!');
            }).catch(err => {
              alert('❌ Failed to copy. Please select and copy manually.');
            });
          }
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    consola.error("[Simkl OAuth] Callback error:", error);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Simkl OAuth Error</title></head>
      <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
        <h1>❌ OAuth Error</h1>
        <p>An error occurred during authentication: ${error.message}</p>
        <p><a href="${process.env.HOST_NAME}/configure">← Back to Configuration</a></p>
      </body>
      </html>
    `);
  }
});

addon.post("/api/auth/trakt/disconnect", async (req, res) => {
  try {
    const { userUUID } = req.body;
    
    if (!userUUID) {
      return res.status(400).json({ error: "userUUID is required" });
    }
    
    // Load user's config
    const config = await loadConfigFromDatabase(userUUID);
    if (!config) {
      return res.status(404).json({ error: "User config not found" });
    }
    
    // Delete OAuth token from database if it exists
    if (config.apiKeys?.traktTokenId) {
      await database.deleteOAuthToken(config.apiKeys.traktTokenId);
      delete config.apiKeys.traktTokenId;
    }
    
    // Remove Trakt user info
    delete config.traktUser;
    delete config.traktWatchTracking;
    
    // Remove Trakt catalogs
    config.catalogs = (config.catalogs || []).filter(c => !c.id.startsWith('trakt.'));
    
    // Get user's password hash to save config
    const user = await database.getUser(userUUID);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Save updated config directly to database
    await database.saveUserConfig(userUUID, user.password_hash, config);
    
    // Invalidate config cache
    configCache.del(userUUID);
    
    res.json({ success: true });
  } catch (error) {
    consola.error("[Trakt] Disconnect error:", error);
    res.status(500).json({ error: "Failed to disconnect Trakt" });
  }
});

addon.post("/api/auth/simkl/disconnect", async (req, res) => {
  try {
    const { userUUID } = req.body;
    
    if (!userUUID) {
      return res.status(400).json({ error: "userUUID is required" });
    }
    
    // Load user's config
    const config = await loadConfigFromDatabase(userUUID);
    if (!config) {
      return res.status(404).json({ error: "User config not found" });
    }
    
    // Delete OAuth token from database if it exists
    if (config.apiKeys?.simklTokenId) {
      await database.deleteOAuthToken(config.apiKeys.simklTokenId);
      delete config.apiKeys.simklTokenId;
    }
    
    // Remove Simkl user info
    delete config.simklUser;
    delete config.simklWatchTracking;
    // Remove Simkl catalogs
    config.catalogs = (config.catalogs || []).filter(c => !c.id.startsWith('simkl.'));
    
    // Get user's password hash to save config
    const user = await database.getUser(userUUID);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Save updated config directly to database
    await database.saveUserConfig(userUUID, user.password_hash, config);
    
    // Invalidate config cache
    configCache.del(userUUID);
    
    res.json({ success: true });
  } catch (error) {
    consola.error("[Simkl] Disconnect error:", error);
    res.status(500).json({ error: "Failed to disconnect Simkl" });
  }
});

function normalizeTraktEndpoint(endpoint) {
  if (typeof endpoint !== 'string') return '';
  const normalized = endpoint.trim();
  if (!normalized) return '';
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function isOptionalUsersRoute(pathnameLower) {
  const parts = pathnameLower.split('/').filter(Boolean);
  // /users/{id}
  if (parts.length === 2) return true;
  // /users/{id}/stats
  if (parts.length === 3 && parts[2] === 'stats') return true;
  // /users/{id}/lists
  if (parts.length === 3 && parts[2] === 'lists') return true;
  // /users/{id}/lists/{list_id}
  if (parts.length === 4 && parts[2] === 'lists') return true;
  // /users/{id}/lists/{list_id}/items[...]
  if (parts.length >= 5 && parts[2] === 'lists' && parts[4] === 'items') return true;
  return false;
}

function resolveTraktProxyAuthMode(pathname) {
  const pathnameLower = pathname.toLowerCase();

  // Auth required routes.
  if (
    pathnameLower.startsWith('/calendars/my/') ||
    pathnameLower.startsWith('/recommendations/') ||
    pathnameLower.startsWith('/sync/') ||
    pathnameLower.startsWith('/users/hidden/') ||
    pathnameLower.includes('/progress/watched')
  ) {
    return 'required';
  }

  // OAuth optional routes we currently proxy.
  if (pathnameLower.startsWith('/users/') && isOptionalUsersRoute(pathnameLower)) {
    return 'optional';
  }

  // Known public/unauthed route groups we currently proxy.
  if (
    pathnameLower.startsWith('/genres/') ||
    pathnameLower.startsWith('/lists/') ||
    pathnameLower.startsWith('/movies/') ||
    pathnameLower.startsWith('/shows/') ||
    pathnameLower.startsWith('/search/') ||
    pathnameLower.startsWith('/people/')
  ) {
    return 'unauthed';
  }

  // Default to auth-required for unknown routes.
  return 'required';
}

// Proxy endpoint for Trakt API calls with auth-aware routing
addon.post("/api/trakt/proxy", async (req, res) => {
  try {
    const { tokenId, endpoint, method = 'GET' } = req.body;
    
    if (!endpoint) {
      return res.status(400).json({ error: "endpoint is required" });
    }

    const normalizedMethod = String(method || 'GET').toUpperCase();
    if (normalizedMethod !== 'GET') {
      return res.status(405).json({ error: "Only GET is supported by this proxy endpoint" });
    }

    const normalizedEndpoint = normalizeTraktEndpoint(endpoint);
    if (!normalizedEndpoint) {
      return res.status(400).json({ error: "endpoint must be a non-empty string" });
    }

    const traktUrl = `https://api.trakt.tv${normalizedEndpoint}`;
    const pathname = new URL(traktUrl).pathname;

    const authMode = resolveTraktProxyAuthMode(pathname);

    const {
      makeRateLimitedTraktRequest,
      makeAuthenticatedRateLimitedTraktRequest,
      getTraktAccessToken
    } = require('./utils/traktUtils');

    let accessToken = null;
    if (tokenId) {
      accessToken = await getTraktAccessToken({ apiKeys: { traktTokenId: tokenId } });
    }

    if (authMode === 'required' && !accessToken) {
      return res.status(400).json({ error: "tokenId is required for this endpoint" });
    }

    let response;

    if (authMode === 'unauthed') {
      response = await makeRateLimitedTraktRequest(traktUrl, `Trakt Proxy (Unauthed) - ${normalizedEndpoint}`);
    } else if (authMode === 'optional') {
      if (accessToken) {
        try {
          response = await makeRateLimitedTraktRequest(
            traktUrl,
            `Trakt Proxy (Optional->Unauthed) - ${normalizedEndpoint}`
          );
        } catch (optionalError) {
          const status = optionalError?.response?.status;
          if (status !== 401 && status !== 403 && status !== 404) {
            throw optionalError;
          }
          response = await makeAuthenticatedRateLimitedTraktRequest(
            traktUrl,
            accessToken,
            `Trakt Proxy (Optional->Authed Fallback) - ${normalizedEndpoint}`
          );
        }
      } else {
        response = await makeRateLimitedTraktRequest(traktUrl, `Trakt Proxy (Optional) - ${normalizedEndpoint}`);
      }
    } else {
      response = await makeAuthenticatedRateLimitedTraktRequest(
        traktUrl,
        accessToken,
        `Trakt Proxy (Auth Required) - ${normalizedEndpoint}`
      );
    }

    res.json(response.data);
  } catch (error) {
    consola.error("[Trakt Proxy] Error:", error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message || "Failed to proxy Trakt request" });
  }
});

// Manual cache clearing endpoint (temporarily disabled due to binding issue)
// addon.post("/api/config/clear-cache/:userUUID", configApi.clearCache.bind(configApi));

// --- MDBList Proxy Endpoints ---
// These proxy frontend MDBList calls through the backend rate limiter
const { makeRateLimitedMDBListRequest } = require('./utils/mdbList');

// Proxy: Get user info and limits
addon.get("/api/mdblist/user", async (req, res) => {
  try {
    const { apikey } = req.query;
    if (!apikey) {
      return res.status(400).json({ error: "apikey is required" });
    }
    const url = `https://api.mdblist.com/user?apikey=${apikey}`;
    const response = await makeRateLimitedMDBListRequest(url, apikey, 'MDBList Proxy - Get User Info');
    res.json(response.data);
  } catch (error) {
    consola.error("[MDBList Proxy] Error fetching user info:", error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message || "Failed to fetch user info" });
  }
});

// Proxy: Get user's lists
addon.get("/api/mdblist/lists/user", async (req, res) => {
  try {
    const { apikey, username, sort } = req.query;
    
    if (!apikey) {
      return res.status(400).json({ error: "apikey is required" });
    }
    
    let url = username 
      ? `https://api.mdblist.com/lists/user/${username}?apikey=${apikey}`
      : `https://api.mdblist.com/lists/user?apikey=${apikey}`;
    
    if (sort) {
      url += `&sort=${sort}`;
    }
    
    const response = await makeRateLimitedMDBListRequest(url, apikey, 'MDBList Proxy - Get User Lists');
    res.json(response.data);
  } catch (error) {
    consola.error("[MDBList Proxy] Error fetching user lists:", error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message || "Failed to fetch user lists" });
  }
});

// Proxy: Get top lists
addon.get("/api/mdblist/lists/top", async (req, res) => {
  try {
    const { apikey } = req.query;
    
    if (!apikey) {
      return res.status(400).json({ error: "apikey is required" });
    }
    
    const url = `https://api.mdblist.com/lists/top?apikey=${apikey}`;
    const response = await makeRateLimitedMDBListRequest(url, apikey, 'MDBList Proxy - Get Top Lists');
    res.json(response.data);
  } catch (error) {
    consola.error("[MDBList Proxy] Error fetching top lists:", error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message || "Failed to fetch top lists" });
  }
});

// Proxy: Get list details by username/listname
addon.get("/api/mdblist/lists/:username/:listname", async (req, res) => {
  try {
    const { username, listname } = req.params;
    const { apikey } = req.query;
    
    if (!apikey) {
      return res.status(400).json({ error: "apikey is required" });
    }
    
    const url = `https://api.mdblist.com/lists/${username}/${listname}?apikey=${apikey}`;
    const response = await makeRateLimitedMDBListRequest(url, apikey, `MDBList Proxy - Get User List ${username}/${listname}`);
    res.json(response.data);
  } catch (error) {
    consola.error("[MDBList Proxy] Error fetching user list details:", error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message || "Failed to fetch user list details" });
  }
});

// Proxy: Get list details by ID/slug
addon.get("/api/mdblist/lists/:listId", async (req, res) => {
  try {
    const { listId } = req.params;
    const { apikey } = req.query;
    
    if (!apikey) {
      return res.status(400).json({ error: "apikey is required" });
    }
    
    const url = `https://api.mdblist.com/lists/${listId}?apikey=${apikey}`;
    const response = await makeRateLimitedMDBListRequest(url, apikey, `MDBList Proxy - Get List ${listId}`);
    res.json(response.data);
  } catch (error) {
    consola.error("[MDBList Proxy] Error fetching list details:", error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message || "Failed to fetch list details" });
  }
});

// --- TMDB Proxy Endpoints ---
const moviedb = require('./lib/getTmdb.js');
const tvdbApi = require('./lib/tvdb');
const TMDB_DISCOVER_CACHE_TTL = 24 * 60 * 60; // 24h for mostly static discover reference data
const TVDB_DISCOVER_CACHE_TTL = 24 * 60 * 60; // 24h for mostly static discover reference data

function normalizeTmdbDiscoverType(type) {
  return type === 'tv' ? 'tv' : 'movie';
}

function normalizeTvdbDiscoverType(type) {
  return type === 'series' ? 'series' : 'movies';
}

function toTvdbCountryCode(regionCode) {
  const normalized = typeof regionCode === 'string' ? regionCode.trim().toUpperCase() : '';
  if (!normalized) return 'usa';
  const countryData = getCountryISO3(normalized);
  if (!countryData) return 'usa';
  return String(countryData).toLowerCase();
}

async function resolveTmdbDiscoverApiKey(req) {
  const requestApiKey = typeof req.query.apikey === 'string' ? req.query.apikey.trim() : '';
  if (requestApiKey) {
    return requestApiKey;
  }

  const userUUID = typeof req.query.userUUID === 'string' ? req.query.userUUID.trim() : '';
  if (userUUID) {
    try {
      const userConfig = await loadConfigFromDatabase(userUUID);
      const userConfigKey = userConfig?.apiKeys?.tmdb?.trim() || '';
      if (userConfigKey) {
        return userConfigKey;
      }
    } catch (error) {
      consola.debug(`[TMDB Discover] Could not load config for user ${userUUID}: ${error.message}`);
    }
  }

  return (process.env.TMDB_API || process.env.BUILT_IN_TMDB_API_KEY || '').trim();
}

async function resolveTvdbDiscoverApiKey(req) {
  const requestApiKey = typeof req.query.apikey === 'string' ? req.query.apikey.trim() : '';
  if (requestApiKey) {
    return requestApiKey;
  }

  const userUUID = typeof req.query.userUUID === 'string' ? req.query.userUUID.trim() : '';
  if (userUUID) {
    try {
      const userConfig = await loadConfigFromDatabase(userUUID);
      const userConfigKey = userConfig?.apiKeys?.tvdb?.trim() || '';
      if (userConfigKey) {
        return userConfigKey;
      }
    } catch (error) {
      consola.debug(`[TVDB Discover] Could not load config for user ${userUUID}: ${error.message}`);
    }
  }

  return (process.env.TVDB_API_KEY || process.env.BUILT_IN_TVDB_API_KEY || '').trim();
}

// Proxy: Get TMDB list details
addon.get("/api/tmdb/list/:listId", async (req, res) => {
  try {
    const { listId } = req.params;
    const { apikey } = req.query;
    
    if (!apikey) {
      return res.status(400).json({ error: "apikey is required" });
    }
    
    consola.debug(`[TMDB Proxy] Fetching list ${listId}`);
    
    const config = { apiKeys: { tmdb: apikey } };
    const data = await moviedb.getTmdbListDetails({ list_id: listId }, config);
    
    res.json(data);
  } catch (error) {
    consola.error("[TMDB Proxy] Error fetching list details:", error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message || "Failed to fetch TMDB list details" });
  }
});

// Proxy: Discover reference data (genres, languages, countries, certifications, watch regions)
addon.get("/api/tmdb/discover/reference", async (req, res) => {
  try {
    const { type, language } = req.query;
    const tmdbApiKey = await resolveTmdbDiscoverApiKey(req);

    if (!tmdbApiKey) {
      return res.status(400).json({
        error: "TMDB API key is required (config.apiKeys.tmdb, TMDB_API, or BUILT_IN_TMDB_API_KEY)"
      });
    }

    const mediaType = normalizeTmdbDiscoverType(type);
    const lang = typeof language === 'string' && language.trim() ? language.trim() : 'en-US';
    const config = { apiKeys: { tmdb: tmdbApiKey } };
    const cacheKey = `tmdb:discover:reference:${mediaType}:${lang}`;

    const payload = await cacheWrapGlobal(
      cacheKey,
      async () => {
        const [genresData, languagesData, countriesData, certificationsData, watchRegionsData] = await Promise.all([
          moviedb.makeTmdbRequest(`/genre/${mediaType}/list`, tmdbApiKey, { language: lang }, 'GET', null, config),
          moviedb.makeTmdbRequest('/configuration/languages', tmdbApiKey, {}, 'GET', null, config),
          moviedb.makeTmdbRequest('/configuration/countries', tmdbApiKey, {}, 'GET', null, config),
          moviedb.makeTmdbRequest(`/certification/${mediaType}/list`, tmdbApiKey, {}, 'GET', null, config),
          moviedb.makeTmdbRequest('/watch/providers/regions', tmdbApiKey, {}, 'GET', null, config),
        ]);

        const genres = Array.isArray(genresData?.genres) ? genresData.genres : [];
        const languages = Array.isArray(languagesData)
          ? languagesData.filter(langItem => !!langItem?.iso_639_1)
          : [];
        const countries = Array.isArray(countriesData)
          ? countriesData.filter(countryItem => !!countryItem?.iso_3166_1)
          : [];
        const watchRegions = Array.isArray(watchRegionsData?.results)
          ? watchRegionsData.results.filter(region => !!region?.iso_3166_1)
          : [];
        const certifications = certificationsData?.certifications || {};

        return {
          mediaType,
          language: lang,
          genres,
          languages,
          countries,
          watchRegions,
          certifications
        };
      },
      TMDB_DISCOVER_CACHE_TTL
    );

    return res.json(payload);
  } catch (error) {
    consola.error("[TMDB Discover] Error fetching reference data:", error.message);
    const status = error.response?.status || 500;
    return res.status(status).json({ error: error.message || "Failed to fetch TMDB discover reference data" });
  }
});

// Proxy: Discover providers for selected media type + region
addon.get("/api/tmdb/discover/providers", async (req, res) => {
  try {
    const { type, watch_region } = req.query;
    const tmdbApiKey = await resolveTmdbDiscoverApiKey(req);

    if (!tmdbApiKey) {
      return res.status(400).json({
        error: "TMDB API key is required (config.apiKeys.tmdb, TMDB_API, or BUILT_IN_TMDB_API_KEY)"
      });
    }

    if (!watch_region) {
      return res.status(400).json({ error: "watch_region is required" });
    }

    const mediaType = normalizeTmdbDiscoverType(type);
    const region = String(watch_region).toUpperCase();
    const cacheKey = `tmdb:discover:providers:${mediaType}:${region}`;
    const config = { apiKeys: { tmdb: tmdbApiKey } };

    const payload = await cacheWrapGlobal(
      cacheKey,
      async () => {
        const providersData = await moviedb.makeTmdbRequest(
          `/watch/providers/${mediaType}`,
          tmdbApiKey,
          { watch_region: region },
          'GET',
          null,
          config
        );

        const providers = Array.isArray(providersData?.results)
          ? providersData.results
              .filter(provider => !!provider?.provider_id)
              .sort((a, b) => {
                const priorityA = Number.isFinite(a.display_priority) ? a.display_priority : Number.MAX_SAFE_INTEGER;
                const priorityB = Number.isFinite(b.display_priority) ? b.display_priority : Number.MAX_SAFE_INTEGER;
                return priorityA - priorityB;
              })
          : [];

        return { mediaType, watch_region: region, providers };
      },
      TMDB_DISCOVER_CACHE_TTL
    );

    return res.json(payload);
  } catch (error) {
    consola.error("[TMDB Discover] Error fetching providers:", error.message);
    const status = error.response?.status || 500;
    return res.status(status).json({ error: error.message || "Failed to fetch TMDB discover providers" });
  }
});

// Proxy: Discover searchable entities (person/company/keyword) for ID-based filters
addon.get("/api/tmdb/discover/search/:entity", async (req, res) => {
  try {
    const { query } = req.query;
    const entity = String(req.params.entity || '').toLowerCase();
    const tmdbApiKey = await resolveTmdbDiscoverApiKey(req);

    if (!tmdbApiKey) {
      return res.status(400).json({
        error: "TMDB API key is required (config.apiKeys.tmdb, TMDB_API, or BUILT_IN_TMDB_API_KEY)"
      });
    }

    if (!query || !String(query).trim()) {
      return res.status(400).json({ error: "query is required" });
    }

    const endpointMap = {
      person: '/search/person',
      company: '/search/company',
      keyword: '/search/keyword'
    };

    const endpoint = endpointMap[entity];
    if (!endpoint) {
      return res.status(400).json({ error: "entity must be one of: person, company, keyword" });
    }

    const config = { apiKeys: { tmdb: tmdbApiKey } };
    const searchData = await moviedb.makeTmdbRequest(
      endpoint,
      tmdbApiKey,
      {
        query: String(query).trim(),
        page: 1,
        include_adult: false
      },
      'GET',
      null,
      config
    );

    const results = Array.isArray(searchData?.results) ? searchData.results.slice(0, 25) : [];
    return res.json({ entity, results });
  } catch (error) {
    consola.error("[TMDB Discover] Error searching entity:", error.message);
    const status = error.response?.status || 500;
    return res.status(status).json({ error: error.message || "Failed to search TMDB discover entity" });
  }
});

// Proxy: TVDB discover reference data (genres, languages, countries, content ratings, statuses, company types)
addon.get("/api/tvdb/discover/reference", async (req, res) => {
  try {
    const { type, language } = req.query;
    const tvdbApiKey = await resolveTvdbDiscoverApiKey(req);

    if (!tvdbApiKey) {
      return res.status(400).json({
        error: "TVDB API key is required (config.apiKeys.tvdb, TVDB_API_KEY, or BUILT_IN_TVDB_API_KEY)"
      });
    }

    const mediaType = normalizeTvdbDiscoverType(type);
    const languageTag = typeof language === 'string' && language.trim() ? language.trim() : 'en-US';
    const languageParts = languageTag.split('-');
    const defaultLanguage = 'eng';
    const defaultCountry = toTvdbCountryCode(languageParts[1] || 'US');
    const userUUID = typeof req.query.userUUID === 'string' && req.query.userUUID.trim()
      ? req.query.userUUID.trim()
      : undefined;

    const tvdbConfig = {
      apiKeys: { tvdb: tvdbApiKey },
      ...(userUUID ? { userUUID } : {})
    };

    const cacheKey = `tvdb:discover:reference:v2:${mediaType}:${languageTag}`;
    const payload = await cacheWrapGlobal(
      cacheKey,
      async () => {
        const [genres, languages, countries, contentRatings, statuses, companyTypes] = await Promise.all([
          tvdbApi.getAllGenres(tvdbConfig),
          tvdbApi.getAllLanguages(tvdbConfig),
          tvdbApi.getAllCountries(tvdbConfig),
          tvdbApi.getAllContentRatings(tvdbConfig),
          tvdbApi.getStatuses(mediaType, tvdbConfig),
          tvdbApi.getCompanyTypes(tvdbConfig),
        ]);

        const normalizeCode = (value) => {
          if (typeof value !== 'string') return '';
          return value.trim().toLowerCase();
        };

        const normalizedGenres = Array.isArray(genres)
          ? genres.filter(item => item && Number.isFinite(Number(item.id)))
          : [];
        const normalizedLanguages = Array.isArray(languages)
          ? Array.from(
              languages.reduce((acc, item) => {
                if (!item || typeof item !== 'object') return acc;
                const code = normalizeCode(item.id) || normalizeCode(item.shortCode);
                if (!code || acc.seen.has(code)) return acc;
                acc.seen.add(code);
                acc.items.push({
                  ...item,
                  id: code,
                  shortCode: normalizeCode(item.shortCode) || code
                });
                return acc;
              }, { seen: new Set(), items: [] }).items
            )
          : [];
        const normalizedCountries = Array.isArray(countries)
          ? Array.from(
              countries.reduce((acc, item) => {
                if (!item || typeof item !== 'object') return acc;
                const code = normalizeCode(item.id) || normalizeCode(item.shortCode);
                if (!code || acc.seen.has(code)) return acc;
                acc.seen.add(code);
                acc.items.push({
                  ...item,
                  id: code,
                  shortCode: normalizeCode(item.shortCode) || code
                });
                return acc;
              }, { seen: new Set(), items: [] }).items
            )
          : [];
        const normalizedStatuses = Array.isArray(statuses)
          ? statuses.filter(item => item && Number.isFinite(Number(item.id)))
          : [];
        const normalizedCompanyTypes = Array.isArray(companyTypes)
          ? companyTypes.filter(item => item && Number.isFinite(Number(item.companyTypeId)))
          : [];

        const normalizedRatings = Array.isArray(contentRatings)
          ? contentRatings.filter(item => item && Number.isFinite(Number(item.id)))
          : [];
        const filteredRatings = normalizedRatings.filter(rating => {
          const contentType = String(rating.contentType || '').toLowerCase();
          if (!contentType) return true;
          if (mediaType === 'movies') return contentType.includes('movie');
          return contentType.includes('series') || contentType.includes('episode') || contentType.includes('tv');
        });

        return {
          mediaType,
          language: languageTag,
          defaultLanguage,
          defaultCountry,
          genres: normalizedGenres,
          languages: normalizedLanguages,
          countries: normalizedCountries,
          contentRatings: filteredRatings,
          statuses: normalizedStatuses,
          companyTypes: normalizedCompanyTypes,
        };
      },
      TVDB_DISCOVER_CACHE_TTL
    );

    return res.json(payload);
  } catch (error) {
    consola.error("[TVDB Discover] Error fetching reference data:", error.message);
    const status = error.response?.status || 500;
    return res.status(status).json({ error: error.message || "Failed to fetch TVDB discover reference data" });
  }
});


addon.get("/api/anilist/discover/reference", async (req, res) => {
  try {
    const { httpPost } = require('./utils/httpClient');
    const { cacheWrapGlobal } = require('./lib/getCache');

    const data = await cacheWrapGlobal('anilist-discover-reference', async () => {
      const query = `
        query {
          GenreCollection
          MediaTagCollection {
            name
            category
            isAdult
          }
        }
      `;

      const response = await httpPost('https://graphql.anilist.co', { query }, {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        timeout: 15000
      });

      const genres = response.data?.data?.GenreCollection || [];
      const allTags = response.data?.data?.MediaTagCollection || [];
      const tags = allTags
        .filter((t) => !t.isAdult)
        .map((t) => ({ name: t.name, category: t.category }));

      return { genres, tags };
    }, 24 * 60 * 60);

    res.json(data);
  } catch (error) {
    console.error('[AniList Discover] Failed to fetch reference data:', error.message);
    res.status(500).json({ error: error.message || 'Failed to fetch AniList reference data' });
  }
});

// GET /api/anilist/discover/search/studio - Search AniList studios by name
addon.get("/api/anilist/discover/search/studio", async (req, res) => {
  try {
    const query = req.query.query.trim();
    if (!query) {
      return res.json({ results: [] });
    }

    const anilist = require('./lib/anilist');
    const results = await anilist.searchStudios(query);
    res.json({ results });
  } catch (error) {
    console.error('[AniList Discover] Failed to search studios:', error.message);
    res.status(500).json({ error: error.message || 'Failed to search studios' });
  }
});

// GET /api/mal/discover/reference - Get MAL genres and top studios for discover builder
addon.get("/api/mal/discover/reference", async (req, res) => {
  try {
    const jikan = require('./lib/mal');
    const { cacheWrapJikanApi } = require('./lib/getCache');

    const genres = await cacheWrapJikanApi('anime-genres', async () => {
      return await jikan.getAnimeGenres();
    }, 24 * 60 * 60);

    const studios = await cacheWrapJikanApi('mal-studios', async () => {
      return await jikan.getStudios(100);
    }, 24 * 60 * 60);

    res.json({ genres: genres || [], studios: studios || [] });
  } catch (error) {
    console.error('[MAL Discover] Failed to fetch reference data:', error.message);
    res.status(500).json({ error: error.message || 'Failed to fetch MAL reference data' });
  }
});

// GET /api/mal/discover/search/producer - Search MAL studios/producers by name
addon.get("/api/mal/discover/search/producer", async (req, res) => {
  try {
    const query = req.query.query.trim();
    if (!query) {
      return res.json({ results: [] });
    }

    const { httpGet } = require('./utils/httpClient');
    const JIKAN_API_BASE = process.env.JIKAN_API_BASE || 'https://api.jikan.moe/v4';

    const url = `${JIKAN_API_BASE}/producers?q=${encodeURIComponent(query)}&limit=20&order_by=favorites&sort=desc`;
    const response = await httpGet(url, { timeout: 15000 });

    const producers = (response.data?.data || []).map((p) => {
      const defaultTitle = p.titles?.find((t) => t.type === 'Default');
      return {
        id: p.mal_id,
        name: defaultTitle?.title || p.name || `Producer ${p.mal_id}`,
      };
    });

    res.json({ results: producers });
  } catch (error) {
    console.error('[MAL Discover] Failed to search producers:', error.message);
    res.status(500).json({ error: error.message || 'Failed to search MAL producers' });
  }
});

// Proxy: TVDB discover searchable entities
addon.get("/api/tvdb/discover/search/:entity", async (req, res) => {
  try {
    const { query } = req.query;
    const entity = String(req.params.entity || '').toLowerCase();
    const tvdbApiKey = await resolveTvdbDiscoverApiKey(req);

    if (!tvdbApiKey) {
      return res.status(400).json({
        error: "TVDB API key is required (config.apiKeys.tvdb, TVDB_API_KEY, or BUILT_IN_TVDB_API_KEY)"
      });
    }

    if (!query || !String(query).trim()) {
      return res.status(400).json({ error: "query is required" });
    }

    if (entity !== 'company') {
      return res.status(400).json({ error: "entity must be: company" });
    }

    const userUUID = typeof req.query.userUUID === 'string' && req.query.userUUID.trim()
      ? req.query.userUUID.trim()
      : undefined;

    const tvdbConfig = {
      apiKeys: { tvdb: tvdbApiKey },
      ...(userUUID ? { userUUID } : {})
    };

    const searchData = await tvdbApi.searchCompanies(String(query).trim(), tvdbConfig);
    const seen = new Set();
    const normalizedResults = (Array.isArray(searchData) ? searchData : [])
      .map(item => {
        const idCandidate = item?.id ?? item?.tvdb_id ?? item?.companyId ?? item?.objectID;
        const numericId = Number(String(idCandidate || '').replace(/[^0-9]/g, ''));
        if (!Number.isFinite(numericId) || numericId <= 0) return null;
        if (seen.has(numericId)) return null;
        seen.add(numericId);

        return {
          id: numericId,
          name: item?.name || item?.company || `ID ${numericId}`,
          country: item?.country || '',
          companyType: item?.companyType || item?.primaryType || ''
        };
      })
      .filter(Boolean)
      .slice(0, 25);

    return res.json({ entity, results: normalizedResults });
  } catch (error) {
    consola.error("[TVDB Discover] Error searching entity:", error.message);
    const status = error.response?.status || 500;
    return res.status(status).json({ error: error.message || "Failed to search TVDB discover entity" });
  }
});

// Proxy: Get TMDB request token
addon.post("/api/tmdb/auth/request_token", async (req, res) => {
  try {
    const { apikey } = req.body;
    
    if (!apikey) {
      return res.status(400).json({ error: "apikey is required" });
    }
    
    consola.debug(`[TMDB Proxy] Getting request token`);
    
    const config = { apiKeys: { tmdb: apikey } };
    const data = await moviedb.requestToken(config);
    
    res.json(data);
  } catch (error) {
    consola.error("[TMDB Proxy] Error getting request token:", error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message || "Failed to get TMDB request token" });
  }
});

// Proxy: Create TMDB session from request token
addon.post("/api/tmdb/auth/session", async (req, res) => {
  try {
    const { apikey, requestToken } = req.body;
    
    if (!apikey) {
      return res.status(400).json({ error: "apikey is required" });
    }
    
    if (!requestToken) {
      return res.status(400).json({ error: "requestToken is required" });
    }
    
    consola.debug(`[TMDB Proxy] Creating session from request token: ${requestToken.substring(0, 10)}...`);
    
    const config = { apiKeys: { tmdb: apikey } };
    const data = await moviedb.sessionId({ request_token: requestToken }, config);
    
    consola.debug(`[TMDB Proxy] Session creation response:`, data);
    
    if (!data.success) {
      consola.warn(`[TMDB Proxy] Session creation failed:`, data);
      return res.json(data);
    }
    
    // Validate the session by trying to get account details
    if (data.session_id) {
      try {
        const accountDetails = await moviedb.getAccountDetails(data.session_id, apikey);
        consola.debug(`[TMDB Proxy] Session validated successfully for account:`, accountDetails?.username || accountDetails?.id);
      } catch (validationError) {
        consola.error(`[TMDB Proxy] Session validation failed:`, validationError.message);
        return res.status(400).json({
          success: false,
          error: "Session created but validation failed. Please make sure you approved the authorization on TMDB.",
          details: validationError.message
        });
      }
    }
    
    res.json(data);
  } catch (error) {
    consola.error("[TMDB Proxy] Error creating session:", error.message);
    consola.error("[TMDB Proxy] Full error:", error);
    const status = error.response?.status || 500;
    res.status(status).json({ 
      error: error.message || "Failed to create TMDB session",
      details: error.response?.data || null
    });
  }
});

// Proxy: Get external lists for current user
addon.get("/api/mdblist/external/lists/user", async (req, res) => {
  try {
    const { apikey } = req.query;
    
    if (!apikey) {
      return res.status(400).json({ error: "apikey is required" });
    }
    
    const url = `https://api.mdblist.com/external/lists/user?apikey=${apikey}`;
    const response = await makeRateLimitedMDBListRequest(url, apikey, 'MDBList Proxy - Get External User Lists');
    res.json(response.data);
  } catch (error) {
    consola.error("[MDBList Proxy] Error fetching external lists:", error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message || "Failed to fetch external lists" });
  }
});

// ── TMDB Discover Preview ──
addon.get("/api/tmdb/discover/preview", async (req, res) => {
  try {
    const { type, ...queryParams } = req.query;
    const tmdbApiKey = await resolveTmdbDiscoverApiKey(req);
    if (!tmdbApiKey) {
      return res.status(400).json({ error: "TMDB API key is required" });
    }
    const mediaType = normalizeTmdbDiscoverType(type);
    const config = { apiKeys: { tmdb: tmdbApiKey } };

    // Pass through all query params except internal ones
    const params = {};
    const skipKeys = new Set(['type', 'apikey', 'userUUID']);
    for (const [key, value] of Object.entries(queryParams)) {
      if (!skipKeys.has(key) && value !== undefined && value !== '') {
        params[key] = value;
      }
    }
    const resolvedParams = resolveDynamicTmdbDiscoverParams(params, {
      timezone: typeof req.query?.timezone === 'string' ? req.query.timezone : undefined
    });
    resolvedParams.page = 1;

    const response = mediaType === 'movie'
      ? await moviedb.discoverMovie(resolvedParams, config)
      : await moviedb.discoverTv(resolvedParams, config);

    const results = (response?.results || []).map(item => ({
      id: item.id,
      title: item.title || item.name,
      poster_path: item.poster_path,
      vote_average: item.vote_average,
      release_date: item.release_date || item.first_air_date,
    }));

    return res.json({ results, total_results: response?.total_results || 0 });
  } catch (error) {
    consola.error("[TMDB Discover Preview] Error:", error.message);
    return res.status(error.response?.status || 500).json({ error: error.message });
  }
});

// ── TVDB Discover Preview ──
addon.get("/api/tvdb/discover/preview", async (req, res) => {
  try {
    const { type, ...queryParams } = req.query;
    const tvdbApiKey = await resolveTvdbDiscoverApiKey(req);
    if (!tvdbApiKey) {
      return res.status(400).json({ error: "TVDB API key is required" });
    }
    const tvdbType = type === 'movie' ? 'movies' : 'series';
    const config = { apiKeys: { tvdb: tvdbApiKey } };

    const params = {};
    const skipKeys = new Set(['type', 'apikey', 'userUUID']);
    for (const [key, value] of Object.entries(queryParams)) {
      if (!skipKeys.has(key) && value !== undefined && value !== '') {
        params[key] = value;
      }
    }

    const response = await tvdbApi.filter(tvdbType, params, config);
    const results = (response || []).slice(0, 20).map(item => ({
      id: item.id,
      title: item.name,
      poster_path: item.image,
      year: item.year,
    }));

    return res.json({ results, total_results: response?.length || 0 });
  } catch (error) {
    consola.error("[TVDB Discover Preview] Error:", error.message);
    return res.status(error.response?.status || 500).json({ error: error.message });
  }
});

// ── AniList Discover Preview ──
addon.post("/api/anilist/discover/preview", async (req, res) => {
  try {
    const params = req.body?.params || {};
    const anilist = require('./lib/anilist');
    const response = await anilist.fetchDiscover(params, 1, 20);
    const results = (response?.items || []).map(item => ({
      id: item.media.id,
      title: item.media.title?.english || item.media.title?.romaji || '',
      poster_path: item.media.coverImage?.large || item.media.coverImage?.medium,
      score: item.media.averageScore,
    }));

    return res.json({ results, total_results: 0 });
  } catch (error) {
    consola.error("[AniList Discover Preview] Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

// ── Simkl Discover Preview ──
addon.get("/api/simkl/discover/preview", async (req, res) => {
  try {
    const { media, ...queryParams } = req.query;
    const mediaType = media === 'movies' ? 'movies' : media === 'shows' ? 'shows' : 'anime';

    const simklUtils = require('./utils/simklUtils');
    const response = await simklUtils.fetchSimklGenreItems(mediaType, queryParams, 1, 20);
    const items = Array.isArray(response?.items) ? response.items : [];

    const results = items.map(item => ({
      id: item.ids?.simkl || item.ids?.tmdb || 0,
      title: item.title || '',
      poster_path: item.poster
        ? `https://wsrv.nl/?url=https://simkl.in/posters/${item.poster}_ca.webp`
        : null,
      year: item.year,
    }));

    return res.json({ results, total_results: response?.totalItems || items.length });
  } catch (error) {
    consola.error("[Simkl Discover Preview] Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

// ── MAL Discover Preview ──
addon.get("/api/mal/discover/preview", async (req, res) => {
  try {
    const params = { ...req.query };
    delete params.apikey;
    delete params.userUUID;

    const jikan = require('./lib/mal');
    const response = await jikan.fetchDiscover(params, 1);
    const items = Array.isArray(response?.items) ? response.items : [];
    const results = items.slice(0, 20).map(item => ({
      id: item.mal_id,
      title: item.title || item.title_english || '',
      poster_path: item.images?.webp?.image_url || item.images?.jpg?.image_url || null,
      score: item.score,
      year: item.year,
    }));

    return res.json({ results, total_results: response?.total || items.length });
  } catch (error) {
    consola.error("[MAL Discover Preview] Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

// ── MDBList Discover Preview ──
addon.get("/api/mdblist/discover/preview", async (req, res) => {
  try {
    const params = { ...req.query };
    const apiKey = params.apikey || process.env.MDBLIST_API_KEY || '';
    const mediaType = params.mediaType === 'show' ? 'show' : 'movie';
    delete params.apikey;
    delete params.userUUID;
    delete params.mediaType;

    if (!apiKey) {
      return res.status(400).json({ error: "MDBList API key is required" });
    }

    const { fetchMDBListCatalog } = require('./utils/mdbList');
    const response = await fetchMDBListCatalog(mediaType, apiKey, 1, params);
    const items = Array.isArray(response?.items) ? response.items : [];
    const results = items.slice(0, 20).map(item => ({
      id: item.ids?.tmdbid || item.ids?.imdbid || item.id || item.imdb_id,
      title: item.title || '',
      poster_path: item.poster || null,
      score: item.score,
      year: item.year,
    }));

    return res.json({ results, total_results: results.length });
  } catch (error) {
    consola.error("[MDBList Discover Preview] Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

// --- Trakt Proxy Endpoints ---
// These proxy frontend Trakt calls through the backend rate limiter

// Proxy: Get user stats
addon.get("/api/trakt/users/:username/stats", async (req, res) => {
  try {
    const { username } = req.params;
    
    if (!username) {
      return res.status(400).json({ error: "username is required" });
    }
    

    const { makeRateLimitedTraktRequest } = require('./utils/traktUtils');
    const url = `https://api.trakt.tv/users/${encodeURIComponent(username)}/stats`;
    const response = await makeRateLimitedTraktRequest(url, `Trakt Proxy - Get User Stats (${username})`);
    res.json(response.data);
  } catch (error) {
    consola.error("[Trakt Proxy] Error fetching user stats:", error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message || "Failed to fetch user stats" });
  }
});

// Simkl stats endpoint - requires authenticated token
addon.post("/api/simkl/users/stats", async (req, res) => {
  try {
    const { tokenId } = req.body;
    
    if (!tokenId) {
      return res.status(400).json({ error: "tokenId is required" });
    }

    // Get the access token from database
    const token = await database.getOAuthToken(tokenId);
    if (!token) {
      return res.status(404).json({ error: "Token not found" });
    }

    if (token.provider !== 'simkl') {
      return res.status(400).json({ error: "Invalid token provider" });
    }

    const { fetchSimklUserStats } = require('./utils/simklUtils');
    const stats = await fetchSimklUserStats(tokenId);
    res.json(stats);
  } catch (error) {
    consola.error("[Simkl] Error fetching user stats:", error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message || "Failed to fetch user stats" });
  }
});

// Proxy: Get user's lists
addon.get("/api/trakt/users/:username/lists", async (req, res) => {
  try {
    const { username } = req.params;
    
    if (!username) {
      return res.status(400).json({ error: "username is required" });
    }
    

    const { makeRateLimitedTraktRequest } = require('./utils/traktUtils');
    const url = `https://api.trakt.tv/users/${encodeURIComponent(username)}/lists`;
    const response = await makeRateLimitedTraktRequest(url, `Trakt Proxy - Get User Lists (${username})`);
    res.json(response.data);
  } catch (error) {
    consola.error("[Trakt Proxy] Error fetching user lists:", error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message || "Failed to fetch user lists" });
  }
});

// Proxy: Get specific list details
addon.get("/api/trakt/users/:username/lists/:slug", async (req, res) => {
  try {
    const { username, slug } = req.params;
    
    if (!username || !slug) {
      return res.status(400).json({ error: "username and slug are required" });
    }
    

    const { makeRateLimitedTraktRequest } = require('./utils/traktUtils');
    const url = `https://api.trakt.tv/users/${encodeURIComponent(username)}/lists/${encodeURIComponent(slug)}`;
    const response = await makeRateLimitedTraktRequest(url, `Trakt Proxy - Get List Details (${username}/${slug})`);
    res.json(response.data);
  } catch (error) {
    consola.error("[Trakt Proxy] Error fetching list details:", error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message || "Failed to fetch list details" });
  }
});

// Proxy: Get trending lists
addon.get("/api/trakt/lists/trending/:type", async (req, res) => {
  try {
    const { type } = req.params;
    const { limit = '100' } = req.query;
    
    if (!type) {
      return res.status(400).json({ error: "type is required (personal or official)" });
    }
    

    const { makeRateLimitedTraktRequest } = require('./utils/traktUtils');
    const url = `https://api.trakt.tv/lists/trending/${encodeURIComponent(type)}?limit=${limit}`;
    const response = await makeRateLimitedTraktRequest(url, `Trakt Proxy - Get Trending Lists (${type})`);
    res.json(response.data);
  } catch (error) {
    consola.error("[Trakt Proxy] Error fetching trending lists:", error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message || "Failed to fetch trending lists" });
  }
});

// Proxy: Get popular lists
addon.get("/api/trakt/lists/popular/:type", async (req, res) => {
  try {
    const { type } = req.params;
    const { limit = '100' } = req.query;
    
    if (!type) {
      return res.status(400).json({ error: "type is required (personal or official)" });
    }
    

    const { makeRateLimitedTraktRequest } = require('./utils/traktUtils');
    const url = `https://api.trakt.tv/lists/popular/${encodeURIComponent(type)}?limit=${limit}`;
    const response = await makeRateLimitedTraktRequest(url, `Trakt Proxy - Get Popular Lists (${type})`);
    res.json(response.data);
  } catch (error) {
    consola.error("[Trakt Proxy] Error fetching popular lists:", error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message || "Failed to fetch popular lists" });
  }
});

// --- Letterboxd Routes (via StremThru) ---

// POST /api/letterboxd/extract-identifier - Extract x-letterboxd-identifier from URL
addon.post("/api/letterboxd/extract-identifier", async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: "url is required" });
    }

    const { extractLetterboxdIdentifier, validateLetterboxdUrl } = require('./utils/letterboxdUtils');
    
    // Validate URL first
    const validation = validateLetterboxdUrl(url);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error || "Invalid Letterboxd URL" });
    }

    // Extract identifier
    const identifier = await extractLetterboxdIdentifier(url);
    
    res.json({
      identifier,
      isWatchlist: validation.isWatchlist,
      username: validation.username,
      listSlug: validation.listSlug
    });
  } catch (error) {
    consola.error("[Letterboxd] Error extracting identifier:", error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message || "Failed to extract Letterboxd identifier" });
  }
});

// POST /api/letterboxd/list - Fetch Letterboxd list from StremThru
addon.post("/api/letterboxd/list", async (req, res) => {
  try {
    const { identifier, isWatchlist } = req.body;
    
    if (!identifier) {
      return res.status(400).json({ error: "identifier is required" });
    }

    const { fetchLetterboxdList } = require('./utils/letterboxdUtils');
    
    const listData = await fetchLetterboxdList(identifier, isWatchlist || false);
    
    res.json(listData);
  } catch (error) {
    consola.error("[Letterboxd] Error fetching list:", error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message || "Failed to fetch Letterboxd list" });
  }
});

// POST /api/flixpatrol/probe - Check available sections for a service/country combo
addon.post("/api/flixpatrol/probe", async (req, res) => {
  try {
    const { service, countrySlug } = req.body;
    if (!service || !countrySlug) {
      return res.status(400).json({ error: "service and countrySlug are required" });
    }
    const { probeFlixPatrolSections } = require('./utils/flixpatrolUtils');
    const sections = await probeFlixPatrolSections(service, countrySlug);
    res.json(sections);
  } catch (error) {
    consola.error("[FlixPatrol] Probe error:", error.message);
    res.status(500).json({ error: error.message || "Failed to probe FlixPatrol" });
  }
});

// --- AniList OAuth Routes ---
const anilistTracker = require('./lib/anilistTracker');
const noStoreOAuthHeaders = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
};
addon.use(['/anilist/auth', '/anilist/callback'], noStoreOAuthHeaders);

// GET /anilist/auth - Initiate AniList OAuth flow
addon.get("/anilist/auth", async (req, res) => {
  try {
    const clientId = process.env.ANILIST_CLIENT_ID;
    const clientSecret = process.env.ANILIST_CLIENT_SECRET;
    const redirectUri = normalizeRedirectUri(process.env.ANILIST_REDIRECT_URI || `${process.env.HOST_NAME}/anilist/callback`);
    
    consola.info(`[AniList OAuth] Starting auth flow with client_id=${clientId}, redirect_uri=${redirectUri}`);
    
    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: "AniList OAuth not configured. Please set ANILIST_CLIENT_ID and ANILIST_CLIENT_SECRET environment variables." });
    }
    
    // Generate state parameter for CSRF protection
    const state = crypto.randomBytes(32).toString('hex');
    
    // Store state in a short-lived way (we'll validate it in callback)
    // For simplicity, we encode it in the URL - in production you might use a session store
    const authUrl = anilistTracker.getAuthorizationUrl(redirectUri, state);
    
    res.redirect(authUrl);
  } catch (error) {
    consola.error("[AniList OAuth] Authorization error:", error);
    res.status(500).json({ error: "Failed to initiate AniList authorization" });
  }
});

// GET /anilist/callback - Handle AniList OAuth callback
addon.get("/anilist/callback", async (req, res) => {
  try {
    const { code } = req.query;
    
    if (!code) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head><title>AniList OAuth Error</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>❌ OAuth Error</h1>
          <p>Invalid callback parameters - missing authorization code.</p>
        </body>
        </html>
      `);
    }
    if (usedAnilistCodes.has(code)) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Anilist OAuth Error</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>⚠️ Code Already Used</h1>
          <p>This authorization code has already been exchanged. Please try authenticating again.</p>
        </body>
        </html>
      `);
    }
    usedAnilistCodes.add(code);
    setTimeout(() => usedAnilistCodes.delete(code), 120000);
    
    const clientId = process.env.ANILIST_CLIENT_ID;
    const clientSecret = process.env.ANILIST_CLIENT_SECRET;
    const redirectUri = normalizeRedirectUri(process.env.ANILIST_REDIRECT_URI || `${process.env.HOST_NAME}/anilist/callback`);
    
    if (!clientId || !clientSecret) {
      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head><title>AniList OAuth Error</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>⚠️ Configuration Error</h1>
          <p>AniList OAuth is not configured on this server.</p>
        </body>
        </html>
      `);
    }
    
    // Exchange code for tokens
    const tokens = await anilistTracker.exchangeCodeForTokens(code, redirectUri);
    
    if (!tokens) {
      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head><title>AniList OAuth Error</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>❌ Token Exchange Failed</h1>
          <p>Failed to exchange authorization code for tokens.</p>
        </body>
        </html>
      `);
    }
    
    // Get user info from AniList
    const user = await anilistTracker.getAuthenticatedUser(tokens.access_token);
    
    if (!user) {
      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head><title>AniList OAuth Error</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>❌ User Info Error</h1>
          <p>Failed to retrieve AniList user information.</p>
        </body>
        </html>
      `);
    }
    
    const existingTokens = await database.getOAuthTokensByProvider('anilist');
    const existingToken = existingTokens.find(t => t.user_id.toLowerCase() === user.username.toLowerCase());
    let tokenId;
    let saved;
    if (existingToken) {
      tokenId = existingToken.id;
      consola.info(`[AniList OAuth] Updating existing token - tokenId: ${tokenId}, user: ${user.username}`);
      saved = await database.updateOAuthToken(
        tokenId,
        tokens.access_token,
        tokens.refresh_token || '',
        tokens.expires_at
      );
    } else {
      tokenId = crypto.randomUUID();
      consola.info(`[AniList OAuth] Creating new token - tokenId: ${tokenId}, user: ${user.username}`);
      saved = await database.saveOAuthToken(
        tokenId,
        'anilist',
        user.username,
        tokens.access_token,
        tokens.refresh_token || '',
        tokens.expires_at,
        ''
      );
    }
    
    if (!saved) {
      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head><title>AniList OAuth Error</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>❌ Database Error</h1>
          <p>Failed to save OAuth token to database.</p>
        </body>
        </html>
      `);
    }
    
    // Display success page with token ID
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>AniList OAuth Success</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          h1 { color: #02a9ff; }
          .token-box { background: #f9f9f9; border: 2px dashed #02a9ff; padding: 20px; margin: 20px 0; border-radius: 5px; word-break: break-all; }
          .token { font-family: monospace; font-size: 14px; color: #333; }
          button { background: #02a9ff; color: white; border: none; padding: 12px 30px; font-size: 16px; cursor: pointer; border-radius: 5px; margin: 10px; }
          button:hover { background: #0288d1; }
          .instructions { text-align: left; margin-top: 30px; padding: 20px; background: #f0f8ff; border-left: 4px solid #02a9ff; }
          .instructions ol { padding-left: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>✅ AniList OAuth Successful</h1>
          <p>Your AniList account <strong>${user.username}</strong> has been authorized!</p>
          
          <div class="token-box">
            <div class="token" id="tokenId">${tokenId}</div>
          </div>
          
          <button onclick="copyToken()">📋 Copy Token ID</button>
          
          <div class="instructions">
            <h3>📝 Next Steps:</h3>
            <ol>
              <li>Copy the Token ID above</li>
              <li>Go to your addon configuration page</li>
              <li>Find the <strong>AniList Integration</strong> section</li>
              <li>Paste this Token ID in the <strong>AniList Token ID</strong> field</li>
              <li>Save your configuration</li>
            </ol>
            <p><strong>⚠️ Important:</strong> Keep this Token ID private. Anyone with this ID can access your AniList account through this addon.</p>
          </div>
        </div>
        
        <script>
          function copyToken() {
            const tokenText = document.getElementById('tokenId').textContent;
            navigator.clipboard.writeText(tokenText).then(() => {
              alert('✅ Token ID copied to clipboard!');
            }).catch(err => {
              alert('❌ Failed to copy. Please select and copy manually.');
            });
          }
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    consola.error("[AniList OAuth] Callback error:", error);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head><title>AniList OAuth Error</title></head>
      <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
        <h1>❌ OAuth Error</h1>
        <p>An error occurred during authentication: ${error.message}</p>
        <p><a href="${process.env.HOST_NAME}/configure">← Back to Configuration</a></p>
      </body>
      </html>
    `);
  }
});

// POST /anilist/disconnect - Disconnect AniList account
addon.post("/anilist/disconnect", async (req, res) => {
  try {
    const { userUUID } = req.body;
    
    if (!userUUID) {
      return res.status(400).json({ error: "userUUID is required" });
    }
    
    // Load user's config
    const config = await loadConfigFromDatabase(userUUID);
    if (!config) {
      return res.status(404).json({ error: "User config not found" });
    }
    
    // Delete OAuth token from database if it exists
    // Token ID is stored in apiKeys.anilistTokenId by the frontend
    if (config.apiKeys?.anilistTokenId) {
      await database.deleteOAuthToken(config.apiKeys.anilistTokenId);
      delete config.apiKeys.anilistTokenId;
    }
    
    // Disable AniList watch tracking
    delete config.anilistWatchTracking;
    
    // Get user's password hash to save config
    const user = await database.getUser(userUUID);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Save updated config directly to database
    await database.saveUserConfig(userUUID, user.password_hash, config);
    
    // Invalidate config cache
    configCache.del(userUUID);
    
    res.json({ success: true });
  } catch (error) {
    consola.error("[AniList] Disconnect error:", error);
    res.status(500).json({ error: "Failed to disconnect AniList" });
  }
});

// GET /anilist/status/:userUUID - Get AniList connection status
addon.get("/anilist/status/:userUUID", async (req, res) => {
  try {
    const { userUUID } = req.params;
    
    if (!userUUID) {
      return res.status(400).json({ error: "userUUID is required" });
    }
    
    // Load user's config
    const config = await loadConfigFromDatabase(userUUID);
    if (!config) {
      return res.status(404).json({ error: "User config not found" });
    }
    
    // Check if AniList token exists
    // Token ID is stored in apiKeys.anilistTokenId by the frontend
    const anilistTokenId = config.apiKeys?.anilistTokenId;
    if (!anilistTokenId) {
      return res.json({ 
        connected: false,
        username: null
      });
    }
    
    // Get the OAuth token from database
    const token = await database.getOAuthToken(anilistTokenId);
    if (!token) {
      return res.json({ 
        connected: false,
        username: null
      });
    }
    
    const isExpired = token.expires_at && Date.now() >= token.expires_at;
    const expiresAt = token.expires_at || null;
    res.json({
      connected: !isExpired,
      expired: isExpired,
      expiresAt,
      username: token.user_id,
      trackingEnabled: config.anilistWatchTracking !== false
    });
  } catch (error) {
    consola.error("[AniList] Status check error:", error);
    res.status(500).json({ error: "Failed to check AniList status" });
  }
});

// POST /api/anilist/lists - Get user's AniList anime lists
addon.post("/api/anilist/lists", async (req, res) => {
  try {
    const { tokenId } = req.body;
    
    if (!tokenId) {
      return res.status(400).json({ error: "tokenId is required" });
    }
    
    // Get the OAuth token from database to retrieve username
    const token = await database.getOAuthToken(tokenId);
    if (!token) {
      return res.status(404).json({ error: "Token not found" });
    }
    
    // Verify this is an AniList token
    if (token.provider !== 'anilist') {
      return res.status(400).json({ error: "Invalid token provider - expected AniList token" });
    }
    
    const username = token.user_id;
    if (!username) {
      return res.status(400).json({ error: "Username not found in token" });
    }
    
    consola.info(`[AniList Lists] Fetching lists for user: ${username}`);
    
    // Fetch user's lists from AniList API
    const result = await anilist.fetchUserLists(username);
    
    res.json({
      success: true,
      username: username,
      lists: result.lists
    });
  } catch (error) {
    consola.error("[AniList Lists] Error fetching lists:", error);
    res.status(500).json({ error: "Failed to fetch AniList lists: " + error.message });
  }
});

// GET /api/anilist/lists/by-username/:username - Get available AniList lists by username (public)
addon.get("/api/anilist/lists/by-username/:username", async (req, res) => {
  try {
    const { username } = req.params;
    
    if (!username || typeof username !== 'string' || username.trim().length === 0) {
      return res.status(400).json({ error: "Username is required and must be a non-empty string" });
    }
    
    const trimmedUsername = username.trim();
    consola.info(`[AniList Lists] Fetching available lists for username: ${trimmedUsername}`);
    
    // Fetch user's lists from AniList API (public endpoint, doesn't require auth)
    const result = await anilist.fetchUserLists(trimmedUsername);
    
    res.json({
      success: true,
      username: trimmedUsername,
      lists: result.lists || []
    });
  } catch (error) {
    consola.error("[AniList Lists] Error fetching lists by username:", error);
    // Don't expose internal error details to avoid leaking sensitive info
    res.status(500).json({ 
      error: "Failed to fetch AniList lists for this username. Please verify the username is correct and the user's lists are public." 
    });
  }
});

// --- PublicMetaDB Proxy Routes ---
addon.get("/api/publicmetadb/validate", async (req, res) => {
  try {
    const { apikey } = req.query;
    if (!apikey) return res.status(400).json({ error: "apikey is required" });
    const { validateKey } = require('./utils/publicmetadbUtils');
    const valid = await validateKey(apikey);
    res.json({ valid });
  } catch (error) {
    consola.error("[PublicMetaDB Proxy] Validation error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

addon.get("/api/publicmetadb/lists", async (req, res) => {
  try {
    const { apikey, page, perPage } = req.query;
    if (!apikey) return res.status(400).json({ error: "apikey is required" });
    const { fetchLists } = require('./utils/publicmetadbUtils');
    const data = await fetchLists(apikey, parseInt(page) || 1, parseInt(perPage) || 50);
    res.json(data);
  } catch (error) {
    consola.error("[PublicMetaDB Proxy] Lists error:", error.message);
    const status = error.message?.includes('401') ? 401 : 500;
    res.status(status).json({ error: error.message });
  }
});

addon.get("/api/publicmetadb/lists/:listId/items", async (req, res) => {
  try {
    const { apikey, page, perPage } = req.query;
    const { listId } = req.params;
    if (!apikey) return res.status(400).json({ error: "apikey is required" });
    const { fetchListItems } = require('./utils/publicmetadbUtils');
    const data = await fetchListItems(apikey, listId, parseInt(page) || 1, parseInt(perPage) || 100);
    res.json(data);
  } catch (error) {
    consola.error("[PublicMetaDB Proxy] List items error:", error.message);
    const status = error.message?.includes('401') ? 401 : 500;
    res.status(status).json({ error: error.message });
  }
});

addon.get("/api/publicmetadb/picks", async (req, res) => {
  try {
    const { apikey } = req.query;
    if (!apikey) return res.status(400).json({ error: "apikey is required" });
    const { fetchPicks } = require('./utils/publicmetadbUtils');
    const data = await fetchPicks(apikey);
    res.json(data);
  } catch (error) {
    consola.error("[PublicMetaDB Proxy] Picks error:", error.message);
    const status = error.message?.includes('401') ? 401 : 500;
    res.status(status).json({ error: error.message });
  }
});

addon.get("/api/publicmetadb/picks/:pickId/items", async (req, res) => {
  try {
    const { apikey, page } = req.query;
    const { pickId } = req.params;
    if (!apikey) return res.status(400).json({ error: "apikey is required" });
    const { fetchPickItems } = require('./utils/publicmetadbUtils');
    const data = await fetchPickItems(apikey, pickId, parseInt(page) || 1);
    res.json(data);
  } catch (error) {
    consola.error("[PublicMetaDB Proxy] Pick items error:", error.message);
    const status = error.message?.includes('401') ? 401 : 500;
    res.status(status).json({ error: error.message });
  }
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
    consola.info('[API] Manual API content warming requested');
    const results = await warmEssentialContent();
    res.json({
      success: true,
      message: 'API content warming completed',
      results
    });
    } catch (error) {
    consola.error('[API] API content warming failed:', error);    res.status(500).json({ 
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
      // Clear all keys matching pattern (safe SCAN-based deletion)
      const deleted = await deleteKeysByPattern(key);
      if (deleted > 0) {
        consola.info(`[Cache] Cleared ${deleted} keys matching pattern: ${key}`);
        res.json({
          success: true,
          message: `Cleared ${deleted} cache keys matching pattern: ${key}`,
          keysCleared: deleted
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
addon.get("/manifest.json", function (req, res) {
  const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;
    const basicManifest = {
        id: "com.aio.metadata",
        version: buildInfo.version,
        name: "AIO Metadata",
        description: "A metadata addon for power users. AIOMetadata uses TMDB, TVDB, TVMaze, MyAnimeList, IMDB and Fanart.tv to provide accurate data for movies, series, and anime. You choose the source.",
        logo: `${host}/logo.png`,
        types: ["movie", "series"],
        catalogs: [],
        resources: [],
        idPrefixes: [],
        behaviorHints: {
          configurable: true,
          configurationRequired: false,
        },
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
addon.get("/stremio/:userUUID/catalog/:type/:id{/:extra}.json", async function (req, res) {
  const { userUUID, type, id, extra } = req.params;
  const config = await loadConfigFromDatabase(userUUID);
  
  if (!config) {
    return res.status(404).send({ error: "User configuration not found" });
  }
  config.userUUID = userUUID;

  // Handle calendar-videos catalog
  if (id === 'calendar-videos' && type === 'series' && extra) {
    const logger = consola.withTag('Calendar');
    
    try {
      // Extract IDs from extra parameter (format: calendarVideosIds=id1,id2,...)
      let ids = extra;
      if (extra.startsWith('calendarVideosIds=')) {
        ids = decodeURIComponent(extra.substring('calendarVideosIds='.length));
      } else {
        ids = decodeURIComponent(extra);
      }
      
      const uniqueIDs = [...new Set(ids.split(',')
        .filter(id => id.startsWith("anilist:") || id.startsWith("kitsu:") || id.startsWith("mal:") || id.startsWith("anidb:") || id.startsWith("tmdb:") || id.startsWith("tvdb:") || id.startsWith("tvmaze:"))
      )];

      logger.debug(`Processing calendar request for ${uniqueIDs.length} IDs`);

      const promises = uniqueIDs.map(async (id) => {
        try {
          const result = await cacheWrapMetaSmart(
            userUUID,
            id,
            async () => {
              return await getMeta('series', config.language || 'en-US', id, config, userUUID, true);
            },
            undefined, 
            { enableErrorCaching: true, maxRetries: 2, config },
            'series',
            true 
          );
          
          if (!result || !result.meta) return null;
          
          const meta = result.meta;
          
          if (meta.videos && Array.isArray(meta.videos)) {
            const now = new Date();
            meta.videos = meta.videos.filter(video => {
              if (!video.released) return false;
              const releaseDate = new Date(video.released);
              return !isNaN(releaseDate.getTime()) && releaseDate >= now;
            });
            
            meta.videos.sort((a, b) => new Date(a.released) - new Date(b.released));
          }
          
          if (!meta.videos || meta.videos.length === 0) return null;
          
          return meta;
        } catch (err) {
          logger.warn(`Failed to process ID ${id} for calendar: ${err.message}`);
          return null;
        }
      });

      const results = await Promise.all(promises);
      const metasDetailed = results.filter(Boolean);

      res.setHeader('Cache-Control', "max-age=10800, stale-while-revalidate=3600, stale-if-error=259200");
      return res.json({ metasDetailed });

    } catch (error) {
      logger.error("Calendar route error:", error);
      return res.status(500).send({ error: "Internal Server Error" });
    }
  }

  let suffixType = null;
  const suffixMatch = id.match(/_(movie|series|anime)$/);
  if (suffixMatch) {
    suffixType = suffixMatch[1];
  }

  // 1. Try to find the catalog config using the exact ID from the URL
  // This handles standard cases like "mal.top_series" correctly
  let catalogConfig = config.catalogs?.find(c =>
    c.id === id && (c.type === type || c.displayType === type)
  );

  let cleanId = id;

  if (id.startsWith('search.') || id.startsWith('people_search.')) {
    const parts = id.split('.');
    if (parts.length >= 2) {
      cleanId = parts.slice(1).join('.');
      if (id.startsWith('people_search.')) {
        cleanId = 'people_search';
      } else {
        cleanId = 'search';
      }
    }
  }

  // 2. If NOT found, check if it's a suffixed ID (created by getManifest for display overrides)
  // e.g. "streaming.nfx_series" -> "streaming.nfx"
  if (!catalogConfig) {
    consola.debug(`[CATALOG ROUTE] No catalog config found for id: ${id}, type: ${type}`);
    const strippedId = id.replace(/_(movie|series|anime)$/, '');
    
    // Only proceed if a replacement actually happened
    if (strippedId !== id) {

      if (suffixType) {
        catalogConfig = config.catalogs?.find(c =>
         c.id === strippedId && c.type === suffixType 
       );
     } 
     
     // Fallback (or if no suffix matched logic)
     if (!catalogConfig) {
       catalogConfig = config.catalogs?.find(c =>
         c.id === strippedId && (c.type === type || c.displayType === type)
       );
     }

     if (catalogConfig) {
       cleanId = strippedId;
     }
    }
  }
  const actualType = catalogConfig ? catalogConfig.type : type;
  
  // Check if user has either RPDB, Top Poster API key, or a custom poster pattern
  const hasRatingPosterKey =
    (config.apiKeys?.rpdb && config.apiKeys.rpdb.trim().length > 0) ||
    (config.apiKeys?.topPoster && config.apiKeys.topPoster.trim().length > 0) ||
    (config.customPosterUrlPattern && config.customPosterUrlPattern.trim().length > 0);

  if (catalogConfig && !hasRatingPosterKey) {
    catalogConfig.enableRatingPosters = false;
  }

  //consola.debug(`[CATALOG ROUTE] catalogConfig:`, JSON.stringify(catalogConfig));

  // Add current catalog config to global config for per-catalog settings (like enableRatingPosters)
  config._currentCatalogConfig = catalogConfig;
  
  const language = config.language || DEFAULT_LANGUAGE;
  const sessionId = config.sessionId;
  
  // Debug logging for TMDB personal lists
  if (cleanId === 'tmdb.favorites' || cleanId === 'tmdb.watchlist') {
    consola.debug(`[CATALOG ROUTE] TMDB personal list - sessionId: ${sessionId ? sessionId.substring(0, 10) + '...' : 'MISSING'}`);
  }

  // Pass config to req for ETag generation
  req.userConfig = config;
  let extraArgs = {};
  if (extra) {
    extraArgs = Object.fromEntries(new URLSearchParams(req.url.split("/").pop().split("?")[0].slice(0, -5)).entries());
  }
  const cacheWrapper = cacheWrapCatalog;

  extraArgs = extraArgs || {};
  // Ensure sort options are included in cache key
  // Trakt uses: sort, sortDirection
  if (cleanId.startsWith('trakt.')) {
    if (catalogConfig?.sort) extraArgs.sort = catalogConfig.sort;
    if (catalogConfig?.sortDirection) extraArgs.sortDirection = catalogConfig.sortDirection;
  }
  // MDBList uses: sort, order
  else if (cleanId.startsWith('mdblist.')) {
    if (catalogConfig?.sort) extraArgs.sort = catalogConfig.sort;
    if (catalogConfig?.order) extraArgs.order = catalogConfig.order;
    // Add score filters for MDBList external lists
    if (catalogConfig?.source === 'mdblist' && catalogConfig?.sourceUrl && catalogConfig?.sourceUrl.includes('/external/lists/')) {
      if (typeof catalogConfig.filter_score_min === 'number') {
        extraArgs.filter_score_min = catalogConfig.filter_score_min;
      }
      if (typeof catalogConfig.filter_score_max === 'number') {
        extraArgs.filter_score_max = catalogConfig.filter_score_max;
      }
    }
  }
  // Streaming uses: sort
  else if (cleanId.startsWith('streaming.') || cleanId.startsWith('tmdb.year') || cleanId.startsWith('tmdb.language')) {
    if (catalogConfig?.sort) extraArgs.sort = catalogConfig.sort;
    if (catalogConfig?.sortDirection) extraArgs.sortDirection = catalogConfig.sortDirection;
  }
  // Discover custom catalogs use discover params (include hash for safe cache invalidation)
  else if (cleanId.startsWith('tmdb.discover.') || cleanId.startsWith('tvdb.discover.') || cleanId.startsWith('simkl.discover.') || cleanId.startsWith('anilist.discover.') || cleanId.startsWith('mal.discover.')) {
    const discoverParams =
      catalogConfig?.metadata?.discover?.params ||
      catalogConfig?.metadata?.discoverParams ||
      null;
    if (discoverParams && typeof discoverParams === 'object') {
      const discoverParamsForSignature = cleanId.startsWith('tmdb.discover.')
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
  // AniList uses: sort, sortDirection
  else if (cleanId.startsWith('anilist.')) {
    if (catalogConfig?.sort) extraArgs.sort = catalogConfig.sort;
    if (catalogConfig?.sortDirection) extraArgs.sortDirection = catalogConfig.sortDirection;
  }
  // Up next catalogs need poster preference and filter settings in cache key
  if (cleanId === 'trakt.upnext' || cleanId === 'mdblist.upnext') {
      extraArgs.useShowPoster = typeof catalogConfig?.metadata?.useShowPosterForUpNext === 'boolean'
        ? catalogConfig.metadata.useShowPosterForUpNext
        : false;
  }
  if (cleanId === 'mdblist.upnext') {
      if (catalogConfig?.metadata?.hideUnreleased !== undefined) {
        extraArgs.hideUnreleased = catalogConfig.metadata.hideUnreleased;
      }
  }
  // Trakt calendar needs today's date and days in cache key
  if (cleanId === 'trakt.calendar') {
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
  // Simkl calendar needs today's date and days in cache key
  if (cleanId.startsWith('simkl.calendar')) {
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
  if (cleanId === 'tvmaze.schedule') {
    // Format date in user's configured timezone (or server timezone as fallback)
    const getUserTimezone = () => config.timezone || process.env.TZ || 'UTC';
    const getTodayInTimezone = (tz) => {
      const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
      return formatter.format(new Date());
    };
    
    const dateString = extraArgs.date || getTodayInTimezone(getUserTimezone());
    extraArgs.date = dateString;
    extraArgs.genre = !extraArgs.genre || extraArgs.genre === 'None' ? '' : extraArgs.genre.toUpperCase();
  }

  // Compute pageSize and derive page from skip BEFORE building the cache key.
  // This normalizes skip values so that different skip values mapping to the same
  // underlying page produce the same cache key (e.g. skip=17 and skip=20 both → page=1).
  let catalogPageSize;
  if (cleanId.startsWith('flixpatrol.')) {
    catalogPageSize = 10;
  } else if (cleanId.includes('mal.')) {
    catalogPageSize = 25;
  } else if (cleanId === 'anilist.trending' || cleanId.startsWith('anilist.discover')) {
    catalogPageSize = 50;
  } else if (cleanId.startsWith('simkl.watchlist.') || cleanId.startsWith('simkl.dvd.') || cleanId.startsWith('simkl.trending.') || cleanId.startsWith('stremthru.') || cleanId.startsWith('mdblist.') || cleanId.startsWith('custom.') || cleanId.startsWith('trakt.') || cleanId.startsWith('anilist.') || cleanId.startsWith('letterboxd.') || (cleanId.startsWith('tvdb.') && !cleanId.startsWith('tvdb.collection.'))) {
    catalogPageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE || '20');
  } else {
    catalogPageSize = 20;
  }
  const isOffsetBased = cleanId.startsWith('stremthru.') || cleanId.startsWith('custom.');
  const catalogPage = extraArgs.skip 
    ? (isOffsetBased 
        ? Math.floor(parseInt(extraArgs.skip) / catalogPageSize) + 1 
        : Math.ceil(parseInt(extraArgs.skip) / catalogPageSize) + 1)
    : 1;

  // Build cache key with page instead of skip for stable cache hits
  const cacheExtraArgs = { ...extraArgs };
  delete cacheExtraArgs.skip;
  if (catalogPage > 1) cacheExtraArgs.page = catalogPage;
  const catalogKey = `${cleanId}:${actualType}:${stableStringify(cacheExtraArgs)}`;

  const cacheOptions = {
    enableErrorCaching: true,
    maxRetries: 2,
    config,
  };
  
  try {
    let responseData;
      
      if (cleanId === 'search' || cleanId === 'gemini.search' || cleanId === 'people_search') {
      let originalSearchId = null;
      if (id.startsWith('search.')) {
        originalSearchId = id.substring('search.'.length);
      } else if (id.startsWith('people_search.')) {
        originalSearchId = id.substring('people_search.'.length);
      } else if (id === 'gemini.search') {
        originalSearchId = 'gemini.search';
      }
      
      let searchType = actualType;
      const searchDisplayTypes = config.search?.searchDisplayTypes || {};
      
      const searchCatalogTypeMap = {
        'movie': 'movie',
        'series': 'series',
        'anime_series': 'anime.series',
        'anime_movie': 'anime.movie',
        'tvdb.collections.search': 'collection',
        'gemini.search': 'other',
        'people_search_movie': 'movie',
        'people_search_series': 'series'
      };
      
      if (originalSearchId && searchCatalogTypeMap[originalSearchId]) {
        searchType = searchCatalogTypeMap[originalSearchId];
      } else {
        const expectedTypes = ['movie', 'series', 'anime.series', 'anime.movie', 'collection', 'other'];
        if (!expectedTypes.includes(actualType)) {
          for (const [searchId, originalType] of Object.entries(searchCatalogTypeMap)) {
            if (searchDisplayTypes[searchId] === actualType) {
              searchType = originalType;
              break;
            }
          }
        }
      }
      
      let searchEngine = null;
      if (originalSearchId === 'gemini.search' || cleanId === 'gemini.search') {
        searchEngine = 'gemini.search';
      } else if (originalSearchId === 'people_search_movie' || (cleanId === 'people_search' && searchType === 'movie')) {
        searchEngine = config.search?.providers?.people_search_movie || 'tmdb.people.search';
      } else if (originalSearchId === 'people_search_series' || (cleanId === 'people_search' && searchType === 'series')) {
        searchEngine = config.search?.providers?.people_search_series || 'tmdb.people.search';
      } else if (originalSearchId === 'movie' || searchType === 'movie') {
        searchEngine = config.search?.providers?.movie;
      } else if (originalSearchId === 'series' || searchType === 'series') {
        searchEngine = config.search?.providers?.series;
      } else if (originalSearchId === 'anime_series' || searchType === 'anime.series') {
        searchEngine = config.search?.providers?.anime_series;
      } else if (originalSearchId === 'anime_movie' || searchType === 'anime.movie') {
        searchEngine = config.search?.providers?.anime_movie;
      } else if (originalSearchId === 'tvdb.collections.search' || searchType === 'collection') {
        searchEngine = 'tvdb.collections.search';
      }
      config._currentSearchEngine = searchEngine;
      config._currentSearchType = searchType;
      config._currentSearchCatalogId = originalSearchId;

      // Compute search-specific page size based on the provider's actual results per page
      let searchPageSize = 20; // default (TMDB, Kitsu)
      if (searchEngine && (searchEngine.startsWith('tvdb.') || searchEngine.startsWith('mal.'))) {
        searchPageSize = 25;
      } else if (searchEngine && searchEngine.startsWith('trakt.')) {
        searchPageSize = 30;
      }
      const searchPage = extraArgs.skip ? Math.ceil(parseInt(extraArgs.skip) / searchPageSize) + 1 : 1;

      // Normalize skip to page for stable search cache keys
      const searchExtraArgs = { ...extraArgs };
      delete searchExtraArgs.skip;
      if (searchPage > 1) searchExtraArgs.page = searchPage;

      // Use search-specific cache wrapper
      const searchKey = `${cleanId}:${originalSearchId}:${searchType}:${stableStringify(searchExtraArgs)}`;

      responseData = await cacheWrapSearch(userUUID, searchKey, async () => {
        const searchResult = await getSearch(cleanId, searchType, language, searchExtraArgs, config);
        return { metas: searchResult.metas || [] };
      }, searchEngine, cacheOptions);
      } else {
      // Use regular catalog cache wrapper
      responseData = await cacheWrapper(userUUID, catalogKey, async () => {
        let metas = [];
        const { genre: genreName, type_filter } = extraArgs;
        const page = catalogPage;
        const args = [actualType, language, page];
        switch (cleanId) {
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
            metas = (await getCatalog(actualType, language, page, cleanId, genreName, config, userUUID, false)).metas;
            break;
          }
          case "tvdb.collections": {
            // TVDB expects 0-based page
            const tvdbPage = Math.max(0, page - 1);
            metas = (await getCatalog(actualType, language, tvdbPage, cleanId, genreName, config, userUUID)).metas;
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
            if (cleanId === 'mal.airing') {
              const animeResults = await cacheWrapJikanApi(`mal-airing-${page}-${config.sfw}`, async () => {
                return await jikan.getAiringNow(page, config);
              }, 24 * 60 * 60, { skipVersion: true });
              metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            } else if (cleanId === 'mal.upcoming') {
              const animeResults = await cacheWrapJikanApi(`mal-upcoming-${page}-${config.sfw}`, async () => {
                return await jikan.getUpcoming(page, config);
              }, 24 * 60 * 60, { skipVersion: true });
              metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            } else if (cleanId === 'mal.top_movies') {
              const animeResults = await cacheWrapJikanApi(`mal-top-movies-${page}-${config.sfw}`, async () => {
                return await jikan.getTopAnimeByType('movie', page, config);
              }, null, { skipVersion: true });
              metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            } else if (cleanId === 'mal.top_series') {
              const animeResults = await cacheWrapJikanApi(`mal-top-series-${page}-${config.sfw}`, async () => {
                return await jikan.getTopAnimeByType('tv', page, config);
              }, null, { skipVersion: true });
              metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            } else if (cleanId === 'mal.most_popular') {
              //consola.debug(`[CATALOG ROUTE 2] mal.most_popular called with type=${actualType}, language=${language}, page=${page}`);
              const animeResults = await cacheWrapJikanApi(`mal-most-popular-${page}-${config.sfw}`, async () => {
                return await jikan.getTopAnimeByFilter('bypopularity', page, config);
              }, null, { skipVersion: true });
              metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            } else if (cleanId === 'mal.most_favorites') {
              const animeResults = await cacheWrapJikanApi(`mal-most-favorites-${page}-${config.sfw}`, async () => {
                return await jikan.getTopAnimeByFilter('favorite', page, config);
              }, null, { skipVersion: true });
              metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            } else if (cleanId === 'mal.top_anime') {
              const animeResults = await cacheWrapJikanApi(`mal-top-anime-${page}-${config.sfw}`, async () => {
                return await jikan.getTopAnimeByType('anime', page, config);
              }, null, { skipVersion: true });
              metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            } else {
            const [startDate, endDate] = decadeMap[cleanId];
            const allAnimeGenres = await cacheWrapJikanApi('anime-genres', async () => {
              //consola.debug('[Cache Miss] Fetching fresh anime genre list from Jikan...');
              return await jikan.getAnimeGenres();
             }, null, { skipVersion: true });
                const genreNameToFetch = genreName && genreName !== 'None' ? genreName : allAnimeGenres[0]?.name;
            if (genreNameToFetch) {
              const selectedGenre = allAnimeGenres.find(g => g.name === genreNameToFetch);
              if (selectedGenre) {
                const genreId = selectedGenre.mal_id;
                    const animeResults = await cacheWrapJikanApi(`mal-${cleanId}-${page}-${genreId}-${config.sfw}`, async () => {
                  return await jikan.getTopAnimeByDateRange(startDate, endDate, page, genreId, config);
                }, null, { skipVersion: true });
                    metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
                }
              }
              
            }
            break;
          }
          case 'tvmaze.schedule': {
            const scheduleDate = extraArgs.date;
            const scheduleCountry = extraArgs.genre;
            metas = (await getTvmazeScheduleCatalog({
              date: scheduleDate,
              country: scheduleCountry,
              page,
              pageSize: catalogPageSize,
              language,
              config,
              userUUID,
              includeVideos: false,
              enableErrorCaching: true,
              maxRetries: 2,
            })).metas;
            break;
          }
          case 'mal.genres': {
            const mediaType = type_filter || 'series';
            const allAnimeGenres = await cacheWrapJikanApi('anime-genres', async () => {
              //consola.debug('[Cache Miss] Fetching fresh anime genre list from Jikan...');
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
                metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
              }
            }
            break;
          }

          case 'mal.studios': {
            if (genreName) {
                //consola.debug(`[Catalog] Fetching anime for MAL studio: ${genreName}`);
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
            }, null, { skipVersion: true });
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
            }, null, { skipVersion: true });
            metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
            break;
          }
          case 'mal.genre_search': {
            const { getSearch } = require('./lib/getSearch');
            const searchResult = await getSearch(cleanId, actualType, language, extraArgs, config);
            metas = searchResult.metas || [];
            break;
          }
          case 'mal.va_search': {
            const { getSearch } = require('./lib/getSearch');
            const searchResult = await getSearch(cleanId, actualType, language, extraArgs, config);
            metas = searchResult.metas || [];
            break;
          }
          default: {
            const skipValue = extraArgs.skip ? parseInt(extraArgs.skip) : undefined;
            metas = (await getCatalog(actualType, language, page, cleanId, genreName, config, userUUID, false, skipValue)).metas;
            break;
          }
      }
      return { metas: metas || [] };
    }, cacheOptions);
    }
    if (!cleanId.startsWith('custom.') && responseData?.metas && Array.isArray(responseData.metas) && responseData.metas.length > 0) {
      const { applyCatalogFilters } = require('./utils/catalogFilters');
      responseData.metas = await applyCatalogFilters(responseData.metas, {
        type,
        config,
        catalogConfig,
        cleanId
      });
    }

    if (Array.isArray(responseData?.metas) && responseData.metas.length > 1) {
      const seen = new Set();
      const deduped = [];
      for (const meta of responseData.metas) {
        const key = meta?.id;
        if (!key) { deduped.push(meta); continue; }
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(meta);
      }
      if (deduped.length !== responseData.metas.length) {
        consola.debug(`[Catalog Route] Deduped ${responseData.metas.length - deduped.length} duplicate metas by id`);
        responseData = { ...responseData, metas: deduped };
      }
    }


    if (catalogConfig?.randomizePerPage && Array.isArray(responseData?.metas) && responseData.metas.length > 1) {
      responseData = {
        ...responseData,
        metas: shuffleMetas(responseData.metas)
      };
    }

    // Art URL pattern overrides for catalog items
    // Skip poster override for up next catalogs unless useShowPosterForUpNext is enabled
    // (when disabled, up next uses episode thumbnails as posters which shouldn't be overridden)
    const host = process.env.HOST_NAME.startsWith('http') ? process.env.HOST_NAME : `https://${process.env.HOST_NAME}`;
    const posterPatternsEnabled = config._currentSearchCatalogId
      ? (config.search?.engineRatingPosters?.[config._currentSearchCatalogId] === true)
      : (catalogConfig?.enableRatingPosters !== false);
    const posterPattern = posterPatternsEnabled ? (config.customPosterUrlPattern || (config.posterRatingProvider && config.posterRatingProvider !== 'custom' ? require('./utils/parseProps').getDefaultPosterPattern(config.posterRatingProvider) : null)) : null;
    if ((posterPattern || config.customBackgroundUrlPattern || config.customLogoUrlPattern) && responseData?.metas && Array.isArray(responseData.metas)) {
      const isUpNextCatalog = cleanId.includes('up_next') || cleanId.includes('upnext');
      const upNextUsesShowPoster = isUpNextCatalog && catalogConfig?.metadata?.useShowPosterForUpNext === true;
      const { resolveCustomArtUrl, getPosterRatingApiKey } = require('./utils/parseProps');
      const proxyApiKey = config.usePosterProxy ? getPosterRatingApiKey(config) : null;
      for (const meta of responseData.metas) {
        const ids = extractIdsFromMeta(meta);
        const type = meta.type || actualType;
        if (posterPattern && (!isUpNextCatalog || upNextUsesShowPoster)) {
          if (proxyApiKey) {
            const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
            if (proxyId) {
              meta.poster = `${host}/poster/${type}/${proxyId}?fallback=${encodeURIComponent(meta.poster || '')}&lang=${config.language || 'en-US'}&key=${proxyApiKey}`;
            }
          } else {
            const resolved = resolveCustomArtUrl(posterPattern, ids, type, config);
            if (resolved) {
              if (config.usePosterProxy) {
                const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
                if (proxyId) {
                  meta.poster = `${host}/poster/${type}/${proxyId}?fallback=${encodeURIComponent(meta.poster || '')}&url=${encodeURIComponent(resolved)}`;
                }
              } else {
                meta.poster = resolved;
              }
            }
          }
        }
        if (config.customBackgroundUrlPattern) {
          const resolved = resolveCustomArtUrl(config.customBackgroundUrlPattern, ids, type, config);
          if (resolved) {
            if (config.usePosterProxy) {
              const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
              if (proxyId) {
                meta.background = `${host}/background/${type}/${proxyId}?fallback=${encodeURIComponent(meta.background || '')}&url=${encodeURIComponent(resolved)}`;
              } else {
                meta.background = resolved;
              }
            } else {
              meta.background = resolved;
            }
          }
        }
        if (config.customLogoUrlPattern) {
          const resolved = resolveCustomArtUrl(config.customLogoUrlPattern, ids, type, config);
          if (resolved) {
            if (config.usePosterProxy) {
              const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
              if (proxyId) {
                meta.logo = `${host}/logo/${type}/${proxyId}?fallback=${encodeURIComponent(meta.logo || '')}&url=${encodeURIComponent(resolved)}`;
              } else {
                meta.logo = resolved;
              }
            } else {
              meta.logo = resolved;
            }
          }
        }
      }
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
    config: fullConfig,
  };
  
  try {
    // Determine useShowPoster for Trakt Up Next
    let useShowPoster = false;
    if (type === 'series' && stremioId && stremioId.startsWith('upnext_')) {
      console.debug('[Meta Route] Detected Trakt Up Next meta request with ID:', stremioId);  
      const catalogConfig = fullConfig.catalogs?.find(c => c.id === 'trakt.upnext');
      if (catalogConfig?.metadata?.useShowPosterForUpNext !== undefined) {
        consola.debug('[Meta Route] Using catalog-specific useShowPosterForUpNext setting:', catalogConfig.metadata.useShowPosterForUpNext);
        useShowPoster = catalogConfig.metadata.useShowPosterForUpNext;
      }
    }
    if (type === 'series' && stremioId && stremioId.startsWith('mdblist_upnext_')) {
      const catalogConfig = fullConfig.catalogs?.find(c => c.id === 'mdblist.upnext');
      if (catalogConfig?.metadata?.useShowPosterForUpNext !== undefined) {
        useShowPoster = catalogConfig.metadata.useShowPosterForUpNext;
      }
    }
    const result = await cacheWrapMetaSmart(
      userUUID,
      stremioId,
      async () => {
        return await getMeta(type, language, stremioId, fullConfig, userUUID, true);
      },
      undefined,
      cacheOptions,
      type,
      true,
      useShowPoster
    );

    if (!result || !result.meta) {
      return respond(req, res, { meta: null });
    }

    {
      const userAgent = req.headers['user-agent'] || '';
      const host = process.env.HOST_NAME.startsWith('http') ? process.env.HOST_NAME : `https://${process.env.HOST_NAME}`;
      const { resolveCustomArtUrl, getDefaultPosterPattern, getDefaultThumbnailPattern, getPosterRatingApiKey } = require('./utils/parseProps');
      const ids = extractIdsFromMeta(result.meta);
      const metaType = result.meta.type || type;
      // Apply poster pattern unless enableRatingPostersForLibrary is explicitly disabled
      if (config.enableRatingPostersForLibrary !== false) {
        const metaPosterPattern = config.customPosterUrlPattern || (config.posterRatingProvider && config.posterRatingProvider !== 'custom' ? getDefaultPosterPattern(config.posterRatingProvider) : null);
        if (metaPosterPattern) {
          const proxyApiKey = config.usePosterProxy ? getPosterRatingApiKey(config) : null;
          if (proxyApiKey) {
            const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
            if (proxyId) {
              result.meta.poster = `${host}/poster/${metaType}/${proxyId}?fallback=${encodeURIComponent(result.meta.poster || '')}&lang=${config.language || 'en-US'}&key=${proxyApiKey}`;
            }
          } else {
            const resolved = resolveCustomArtUrl(metaPosterPattern, ids, metaType, config, { userAgent });
            if (resolved) {
              if (config.usePosterProxy) {
                const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
                if (proxyId) {
                  result.meta.poster = `${host}/poster/${metaType}/${proxyId}?fallback=${encodeURIComponent(result.meta.poster || '')}&url=${encodeURIComponent(resolved)}`;
                }
              } else {
                result.meta.poster = resolved;
              }
            }
          }
        }
      }
      if (config.customBackgroundUrlPattern) {
        const resolved = resolveCustomArtUrl(config.customBackgroundUrlPattern, ids, metaType, config, { userAgent });
        if (resolved) {
          if (config.usePosterProxy) {
            const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
            if (proxyId) {
              result.meta.background = `${host}/background/${metaType}/${proxyId}?fallback=${encodeURIComponent(result.meta.background || '')}&url=${encodeURIComponent(resolved)}`;
            } else {
              result.meta.background = resolved;
            }
          } else {
            result.meta.background = resolved;
          }
        }
      }
      if (config.customLogoUrlPattern) {
        const resolved = resolveCustomArtUrl(config.customLogoUrlPattern, ids, metaType, config, { userAgent });
        if (resolved) {
          if (config.usePosterProxy) {
            const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
            if (proxyId) {
              result.meta.logo = `${host}/logo/${metaType}/${proxyId}?fallback=${encodeURIComponent(result.meta.logo || '')}&url=${encodeURIComponent(resolved)}`;
            } else {
              result.meta.logo = resolved;
            }
          } else {
            result.meta.logo = resolved;
          }
        }
      }
      // Apply thumbnail pattern to episode videos
      const thumbnailPattern = config.customThumbnailUrlPattern || (config.posterRatingProvider && config.posterRatingProvider !== 'custom' ? getDefaultThumbnailPattern(config.posterRatingProvider) : null);
      if (thumbnailPattern && result.meta.videos && Array.isArray(result.meta.videos)) {
        for (const video of result.meta.videos) {
          const idParts = video.id?.split(':');
          if (idParts && idParts.length >= 3) {
            const season = parseInt(idParts[idParts.length - 2], 10);
            const episode = parseInt(idParts[idParts.length - 1], 10);
            if (!isNaN(season) && !isNaN(episode)) {
              // Unwrap blur proxy to get original thumbnail URL for {thumbnail} placeholder
              let originalThumb = video.thumbnail || '';
              if (originalThumb.includes('/api/image/blur?url=')) {
                originalThumb = decodeURIComponent(originalThumb.split('/api/image/blur?url=')[1] || '');
              }
              const resolved = resolveCustomArtUrl(thumbnailPattern, ids, metaType, config, {
                season,
                episode,
                blur: config.blurThumbs ? 'true' : 'false',
                thumbnail: encodeURIComponent(originalThumb),
                userAgent,
              });
              if (resolved) {
                video.thumbnail = resolved;
              }
            }
          }
        }
      }
    }

    /*else if (result && result.meta) {
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
    
    // Use aggressive cache control for meta routes to ensure fresh data when config changes
    // Don't pass cacheOpts to let the respond function use the aggressive cache control
    respond(req, res, result);
    
  } catch (error) {
    consola.error(`CRITICAL ERROR in meta route for ${stremioId}:`, error);
    
    // Log error for dashboard (fire-and-forget)
    try {
      requestTracker.logError('error', `Meta route failed for ${stremioId}`, {
        stremioId,
        type,
        error: error.message,
        stack: error.stack
      }).catch(() => {});
    } catch (logError) {
      consola.warn('Failed to log error:', logError.message);
    }
    
    res.status(500).send("Internal Server Error");
  }
});

// --- Stream route for rating page ---
addon.get("/stremio/:userUUID/stream/:type/:id.json", async function (req, res) {
  const { userUUID, type, id } = req.params;
  const config = await loadConfigFromDatabase(userUUID);
  if (!config) {
    consola.debug(`[Stream Route] No config found for user: ${userUUID}`);
    return respond(req, res, { streams: [] }, { cacheMaxAge: 0 });
  }
  let streamUrl = null;
  consola.debug(`[Stream Route] Showing rate me button: ${config.showRateMeButton}, id: ${id}`);
  if (config.showRateMeButton && id) {
    const host = process.env.HOST_NAME && process.env.HOST_NAME.startsWith('http')
      ? process.env.HOST_NAME
      : `https://${process.env.HOST_NAME}`;
    
    // For series, strip out season:episode from id
    // IMDb: "tt1234567:1:5" -> "tt1234567"
    // Others: "kitsu:12345:1:5" -> "kitsu:12345", "tmdb:12345:1:5" -> "tmdb:12345"
    let cleanId = id;
    if (type === 'series') {
      const parts = id.split(':');
      if (parts[0].startsWith('tt')) {
        // IMDb ID - just take the first part
        cleanId = parts[0];
      } else if (parts.length >= 2) {
        // Provider ID (kitsu:, tmdb:, etc.) - take provider:id
        cleanId = `${parts[0]}:${parts[1]}`;
      }
    }
    
    // Build rating page URL
    streamUrl = `${host}/stremio/${userUUID}/rating?id=${encodeURIComponent(cleanId)}&type=${type}`;
  }
  return respond(req, res, { streams: streamUrl ? [{ externalUrl: streamUrl, name: `⭐ Rate Me` }] : [] }, { cacheMaxAge: 0 });
});

// --- Subtitle Route (for watch tracking) ---
// Route pattern matches Stremio's subtitle URL format: /:id{/:extra}.json
// where extra contains filename, videoSize, and videoHash parameters
addon.get("/stremio/:userUUID/subtitles/:type/:id{/:extra}.json", async function (req, res) {
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
    
    // Check if any watch tracking is enabled (MDBList, AniList, Simkl, or Trakt)
    const hasMdblistKey = config?.apiKeys?.mdblist;
    const mdblistEnabled = !!config?.mdblistWatchTracking;
    const hasAnilistToken = config?.apiKeys?.anilistTokenId;
    const anilistEnabled = !!config?.anilistWatchTracking;
    const hasSimklToken = config?.apiKeys?.simklTokenId;
    const simklEnabled = !!config?.simklWatchTracking;
    const hasTraktToken = config?.apiKeys?.traktTokenId;
    const traktEnabled = !!config?.traktWatchTracking;

    const shouldTrackMdblist = hasMdblistKey && mdblistEnabled;
    const shouldTrackAnilist = hasAnilistToken && anilistEnabled;
    const shouldTrackSimkl = hasSimklToken && simklEnabled;
    const shouldTrackTrakt = hasTraktToken && traktEnabled;

    if (shouldTrackMdblist || shouldTrackAnilist || shouldTrackSimkl || shouldTrackTrakt) {      // Import and call subtitle handler
      const { handleSubtitleRequest } = require('./lib/subtitleHandler');
      
      // Call handler synchronously (no await)
      const result = handleSubtitleRequest(type, id, config, userUUID);
      
      // Return empty subtitle response immediately
      return respond(req, res, result, { cacheMaxAge: 0 });
    } else {
      // Watch tracking disabled or no credentials - return empty subtitles
      consola.debug(`[Watch Tracking] Skipped for user ${userUUID} - mdblist: ${shouldTrackMdblist}, anilist: ${shouldTrackAnilist}, simkl: ${shouldTrackSimkl}, trakt: ${shouldTrackTrakt}`);
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

// --- Rating Route ---
// POST endpoint to submit ratings to external services (Trakt, AniList, MDBList)
addon.post("/stremio/:userUUID/rating", async function (req, res) {
  const { userUUID } = req.params;
  const { ids, type, score, services } = req.body;

  try {
    // Validate input
    if (!ids || !ids.stremio || !type || typeof score !== 'number' || score < 1 || score > 10) {
      return res.status(400).json({ 
        ok: false, 
        error: "Invalid request. Required: ids.stremio, type (movie/series), score (1-10)" 
      });
    }

    // Load user config
    const config = await loadConfigFromDatabase(userUUID);
    if (!config) {
      return res.status(404).json({ ok: false, error: "User config not found" });
    }

    const stremioId = ids.stremio;
    const results = {
      trakt: { success: false, error: null },
      anilist: { success: false, error: null },
      mdblist: { success: false, error: null }
    };

    const isImdbIdAnime = stremioId.startsWith('tt') && !!idMapper.getTraktAnimeMovieByImdbId(stremioId) && type.toLowerCase() === 'movie';
    const isTmdbIdAnime = stremioId.startsWith('tmdb:') && !!idMapper.getTraktAnimeMovieByTmdbId(stremioId.replace('tmdb:', '')) && type.toLowerCase() === 'movie';
    // Check if the Stremio ID is from an anime provider (anilist, mal, kitsu, anidb)
    const isAnimeId = stremioId && typeof stremioId === 'string' && (
      stremioId.startsWith('anilist:') || 
      stremioId.startsWith('mal:') || 
      stremioId.startsWith('kitsu:') || 
      stremioId.startsWith('anidb:')
    );

    const finalType = isAnimeId ? 'anime' : type.toLowerCase() === 'series' ? 'series' : 'movie';
    // Resolve all IDs needed for different services
    const { resolveAllIds } = require('./lib/id-resolver');
    const allIds = await resolveAllIds(stremioId, finalType, config);
    if (type.toLowerCase() === 'movie') {
      if (allIds?.malId) {
        allIds.imdbId = idMapper.getTraktAnimeMovieByMalId(allIds.malId)?.externals.imdb;
        allIds.tmdbId = idMapper.getTraktAnimeMovieByMalId(allIds.malId)?.externals.tmdb || allIds.tmdbId;
        allIds.tvdbId = (wikiMappings.getByImdbId(allIds.imdbId, 'movie'))?.tvdbId || null;
      }
    }

    // Send rating to Trakt if enabled and selected
    const sendToTrakt = services ? (services.trakt === true) : true; // Default to true if services not specified
    if (sendToTrakt && config.apiKeys?.traktTokenId) {
      try {
        const { getTraktAccessToken, makeAuthenticatedRateLimitedTraktWriteRequest } = require('./utils/traktUtils');
        let accessToken = await getTraktAccessToken(config);
        if (!accessToken) {
          results.trakt.error = "Trakt token not found or expired";
        } else {
          const TRAKT_BASE_URL = 'https://api.trakt.tv';
          const traktType = type.toLowerCase() === 'series' ? 'shows' : 'movies';
          const tmdbId = allIds.tmdbId;
          const imdbId = allIds.imdbId;
          const tvdbId = allIds.tvdbId;
          
          if (tmdbId || imdbId || tvdbId) {
            // Build IDs object for Trakt (only include non-null values)
            const ids = {};
            if (tmdbId) ids.tmdb = parseInt(tmdbId, 10);
            if (imdbId) ids.imdb = imdbId;
            if (tvdbId) ids.tvdb = parseInt(tvdbId, 10);
            
            // Trakt sync/ratings payload format
            const payload = {
              [traktType]: [
                {
                  rating: Math.round(score),
                  ids: ids
                }
              ]
            };

            const response = await makeAuthenticatedRateLimitedTraktWriteRequest(
              `${TRAKT_BASE_URL}/sync/ratings`,
              payload,
              accessToken,
              `Trakt submitRating (${traktType})`
            );

            // Trakt returns 201 (Created) on successful rating submission.
            results.trakt.success = true;
            consola.info(`[Rating] Successfully rated ${traktType} on Trakt with score ${score} (status: ${response.status})`);
          } else {
            results.trakt.error = "No Trakt ID found for this item";
          }
        }
      } catch (error) {
        results.trakt.error = error.message || "Failed to rate on Trakt";
        consola.error(`[Rating] Trakt error:`, error.message);
      }
    }

    // Send rating to AniList if enabled and selected (only if Stremio ID is from anime provider)
    const sendToAniList = services ? (services.anilist === true) : true; // Default to true if services not specified
    if (sendToAniList && (isAnimeId || isImdbIdAnime || isTmdbIdAnime) && config.apiKeys?.anilistTokenId) {
      try {
        const token = await database.getOAuthToken(config.apiKeys.anilistTokenId);
        if (token && token.access_token) {
          let anilistId = null; 
          if (stremioId.startsWith('anilist:')) {
            anilistId = stremioId.replace('anilist:', '');
          } else if (stremioId.startsWith('mal:')) {
            anilistId = idMapper.getMappingByMalId(stremioId.replace('mal:', ''))?.anilist_id;
          } else if (stremioId.startsWith('kitsu:')) {
            anilistId = idMapper.getMappingByKitsuId(stremioId.replace('kitsu:', ''))?.anilist_id;
          } else if (stremioId.startsWith('anidb:')) {
            anilistId = idMapper.getMappingByAnidbId(stremioId.replace('anidb:', ''))?.anilist_id;
          }

          if (isImdbIdAnime) {
            const malId =  idMapper.getTraktAnimeMovieByImdbId(stremioId)?.myanimelist.id;
            if (malId) {
              anilistId = idMapper.getMappingByMalId(malId)?.anilist_id;
            }
          } else if (isTmdbIdAnime) {
            const malId = idMapper.getTraktAnimeMovieByTmdbId(stremioId.replace('tmdb:', ''))?.myanimelist.id;
            if (malId) {
              anilistId = idMapper.getMappingByMalId(malId)?.anilist_id;
            }
          }
          if (anilistId) {
            const anilist = require('./lib/anilist');
            // Extract numeric ID - could be number, string like "anilist:123", or "123"
            let anilistIdNum;
            if (typeof anilistId === 'number') {
              anilistIdNum = anilistId;
            } else if (typeof anilistId === 'string') {
              anilistIdNum = parseInt(anilistId.replace(/^anilist:/, '').replace(/^mal:/, ''));
            } else {
              anilistIdNum = parseInt(anilistId);
            }
            
            if (isNaN(anilistIdNum)) {
              results.anilist.error = "Invalid AniList/MAL ID format";
            } else {
              // AniList uses 1-100 scale, convert from 1-10
              const anilistScore = Math.round(score * 10);

              // Validate score is within valid range (1-100)
              if (anilistScore < 1 || anilistScore > 100) {
                results.anilist.error = `Invalid score: ${anilistScore} (must be 1-100)`;
              } else {
                consola.debug(`[Rating] AniList rating - mediaId: ${anilistIdNum}, score: ${anilistScore}`);
                
                try {
                  // Use the submitRating method from anilist instance (uses makeRateLimitedRequest internally)
                  // The method now handles error extraction internally
                  const response = await anilist.submitRating(anilistIdNum, anilistScore, token.access_token);
                  
                  // Check for successful response
                  if (response?.data?.data?.SaveMediaListEntry) {
                    results.anilist.success = true;
                    consola.info(`[Rating] Successfully rated anime ${anilistIdNum} on AniList with score ${anilistScore}`);
                  } else {
                    // This shouldn't happen as submitRating throws on errors, but handle it just in case
                    results.anilist.error = `AniList API returned unexpected response: ${JSON.stringify(response?.data)}`;
                    consola.error(`[Rating] AniList unexpected response:`, response);
                  }
                } catch (error) {
                  // Error message is already formatted by submitRating method
                  results.anilist.error = error.message || "Failed to submit rating to AniList";
                  consola.error(`[Rating] AniList submission error:`, error.message);
                }
              }
            }
          } else {
            results.anilist.error = "No AniList/MAL ID found for this item";
          }
        }
      } catch (error) {
        results.anilist.error = error.message || "Failed to rate on AniList";
        consola.error(`[Rating] AniList error:`, error.message);
      }
    }

    // Send rating to MDBList if enabled and selected
    const sendToMDBList = services ? (services.mdblist === true) : true; // Default to true if services not specified
    if (sendToMDBList && config.apiKeys?.mdblist) {
      try {
        const mdblistApiKey = config.apiKeys.mdblist;
        const { httpPost } = require('./utils/httpClient');
        
        const tmdbId = allIds.tmdbId;
        const imdbId = allIds.imdbId;
        const tvdbId = allIds.tvdbId;
        
        if (tmdbId || imdbId || tvdbId) {
          const mdblistType = type.toLowerCase() === 'series' ? 'shows' : 'movies';
          
          // Build IDs object for MDBList
          const ids = {};
          if (tmdbId) ids.tmdb = parseInt(tmdbId);
          if (imdbId) ids.imdb = imdbId;
          if (tvdbId) ids.tvdb = parseInt(tvdbId);
          
          // MDBList sync/ratings endpoint: POST /sync/ratings?apikey=...
          const url = `https://api.mdblist.com/sync/ratings?apikey=${mdblistApiKey}`;
          
          // Build payload according to MDBList API format
          const payload = {
            [mdblistType]: [
              {
                ids: ids,
                rating: Math.round(score)
              }
            ]
          };
          
          await httpPost(url, payload, {
            headers: {
              'Content-Type': 'application/json'
            }
          });
          
          results.mdblist.success = true;
          consola.info(`[Rating] Successfully rated ${type} on MDBList with score ${score}`);
        } else {
          results.mdblist.error = "No TMDB or IMDb ID found for this item";
        }
      } catch (error) {
        results.mdblist.error = error.message || "Failed to rate on MDBList";
        consola.error(`[Rating] MDBList error:`, error.message);
      }
    }

    // Check if at least one service succeeded
    const anySuccess = results.trakt.success || results.anilist.success || results.mdblist.success;
    
    if (anySuccess) {
      return res.json({ 
        ok: true, 
        results,
        message: "Rating submitted successfully to at least one service"
      });
    } else {
      return res.status(400).json({ 
        ok: false, 
        error: "Failed to submit rating to any service",
        results
      });
    }
  } catch (error) {
    consola.error(`[Rating] Error in rating route:`, error);
    return res.status(500).json({ 
      ok: false, 
      error: error.message || "Internal server error" 
    });
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

async function fetchPosterImageStream(posterUrl) {
  const imageResponse = await axios({
    method: 'get',
    url: posterUrl,
    responseType: 'stream',
    timeout: 5000,
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 300,
    headers: { 'User-Agent': `AIOMetadata/${buildInfo.version}` }
  });

  const contentType = imageResponse.headers['content-type'];
  if (contentType && !contentType.toLowerCase().startsWith('image/')) {
    imageResponse.data.destroy();
    throw new Error(`Poster URL returned non-image content-type: ${contentType}`);
  }

  const contentLength = imageResponse.headers['content-length'];
  const parsedContentLength = contentLength ? parseInt(contentLength, 10) : null;
  if (Number.isFinite(parsedContentLength) && parsedContentLength < 100) {
    imageResponse.data.destroy();
    throw new Error(`Poster URL returned too-small content-length: ${contentLength}`);
  }

  return imageResponse;
}

function pipePosterImageResponse(res, imageResponse) {
  const contentType = imageResponse.headers['content-type'];
  res.setHeader('Content-Type', contentType || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  imageResponse.data.pipe(res);
}

addon.get("/poster/:type/:id", async function (req, res) {
  const { type, id } = req.params;
  const { fallback, lang, key, url: customUrl } = req.query;
  if (!key && !customUrl) {
    return res.redirect(302, fallback);
  }
  const etag = crypto.createHash('md5').update(`${type}:${id}:${customUrl || key}:${lang}`).digest('hex');
  res.setHeader('ETag', `"${etag}"`);
  if (req.headers['if-none-match'] === `"${etag}"`) {
    return res.status(304).end();
  }

  try {
    let posterUrl = customUrl || null;

    if (!posterUrl) {
      const [idSource, idValue] = id.startsWith('tt') ? ['imdb', id] : id.split(':');
      const ids = {
        tmdbId: idSource === 'tmdb' ? idValue : null,
        tvdbId: idSource === 'tvdb' ? idValue : null,
        imdbId: idSource === 'imdb' ? idValue : null,
      };
      const isTopPoster = key.startsWith('TP-');
      if (isTopPoster) {
        const config = { apiKeys: { topPoster: key }, posterRatingProvider: 'top' };
        posterUrl = getRatingPosterUrl(type, ids, lang, config, fallback);
      } else {
        posterUrl = getRpdbPoster(type, ids, lang, key);
      }
    }

    if (!posterUrl) {
      return res.redirect(302, fallback);
    }

    const imageResponse = await fetchPosterImageStream(posterUrl);
    pipePosterImageResponse(res, imageResponse);
  } catch (error) {
    consola.error(`Error in poster proxy for ${id}:`, error.message);
    res.redirect(302, fallback);
  }
});

function streamArtWithFallback(assetName) {
  return async function (req, res) {
    const { type, id } = req.params;
    const { fallback, url: customUrl } = req.query;
    if (!customUrl) {
      return res.redirect(302, fallback || '');
    }
    const etag = crypto.createHash('md5').update(`${assetName}:${type}:${id}:${customUrl}`).digest('hex');
    res.setHeader('ETag', `"${etag}"`);
    if (req.headers['if-none-match'] === `"${etag}"`) {
      return res.status(304).end();
    }
    try {
      const imageResponse = await axios({
        method: 'get',
        url: customUrl,
        responseType: 'stream',
        timeout: 5000,
        validateStatus: (status) => status >= 200 && status < 300,
        headers: { 'User-Agent': `AIOMetadata/${buildInfo.version}` }
      });
      const contentType = imageResponse.headers['content-type'];
      res.setHeader('Content-Type', contentType || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      imageResponse.data.pipe(res);
    } catch (error) {
      consola.debug(`Art proxy miss for ${assetName} ${id}: ${error.message}`);
      if (fallback) {
        return res.redirect(302, fallback);
      }
      res.status(404).end();
    }
  };
}

addon.get("/logo/:type/:id", streamArtWithFallback('logo'));
addon.get("/background/:type/:id", streamArtWithFallback('background'));


// --- Image Processing Routes ---
addon.get("/api/image/blur", async function (req, res) {
  const imageUrl = req.query.url;
  if (!imageUrl) { return res.status(400).send('Image URL not provided'); }
  
  // Add security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  try {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    await blurImage(imageUrl, res);
  } catch (error) {
    consola.error('Error in blur route:', error);
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    res.status(500).send('Error processing image');
  }
});

// Convert banner to background image
addon.get("/api/image/banner-to-background", async function (req, res) {
  const imageUrl = req.query.url;
  if (!imageUrl) { return res.status(400).send('Image URL not provided'); }
  
  try {
    // Parse options from query parameters
    const options = {
      width: parseInt(req.query.width) || 1920,
      height: parseInt(req.query.height) || 1080,
      blur: parseFloat(req.query.blur) || 0,
      brightness: parseFloat(req.query.brightness) || 1,
      contrast: parseFloat(req.query.contrast) || 1,
      position: req.query.position || 'center' // Add position parameter
    };
    
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    await convertBannerToBackground(imageUrl, options, res);
  } catch (error) {
    consola.error(`Error converting banner to background for ${imageUrl}:`, error.message);
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
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
    res.sendFile(clientIndexPath);
  });

// Rating Page Route - MUST be before static middleware
// Access via: /stremio/:userUUID/rating?id=stremioId&type=Series&title=Title
// Or: /rating?user=userUUID&id=stremioId&type=Series&title=Title
addon.get("/stremio/:userUUID/rating", async function (req, res) {
  const { userUUID } = req.params;
  const { id, type } = req.query;
  
  // No cache to prevent cross-instance contamination
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
  try {
    let html = fs.readFileSync(clientIndexPath, 'utf8');
    
    let metaTitle = '';
    let metaPoster = '';
    let metaDescription = '';
    
    // Use type from URL query parameter (source of truth)
    // Normalize: Series/series -> Series, Movie/movie -> Movie
    let metaType = 'Series'; // Default
    if (type) {
      const normalizedType = type.toLowerCase();
      metaType = normalizedType === 'series' ? 'Series' : 'Movie';
    }
    
    // Check which services are available for this user
    let availableServices = {
      trakt: false,
      anilist: false,
      mdblist: false
    };
    consola.debug(`[Rating Page] Checking if ID is anime - id: ${id}, metaType: ${metaType}, gettraktanimemoviebyimdbid: ${JSON.stringify(idMapper.getTraktAnimeMovieByImdbId(id))}`);  
    const isImdbIdAnime = id && id.startsWith('tt') && !!idMapper.getTraktAnimeMovieByImdbId(id) && metaType === 'Movie';
    const isTmdbIdAnime = id && id.startsWith('tmdb:') && !!idMapper.getTraktAnimeMovieByTmdbId(id.replace('tmdb:', '')) && metaType === 'Movie';
    // Check if the Stremio ID in URL is from an anime provider (anilist, mal, kitsu, anidb)
    const isAnimeId = id && typeof id === 'string' && (
      id.startsWith('anilist:') || 
      id.startsWith('mal:') || 
      id.startsWith('kitsu:') || 
      id.startsWith('anidb:') ||
      isImdbIdAnime ||
      isTmdbIdAnime
    );
    
    try {
      const config = await loadConfigFromDatabase(userUUID);
      if (config) {
        // Check Trakt
        if (config.apiKeys?.traktTokenId) {
          const token = await database.getOAuthToken(config.apiKeys.traktTokenId);
          availableServices.trakt = !!(token && token.access_token && (!token.expires_at || Date.now() < Number(token.expires_at)));
        }

        // Check AniList (only if Stremio ID is from anime provider and user has AniList configured)
        if (isAnimeId && config.apiKeys?.anilistTokenId) {
          const token = await database.getOAuthToken(config.apiKeys.anilistTokenId);
          availableServices.anilist = !!(token && token.access_token && (!token.expires_at || Date.now() < Number(token.expires_at)));
        }
        
        // Check MDBList
        availableServices.mdblist = !!config.apiKeys?.mdblist;
      }
    } catch (error) {
      consola.warn('[Rating Page] Failed to check available services:', error.message);
    }
    
    if (id && userUUID) {
      try {
        // Use the type from URL to look up metadata
        const stremioType = metaType.toLowerCase();
        const contentKey = `${stremioType}:${id}`;
        
        // Try to get metadata from cache with multiple key variants (same as dashboard)
        const tryKeys = [];
        // exact member key (often includes .json or provider prefix)
        tryKeys.push(`content_metadata:${contentKey}`);
        // decoded variant without extension
        const parts = contentKey.split(":");
        const keyType = parts[0];
        const rawId = parts.slice(1).join(":");
        const decoded = decodeURIComponent(rawId || "");
        const cleanId = decoded.replace(/\.(json|xml)$/i, "");
        tryKeys.push(`content_metadata:${keyType}:${cleanId}`);
        // encoded + .json variant from captureMetadataFromComponents
        const encodedJson = encodeURIComponent(cleanId) + ".json";
        tryKeys.push(`content_metadata:${keyType}:${encodedJson}`);
        // provider variants (tmdb:123 etc.) if present in original
        if (cleanId.includes(":")) {
          tryKeys.push(`content_metadata:${keyType}:${cleanId}`);
          const providerEncoded = encodeURIComponent(cleanId) + ".json";
          tryKeys.push(`content_metadata:${keyType}:${providerEncoded}`);
        }
        
        let metadataStr = null;
        for (const k of tryKeys) {
          try {
            metadataStr = await redis.get(k);
            if (metadataStr) break;
          } catch (_) {}
        }
        
        if (metadataStr) {
          const metadata = JSON.parse(metadataStr);
          metaTitle = metadata.title || metadata.name || '';
          metaPoster = metadata.poster || '';
          metaDescription = metadata.description || '';
        }
      } catch (error) {
        consola.warn('[Rating Page] Failed to read metadata from cache:', error.message);
        // Continue with empty values - frontend will handle fallback
      }
    }
    
    const pageTitle = metaTitle ? `Rate ${metaTitle} - AIO Metadata` : 'Rate This Title - AIO Metadata';
    html = html.replace(
      /<title>.*?<\/title>/,
      `<title>${pageTitle}</title>`
    );
    
    const ratingScript = `
      <script>
        window.RATING_MODE = true;
        window.RATING_USER = ${JSON.stringify(userUUID)};
        window.RATING_ID = ${JSON.stringify(id || '')};
        window.RATING_TYPE = ${JSON.stringify(metaType)};
        window.RATING_TITLE = ${JSON.stringify(metaTitle || req.query.title || '')};
        window.RATING_POSTER = ${JSON.stringify(metaPoster)};
        window.RATING_DESCRIPTION = ${JSON.stringify(metaDescription)};
        window.RATING_AVAILABLE_SERVICES = ${JSON.stringify(availableServices)};
      </script>
    `;
    
    // Add rating-specific script
    html = html.replace(
      '</head>',
      ratingScript + '</head>'
    );
    
    res.send(html);
  } catch (error) {
    consola.error('Error serving rating page:', error);
    res.status(500).send('Error loading rating page');
  }
});

addon.get("/rating", (req, res) => {
  const { user, id, type, title } = req.query;
  
  if (!user || !id) {
    return res.status(400).send('Missing required parameters: user and id');
  }
  
  // Redirect to the proper route format
  const params = new URLSearchParams();
  if (id) params.set('id', id);
  if (type) params.set('type', type);
  if (title) params.set('title', title);
  
  res.redirect(`/stremio/${user}/rating?${params.toString()}`);
});

addon.use(favicon(path.join(publicDir, 'favicon.png')));
addon.use('/configure', express.static(clientDistDir));
addon.use(express.static(publicDir));
addon.use(express.static(clientDistDir));

// Dedicated Dashboard Page Route
addon.get("/dashboard", (req, res) => {
  // Serve the same HTML but with dashboard-specific handling
  try {
    let html = fs.readFileSync(clientIndexPath, 'utf8');
    
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
    
    // Clear all cache entries for this user (safe SCAN-based deletion)
    const userCachePattern = `*${userUUID}*`;
    const deleted = await deleteKeysByPattern(userCachePattern);
    if (deleted > 0) {
      consola.info(`[Cache Invalidation] Cleared ${deleted} cache entries for user ${userUUID}`);
      
      res.json({
        success: true,
        message: `Cache invalidated for user ${userUUID}`,
        cacheEntriesCleared: deleted
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

addon.get('/api/cache/invalidation-status/:userUUID', async (req, res) => {
  try {
    const { userUUID } = req.params;
    
    // Count cache entries for this user
    const userCachePattern = `*${userUUID}*`;
    // Group by cache type
    const cacheStats = {
      total: 0,
      byType: {}
    };
    // Iterate keys via SCAN and accumulate stats
    await scanKeys(userCachePattern, async (k) => {
      cacheStats.total++;
      if (k.includes('meta-')) cacheStats.byType.meta = (cacheStats.byType.meta || 0) + 1;
      else if (k.includes('catalog')) cacheStats.byType.catalog = (cacheStats.byType.catalog || 0) + 1;
      else if (k.includes('manifest')) cacheStats.byType.manifest = (cacheStats.byType.manifest || 0) + 1;
      else cacheStats.byType.other = (cacheStats.byType.other || 0) + 1;
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
const { isMetricsDisabled } = require('./lib/metricsConfig');

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

// Middleware to require admin authentication for dashboard routes
function requireDashboardAdmin(req, res, next) {
  const adminKey = process.env.ADMIN_KEY;
  
  // If ADMIN_KEY is not configured, deny access with specific message
  if (!adminKey) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'ADMIN_KEY environment variable must be configured to access the dashboard'
    });
  }
  
  // Validate the provided admin key
  if (req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Valid key - proceed to route handler
  next();
}

// Middleware for conditionally-protected endpoints (public when guest mode enabled)
function requireAuthUnlessGuestMode(req, res, next) {
  const disableGuestMode = process.env.DISABLE_GUEST_MODE === 'true' || 
                           process.env.DISABLE_GUEST_MODE === '1';
  
  // If guest mode is enabled (env var not set/falsy), allow access without auth
  if (!disableGuestMode) {
    return next();
  }
  
  // Guest mode disabled - require admin auth
  return requireDashboardAdmin(req, res, next);
}

// Apply the no-cache middleware to all dashboard and dashboard API routes
addon.use('/dashboard', noCache);
addon.use('/api/dashboard', noCache);

// Public config endpoint - must be defined BEFORE admin auth middleware
// This endpoint is always accessible regardless of guest mode setting
addon.get("/api/dashboard/config", (req, res) => {
  try {
    const dashboardApi = getDashboardAPI();
    const config = dashboardApi.getConfig();
    res.json(config);
  } catch (error) {
    consola.error('[Dashboard API] Error getting config:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard config' });
  }
});

// Lightweight auth check endpoint - verifies admin key without loading heavy data
addon.get("/api/dashboard/auth/check", requireDashboardAdmin, (req, res) => {
  // If we get here, the admin key is valid (requireDashboardAdmin passed)
  res.json({ authenticated: true });
});

// Note: Admin authentication is now applied per-route instead of globally
// Public endpoints use requireAuthUnlessGuestMode (accessible without auth when guest mode enabled)
// Protected endpoints use requireDashboardAdmin (always require admin auth)


addon.get("/api/dashboard/overview", requireAuthUnlessGuestMode, async (req, res) => {
  try {
    const dashboardApi = getDashboardAPI();
    
    // If metrics are disabled, return minimal essential data with disabled flag
    if (isMetricsDisabled()) {
      Promise.all([
        dashboardApi.getSystemOverview(),
      ]).then(([systemOverview]) => {
        res.json({
          metricsDisabled: true,
          message: "Metrics have been disabled on this instance",
          systemOverview,
          quickStats: null,
          timestamp: new Date().toISOString(),
        });
      }).catch(error => {
        consola.error('[Dashboard API] Error:', error);
        res.status(500).json({ error: 'Failed to fetch dashboard data' });
      });
      return;
    }
    
    // Overview tab only needs: systemOverview, quickStats
    // Other data is fetched by their respective tab endpoints
    const [systemOverview, quickStats] = await Promise.all([
      dashboardApi.getSystemOverview(),
      dashboardApi.getQuickStats(),
    ]);

    const data = {
      systemOverview,
      quickStats,
      timestamp: new Date().toISOString(),
    };
    
    res.json(data);
  } catch (error) {
    consola.error('[Dashboard API] Error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

addon.get("/api/dashboard/stats", requireAuthUnlessGuestMode, (req, res) => {
  // Check if metrics are disabled
  if (isMetricsDisabled()) {
    return res.json({ 
      metricsDisabled: true,
      message: "Metrics have been disabled on this instance"
    });
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

addon.get("/api/dashboard/system", requireAuthUnlessGuestMode, (req, res) => {
  
  try {
    const dashboardApi = getDashboardAPI();
    
    // If metrics disabled, don't fetch recentActivity
    if (isMetricsDisabled()) {
      Promise.all([
        dashboardApi.getSystemConfig(),
        dashboardApi.getResourceUsage(),
        dashboardApi.getProviderStatus(),
      ]).then(([systemConfig, resourceUsage, providerStatus]) => {
        res.json({ systemConfig, resourceUsage, providerStatus, recentActivity: [] });
      }).catch(error => {
        consola.error('[Dashboard API] Error:', error);
        res.status(500).json({ error: 'Failed to fetch system data' });
      });
      return;
    }
    
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

addon.get("/api/dashboard/operations", requireDashboardAdmin, (req, res) => {
  
  
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

addon.get("/api/dashboard/memory", requireDashboardAdmin, (req, res) => {
  try {
    const dashboardApi = getDashboardAPI();
    res.json(dashboardApi.getHeapProfile());
  } catch (error) {
    consola.error('[Dashboard API] Memory profile error:', error);
    res.status(500).json({ error: 'Failed to fetch memory profile' });
  }
});

const HEAP_DIAGNOSTICS_DIR = path.resolve(
  process.env.HEAP_DIAGNOSTICS_DIR || path.join(process.cwd(), 'addon', 'data', 'diagnostics')
);
let heapSnapshotInProgress = false;

function ensureHeapDiagnosticsDir() {
  fs.mkdirSync(HEAP_DIAGNOSTICS_DIR, { recursive: true });
}

function getHeapDiagnosticFiles() {
  ensureHeapDiagnosticsDir();
  return fs.readdirSync(HEAP_DIAGNOSTICS_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .filter(entry => entry.name.endsWith('.heapsnapshot') || entry.name.endsWith('.heapprofile'))
    .map(entry => {
      const filePath = path.join(HEAP_DIAGNOSTICS_DIR, entry.name);
      const stats = fs.statSync(filePath);
      return {
        name: entry.name,
        size: stats.size,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
        downloadUrl: `/api/dashboard/heap-snapshots/${encodeURIComponent(entry.name)}`,
      };
    })
    .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
}

addon.post("/api/dashboard/heap-snapshots", requireDashboardAdmin, (req, res) => {
  if (heapSnapshotInProgress) {
    return res.status(409).json({ error: 'Heap snapshot already in progress' });
  }

  heapSnapshotInProgress = true;
  try {
    ensureHeapDiagnosticsDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = crypto.randomBytes(4).toString('hex');
    const filename = `heap-${timestamp}-${process.pid}-${suffix}.heapsnapshot`;
    const targetPath = path.join(HEAP_DIAGNOSTICS_DIR, filename);
    const snapshotPath = v8.writeHeapSnapshot(targetPath);
    const stats = fs.statSync(snapshotPath);

    res.json({
      name: path.basename(snapshotPath),
      size: stats.size,
      directory: HEAP_DIAGNOSTICS_DIR,
      downloadUrl: `/api/dashboard/heap-snapshots/${encodeURIComponent(path.basename(snapshotPath))}`,
      warning: 'Heap snapshots may contain secrets such as tokens, API keys, request data, and user configuration.',
    });
  } catch (error) {
    consola.error('[Dashboard API] Heap snapshot error:', error);
    res.status(500).json({ error: 'Failed to write heap snapshot', message: error.message });
  } finally {
    heapSnapshotInProgress = false;
  }
});

addon.get("/api/dashboard/heap-snapshots", requireDashboardAdmin, (req, res) => {
  try {
    res.json({
      directory: HEAP_DIAGNOSTICS_DIR,
      files: getHeapDiagnosticFiles(),
    });
  } catch (error) {
    consola.error('[Dashboard API] Heap snapshot list error:', error);
    res.status(500).json({ error: 'Failed to list heap diagnostics', message: error.message });
  }
});

addon.get("/api/dashboard/heap-snapshots/:filename", requireDashboardAdmin, (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    if (!filename.endsWith('.heapsnapshot') && !filename.endsWith('.heapprofile')) {
      return res.status(400).json({ error: 'Unsupported diagnostic file type' });
    }

    const filePath = path.resolve(HEAP_DIAGNOSTICS_DIR, filename);
    if (!filePath.startsWith(`${HEAP_DIAGNOSTICS_DIR}${path.sep}`)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Diagnostic file not found' });
    }

    res.download(filePath, filename);
  } catch (error) {
    consola.error('[Dashboard API] Heap snapshot download error:', error);
    res.status(500).json({ error: 'Failed to download heap diagnostic', message: error.message });
  }
});

// Enhanced timing metrics API endpoint
addon.get("/api/dashboard/timing", requireAuthUnlessGuestMode, async (req, res) => {
  // Check if metrics are disabled
  if (isMetricsDisabled()) {
    return res.json({ 
      metricsDisabled: true,
      message: "Metrics have been disabled on this instance"
    });
  }
  
  try {
    const timingMetrics = require('./lib/timing-metrics');
    const { getPerformanceStats } = require('./lib/id-resolver.js');
    
    // Get comprehensive timing data
    const [dashboardData, providerBreakdown, resolutionBreakdown, idResolverStats] = await Promise.all([
      timingMetrics.getDashboardData(),
      timingMetrics.getProviderTimingBreakdown(),
      timingMetrics.getResolutionTimingBreakdown(),
      Promise.resolve(getPerformanceStats())
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
      idResolverPerformance: idResolverStats,
      lastUpdated: new Date().toISOString()
    });
  } catch (error) {
    consola.error('[Timing API] Error:', error);
    res.status(500).json({ error: 'Failed to fetch timing data' });
  }
});

addon.post("/api/dashboard/cache/clear", requireDashboardAdmin, (req, res) => {
  
  
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

addon.post("/api/dashboard/poster-cache/purge", requireDashboardAdmin, async (req, res) => {
  const posterCacheUrl = (process.env.POSTER_WARMUP_URL || process.env.POSTER_PROXY_PREFIX_URL || '').replace(/\/+$/, '');
  if (!posterCacheUrl) {
    return res.status(400).json({ error: 'No poster cache URL configured' });
  }

  try {
    const response = await fetch(`${posterCacheUrl}/purge`, { method: 'POST' });
    const result = await response.json();
    consola.info('[API] Poster cache purge requested via dashboard');
    res.json(result);
  } catch (error) {
    consola.error('[API] Poster cache purge failed:', error.message);
    res.status(502).json({ error: 'Failed to reach poster cache', details: error.message });
  }
});

addon.get("/api/dashboard/poster-cache/stats", requireDashboardAdmin, async (req, res) => {
  const posterCacheUrl = (process.env.POSTER_WARMUP_URL || process.env.POSTER_PROXY_PREFIX_URL || '').replace(/\/+$/, '');
  if (!posterCacheUrl) {
    return res.status(400).json({ error: 'No poster cache URL configured' });
  }

  try {
    const response = await fetch(`${posterCacheUrl}/stats`);
    const stats = await response.json();
    res.json(stats);
  } catch (error) {
    res.status(502).json({ error: 'Failed to reach poster cache', details: error.message });
  }
});

addon.post("/api/dashboard/users/clear", requireDashboardAdmin, (req, res) => {
  
  
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

addon.get("/api/dashboard/analytics", requireAuthUnlessGuestMode, async (req, res) => {
  // Check if metrics are disabled
  if (isMetricsDisabled()) {
    return res.json({ 
      metricsDisabled: true,
      message: "Metrics have been disabled on this instance"
    });
  }
  
  try {
    const { getPerformanceStats } = require('./lib/id-resolver.js');
    const dashboardApi = getDashboardAPI();
    
    const [stats, hourlyStats, topEndpoints, providerHourlyData, idResolverStats, cachePerformance, providerPerformance] = await Promise.all([
      requestTracker.getStats(),
      requestTracker.getHourlyStats(24),
      requestTracker.getTopEndpoints(10),
      requestTracker.getHourlyProviderStats(24),
      Promise.resolve(getPerformanceStats()),
      dashboardApi.getCachePerformance(),
      dashboardApi.getProviderPerformance()
    ]);

    res.json({ 
      requestStats: stats, 
      hourlyData: hourlyStats,
      topEndpoints: topEndpoints,
      providerHourlyData: providerHourlyData,
      idResolverPerformance: idResolverStats,
      cachePerformance,
      providerPerformance
    });
  } catch (error) {
    consola.error('[Dashboard API] Error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics data' });
  }
});

addon.post("/api/dashboard/uptime/reset", requireDashboardAdmin, (req, res) => {
  
  
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
addon.post("/api/dashboard/test-errors", requireDashboardAdmin, (req, res) => {
  
  
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

// Clear all error logs endpoint
addon.post("/api/dashboard/errors/clear", requireDashboardAdmin, async (req, res) => {
  try {
    const result = await requestTracker.clearErrorLogs();
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json({ error: result.message });
    }
  } catch (error) {
    consola.error('[Dashboard API] Error clearing error logs:', error);
    res.status(500).json({ error: 'Failed to clear error logs' });
  }
});

addon.get("/api/dashboard/content", requireAuthUnlessGuestMode, (req, res) => {
  // Check if metrics are disabled
  if (isMetricsDisabled()) {
    return res.json({ 
      metricsDisabled: true,
      message: "Metrics have been disabled on this instance"
    });
  }
  
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

addon.get("/api/dashboard/users", requireDashboardAdmin, (req, res) => {
  // Users endpoint is NOT disabled when metrics are disabled
  // It provides user management which is essential for admin UI
  
  
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
addon.get("/api/dashboard/mal-warmup", requireAuthUnlessGuestMode, (req, res) => {
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
addon.get("/api/dashboard/catalog-warmup", requireAuthUnlessGuestMode, (req, res) => {
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
addon.get("/api/dashboard/warming", requireAuthUnlessGuestMode, (req, res) => {
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
addon.post("/api/dashboard/warming/control", requireDashboardAdmin, (req, res) => {
  
  
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
addon.post("/api/dashboard/maintenance/execute", requireDashboardAdmin, async (req, res) => {
  
  
  try {
    const { taskId, action } = req.body;
    
    if (!taskId || !action) {
      return res.status(400).json({ error: 'Task ID and action are required' });
    }
    
    let result = { success: false, message: '' };
    
    // Handle maintenance tasks
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
    } else if (taskId === 2) { // Update anime-list XML
      if (action === 'restart' || action === 'enable') {
        try {
          const { forceUpdateAnimeListXml } = require('./lib/anime-list-mapper');
          result = await forceUpdateAnimeListXml();
          if (result.success) {
            result.message = `Anime-list XML updated successfully (${result.count.toLocaleString()} entries)`;
          }
        } catch (error) {
          consola.error('[Maintenance Task] Error updating anime-list XML:', error);
          result = { success: false, message: `Failed to update anime-list XML: ${error.message}` };
        }
      }
    } else if (taskId === 3) { // Update ID Mapper
      if (action === 'restart' || action === 'enable') {
        try {
          const { forceUpdateIdMapper } = require('./lib/id-mapper');
          result = await forceUpdateIdMapper();
          if (result.success) {
            result.message = `ID Mapper updated successfully (${result.count.toLocaleString()} entries)`;
          }
        } catch (error) {
          consola.error('[Maintenance Task] Error updating ID Mapper:', error);
          result = { success: false, message: `Failed to update ID Mapper: ${error.message}` };
        }
      }
    } else if (taskId === 4) { // Update Kitsu-IMDB Mapping
      if (action === 'restart' || action === 'enable') {
        try {
          const { forceUpdateKitsuImdbMapping } = require('./lib/id-mapper');
          result = await forceUpdateKitsuImdbMapping();
          if (result.success) {
            result.message = `Kitsu-IMDB Mapping updated successfully (${result.count.toLocaleString()} entries)`;
          }
        } catch (error) {
          consola.error('[Maintenance Task] Error updating Kitsu-IMDB Mapping:', error);
          result = { success: false, message: `Failed to update Kitsu-IMDB Mapping: ${error.message}` };
        }
      }
    } else if (taskId === 5) { // Update Wikidata Mappings
      if (action === 'restart' || action === 'enable') {
        try {
          const { forceUpdateWikiMappings } = require('./lib/wiki-mapper');
          result = await forceUpdateWikiMappings();
          if (result.success) {
            result.message = `Wikidata Mappings updated successfully (${result.seriesCount.toLocaleString()} series, ${result.moviesCount.toLocaleString()} movies)`;
          }
        } catch (error) {
          consola.error('[Maintenance Task] Error updating Wikidata Mappings:', error);
          result = { success: false, message: `Failed to update Wikidata Mappings: ${error.message}` };
        }
      }
    } else if (taskId === 11) { // Update IMDb Ratings
      if (action === 'restart' || action === 'enable') {
        try {
          const { forceUpdateImdbRatings } = require('./lib/imdbRatings');
          result = await forceUpdateImdbRatings();
          if (result.success) {
            result.message = `IMDb Ratings updated successfully (${result.count.toLocaleString()} ratings)`;
          }
        } catch (error) {
          consola.error('[Maintenance Task] Error updating IMDb Ratings:', error);
          result = { success: false, message: `Failed to update IMDb Ratings: ${error.message}` };
        }
      }
    } else if (taskId === 7) { // Essential Cache Warming
      if (action === 'restart' || action === 'enable') {
        const { warmEssentialContent } = require('./lib/cacheWarmer');
        warmEssentialContent();
        result = { success: true, message: 'Essential cache warming started' };
      } else if (action === 'stop') {
        const { stopWarming } = require('./lib/cacheWarmer');
        result = stopWarming();
      }
    } else if (taskId === 8) { // MAL Catalog Warming
      if (action === 'restart' || action === 'enable') {
        const { forceRunMALWarmup } = require('./lib/malCatalogWarmer');
        result = forceRunMALWarmup();
      } else if (action === 'stop') {
        const { stopMALWarmup } = require('./lib/malCatalogWarmer');
        result = stopMALWarmup();
      }
    } else if (taskId === 9) { // Comprehensive Catalog Warming
      if (action === 'restart' || action === 'enable') {
        const { forceRestartWarmup } = require('./lib/comprehensiveCatalogWarmer');
        forceRestartWarmup();
        result = { success: true, message: 'Comprehensive catalog warming started (force restart)' };
      } else if (action === 'stop') {
        const { stopComprehensiveWarming } = require('./lib/comprehensiveCatalogWarmer');
        result = stopComprehensiveWarming();
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
