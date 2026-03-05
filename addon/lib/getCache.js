// FILE: lib/getCache.js

const packageJson = require('../../package.json');
const redis = require('./redisClient');
const { loadConfigFromDatabase } = require('./configApi');
const consola = require('consola');
const idMapper = require('./id-mapper');
const crypto = require('crypto');
const { isMetricsDisabled } = require('./metricsConfig');

// Helper to hash config
function hashConfig(configObj) {
  const str = typeof configObj === 'string' ? configObj : stableStringify(configObj);
  return crypto.createHash('md5').update(str).digest('hex').substring(0, 10);
}

// Create tagged loggers
const cacheLogger = consola.withTag('Cache');
const globalCacheLogger = consola.withTag('Global-Cache');
const selfHealingLogger = consola.withTag('Self-Healing');
const cacheHealthLogger = consola.withTag('Cache-Health');

function parsePositiveIntEnv(envValue, defaultValue, minValue = 1, maxValue = 1000000) {
  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed < minValue) {
    return defaultValue;
  }
  return Math.min(parsed, maxValue);
}


const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const GLOBAL_NO_CACHE = process.env.NO_CACHE === 'true';
const ADDON_VERSION = packageJson.version;

// --- Time To Live (TTL) constants in seconds ---
const META_TTL = parseInt(process.env.META_TTL || 7 * 24 * 60 * 60, 10);
const CATALOG_TTL = parseInt(process.env.CATALOG_TTL || 1 * 24 * 60 * 60, 10);
const TMDB_TRENDING_TTL = parseInt(process.env.TMDB_TRENDING_TTL || 3 * 60 * 60, 10);
const JIKAN_API_TTL = 1 * 24 * 60 * 60;
const STATIC_CATALOG_TTL = 30 * 24 * 60 * 60;
const TVDB_API_TTL = 12 * 60 * 60;
const TVMAZE_API_TTL = 12 * 60 * 60;
const MDBLIST_GENRES_TTL = 30 * 24 * 60 * 60; // Cache MDBList genres for 30 days
const STREMTHRU_GENRES_TTL = 7 * 24 * 60 * 60; // Cache StremThru genres for 7 days
const ANILIST_CATALOG_TTL = parseInt(process.env.ANILIST_CATALOG_TTL || 1 * 60 * 60, 10); // Default 1 hour for AniList catalogs

// Store current request context for catalog/search operations
// This allows reconstruction to access the correct RPDB state
let currentRequestContext = {
  catalogConfig: null,
  searchEngine: null
};

// Enhanced error caching strategy with self-healing
const ERROR_TTL_STRATEGIES = {
  EMPTY_RESULT: 60,             // Don't cache empty results at all
  RATE_LIMITED: 15 * 60,       // 15 minutes for rate limit errors
  TEMPORARY_ERROR: 2 * 60,     // 2 minutes for temporary errors
  PERMANENT_ERROR: 30 * 60,    // 30 minutes for permanent errors
  NOT_FOUND: 60 * 60,          // 1 hour for not found errors
  CACHE_CORRUPTED: 1 * 60,     // 1 minute for corrupted cache entries
};

// Cache health monitoring
const cacheHealth = {
  hits: 0,
  misses: 0,
  errors: 0,
  cachedErrors: 0, // Track cached errors separately (not counted as hits)
  corruptedEntries: 0,
  lastHealthCheck: Date.now(),
  errorCounts: {},
  keyAccessCounts: new Map(),
};

// Self-healing configuration
const SELF_HEALING_CONFIG = {
  enabled: process.env.ENABLE_SELF_HEALING !== 'false',
  maxRetries: parsePositiveIntEnv(process.env.CACHE_MAX_RETRIES, 2),
  retryDelay: parsePositiveIntEnv(process.env.CACHE_RETRY_DELAY, 1000),
  healthCheckInterval: parsePositiveIntEnv(process.env.CACHE_HEALTH_CHECK_INTERVAL, 300000), // 5 minutes
  corruptedEntryThreshold: parsePositiveIntEnv(process.env.CACHE_CORRUPTED_THRESHOLD, 10)
};

const MAX_TRACKED_KEYS = parsePositiveIntEnv(process.env.MAX_TRACKED_KEYS, 30000, 100);
const KEYS_TO_KEEP_AFTER_PRUNE = Math.min(
  parsePositiveIntEnv(process.env.KEYS_TO_KEEP_AFTER_PRUNE, 6000, 10),
  Math.max(1, MAX_TRACKED_KEYS - 1)
);

const inFlightRequests = new Map();
const cacheValidator = require('./cacheValidator');
const { cache } = require('sharp');

/**
 * Safely delete Redis keys matching a pattern using SCAN and pipelined DELs to avoid memory/stack spikes
 * @param {string} pattern Redis key pattern (e.g., 'meta-*:*')
 * @param {object} options
 * @param {number} options.scanCount  Number of keys to request per SCAN iteration (default 1000)
 * @param {number} options.batchSize  Number of keys to delete per pipeline exec (default 500)
 * @returns {Promise<number>} total deleted keys
 */
async function deleteKeysByPattern(pattern, options = {}) {
  if (!redis) return 0;
  const scanCount = options.scanCount || 1000;
  const batchSize = options.batchSize || 500;
  let cursor = '0';
  let totalDeleted = 0;

  do {
    const res = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', scanCount);
    cursor = res[0];
    const keys = res[1] || [];
    if (keys.length === 0) continue;

    for (let i = 0; i < keys.length; i += batchSize) {
      const chunk = keys.slice(i, i + batchSize);
      const pipeline = redis.pipeline();
      for (const k of chunk) pipeline.del(k);
      await pipeline.exec();
      totalDeleted += chunk.length;
    }
  } while (cursor !== '0');

  return totalDeleted;
}

/**
 * Scan keys matching pattern and invoke callback per key.
 * @param {string} pattern
 * @param {function} cb callback(key) which can be async
 * @param {object} options
 * @param {number} options.scanCount default 1000
 */
async function scanKeys(pattern, cb, options = {}) {
  if (!redis) return 0;
  const scanCount = options.scanCount || 1000;
  let cursor = '0';
  let processed = 0;
  do {
    const res = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', scanCount);
    cursor = res[0];
    const keys = res[1] || [];
    for (const k of keys) {
      await cb(k);
      processed++;
    }
  } while (cursor !== '0');
  return processed;
}

// Helper: stable stringify to ensure consistent cache keys regardless of property insertion order
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => stableStringify(v)).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

// Lightweight stable hash for short log signatures
function shortSignature(input) {
  try {
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
      hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
    }
    // convert to unsigned and base36 for compactness
    return (hash >>> 0).toString(36);
  } catch {
    return 'na';
  }
}

// Helper to resolve art provider for specific art type
function resolveArtProvider(contentType, artType, config) {
  const artProviderConfig = config.artProviders?.[contentType];
  
  // Handle legacy string format
  if (typeof artProviderConfig === 'string') {
    return artProviderConfig === 'meta' 
      ? config.providers?.[contentType] || getDefaultProvider(contentType)
      : artProviderConfig;
  }
  
  // Handle new nested object format
  if (artProviderConfig && typeof artProviderConfig === 'object') {
    const provider = artProviderConfig[artType];
    return provider === 'meta' 
      ? config.providers?.[contentType] || getDefaultProvider(contentType)
      : provider || getDefaultProvider(contentType);
  }
  
  // Fallback to meta provider
  return config.providers?.[contentType] || getDefaultProvider(contentType);
}

function getDefaultProvider(contentType) {
  switch (contentType) {
    case 'anime': return 'mal';
    case 'movie': return 'tmdb';
    case 'series': return 'tvdb';
    default: return 'tmdb';
  }
}

/**
 * Truncate long cache keys for better log readability
 */
function truncateCacheKey(key, maxLength = 80) {
  if (key.length <= maxLength) return key;
  
  // Try to preserve the most important parts: version, cache type, and catalog info
  const parts = key.split(':');
  if (parts.length >= 4) {
    const version = parts[0];
    const cacheType = parts[1];
    const catalogInfo = parts.slice(2).join(':');
    
    // If we have catalog info (like tmdb.top:series:{}), try to preserve it
    if (catalogInfo.includes('.') && catalogInfo.includes(':')) {
      const catalogParts = catalogInfo.split(':');
      const catalogProvider = catalogParts[0]; // e.g., "tmdb.top"
      const catalogType = catalogParts[1]; // e.g., "series"
      const catalogParams = catalogParts.slice(2).join(':'); // e.g., "{}"
      
      const availableLength = maxLength - version.length - cacheType.length - catalogProvider.length - catalogType.length - catalogParams.length - 6; // 6 for colons and "..."
      
      if (availableLength > 10) {
        // We have enough space to show some of the config string
        return `${version}:${cacheType}:${catalogProvider}:${catalogType}:${catalogParams.substring(0, availableLength)}...`;
      } else {
        // Not enough space, just show the essential parts
        return `${version}:${cacheType}:${catalogProvider}:${catalogType}:...`;
      }
    }
  }
  
  // Fallback: preserve version and cache type, truncate the rest
  if (parts.length >= 3) {
    const version = parts[0];
    const cacheType = parts[1];
    const remaining = parts.slice(2).join(':');
    
    if (remaining.length > maxLength - version.length - cacheType.length - 10) {
      const truncated = remaining.substring(0, maxLength - version.length - cacheType.length - 10);
      return `${version}:${cacheType}:${truncated}...`;
    }
  }
  
  return key.substring(0, maxLength - 3) + '...';
}

function safeParseConfigString(configString) {
  try {
    if (!configString) return null;
    const lz = require('lz-string');
    const decompressed = lz.decompressFromEncodedURIComponent(configString);
    if (!decompressed) return null;
    return JSON.parse(decompressed);
  } catch {
    return null;
  }
}

function pruneKeyAccessCounts() {
  if (cacheHealth.keyAccessCounts.size <= MAX_TRACKED_KEYS) {
    return null;
  }

  const oldSize = cacheHealth.keyAccessCounts.size;
  const sorted = Array.from(cacheHealth.keyAccessCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, KEYS_TO_KEEP_AFTER_PRUNE);

  cacheHealth.keyAccessCounts.clear();
  for (const [trackedKey, count] of sorted) {
    cacheHealth.keyAccessCounts.set(trackedKey, count);
  }

  return { oldSize, newSize: cacheHealth.keyAccessCounts.size };
}

/**
 * Self-healing cache health monitoring
 */
