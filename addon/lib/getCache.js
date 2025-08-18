// FILE: lib/getCache.js

const packageJson = require('../../package.json');
const redis = require('./redisClient');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const GLOBAL_NO_CACHE = process.env.NO_CACHE === 'true';
const ADDON_VERSION = packageJson.version;

// --- Time To Live (TTL) constants in seconds ---
const META_TTL = parseInt(process.env.META_TTL || 7 * 24 * 60 * 60, 10);
const CATALOG_TTL = parseInt(process.env.CATALOG_TTL || 1 * 24 * 60 * 60, 10);
const JIKAN_API_TTL = 7 * 24 * 60 * 60;
const STATIC_CATALOG_TTL = 30 * 24 * 60 * 60;
const TVDB_API_TTL = 12 * 60 * 60;
const TVMAZE_API_TTL = 12 * 60 * 60;

// Enhanced error caching strategy with self-healing
const ERROR_TTL_STRATEGIES = {
  EMPTY_RESULT: 5 * 60,        // 5 minutes for empty results
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
  corruptedEntries: 0,
  lastHealthCheck: Date.now(),
  errorCounts: {},
  keyAccessCounts: new Map()
};

// Self-healing configuration
const SELF_HEALING_CONFIG = {
  enabled: process.env.ENABLE_SELF_HEALING !== 'false',
  maxRetries: parseInt(process.env.CACHE_MAX_RETRIES || '2', 10),
  retryDelay: parseInt(process.env.CACHE_RETRY_DELAY || '1000', 10),
  healthCheckInterval: parseInt(process.env.CACHE_HEALTH_CHECK_INTERVAL || '300000', 10), // 5 minutes
  corruptedEntryThreshold: parseInt(process.env.CACHE_CORRUPTED_THRESHOLD || '10', 10)
};

const inFlightRequests = new Map();
const cacheValidator = require('./cacheValidator');

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

/**
 * Self-healing cache health monitoring
 */
