const express = require("express");
const favicon = require('serve-favicon');
const fs = require('fs');
const path = require("path");
const crypto = require('crypto');
const stream = require('stream');
const v8 = require('v8');
const addon = express();
// Honor X-Forwarded-* headers from reverse proxies (e.g., Traefik) so req.protocol reflects HTTPS
//addon.set('trust proxy', true);

const { getCatalog } = require("./lib/getCatalog");
const { applyCatalogFilters, catalogFiltersActive } = require("./utils/catalogFilters");
const { cursorKey, resolveStartPage, writeCursor, fillFilteredPage } = require("./lib/catalogPagination");
const anilist = require("./lib/anilist");
const { getSearch } = require("./lib/getSearch");
const { getManifest, resolveManifestTags, DEFAULT_LANGUAGE } = require("./lib/getManifest");
const { resolveInstallFilters, uniformTagRating, allowsUnrated, scopeTagsToCatalog } = require("./utils/ageRating");
const { getMeta } = require("./lib/getMeta");
const { cacheWrapMetaSmart, cacheWrapCatalog, cacheWrapSearch, cacheWrapJikanApi, cacheWrapGlobal, getCacheHealth, clearCacheHealth, logCacheHealth, stableStringify, deleteKeysByPattern, scanKeys } = require("./lib/getCache");
const { hasPermission } = require("./lib/authSession");
const { isOidcConfigured } = require("./lib/oidc");
const { resolveConfigAccess } = require("./lib/configAccess");
const managerAccounts = require("./lib/managerAccounts");
const redis = require("./lib/redisClient");
const { warmEssentialContent, warmPopularContent, scheduleEssentialWarming } = require("./lib/cacheWarmer");
const requestTracker = require("./lib/requestTracker");
const { runWithRequestContext } = require('./lib/logBuffer.js');
const { getSetting } = require('./lib/settingsService');
const consola = require('consola');
const aiCatalogLogger = consola.withTag('AICatalog');
const { stripReleaseAvailabilityForResponse } = require('./utils/releaseAvailability');

const { supportsMdblistScoreFilters } = require("./utils/mdbList");

const configApi = require('./lib/configApi');
const database = require('./lib/database');
const { loadConfigFromDatabase } = require('./lib/configApi');
const { getTrending } = require("./lib/getTrending");
const { resolveProxyRatingPosterUrl, parseAnimeCatalogMetaBatch } = require("./utils/parseProps");
const { extractIdsFromMeta, extractCanonicalIdFromDynamicUpNextId } = require("./utils/metaIds");
const { sleep } = require("./utils/concurrency");
const { resolveMdblistKey, mdblistCacheKey } = require("./utils/mdblistUtils");
const { normalizeTraktEndpoint, resolveTraktProxyAuthMode } = require("./utils/traktProxyRoutes");
const { normalizeTvdbListRecord, enrichTvdbListRecords } = require("./utils/tvdbLists");
const { resolveTmdbDiscoverApiKey, resolveTvdbDiscoverApiKey, normalizeTmdbDiscoverType, normalizeTvdbDiscoverType, toTvdbCountryCode } = require("./utils/discoverParams");
const { normalizeRedirectUri } = require("./utils/oauthRedirect");
const { shuffleMetas } = require("./utils/mergedCatalog");
const { getFavorites, getWatchList } = require("./lib/getPersonalLists");
const { resolveDynamicTmdbDiscoverParams } = require('./lib/tmdbDiscoverDateTokens');
const { isDiscoverCatalogId, applyDiscoverSignature } = require('./lib/discoverCatalogSignature');
const { blurImage, convertBannerToBackground } = require('./utils/imageProcessor');
const { getAiTriggerKeyword, applyAiTrigger } = require('./utils/aiSearchTrigger');
const { TraktClient } = require('./lib/trakt');
const movielens = require('./lib/movielens');
const {
  createAniListOAuthState,
  createMalOAuthTransaction,
  createSimklOAuthState,
  createTraktOAuthState,
  verifyAniListOAuthState,
  verifyMalOAuthState,
  verifySimklOAuthState,
  verifyTraktOAuthState,
} = require('./lib/oauthState');
const { renderOAuthPage } = require('./lib/oauthPage');
const { hasAnyWatchTrackingEnabled } = require('./lib/watchTracking');
const { SimklClient } = require('./lib/simkl');
const {
  createSessionId,
  deleteDeviceAuthSession,
  getDeviceAuthSession,
  registerPoll,
  saveDeviceAuthSession,
  widenPollInterval,
} = require('./lib/deviceAuthSessions');
const jikan = require('./lib/mal');
const buildInfo = require('./lib/buildInfo');
const { clientDistDir, clientIndexPath, publicDir } = require('./lib/runtimePaths');
const ADDON_VERSION = buildInfo.version;
const { withGlobalEpoch } = require('./lib/cacheEpoch');
const idMapper = require('./lib/id-mapper');
const wikiMappings = require('./lib/wiki-mapper.js');

// Normalize redirect URIs to always include a scheme
// Best-effort same-process duplicate handling. Trakt enforces authorization-code
// single use; this set is not shared across replicas and does not consume state.
const usedTraktCodes = new Set();
const TRAKT_OAUTH_STATE_TTL_MS = parseInt(process.env.TRAKT_OAUTH_STATE_TTL_MS || String(10 * 60 * 1000), 10);
const usedAnilistCodes = new Set();
const ANILIST_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SIMKL_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// Which Simkl flows this instance offers. PIN needs only a client id, so it is
// the default when no secret is set.
function resolveSimklAuthMode() {
  const configured = String(getSetting('SIMKL_AUTH_MODE') || '').trim().toLowerCase();
  if (configured === 'pin' || configured === 'oauth' || configured === 'both') {
    return configured;
  }
  return getSetting('SIMKL_CLIENT_SECRET') ? 'oauth' : 'pin';
}

function simklPinEnabled() {
  const mode = resolveSimklAuthMode();
  return mode === 'pin' || mode === 'both';
}

const usedMalCodes = new Set();
const MAL_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;





const { createResponseCompression } = require('./utils/responseCompression');
addon.use(createResponseCompression());

// Parse JSON and URL-encoded bodies for API routes.
// The parser mounts before settings load, so the limit is resolved per request
// rather than captured here, and a parser is kept per distinct limit.
const jsonBodyParsers = new Map();

function jsonBodyParserFor(limit) {
  let parser = jsonBodyParsers.get(limit);
  if (!parser) {
    parser = express.json({ limit });
    jsonBodyParsers.set(limit, parser);
  }
  return parser;
}

addon.use((req, res, next) => {
  let limit;
  try {
    limit = getSetting('MAX_REQUEST_BODY_SIZE');
  } catch {
    limit = '';
  }
  return jsonBodyParserFor(limit || '8mb')(req, res, next);
});
addon.use(express.urlencoded({ extended: true }));

// Express reports an oversized body as an HTML stack, which reaches the setup
// page as an unreadable failure rather than as the ceiling it is.
addon.use((err, req, res, next) => {
  if (err?.type !== 'entity.too.large') return next(err);
  consola.warn(`[Request] Body over the ${err.limit} byte limit on ${req.method} ${req.path}`);
  return res.status(413).json({
    error: 'Configuration is too large to send in one request. An instance administrator can raise Max Request Body Size in the dashboard settings.',
    limit: err.limit,
    length: err.length ?? null,
  });
});

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

const { readiness } = require('./lib/lifecycle/runtime.js');
const { createReadinessGate } = require('./lib/lifecycle/readiness.js');

addon.get('/health/live', (req, res) => {
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    version: ADDON_VERSION,
  });
});

addon.get('/health/ready', (req, res) => {
  const snapshot = readiness.snapshot();
  res.status(snapshot.ready ? 200 : 503).json({
    status: snapshot.ready ? 'ready' : 'starting',
    ready: snapshot.ready,
    components: snapshot.components,
    timestamp: new Date().toISOString(),
    version: ADDON_VERSION,
  });
});

addon.use(createReadinessGate(readiness, { allowPaths: ['/health'] }));

const { createAliasResolutionMiddleware } = require('./lib/aliasMiddleware.js');
const { resolveAliasSync, isAliasFeatureEnabled } = require('./lib/aliasResolver.js');
addon.use(createAliasResolutionMiddleware({
  resolve: resolveAliasSync,
  isEnabled: isAliasFeatureEnabled,
}));

// Add request tracking middleware
addon.use(requestTracker.middleware());

addon.use((req, res, next) => {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(req.path);
  if (m) return runWithRequestContext(m[1], () => next());
  next();
});

const noStoreOAuthHeaders = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
};
addon.use(
  [
    '/api/auth/trakt/authorize',
    '/api/auth/trakt/callback',
    '/api/auth/simkl/authorize',
    '/api/auth/simkl/callback',
    '/api/auth/simkl/pin',
    '/api/auth/simkl/pin/status',
    '/api/auth/simkl/pin/cancel',
    '/api/auth/movielens/connect',
  ],
  noStoreOAuthHeaders
);

function TEST_KEYS_RATE_LIMIT_PER_MIN() { return parseInt(process.env.TEST_KEYS_RATE_LIMIT_PER_MIN || '60', 10); }

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

    if (currentCount > TEST_KEYS_RATE_LIMIT_PER_MIN()) {
      return res.status(429).json({ error: 'Too many API key validation requests. Please try again shortly.' });
    }
  } catch (error) {
    consola.warn('[Rate Limit] /api/test-keys limiter failed, allowing request:', error.message);
  }

  next();
}

const REDIS_LIMITER_TIMEOUT_MS = 500;