function updateCacheHealth(key, type, success = true) {
  const metricsDisabled = isMetricsDisabled();
  if (!metricsDisabled) {
    cacheHealth.keyAccessCounts.set(key, (cacheHealth.keyAccessCounts.get(key) || 0) + 1);
    pruneKeyAccessCounts();
  }
  
  if (success) {
    if (type === 'hit') {
      cacheHealth.hits++;
      // Also track in requestTracker for dashboard metrics
      try {
        const requestTracker = require('./requestTracker');
        requestTracker.trackCacheHit().catch(() => {}); // Don't let this fail silently
      } catch (error) {
        // Ignore if requestTracker is not available
      }
    } else if (type === 'miss') {
      cacheHealth.misses++;
      // Also track in requestTracker for dashboard metrics
      try {
        const requestTracker = require('./requestTracker');
        requestTracker.trackCacheMiss().catch(() => {}); // Don't let this fail silently
      } catch (error) {
        // Ignore if requestTracker is not available
      }
    } else if (type === 'cached-error') {
      // Track cached errors separately - these are NOT counted as hits
      cacheHealth.cachedErrors++;
      // Track as cache miss for hit rate calculation since these are essentially failed responses
      try {
        const requestTracker = require('./requestTracker');
        requestTracker.trackCacheMiss().catch(() => {}); // Count as miss for accurate hit rate
      } catch (error) {
        // Ignore if requestTracker is not available
      }
    }
  } else {
    cacheHealth.errors++;
  }
  
  // Periodic health check
  const now = Date.now();
  if (now - cacheHealth.lastHealthCheck > SELF_HEALING_CONFIG.healthCheckInterval) {
    logCacheHealth();
    cacheHealth.lastHealthCheck = now;
  }
}

/**
 * Log cache health statistics
 */