function updateCacheHealth(key, type, success = true) {
  cacheHealth.keyAccessCounts.set(key, (cacheHealth.keyAccessCounts.get(key) || 0) + 1);
  
  if (success) {
    if (type === 'hit') cacheHealth.hits++;
    else if (type === 'miss') cacheHealth.misses++;
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
  const total = cacheHealth.hits + cacheHealth.misses;
  const hitRate = total > 0 ? ((cacheHealth.hits / total) * 100).toFixed(2) : '0.00';
  const errorRate = total > 0 ? ((cacheHealth.errors / total) * 100).toFixed(2) : '0.00';
  
  console.log(`[Cache Health] Hit Rate: ${hitRate}%, Error Rate: ${errorRate}%, Total: ${total}`);
  console.log(`[Cache Health] Hits: ${cacheHealth.hits}, Misses: ${cacheHealth.misses}, Errors: ${cacheHealth.errors}`);
  
  // Log most accessed keys
  const topKeys = Array.from(cacheHealth.keyAccessCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  
  if (topKeys.length > 0) {
    console.log('[Cache Health] Most accessed keys:', topKeys.map(([key, count]) => `${key}:${count}`).join(', '));
  }
}

/**
 * Self-healing: Attempt to repair corrupted cache entries
 */
async function attemptSelfHealing(key, originalError) {
  if (!SELF_HEALING_CONFIG.enabled) return false;
  
  try {
    console.log(`[Self-Healing] Attempting to repair corrupted cache entry: ${key}`);
    
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
    
    console.log(`[Self-Healing] Successfully repaired corrupted cache entry: ${key}`);
    return true;
  } catch (error) {
    console.error(`[Self-Healing] Failed to repair cache entry ${key}:`, error);
    return false;
  }
}

/**
 * Enhanced result classification with self-healing awareness
 */
function classifyResult(result, error = null) {
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
  
  // Check for empty/meaningless results
  if (Array.isArray(result.metas) && result.metas.length === 0) {
    return { type: 'EMPTY_RESULT', ttl: ERROR_TTL_STRATEGIES.EMPTY_RESULT };
  }
  
  if (result.meta === null || result.meta === undefined) {
    return { type: 'EMPTY_RESULT', ttl: ERROR_TTL_STRATEGIES.EMPTY_RESULT };
  }
  
  // Good result
  return { type: 'SUCCESS', ttl: null };
}

/**
 * Enhanced cache wrapper with self-healing capabilities
 */
async function cacheWrap(key, method, ttl, options = {}) {
  if (GLOBAL_NO_CACHE || !redis) {
    return method();
  }

  const versionedKey = `v${ADDON_VERSION}:${key}`;
  const { enableErrorCaching = true, resultClassifier = classifyResult, maxRetries = SELF_HEALING_CONFIG.maxRetries } = options;

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
              console.log(`[Cache] Retrying expired temporary error for ${versionedKey}`);
              await redis.del(versionedKey);
            } else {
              console.log(`[Cache] HIT (cached error) for ${versionedKey}`);
              updateCacheHealth(versionedKey, 'hit', true);
              return parsed;
            }
          } else if (parsed.error) {
            console.log(`[Cache] HIT (cached error) for ${versionedKey}`);
            updateCacheHealth(versionedKey, 'hit', true);
            return parsed;
          } else {
            console.log(`[Cache] HIT for ${versionedKey}`);
            updateCacheHealth(versionedKey, 'hit', true);
            return parsed;
          }
        } catch (parseError) {
          console.warn(`[Cache] Corrupted cache entry for ${versionedKey}, attempting self-healing`);
          await attemptSelfHealing(versionedKey, parseError);
          // Continue to retry the method
        }
    }
  } catch (err) {
    console.warn(`[Cache] Failed to read from Redis for key ${versionedKey}:`, err);
      updateCacheHealth(versionedKey, 'error', false);
  }

  const promise = method();
  inFlightRequests.set(versionedKey, promise);

  try {
    const result = await promise;
      console.log(`[Cache] MISS for ${versionedKey}`);
      updateCacheHealth(versionedKey, 'miss', true);
      
    if (result !== null && result !== undefined) {
        // Validate data before caching to prevent bad data from being cached
        const contentType = key.startsWith('meta') ? 'meta' : key.startsWith('catalog') ? 'catalog' : 'unknown';
        const validation = cacheValidator.validateBeforeCache(result, contentType);
        
        if (!validation.isValid) {
          console.warn(`[Cache] Preventing bad data from being cached for ${versionedKey}:`, validation.issues);
          updateCacheHealth(versionedKey, 'error', false);
          throw new Error(`Bad data detected: ${validation.issues.join(', ')}`);
        }
        
        const classification = resultClassifier(result);
        const finalTtl = classification.ttl || ttl;
        
        if (classification.type !== 'SUCCESS') {
          console.warn(`[Cache] Caching ${classification.type} result for ${versionedKey} for ${finalTtl}s`);
        }
        
        try {
          await redis.set(versionedKey, JSON.stringify(result), 'EX', finalTtl);
      } catch (err) {
        console.warn(`[Cache] Failed to write to Redis for key ${versionedKey}:`, err);
          updateCacheHealth(versionedKey, 'error', false);
        }
    }
    return result;
  } catch (error) {
    console.error(`[Cache] Method failed for cache key ${versionedKey}:`, error);
      updateCacheHealth(versionedKey, 'error', false);
      
      // Cache error results if enabled
      if (enableErrorCaching) {
        const classification = resultClassifier(null, error);
        const errorTtl = classification.ttl;
        
        try {
          const errorResult = { 
            error: true, 
            type: classification.type, 
            message: error.message,
            timestamp: new Date().toISOString()
          };
          await redis.set(versionedKey, JSON.stringify(errorResult), 'EX', errorTtl);
          console.warn(`[Cache] Cached ${classification.type} error for ${versionedKey} for ${errorTtl}s`);
        } catch (err) {
          console.warn(`[Cache] Failed to cache error for key ${versionedKey}:`, err);
        }
      }
      
      // Retry logic for temporary errors
      if (retries < maxRetries && (error.status >= 500 || error.message?.includes('timeout'))) {
        retries++;
        console.log(`[Cache] Retrying ${versionedKey} (attempt ${retries}/${maxRetries})`);
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

  const versionedKey = `global:${ADDON_VERSION}:${key}`;
  const { enableErrorCaching = true, resultClassifier = classifyResult, maxRetries = SELF_HEALING_CONFIG.maxRetries } = options;
  
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
              console.log(`[Global Cache] Retrying expired temporary error for ${versionedKey}`);
              await redis.del(versionedKey);
            } else {
              console.log(`[Global Cache] HIT (cached error) for ${versionedKey}`);
              updateCacheHealth(versionedKey, 'hit', true);
              return parsed;
            }
          } else if (parsed.error) {
            console.log(`[Global Cache] HIT (cached error) for ${versionedKey}`);
            updateCacheHealth(versionedKey, 'hit', true);
            return parsed;
          } else {
            console.log(`[Global Cache] HIT for ${versionedKey}`);
            updateCacheHealth(versionedKey, 'hit', true);
            return parsed;
          }
        } catch (parseError) {
          console.warn(`[Global Cache] Corrupted cache entry for ${versionedKey}, attempting self-healing`);
          await attemptSelfHealing(versionedKey, parseError);
        }
    }
  } catch (err) {
    console.warn(`[Global Cache] Redis GET error for key ${versionedKey}:`, err.message);
      updateCacheHealth(versionedKey, 'error', false);
  }

  const promise = method();
  inFlightRequests.set(versionedKey, promise);

  try {
    const result = await promise;
      console.log(`[Global Cache] MISS for ${versionedKey}`);
      updateCacheHealth(versionedKey, 'miss', true);

      const classification = resultClassifier(result);
      const finalTtl = classification.ttl || ttl;

      // Skip caching if result classifier says so
      if (classification.type === 'SKIP_CACHE') {
        console.log(`[Global Cache] Skipping cache for ${versionedKey} as requested by classifier`);
        return result;
      }

      if (classification.type !== 'SUCCESS') {
        console.warn(`[Global Cache] Caching ${classification.type} result for ${versionedKey} for ${finalTtl}s`);
    }

    if (result !== null && result !== undefined) {
      await redis.set(versionedKey, JSON.stringify(result), 'EX', finalTtl);
    }
    return result;
  } catch (error) {
    console.error(`[Global Cache] Method failed for cache key ${versionedKey}:`, error);
      updateCacheHealth(versionedKey, 'error', false);
      
      // Cache error results if enabled
      if (enableErrorCaching) {
        const classification = resultClassifier(null, error);
        const errorTtl = classification.ttl;
        
        try {
          const errorResult = { 
            error: true, 
            type: classification.type, 
            message: error.message,
            timestamp: new Date().toISOString()
          };
          await redis.set(versionedKey, JSON.stringify(errorResult), 'EX', errorTtl);
          console.warn(`[Global Cache] Cached ${classification.type} error for ${versionedKey} for ${errorTtl}s`);
        } catch (err) {
          console.warn(`[Global Cache] Failed to cache error for key ${versionedKey}:`, err);
        }
      }
      
      // Retry logic for temporary errors
      if (retries < maxRetries && (error.status >= 500 || error.message?.includes('timeout'))) {
        retries++;
        console.log(`[Global Cache] Retrying ${versionedKey} (attempt ${retries}/${maxRetries})`);
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

function cacheWrapCatalog(configString, catalogKey, method, options = {}) {
  const parsed = safeParseConfigString(configString);
  const language = parsed?.language || 'en-US';
  const trendingIds = new Set(['tmdb.trending']);
  const genresIds = new Set(['mal.genres']);
  const scheduleIds = new Set(['mal.schedule']);

  const idOnly = catalogKey.split(':')[0];

  // Globalize known config-independent catalogs
  if (trendingIds.has(idOnly)) {
    // For trending catalogs, include the type in the cache key to avoid conflicts between movie/series
    const type = catalogKey.split(':')[1]; // Extract type from catalogKey (e.g., "tmdb.trending:movie:{}")
    const globalKey = `catalog-global:${idOnly}:${type}:${language}`;
    return cacheWrapGlobal(globalKey, method, CATALOG_TTL, options);
  }
  // MAL catalogs should use full config cache since they depend on art providers, meta providers, etc.
  // But exclude search IDs which should use their own caching strategy
  if (genresIds.has(idOnly) || scheduleIds.has(idOnly) || 
      (idOnly.startsWith('mal.') && !idOnly.includes('search'))) {
    // Use full config cache for MAL catalogs since they depend on configuration
    const key = `catalog:${configString}:${catalogKey}`;
    
    // Debug: Log the cache key and parsed config for MAL catalogs
    const parsed = safeParseConfigString(configString);
    console.log(`[Cache Debug] MAL catalog cache key: ${key}`);
    console.log(`[Cache Debug] Art provider: ${parsed?.artProviders?.anime || 'not set'}`);
    console.log(`[Cache Debug] Config string length: ${configString?.length || 0}`);
    
    return cacheWrap(key, method, CATALOG_TTL, options);
  }

  const key = `catalog:${configString}:${catalogKey}`;
  return cacheWrap(key, method, CATALOG_TTL, options);
}

function cacheWrapMeta(configString, metaId, method, ttl = META_TTL, options = {}) {
   // Some metas can be shared globally when independent of config
   const parsed = safeParseConfigString(configString);
   const language = parsed?.language || 'en-US';
   const globalMetaPrefixes = ['tmdb:', 'tvdb:', 'imdb:', 'kitsu:', 'anilist:', 'anidb:', 'mal:', 'tvmaze:'];
   const isGlobalEligible = globalMetaPrefixes.some(p => metaId.startsWith(p));
   
   if (isGlobalEligible) {
     // For global meta, we need to include both metadata and art provider settings in the cache key
     // because both the data source and artwork can change based on provider preferences
     const artProviderKey = parsed?.artProviders ? 
       `${parsed.artProviders.movie || 'tmdb'}-${parsed.artProviders.series || 'tvdb'}-${parsed.artProviders.anime || 'mal'}` : 
       'tmdb-tvdb-mal';
     
     const metaProviderKey = parsed?.providers ?
       `${parsed.providers.movie || 'tmdb'}-${parsed.providers.series || 'tvdb'}-${parsed.providers.anime || 'mal'}` :
       'tmdb-tvdb-mal';
     
     const globalKey = `meta-global:${metaId}:${language}:${metaProviderKey}:${artProviderKey}`;
     return cacheWrapGlobal(globalKey, method, ttl, options);
   }
   
   const key = `meta:${configString}:${metaId}`;
   return cacheWrap(key, method, ttl, options);
}

function cacheWrapJikanApi(key, method) {
  const subkey = key.replace(/\s/g, '-');
  return cacheWrapGlobal(`jikan-api:${subkey}`, method, JIKAN_API_TTL);
}

function cacheWrapStaticCatalog(configString, catalogKey, method) {
  const fullKey = `catalog:${configString}:${catalogKey}`;
  return cacheWrap(fullKey, method, STATIC_CATALOG_TTL);
}

function cacheWrapTvdbApi(key, method) {
  // Custom result classifier for TVDB API - don't cache null results
  const tvdbResultClassifier = (result, error = null) => {
    if (error) {
      return classifyResult(result, error);
    }
    
    // Don't cache null results from TVDB API - let them retry immediately
    if (result === null || result === undefined) {
      console.log(`[TVDB Cache] Skipping cache for null result: ${key}`);
      return { type: 'SKIP_CACHE', ttl: 0 };
    }
    
    return classifyResult(result, error);
  };

  return cacheWrapGlobal(`tvdb-api:${key}`, method, TVDB_API_TTL, {
    resultClassifier: tvdbResultClassifier
  });
}

function cacheWrapTvmazeApi(key, method) {
  return cacheWrapGlobal(`tvmaze-api:${key}`, method, TVMAZE_API_TTL);
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
  cacheHealth.corruptedEntries = 0;
  cacheHealth.errorCounts = {};
  cacheHealth.keyAccessCounts.clear();
  console.log('[Cache Health] Statistics cleared');
}

module.exports = {
  redis,
  cacheWrap,
  cacheWrapGlobal,
  cacheWrapCatalog,
  cacheWrapJikanApi,
  cacheWrapStaticCatalog,
  cacheWrapMeta,
  getCacheHealth,
  clearCacheHealth,
  logCacheHealth,
  cacheWrapTvdbApi,
  cacheWrapTvmazeApi
};