function DEVICE_AUTH_POLL_RATE_LIMIT_PER_MIN() {
  const parsed = parseInt(getSetting('DEVICE_AUTH_POLL_RATE_LIMIT_PER_MIN'), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 240;
}

function getManagerSyncHostDelayMs() {
  const parsed = parseInt(getSetting('MANAGER_SYNC_HOST_DELAY_MS'), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 400;
}

// Own bucket: a pending code polls every few seconds and would eat the much
// tighter /api/test-keys budget.
async function deviceAuthPollRateLimitMiddleware(req, res, next) {
  if (!redis) {
    return next();
  }

  try {
    const minuteBucket = Math.floor(Date.now() / 60000);
    // Keyed per caller, the way the config-load limiter is. A single bucket for
    // the whole instance would let a handful of concurrent authorizations spend
    // the budget, and would let anyone spend it deliberately: a pending code
    // polls every few seconds and these routes need no session.
    const target = (typeof req.query?.sessionId === 'string' && req.query.sessionId)
      || (typeof req.body?.sessionId === 'string' && req.body.sessionId)
      || req.session?.accountId
      || req.ip
      || 'unknown';
    const rateKey = `rate-limit:device-auth-poll:${target}:${minuteBucket}`;

    // Bounded: with no Redis listening, ioredis holds a command for the better
    // part of a minute, and these routes are polled every few seconds. A count
    // we can't read in time means the request is allowed through.
    const currentCount = await Promise.race([
      redis.incr(rateKey),
      new Promise(resolve => setTimeout(() => resolve(null), REDIS_LIMITER_TIMEOUT_MS).unref()),
    ]);

    if (currentCount === null) {
      return next();
    }

    if (currentCount === 1) {
      redis.expire(rateKey, 70).catch(() => undefined);
    }

    if (currentCount > DEVICE_AUTH_POLL_RATE_LIMIT_PER_MIN()) {
      return res.status(429).json({ error: 'Too many authorization status requests. Please try again shortly.' });
    }
  } catch (error) {
    consola.warn('[Rate Limit] Device auth poll limiter failed, allowing request:', error.message);
  }

  next();
}

function CONFIG_LOAD_RATE_LIMIT_PER_MIN() {
  const parsed = parseInt(require('./lib/settingsService').getSetting('CONFIG_LOAD_RATE_LIMIT_PER_MIN'), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
}

async function configLoadRateLimitMiddleware(req, res, next) {
  if (!redis) {
    return next();
  }

  try {
    const minuteBucket = Math.floor(Date.now() / 60000);
    const target = req.params.userUUID
      || (typeof req.body?.userUUID === 'string' ? req.body.userUUID.trim() : '')
      || req.session?.accountId
      || req.ip
      || 'unknown';
    const rateKey = `rate-limit:config-load:${target}:${minuteBucket}`;
    const currentCount = await redis.incr(rateKey);

    if (currentCount === 1) {
      await redis.expire(rateKey, 70);
    }

    if (currentCount > CONFIG_LOAD_RATE_LIMIT_PER_MIN()) {
      return res.status(429).json({ error: 'Too many login attempts. Please try again shortly.' });
    }
  } catch (error) {
    consola.warn('[Rate Limit] /api/config/load limiter failed, allowing request:', error.message);
  }

  next();
}


const posterCacheConfig = require('./lib/posterCache/config.js');
const { buildProxyArtUrl, proxyArtUrlVouched } = require('./lib/posterCache/proxyArt.js');
const { serveStoreResult, servePassThrough, openArtStream } = require('./lib/posterCache/artProxyServe.js');

function POSTER_PROXY_PREFIX_URL() { return posterCacheConfig.getPosterProxyPrefix(); }


function applyImageCachePrefix(data) {
  const prefix = POSTER_PROXY_PREFIX_URL();
  if (!prefix || !data) return;

  const selfOrigin = posterCacheConfig.getSelfOrigin();
  const metaFieldClasses = posterCacheConfig.META_FIELD_CLASSES;
  const cacheThumbnails = posterCacheConfig.isClassEnabled('thumbnail');
  const cacheCast = posterCacheConfig.isClassEnabled('cast');

  const enabledFields = posterCacheConfig.getCacheableFields();
  if (enabledFields.length === 0 && !cacheThumbnails && !cacheCast) return;

  const prefixUrl = (url, imageClass) => {
    if (!url || typeof url !== 'string') return url;
    if (url.startsWith(prefix)) return url;
    if (!/^https?:\/\//i.test(url)) return url;
    if (selfOrigin && url.startsWith(selfOrigin)) return url;
    return posterCacheConfig.buildCachedUrl(prefix, imageClass, url);
  };

  const applyToMeta = (meta) => {
    if (!meta) return;
    for (const field of enabledFields) {
      if (meta[field]) meta[field] = prefixUrl(meta[field], metaFieldClasses[field]);
    }
    if (cacheThumbnails && Array.isArray(meta.videos)) {
      for (const video of meta.videos) {
        if (video?.thumbnail) video.thumbnail = prefixUrl(video.thumbnail, 'thumbnail');
      }
    }
    if (cacheCast && Array.isArray(meta.app_extras?.cast)) {
      for (const member of meta.app_extras.cast) {
        if (member?.photo) member.photo = prefixUrl(member.photo, 'cast');
      }
    }
  };

  applyToMeta(data.meta);
  if (Array.isArray(data.metas)) {
    for (const meta of data.metas) applyToMeta(meta);
  }
}

const isCacheWarmingEnabled = () => process.env.ENABLE_CACHE_WARMING !== 'false';

/** Read at call time so the status route reports a value changed from the dashboard. */
const cacheWarmingIntervalMinutes = () => parseInt(process.env.CACHE_WARMING_INTERVAL || '720', 10);

/** Called by the startup sequence once settings are loaded. */
function startEssentialWarmingSchedules() {
  const CACHE_WARMING_INTERVAL = cacheWarmingIntervalMinutes();

  if (isCacheWarmingEnabled()) {
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
}

/** Called by the startup sequence once settings are loaded. */
function startMovieLensSyncSchedule() {
  const ENABLE_MOVIELENS_SYNC = process.env.ENABLE_MOVIELENS_SYNC !== 'false';
  if (ENABLE_MOVIELENS_SYNC && process.env.MOVIELENS_CRED_KEY) {
    const MOVIELENS_SYNC_INTERVAL_HOURS = Math.max(1, parseInt(process.env.MOVIELENS_SYNC_INTERVAL_HOURS || '24', 10));
    const intervalMs = MOVIELENS_SYNC_INTERVAL_HOURS * 60 * 60 * 1000;
    consola.info(`[MovieLens] Scheduling rating re-sync every ${MOVIELENS_SYNC_INTERVAL_HOURS}h`);
    setInterval(() => {
      require('./lib/movielensSync').syncAllMovieLensAccounts().catch(error => {
        consola.warn('[MovieLens] Scheduled re-sync failed:', error.message);
      });
    }, intervalMs);
  }
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

/**
 * The filtering an install URL asks for, from the profiles it names and from the raw
 * parameters. One UUID can then serve both an unrestricted and a family install.
 * Copied rather than assigned onto the config, because concurrent loads for the same
 * user are coalesced and hand back the same object.
 */

function applyRatingOverrides(config, req, userUUID) {
  const rawRating = req.query.contentrating ?? req.query.contentRating;
  const rawUnrated = req.query.unrated;
  const rawTag = req.query.tag;
  if (rawRating === undefined && rawUnrated === undefined && rawTag === undefined) return config;

  const { tags: urlTags } = resolveManifestTags(config, rawTag);
  const tags = scopeTagsToCatalog(config, urlTags, req.params.id, req.params.type);
  const { ageRating, allowUnrated, refused } = resolveInstallFilters(config, {
    rating: rawRating,
    unrated: rawUnrated,
    tags,
  });
  if (refused.length > 0) {
    consola.warn(`[Rating] User ${userUUID} asked for ${refused.join(', ')}, which does not tighten their configured ${config.ageRating || 'None'}`);
  }

  const hidesUnrated = allowUnrated === false && allowsUnrated(config);
  const showsUnrated = allowUnrated === true && !allowsUnrated(config);
  if (!ageRating && !hidesUnrated && !showsUnrated) return config;

  const next = { ...config };
  if (ageRating) {
    next.ageRating = ageRating;
    next._ratingOverride = ageRating;
  }
  if (hidesUnrated || showsUnrated) next.allowUnratedContent = !hidesUnrated;
  consola.debug(`[Rating] User ${userUUID} install capped at ${next.ageRating}${hidesUnrated ? ', unrated hidden' : ''} (configured ${config.ageRating || 'None'}${tags.length ? `, profiles ${tags.join(', ')}` : ''})`);
  return next;
}

const respond = function (req, res, data, opts?) {
  // Store minimal tracking data in res.locals for success detection
  if (req.path.includes('/catalog/') && data && data.metas) {
    res.locals.resultCount = data.metas.length;
    res.locals.hasResults = data.metas.length > 0;
  }

  {
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

      // Set by the manifest route once the query has been resolved, so the validator
      // follows the profiles that were actually built rather than the raw query.
      if (Array.isArray(req.manifestTags) && req.manifestTags.length > 0) {
        etagContent += ':tags:' + req.manifestTags.map((t) => t.toLowerCase()).join(',');
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

  applyImageCachePrefix(data);

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
      tmdb: getSetting('TMDB_API_KEY'),
      tvdb: getSetting('TVDB_API_KEY'),
      fanart: getSetting('FANART_API_KEY'),
      rpdb: getSetting('RPDB_API_KEY'),
      mdblist: getSetting('MDBLIST_API_KEY'),
      gemini: getSetting('GEMINI_API_KEY'),
      trakt: getSetting('TRAKT_CLIENT_ID'),
      simkl: getSetting('SIMKL_CLIENT_ID'),
      simklAuthMode: resolveSimklAuthMode(),
      customDescriptionBlurb: getSetting('CUSTOM_DESCRIPTION_BLURB'),
      addonVersion: ADDON_VERSION,
      hasBuiltInTvdb: !!getSetting('BUILT_IN_TVDB_API_KEY'),
      hasBuiltInTmdb: !!getSetting('BUILT_IN_TMDB_API_KEY'),
      hasBuiltInMdblist: !!getSetting('BUILT_IN_MDBLIST_API_KEY'),
      hasBuiltInGemini: !!getSetting('BUILT_IN_GEMINI_API_KEY'),
      catalogTTL: parseInt(getSetting('CATALOG_TTL') || String(24 * 60 * 60), 10),
      maxCatalogs: parseInt(getSetting('MAX_CATALOGS') || '', 10) || null,
      collectionImportCatalogCap: parseInt(getSetting('COLLECTION_IMPORT_CATALOG_CAP') || '', 10) || 400,
      simklTrendingPageSizeOptions: resolvedOptions,
      traktSearchEnabled: getSetting('DISABLE_TRAKT_SEARCH') !== 'true',
      simklSearchEnabled: getSetting('DISABLE_SIMKL_SEARCH') !== 'true',
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

// --- Authentication and config profiles ---
require('./lib/authRoutes').register(addon, {
  rateLimit: configLoadRateLimitMiddleware,
  requireAdmin: requireDashboardAdmin,
});
const { requireSigninForAppPages, requireSigninForApi, isAuthenticatedRequest, respondIfSigninRequired } = require('./lib/signinGate');
const { runWithRequestAuth } = require('./lib/requestSession');
addon.use((req, _res, next) => runWithRequestAuth(isAuthenticatedRequest(req), next));
addon.use(requireSigninForAppPages);
addon.use(requireSigninForApi);

// --- Configuration Database API Routes ---
addon.post("/api/config/save", configApi.saveConfig.bind(configApi));
addon.post("/api/config/load/:userUUID", configLoadRateLimitMiddleware, configApi.loadConfig.bind(configApi));
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
    
    const state = createTraktOAuthState(clientSecret, TRAKT_OAUTH_STATE_TTL_MS);
    const authUrl = traktClient.getAuthorizationUrl(state);
    
    res.redirect(authUrl);
  } catch (error) {
    consola.error("[Trakt OAuth] Authorization error:", error);
    res.status(500).json({ error: "Failed to initiate Trakt authorization" });
  }
});

// Coalesce duplicate exchanges handled by this process only.
const pendingTraktExchanges = new Map();

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

        await sleep(waitSeconds * 1000);
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
      return res.status(400).send(renderOAuthPage({
        provider: 'trakt',
        status: 'error',
        title: 'Authorization incomplete',
        message: 'Trakt did not return an authorization code. Please start the connection again.',
        retryHref: '/api/auth/trakt/authorize',
      }));
    }

    if (usedTraktCodes.has(code)) {
      return res.status(400).send(renderOAuthPage({
        provider: 'trakt',
        status: 'warning',
        title: 'Authorization already used',
        message: 'This authorization has already been completed. Start a new connection if you need another token.',
        retryHref: '/api/auth/trakt/authorize',
        retryLabel: 'Reconnect Trakt',
      }));
    }

    const clientSecret = process.env.TRAKT_CLIENT_SECRET;
    if (!state || !verifyTraktOAuthState(state, clientSecret)) {
      return res.status(400).send(renderOAuthPage({
        provider: 'trakt',
        status: 'error',
        title: 'Connection expired',
        message: 'The secure authorization state is missing, invalid, or expired. Please start again.',
        retryHref: '/api/auth/trakt/authorize',
      }));
    }

    if (pendingTraktExchanges.has(code)) {
      consola.info(`[Trakt OAuth] Duplicate callback for code ${code.substring(0, 8)}... — waiting on existing exchange`);
      try {
        await pendingTraktExchanges.get(code);

        return res.send(renderOAuthPage({
          provider: 'trakt',
          status: 'info',
          title: 'Connection in progress',
          message: 'Your Trakt authorization is already being processed. You can close this window and check the original tab.',
        }));
      } catch {
        return res.status(500).send(renderOAuthPage({
          provider: 'trakt',
          status: 'error',
          title: 'Connection failed',
          message: 'Trakt could not complete the token exchange. Please start the connection again.',
          retryHref: '/api/auth/trakt/authorize',
        }));
      }
    }

    const clientId = process.env.TRAKT_CLIENT_ID;
    const redirectUri = normalizeRedirectUri(
      process.env.TRAKT_REDIRECT_URI || `${process.env.HOST_NAME}/api/auth/trakt/callback`
    );

    if (!clientId || !clientSecret) {
      return res.status(500).send(renderOAuthPage({
        provider: 'trakt',
        status: 'warning',
        title: 'Trakt is not configured',
        message: 'This server is missing the credentials required to connect a Trakt account.',
      }));
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
        return res.status(429).send(renderOAuthPage({
          provider: 'trakt',
          status: 'warning',
          title: 'Trakt is temporarily busy',
          message: 'The Trakt API is rate-limiting new connections. Wait a moment, then try again.',
          detail: `Estimated wait: ${waitSeconds} seconds.`,
          retryHref: '/api/auth/trakt/authorize',
        }));
      }

      return res.status(500).send(renderOAuthPage({
        provider: 'trakt',
        status: 'error',
        title: 'Connection failed',
        message: 'The authorization code could not be exchanged for a Trakt token. Please try again.',
        retryHref: '/api/auth/trakt/authorize',
      }));
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
      return res.status(500).send(renderOAuthPage({
        provider: 'trakt',
        status: 'error',
        title: 'Token could not be saved',
        message: 'Trakt authorized the connection, but this server could not store the token. Please try again.',
        retryHref: '/api/auth/trakt/authorize',
      }));
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

    res.send(renderOAuthPage({
      provider: 'trakt',
      status: 'success',
      title: 'Trakt connected',
      message: 'Authorization is complete. Copy the token ID and paste it into the Trakt integration settings.',
      username: user.username,
      tokenId,
    }));

  } catch (error) {
    consola.error("[Trakt OAuth] Unexpected callback error:", error);
    res.status(500).send(renderOAuthPage({
      provider: 'trakt',
      status: 'error',
      title: 'Something went wrong',
      message: 'An unexpected error interrupted the Trakt connection. Please try again.',
      retryHref: '/api/auth/trakt/authorize',
    }));
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
    const response: any = { provider: token.provider, username: token.user_id, expiresAt: token.expires_at };
    if (token.provider === 'trakt') {
      try {
        const { isTokenInvalidated } = require('./utils/traktUtils');
        if (isTokenInvalidated(tokenId)) {
          response.status = 'invalid';
          response.statusMessage = 'Your Trakt refresh token has expired or been revoked. Please disconnect and reconnect your account.';
        }
      } catch {}
    }
    res.json(response);
  } catch (error) {
    consola.error("[OAuth] Token info fetch error:", error);
    res.status(500).json({ error: "Failed to fetch token info" });
  }
});

// --- MovieLens Connect ---
addon.post("/api/auth/movielens/connect", async (req, res) => {
  try {
    const { userName, password } = req.body || {};
    if (!userName || !password) {
      return res.status(400).json({ error: "userName and password are required" });
    }
    if (!process.env.MOVIELENS_CRED_KEY) {
      return res.status(500).json({ error: "MovieLens is not configured on this server (MOVIELENS_CRED_KEY is missing)." });
    }
    const credId = await movielens.connect(userName, password);
    consola.info(`[MovieLens] Connected account ${userName} (cred ${credId})`);
    res.json({ success: true, credId, userName });
  } catch (error) {
    if (error instanceof movielens.MovieLensAuthError) {
      return res.status(401).json({ error: "MovieLens rejected the username or password." });
    }
    consola.error("[MovieLens] Connect error:", error);
    res.status(500).json({ error: "Could not connect to MovieLens. Please try again." });
  }
});

// --- MovieLens Sync / Bootstrap ---
addon.post("/api/movielens/sync/:userUUID", async (req, res) => {
  try {
    const { userUUID } = req.params;
    const { password, full, credId: bodyCredId } = req.body || {};
    const access = await resolveConfigAccess(req, userUUID, password);
    if (!access) {
      return res.status(401).json({ error: "Invalid UUID or password" });
    }
    const config = access.config;
    if (!config.apiKeys?.movieLensCredId && bodyCredId) {
      const credRow = await database.getOAuthToken(bodyCredId);
      if (credRow && credRow.provider === 'movielens') {
        config.apiKeys = { ...config.apiKeys, movieLensCredId: bodyCredId };
      }
    }
    if (!config.apiKeys?.movieLensCredId) {
      return res.status(400).json({ error: "No MovieLens account is connected." });
    }
    const cooldownSeconds = parseInt(process.env.MOVIELENS_MANUAL_SYNC_COOLDOWN_SECONDS || '21600', 10);
    const movielensSync = require('./lib/movielensSync');
    const result = await movielensSync.syncMovieLensAccount(config, { full: !!full, cooldownSeconds });
    if (!result.ok) {
      if (result.reason === 'cooldown') {
        return res.status(429).json({
          error: "You've synced recently. Please try again later.",
          nextAllowedInSeconds: result.nextAllowedInSeconds,
        });
      }
      return res.status(400).json({ error: `MovieLens sync could not run (${result.reason || 'unknown'}).` });
    }
    consola.info(`[MovieLens] Sync for ${userUUID}: sent ${result.sent || 0} ratings, MovieLens reports ${result.successCount || 0} new`);
    res.json(result);
  } catch (error) {
    if (error instanceof movielens.MovieLensAuthError) {
      return res.status(401).json({ error: "Your MovieLens session could not be refreshed. Please reconnect your account." });
    }
    consola.error("[MovieLens] Sync error:", error);
    res.status(500).json({ error: "MovieLens sync failed. Please try again." });
  }
});

addon.post("/api/movielens/lists/:userUUID", async (req, res) => {
  try {
    const { userUUID } = req.params;
    const { password } = req.body || {};
    const access = await resolveConfigAccess(req, userUUID, password);
    if (!access) {
      return res.status(401).json({ error: "Invalid UUID or password" });
    }
    const credId = access.config.apiKeys?.movieLensCredId;
    if (!credId) {
      return res.status(400).json({ error: "No MovieLens account is connected." });
    }
    const lists = await movielens.getLists(credId);
    res.json({ lists: Array.isArray(lists) ? lists : [] });
  } catch (error) {
    if (error instanceof movielens.MovieLensAuthError) {
      return res.status(401).json({ error: "Your MovieLens session could not be refreshed. Please reconnect your account." });
    }
    consola.error("[MovieLens] Lists error:", error);
    res.status(500).json({ error: "Could not fetch MovieLens lists." });
  }
});

// Saves a new Simkl access token and returns the token ID the user pastes into
// their config. Used by both the OAuth callback and the PIN flow.
async function persistSimklToken(user, accessToken) {
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
    saved = await database.updateOAuthToken(tokenId, accessToken, '', 0);
  } else {
    // Create new token
    tokenId = crypto.randomUUID();
    consola.info(`[Simkl OAuth] Creating new token - tokenId: ${tokenId}, user: ${user.username}`);

    saved = await database.saveOAuthToken(tokenId, 'simkl', user.username, accessToken, '', 0, '');
  }

  if (!saved) {
    return null;
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

  return tokenId;
}

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
    
    const state = createSimklOAuthState(clientSecret, SIMKL_OAUTH_STATE_TTL_MS);
    const authUrl = simklClient.getAuthorizationUrl(state);
    
    res.redirect(authUrl);
  } catch (error) {
    consola.error("[Simkl OAuth] Authorization error:", error);
    res.status(500).json({ error: "Failed to initiate Simkl authorization" });
  }
});

addon.get("/api/auth/simkl/callback", async (req, res) => {
  try {
    const codeParam = Array.isArray(req.query.code) ? req.query.code[0] : req.query.code;
    const stateParam = Array.isArray(req.query.state) ? req.query.state[0] : req.query.state;
    const code = typeof codeParam === 'string' ? codeParam : '';
    const state = typeof stateParam === 'string' ? stateParam : '';
    
    if (!code) {
      return res.status(400).send(renderOAuthPage({
        provider: 'simkl',
        status: 'error',
        title: 'Authorization incomplete',
        message: 'Simkl did not return an authorization code. Please start the connection again.',
        retryHref: '/api/auth/simkl/authorize',
      }));
    }
    
    const clientId = process.env.SIMKL_CLIENT_ID;
    const clientSecret = process.env.SIMKL_CLIENT_SECRET;
    const redirectUri = normalizeRedirectUri(process.env.SIMKL_REDIRECT_URI || `${process.env.HOST_NAME}/api/auth/simkl/callback`);
    
    if (!clientId || !clientSecret) {
      return res.status(500).send(renderOAuthPage({
        provider: 'simkl',
        status: 'warning',
        title: 'Simkl is not configured',
        message: 'This server is missing the credentials required to connect a Simkl account.',
      }));
    }

    if (!verifySimklOAuthState(state, clientSecret)) {
      return res.status(400).send(renderOAuthPage({
        provider: 'simkl',
        status: 'error',
        title: 'Connection expired',
        message: 'The secure authorization state is missing, invalid, or expired. Please start again.',
        retryHref: '/api/auth/simkl/authorize',
      }));
    }
    
    const simklClient = new SimklClient(clientId, clientSecret, redirectUri);
    
    // Exchange code for tokens (Simkl tokens never expire)
    const tokens = await simklClient.exchangeCodeForToken(code);
    
    // Get user info
    const user = await simklClient.getMe(tokens.access_token);
    
    const tokenId = await persistSimklToken(user, tokens.access_token);
    
    if (!tokenId) {
      return res.status(500).send(renderOAuthPage({
        provider: 'simkl',
        status: 'error',
        title: 'Token could not be saved',
        message: 'Simkl authorized the connection, but this server could not store the token. Please try again.',
        retryHref: '/api/auth/simkl/authorize',
      }));
    }

    res.send(renderOAuthPage({
      provider: 'simkl',
      status: 'success',
      title: 'Simkl connected',
      message: 'Authorization is complete. Copy the token ID and paste it into the Simkl integration settings.',
      username: user.username,
      tokenId,
    }));
  } catch (error) {
    consola.error("[Simkl OAuth] Callback error:", error);
    res.status(500).send(renderOAuthPage({
      provider: 'simkl',
      status: 'error',
      title: 'Something went wrong',
      message: 'An unexpected error interrupted the Simkl connection. Please try again.',
      retryHref: '/api/auth/simkl/authorize',
    }));
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
    
    // `removed` says exactly what this disconnect took out, so a page holding
    // unsaved edits can apply the same removals instead of adopting the whole
    // saved document and losing them.
    res.json({ success: true, config, removed: { apiKeys: ['traktTokenId'], fields: ['traktUser', 'traktWatchTracking'], catalogIdPrefix: 'trakt.' } });
  } catch (error) {
    consola.error("[Trakt] Disconnect error:", error);
    res.status(500).json({ error: "Failed to disconnect Trakt" });
  }
});

// Drops a pending session so a cancelled code doesn't linger until it expires.
// Knowing the session id is the only thing needed, same as polling it.
async function handleDeviceAuthCancel(req, res, provider) {
  try {
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
    const session = await getDeviceAuthSession(sessionId, provider);
    if (session) {
      await deleteDeviceAuthSession(sessionId);
    }
    res.json({ cancelled: !!session });
  } catch (error) {
    consola.error(`[${provider}] Failed to cancel the authorization session:`, error);
    res.status(500).json({ error: "Failed to cancel the authorization" });
  }
}

// --- Simkl PIN (device) Routes ---
// No client secret and no reachable callback URL needed, so these work on
// private instances where the OAuth flow can't.
addon.post("/api/auth/simkl/pin", deviceAuthPollRateLimitMiddleware, async (req, res) => {
  try {
    if (!simklPinEnabled()) {
      return res.status(404).json({ error: "Simkl PIN authentication is not enabled on this instance." });
    }

    const clientId = getSetting('SIMKL_CLIENT_ID');
    if (!clientId) {
      return res.status(500).json({ error: "Simkl is not configured. Please set the SIMKL_CLIENT_ID environment variable." });
    }

    const simklClient = new SimklClient(clientId);
    const pin = await simklClient.requestPin();

    const sessionId = createSessionId();
    const expiresAt = Date.now() + pin.expires_in * 1000;
    await saveDeviceAuthSession(sessionId, {
      provider: 'simkl',
      userCode: pin.user_code,
      expiresAt,
      pollIntervalMs: pin.interval * 1000,
      lastPolledAt: 0,
    });

    res.json({
      sessionId,
      userCode: pin.user_code,
      verificationUrl: pin.verification_url,
      interval: pin.interval,
      expiresIn: pin.expires_in,
    });
  } catch (error) {
    consola.error("[Simkl PIN] Failed to request a PIN:", error);
    res.status(500).json({ error: "Failed to request a Simkl PIN" });
  }
});

addon.get("/api/auth/simkl/pin/status", deviceAuthPollRateLimitMiddleware, async (req, res) => {
  try {
    if (!simklPinEnabled()) {
      return res.status(404).json({ error: "Simkl PIN authentication is not enabled on this instance." });
    }

    const clientId = getSetting('SIMKL_CLIENT_ID');
    if (!clientId) {
      return res.status(500).json({ error: "Simkl is not configured. Please set the SIMKL_CLIENT_ID environment variable." });
    }

    const sessionIdParam = Array.isArray(req.query.sessionId) ? req.query.sessionId[0] : req.query.sessionId;
    const sessionId = typeof sessionIdParam === 'string' ? sessionIdParam : '';

    // The session id stays in the browser that started the flow, so guessing the
    // short user code isn't enough to claim the token.
    const session = await getDeviceAuthSession(sessionId, 'simkl');
    if (!session) {
      return res.status(404).json({ status: 'expired' });
    }

    // Simkl asks callers to respect the interval it handed out, so polls that
    // arrive early are answered without bothering it.
    if (!await registerPoll(sessionId, session)) {
      return res.json({ status: 'pending' });
    }

    const simklClient = new SimklClient(clientId);
    const poll = await simklClient.pollPin(session.userCode);

    if (poll.status === 'pending') {
      return res.json({ status: 'pending' });
    }

    if (poll.status === 'slow_down') {
      await widenPollInterval(sessionId, session);
      return res.json({ status: 'slow_down' });
    }

    if (poll.status === 'expired') {
      await deleteDeviceAuthSession(sessionId);
      return res.json({ status: 'expired' });
    }

    const user = await simklClient.getMe(poll.access_token);
    const tokenId = await persistSimklToken(user, poll.access_token);

    if (!tokenId) {
      // Session left in place: storing the token is the only thing that failed,
      // so the next poll can try again rather than making the user start over.
      return res.status(500).json({ error: "Simkl authorized the connection, but this server could not store the token." });
    }

    await deleteDeviceAuthSession(sessionId);

    consola.info(`[Simkl PIN] Connected user ${user.username} - tokenId: ${tokenId}`);
    res.json({ status: 'authorized', tokenId, username: user.username });
  } catch (error) {
    consola.error("[Simkl PIN] Status check failed:", error);
    res.status(500).json({ error: "Failed to check the Simkl PIN status" });
  }
});