function logCacheHealth() {
  // Skip logging if metrics are disabled
  if (isMetricsDisabled()) {
    return;
  }
  
  const total = cacheHealth.hits + cacheHealth.misses;
  const hitRate = total > 0 ? ((cacheHealth.hits / total) * 100).toFixed(2) : '0.00';
  const errorRate = total > 0 ? ((cacheHealth.errors / total) * 100).toFixed(2) : '0.00';
  
  cacheHealthLogger.info(`Hit Rate: ${hitRate}%, Error Rate: ${errorRate}%, Total: ${total}`);
  cacheHealthLogger.info(`Hits: ${cacheHealth.hits}, Misses: ${cacheHealth.misses}, Errors: ${cacheHealth.errors}, Cached Errors: ${cacheHealth.cachedErrors}`);
  
  // Log most accessed keys
  const topKeys = Array.from(cacheHealth.keyAccessCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  if (topKeys.length > 0) {
    cacheHealthLogger.info('Most accessed keys:', topKeys.map(([key, count]) => `${key}:${count}`).join(', '));
  }

  const pruneResult = pruneKeyAccessCounts();
  if (pruneResult) {
    cacheHealthLogger.info(`Pruned keyAccessCounts Map: ${pruneResult.oldSize} -> ${pruneResult.newSize} keys`);
  }
}

/**
 * Self-healing: Attempt to repair corrupted cache entries
 */
async function attemptSelfHealing(key, originalError) {
  if (!SELF_HEALING_CONFIG.enabled) return false;
  
  try {
    selfHealingLogger.info(`Attempting to repair corrupted cache entry: ${key}`);
    
    // Remove corrupted entry
    await redis.del(key);
    cacheHealth.corruptedEntries++;
    
    // Cache the error with a short TTL to prevent repeated failures
    const errorResult = {
      error: true,
      type: 'CACHE_CORRUPTED',
      message: 'Cache entry was corrupted and removed',
      originalError: originalError.message,
      timestamp: new Date().toISOString()
    };
    
    await redis.set(key, JSON.stringify(errorResult), 'EX', ERROR_TTL_STRATEGIES.CACHE_CORRUPTED);
    
    selfHealingLogger.success(`Successfully repaired corrupted cache entry: ${key}`);
    return true;
  } catch (error) {
    selfHealingLogger.error(`Failed to repair cache entry ${key}:`, error);
    return false;
  }
}

/**
 * Enhanced result classification with self-healing awareness
 */
function classifyResult(result, error = null, cacheKey = null) {
  if (error) {
    const errorMessage = error.message?.toLowerCase() || '';
    const errorCode = error.status || error.code;
    
    if (errorCode === 404 || errorMessage.includes('not found')) {
      return { type: 'NOT_FOUND', ttl: ERROR_TTL_STRATEGIES.NOT_FOUND };
    }
    if (errorCode === 429 || errorMessage.includes('rate limit')) {
      return { type: 'RATE_LIMITED', ttl: ERROR_TTL_STRATEGIES.RATE_LIMITED };
    }
    if (errorCode >= 500 || errorMessage.includes('timeout') || errorMessage.includes('connection')) {
      return { type: 'TEMPORARY_ERROR', ttl: ERROR_TTL_STRATEGIES.TEMPORARY_ERROR };
    }
    return { type: 'PERMANENT_ERROR', ttl: ERROR_TTL_STRATEGIES.PERMANENT_ERROR };
  }
  
  if (!result) {
    return { type: 'EMPTY_RESULT', ttl: ERROR_TTL_STRATEGIES.EMPTY_RESULT };
  }
  
  // Check if this is an external API response (TVDB, TMDB, etc.)
  const isExternalApi = cacheKey && (
    cacheKey.includes('tvdb-api:') || 
    cacheKey.includes('tmdb-api:') || 
    cacheKey.includes('tmdb:') || 
    cacheKey.includes('tvmaze-api:') ||
    cacheKey.includes('jikan-api:') ||
    cacheKey.includes('simkl-') ||
    cacheKey.includes('fanart-api:') ||
    cacheKey.includes('anilist-') ||
    cacheKey.includes('anilist_') ||
    cacheKey.includes('kitsu-') ||
    cacheKey.includes('mdblist-') ||
    cacheKey.includes('trakt-') ||
    cacheKey.includes('trakt_') ||
    cacheKey.includes('mdblist_') ||
    cacheKey.includes('stremthru-') ||
    cacheKey.includes('cinemeta-')
  );
  
  if (isExternalApi) {
    // Deep-check for truly useful data — objects with only empty arrays/false booleans
    // are effectively empty (e.g. { items: [], hasMore: false } from an API error fallback)
    const hasValidData = (() => {
      if (Array.isArray(result)) return result.length > 0;
      if (typeof result === 'string') return result.length > 0;
      if (typeof result === 'number') return true;
      if (typeof result === 'object' && result !== null) {
        const values = Object.values(result);
        if (values.length === 0) return false;
        return values.some(v => {
          if (Array.isArray(v)) return v.length > 0;
          if (typeof v === 'object' && v !== null) return Object.keys(v).length > 0;
          if (typeof v === 'string') return v.length > 0;
          if (typeof v === 'number') return v > 0;
          return false;
        });
      }
      return false;
    })();

    if (hasValidData) {
      return { type: 'SUCCESS', ttl: null };
    } else {
      return { type: 'EMPTY_RESULT', ttl: ERROR_TTL_STRATEGIES.EMPTY_RESULT };
    }
  }
  
  // For internal responses (meta, catalog, etc.)
  const hasMetaData = (result.meta && typeof result.meta === 'object' && Object.keys(result.meta).length > 0);
  const hasMetasData = (Array.isArray(result.metas) && result.metas.length > 0);
  const hasArrayData = (Array.isArray(result) && result.length > 0);
  
  if (hasMetaData || hasMetasData || hasArrayData) {
  return { type: 'SUCCESS', ttl: null };
  }
  
  return { type: 'EMPTY_RESULT', ttl: ERROR_TTL_STRATEGIES.EMPTY_RESULT };
}

/**
 * Enhanced cache wrapper with self-healing capabilities
 */
async function cacheWrap(key, method, ttl, options = {}) {
  if (GLOBAL_NO_CACHE || !redis) {
    return method();
  }

  const versionedKey = `v${ADDON_VERSION}:${key}`;
  const { enableErrorCaching = false, resultClassifier = classifyResult, maxRetries = SELF_HEALING_CONFIG.maxRetries } = options;

  if (inFlightRequests.has(versionedKey)) {
    return inFlightRequests.get(versionedKey);
  }
  
  let retries = 0;
  
  while (retries <= maxRetries) {
  try {
    const cached = await redis.get(versionedKey);
    if (cached) {
        try {
          const parsed = JSON.parse(cached);
          
          // Check if it's a cached error that should be retried
          if (parsed.error && parsed.type === 'TEMPORARY_ERROR') {
            const errorAge = Date.now() - new Date(parsed.timestamp).getTime();
            if (errorAge > ERROR_TTL_STRATEGIES.TEMPORARY_ERROR * 1000) {
              cacheLogger.debug(`[Cache] Retrying expired temporary error for ${versionedKey}`);
              await redis.del(versionedKey);
            } else {
              cacheLogger.debug(`[Cache] Cached error returned for ${versionedKey}`);
              updateCacheHealth(versionedKey, 'cached-error', true);
              return parsed;
            }
          } else if (parsed.error) {
            cacheLogger.debug(`[Cache] Cached error returned for ${versionedKey}`);
            updateCacheHealth(versionedKey, 'cached-error', true);
            return parsed;
          } else {
            cacheLogger.debug(`⚡ [Cache] HIT for ${versionedKey}`);
            updateCacheHealth(versionedKey, 'hit', true);
            return parsed;
          }
        } catch (parseError) {
          cacheLogger.warn(`Corrupted cache entry for ${versionedKey}, attempting self-healing`);
          await attemptSelfHealing(versionedKey, parseError);
          // Continue to retry the method
        }
    }
  } catch (err) {
    cacheLogger.warn(`Failed to read from Redis for key ${versionedKey}:`, err);
      updateCacheHealth(versionedKey, 'error', false);
  }

  const promise = method();
  inFlightRequests.set(versionedKey, promise);

  try {
    const result = await promise;
      //cacheLogger.info(`⏳ MISS for ${versionedKey}`);
      updateCacheHealth(versionedKey, 'miss', true);
      
    if (result !== null && result !== undefined) {
        // Validate data before caching to prevent bad data from being cached
        let contentType = 'unknown';
        if (key.startsWith('meta')) {
          contentType = 'meta';
        } else if (key.startsWith('catalog')) {
          contentType = 'catalog';
        } else if (key.startsWith('search')) {
          contentType = 'search';
        } else if (key.startsWith('genre')) {
          contentType = 'genre';
        }
        const validation = cacheValidator.validateBeforeCache(result, contentType);
        
        if (!validation.isValid) {
          cacheLogger.warn(`Preventing bad data from being cached for ${versionedKey}:`, validation.issues);
          updateCacheHealth(versionedKey, 'error', false);
          throw new Error(`Bad data detected: ${validation.issues.join(', ')}`);
        }
        
        const classification = resultClassifier(result, null, key);
        const finalTtl = classification.ttl !== null ? classification.ttl : ttl;
        
        cacheLogger.debug(`[Cache] Classification: ${classification.type}, TTL: ${finalTtl}s`);
        
        // Skip caching if TTL is 0 (e.g., empty results)
        if (finalTtl > 0) {
        if (classification.type !== 'SUCCESS') {
            cacheLogger.warn(`Caching ${classification.type} result for ${versionedKey} for ${finalTtl}s`);
        }
        
        try {
          await redis.set(versionedKey, JSON.stringify(result), 'EX', finalTtl);
      } catch (err) {
            cacheLogger.warn(`Failed to write to Redis for key ${versionedKey}:`, err);
          updateCacheHealth(versionedKey, 'error', false);
          }
        } else {
          cacheLogger.debug(`[Cache] Skipping cache for ${versionedKey} (TTL: 0)`);
        }
    }
    return result;
  } catch (error) {
    cacheLogger.error(`Method failed for cache key ${versionedKey}:`, error);
      updateCacheHealth(versionedKey, 'error', false);
      
      // Cache error results if enabled
      if (enableErrorCaching) {
        const classification = resultClassifier(null, error);
        const errorTtl = classification.ttl;
        
        // Skip caching if classifier says so
        if (classification.type === 'SKIP_CACHE') {
          cacheLogger.debug(`[Cache] Skipping error cache for ${truncateCacheKey(versionedKey)} as requested by classifier`);
        } else if (errorTtl > 0) {
          try {
            const errorResult = { 
              error: true, 
              type: classification.type, 
              message: error.message,
              timestamp: new Date().toISOString()
            };
            await redis.set(versionedKey, JSON.stringify(errorResult), 'EX', errorTtl);
            cacheLogger.warn(`Cached ${classification.type} error for ${versionedKey} for ${errorTtl}s`);
          } catch (err) {
              cacheLogger.warn(`Failed to cache error for key ${versionedKey}:`, err);
          }
        }
      }
      
      // Retry logic for temporary errors
      if (retries < maxRetries && (error.status >= 500 || error.message?.includes('timeout'))) {
        retries++;
        cacheLogger.debug(`[Cache] Retrying ${versionedKey} (attempt ${retries}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, SELF_HEALING_CONFIG.retryDelay));
        continue;
      }
      
    throw error; 
  } finally {
    inFlightRequests.delete(versionedKey);
    }
  }
}

/**
 * Enhanced global cache wrapper with self-healing capabilities
 */
async function cacheWrapGlobal(key, method, ttl, options = {}) {
  if (GLOBAL_NO_CACHE || !redis) {
    return method();
  }

  const { enableErrorCaching = false, resultClassifier = classifyResult, maxRetries = SELF_HEALING_CONFIG.maxRetries, skipVersion = false } = options;
  const versionedKey = skipVersion ? `global:${key}` : `global:${ADDON_VERSION}:${key}`;
  
  if (inFlightRequests.has(versionedKey)) {
    return inFlightRequests.get(versionedKey);
  }

  let retries = 0;
  
  while (retries <= maxRetries) {
  try {
    const cached = await redis.get(versionedKey);
    if (cached) {
        try {
          const parsed = JSON.parse(cached);
          
          if (parsed.error && parsed.type === 'TEMPORARY_ERROR') {
            const errorAge = Date.now() - new Date(parsed.timestamp).getTime();
            if (errorAge > ERROR_TTL_STRATEGIES.TEMPORARY_ERROR * 1000) {
              globalCacheLogger.debug(`[Global-Cache] Retrying expired temporary error for ${truncateCacheKey(versionedKey)}`);
              await redis.del(versionedKey);
            } else {
              globalCacheLogger.debug(`[Global-Cache] Cached error returned for ${truncateCacheKey(versionedKey)}`);
              updateCacheHealth(versionedKey, 'cached-error', true);
              return parsed;
            }
          } else if (parsed.error) {
            globalCacheLogger.debug(`[Global-Cache] Cached error returned for ${truncateCacheKey(versionedKey)}`);
            updateCacheHealth(versionedKey, 'cached-error', true);
            return parsed;
          } else {
            globalCacheLogger.debug(`⚡ [Global-Cache] HIT for ${truncateCacheKey(versionedKey)}`);
            updateCacheHealth(versionedKey, 'hit', true);
            return parsed;
          }
        } catch (parseError) {
          globalCacheLogger.warn(`Corrupted cache entry for ${versionedKey}, attempting self-healing`);
          await attemptSelfHealing(versionedKey, parseError);
        }
    }
  } catch (err) {
    globalCacheLogger.warn(`Redis GET error for key ${versionedKey}:`, err.message);
      updateCacheHealth(versionedKey, 'error', false);
  }

  const promise = method();
  inFlightRequests.set(versionedKey, promise);

  try {
    const result = await promise;
      //globalCacheLogger.info(`⏳ MISS for ${truncateCacheKey(versionedKey)}`);
      updateCacheHealth(versionedKey, 'miss', true);

      const classification = resultClassifier(result, null, key);
      const finalTtl = classification.ttl !== null ? classification.ttl : ttl;
      
      //globalCacheLogger.info(`Classification: ${classification.type}, TTL: ${finalTtl}s`);

      // Skip caching if result classifier says so
      if (classification.type === 'SKIP_CACHE') {
        globalCacheLogger.debug(`[Global-Cache] Skipping cache for ${truncateCacheKey(versionedKey)} as requested by classifier`);
        return result;
      }

      // Skip caching if TTL is 0 (e.g., empty results)
      if (finalTtl > 0) {
      if (classification.type !== 'SUCCESS') {
        globalCacheLogger.warn(`Caching ${classification.type} result for ${versionedKey} for ${finalTtl}s`);
    }

    if (result !== null && result !== undefined) {
      await redis.set(versionedKey, JSON.stringify(result), 'EX', finalTtl);
        }
      } else {
        globalCacheLogger.debug(`[Global-Cache] Skipping cache for ${versionedKey} (TTL: 0)`);
    }
    return result;
  } catch (error) {
    globalCacheLogger.error(`Method failed for cache key ${versionedKey}:`, error);
      updateCacheHealth(versionedKey, 'error', false);
      
      // Cache error results if enabled
      if (enableErrorCaching) {
        const classification = resultClassifier(null, error);
        const errorTtl = classification.ttl;
        
        // Skip caching if classifier says so
        if (classification.type === 'SKIP_CACHE') {
          globalCacheLogger.debug(`[Global-Cache] Skipping error cache for ${truncateCacheKey(versionedKey)} as requested by classifier`);
        } else if (errorTtl > 0) {
          try {
            const errorResult = { 
              error: true, 
              type: classification.type, 
              message: error.message,
              timestamp: new Date().toISOString()
            };
            await redis.set(versionedKey, JSON.stringify(errorResult), 'EX', errorTtl);
            globalCacheLogger.warn(`Cached ${classification.type} error for ${versionedKey} for ${errorTtl}s`);
          } catch (err) {
            globalCacheLogger.warn(`Failed to cache error for key ${versionedKey}:`, err);
          }
        }
      }
      
      // Retry logic for temporary errors
      if (retries < maxRetries && (error.status >= 500 || error.message?.includes('timeout'))) {
        retries++;
        globalCacheLogger.debug(`[Global-Cache] Retrying ${truncateCacheKey(versionedKey)} (attempt ${retries}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, SELF_HEALING_CONFIG.retryDelay));
        continue;
      }
      
    throw error;
  } finally {
    inFlightRequests.delete(versionedKey);
    }
  }
}

// --- Helper Functions ---

async function cacheWrapCatalog(userUUID, catalogKey, method, options = {}) {
  // Load config from database
  let config;
  try {
    config = await loadConfigFromDatabase(userUUID);
  } catch (error) {
    cacheLogger.warn(`Failed to load config for user ${userUUID}: ${error.message}`);
    // Return empty response for invalid UUIDs instead of crashing
    return { metas: [] };
  }
  
  if (!config) {
    cacheLogger.warn(`No config found for user ${userUUID}`);
    return { metas: [] };
  }

  const idOnly = catalogKey.split(':')[0];
  const catalogType = catalogKey.split(':')[1];
  const trendingIds = new Set(['tmdb.trending']);
  const isTrendingCatalog = trendingIds.has(idOnly);
  
  // Check if this is an auth catalog (watchlist/favorites) - user-specific
  const isAuthCatalog = idOnly === 'tmdb.watchlist' || idOnly === 'tmdb.favorites';
  
  // Check if this is an airing_today catalog - needs date in cache key
  const isAiringTodayCatalog = idOnly === 'tmdb.airing_today';
  
  // Check if this is a MAL catalog with MAL as anime provider
  const isMALCatalog = idOnly.startsWith('mal.');
  const isMALAnimeProvider = config.providers?.anime === 'mal';
  const isMDBListCatalog = idOnly.startsWith('mdblist.');
  const isTraktCatalog = idOnly.startsWith('trakt.');
  const isLetterboxdCatalog = idOnly.startsWith('letterboxd.');
  const isStreamingCatalog = idOnly.startsWith('streaming.');
  const isTmdbDiscoverCatalog = idOnly.startsWith('tmdb.discover.');
  const isTvdbDiscoverCatalog = idOnly.startsWith('tvdb.discover.');
  const isAniListDiscoverCatalog = idOnly.startsWith('anilist.discover.');
  const isSimklDiscoverCatalog = idOnly.startsWith('simkl.discover.');
  const isMalDiscoverCatalog = idOnly.startsWith('mal.discover.');
  const isDiscoverCatalog = isTmdbDiscoverCatalog || isTvdbDiscoverCatalog || isAniListDiscoverCatalog || isSimklDiscoverCatalog || isMalDiscoverCatalog;
  const shouldExcludeLanguageForMAL = isMALCatalog && isMALAnimeProvider;
  
  // Find the catalog config to get per-catalog settings (like enableRatingPosters)
  // Match by both id AND type to handle duplicate IDs (e.g., tvdb.trending for movie vs series)
  const catalogFromConfig = config.catalogs?.find(c => c.id === idOnly && c.type === catalogType);
  const enableRatingPosters = catalogFromConfig?.enableRatingPosters !== false; // Default to true if not explicitly disabled
  const catalogHideWatchedTrakt = catalogFromConfig?.metadata?.hideWatchedTrakt;

  // Create context-aware catalog config (only relevant parameters for catalogs)
  const catalogConfig = {
    // Language (affects all catalogs except MAL when MAL is the anime provider)
    // MAL/Jikan doesn't return multilingual data, so language doesn't affect results
    ...(shouldExcludeLanguageForMAL ? {} : { language: config.language || 'en-US' }),
    
    // Provider settings (affect catalog content)
    providers: config.providers || {},
    artProviders: config.artProviders || {},
    
    // Content filtering (affects catalog results)
    sfw: config.sfw || false,
    includeAdult: config.includeAdult || false,
    ageRating: config.ageRating || null,
    exclusionKeywords: config.exclusionKeywords || null,
    regexExclusionFilter: config.regexExclusionFilter || null,
    showPrefix: config.showPrefix || false,
    showMetaProviderAttribution: config.showMetaProviderAttribution || false,
    displayAgeRating: config.displayAgeRating || false,

    // Poster rating provider and API key (affects poster generation)
    posterRatingProvider: config.posterRatingProvider || 'rpdb',
    posterRatingApiKey: enableRatingPosters ? (config.posterRatingProvider === 'top'
      ? (config.apiKeys?.topPoster || '')
      : (config.apiKeys?.rpdb || '')) : '',
    usePosterProxy: !!config.usePosterProxy,
  };

  // Only include MDBList API key for MDBList catalogs
  if (isMDBListCatalog) {
    catalogConfig.apiKeys = {
      mdblist: config.apiKeys?.mdblist || process.env.MDBLIST_API_KEY || ''
    };
  }
  
  // Only include Trakt token ID for Trakt catalogs (user-specific)
  if (isTraktCatalog) {
    catalogConfig.apiKeys = {
      traktTokenId: config.apiKeys?.traktTokenId || ''
    };
  }

  // Only include SimKL token ID for watchlist catalogs (trending is public, no token)
  if (idOnly.startsWith('simkl.watchlist.')) {
    catalogConfig.apiKeys = {
      simklTokenId: config.apiKeys?.simklTokenId || ''
    };
  }

  // Only include AniList token ID for user-list catalogs (trending is public, no token)
  if (idOnly.startsWith('anilist.') && idOnly !== 'anilist.trending') {
    catalogConfig.apiKeys = {
      anilistTokenId: config.apiKeys?.anilistTokenId || ''
    };
  }
  
  // Only include MAL config for MAL catalogs
  if (isMALCatalog) {
    catalogConfig.mal = config.mal || {};
  }
  
  // Only include streaming config for streaming catalogs
  if (isStreamingCatalog) {
    catalogConfig.streaming = config.streaming || [];
  }
  
  const catalogConfigString = JSON.stringify(catalogConfig);
  const configHash = hashConfig(catalogConfigString);
  
  let cacheTTL = CATALOG_TTL;
  
  // Auth catalogs (watchlist/favorites) change frequently - don't cache to avoid stale data
  // User lists can change (items added/removed), and old cached pages could show items that no longer exist
  if (isAuthCatalog) {
    cacheTTL = 0; // Don't cache - user lists change frequently and old pages could be stale
    cacheLogger.debug(`[Catalog] Not caching auth catalog ${idOnly} (user-specific data changes frequently)`);
  } else if (isTrendingCatalog) {
    cacheTTL = TMDB_TRENDING_TTL;
    cacheLogger.debug(`[Catalog] Using TMDB trending cache TTL for ${idOnly}: ${cacheTTL}s`);
  }
  
  // Use custom cache TTL for MDBList catalogs if specified
  
  // Decade catalogs use 30-day cache since historical data doesn't change
  // Note: 2020s decade still active, but older decades are stable
  const decadeCatalogs = ['mal.80sDecade', 'mal.90sDecade', 'mal.00sDecade', 'mal.10sDecade'];
  if (decadeCatalogs.includes(idOnly)) {
    cacheTTL = STATIC_CATALOG_TTL; // 30 days
    cacheLogger.debug(`[Catalog] Using extended cache TTL for decade catalog ${idOnly}: 30 days`);
  }
  
  if (idOnly.startsWith('mdblist.')) {
    const catalogConfig = config.catalogs?.find(c => c.id === idOnly);
    if (catalogConfig?.cacheTTL) {
      cacheTTL = catalogConfig.cacheTTL;
      cacheLogger.debug(`[Catalog] Using custom cache TTL for MDBList catalog ${idOnly}: ${cacheTTL}s`);
    }
  }
  
  // Use custom cache TTL for Trakt catalogs if specified
  if (idOnly.startsWith('trakt.')) {
    const catalogConfig = config.catalogs?.find(c => c.id === idOnly);
    if (catalogConfig?.cacheTTL) {
      cacheTTL = catalogConfig.cacheTTL;
      cacheLogger.debug(`[Catalog] Using custom cache TTL for Trakt catalog ${idOnly}: ${cacheTTL}s`);
    }
  }

  if (idOnly.startsWith('simkl.trending.')) {
    const catalogConfig = config.catalogs?.find(c => c.id === idOnly);
    cacheTTL = Math.max(catalogConfig?.cacheTTL || CATALOG_TTL, 3600);
    cacheLogger.debug(`[Catalog] Using cache TTL for Simkl trending catalog ${idOnly}: ${cacheTTL}s`);
  }
  
  // Use custom cache TTL for Letterboxd catalogs if specified
  // StremThru returns cache-control headers suggesting 900s (15min), but allow user override
  if (idOnly.startsWith('letterboxd.')) {
    const catalogConfig = config.catalogs?.find(c => c.id === idOnly);
    if (catalogConfig?.cacheTTL) {
      cacheTTL = catalogConfig.cacheTTL;
      cacheLogger.debug(`[Catalog] Using custom cache TTL for Letterboxd catalog ${idOnly}: ${cacheTTL}s`);
    }
  }
  
  // Handle custom TTL for custom manifest catalogs
  if (idOnly.startsWith('custom.')) {
    const catalogConfig = config.catalogs?.find(c => c.id === idOnly);
    if (catalogConfig?.cacheTTL) {
      cacheTTL = catalogConfig.cacheTTL;
      cacheLogger.debug(`[Catalog] Using custom cache TTL for custom manifest catalog ${idOnly}: ${cacheTTL}s`);
    }
  }
  
  // Use custom cache TTL for AniList catalogs if specified
  if (idOnly.startsWith('anilist.')) {
    const catalogConfig = config.catalogs?.find(c => c.id === idOnly);
    if (catalogConfig?.cacheTTL) {
      cacheTTL = catalogConfig.cacheTTL;
      cacheLogger.debug(`[Catalog] Using custom cache TTL for AniList catalog ${idOnly}: ${cacheTTL}s`);
    }
  }
  
  // Use custom cache TTL for SimKL catalogs if specified
  if (idOnly.startsWith('simkl.')) {
    const catalogConfig = config.catalogs?.find(c => c.id === idOnly);
    if (catalogConfig?.cacheTTL) {
      cacheTTL = catalogConfig.cacheTTL;
      cacheLogger.debug(`[Catalog] Using custom cache TTL for SimKL catalog ${idOnly}: ${cacheTTL}s`);
    }
  }

  // Use custom cache TTL for custom TMDB discover catalogs if specified
  if (isDiscoverCatalog) {
    const catalogConfig = config.catalogs?.find(c => c.id === idOnly);
    if (catalogConfig?.cacheTTL) {
      cacheTTL = catalogConfig.cacheTTL;
      cacheLogger.debug(`[Catalog] Using custom cache TTL for discover catalog ${idOnly}: ${cacheTTL}s`);
    }
  }
  
  // Include TTL in cache key to ensure proper cache invalidation when TTL changes
  // Auth catalogs (watchlist/favorites) use sessionId in cache key (since they're tied to TMDB account)
  // Airing today catalog needs today's date in cache key (results change daily)
  // Other user-specific catalogs use userUUID
  let key;
  if (isAuthCatalog) {
    const sessionId = config.sessionId || '';
    key = `catalog:${sessionId}:${configHash}:${cacheTTL}:${catalogKey}`;
  } else if (isAiringTodayCatalog) {
    // Use local timezone to get today's date for cache key
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const today = `${year}-${month}-${day}`; // YYYY-MM-DD format in local timezone
    key = `catalog:${today}:${configHash}:${cacheTTL}:${catalogKey}`;
  } else if (idOnly.startsWith('mdblist.') || idOnly.startsWith('trakt.') || idOnly.startsWith('simkl.watchlist.') || (idOnly.startsWith('anilist.') && idOnly !== 'anilist.trending') || idOnly.includes('stremthru.') || idOnly.startsWith('custom.') || idOnly.startsWith('letterboxd.') || isDiscoverCatalog) {
    key = `catalog:${userUUID}:${configHash}:${cacheTTL}:${catalogKey}`;
  } else if (idOnly.startsWith('simkl.') || idOnly.startsWith('anilist.')) {
    key = `catalog:${configHash}:${catalogKey}`;
  } else {
    key = `catalog:${configHash}:${catalogKey}`;
  }
  
  const cacheKeyIdentifier = isAuthCatalog ? (config.sessionId || 'no-session') : (userUUID || '');
  const catalogSig = shortSignature(`${cacheKeyIdentifier}|${idOnly}|${configHash}|ttl:${cacheTTL}`);
  const isUserScopedCatalog = idOnly.startsWith('mdblist.') || idOnly.startsWith('trakt.') || idOnly.startsWith('simkl.watchlist.') || (idOnly.startsWith('anilist.') && idOnly !== 'anilist.trending') || idOnly.includes('stremthru.') || idOnly.startsWith('custom.') || idOnly.startsWith('letterboxd.') || isDiscoverCatalog || isAuthCatalog;
  cacheLogger.debug(`[Catalog] Key detail (${idOnly}) [sig:${catalogSig}] userScoped:${isUserScopedCatalog} ttl:${cacheTTL}s catalogConfig:${catalogConfigString} catalogKey:${catalogKey}`);
  
  // Set module-level context for this catalog request
  // This allows reconstruction to access the correct RPDB state
  currentRequestContext.catalogConfig = catalogFromConfig;

  try {
    // Check if the catalog is already cached before calling cacheWrap
    // so we can log the full config detail on HITs (cacheWrap only logs the key)
    if (redis) {
      const versionedKey = `v${ADDON_VERSION}:${key}`;
      const cached = await redis.get(versionedKey);
      if (cached) {
        cacheLogger.debug(`[Catalog] HIT detail (${idOnly}) [sig:${catalogSig}] catalogConfig:${catalogConfigString} catalogKey:${catalogKey}`);
      }
    }
    return await cacheWrap(key, method, cacheTTL, options);
  } finally {
    // Clear context after request completes
    currentRequestContext.catalogConfig = null;
  }
  }

/**
 * Search-specific cache wrapper with context-aware cache keys
 * Search results depend on different config parameters than catalogs
 */
async function cacheWrapSearch(userUUID, searchKey, method, searchEngine = null, options = {}) {
  // Load config from database
  let config;
  try {
    config = await loadConfigFromDatabase(userUUID);
  } catch (error) {
    cacheLogger.warn(`Failed to load config for user ${userUUID}: ${error.message}`);
    // Return empty response for invalid UUIDs instead of crashing
    return { metas: [] };
  }
  
  if (!config) {
    cacheLogger.warn(`No config found for user ${userUUID}`);
    return { metas: [] };
  }
  
  // Get rating posters enablement state for this search engine
  const ratingPostersEnabled = searchEngine ? (config.search?.engineRatingPosters?.[searchEngine] !== false) : true;
  
  // Search-specific config (only relevant parameters for search results)
  const defaultSearchOrder = [
    'movie',
    'series',
    'tvdb.collections.search',
    'gemini.search',
    'anime_series',
    'anime_movie',
    'people_search_movie',
    'people_search_series',
  ];
  const rawSearchOrder = Array.isArray(config.search?.searchOrder) ? config.search.searchOrder : [];
  const searchOrder = Array.from(new Set([...rawSearchOrder, ...defaultSearchOrder]));

  const searchConfig = {
    language: config.language || 'en-US',
    searchProviders: config.search?.providers || {},
    searchNames: config.search?.searchNames || {},
    providerNames: config.search?.providerNames || {},
    searchOrder,
    engineEnabled: config.search?.engineEnabled || {},
    sfw: config.sfw || false,
    includeAdult: config.includeAdult || false,
    ageRating: config.ageRating || null,
    exclusionKeywords: config.exclusionKeywords || null,
    regexExclusionFilter: config.regexExclusionFilter || null,
    // Add meta and art providers since they affect search results
    metaProviders: config.providers || {},
    artProviders: config.artProviders || {},
    // Add display settings that affect search results
    blurThumbs: config.blurThumbs || false,
    showPrefix: config.showPrefix || false,
    hideUnreleasedDigitalSearch: config.hideUnreleasedDigitalSearch || false,
    showMetaProviderAttribution: config.showMetaProviderAttribution || false,
    displayAgeRating: config.displayAgeRating || false,
    useImdbIdForCatalogAndSearch: config.mal?.useImdbIdForCatalogAndSearch || false,
    // Poster rating provider and API key (affects poster generation)
    posterRatingProvider: config.posterRatingProvider || 'rpdb',
    posterRatingApiKey: ratingPostersEnabled ? (config.posterRatingProvider === 'top' 
      ? (config.apiKeys?.topPoster || '') 
      : (config.apiKeys?.rpdb || '')) : '',
    usePosterProxy: !!config.usePosterProxy,
  };
  
  const searchConfigString = JSON.stringify(searchConfig);
  const configHash = hashConfig(searchConfigString);
  const key = `search:${configHash}:${searchKey}`;
  const searchSig = shortSignature(`${configHash}`);
  cacheLogger.debug(`[Search] Key detail [sig:${searchSig}]`);
  
  // TTL for search results
  const SEARCH_TTL = 12 * 60 * 60; // 12 hours
  
  return cacheWrap(key, method, SEARCH_TTL, options);
}

async function cacheWrapMeta(userUUID, metaId, method, ttl = META_TTL, options = {}, type = null) {
   // Load config from database
   let config;
   try {
     config = await loadConfigFromDatabase(userUUID);
   } catch (error) {
     cacheLogger.warn(`Failed to load config for user ${userUUID}: ${error.message}`);
     // Return empty response for invalid UUIDs instead of crashing
     return { meta: null };
   }
   
   if (!config) {
     cacheLogger.warn(`No config found for user ${userUUID}`);
     return { meta: null };
   }
   
   // Parse metaId to determine context (fallback if type not provided)
   const [prefix, sourceId] = metaId.split(':');
   const metaType = type;
   
   // Create context-aware meta config object
   const metaConfig = {
     // Language (affects all meta)
     language: config.language || 'en-US',
     
     // Display settings (affect all meta)
     castCount: config.castCount || 0,
     blurThumbs: config.blurThumbs || false,
     showMetaProviderAttribution: config.showMetaProviderAttribution || false,
     displayAgeRating: config.displayAgeRating || false,
     
     englishArtOnly: config.artProviders?.englishArtOnly || false,
     
     timezone: config.timezone || 'UTC',
     
     // Poster rating provider (affects poster URLs)
     posterRatingProvider: config.posterRatingProvider || 'rpdb',
     usePosterProxy: !!config.usePosterProxy,
     apiKeys: { 
       rpdb: config.apiKeys?.rpdb || process.env.RPDB_API_KEY || '',
       topPoster: config.apiKeys?.topPoster || ''
     }
   };
   
   // Add context-specific settings based on meta type
  const animePrefixes = ['mal', 'kitsu', 'anilist', 'anidb'];
  if (animePrefixes.includes(prefix) || metaType === 'anime') {
     metaConfig.metaProvider = config.providers?.anime || 'mal';
     metaConfig.artProvider = {
       poster: resolveArtProvider('anime', 'poster', config),
       background: resolveArtProvider('anime', 'background', config),
       logo: resolveArtProvider('anime', 'logo', config)
     };
     metaConfig.animeIdProvider = config.providers?.anime_id_provider || 'imdb';
     metaConfig.mal = {
      skipFiller: config.mal?.skipFiller || false,
      useImdbIdForCatalogAndSearch: config.mal?.useImdbIdForCatalogAndSearch || false,
      skipRecap: config.mal?.skipRecap || false,
      allowEpisodeMarking: config.mal?.allowEpisodeMarking || false
    };
   } else if (metaType === 'movie') {
     metaConfig.metaProvider = config.providers?.movie || 'tmdb';
     metaConfig.artProvider = {
       poster: resolveArtProvider('movie', 'poster', config),
       background: resolveArtProvider('movie', 'background', config),
       logo: resolveArtProvider('movie', 'logo', config)
     };
    metaConfig.tmdb = {
     scrapeImdb: config.tmdb?.scrapeImdb || false,
     forceLatinCastNames: config.tmdb?.forceLatinCastNames || false
    };
   } else if (metaType === 'series') {
     metaConfig.metaProvider = config.providers?.series || 'tvdb';
     metaConfig.forceAnimeForDetectedImdb = config.providers?.forceAnimeForDetectedImdb;
     metaConfig.artProvider = {
       poster: resolveArtProvider('series', 'poster', config),
       background: resolveArtProvider('series', 'background', config),
       logo: resolveArtProvider('series', 'logo', config)
     };
     // TVDB season type only matters for TVDB series
     metaConfig.tvdbSeasonType = config.tvdbSeasonType || 'default';

   }
   
  // Create cache key from context-aware meta config (no UUID for shared caching)
  const metaConfigString = stableStringify(metaConfig);
  const configHash = hashConfig(metaConfigString);
   const key = `meta:${configHash}:${metaId}`;
   const metaSig = shortSignature(`${configHash}`);
  cacheLogger.debug(`[Meta] Key detail (${prefix}/${metaType}) [sig:${metaSig}]`);
   
   return cacheWrap(key, method, ttl, options);
}

/**
 * Granular component caching for meta objects
 * Caches individual components separately to prevent one bad component from affecting everything
 */
async function cacheWrapMetaComponents(userUUID, metaId, method, ttl = META_TTL, options = {}, type = null, useShowPoster = false) {
   // Validate metaId
   if (!metaId || typeof metaId !== 'string') {
     cacheLogger.warn(`Invalid metaId provided to cacheWrapMetaComponents: ${metaId}`);
     return { meta: null };
   }
   
   // Load config from database
   let config;
   try {
     config = await loadConfigFromDatabase(userUUID);
   } catch (error) {
     cacheLogger.warn(`Failed to load config for user ${userUUID}: ${error.message}`);
     // Return empty response for invalid UUIDs instead of crashing
     return { meta: null };
   }
   
   if (!config) {
     cacheLogger.warn(`No config found for user ${userUUID}`);
     return { meta: null };
   }
   
   // Parse metaId to determine context
   const [prefix, sourceId] = metaId.split(':');
   const metaType = type;
   
   // Create context-aware meta config object (same as cacheWrapMeta)
   const metaConfig = {
     language: config.language || 'en-US',
     castCount: config.castCount || 0,
     blurThumbs: config.blurThumbs || false,
     showPrefix: config.showPrefix || false,
     showMetaProviderAttribution: config.showMetaProviderAttribution || false,
     displayAgeRating: config.displayAgeRating || false,
     englishArtOnly: config.artProviders?.englishArtOnly || false,
     timezone: config.timezone || 'UTC',
     // Poster rating provider (affects poster URLs)
     posterRatingProvider: config.posterRatingProvider || 'rpdb',
     usePosterProxy: !!config.usePosterProxy,
     apiKeys: { 
       rpdb: config.apiKeys?.rpdb || process.env.RPDB_API_KEY || '',
       topPoster: config.apiKeys?.topPoster || ''
     }
   };
   const animePrefixes = ['mal', 'kitsu', 'anilist', 'anidb'];
   const isAnime = metaType === 'anime' || animePrefixes.includes(prefix);
   //const isImdbIdAnime = metaId.startsWith('tt') && !!idMapper.getMappingByImdbId(metaId);
   //const isAnimeWithImdbId = isAnime || (isImdbIdAnime && config.providers?.forceAnimeForDetectedImdb);

   
   if (isAnime) {
     metaConfig.metaProvider = config.providers?.anime || 'mal';
     metaConfig.artProvider = {
       poster: resolveArtProvider('anime', 'poster', config),
       background: resolveArtProvider('anime', 'background', config),
       logo: resolveArtProvider('anime', 'logo', config)
     };
     metaConfig.mal = {
       skipFiller: config.mal?.skipFiller || false,
       skipRecap: config.mal?.skipRecap || false,
       allowEpisodeMarking: config.mal?.allowEpisodeMarking || false,
       useImdbIdForCatalogAndSearch: config.mal?.useImdbIdForCatalogAndSearch || false
     };
   } else if (metaType === 'movie') {
     metaConfig.metaProvider = config.providers?.movie || 'tmdb';
     metaConfig.artProvider = {
       poster: resolveArtProvider('movie', 'poster', config),
       background: resolveArtProvider('movie', 'background', config),
       logo: resolveArtProvider('movie', 'logo', config)
     };
    // Keep keys identical to reconstructMetaFromComponents
    metaConfig.tmdb = {
     scrapeImdb: config.tmdb?.scrapeImdb || false,
     forceLatinCastNames: config.tmdb?.forceLatinCastNames || false
    };
   } else if (metaType === 'series') {
     metaConfig.metaProvider = config.providers?.series || 'tvdb';
     metaConfig.artProvider = {
       poster: resolveArtProvider('series', 'poster', config),
       background: resolveArtProvider('series', 'background', config),
       logo: resolveArtProvider('series', 'logo', config)
     };
     metaConfig.tvdbSeasonType = config.tvdbSeasonType || 'default';
     metaConfig.tmdb = {
      scrapeImdb: config.tmdb?.scrapeImdb || false,
      forceLatinCastNames: config.tmdb?.forceLatinCastNames || false
    };
     metaConfig.forceAnimeForDetectedImdb = config.providers?.forceAnimeForDetectedImdb;
     metaConfig.useShowPosterForUpNext = useShowPoster;
    }
    /*if (isAnimeWithImdbId) {
      metaConfig.animeIdProvider = config.providers?.anime_id_provider || 'imdb';
    }*/
    metaConfig.animeIdProvider = config.providers?.anime_id_provider || 'imdb';
 
const metaConfigString = stableStringify(metaConfig);
const configHash = hashConfig(metaConfigString);
 
 // Define component cache keys
  const componentCacheKeys = {
     basic: `meta-basic:${configHash}:${metaId}`,
     poster: `meta-poster:${configHash}:${metaId}`,
     rawPoster: `meta-raw-poster:${configHash}:${metaId}`,
     background: `meta-background:${configHash}:${metaId}`,
     landscapePoster: `meta-landscape-poster:${configHash}:${metaId}`,
     logo: `meta-logo:${configHash}:${metaId}`,
     videos: `meta-videos:${configHash}:${metaId}`,
     cast: `meta-cast:${configHash}:${metaId}`,
     director: `meta-director:${configHash}:${metaId}`,
     writer: `meta-writer:${configHash}:${metaId}`,
     links: `meta-links:${configHash}:${metaId}`,
     trailers: `meta-trailers:${configHash}:${metaId}`,
     extras: `meta-extras:${configHash}:${metaId}`
   };
   
   // Debug: Log cache keys for different content types
   /*console.log(`📦 [Cache] DEBUG: Generated cache keys for ${metaId} (type: ${metaType}):`);
   console.log(`📦 [Cache] DEBUG:   metaConfig: ${metaConfigString}`);
   console.log(`📦 [Cache] DEBUG:   poster key: ${componentCacheKeys.poster}`);
   console.log(`📦 [Cache] DEBUG:   background key: ${componentCacheKeys.background}`);*/
   
   const result = await method();
   
   const meta = result?.meta || result;
   
  if (!meta || !meta.id || !meta.name || !meta.type) {
          cacheLogger.warn(`No valid meta object returned for ${metaId}`);
    return { meta: null };
  }
  
  // Capture metadata for dashboard display (fire-and-forget)
  try {
    const requestTracker = require('./requestTracker');
    requestTracker.captureMetadataFromComponents(metaId, meta, meta.type).catch(() => {});
  } catch (error) {
    cacheLogger.warn(`Failed to capture metadata for dashboard: ${error.message}`);
  }
   
   const componentPromises = [];
   
   const basicMeta = {
      id: metaId,
      name: meta.name,
      type: meta.type,
      description: meta.description,
      imdb_id: meta.imdb_id,
      slug: meta.slug,
      genres: meta.genres,
      director: meta.director,
      writer: meta.writer,
      year: meta.year,
      releaseInfo: meta.releaseInfo,
      released: meta.released,
      runtime: meta.runtime,
      country: meta.country,
      imdbRating: meta.imdbRating,
      behaviorHints: meta.behaviorHints,
      posterShape: meta.posterShape || 'poster',
      _hasPoster: !!meta.poster,
      _hasBackground: !!meta.background,
      _hasLandscapePoster: !!meta.landscapePoster,
      _hasLogo: !!meta.logo,
      _hasVideos: !!(meta.videos && Array.isArray(meta.videos) && meta.videos.length > 0),
      _hasLinks: !!(meta.links && Array.isArray(meta.links) && meta.links.length > 0)
   };
   
   componentPromises.push(
     cacheComponent(componentCacheKeys.basic, basicMeta, ttl)
   );
   
   // Poster
   if (meta.poster) {
    let rawPoster = meta.poster;
    
    try {
        const urlObj = new URL(rawPoster);
        
        if (rawPoster.includes('/poster/') && urlObj.searchParams.has('fallback')) {
           rawPoster = decodeURIComponent(urlObj.searchParams.get('fallback'));
        }
        else if (urlObj.hostname.includes('top-streaming.stream') && urlObj.searchParams.has('fallback_url')) {
           rawPoster = decodeURIComponent(urlObj.searchParams.get('fallback_url'));
        }

    } catch (e) {}
    
    if (meta._rawPosterUrl) {
        rawPoster = meta._rawPosterUrl;
    }

    componentPromises.push(
      cacheComponent(componentCacheKeys.poster, { poster: rawPoster }, ttl)
    );
    componentPromises.push(
      cacheComponent(componentCacheKeys.rawPoster, { _rawPosterUrl: meta._rawPosterUrl }, ttl)
    );
  }
   
   // Background
   if (meta.background) {
     componentPromises.push(
       cacheComponent(componentCacheKeys.background, { background: meta.background }, ttl)
     );
   }
   if (meta.landscapePoster) {
     componentPromises.push(
       cacheComponent(componentCacheKeys.landscapePoster, { landscapePoster: meta.landscapePoster }, ttl)
     );
   }
   
   // Logo
   if (meta.logo) {
     componentPromises.push(
       cacheComponent(componentCacheKeys.logo, { logo: meta.logo }, ttl)
     );
   }
   
   // Videos (episodes for series)
   if (meta.videos && Array.isArray(meta.videos) && meta.videos.length > 0) {
     componentPromises.push(
       cacheComponent(componentCacheKeys.videos, { videos: meta.videos }, ttl)
     );
   }
   
   // Cast - only cache if castCount is not configured (unlimited cast)
   // When castCount is configured, we don't cache cast to avoid serving wrong cast count
   if (meta.app_extras?.cast && (!config.castCount || config.castCount === 0)) {
     componentPromises.push(
       cacheComponent(componentCacheKeys.cast, { cast: meta.app_extras.cast }, ttl)
     );
   }
   
   // Director details
   if (meta.app_extras?.directors) {
     componentPromises.push(
       cacheComponent(componentCacheKeys.director, { directors: meta.app_extras.directors }, ttl)
     );
   }
   
   // Writer details
   if (meta.app_extras?.writers) {
     componentPromises.push(
       cacheComponent(componentCacheKeys.writer, { writers: meta.app_extras.writers }, ttl)
     );
   }
   
   // Links
   if (meta.links && Array.isArray(meta.links)) {
     componentPromises.push(
       cacheComponent(componentCacheKeys.links, { links: meta.links }, ttl)
     );
   }
   
   // Trailers
   if (meta.trailers) {
     componentPromises.push(
       cacheComponent(componentCacheKeys.trailers, { trailers: meta.trailers }, ttl)
     );
   }
   
   // Trailer streams
   if (meta.trailerStreams) {
     componentPromises.push(
       cacheComponent(componentCacheKeys.trailers, { trailerStreams: meta.trailerStreams }, ttl)
     );
   }
   
   // App extras (combined)
   if (meta.app_extras) {
     componentPromises.push(
       cacheComponent(componentCacheKeys.extras, { app_extras: meta.app_extras }, ttl)
     );
   }
   
     // Cache all components in parallel
  await Promise.all(componentPromises);
   
   // Return the meta object wrapped in the expected format
   return { meta };
}

/**
 * Reconstruct meta object from cached components
 * This allows for partial cache hits and graceful degradation
 * @param {boolean} includeVideos - Whether videos component is required for this request
 */
async function reconstructMetaFromComponents(userUUID, metaId, ttl = META_TTL, options = {}, type = null, includeVideos = true, useShowPoster = false) {
   // Validate metaId
   if (!metaId || typeof metaId !== 'string') {
     cacheLogger.warn(`Invalid metaId provided: ${metaId}`);
     return { errorReason: 'invalid metaId' };
   }
   
   // Load config from database
   let config;
   try {
     config = await loadConfigFromDatabase(userUUID);
  } catch (error) {
    cacheLogger.warn(`Failed to load config for user ${userUUID}: ${error.message}`);
    // Return reason for invalid UUIDs instead of crashing
    return { errorReason: `load config failed: ${error.message}` };
  }
   
  if (!config) {
    cacheLogger.warn(`No config found for user ${userUUID}`);
    return { errorReason: 'no config for user' };
  }
   
   // Parse metaId to determine context
   const [prefix, sourceId] = metaId.split(':');
   const metaType = type;
   
   // Create context-aware meta config object (same as cacheWrapMeta)
   const metaConfig = {
     language: config.language || 'en-US',
     castCount: config.castCount || 0,
     blurThumbs: config.blurThumbs || false,
     showPrefix: config.showPrefix || false,
     showMetaProviderAttribution: config.showMetaProviderAttribution || false,
     displayAgeRating: config.displayAgeRating || false,
     englishArtOnly: config.artProviders?.englishArtOnly || false,
     timezone: config.timezone || 'UTC',
     posterRatingProvider: config.posterRatingProvider || 'rpdb',
     usePosterProxy: !!config.usePosterProxy,
     apiKeys: { 
       rpdb: config.apiKeys?.rpdb || process.env.RPDB_API_KEY || '',
       topPoster: config.apiKeys?.topPoster || ''
     }
   };
   
   const animePrefixes = ['mal', 'kitsu', 'anilist', 'anidb'];
   const isAnime = metaType === 'anime' || animePrefixes.includes(prefix);
   //const isImdbIdAnime = metaId.startsWith('tt') && !!idMapper.getMappingByImdbId(metaId);
   //const isAnimeWithImdbId = isAnime || (isImdbIdAnime && config.providers?.forceAnimeForDetectedImdb);
   if (isAnime) {
     metaConfig.metaProvider = config.providers?.anime || 'mal';
     metaConfig.artProvider = {
       poster: resolveArtProvider('anime', 'poster', config),
       background: resolveArtProvider('anime', 'background', config),
       logo: resolveArtProvider('anime', 'logo', config)
     };
     metaConfig.mal = {
       skipFiller: config.mal?.skipFiller || false,
       skipRecap: config.mal?.skipRecap || false,
       allowEpisodeMarking: config.mal?.allowEpisodeMarking || false,
       useImdbIdForCatalogAndSearch: config.mal?.useImdbIdForCatalogAndSearch || false
     };
   } else if (metaType === 'movie') {
    metaConfig.metaProvider = config.providers?.movie || 'tmdb';
    metaConfig.artProvider = {
      poster: resolveArtProvider('movie', 'poster', config),
      background: resolveArtProvider('movie', 'background', config),
      logo: resolveArtProvider('movie', 'logo', config)
    };
    metaConfig.tmdb = {
    scrapeImdb: config.tmdb?.scrapeImdb || false,
    forceLatinCastNames: config.tmdb?.forceLatinCastNames || false
   };
  } else if (metaType === 'series') {
    metaConfig.metaProvider = config.providers?.series || 'tvdb';
    metaConfig.artProvider = {
      poster: resolveArtProvider('series', 'poster', config),
      background: resolveArtProvider('series', 'background', config),
      logo: resolveArtProvider('series', 'logo', config)
    };
    metaConfig.tvdbSeasonType = config.tvdbSeasonType || 'default';
    metaConfig.tmdb = {
      scrapeImdb: config.tmdb?.scrapeImdb || false,
      forceLatinCastNames: config.tmdb?.forceLatinCastNames || false
    };
   metaConfig.forceAnimeForDetectedImdb = config.providers?.forceAnimeForDetectedImdb;
   metaConfig.useShowPosterForUpNext = useShowPoster;
 }
 metaConfig.animeIdProvider = config.providers?.anime_id_provider || 'imdb';
 
 const metaConfigString = stableStringify(metaConfig);
 const configHash = hashConfig(metaConfigString);
  const debugSig = shortSignature(`${userUUID}|${configHash}`);
  
  // Define component cache keys
  const componentCacheKeys = {
    basic: `meta-basic:${configHash}:${metaId}`,
     poster: `meta-poster:${configHash}:${metaId}`,
     rawPoster: `meta-raw-poster:${configHash}:${metaId}`,
     background: `meta-background:${configHash}:${metaId}`,
     landscapePoster: `meta-landscape-poster:${configHash}:${metaId}`,
     logo: `meta-logo:${configHash}:${metaId}`,
     videos: `meta-videos:${configHash}:${metaId}`,
     cast: `meta-cast:${configHash}:${metaId}`,
     director: `meta-director:${configHash}:${metaId}`,
     writer: `meta-writer:${configHash}:${metaId}`,
     links: `meta-links:${configHash}:${metaId}`,
     trailers: `meta-trailers:${configHash}:${metaId}`,
     extras: `meta-extras:${configHash}:${metaId}`
   };
   
   // Try to fetch all components from cache using MGET (optimized single round trip)
  const componentNames = Object.keys(componentCacheKeys);
  const cacheKeys = Object.values(componentCacheKeys).map(key => `v${ADDON_VERSION}:${key}`);
  
  let componentResults = [];
  
  // Short-circuit if no cache keys to fetch
  if (cacheKeys.length === 0) {
    componentResults = componentNames.map(componentName => ({ componentName, data: null }));
  } else {
    try {
      // Use MGET to fetch all keys in a single network round trip
      const cachedValues = await redis.mget(...cacheKeys);
    
    // Map results back to component names
    componentResults = componentNames.map((componentName, index) => {
      const cached = cachedValues[index];
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          //console.log(`📦 [Cache] Component HIT: ${componentName} for ${metaId}`);
          return { componentName, data: parsed };
        } catch (parseError) {
          cacheLogger.warn(`Error parsing component ${componentName}:`, parseError);
          return { componentName, data: null };
        }
      } else {
        //console.log(`📦 [Cache] Component MISS: ${componentName} for ${metaId}`);
        return { componentName, data: null };
      }
    });
    } catch (error) {
      cacheLogger.warn(`Error fetching components with MGET:`, error);
      // Fallback: return empty results
      componentResults = componentNames.map(componentName => ({ componentName, data: null }));
    }
  }
  
  const availableComponents = componentResults.filter(result => result.data !== null);
  
  if (availableComponents.length === 0) {
    const metaReconstructionKey = `meta:reconstructed:${metaId}`;
    updateCacheHealth(metaReconstructionKey, 'miss', true);
    return { errorReason: 'no cached components' };
  }
   
   // Reconstruct meta object from available components
   const reconstructedMeta = {};
   
   // Start with basic meta
  const basicComponent = availableComponents.find(c => c.componentName === 'basic');
  if (basicComponent) {
    Object.assign(reconstructedMeta, basicComponent.data);
    reconstructedMeta.posterShape = basicComponent.data.posterShape;

    const bd = basicComponent.data;

    if (bd._hasPoster) {
        const hasPoster = availableComponents.some(c => c.componentName === 'poster');
        if (!hasPoster) {
            cacheLogger.warn(`[Reconstruct] Integrity failure for ${metaId}: Missing required poster.`);
            updateCacheHealth(`meta:reconstructed:${metaId}`, 'miss', true);
            return { errorReason: 'corrupted: missing poster' };
        }
    }

    if (bd._hasBackground) {
        const hasBg = availableComponents.some(c => c.componentName === 'background');
        if (!hasBg) {
            cacheLogger.warn(`[Reconstruct] Integrity failure for ${metaId}: Missing required background.`);
            updateCacheHealth(`meta:reconstructed:${metaId}`, 'miss', true);
            return { errorReason: 'corrupted: missing background' };
        }
    }
    if (bd._hasLandscapePoster) {
        const hasLandscapePoster = availableComponents.some(c => c.componentName === 'landscapePoster');
        if (!hasLandscapePoster) {
            cacheLogger.warn(`[Reconstruct] Integrity failure for ${metaId}: Missing required landscape poster.`);
            updateCacheHealth(`meta:reconstructed:${metaId}`, 'miss', true);
            return { errorReason: 'corrupted: missing landscape poster' };
        }
    }

    if (bd._hasLogo) {
        const hasLogo = availableComponents.some(c => c.componentName === 'logo');
        if (!hasLogo) {
            cacheLogger.warn(`[Reconstruct] Integrity failure for ${metaId}: Missing required logo.`);
            updateCacheHealth(`meta:reconstructed:${metaId}`, 'miss', true);
            return { errorReason: 'corrupted: missing logo' };
        }
    }

    if (includeVideos && bd._hasVideos) {
        const hasVideos = availableComponents.some(c => c.componentName === 'videos');
        if (!hasVideos) {
            cacheLogger.warn(`[Reconstruct] Integrity failure for ${metaId}: Missing required videos.`);
            updateCacheHealth(`meta:reconstructed:${metaId}`, 'miss', true);
            return { errorReason: 'corrupted: missing videos' };
        }
    }
  }

  
   // Add other components
   availableComponents.forEach(({ componentName, data }) => {
     if (componentName === 'basic') return; // Already handled
     
     if (componentName === 'poster') {
       // Apply poster rating logic during reconstruction if enabled
       // Use module-level context to get accurate enablement state
       const posterRatingEnabled = currentRequestContext.catalogConfig?.enableRatingPosters !== false;
       const host = process.env.HOST_NAME.startsWith('http')
         ? process.env.HOST_NAME
         : `https://${process.env.HOST_NAME}`;
       
       const isUpNextWithEpisodeThumbnail = (metaId.startsWith('upnext_') || metaId.startsWith('mdblist_upnext_')) && !useShowPoster;
       const hasEpisodeThumbnailShape = reconstructedMeta.posterShape === 'landscape';
       
       if (posterRatingEnabled && reconstructedMeta.id && !isUpNextWithEpisodeThumbnail && !hasEpisodeThumbnailShape) {
         // Apply poster rating proxy/direct URL to cached poster
         const language = config.language || 'en-US';
         const Utils = require("../utils/parseProps");
         // Strip known prefixes used for special metas (upnext_, unwatched_, tun_, mdblist_upnext_)
         let canonicalProxyId = reconstructedMeta.id.replace(/^(upnext_|unwatched_|tun_|mdblist_upnext_)/, '');
         // Also strip any trailing episode identifier we append to upnext cache keys
         // Examples: 'tmdb:123_trakt456' or 'tvdb:789_S1E02' -> keep only the canonical media id
         canonicalProxyId = canonicalProxyId.replace(/_(trakt\d+|S\d+E\d+)$/i, '');
         //cacheLogger.debug(`[Reconstruct] Rebuilding poster proxy URL for ${reconstructedMeta.id} (canonical: ${canonicalProxyId}), cached poster: ${data.poster?.substring(0, 100)}...`);
         reconstructedMeta.poster = Utils.buildPosterProxyUrl(host, reconstructedMeta.type, canonicalProxyId, data.poster, language, config);
       } else {
        if (isUpNextWithEpisodeThumbnail || hasEpisodeThumbnailShape) {
          cacheLogger.debug(`[Reconstruct] Preserving cached episode thumbnail for ${metaId}...`);
        }
        if (data.poster && data.poster.includes('/poster/')) {
          try {
            const urlObj = new URL(data.poster);
            const fallback = urlObj.searchParams.get('fallback');
            if (fallback) {
              reconstructedMeta.poster = decodeURIComponent(fallback);
            } else {
              reconstructedMeta.poster = data.poster;
            }
          } catch(e) {
            reconstructedMeta.poster = data.poster;
          }
        } else {
          reconstructedMeta.poster = data.poster;
        }
      }
     } else if (componentName === 'rawPoster') {
       reconstructedMeta._rawPosterUrl = data._rawPosterUrl;
     } else if (componentName === 'background') {
       reconstructedMeta.background = data.background;
     } else if (componentName === 'landscapePoster') {
       reconstructedMeta.landscapePoster = data.landscapePoster;
     } else if (componentName === 'logo') {
       reconstructedMeta.logo = data.logo;
     } else if (componentName === 'videos') {
       reconstructedMeta.videos = data.videos;
     } else if (componentName === 'cast') {
       if (!reconstructedMeta.app_extras) reconstructedMeta.app_extras = {};
       reconstructedMeta.app_extras.cast = data.cast;
     } else if (componentName === 'director') {
       if (!reconstructedMeta.app_extras) reconstructedMeta.app_extras = {};
       reconstructedMeta.app_extras.directors = data.directors;
     } else if (componentName === 'writer') {
       if (!reconstructedMeta.app_extras) reconstructedMeta.app_extras = {};
       reconstructedMeta.app_extras.writers = data.writers;
     } else if (componentName === 'links') {
       reconstructedMeta.links = data.links;
     } else if (componentName === 'trailers') {
       if (data.trailers) reconstructedMeta.trailers = data.trailers;
       if (data.trailerStreams) reconstructedMeta.trailerStreams = data.trailerStreams;
     } else if (componentName === 'extras') {
       reconstructedMeta.app_extras = data.app_extras;
     }
   });
   
  if (!reconstructedMeta.poster && reconstructedMeta._rawPosterUrl) {
    cacheLogger.debug(`[Reconstruct] Missing poster component for ${metaId}, using _rawPosterUrl as fallback: ${reconstructedMeta._rawPosterUrl?.substring(0, 100)}...`);
    reconstructedMeta.poster = reconstructedMeta._rawPosterUrl;
  }
  
  // Validate the reconstructed meta
  if (!reconstructedMeta.id || !reconstructedMeta.name || !reconstructedMeta.type) {
    cacheLogger.warn(`Reconstructed meta missing required fields for ${metaId}`);
    const metaReconstructionKey = `meta:reconstructed:${metaId}`;
    updateCacheHealth(metaReconstructionKey, 'miss', true);
    return { errorReason: 'missing required fields' };
  }
  
  // Context-aware videos check: only require videos if the caller needs them
  if ((reconstructedMeta.type === 'series') && includeVideos) {
    const videosComponent = availableComponents.find(c => c.componentName === 'videos');
    
    // If videos are required but not found in cache, fail the reconstruction
    if (!videosComponent) {
      const metaReconstructionKey = `meta:reconstructed:${metaId}`;
      updateCacheHealth(metaReconstructionKey, 'miss', true);
      return { errorReason: 'required videos component missing' };
    }
    
    // Also check if videos array is valid
    const videos = reconstructedMeta.videos;
    if (!videos || !Array.isArray(videos) || videos.length === 0) {
      const metaReconstructionKey = `meta:reconstructed:${metaId}`;
      updateCacheHealth(metaReconstructionKey, 'miss', true);
      return { errorReason: 'empty videos for series' };
    }
  }
  
  // Capture metadata for dashboard display (fire-and-forget)
  try {
    const requestTracker = require('./requestTracker');
    requestTracker.captureMetadataFromComponents(metaId, reconstructedMeta, reconstructedMeta.type).catch(() => {});
  } catch (error) {
    cacheLogger.warn(`Failed to capture reconstructed metadata for dashboard: ${error.message}`);
  }
  
  const metaReconstructionKey = `meta:reconstructed:${metaId}`;
  updateCacheHealth(metaReconstructionKey, 'hit', true);
  
  return { meta: reconstructedMeta };
}

/**
 * meta cache wrapper that tries component reconstruction first, then falls back to full generation
 * This provides granular caching with graceful degradation
 * @param {boolean} includeVideos - Whether videos are required for this request (default: true)
 */
async function cacheWrapMetaSmart(userUUID, metaId, method, ttl = META_TTL, options = {}, type = null, includeVideos = true, useShowPoster = false) {
  cacheLogger.debug(`[Meta] Smart caching for ${metaId} (type:${type}, videos:${includeVideos}, showPoster:${useShowPoster})`);
   
   // First, try to reconstruct from cached components BEFORE calling method
   const reconstructedMeta = await reconstructMetaFromComponents(userUUID, metaId, ttl, options, type, includeVideos, useShowPoster);
  
  if (reconstructedMeta && reconstructedMeta.meta) {
    cacheLogger.debug(`[Meta] Component reconstruction successful for ${metaId}`);
    return reconstructedMeta;
  }
   
  const failureReason = reconstructedMeta && reconstructedMeta.errorReason ? ` (reason: ${reconstructedMeta.errorReason})` : '';
  cacheLogger.debug(`[Meta] Component reconstruction failed for ${metaId}, generating full meta${failureReason}`);
  
  const result = await method();
  
  // Handle null/empty results
  if (!result || !result.meta) {
    cacheLogger.debug(`[Meta] Method returned null/empty result for ${metaId}`);
    return { meta: null };
  }
  
  const meta = result.meta;
  let idToCache = meta.id;
  
  // Validate that we have a valid ID to cache
  if (!idToCache || typeof idToCache !== 'string') {
    cacheLogger.warn(`Invalid meta.id for caching: ${idToCache}, using original metaId: ${metaId}`);
    idToCache = metaId;
  }
  
  if(metaId.startsWith('tun_')){
    idToCache = metaId;
  }
  
  return await cacheWrapMetaComponents(userUUID, idToCache, async () => result, ttl, options, type, useShowPoster);
}