addon.post("/api/auth/simkl/pin/cancel", async (req, res) => {
  await handleDeviceAuthCancel(req, res, 'simkl');
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
    
    // `removed` says exactly what this disconnect took out, so a page holding
    // unsaved edits can apply the same removals instead of adopting the whole
    // saved document and losing them.
    res.json({ success: true, config, removed: { apiKeys: ['simklTokenId'], fields: ['simklUser', 'simklWatchTracking'], catalogIdPrefix: 'simkl.' } });
  } catch (error) {
    consola.error("[Simkl] Disconnect error:", error);
    res.status(500).json({ error: "Failed to disconnect Simkl" });
  }
});


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
const { envInt } = require('./utils/envNumber');

/** Read per call so a dashboard change lands without a restart. */
function mdblistListCacheTtl() {
  return envInt('MDBLIST_LIST_CACHE_TTL', 30 * 60, 0);
}

/** Keyed per key rather than globally: without a username MDBList returns the caller's own lists. */
/** The instance key stands in when the caller sends none, same as the catalog paths. */
addon.get("/api/mdblist/lists/user", async (req, res) => {
  try {
    const { username, sort } = req.query;
    const apikey = resolveMdblistKey(req.query.apikey);
    
    if (!apikey) {
      return res.status(400).json({ error: "apikey is required" });
    }
    
    let url = username 
      ? `https://api.mdblist.com/lists/user/${username}?apikey=${apikey}`
      : `https://api.mdblist.com/lists/user?apikey=${apikey}`;
    
    if (sort) {
      url += `&sort=${sort}`;
    }
    
    const payload = await cacheWrapGlobal(
      mdblistCacheKey(['lists', 'user', username || '~self', sort || 'default'], apikey),
      async () => {
        const response = await makeRateLimitedMDBListRequest(url, apikey, 'MDBList Proxy - Get User Lists');
        return response.data;
      },
      mdblistListCacheTtl()
    );
    res.json(payload);
  } catch (error) {
    consola.error("[MDBList Proxy] Error fetching user lists:", error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message || "Failed to fetch user lists" });
  }
});

// Proxy: Search public lists by name, ordered by popularity
addon.get("/api/mdblist/lists/search", async (req, res) => {
  try {
    const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
    if (!query) {
      return res.status(400).json({ error: "query is required" });
    }

    const apikey = resolveMdblistKey(req.query.apikey);
    if (!apikey) {
      return res.status(400).json({ error: "apikey is required" });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const url = `https://api.mdblist.com/lists/search?apikey=${apikey}&query=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`;

    const payload = await cacheWrapGlobal(
      mdblistCacheKey(['lists', 'search', query.toLowerCase(), String(limit), String(offset)], apikey),
      async () => {
        const response = await makeRateLimitedMDBListRequest(url, apikey, 'MDBList Proxy - Search Lists');
        return {
          results: Array.isArray(response.data) ? response.data : [],
          hasMore: String(response.headers?.['x-has-more'] ?? '').toLowerCase() === 'true',
          totalItems: parseInt(response.headers?.['x-total-items'], 10) || 0,
        };
      },
      mdblistListCacheTtl()
    );
    res.json(payload);
  } catch (error) {
    consola.error("[MDBList Proxy] Error searching lists:", error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message || "Failed to search lists" });
  }
});