/**
 * Simple component caching without validation
 * Used for individual meta components that don't need meta validation
 */
async function cacheComponent(cacheKey, componentData, ttl) {
  if (!redis || !componentData) return;
  
  const versionedKey = `v${ADDON_VERSION}:${cacheKey}`;
  
  try {
    await redis.set(versionedKey, JSON.stringify(componentData), 'EX', ttl);
  } catch (error) {
    cacheLogger.warn(`Failed to cache component for ${versionedKey}:`, error);
  }
}



function cacheWrapJikanApi(key, method, customTTL = null, options = {}) {
  const subkey = key.replace(/\s/g, '-');
  const ttl = customTTL !== null ? customTTL : JIKAN_API_TTL;
  
  // Custom result classifier for Jikan API - don't cache rate limit errors
  const jikanResultClassifier = (result, error = null) => {
    if (error) {
      // Don't cache 429 rate limit errors - they're temporary
      if (error.response?.status === 429 || error.message?.includes('429')) {
        cacheLogger.debug(`Jikan Cache - Skipping cache for rate limit error: ${key}`);
        return { type: 'SKIP_CACHE', ttl: 0 };
      }
      // Use default classification for other errors
      return classifyResult(result, error);
    }
    
    return classifyResult(result, error);
  };
  
  return cacheWrapGlobal(`jikan-api:${subkey}`, method, ttl, {
    resultClassifier: jikanResultClassifier,
    ...options
  });
}