// Proxy: Get top lists
addon.get("/api/mdblist/lists/top", async (req, res) => {
  try {
    const apikey = resolveMdblistKey(req.query.apikey);
    
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

// Proxy: Get a list's items, poster URLs included.
// Declared above /:username/:listname, which would otherwise swallow this path.
addon.get("/api/mdblist/lists/:listId/items", async (req, res) => {
  try {
    const { listId } = req.params;
    const { limit } = req.query;
    const apikey = resolveMdblistKey(req.query.apikey);

    if (!apikey) {
      return res.status(400).json({ error: "apikey is required" });
    }

    const params = new URLSearchParams({ apikey, append_to_response: 'poster' });
    const parsedLimit = Number.parseInt(limit, 10);
    if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
      params.set('limit', String(Math.min(parsedLimit, 50)));
    }

    const url = `https://api.mdblist.com/lists/${listId}/items?${params.toString()}`;
    const items = await cacheWrapGlobal(
      mdblistCacheKey(['list', String(listId), 'items', params.get('limit') || 'all'], apikey),
      async () => {
        const response = await makeRateLimitedMDBListRequest(url, apikey, `MDBList Proxy - Get List Items ${listId}`);
        const payload = response.data || {};
        return [...(payload.movies || []), ...(payload.shows || [])].map(item => ({
          id: item.id,
          title: item.title,
          mediatype: item.mediatype,
          poster: item.poster || null,
        }));
      },
      mdblistListCacheTtl()
    );

    res.json({ items });
  } catch (error) {
    consola.error("[MDBList Proxy] Error fetching list items:", error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: error.message || "Failed to fetch list items" });
  }
});

// Proxy: Get list details by username/listname
addon.get("/api/mdblist/lists/:username/:listname", async (req, res) => {
  try {
    const { username, listname } = req.params;
    const apikey = resolveMdblistKey(req.query.apikey);
    
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
    const apikey = resolveMdblistKey(req.query.apikey);
    
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
        error: "TMDB API key is required (config.apiKeys.tmdb, TMDB_API_KEY, or BUILT_IN_TMDB_API_KEY)"
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
        error: "TMDB API key is required (config.apiKeys.tmdb, TMDB_API_KEY, or BUILT_IN_TMDB_API_KEY)"
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
        error: "TMDB API key is required (config.apiKeys.tmdb, TMDB_API_KEY, or BUILT_IN_TMDB_API_KEY)"
      });
    }

    if (!query || !String(query).trim()) {
      return res.status(400).json({ error: "query is required" });
    }

    // TMDB has no /search/network endpoint; resolve from the daily export index instead
    if (entity === 'network') {
      const { searchTmdbNetworks } = require('./lib/tmdb-network-index');
      const networks = await searchTmdbNetworks(String(query).trim(), 25);
      return res.json({ entity, results: networks.map(n => ({ id: n.id, name: n.label })) });
    }

    const endpointMap = {
      person: '/search/person',
      company: '/search/company',
      keyword: '/search/keyword'
    };

    const endpoint = endpointMap[entity];
    if (!endpoint) {
      return res.status(400).json({ error: "entity must be one of: person, company, keyword, network" });
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


async function buildTvdbListConfig(req, res) {
  const tvdbApiKey = await resolveTvdbDiscoverApiKey(req);
  if (!tvdbApiKey) {
    res.status(400).json({ error: "TVDB API key is required (config.apiKeys.tvdb, TVDB_API_KEY, or BUILT_IN_TVDB_API_KEY)" });
    return null;
  }
  const userUUID = typeof req.query.userUUID === 'string' && req.query.userUUID.trim()
    ? req.query.userUUID.trim()
    : undefined;
  return { apiKeys: { tvdb: tvdbApiKey }, ...(userUUID ? { userUUID } : {}) };
}

// Proxy: browse TheTVDB lists, one page at a time
addon.get("/api/tvdb/lists", async (req, res) => {
  try {
    const tvdbConfig = await buildTvdbListConfig(req, res);
    if (!tvdbConfig) return;

    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    const results = await cacheWrapGlobal(
      `tvdb:lists:browse:v2:${page}`,
      async () => {
        const records = await tvdbApi.getCollectionsList(tvdbConfig, page);
        const normalized = (Array.isArray(records) ? records : []).map(normalizeTvdbListRecord).filter(Boolean);
        return enrichTvdbListRecords(normalized, tvdbConfig);
      },
      6 * 60 * 60
    );

    return res.json({ page, results });
  } catch (error) {
    consola.error("[TVDB Lists] Error browsing lists:", error.message);
    const status = error.response?.status || 500;
    return res.status(status).json({ error: error.message || "Failed to browse TVDB lists" });
  }
});

// Proxy: search TheTVDB lists by name
addon.get("/api/tvdb/lists/search", async (req, res) => {
  try {
    const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
    if (!query) {
      return res.status(400).json({ error: "query is required" });
    }

    const tvdbConfig = await buildTvdbListConfig(req, res);
    if (!tvdbConfig) return;

    const results = await cacheWrapGlobal(
      `tvdb:lists:search:v3:${query.toLowerCase()}`,
      async () => {
        const records = await tvdbApi.searchCollections(query, tvdbConfig);
        const normalized = (Array.isArray(records) ? records : []).map(normalizeTvdbListRecord).filter(Boolean).slice(0, 40);
        const enriched = await enrichTvdbListRecords(normalized, tvdbConfig);
        // thetvdb.com only surfaces official lists, so match that ranking rather
        // than the search index order, which buries them among unpublished ones.
        return enriched.sort((a, b) =>
          (Number(b.isOfficial) - Number(a.isOfficial)) || (b.itemCount - a.itemCount)
        );
      },
      60 * 60
    );

    return res.json({ query, results });
  } catch (error) {
    consola.error("[TVDB Lists] Error searching lists:", error.message);
    const status = error.response?.status || 500;
    return res.status(status).json({ error: error.message || "Failed to search TVDB lists" });
  }
});

// Proxy: resolve a list id, slug or thetvdb.com URL into a previewable record
addon.get("/api/tvdb/lists/resolve", async (req, res) => {
  try {
    const raw = typeof req.query.input === 'string' ? req.query.input.trim() : '';
    if (!raw) {
      return res.status(400).json({ error: "input is required" });
    }

    const tvdbConfig = await buildTvdbListConfig(req, res);
    if (!tvdbConfig) return;

    const urlMatch = raw.match(/thetvdb\.com\/lists\/([^/?#]+)/i);
    const candidate = urlMatch ? decodeURIComponent(urlMatch[1]) : raw;

    const preview = await cacheWrapGlobal(
      `tvdb:lists:resolve:v3:${candidate.toLowerCase()}`,
      async () => {
        // A slug can be all digits and still not be an id: list 1 has the slug "1001".
        const base = await tvdbApi.getCollectionBySlug(candidate, tvdbConfig);
        const listId = base?.id
          ? String(base.id)
          : (/^\d+$/.test(candidate) ? candidate : null);
        if (!listId) return null;

        const details = await tvdbApi.getCollectionDetails(listId, tvdbConfig);
        if (!details?.id) return null;

        const entities = Array.isArray(details.entities) ? details.entities : [];
        const movieCount = entities.filter(e => e?.movieId).length;
        const seriesCount = entities.filter(e => e?.seriesId).length;

        return {
          ...normalizeTvdbListRecord({ ...base, ...details }),
          movieCount,
          seriesCount,
          itemCount: movieCount + seriesCount
        };
      },
      6 * 60 * 60
    );

    if (!preview) {
      return res.status(404).json({ error: "No TheTVDB list matched that id or slug" });
    }

    return res.json(preview);
  } catch (error) {
    consola.error("[TVDB Lists] Error resolving list:", error.message);
    const status = error.response?.status || 500;
    return res.status(status).json({ error: error.message || "Failed to resolve TVDB list" });
  }
});

function normalizeTmdbCollection(record) {
  const id = Number(record?.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    name: record?.name || `Collection ${id}`,
    overview: record?.overview || '',
    poster: record?.poster_path ? `https://image.tmdb.org/t/p/w342${record.poster_path}` : '',
    backdrop: record?.backdrop_path ? `https://image.tmdb.org/t/p/w780${record.backdrop_path}` : '',
    url: `https://www.themoviedb.org/collection/${id}`
  };
}

// Proxy: search TMDB collections by name
addon.get("/api/tmdb/collections/search", async (req, res) => {
  try {
    const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
    if (!query) {
      return res.status(400).json({ error: "query is required" });
    }
    const apikey = await resolveTmdbDiscoverApiKey(req);
    if (!apikey) {
      return res.status(400).json({ error: "TMDB API key is required" });
    }

    const language = typeof req.query.language === 'string' && req.query.language.trim()
      ? req.query.language.trim()
      : 'en-US';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const data = await moviedb.searchCollection({ query, page, language }, { apiKeys: { tmdb: apikey } });
    const results = (data?.results || []).map(normalizeTmdbCollection).filter(Boolean);

    return res.json({ query, page, totalPages: data?.total_pages || 1, totalResults: data?.total_results || 0, results });
  } catch (error) {
    consola.error("[TMDB Collections] Error searching:", error.message);
    const status = error.response?.status || 500;
    return res.status(status).json({ error: error.message || "Failed to search TMDB collections" });
  }
});

// Proxy: resolve a collection id or themoviedb.org/collection URL into a previewable record
addon.get("/api/tmdb/collections/resolve", async (req, res) => {
  try {
    const raw = typeof req.query.input === 'string' ? req.query.input.trim() : '';
    if (!raw) {
      return res.status(400).json({ error: "input is required" });
    }
    const apikey = await resolveTmdbDiscoverApiKey(req);
    if (!apikey) {
      return res.status(400).json({ error: "TMDB API key is required" });
    }

    const urlMatch = raw.match(/themoviedb\.org\/collection\/(\d+)/i);
    const collectionId = urlMatch ? urlMatch[1] : (/^\d+/.test(raw) ? raw.match(/^\d+/)[0] : null);
    if (!collectionId) {
      return res.status(400).json({ error: "Enter a collection id or a themoviedb.org/collection link" });
    }

    const language = typeof req.query.language === 'string' && req.query.language.trim()
      ? req.query.language.trim()
      : 'en-US';

    const collection = await moviedb.collectionInfo({ id: collectionId, language }, { apiKeys: { tmdb: apikey } });
    if (!collection?.id) {
      return res.status(404).json({ error: "No TMDB collection matched that id" });
    }

    const parts = Array.isArray(collection.parts) ? collection.parts : [];
    const dated = parts.filter(p => p?.release_date).map(p => p.release_date).sort();

    return res.json({
      ...normalizeTmdbCollection(collection),
      itemCount: parts.length,
      undatedCount: parts.length - dated.length,
      firstRelease: dated[0] || null,
      lastRelease: dated[dated.length - 1] || null
    });
  } catch (error) {
    consola.error("[TMDB Collections] Error resolving:", error.message);
    const status = error.response?.status || 500;
    return res.status(status).json({ error: error.message || "Failed to resolve TMDB collection" });
  }
});

// AI-powered catalog creation
const aiCatalogRateLimit = new Map();
addon.post("/api/ai/create-catalog", async (req, res) => {
  try {
    const { userUUID, password, query, provider, generationMode, model: requestedModel, geminiKey: clientGeminiKey, openrouterKey: clientOpenrouterKey } = req.body;

    if (!userUUID) {
      return res.status(400).json({ error: 'User UUID is required' });
    }
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'Query is required' });
    }
    const allowedGenerationModes = new Set(['auto', 'tmdb', 'anilist', 'mal', 'tvdb', 'simkl']);
    if (!allowedGenerationModes.has(generationMode)) {
      return res.status(400).json({ error: 'generationMode must be one of: auto, tmdb, anilist, mal, tvdb' });
    }

    // Rate limit: 5 requests per minute per user
    const now = Date.now();
    const userRateKey = `ai-catalog:${userUUID}`;
    const userRequests = aiCatalogRateLimit.get(userRateKey) || [];
    const recentRequests = userRequests.filter(t => now - t < 60000);
    if (recentRequests.length >= 5) {
      return res.status(429).json({ error: 'Too many requests. Please wait a moment before trying again.' });
    }
    recentRequests.push(now);
    aiCatalogRateLimit.set(userRateKey, recentRequests);

    // Authenticate
    const access = await resolveConfigAccess(req, userUUID, password);
    if (!access) {
      return res.status(401).json({ error: 'Invalid UUID or password' });
    }
    const config = access.config;

    const openrouterKey = config.apiKeys?.openrouter || clientOpenrouterKey;
    const geminiKey = config.apiKeys?.gemini || clientGeminiKey || process.env.BUILT_IN_GEMINI_API_KEY;
    if (!openrouterKey && !geminiKey) {
      return res.status(400).json({ error: 'No AI API key configured. Add an OpenRouter or Gemini key in your settings.' });
    }

    const { buildCatalogCreationPrompt, parseCatalogAIResponse, normalizeCatalog, validateCatalogParams, resolveEntities, buildCatalogConfigs } = require('./utils/ai-catalog-service');
    const hasTmdb = !!(config.apiKeys?.tmdb || process.env.TMDB_API_KEY || process.env.TMDB_API || process.env.BUILT_IN_TMDB_API_KEY);
    const hasTvdb = !!(config.apiKeys?.tvdb || process.env.TVDB_API_KEY || process.env.BUILT_IN_TVDB_API_KEY);
    const hasSimkl = !!process.env.SIMKL_CLIENT_ID;
    if (generationMode === 'tmdb' && !hasTmdb) {
      return res.status(400).json({ error: 'TMDB catalog generation requires a TMDB API key.' });
    }
    if (generationMode === 'tvdb' && !hasTvdb) {
      return res.status(400).json({ error: 'TVDB catalog generation requires a TVDB API key.' });
    }
    const { systemPrompt, userPrompt } = buildCatalogCreationPrompt(query.trim(), {
      mode: generationMode,
      keys: { tmdb: hasTmdb, tvdb: hasTvdb, simkl: hasSimkl },
    });

    let rawText = null;
    const useOpenRouter = provider === 'gemini' ? (!geminiKey && !!openrouterKey) : !!openrouterKey;
    const { resolveCatalogModel } = require('./utils/ai-model-resolver');
    const activeProvider = useOpenRouter ? 'openrouter' : 'gemini';
    const model = resolveCatalogModel({ config, provider: activeProvider, requestedModel });

    if (useOpenRouter) {
      const { generateContent } = require('./utils/openrouter-client');
      const result = await generateContent({
        apiKey: openrouterKey,
        model,
        prompt: userPrompt,
        systemPrompt,
        timeout: 45000,
      });
      rawText = result.text;
    } else {
      const { generateContent } = require('./utils/gemini-client');
      const result = await generateContent({
        apiKey: geminiKey,
        model,
        prompt: userPrompt,
        systemPrompt,
        timeout: 45000,
      });
      rawText = result.text;
    }

    if (!rawText) {
      return res.status(500).json({ error: 'AI returned an empty response. Please try again.' });
    }

    aiCatalogLogger.debug(`Raw response: ${rawText.substring(0, 500)}`);

    const parsed = parseCatalogAIResponse(rawText);
    if (!parsed || !parsed.catalogs.length) {
      return res.status(422).json({ error: 'AI returned an invalid response. Try again or rephrase your request.' });
    }
    if (generationMode !== 'auto') {
      const filteredCatalogs = parsed.catalogs.filter(catalog => catalog.source === generationMode);
      if (filteredCatalogs.length === 0) {
        return res.status(422).json({ error: `AI did not return a ${generationMode.toUpperCase()} catalog. Try again or switch to Auto.` });
      }
      if (filteredCatalogs.length !== parsed.catalogs.length) {
        parsed.warnings = [
          ...(parsed.warnings || []),
          `Ignored ${parsed.catalogs.length - filteredCatalogs.length} catalog${parsed.catalogs.length - filteredCatalogs.length === 1 ? '' : 's'} that did not match ${generationMode.toUpperCase()} mode`,
        ];
        parsed.catalogs = filteredCatalogs;
      }
    }

    // Normalize and validate each catalog
    const validCatalogs = [];
    const userWarnings = [];
    const userWarningSet = new Set();
    const addUserWarning = (message) => {
      if (!message || userWarningSet.has(message)) return;
      userWarningSet.add(message);
      userWarnings.push(message);
    };
    const visibleWarnings = () => {
      const visible = userWarnings.slice(0, 3);
      const omitted = userWarnings.length - visible.length;
      if (omitted > 0) {
        visible.push(`${omitted} more warning${omitted === 1 ? '' : 's'} omitted`);
      }
      return visible;
    };

    for (const warning of parsed.warnings || []) {
      addUserWarning(warning);
    }

    for (const catalog of parsed.catalogs) {
      const normalizeDiagnostics = normalizeCatalog(catalog, { originalQuery: query.trim() });
      if (normalizeDiagnostics?.length) {
        aiCatalogLogger.debug(`Normalized "${catalog.name || 'unnamed'}": ${normalizeDiagnostics.join('; ')}`);
      }
      if (catalog.source === 'tmdb' && !hasTmdb) {
        addUserWarning(`Skipped "${catalog.name || 'unnamed'}": no TMDB API key configured`);
        continue;
      }
      if (catalog.source === 'tvdb' && !hasTvdb) {
        addUserWarning(`Skipped "${catalog.name || 'unnamed'}": no TVDB API key configured`);
        continue;
      }
      if (catalog.source === 'simkl' && !hasSimkl) {
        addUserWarning(`Skipped "${catalog.name || 'unnamed'}": no Simkl client ID configured`);
        continue;
      }
      const validation = validateCatalogParams(catalog);
      if (validation.valid) {
        validCatalogs.push(catalog);
      } else {
        addUserWarning(`Skipped "${catalog.name || 'unnamed'}": invalid configuration`);
        aiCatalogLogger.debug(`Validation failed for catalog: ${JSON.stringify(validation.errors)}`);
      }
    }

    if (validCatalogs.length === 0) {
      const warnings = visibleWarnings();
      return res.status(422).json({ error: 'AI generated invalid configurations. Try a more specific request.', warnings: warnings.length ? warnings : undefined });
    }

    // Resolve dynamic entities
    const tmdbApiKey = config.apiKeys?.tmdb || process.env.TMDB_API_KEY || process.env.TMDB_API || process.env.BUILT_IN_TMDB_API_KEY || '';
    const tvdbApiKey = config.apiKeys?.tvdb || process.env.TVDB_API_KEY || process.env.BUILT_IN_TVDB_API_KEY || '';
    const resolveCtx = { tmdbApiKey, tvdbApiKey, userUUID };
    aiCatalogLogger.info(`Resolving entities. TMDB key: ${tmdbApiKey ? '...' + tmdbApiKey.slice(-4) : 'NONE'}, TVDB key: ${tvdbApiKey ? '...' + tvdbApiKey.slice(-4) : 'NONE'}, Simkl client ID: ${hasSimkl ? 'SET' : 'NONE'}, Generation mode: ${generationMode}, Prompt sources: TMDB=${hasTmdb}, TVDB=${hasTvdb}, Simkl=${hasSimkl}`);

    const resolvedParams = [];
    const perCatalogWarnings = [];
    for (const catalog of validCatalogs) {
      try {
        const { resolved, warnings: resolveWarnings } = await resolveEntities(catalog, resolveCtx);
        aiCatalogLogger.info(`Resolved for "${catalog.name}": ${JSON.stringify(resolved)}`);
        resolvedParams.push(resolved);
        if (resolveWarnings.length) {
          aiCatalogLogger.debug(`Resolve warnings for "${catalog.name}": ${resolveWarnings.join('; ')}`);
          addUserWarning('Some requested filters could not be resolved and were omitted');
        }
      } catch (e) {
        aiCatalogLogger.error(`Entity resolution error: ${e.message}`);
        resolvedParams.push({});
        perCatalogWarnings.push([]);
      }
    }

    // Build final catalog configs
    const catalogConfigs = buildCatalogConfigs(validCatalogs, resolvedParams, query.trim(), config.catalogTTL, perCatalogWarnings);

    const warnings = visibleWarnings();
    return res.json({ catalogs: catalogConfigs, warnings: warnings.length ? warnings : undefined });
  } catch (error) {
    aiCatalogLogger.error("Error:", error.message);
    if (error.statusCode === 429) {
      return res.status(429).json({ error: 'AI provider rate limited. Please wait and try again.' });
    }
    return res.status(500).json({ error: error.message || 'Failed to create AI catalog' });
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
      poster_path: item.images?.jpg?.large_image_url || item.images?.webp?.image_url || item.images?.jpg?.image_url || null,
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
    const apiKey = params.apikey || process.env.MDBLIST_API_KEY || process.env.BUILT_IN_MDBLIST_API_KEY || '';
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

// GET /api/flixpatrol/availability - Precomputed map of valid (service, country)
// combos so the config UI can filter its dropdowns without probing each pair.
// Returns { available: false } when the feed does not publish the index.
addon.get("/api/flixpatrol/availability", (req, res) => {
  try {
    const { getFlixPatrolAvailability } = require('./utils/flixpatrolUtils');
    const index = getFlixPatrolAvailability();
    res.json({ available: Boolean(index), index: index || null });
  } catch (error) {
    consola.error("[FlixPatrol] Availability error:", error.message);
    res.json({ available: false, index: null });
  }
});

// --- AniList OAuth Routes ---
const anilistTracker = require('./lib/anilistTracker');
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
    
    const state = createAniListOAuthState(clientSecret, ANILIST_OAUTH_STATE_TTL_MS);
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
    const codeParam = Array.isArray(req.query.code) ? req.query.code[0] : req.query.code;
    const stateParam = Array.isArray(req.query.state) ? req.query.state[0] : req.query.state;
    const code = typeof codeParam === 'string' ? codeParam : '';
    const state = typeof stateParam === 'string' ? stateParam : '';
    
    if (!code) {
      return res.status(400).send(renderOAuthPage({
        provider: 'anilist',
        status: 'error',
        title: 'Authorization incomplete',
        message: 'AniList did not return an authorization code. Please start the connection again.',
        retryHref: '/anilist/auth',
      }));
    }
    
    const clientId = process.env.ANILIST_CLIENT_ID;
    const clientSecret = process.env.ANILIST_CLIENT_SECRET;
    const redirectUri = normalizeRedirectUri(process.env.ANILIST_REDIRECT_URI || `${process.env.HOST_NAME}/anilist/callback`);
    
    if (!clientId || !clientSecret) {
      return res.status(500).send(renderOAuthPage({
        provider: 'anilist',
        status: 'warning',
        title: 'AniList is not configured',
        message: 'This server is missing the credentials required to connect an AniList account.',
      }));
    }

    if (!verifyAniListOAuthState(state, clientSecret)) {
      return res.status(400).send(renderOAuthPage({
        provider: 'anilist',
        status: 'error',
        title: 'Connection expired',
        message: 'The secure authorization state is missing, invalid, or expired. Please start again.',
        retryHref: '/anilist/auth',
      }));
    }

    if (usedAnilistCodes.has(code)) {
      return res.status(400).send(renderOAuthPage({
        provider: 'anilist',
        status: 'warning',
        title: 'Authorization already used',
        message: 'This authorization has already been completed. Start a new connection if you need another token.',
        retryHref: '/anilist/auth',
        retryLabel: 'Reconnect AniList',
      }));
    }
    usedAnilistCodes.add(code);
    setTimeout(() => usedAnilistCodes.delete(code), 120000);
    
    // Exchange code for tokens
    const tokens = await anilistTracker.exchangeCodeForTokens(code, redirectUri);
    
    if (!tokens) {
      return res.status(500).send(renderOAuthPage({
        provider: 'anilist',
        status: 'error',
        title: 'Connection failed',
        message: 'The authorization code could not be exchanged for an AniList token. Please try again.',
        retryHref: '/anilist/auth',
      }));
    }
    
    // Get user info from AniList
    const user = await anilistTracker.getAuthenticatedUser(tokens.access_token);
    
    if (!user) {
      return res.status(500).send(renderOAuthPage({
        provider: 'anilist',
        status: 'error',
        title: 'Profile unavailable',
        message: 'AniList authorized the connection, but the account profile could not be loaded. Please try again.',
        retryHref: '/anilist/auth',
      }));
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
      return res.status(500).send(renderOAuthPage({
        provider: 'anilist',
        status: 'error',
        title: 'Token could not be saved',
        message: 'AniList authorized the connection, but this server could not store the token. Please try again.',
        retryHref: '/anilist/auth',
      }));
    }

    res.send(renderOAuthPage({
      provider: 'anilist',
      status: 'success',
      title: 'AniList connected',
      message: 'Authorization is complete. Copy the token ID and paste it into the AniList integration settings.',
      username: user.username,
      tokenId,
    }));
  } catch (error) {
    consola.error("[AniList OAuth] Callback error:", error);
    res.status(500).send(renderOAuthPage({
      provider: 'anilist',
      status: 'error',
      title: 'Something went wrong',
      message: 'An unexpected error interrupted the AniList connection. Please try again.',
      retryHref: '/anilist/auth',
    }));
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
    
    // `removed` says exactly what this disconnect took out, so a page holding
    // unsaved edits can apply the same removals instead of adopting the whole
    // saved document and losing them.
    res.json({ success: true, config, removed: { apiKeys: ['anilistTokenId'], fields: ['anilistWatchTracking'] } });
  } catch (error) {
    consola.error("[AniList] Disconnect error:", error);
    res.status(500).json({ error: "Failed to disconnect AniList" });
  }
});

addon.get("/anilist/status/:userUUID", requireDashboardAdmin, async (req, res) => {
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

const malTracker = require('./lib/malTracker');

addon.use(['/mal/auth', '/mal/callback'], noStoreOAuthHeaders);

// GET /mal/auth - Initiate MyAnimeList OAuth flow
addon.get("/mal/auth", async (req, res) => {
  try {
    const clientId = process.env.MAL_CLIENT_ID;
    const clientSecret = process.env.MAL_CLIENT_SECRET;
    const redirectUri = normalizeRedirectUri(process.env.MAL_REDIRECT_URI || `${process.env.HOST_NAME}/mal/callback`);

    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: "MyAnimeList OAuth not configured. Please set MAL_CLIENT_ID and MAL_CLIENT_SECRET environment variables." });
    }

    consola.info(`[MAL OAuth] Starting auth flow with redirect_uri=${redirectUri}`);

    const { state, codeVerifier } = createMalOAuthTransaction(
      clientSecret,
      MAL_OAUTH_STATE_TTL_MS
    );

    const authUrl = malTracker.getAuthorizationUrl(redirectUri, state, codeVerifier);
    res.redirect(authUrl);
  } catch (error) {
    consola.error("[MAL OAuth] Authorization error:", error);
    res.status(500).json({ error: "Failed to initiate MyAnimeList authorization" });
  }
});

// GET /mal/callback - Handle MyAnimeList OAuth callback
addon.get("/mal/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.status(400).send(renderOAuthPage({
        provider: 'mal',
        status: 'error',
        title: 'Authorization incomplete',
        message: 'MyAnimeList did not return an authorization code. Please start the connection again.',
        retryHref: '/mal/auth',
      }));
    }

    const clientSecret = process.env.MAL_CLIENT_SECRET;
    const codeVerifier = state
      ? verifyMalOAuthState(state, clientSecret)
      : null;
    if (!codeVerifier) {
      return res.status(400).send(renderOAuthPage({
        provider: 'mal',
        status: 'error',
        title: 'Connection expired',
        message: 'The secure authorization state is missing, invalid, or expired. Please start again.',
        retryHref: '/mal/auth',
      }));
    }

    if (usedMalCodes.has(code)) {
      return res.status(400).send(renderOAuthPage({
        provider: 'mal',
        status: 'warning',
        title: 'Authorization already used',
        message: 'This authorization has already been completed. Start a new connection if you need another token.',
        retryHref: '/mal/auth',
        retryLabel: 'Reconnect MyAnimeList',
      }));
    }
    usedMalCodes.add(code);
    setTimeout(() => usedMalCodes.delete(code), 120000);

    const clientId = process.env.MAL_CLIENT_ID;
    const redirectUri = normalizeRedirectUri(process.env.MAL_REDIRECT_URI || `${process.env.HOST_NAME}/mal/callback`);

    if (!clientId || !clientSecret) {
      return res.status(500).send(renderOAuthPage({
        provider: 'mal',
        status: 'warning',
        title: 'MyAnimeList is not configured',
        message: 'This server is missing the credentials required to connect a MyAnimeList account.',
      }));
    }

    const tokens = await malTracker.exchangeCodeForTokens(code, redirectUri, codeVerifier);
    if (!tokens) {
      return res.status(500).send(renderOAuthPage({
        provider: 'mal',
        status: 'error',
        title: 'Connection failed',
        message: 'The authorization code could not be exchanged for a MyAnimeList token. Please try again.',
        retryHref: '/mal/auth',
      }));
    }

    const user = await malTracker.getAuthenticatedUser(tokens.access_token);
    if (!user) {
      return res.status(500).send(renderOAuthPage({
        provider: 'mal',
        status: 'error',
        title: 'Profile unavailable',
        message: 'MyAnimeList authorized the connection, but the account profile could not be loaded. Please try again.',
        retryHref: '/mal/auth',
      }));
    }

    const existingTokens = await database.getOAuthTokensByProvider('mal');
    const existingToken = existingTokens.find(t => t.user_id.toLowerCase() === user.username.toLowerCase());
    let tokenId;
    let saved;
    if (existingToken) {
      tokenId = existingToken.id;
      consola.info(`[MAL OAuth] Updating existing token - tokenId: ${tokenId}, user: ${user.username}`);
      saved = await database.updateOAuthToken(
        tokenId,
        tokens.access_token,
        tokens.refresh_token || '',
        tokens.expires_at
      );
    } else {
      tokenId = crypto.randomUUID();
      consola.info(`[MAL OAuth] Creating new token - tokenId: ${tokenId}, user: ${user.username}`);
      saved = await database.saveOAuthToken(
        tokenId,
        'mal',
        user.username,
        tokens.access_token,
        tokens.refresh_token || '',
        tokens.expires_at,
        ''
      );
    }

    if (!saved) {
      return res.status(500).send(renderOAuthPage({
        provider: 'mal',
        status: 'error',
        title: 'Token could not be saved',
        message: 'MyAnimeList authorized the connection, but this server could not store the token. Please try again.',
        retryHref: '/mal/auth',
      }));
    }

    res.send(renderOAuthPage({
      provider: 'mal',
      status: 'success',
      title: 'MyAnimeList connected',
      message: 'Authorization is complete. Copy the token ID and paste it into the MyAnimeList integration settings.',
      username: user.username,
      tokenId,
    }));
  } catch (error) {
    consola.error("[MAL OAuth] Callback error:", error);
    res.status(500).send(renderOAuthPage({
      provider: 'mal',
      status: 'error',
      title: 'Something went wrong',
      message: 'An unexpected error interrupted the MyAnimeList connection. Please try again.',
      retryHref: '/mal/auth',
    }));
  }
});

// POST /mal/disconnect - Disconnect MyAnimeList account
addon.post("/mal/disconnect", async (req, res) => {
  try {
    const { userUUID } = req.body;

    if (!userUUID) {
      return res.status(400).json({ error: "userUUID is required" });
    }

    const config = await loadConfigFromDatabase(userUUID);
    if (!config) {
      return res.status(404).json({ error: "User config not found" });
    }

    if (config.apiKeys?.malTokenId) {
      await database.deleteOAuthToken(config.apiKeys.malTokenId);
      delete config.apiKeys.malTokenId;
    }

    delete config.malWatchTracking;

    const user = await database.getUser(userUUID);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    await database.saveUserConfig(userUUID, user.password_hash, config);
    configCache.del(userUUID);

    // `removed` says exactly what this disconnect took out, so a page holding
    // unsaved edits can apply the same removals instead of adopting the whole
    // saved document and losing them.
    res.json({ success: true, config, removed: { apiKeys: ['malTokenId'], fields: ['malWatchTracking'] } });
  } catch (error) {
    consola.error("[MAL] Disconnect error:", error);
    res.status(500).json({ error: "Failed to disconnect MyAnimeList" });
  }
});