function cacheWrapMDBListGenres(genreType, method) {
  // genreType should be 'genres-standard' or 'genres-anime'
  cacheLogger.debug(`Caching MDBList genres for type: ${genreType}`);
  return cacheWrapGlobal(`mdblist-${genreType}`, method, MDBLIST_GENRES_TTL);
}

function cacheWrapTraktGenres(genreType, method) {
  // genreType should be 'movies' or 'shows'
  cacheLogger.debug(`Caching Trakt genres for type: ${genreType}`);
  // Use same TTL as MDBList genres (30 days) since Trakt genres are also stable
  return cacheWrapGlobal(`trakt-genres-${genreType}`, method, MDBLIST_GENRES_TTL, { skipVersion: true });
}

function cacheWrapStremThruGenres(catalogUrl, method) {
  // Use a hash or simplified key from the catalog URL to avoid super long keys
  const urlKey = Buffer.from(catalogUrl).toString('base64').substring(0, 50);
  cacheLogger.debug(`Caching StremThru genres for catalog ${urlKey}`);
  return cacheWrapGlobal(`stremthru-genres:${urlKey}`, method, STREMTHRU_GENRES_TTL);
}

async function cacheWrapStaticCatalog(userUUID, catalogKey, method, options = {}) {
  // Load config from database
  let config;
  try {
    config = await loadConfigFromDatabase(userUUID);
  } catch (error) {
    cacheLogger.warn(`Failed to load config for user ${userUUID}: ${error.message}`);
    // Return empty response for invalid UUIDs instead of crashing
    return { metas: [] };
  }
  
  if (!config) {
    cacheLogger.warn(`No config found for user ${userUUID}`);
    return { metas: [] };
  }
  
  const idOnly = catalogKey.split(':')[0];
  
  // Create context-aware catalog config (only relevant parameters for catalogs)
  const catalogConfig = {
    // Language (affects all catalogs)
    language: config.language || 'en-US',
    
    // Provider settings (affect catalog content)
    providers: config.providers || {},
    artProviders: config.artProviders || {},
    
    // Content filtering (affects catalog results)
    sfw: config.sfw || false,
    includeAdult: config.includeAdult || false,
    ageRating: config.ageRating || null,
    exclusionKeywords: config.exclusionKeywords || null,
    regexExclusionFilter: config.regexExclusionFilter || null,
    showPrefix: config.showPrefix || false,
    showMetaProviderAttribution: config.showMetaProviderAttribution || false,
    displayAgeRating: config.displayAgeRating || false,
    usePosterProxy: !!config.usePosterProxy,
    // Anime-specific settings (for MAL catalogs)
    mal: config.mal || {}
  };

  const catalogConfigString = JSON.stringify(catalogConfig);
  const key = `catalog:${catalogConfigString}:${catalogKey}`;
  
  cacheLogger.debug(`Static catalog cache key (${idOnly}): ${key.substring(0, 120)}...`);
  
  return cacheWrap(key, method, STATIC_CATALOG_TTL, options);
}

function cacheWrapTvdbApi(key, method) {
  const fullKey = `tvdb-api:${key}`;
  // Custom result classifier for TVDB API - don't cache null results
  const tvdbResultClassifier = (result, error = null, cacheKey = null) => {
    const keyForClassify = cacheKey || fullKey;
    if (error) {
      return classifyResult(result, error, keyForClassify);
    }

    // Don't cache null results from TVDB API - let them retry immediately
    if (result === null || result === undefined) {
      cacheLogger.debug(`TVDB Cache - Skipping cache for null result: ${key}`);
      return { type: 'SKIP_CACHE', ttl: 0 };
    }

    return classifyResult(result, error, keyForClassify);
  };

  return cacheWrapGlobal(`tvdb-api:${key}`, method, TVDB_API_TTL, {
    resultClassifier: tvdbResultClassifier,
    skipVersion: true
  });
}

function cacheWrapTvmazeApi(key, method) {
  const tvmazeResultClassifier = (result, error = null) => {
    if (error) {
      return classifyResult(result, error);
    }
    
    // Don't cache null results from TVmaze API - let them retry immediately
    if (result === null || result === undefined) {
      cacheLogger.debug(`TVmaze Cache - Skipping cache for null result: ${key}`);
      return { type: 'SKIP_CACHE', ttl: 0 };
    }
    
    return classifyResult(result, error);
  };

  return cacheWrapGlobal(`tvmaze-api:${key}`, method, TVMAZE_API_TTL, {
    resultClassifier: tvmazeResultClassifier
  });
}