addon.get("/mal/status/:userUUID", requireDashboardAdmin, async (req, res) => {
  try {
    const { userUUID } = req.params;

    if (!userUUID) {
      return res.status(400).json({ error: "userUUID is required" });
    }

    const config = await loadConfigFromDatabase(userUUID);
    if (!config) {
      return res.status(404).json({ error: "User config not found" });
    }

    const malTokenId = config.apiKeys?.malTokenId;
    if (!malTokenId) {
      return res.json({
        connected: false,
        username: null
      });
    }

    const token = await database.getOAuthToken(malTokenId);
    if (!token) {
      return res.json({
        connected: false,
        username: null
      });
    }

    const hasRefreshToken = !!token.refresh_token;
    const isExpired = token.expires_at && Date.now() >= token.expires_at && !hasRefreshToken;
    res.json({
      connected: !isExpired,
      expired: isExpired,
      expiresAt: token.expires_at || null,
      username: token.user_id,
      trackingEnabled: config.malWatchTracking !== false
    });
  } catch (error) {
    consola.error("[MAL] Status check error:", error);
    res.status(500).json({ error: "Failed to check MyAnimeList status" });
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

// POST /api/integrations/credential - Point a configuration at a credential the OAuth
// callback already stored. Persisting here rather than waiting for Save is what stops a
// connection being lost by navigating away, and stops the token row being stranded with
// nothing referencing it. Only the pointer is written, so unsaved edits held in the page
// are neither read nor overwritten.
const INTEGRATION_CREDENTIAL_FIELDS = {
  trakt: { field: 'traktTokenId', provider: 'trakt' },
  simkl: { field: 'simklTokenId', provider: 'simkl' },
  anilist: { field: 'anilistTokenId', provider: 'anilist' },
  mal: { field: 'malTokenId', provider: 'mal' },
  movielens: { field: 'movieLensCredId', provider: 'movielens' },
};

addon.post("/api/integrations/credential", async (req, res) => {
  try {
    const { userUUID, password, provider, tokenId } = req.body || {};
    const mapping = INTEGRATION_CREDENTIAL_FIELDS[provider];
    if (!userUUID || !mapping || !tokenId) {
      return res.status(400).json({ error: "userUUID, a known provider and tokenId are required" });
    }
    const access = await resolveConfigAccess(req, userUUID, password);
    if (!access || !access.passwordHash) {
      return res.status(401).json({ error: "Invalid UUID or password" });
    }
    // A typo used to be stored and only fail much later, on the first call that needed it.
    const row = await database.getOAuthToken(tokenId);
    if (!row || row.provider !== mapping.provider) {
      return res.status(404).json({ error: `No ${provider} credential with that id` });
    }
    const config = access.config;
    config.apiKeys = { ...(config.apiKeys || {}), [mapping.field]: tokenId };
    await database.saveUserConfig(userUUID, access.passwordHash, config);
    configCache.del(userUUID);
    res.json({ success: true, field: mapping.field, tokenId });
  } catch (error) {
    consola.error(`[Integrations] Failed to store credential: ${error.message}`);
    res.status(500).json({ error: "Failed to store the credential" });
  }
});

// --- Addon manager accounts (AIOManager and friends) ---------------------------

// Relays one Hydra reinstall. Shared by the single-account route and the batch below
// so both apply the same manifest-origin guard and read upstream errors the same way.
async function hydraReinstall(instanceUrl: string, apiKey: string, addonUrl: string) {
  const { httpPost } = require('./utils/httpClient');
  const target = `${managerAccounts.normalizeInstanceUrl(instanceUrl)}/hydra/reinstall`;
  try {
    const response = await httpPost(target, { addonUrl }, {
      headers: { 'X-API-Key': apiKey },
      timeout: 15000
    });
    if (typeof response.data === 'string') {
      consola.warn(`[AIOManager Proxy] Non-JSON response from ${target} (status ${response.status}); this instance does not expose the Hydra API, reinstall was not processed`);
      return { ok: false, status: 502, error: "Your AIOManager instance does not support the Hydra API yet (it requires a newer AIOManager release), so the sync was not processed" };
    }
    return { ok: true, status: 200, data: response.data ?? { success: true } };
  } catch (error: any) {
    const upstreamStatus = error.response?.status;
    let upstreamData = error.response?.data;
    if (typeof upstreamData === 'string') {
      try { upstreamData = JSON.parse(upstreamData); } catch { upstreamData = null; }
    }
    consola.error(`[AIOManager Proxy] Hydra reinstall failed: ${error.message}`);
    return {
      ok: false,
      status: upstreamStatus >= 400 && upstreamStatus < 600 ? upstreamStatus : 502,
      error: upstreamData?.error || upstreamData?.message || error.message || "Hydra reinstall failed"
    };
  }
}

/** A manifest may only be pushed to a manager if this instance is the one serving it. */
function servedByThisInstance(addonUrl: string): boolean {
  const hostName = (process.env.HOST_NAME || '').replace(/\/+$/, '');
  if (!hostName) return true;
  try {
    const expected = new URL(hostName.includes('://') ? hostName : `https://${hostName}`).host.toLowerCase();
    return new URL(String(addonUrl)).host.toLowerCase() === expected;
  } catch {
    return false;
  }
}

// POST /api/managers/accounts - Add or edit one manager account. The API key is stored
// out of line and only its id is written to the config.
addon.post("/api/managers/accounts", async (req, res) => {
  try {
    const { userUUID, password, accountId, managerId, label, instanceUrl, apiKey, profileTags, autoSync } = req.body || {};
    if (!userUUID || !managerId || !instanceUrl) {
      return res.status(400).json({ error: "userUUID, managerId and instanceUrl are required" });
    }
    const normalized = managerAccounts.normalizeInstanceUrl(instanceUrl);
    if (!managerAccounts.isHttpUrl(normalized)) {
      return res.status(400).json({ error: "instanceUrl must be a http(s) URL" });
    }
    const access = await resolveConfigAccess(req, userUUID, password);
    if (!access || !access.passwordHash) {
      return res.status(401).json({ error: "Invalid UUID or password" });
    }
    const config = access.config;
    await managerAccounts.migrateLegacyManagers(config, userUUID);
    if (!accountId && !apiKey) {
      return res.status(400).json({ error: "apiKey is required for a new account" });
    }
    const account = await managerAccounts.upsertAccount(config, userUUID, {
      accountId, managerId, label, instanceUrl: normalized, apiKey, profileTags, autoSync
    });
    await database.saveUserConfig(userUUID, access.passwordHash, config);
    res.json({ success: true, account, managerAccounts: config.managerAccounts });
  } catch (error) {
    consola.error(`[Managers] Failed to save account: ${error.message}`);
    res.status(500).json({ error: "Failed to save the manager account" });
  }
});

// DELETE /api/managers/accounts - Remove one account and the key it points at
addon.delete("/api/managers/accounts", async (req, res) => {
  try {
    const { userUUID, password, accountId } = req.body || {};
    if (!userUUID || !accountId) {
      return res.status(400).json({ error: "userUUID and accountId are required" });
    }
    const access = await resolveConfigAccess(req, userUUID, password);
    if (!access || !access.passwordHash) {
      return res.status(401).json({ error: "Invalid UUID or password" });
    }
    const config = access.config;
    await managerAccounts.migrateLegacyManagers(config, userUUID);
    const removed = await managerAccounts.removeAccount(config, accountId);
    if (!removed) {
      return res.status(404).json({ error: "No such account" });
    }
    await database.saveUserConfig(userUUID, access.passwordHash, config);
    res.json({ success: true, managerAccounts: config.managerAccounts });
  } catch (error) {
    consola.error(`[Managers] Failed to remove account: ${error.message}`);
    res.status(500).json({ error: "Failed to remove the manager account" });
  }
});

// POST /api/managers/credentials - Legacy single-account save, kept so a cached page
// still works. Writes through to the account list rather than the old inline shape.
addon.post("/api/managers/credentials", async (req, res) => {
  try {
    const { userUUID, password, managerId, instanceUrl, apiKey } = req.body || {};
    if (!userUUID || !managerId || !instanceUrl || !apiKey) {
      return res.status(400).json({ error: "userUUID, managerId, instanceUrl and apiKey are required" });
    }
    const access = await resolveConfigAccess(req, userUUID, password);
    if (!access || !access.passwordHash) {
      return res.status(401).json({ error: "Invalid UUID or password" });
    }
    const config = access.config;
    await managerAccounts.migrateLegacyManagers(config, userUUID);
    const normalized = managerAccounts.normalizeInstanceUrl(instanceUrl);
    const existing = managerAccounts.accountsOf(config)
      .find(account => account.managerId === managerId && account.instanceUrl === normalized);
    await managerAccounts.upsertAccount(config, userUUID, {
      accountId: existing?.id,
      managerId,
      instanceUrl: normalized,
      apiKey,
      label: existing?.label || managerAccounts.hostLabel(normalized),
    });
    await database.saveUserConfig(userUUID, access.passwordHash, config);
    res.json({ success: true, managerAccounts: config.managerAccounts });
  } catch (error) {
    consola.error(`[Managers] Failed to save credentials: ${error.message}`);
    res.status(500).json({ error: "Failed to save manager credentials" });
  }
});

// POST /api/managers/sync - Push one manifest to several accounts at once. Sequential
// per host, because Hydra rate limits reinstall at 10/min and several accounts can live
// on the same instance. One failure is reported against its account, not the batch.
addon.post("/api/managers/sync", async (req, res) => {
  try {
    const { userUUID, password, targets } = req.body || {};
    if (!userUUID || !Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({ error: "userUUID and a non-empty targets array are required" });
    }
    const access = await resolveConfigAccess(req, userUUID, password);
    if (!access || !access.passwordHash) {
      return res.status(401).json({ error: "Invalid UUID or password" });
    }
    const config = access.config;
    await managerAccounts.migrateLegacyManagers(config, userUUID);

    const byHost = new Map<string, Array<{ accountId: string; addonUrl: string }>>();
    for (const target of targets) {
      const account = managerAccounts.findAccount(config, target?.accountId);
      const host = account ? managerAccounts.normalizeInstanceUrl(account.instanceUrl).toLowerCase() : String(target?.accountId);
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push(target);
    }

    const delayMs = getManagerSyncHostDelayMs();
    const results = [];
    await Promise.all([...byHost.values()].map(async (group) => {
      for (let i = 0; i < group.length; i++) {
        const { accountId, addonUrl } = group[i] || {};
        const account = managerAccounts.findAccount(config, accountId);
        if (!account) {
          results.push({ accountId, ok: false, error: "No such account" });
          continue;
        }
        if (!addonUrl || !servedByThisInstance(addonUrl)) {
          results.push({ accountId, label: account.label, ok: false, error: "addonUrl must be a manifest URL from this addon" });
          continue;
        }
        const apiKey = await managerAccounts.resolveAccountKey(account);
        if (!apiKey) {
          results.push({ accountId, label: account.label, ok: false, error: "Stored API key is missing, re-enter it" });
          continue;
        }
        if (i > 0 && delayMs > 0) await sleep(delayMs);
        const outcome = await hydraReinstall(account.instanceUrl, apiKey, addonUrl);
        if (outcome.ok) account.lastSyncedAt = new Date().toISOString();
        results.push({ accountId, label: account.label, ok: outcome.ok, ...(outcome.ok ? {} : { error: outcome.error, status: outcome.status }) });
      }
    }));

    await database.saveUserConfig(userUUID, access.passwordHash, config);
    const synced = results.filter(r => r.ok).length;
    res.json({ success: synced > 0, synced, failed: results.length - synced, results, managerAccounts: config.managerAccounts });
  } catch (error) {
    consola.error(`[Managers] Batch sync failed: ${error.message}`);
    res.status(500).json({ error: "Failed to sync to the manager accounts" });
  }
});

// GET /api/aiomanager/status - Ask an instance whether it serves the Hydra API
addon.get("/api/aiomanager/status", async (req, res) => {
  const instanceUrl = typeof req.query.instanceUrl === 'string' ? req.query.instanceUrl.trim() : '';
  if (!instanceUrl) {
    return res.status(400).json({ error: "instanceUrl is required" });
  }
  let parsed;
  try {
    parsed = new URL(instanceUrl);
  } catch {
    return res.status(400).json({ error: "instanceUrl must be a valid URL" });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.status(400).json({ error: "instanceUrl must be a http(s) URL" });
  }

  try {
    const { httpGet } = require('./utils/httpClient');
    const response = await httpGet(`${instanceUrl.replace(/\/+$/, '')}/hydra/status`, { timeout: 10000 });
    // Releases without Hydra answer the SPA catch-all, so HTML means unsupported.
    if (typeof response.data === 'string' || !response.data?.capabilities) {
      return res.json({ supported: false });
    }
    return res.json({ supported: true, ...response.data });
  } catch (error) {
    consola.debug(`[AIOManager Proxy] Status probe failed for ${instanceUrl}: ${error.message}`);
    return res.json({ supported: false });
  }
});

// POST /api/aiomanager/reinstall - Proxy one Hydra reinstall. Takes either a saved
// accountId, whose key is resolved here so the page never holds it, or a key typed in
// for a one-off sync that is not being remembered.
addon.post("/api/aiomanager/reinstall", async (req, res) => {
  try {
    const { instanceUrl, apiKey, addonUrl, userUUID, password, accountId } = req.body || {};
    if (!addonUrl) {
      return res.status(400).json({ error: "addonUrl is required" });
    }
    if (!servedByThisInstance(addonUrl)) {
      return res.status(400).json({ error: "addonUrl must be a manifest URL from this addon" });
    }

    let targetUrl = managerAccounts.normalizeInstanceUrl(instanceUrl || '');
    let targetKey = apiKey;

    if (accountId) {
      if (!userUUID) {
        return res.status(400).json({ error: "userUUID is required to sync a saved account" });
      }
      const access = await resolveConfigAccess(req, userUUID, password);
      if (!access || !access.passwordHash) {
        return res.status(401).json({ error: "Invalid UUID or password" });
      }
      await managerAccounts.migrateLegacyManagers(access.config, userUUID);
      const account = managerAccounts.findAccount(access.config, accountId);
      if (!account) {
        return res.status(404).json({ error: "No such account" });
      }
      targetKey = await managerAccounts.resolveAccountKey(account);
      if (!targetKey) {
        return res.status(400).json({ error: "Stored API key is missing, re-enter it" });
      }
      targetUrl = managerAccounts.normalizeInstanceUrl(account.instanceUrl);
    }

    if (!targetUrl || !targetKey) {
      return res.status(400).json({ error: "instanceUrl and apiKey are required" });
    }
    if (!managerAccounts.isHttpUrl(targetUrl)) {
      return res.status(400).json({ error: "instanceUrl must be a http(s) URL" });
    }

    const outcome = await hydraReinstall(targetUrl, targetKey, addonUrl);
    if (!outcome.ok) {
      return res.status(outcome.status).json({ error: outcome.error });
    }
    res.json(outcome.data);
  } catch (error) {
    consola.error(`[AIOManager Proxy] Hydra reinstall failed: ${error.message}`);
    res.status(502).json({ error: error.message || "Hydra reinstall failed" });
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
addon.get("/api/config/stats", requireDashboardAdmin, (req, res) => {
  configApi.getStats(req, res);
});

addon.get("/api/admin/cold-store/stats", requireDashboardAdmin, (req, res) => {
  try {
    const metaColdStore = require('./lib/metaColdStore');
    res.json(metaColdStore.stats());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

addon.post("/api/admin/cold-store/purge", requireDashboardAdmin, (req, res) => {
  try {
    const metaColdStore = require('./lib/metaColdStore');
    const metaId = req.query.metaId;
    const removed = metaId ? metaColdStore.invalidate(String(metaId)) : metaColdStore.purge();
    res.json({ success: true, removed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Cache Warming Endpoints (Admin only) ---
addon.post("/api/cache/warm", requireDashboardAdmin, async (req, res) => {
  
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

addon.get("/api/cache/status", requireDashboardAdmin, (req, res) => {
  
  const { isInitialWarmingComplete } = require('./lib/cacheWarmer');
  
  res.json({
    cacheEnabled: true,
    warmingEnabled: isCacheWarmingEnabled(),
    warmingInterval: cacheWarmingIntervalMinutes(),
    initialWarmingComplete: isInitialWarmingComplete(),
    addonVersion: ADDON_VERSION
  });
});

// Cache health monitoring endpoints
addon.get("/api/cache/health", requireDashboardAdmin, (req, res) => {
  
  const health = getCacheHealth();
  res.json({
    success: true,
    health,
    timestamp: new Date().toISOString()
  });
});

addon.post("/api/cache/health/clear", requireDashboardAdmin, (req, res) => {
  
  clearCacheHealth();
  res.json({
    success: true,
    message: 'Cache health statistics cleared'
  });
});

addon.post("/api/cache/health/log", requireDashboardAdmin, (req, res) => {
  
  logCacheHealth();
  res.json({
    success: true,
    message: 'Cache health logged to console'
  });
});

// Clear specific cache key
addon.delete("/api/cache/clear/:key", requireDashboardAdmin, async (req, res) => {
  
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
require('./lib/collectionExportRoutes').register(addon);

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
        
        const { tags, unknown: unknownTags } = resolveManifestTags(config, req.query.tag);
        req.manifestTags = tags;
        // The cap itself applies to catalog and search requests, not to the manifest.
        // It is resolved here anyway so an install URL can be checked before it is used.
        const installFilters = resolveInstallFilters(config, {
            rating: req.query.contentrating ?? req.query.contentRating,
            unrated: req.query.unrated,
            tags,
        });
        const ratingOverride = installFilters.ageRating;
        const hidesUnrated = installFilters.allowUnrated === false && allowsUnrated(config);
        const refusedFilters = installFilters.refused;
        if (refusedFilters.length > 0) {
            consola.warn(`[Manifest] User ${userUUID} asked for ${refusedFilters.join(', ')}, which does not tighten their configured ${config.ageRating || 'None'}`);
        }
        consola.debug(`[Manifest] Building fresh manifest for user: ${userUUID}${tags.length ? ` (tags: ${tags.join(', ')})` : ''}`);
        if (unknownTags.length > 0) {
            consola.warn(`[Manifest] User ${userUUID} asked for ${unknownTags.join(', ')}, which no catalog is tagged with`);
        }
        const manifest = await getManifest(config, { tags });
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
            timestamp: new Date().toISOString(),
            ...(tags.length > 0 ? { tags } : {}),
            ...(unknownTags.length > 0 ? { unknownTags } : {}),
            ...(ratingOverride ? { contentRating: ratingOverride } : {}),
            ...(hidesUnrated ? { unrated: 'hidden' } : {}),
            ...(refusedFilters.length > 0 ? { refusedContentRating: refusedFilters } : {})
        };
        
        // Only when every named profile agrees, so a mixed install is not labelled with
        // a cap that half its rows do not carry.
        const labelRating = req.query.contentrating || req.query.contentRating
            ? ratingOverride
            : uniformTagRating(config, tags);
        if (labelRating) {
            manifest.name = `${manifest.name} · ${labelRating}`;
        }

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
  const storedConfig = await loadConfigFromDatabase(userUUID);
  
  if (!storedConfig) {
    return res.status(404).send({ error: "User configuration not found" });
  }
  const config = applyRatingOverrides(storedConfig, req, userUUID);
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
            
            meta.videos.sort((a, b) => new Date(a.released).getTime() - new Date(b.released).getTime());
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
  const suffixMatch = id.match(/_(movie|series|anime|all)$/);
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
    const strippedId = id.replace(/_(movie|series|anime|all)$/, '');
    
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
  let extraArgs: any = {};
  if (extra) {
    extraArgs = Object.fromEntries(new URLSearchParams(req.url.split("/").pop().split("?")[0].slice(0, -5)).entries());
  }
  const cacheWrapper = cacheWrapCatalog;

  extraArgs = extraArgs || {};
  // Ensure sort options are included in cache key
  // Claimed before the provider prefixes; anilist.discover would otherwise match anilist.
  if (isDiscoverCatalogId(cleanId)) {
    applyDiscoverSignature(extraArgs, catalogConfig);
  }
  // Trakt uses: sort, sortDirection
  else if (cleanId.startsWith('trakt.')) {
    if (catalogConfig?.sort) extraArgs.sort = catalogConfig.sort;
    if (catalogConfig?.sortDirection) extraArgs.sortDirection = catalogConfig.sortDirection;
  }
  // MDBList uses: sort, order
  else if (cleanId.startsWith('mdblist.')) {
    if (catalogConfig?.sort) extraArgs.sort = catalogConfig.sort;
    if (catalogConfig?.order) extraArgs.order = catalogConfig.order;
    if (supportsMdblistScoreFilters(catalogConfig)) {
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
    if (cleanId.startsWith('tmdb.year') && typeof catalogConfig?.minVotes === 'number') {
      extraArgs.minVotes = catalogConfig.minVotes;
    }
  }
  // AniList uses: sort, sortDirection
  else if (cleanId.startsWith('anilist.')) {
    if (catalogConfig?.sort) extraArgs.sort = catalogConfig.sort;
    if (catalogConfig?.sortDirection) extraArgs.sortDirection = catalogConfig.sortDirection;
  }
  // MAL user lists use: sort
  else if (cleanId.startsWith('mal.userlist.')) {
    if (catalogConfig?.sort) extraArgs.sort = catalogConfig.sort;
  }
  // MovieLens uses: sortBy, sortDirection, tags, minYear, maxYear, minPop, maxDaysAgo, maxFutureDays
  else if (cleanId.startsWith('movielens.')) {
    const mlMeta: any = catalogConfig?.metadata || {};
    if (mlMeta.sortBy) extraArgs.sort = mlMeta.sortBy;
    if (mlMeta.sortDirection) extraArgs.sortDirection = mlMeta.sortDirection;
    if (mlMeta.tags) extraArgs.tags = mlMeta.tags;
    if (mlMeta.minYear) extraArgs.minYear = mlMeta.minYear;
    if (mlMeta.maxYear) extraArgs.maxYear = mlMeta.maxYear;
    if (mlMeta.minPop) extraArgs.minPop = mlMeta.minPop;
    if (mlMeta.maxDaysAgo) extraArgs.maxDaysAgo = mlMeta.maxDaysAgo;
    if (mlMeta.maxFutureDays !== undefined) extraArgs.maxFutureDays = mlMeta.maxFutureDays;
    if (mlMeta.includeRated) extraArgs.includeRated = true;
  }
  // Up next catalogs need poster preference and filter settings in cache key
  if (cleanId === 'trakt.upnext' || cleanId === 'mdblist.upnext' || cleanId.startsWith('simkl.upnext')) {
      extraArgs.useShowPoster = typeof catalogConfig?.metadata?.useShowPosterForUpNext === 'boolean'
        ? catalogConfig.metadata.useShowPosterForUpNext
        : false;
  }
  if (cleanId === 'simkl.upnext') {
      extraArgs.includeAnime = catalogConfig?.metadata?.includeAnimeInUpNext !== false;
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
  } else if (cleanId.startsWith('mal.userlist.') || cleanId === 'mal.suggestions') {
    catalogPageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE || '20');
  } else if (cleanId.includes('mal.')) {
    catalogPageSize = parseInt(process.env.MAL_PAGE_SIZE || '25');
  } else if (cleanId === 'anilist.trending' || cleanId.startsWith('anilist.discover')) {
    catalogPageSize = 50;
  } else if (cleanId.startsWith('simkl.watchlist.') || cleanId.startsWith('simkl.upnext') || cleanId.startsWith('simkl.dvd.') || cleanId.startsWith('simkl.trending.') || cleanId.startsWith('simkl.recipe.') || cleanId.startsWith('stremthru.') || cleanId.startsWith('mdblist.') || cleanId.startsWith('custom.') || cleanId.startsWith('trakt.') || cleanId.startsWith('anilist.') || cleanId.startsWith('letterboxd.') || cleanId.startsWith('movielens.') || (cleanId.startsWith('tvdb.') && !cleanId.startsWith('tvdb.collection.'))) {
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

  if (cleanId.startsWith('simkl.watchlist.') || cleanId.startsWith('simkl.upnext')) {
    try {
      const { getSimklToken, getSimklActivityFingerprint } = require('./utils/simklUtils');
      const tokenId = config.apiKeys?.simklTokenId;
      if (tokenId) {
        const token = await getSimklToken(tokenId);
        if (token?.access_token) {
          // Up Next reads whichever buckets it renders, so its key has to move when
          // any of them does, not just when the shows bucket does.
          let pairs;
          if (cleanId === 'simkl.upnext.anime') {
            pairs = [['anime', 'watching']];
          } else if (cleanId === 'simkl.upnext') {
            pairs = extraArgs.includeAnime === false
              ? [['shows', 'watching']]
              : [['shows', 'watching'], ['anime', 'watching']];
          } else {
            const parts = cleanId.split('.');
            pairs = [[parts[2], parts[3]]];
          }
          const fps = await Promise.all(
            pairs.map(([t, s]) => getSimklActivityFingerprint(token.access_token, t, s))
          );
          const fp = fps.filter(Boolean).join('+');
          if (fp) cacheExtraArgs._simklAct = fp;
        }
      }
    } catch (e) {
      consola.warn(`[Catalog] Simkl activity fingerprint failed for ${cleanId}: ${e.message}`);
    }
  }

  if (cleanId.startsWith('movielens.explore')) {
    try {
      const credId = config.apiKeys?.movieLensCredId;
      const catCfg = config.catalogs?.find(c => c.id === cleanId);
      const explicitTags = String(catCfg?.metadata?.tags || '')
        .split(',').map(s => s.trim()).filter(Boolean).join(',');
      if (credId && !explicitTags) {
        const metaTtl = parseInt(
          process.env.MOVIELENS_USERMETA_TTL_SECONDS || process.env.MOVIELENS_GROUPTAGS_TTL_SECONDS || '43200', 10);
        const userMeta = await cacheWrapGlobal(`movielens-usermeta:${credId}`,
          async () => movielens.getUserMeta(credId), metaTtl);
        if (userMeta?.engineId === 'bard' && Array.isArray(userMeta.groupTags) && userMeta.groupTags.length) {
          cacheExtraArgs._mlTags = userMeta.groupTags.map(t => t.trim()).filter(Boolean).join(',');
        }
      }
    } catch (e) {
      consola.warn(`[Catalog] MovieLens group tags failed for ${cleanId}: ${e.message}`);
    }
  }

  const cacheOptions = {
    enableErrorCaching: true,
    maxRetries: 2,
    config,
  };
  
  try {
    let responseData;
    // Set by any branch whose handler already ran applyCatalogFilters internally
    // (external addon catalogs filter before computing their pagination cursor).
    let filtersAlreadyApplied = false;
    let pendingCursor = null;

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
      if (searchEngine && searchEngine.startsWith('mal.')) {
        searchPageSize = parseInt(process.env.MAL_PAGE_SIZE || '25');
      } else if (searchEngine && searchEngine.startsWith('tvdb.')) {
        searchPageSize = 25;
      } else if (searchEngine && searchEngine.startsWith('trakt.')) {
        searchPageSize = 30;
      }
      const searchPage = extraArgs.skip ? Math.ceil(parseInt(extraArgs.skip) / searchPageSize) + 1 : 1;

      // Normalize skip to page for stable search cache keys
      const searchExtraArgs = { ...extraArgs };
      delete searchExtraArgs.skip;
      if (searchPage > 1) searchExtraArgs.page = searchPage;

      // Optional keyword gate for AI search.
      const aiKeyword = getAiTriggerKeyword(config);
      let aiGateBlocked = false;

      if (searchEngine === 'gemini.search' && aiKeyword) {
        const aiTrigger = applyAiTrigger(searchExtraArgs.search || '', aiKeyword);
        if (aiTrigger.matched && aiTrigger.query) {
          searchExtraArgs.search = aiTrigger.query;
        } else {
          // Query lacks the trigger keyword (or is only the keyword) — no AI call.
          aiGateBlocked = true;
        }
      }

      if (aiGateBlocked) {
        responseData = { metas: [] };
      } else {
        // Use search-specific cache wrapper
        const searchKey = `${cleanId}:${originalSearchId}:${searchType}:${stableStringify(searchExtraArgs)}`;

        responseData = await cacheWrapSearch(userUUID, searchKey, async () => {
          const searchResult = await getSearch(cleanId, searchType, language, searchExtraArgs, config);
          return { metas: searchResult.metas || [] };
        }, searchEngine, cacheOptions);
      }
      } else if (cleanId.startsWith('custom.') || cleanId.startsWith('stremthru.')) {
      const { genre: genreName } = extraArgs;
      const skipValue = extraArgs.skip !== undefined ? parseInt(extraArgs.skip) : 0;
      const result = await getCatalog(actualType, language, catalogPage, cleanId, genreName, config, userUUID, false, skipValue);
      responseData = { metas: result.metas || [] };
      filtersAlreadyApplied = true;
      } else if (cleanId.startsWith('merged.')) {
      const { genre: genreName } = extraArgs;
      const skipValue = extraArgs.skip !== undefined ? parseInt(extraArgs.skip) : 0;
      const result = await getCatalog(actualType, language, catalogPage, cleanId, genreName, config, userUUID, false, skipValue);
      responseData = { metas: result.metas || [] };
      filtersAlreadyApplied = true;
      } else {
      const { genre: genreName, type_filter } = extraArgs;
      const runCatalogPage = async (page, skipOverride) => {
        let metas = [];
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
          case 'mal.genres': {
            const mediaType = type_filter || null;
            const allAnimeGenres = await cacheWrapJikanApi('anime-genres', async () => {
              return await jikan.getAnimeGenres();
            }, null);
            const genreNameToFetch = genreName || allAnimeGenres[0]?.name;
            if (genreNameToFetch) {
              const selectedGenre = allAnimeGenres.find(g => g.name === genreNameToFetch);
              if (selectedGenre) {
                const genreId = selectedGenre.mal_id;
                const animeResults = await cacheWrapJikanApi(`mal-genre-${genreId}-${mediaType || 'all'}-${page}-${config.sfw}`, async () => {
                  return await jikan.getAnimeByGenre(genreId, mediaType, page, config);
                }, null);
                metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
              }
            }
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
            metas = (await getCatalog(actualType, language, page, cleanId, genreName, config, userUUID, false, skipOverride)).metas;
            break;
          }
      }
      return { metas: metas || [] };
    };

    const keyForPage = (page) => {
      const pageArgs = { ...cacheExtraArgs };
      if (page > 1) pageArgs.page = page; else delete pageArgs.page;
      return `${cleanId}:${actualType}:${stableStringify(pageArgs)}`;
    };

    const legacySkip = extraArgs.skip ? parseInt(extraArgs.skip) : undefined;
    const readPage = (page, skipOverride) =>
      cacheWrapper(userUUID, keyForPage(page), () => runCatalogPage(page, skipOverride), cacheOptions);

    if (catalogFiltersActive({ config, catalogConfig, cleanId })) {
      const key = cursorKey(userUUID, cleanId, actualType, genreName);
      const skipValue = legacySkip || 0;
      const { startPage, startOffset, matched } = await resolveStartPage(key, skipValue, catalogPage);

      const filled = await fillFilteredPage({
        startPage,
        startOffset,
        pageSize: catalogPageSize,
        fetchPage: async (page) => (await readPage(page, undefined))?.metas || [],
        filter: (metas) => applyCatalogFilters(metas, { type: actualType, config, catalogConfig, cleanId }),
      });

      responseData = { metas: filled.metas };
      filtersAlreadyApplied = true;
      pendingCursor = { key, skip: skipValue, page: filled.nextPage, offset: filled.nextOffset };

      consola.debug(
        `[Catalog] ${cleanId}: filled ${filled.metas.length}/${catalogPageSize} from ${filled.pagesRead} page(s) ` +
        `(skip=${skipValue}, start=${startPage}+${startOffset}, next=${filled.nextPage}+${filled.nextOffset}, ` +
        `cursor=${matched ? 'hit' : 'miss'}, exhausted=${filled.exhausted})`
      );
    } else {
      responseData = await readPage(catalogPage, legacySkip);
    }
    }
    if (!filtersAlreadyApplied && responseData?.metas && Array.isArray(responseData.metas) && responseData.metas.length > 0) {
      responseData.metas = await applyCatalogFilters(responseData.metas, {
        type: actualType,
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

    if (pendingCursor) {
      await writeCursor(pendingCursor.key, {
        served: pendingCursor.skip + (responseData?.metas?.length || 0),
        upstreamPage: pendingCursor.page,
        pageOffset: pendingCursor.offset,
      });
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
    const posterPattern = posterPatternsEnabled ? require('./utils/parseProps').resolvePosterPattern(config) : null;
    if ((posterPattern || config.customBackgroundUrlPattern || config.customLandscapeUrlPattern || config.customLogoUrlPattern) && responseData?.metas && Array.isArray(responseData.metas)) {
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
              meta.poster = buildProxyArtUrl({ base: `${host}/poster-cache/proxy`, imageClass: 'poster', type: type, id: proxyId, fallback: meta.poster, ratingKey: proxyApiKey, lang: config.language });
            }
          } else {
            const resolved = resolveCustomArtUrl(posterPattern, ids, type, config);
            if (resolved) {
              if (config.usePosterProxy) {
                const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
                if (proxyId) {
                  meta.poster = buildProxyArtUrl({ base: `${host}/poster-cache/proxy`, imageClass: 'poster', type: type, id: proxyId, fallback: meta.poster, url: resolved });
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
                meta.background = buildProxyArtUrl({ base: `${host}/poster-cache/proxy`, imageClass: 'background', type: type, id: proxyId, fallback: meta.background, url: resolved });
              } else {
                meta.background = resolved;
              }
            } else {
              meta.background = resolved;
            }
          }
        }
        if (config.customLandscapeUrlPattern) {
          const resolved = resolveCustomArtUrl(config.customLandscapeUrlPattern, ids, type, config, {
            userAgent: req.headers['user-agent'] || '',
            landscape: meta.landscapePoster,
          });
          if (resolved) {
            if (config.usePosterProxy) {
              const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
              if (proxyId) {
                meta.landscapePoster = buildProxyArtUrl({ base: `${host}/poster-cache/proxy`, imageClass: 'landscape', type: type, id: proxyId, fallback: meta.landscapePoster, url: resolved });
              } else {
                meta.landscapePoster = resolved;
              }
            } else {
              meta.landscapePoster = resolved;
            }
          }
        }
        if (config.customLogoUrlPattern) {
          const resolved = resolveCustomArtUrl(config.customLogoUrlPattern, ids, type, config, {
            userAgent: req.headers['user-agent'] || '',
            logo: meta.logo,
          });
          if (resolved) {
            if (config.usePosterProxy) {
              const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
              if (proxyId) {
                meta.logo = buildProxyArtUrl({ base: `${host}/poster-cache/proxy`, imageClass: 'logo', type: type, id: proxyId, fallback: meta.logo, url: resolved });
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
  config.addonIdentifier = req.addonIdentifier || userUUID;

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
    if (type === 'series' && stremioId && stremioId.startsWith('pmdb_resume_')) {
      const catalogConfig = fullConfig.catalogs?.find(c => c.id === 'publicmetadb.upnext');
      if (catalogConfig?.metadata?.useShowPosterForUpNext !== undefined) {
        useShowPoster = catalogConfig.metadata.useShowPosterForUpNext;
      }
    }
    if (type === 'series' && stremioId && stremioId.startsWith('simkl_upnext_')) {
      const catalogConfig = fullConfig.catalogs?.find(c => c.id.startsWith('simkl.upnext')
        && c.metadata?.useShowPosterForUpNext !== undefined);
      if (catalogConfig) {
        useShowPoster = catalogConfig.metadata.useShowPosterForUpNext;
      }
    }
    let result = await cacheWrapMetaSmart(
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
      const canonicalFallbackId = extractCanonicalIdFromDynamicUpNextId(type, stremioId);
      if (canonicalFallbackId) {
        consola.debug(`[Meta Route] Falling back from stale Up Next ID ${stremioId} to canonical ID ${canonicalFallbackId}`);
        result = await cacheWrapMetaSmart(
          userUUID,
          canonicalFallbackId,
          async () => {
            return await getMeta(type, language, canonicalFallbackId, fullConfig, userUUID, true);
          },
          undefined,
          cacheOptions,
          type,
          true,
          false
        );
      }
    }

    if (!result || !result.meta) {
      return respond(req, res, { meta: null });
    }

    {
      const userAgent = req.headers['user-agent'] || '';
      const host = process.env.HOST_NAME.startsWith('http') ? process.env.HOST_NAME : `https://${process.env.HOST_NAME}`;
      const { resolveCustomArtUrl, resolvePosterPattern, resolveThumbnailPattern, getPosterRatingApiKey } = require('./utils/parseProps');
      const ids = extractIdsFromMeta(result.meta);
      const metaType = result.meta.type || type;
      // Apply poster pattern unless enableRatingPostersForLibrary is explicitly disabled
      if (config.enableRatingPostersForLibrary !== false) {
        const metaPosterPattern = resolvePosterPattern(config);
        if (metaPosterPattern) {
          const proxyApiKey = config.usePosterProxy ? getPosterRatingApiKey(config) : null;
          if (proxyApiKey) {
            const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
            if (proxyId) {
              result.meta.poster = buildProxyArtUrl({ base: `${host}/poster-cache/proxy`, imageClass: 'poster', type: metaType, id: proxyId, fallback: result.meta.poster, ratingKey: proxyApiKey, lang: config.language });
            }
          } else {
            const resolved = resolveCustomArtUrl(metaPosterPattern, ids, metaType, config, { userAgent });
            if (resolved) {
              if (config.usePosterProxy) {
                const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
                if (proxyId) {
                  result.meta.poster = buildProxyArtUrl({ base: `${host}/poster-cache/proxy`, imageClass: 'poster', type: metaType, id: proxyId, fallback: result.meta.poster, url: resolved });
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
              result.meta.background = buildProxyArtUrl({ base: `${host}/poster-cache/proxy`, imageClass: 'background', type: metaType, id: proxyId, fallback: result.meta.background, url: resolved });
            } else {
              result.meta.background = resolved;
            }
          } else {
            result.meta.background = resolved;
          }
        }
      }
      if (config.customLandscapeUrlPattern) {
        const resolved = resolveCustomArtUrl(config.customLandscapeUrlPattern, ids, metaType, config, {
          userAgent,
          landscape: result.meta.landscapePoster,
        });
        if (resolved) {
          if (config.usePosterProxy) {
            const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
            if (proxyId) {
              result.meta.landscapePoster = buildProxyArtUrl({ base: `${host}/poster-cache/proxy`, imageClass: 'landscape', type: metaType, id: proxyId, fallback: result.meta.landscapePoster, url: resolved });
            } else {
              result.meta.landscapePoster = resolved;
            }
          } else {
            result.meta.landscapePoster = resolved;
          }
        }
      }
      if (config.customLogoUrlPattern) {
        const resolved = resolveCustomArtUrl(config.customLogoUrlPattern, ids, metaType, config, {
          userAgent,
          logo: result.meta.logo,
        });
        if (resolved) {
          if (config.usePosterProxy) {
            const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
            if (proxyId) {
              result.meta.logo = buildProxyArtUrl({ base: `${host}/poster-cache/proxy`, imageClass: 'logo', type: metaType, id: proxyId, fallback: result.meta.logo, url: resolved });
            } else {
              result.meta.logo = resolved;
            }
          } else {
            result.meta.logo = resolved;
          }
        }
      }
      // Apply thumbnail pattern to episode videos
      const thumbnailPattern = resolveThumbnailPattern(config);
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
                if (config.usePosterProxy) {
                  const proxyId = ids.imdbId || (ids.tmdbId ? `tmdb:${ids.tmdbId}` : (ids.tvdbId ? `tvdb:${ids.tvdbId}` : null));
                  // Episode thumbnails share the show's proxyId; the per-episode url param keeps the proxy cache/etag distinct.
                  video.thumbnail = proxyId
                    ? buildProxyArtUrl({ base: `${host}/poster-cache/proxy`, imageClass: 'background', type: metaType, id: proxyId, fallback: originalThumb, url: resolved })
                    : resolved;
                } else {
                  video.thumbnail = resolved;
                }
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
    
    if (hasAnyWatchTrackingEnabled(config)) {
      // Import and call subtitle handler
      const { handleSubtitleRequest } = require('./lib/subtitleHandler');
      
      // Call handler synchronously (no await)
      const result = handleSubtitleRequest(type, id, config, userUUID);
      
      // Return empty subtitle response immediately
      return respond(req, res, result, { cacheMaxAge: 0 });
    } else {
      // Watch tracking disabled or no credentials - return empty subtitles
      consola.debug(`[Watch Tracking] Skipped for user ${userUUID} - no service has an enabled media type and valid credentials`);
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
            const ids: any = {};
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
          const ids: any = {};
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

function isProcessedImageCacheEnabled() {
  return posterCacheConfig.isClassEnabled('processed');
}


async function readEntryBytes(entry) {
  if (entry.body) return entry.body;
  const chunks = [];
  for await (const chunk of entry.openStream()) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function produceProcessedBytes(bareUrl, fetchFallback) {
  const posterCacheStore = require('./lib/posterCache/store.js');
  const migrated = await posterCacheStore.get('poster', bareUrl);
  if (migrated && !migrated.expired) {
    return {
      body: await readEntryBytes(migrated),
      contentType: migrated.contentType,
      upstream: migrated.upstream,
    };
  }
  return fetchFallback();
}

async function sendCachedImage(res, result, fallbackContentType?) {
  const { entry } = result;
  res.setHeader('X-Cache-Status', result.status);
  res.setHeader('Content-Type', entry.contentType || fallbackContentType || 'image/jpeg');
  res.setHeader('Content-Length', String(entry.size));
  if (entry.body) {
    res.end(entry.body);
    return;
  }
  await stream.promises.pipeline(entry.openStream(), res);
}

// The `blur:` and `b2b:` transforms: rendered locally from an already-cached
// source, so they carry no upstream headers to follow.
async function cacheProcessedImage(cacheKey, contentType, produce) {
  const posterCacheStore = require('./lib/posterCache/store.js');
  return posterCacheStore.getOrFetch('processed', cacheKey, async () => {
    const chunks = [];
    const sink = new stream.PassThrough();
    sink.on('data', (chunk) => chunks.push(chunk));
    const drained = new Promise((resolve, reject) => {
      sink.on('end', resolve);
      sink.on('error', reject);
    });
    await produce(sink);
    await drained;
    return { body: Buffer.concat(chunks), contentType };
  });
}

const refusalsWarned = new Set();
function warnRefusedOrigin(context, message) {
  const line = `${context}: ${message}`;
  if (refusalsWarned.has(line) || refusalsWarned.size >= 20) return;
  refusalsWarned.add(line);
  consola.warn(
    `${line}. If that host is yours, add it to POSTER_CACHE_ALLOWED_HOSTS, or set ` +
    `IMAGE_PROXY_SIGNING_SECRET (or ADMIN_KEY) so the addon signs the art URLs it issues.`
  );
}

const handlePosterProxy = async function (req, res) {
  const { type, id } = req.params;
  const { fallback, lang, key, url: customUrl, sig } = req.query;
  const sendFallback = () => (fallback ? res.redirect(302, fallback) : res.status(404).end());
  if (!key && !customUrl) {
    return sendFallback();
  }
  try {
    let posterUrl = customUrl || null;

    if (!posterUrl) {
      posterUrl = resolveProxyRatingPosterUrl(type, id, lang, key, fallback);
    }

    if (!posterUrl) {
      return sendFallback();
    }

    const isRatingPoster = !customUrl;
    const bypassed = posterCacheConfig.isBypassed(posterUrl);
    const allowPrivateHost = customUrl ? proxyArtUrlVouched(customUrl, sig) : true;
    if (!bypassed && (isRatingPoster ? isProcessedImageCacheEnabled() : posterCacheConfig.isClassEnabled('poster'))) {
      const posterCacheStore = require('./lib/posterCache/store.js');
      const { fetchImage } = require('./lib/posterCache/upstream.js');
      const fetchUpstream = (validators) => fetchImage(posterUrl, { allowPrivateHost, validators });
      const result = isRatingPoster
        ? await posterCacheStore.getOrFetch('processed', `rating-poster:${posterUrl}`, (validators) => produceProcessedBytes(posterUrl, () => fetchUpstream(validators)))
        : await posterCacheStore.getOrFetch('poster', posterUrl, fetchUpstream);
      return await serveStoreResult(req, res, {
        imageClass: 'poster',
        url: posterUrl,
        result,
        send: (served) => sendCachedImage(res, served),
      });
    }

    const openUpstream = openArtStream({ url: posterUrl, allowPrivateHost, minContentLength: 100 });
    await servePassThrough(req, res, {
      imageClass: 'poster',
      url: posterUrl,
      bypassed,
      open: async (validators) => {
        const imageResponse = await openUpstream(validators);
        if (bypassed && posterCacheConfig.isBuiltinPosterCacheEnabled()) {
          require('./lib/posterCache/handler.js').recordServe('poster', 'BYPASS', 0, req.method, posterUrl);
        }
        return imageResponse;
      },
    });
  } catch (error) {
    if (posterCacheConfig.isBuiltinPosterCacheEnabled()) require('./lib/posterCache/handler.js').recordServeError();
    const isTimeout = error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '');
    const status = error.response?.status ?? error.status;
    if (isTimeout) {
      consola.warn(`Poster proxy timed out for ${id}, serving fallback:`, error.message);
    } else if (status === 404) {
      consola.debug(`No art for ${id} at the poster provider, serving fallback`);
    } else if (status === 403) {
      warnRefusedOrigin(`Poster proxy refused ${id}`, error.message);
    } else {
      consola.error(`Error in poster proxy for ${id}:`, error.message);
    }
    sendFallback();
  }
};
addon.get("/poster/:type/:id", handlePosterProxy);

function streamArtWithFallback(assetName) {
  return async function (req, res) {
    const { id } = req.params;
    const { fallback, url: customUrl, sig } = req.query;
    if (!customUrl) {
      return res.redirect(302, fallback || '');
    }
    const bypassed = posterCacheConfig.isBypassed(customUrl);
    // A property of the URL, not of whether we are storing it — see handlePosterProxy.
    const allowPrivateHost = proxyArtUrlVouched(customUrl, sig);
    try {
      if (posterCacheConfig.isClassEnabled(assetName) && !bypassed) {
        const posterCacheStore = require('./lib/posterCache/store.js');
        const { fetchImage } = require('./lib/posterCache/upstream.js');
        const result = await posterCacheStore.getOrFetch(assetName, customUrl, (validators) =>
          fetchImage(customUrl, { allowPrivateHost, validators }));
        return await serveStoreResult(req, res, {
          imageClass: assetName,
          url: customUrl,
          result,
          send: (served) => sendCachedImage(res, served),
        });
      }

      // No size floor here: a 1×1 logo is small but legitimate.
      const openUpstream = openArtStream({ url: customUrl, allowPrivateHost });
      await servePassThrough(req, res, {
        imageClass: assetName,
        url: customUrl,
        bypassed,
        open: async (validators) => {
          const imageResponse = await openUpstream(validators);
          if (bypassed && posterCacheConfig.isBuiltinPosterCacheEnabled()) {
            require('./lib/posterCache/handler.js').recordServe(assetName, 'BYPASS', 0, req.method, customUrl);
          }
          return imageResponse;
        },
      });
    } catch (error) {
      if (posterCacheConfig.isBuiltinPosterCacheEnabled()) require('./lib/posterCache/handler.js').recordServeError();
      if (error.status === 403) {
        warnRefusedOrigin(`Art proxy refused ${assetName} ${id}`, error.message);
      } else {
        consola.debug(`Art proxy miss for ${assetName} ${id}: ${error.message}`);
      }
      if (fallback) {
        return res.redirect(302, fallback);
      }
      res.status(404).end();
    }
  };
}

addon.get("/logo/:type/:id", streamArtWithFallback('logo'));
addon.get("/background/:type/:id", streamArtWithFallback('background'));

addon.get("/poster-cache/proxy/poster/:type/:id", handlePosterProxy);
addon.get("/poster-cache/proxy/logo/:type/:id", streamArtWithFallback('logo'));
addon.get("/poster-cache/proxy/background/:type/:id", streamArtWithFallback('background'));
addon.get("/poster-cache/proxy/landscape/:type/:id", streamArtWithFallback('landscape'));

{
  const { posterCacheHandler } = require('./lib/posterCache/handler.js');
  addon.use(posterCacheConfig.POSTER_CACHE_ROUTE, posterCacheHandler());
}


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
    if (isProcessedImageCacheEnabled()) {
      const result = await cacheProcessedImage(`blur:${imageUrl}`, 'image/jpeg', (sink) => blurImage(imageUrl, sink));
      return await sendCachedImage(res, result, 'image/jpeg');
    }
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
    if (isProcessedImageCacheEnabled()) {
      const optionsKey = `${options.width}:${options.height}:${options.blur}:${options.brightness}:${options.contrast}:${options.position}`;
      const result = await cacheProcessedImage(
        `b2b:${imageUrl}:${optionsKey}`,
        'image/jpeg',
        (sink) => convertBannerToBackground(imageUrl, options, sink)
      );
      return await sendCachedImage(res, result, 'image/jpeg');
    }
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
        
        // Try to get metadata from cache using the canonical key
        const canonicalKey = requestTracker.canonicalContentMetadataKey(stremioType, id);
        
        let metadataStr = null;
        try {
          metadataStr = await redis.get(canonicalKey);
        } catch (_) {}

        
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

const clientAssetsDir = path.join(clientDistDir, 'assets');
function setClientDistCacheHeaders(res, filePath) {
  if (filePath.startsWith(clientAssetsDir + path.sep)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (path.basename(filePath) === 'index.html') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}

addon.use(favicon(path.join(publicDir, 'favicon.png')));
addon.use('/configure', express.static(clientDistDir, { setHeaders: setClientDistCacheHeaders }));
addon.use(express.static(publicDir));
addon.use(express.static(clientDistDir, { setHeaders: setClientDistCacheHeaders }));

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
addon.post('/api/admin/prune-id-mappings', requireDashboardAdmin, async (req, res) => {
  try {
    await database.pruneAllIdMappings();
    res.json({ success: true, message: 'All id_mappings pruned.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- Admin: User Management Endpoints ---

// Get all users with basic info
addon.get('/api/admin/users', requireDashboardAdmin, async (req, res) => {
  
  try {
    const users = await database.getAllUsersWithStats();
    res.json({ users });
  } catch (error) {
    consola.error('[Admin API] Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get detailed user information
// Export all user data
addon.get('/api/admin/users/export', requireDashboardAdmin, async (req, res) => {
  
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

addon.get('/api/admin/users/:userUUID', requireDashboardAdmin, async (req, res) => {
  
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
addon.post('/api/admin/users/:userUUID/reset-password', requireDashboardAdmin, async (req, res) => {
  
  try {
    const { userUUID } = req.params;
    const { newPassword: providedPassword } = req.body || {};
    const newPassword = await database.resetUserPassword(userUUID, providedPassword);

    if (!newPassword) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ success: true });
  } catch (error) {
    consola.error('[Admin API] Error resetting password:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Set a user's alias
addon.put('/api/admin/users/:userUUID/alias', requireDashboardAdmin, async (req, res) => {
  const { isAliasFeatureEnabled, setAliasForUser } = require('./lib/aliasResolver.js');
  if (!isAliasFeatureEnabled()) {
    return res.status(403).json({ error: 'User aliases are disabled on this instance (USER_ALIASES_ENABLED).' });
  }

  try {
    const { userUUID } = req.params;
    const { alias } = req.body || {};
    const result = await setAliasForUser(userUUID, alias);

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    res.json({ success: true, alias: result.alias });
  } catch (error) {
    consola.error('[Admin API] Error setting alias:', error);
    res.status(500).json({ error: 'Failed to set alias' });
  }
});

// Remove a user's alias
addon.delete('/api/admin/users/:userUUID/alias', requireDashboardAdmin, async (req, res) => {
  const { isAliasFeatureEnabled, clearAliasForUser } = require('./lib/aliasResolver.js');
  if (!isAliasFeatureEnabled()) {
    return res.status(403).json({ error: 'User aliases are disabled on this instance (USER_ALIASES_ENABLED).' });
  }

  try {
    const { userUUID } = req.params;
    const removed = await clearAliasForUser(userUUID);

    if (!removed) {
      return res.status(404).json({ error: 'User has no alias' });
    }

    res.json({ success: true });
  } catch (error) {
    consola.error('[Admin API] Error clearing alias:', error);
    res.status(500).json({ error: 'Failed to clear alias' });
  }
});

// Delete user
addon.delete('/api/admin/users/:userUUID', requireDashboardAdmin, async (req, res) => {
  
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


// Bulk delete inactive users
addon.post('/api/admin/users/bulk-delete-inactive', requireDashboardAdmin, async (req, res) => {
  
  try {
    const { days = 30 } = req.body;
    const deletedCount = await database.deleteInactiveUsers(days);
    res.json({ deletedCount, message: `${deletedCount} inactive users deleted` });
  } catch (error) {
    consola.error('[Admin API] Error deleting inactive users:', error);
    res.status(500).json({ error: 'Failed to delete inactive users' });
  }
});

addon.get("/api/debug/catalogs/:userUUID", requireDashboardAdmin, async function (req, res) {
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

    // Deleting is irreversible, so the password is asked for again even when the
    // account already owns this configuration.
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

// Test granular caching
addon.post('/api/cache/test-granular', async (req, res) => {
  try {
    const { userUUID, metaId, type } = req.body;
    
    if (!userUUID || !metaId || !type) {
      return res.status(400).json({ error: 'userUUID, metaId, and type are required' });
    }
    
    const { reconstructMetaFromComponents } = require('./lib/getCache');
    
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

    if (!userUUID) {
      return res.status(400).json({ error: 'userUUID is required' });
    }

    const access = await resolveConfigAccess(req, userUUID, password);
    if (!access) {
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
addon.get('/api/cache/test-essential', requireDashboardAdmin, async (req, res) => {
  
  try {
    // Jikan and genre lists are raw upstream payloads cached with `upstream`, so
    // they carry no prefix at all; only the language list is epoch-keyed. (This list
    // previously prefixed every entry with the addon version and so never matched.)
    const essentialKeys = [
      `global:jikan-api:anime-genres`,
      `global:jikan-api:mal-studios`,
      `global:genre:tmdb:en-US:movie`,
      `global:genre:tmdb:en-US:series`,
      `global:genre:tvdb:en-US:series`,
      withGlobalEpoch(`languages:en-US`)
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

addon.get('/api/cache/invalidation-status/:userUUID', requireDashboardAdmin, async (req, res) => {
  try {
    const { userUUID } = req.params;
    
    // Count cache entries for this user
    const userCachePattern = `*${userUUID}*`;
    // Group by cache type
    const cacheStats: any = {
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
function nameList(names) {
  const shown = names.slice(0, 5).join(', ');
  return names.length > 5 ? `${shown} and ${names.length - 5} more` : shown;
}

function describeAdminImpact(impact) {
  const parts = [];
  if (impact.signedOut.length > 0) parts.push(`sign out ${nameList(impact.signedOut)}`);
  if (impact.demoted.length > 0) {
    parts.push(`take the admin permission away from ${nameList(impact.demoted)}, immediately and without signing them out`);
  }
  if (parts.length < 2) return parts.join('');
  return `${parts.slice(0, -1).join('; ')}; and ${parts[parts.length - 1]}`;
}

function describeOthers(impact) {
  const described = describeAdminImpact(impact);
  return described ? ` It would also ${described}.` : '';
}

async function describeSelfDemotion(req, key, proposedValue, confirmed) {
  if (confirmed === true) return null;
  if (!key || !key.startsWith('OIDC_')) return null;

  const { previewPermissions } = require('./lib/oidc');
  const { accountsLosingAdmin, emptyAdminImpact } = require('./lib/authRoutes');

  if (previewPermissions([], key, proposedValue).outcome === 'malformed') {
    return {
      error: 'This value cannot be read',
      requiresConfirmation: true,
      reason: `${key} would be saved but not understood, so no sign-in would be allowed at all until it is fixed, and everyone already signed in would keep the permissions they have now.`,
    };
  }

  let others = emptyAdminImpact();
  try {
    others = await accountsLosingAdmin(key, proposedValue, req.session?.accountId);
  } catch (error) {
    consola.warn(`[Settings] Could not work out who else would lose admin: ${error.message}`);
  }

  const session = req.session;
  if (session && Array.isArray(session.groups) && hasPermission(req, 'admin')) {
    const preview = previewPermissions(session.groups, key, proposedValue);

    if (preview.outcome === 'unconfigured' || preview.outcome === 'refused') {
      return {
        error: 'This change would end your own session',
        requiresConfirmation: true,
        reason: `Saving ${key} would sign you out of this dashboard. If no ADMIN_KEY is set on this instance you may not be able to get back in.${describeOthers(others)}`,
      };
    }
    if (!preview.permissions.includes('admin')) {
      return {
        error: 'This change would remove your own admin access',
        requiresConfirmation: true,
        reason: `Saving ${key} would leave your account without the admin permission, so you would lose the dashboard immediately.${describeOthers(others)}`,
      };
    }
  }

  const described = describeAdminImpact(others);
  if (described) {
    return {
      error: 'This change would remove someone else\'s admin access',
      requiresConfirmation: true,
      reason: `Saving ${key} would ${described}.`,
    };
  }

  return null;
}

function requireDashboardAdmin(req, res, next) {
  // A signed-in administrator needs no key. ADMIN_KEY stays the way in when the
  // identity provider is unreachable or SSO was never set up.
  if (hasPermission(req, 'admin')) {
    return next();
  }

  const adminKey = process.env.ADMIN_KEY;

  // If ADMIN_KEY is not configured, deny access with specific message
  if (!adminKey) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: isOidcConfigured()
        ? 'ADMIN_KEY environment variable must be configured to access the dashboard with a key. Sign in with the identity provider instead, using an account holding the admin permission.'
        : 'ADMIN_KEY environment variable must be configured to access the dashboard, or configure an identity provider to sign in without one.'
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
    
    const { buildOverviewSignals } = require('./lib/dashboardSignals.js');
    const [systemOverview, quickStats] = await Promise.all([
      dashboardApi.getSystemOverview(),
      dashboardApi.getQuickStats(),
    ]);
    const signals = await buildOverviewSignals(dashboardApi, { tz: req.query.tz || null, systemOverview });

    const data = {
      systemOverview,
      quickStats,
      signals,
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

addon.get("/api/dashboard/logs", requireDashboardAdmin, (req, res) => {
  try {
    const { getLogEntries, getLogTags, getLogServices } = require('./lib/logBuffer.js');
    const afterCursor = req.query.afterCursor ? parseInt(req.query.afterCursor, 10) : 0;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 200;
    const { entries, cursor, newestId } = getLogEntries({
      afterCursor,
      level: req.query.level || undefined,
      tag: req.query.tag || undefined,
      search: req.query.search || undefined,
      service: req.query.service || undefined,
      limit,
    });
    res.json({ entries, cursor, newestId, tags: getLogTags(), services: getLogServices() });
  } catch (error) {
    consola.error('[Dashboard API] Logs error:', error);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

addon.get("/api/dashboard/logs/stream", requireDashboardAdmin, (req, res) => {
  const { subscribeToLogs, buildLogFilter, getLogEntries, getBufferStats, getLogQueryMaxEntries } = require('./lib/logBuffer.js');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const afterCursor = req.query.afterCursor ? parseInt(req.query.afterCursor, 10) : 0;
  const filterOpts = {
    level: req.query.level || undefined,
    tag: req.query.tag || undefined,
    search: req.query.search || undefined,
    service: req.query.service || undefined,
  };
  const match = buildLogFilter(filterOpts);

  // Replay buffered history after the cursor, then subscribe for live entries.
  // Both run synchronously with no await between them, so no entry can be pushed
  // in the gap (single-threaded) — the backfill->live handoff is gapless and
  // non-overlapping, which lets the client rely on the stream alone (no poll).
  const replay = getLogEntries({ afterCursor, ...filterOpts, limit: getLogQueryMaxEntries() });
  for (const entry of replay.entries) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
  res.write(`event: ready\ndata: ${JSON.stringify({ newestId: getBufferStats().newestId })}\n\n`);

  const MAX_SOCKET_BUFFER = 1024 * 1024; // drop rather than buffer unboundedly for a slow client
  let dropped = 0;
  const unsubscribe = subscribeToLogs((entry) => {
    if (!match(entry)) return;
    if (res.writableLength > MAX_SOCKET_BUFFER) { dropped++; return; }
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  });

  const heartbeat = setInterval(() => {
    res.write(`: ping${dropped ? ` dropped=${dropped}` : ''}\n\n`);
  }, 25000);
  heartbeat.unref?.();

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
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

    const cached = timingMetrics.getCachedResponse();
    if (cached) {
      return res.json(cached);
    }

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

    const response = {
      dashboard: dashboardData,
      providerBreakdown,
      resolutionBreakdown,
      timingTrends,
      imdbRatingsStats,
      idResolverPerformance: idResolverStats,
      lastUpdated: new Date().toISOString()
    };
    timingMetrics.setCachedResponse(response);
    res.json(response);
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

addon.post("/api/dashboard/cache/clear-by-id", requireDashboardAdmin, async (req, res) => {
  try {
    const { token, dryRun, includeColdStore } = req.body || {};
    const result = await getDashboardAPI().clearCacheByToken(token, {
      dryRun: !!dryRun,
      // Default on, so existing callers keep the combined behavior.
      includeColdStore: includeColdStore !== false,
    });
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    consola.error('[Dashboard API] Error:', error);
    return res.status(500).json({ error: 'Failed to clear cache entries' });
  }
});

addon.post("/api/dashboard/poster-cache/purge", requireDashboardAdmin, async (req, res) => {
  const requestedType = req.body?.type;
  const askedForDomain = typeof req.body?.domain === 'string';

  if (posterCacheConfig.isBuiltinPosterCacheEnabled()) {
    if (requestedType !== undefined && !posterCacheConfig.isValidImageClass(requestedType)) {
      return res.status(400).json({ error: `Unknown image type: ${requestedType}` });
    }
    try {
      const posterCacheStore = require('./lib/posterCache/store.js');
      if (askedForDomain) {
        try {
          const status = posterCacheStore.startDomainPurge(req.body.domain);
          consola.info(`[API] Poster cache domain purge started: ${status.domain}`);
          return res.status(202).json({ success: true, ...status });
        } catch (error) {
          return res.status(400).json({
            success: false, message: error.message, domain: req.body.domain, removed: 0, freed_bytes: 0,
          });
        }
      }
      const result = await posterCacheStore.purge(requestedType);
      consola.info(`[API] Poster cache purge requested via dashboard (${requestedType || 'all'})`);
      return res.json(result);
    } catch (error) {
      consola.error('[API] Poster cache purge failed:', error.message);
      return res.status(500).json({ error: 'Failed to purge poster cache', details: error.message });
    }
  }

  // Standalone nginx proxy (README Option B) — purge over HTTP as before.
  const posterCacheUrl = posterCacheConfig.getPosterWarmupBase();
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

addon.post("/api/dashboard/poster-cache/invalidate-by-id", requireDashboardAdmin, async (req, res) => {
  if (!posterCacheConfig.isBuiltinPosterCacheEnabled()) {
    return res.status(400).json({ error: 'The built-in image cache is not enabled' });
  }

  const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
  if (!id) {
    return res.status(400).json({ error: 'A media id is required' });
  }

  try {
    const posterCacheStore = require('./lib/posterCache/store.js');
    res.json(await posterCacheStore.invalidateByMediaId(id));
  } catch (error) {
    consola.error('[Poster cache] Invalidate by id failed:', error.message);
    res.status(500).json({ error: 'Failed to clear art for that id' });
  }
});

addon.post("/api/dashboard/poster-cache/invalidate", requireDashboardAdmin, async (req, res) => {
  if (!posterCacheConfig.isBuiltinPosterCacheEnabled()) {
    return res.status(400).json({ error: 'The built-in image cache is not enabled' });
  }

  const raw = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!raw) {
    return res.status(400).json({ error: 'An image URL is required' });
  }

  const requestedType = req.body?.type;
  if (requestedType !== undefined && !posterCacheConfig.isValidImageClass(requestedType)) {
    return res.status(400).json({ error: `Unknown image type: ${requestedType}` });
  }

  // Accept a pasted /poster-cache/... URL as readily as the upstream URL itself —
  // the cache URL is what an admin has in front of them when an image looks wrong.
  let target = raw;
  let parsedType = requestedType;
  const marker = `${posterCacheConfig.POSTER_CACHE_ROUTE}/`;
  const markerAt = raw.indexOf(marker);
  if (markerAt >= 0) {
    const afterMount = raw.slice(markerAt + marker.length - 1);
    const proxyRoute = /^\/proxy\/(poster|logo|background|landscape)\//.exec(afterMount);
    if (proxyRoute) {
      let customUrl = null;
      try {
        customUrl = new URL(raw, 'http://addon.invalid').searchParams.get('url');
      } catch { /* ignore */ }
      if (!customUrl) {
        return res.status(400).json({
          error: 'That art-proxy URL has no url= parameter to refresh. Rating-provider posters are keyed by the generated provider URL — paste that, or clear the Processed Images type.',
        });
      }
      target = customUrl;
      if (!parsedType) parsedType = proxyRoute[1];
    } else {
      const { parsePosterCachePath } = require('./lib/posterCache/handler.js');
      const parsed = parsePosterCachePath(afterMount);
      if (!parsed) {
        return res.status(400).json({ error: 'Could not read an image URL out of that cache URL' });
      }
      target = parsed.url;
      if (!parsedType) parsedType = parsed.imageClass;
    }
  }

  try {
    const posterCacheStore = require('./lib/posterCache/store.js');
    const result = await posterCacheStore.invalidate(target, parsedType);

    const removed = [...result.removed];
    let freed = result.freed_bytes;
    for (const prefix of ['rating-poster', 'logo', 'background']) {
      const legacy = await posterCacheStore.invalidate(`${prefix}:${target}`, 'processed');
      if (legacy.removed.length) {
        if (!removed.includes('processed')) removed.push('processed');
        freed += legacy.freed_bytes;
      }
    }

    consola.info(`[API] Image cache invalidation for ${target} (${removed.join(', ') || 'not cached'})`);
    res.json({
      success: true,
      url: target,
      removed,
      freed_bytes: freed,
      message: removed.length
        ? `Removed from ${removed.join(', ')}; it will be re-fetched on the next request. Your player may still show its own copy until its cache expires.`
        : 'That image was not in the cache',
    });
  } catch (error) {
    consola.error('[API] Image cache invalidation failed:', error.message);
    res.status(500).json({ error: 'Failed to invalidate image', details: error.message });
  }
});

addon.get("/api/dashboard/poster-cache/stats", requireDashboardAdmin, async (req, res) => {
  if (posterCacheConfig.isBuiltinPosterCacheEnabled()) {
    const posterCacheStore = require('./lib/posterCache/store.js');
    return res.json({
      ...posterCacheStore.stats(),
      enabled_types: posterCacheConfig.getEnabledClasses(),
      known_providers: posterCacheConfig.KNOWN_ART_PROVIDERS,
      domain_purge: posterCacheStore.domainPurgeStatus(),
      provider_policies: posterCacheConfig.parseProviderPolicies(process.env.POSTER_CACHE_PROVIDER_POLICIES) || [],
      infer_ttl: posterCacheConfig.isInferTtlEnabled(),
      presets_enabled: posterCacheConfig.arePresetsEnabled(),
      follow_upstream: posterCacheConfig.followsUpstreamCacheControl(),
      passthrough_classes: posterCacheConfig.IMAGE_CLASSES.filter(
        (imageClass) => !posterCacheConfig.isClassEnabled(imageClass)
      ),
    });
  }

  const policyPayload = {
    builtin: false,
    known_providers: posterCacheConfig.KNOWN_ART_PROVIDERS,
    provider_policies: posterCacheConfig.parseProviderPolicies(process.env.POSTER_CACHE_PROVIDER_POLICIES) || [],
    presets_enabled: posterCacheConfig.arePresetsEnabled(),
    follow_upstream: posterCacheConfig.followsUpstreamCacheControl(),
    proxy_max_age_days: posterCacheConfig.getProxyMaxAgeDays(),
  };

  // Standalone nginx cannot report a per-type breakdown, so `by_type` is absent
  // here and the dashboard renders only the totals.
  const posterCacheUrl = posterCacheConfig.getPosterWarmupBase();
  if (!posterCacheUrl) {
    return res.json({ ...policyPayload, external: 'none' });
  }

  try {
    const response = await fetch(`${posterCacheUrl}/stats`);
    if (!response.ok) throw new Error(`Poster cache answered ${response.status}`);
    const stats: any = await response.json();
    res.json({ ...policyPayload, ...stats, external: 'ok' });
  } catch (error) {
    consola.debug(`[API] Poster cache stats unreachable at ${posterCacheUrl}: ${error.message}`);
    res.json({ ...policyPayload, external: 'unreachable' });
  }
});

// --- Meta Cold Store (disk L2 for stable metadata) ---
// Returns `enabled: false` rather than an error when the feature is off, so the
// dashboard can render a single explanatory panel instead of an error state.
addon.get("/api/dashboard/cold-store/stats", requireDashboardAdmin, (req, res) => {
  try {
    const metaColdStore = require('./lib/metaColdStore');
    const stats = metaColdStore.stats();
    const health = getCacheHealth();
    res.json({
      ...stats,
      configured: metaColdStore.isEnabled(),
      hits: health.coldStoreHits || 0,
      misses: health.coldStoreMisses || 0,
      componentsServed: health.coldStoreComponents || 0,
    });
  } catch (error) {
    consola.error('[API] Cold store stats failed:', error.message);
    res.status(500).json({ error: 'Failed to read cold store stats', details: error.message });
  }
});

addon.post("/api/dashboard/cold-store/purge", requireDashboardAdmin, async (req, res) => {
  // Omitting `metaId` drops the whole store; passing one drops just that title.
  const metaId = typeof req.body?.metaId === 'string' ? req.body.metaId.trim() : '';
  const includeRedis = metaId ? req.body?.includeRedis !== false : false;
  try {
    const metaColdStore = require('./lib/metaColdStore');
    const removed = metaId ? metaColdStore.invalidate(metaId) : metaColdStore.purge();

    let redisRemoved = 0;
    if (includeRedis) {
      try {
        redisRemoved = await getDashboardAPI().clearCacheForMetaId(metaId);
      } catch (redisErr) {
        consola.warn(`[API] Cold store purge: Redis clear failed for ${metaId}: ${redisErr.message}`);
      }
    }

    consola.info(`[API] Cold store purge via dashboard (${metaId || 'all'}): ${removed} row(s)`
      + (includeRedis ? `, ${redisRemoved} Redis key(s)` : ''));
    res.json({ success: true, removed, redisRemoved, metaId: metaId || null });
  } catch (error) {
    consola.error('[API] Cold store purge failed:', error.message);
    res.status(500).json({ error: 'Failed to purge cold store', details: error.message });
  }
});

addon.post("/api/dashboard/cold-store/sweep", requireDashboardAdmin, (req, res) => {
  try {
    const metaColdStore = require('./lib/metaColdStore');
    const removed = metaColdStore.sweep();
    consola.info(`[API] Cold store sweep via dashboard: ${removed} row(s)`);
    res.json({ success: true, removed });
  } catch (error) {
    consola.error('[API] Cold store sweep failed:', error.message);
    res.status(500).json({ error: 'Failed to sweep cold store', details: error.message });
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
    
    const tz = typeof req.query.tz === 'string' ? req.query.tz : null;
    const [stats, hourlyStats, topEndpoints, providerHourlyData, idResolverStats, cachePerformance, providerPerformance] = await Promise.all([
      requestTracker.getStats(tz),
      requestTracker.getHourlyStats(24, tz),
      requestTracker.getTopEndpoints(10),
      requestTracker.getHourlyProviderStats(24, tz),
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
    const limit = parseInt(req.query.limit) || 50;
    const timeframe = req.query.timeframe || 'today';
    const tz = typeof req.query.tz === 'string' ? req.query.tz : null;
    const days = timeframe === 'week' ? 7 : timeframe === 'month' ? 30 : timeframe === 'all' ? 30 : 1;
    Promise.all([
      requestTracker.getPopularContent(limit, days, tz),
      requestTracker.getSearchPatterns(limit, days, tz),
      requestTracker.getStats(tz)
    ]).then(([popularContent, searchPatterns, stats]) => {
      res.json({ 
        popularContent,
        searchPatterns,
        contentQuality: {
          missingMetadata: 0, // TODO: Implement real tracking
          failedMappings: 0,  // TODO: Implement real tracking
          correctionRequests: 0, // TODO: Implement real tracking
          successRate: parseFloat(String(100 - stats.errorRate))
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

addon.get("/api/dashboard/users/heatmap", requireDashboardAdmin, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 30);
    const tz = typeof req.query.tz === 'string' ? req.query.tz : null;
    const data = await requestTracker.getActivityHeatmap(days, tz);
    res.json(data);
  } catch (error) {
    consola.error('[Dashboard API] Heatmap error:', error);
    res.status(500).json({ error: 'Failed to fetch heatmap data' });
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
    
    let result: any = { success: false, message: '' };
    
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
    } else if (taskId === 12) { // Update animeApi overlay
      if (action === 'restart' || action === 'enable') {
        try {
          const { forceUpdateAnimeApi } = require('./lib/id-mapper');
          result = await forceUpdateAnimeApi();
          if (result.success) {
            result.message = `animeApi overlay updated successfully (${result.count.toLocaleString()} entries)`;
          }
        } catch (error) {
          consola.error('[Maintenance Task] Error updating animeApi overlay:', error);
          result = { success: false, message: `Failed to update animeApi overlay: ${error.message}` };
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
      } else if (action === 'warm-images') {
        const { forceWarmImages } = require('./lib/comprehensiveCatalogWarmer');
        forceWarmImages();
        result = { success: true, message: 'Image warming started, catalog schedule left unchanged' };
      } else if (action === 'sync-ttl') {
        const { syncCatalogTtlToSchedule } = require('./lib/comprehensiveCatalogWarmer');
        result = await syncCatalogTtlToSchedule();
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


// --- Admin: Settings Management ---
const settingsService = require('./lib/settingsService');

addon.get('/api/dashboard/settings', requireDashboardAdmin, (req, res) => {
  res.json({ settings: settingsService.getAllSettings(), canRestart: canUiRestart() });
});

addon.put('/api/dashboard/settings/:key', requireDashboardAdmin, async (req, res) => {
  try {
    const { value, confirm } = req.body || {};
    if (value === undefined) return res.status(400).json({ error: 'Missing value' });
    const block = await describeSelfDemotion(req, req.params.key, String(value), confirm);
    if (block) return res.status(409).json(block);
    await settingsService.setSetting(req.params.key, String(value));
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

addon.post('/api/dashboard/settings/reset/:key', requireDashboardAdmin, async (req, res) => {
  try {
    const proposed = settingsService.previewSettingValue(req.params.key, null);
    const block = await describeSelfDemotion(req, req.params.key, proposed, req.body && req.body.confirm);
    if (block) return res.status(409).json(block);
    await settingsService.resetSetting(req.params.key);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

function canUiRestart() {
  const flag = process.env.ENABLE_UI_RESTART;
  if (flag === 'true' || flag === '1') return true;
  if (flag === 'false' || flag === '0') return false;
  try {
    return require('fs').existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

const SERVER_BOOT_ID = require('crypto').randomBytes(8).toString('hex');

addon.get('/api/dashboard/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), bootId: SERVER_BOOT_ID });
});

addon.post('/api/dashboard/restart', requireDashboardAdmin, (req, res) => {
  if (!canUiRestart()) {
    return res.status(400).json({ error: 'UI restart is not available in this environment' });
  }
  consola.warn('[Dashboard] Restart requested from UI');
  res.json({ success: true });
  setTimeout(() => {
    try {
      process.kill(process.pid, 'SIGTERM');
    } catch {
      process.exit(0);
    }
  }, 500);
});

addon.use((err, req, res, next) => {
  if (respondIfSigninRequired(err, res)) return;
  next(err);
});

// Blocking startup function that waits for cache warming
async function startServerWithCacheWarming() {
  if (isCacheWarmingEnabled()) {
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

export {
  addon, startServerWithCacheWarming, getDashboardAPI, applyImageCachePrefix,
  startEssentialWarmingSchedules, startMovieLensSyncSchedule,
};