/**
 * Get cache health statistics
 */
function getCacheHealth() {
  const total = cacheHealth.hits + cacheHealth.misses;
  
  return {
    hits: cacheHealth.hits,
    misses: cacheHealth.misses,
    errors: cacheHealth.errors,
    cachedErrors: cacheHealth.cachedErrors,
    corruptedEntries: cacheHealth.corruptedEntries,
    hitRate: total > 0 ? ((cacheHealth.hits / total) * 100).toFixed(2) : '0.00',
    errorRate: total > 0 ? ((cacheHealth.errors / total) * 100).toFixed(2) : '0.00',
    totalRequests: total,
    mostAccessedKeys: Array.from(cacheHealth.keyAccessCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([key, count]) => ({ key, count }))
  };
}

/**
 * Clear cache health statistics
 */
function clearCacheHealth() {
  cacheHealth.hits = 0;
  cacheHealth.misses = 0;
  cacheHealth.errors = 0;
  cacheHealth.cachedErrors = 0;
  cacheHealth.corruptedEntries = 0;
  cacheHealth.errorCounts = {};
  cacheHealth.keyAccessCounts.clear();
  cacheHealthLogger.info('Statistics cleared');
}

/**
 * Clear a specific cache key from Redis
 */
async function clearCache(key) {
  if (!redis) {
    cacheLogger.warn('Redis not available, cannot clear cache');
    return;
  }
  
  try {
    const result = await redis.del(key);
    cacheLogger.info(`Cleared key: ${key} (${result} keys removed)`);
    return result;
  } catch (error) {
    cacheLogger.error(`Failed to clear key ${key}:`, error.message);
    throw error;
  }
}

/**
 * Generate cache key for AniList catalog data
 * Includes username, list name, and page for unique identification
 * @param {string} username - AniList username
 * @param {string} listName - Name of the AniList list
 * @param {number} page - Page number for pagination
 * @returns {string} Cache key
 */
function generateAniListCatalogCacheKey(username, listName, page) {
  return `anilist-catalog:${username}:${listName}:page${page}`;
}

/**
 * Cache wrapper for AniList catalog data
 * Supports configurable TTL from catalog config
 * @param {string} username - AniList username
 * @param {string} listName - Name of the AniList list
 * @param {number} page - Page number for pagination
 * @param {function} method - Async function to fetch data if not cached
 * @param {number} customTTL - Optional custom TTL in seconds (defaults to ANILIST_CATALOG_TTL)
 * @param {object} options - Additional cache options
 * @returns {Promise<any>} Cached or freshly fetched data
 */
async function cacheWrapAniListCatalog(username, listName, page, method, customTTL = null, options = {}) {
  const key = generateAniListCatalogCacheKey(username, listName, page);
  const ttl = customTTL !== null ? customTTL : ANILIST_CATALOG_TTL;
  
  cacheLogger.debug(`[AniList] Cache key: ${key}, TTL: ${ttl}s`);
  
  return cacheWrap(key, method, ttl, options);
}

module.exports = {
  redis,
  cacheWrap,
  cacheWrapGlobal,
  deleteKeysByPattern,
  scanKeys,
  cacheWrapCatalog,
  cacheWrapSearch,
  cacheWrapJikanApi,
  cacheWrapMDBListGenres,
  cacheWrapTraktGenres,
  cacheWrapStremThruGenres,
  cacheWrapStaticCatalog,
  cacheWrapMeta,
  cacheWrapMetaComponents,
  reconstructMetaFromComponents,
  cacheWrapMetaSmart,
  getCacheHealth,
  clearCacheHealth,
  clearCache,
  logCacheHealth,
  cacheWrapTvdbApi,
  cacheWrapTvmazeApi,
  cacheWrapAniListCatalog,
  generateAniListCatalogCacheKey,
  stableStringify
};
