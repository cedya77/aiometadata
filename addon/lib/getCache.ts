const buildInfo: any = require('./buildInfo');
const redis: any = require('./redisClient');
const { loadConfigFromDatabase }: any = require('./configApi');
const consola: any = require('consola');
const crypto: any = require('crypto');
const { isMetricsDisabled }: any = require('./metricsConfig');
const {
  decodeCachePayload,
  encodeCachePayload,
}: any = require('./cacheCodec');
const {
  canonicalizeLinksForCache,
  applyLinksUserScopeProjection,
}: any = require('./linkProjection');
const {
  RELEASE_AVAILABILITY_FIELD,
  normalizeMetaReleaseAvailability,
  normalizeReleaseAvailabilityInPayload,
}: any = require('../utils/releaseAvailability');

function hashConfig(configObj: any): string {
  const str = typeof configObj === 'string' ? configObj : stableStringify(configObj);
  return crypto.createHash('md5').update(str).digest('hex').substring(0, 10);
}

const cacheLogger = consola.withTag('Cache');
const globalCacheLogger = consola.withTag('Global-Cache');
const selfHealingLogger = consola.withTag('Self-Healing');
const cacheHealthLogger = consola.withTag('Cache-Health');

function parsePositiveIntEnv(envValue: any, defaultValue: number, minValue: number = 1, maxValue: number = 1000000): number {
  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed < minValue) {
    return defaultValue;
  }
  return Math.min(parsed, maxValue);
}


const GLOBAL_NO_CACHE = process.env.NO_CACHE === 'true';
const ADDON_VERSION = buildInfo.version;

const META_TTL = parseInt(process.env.META_TTL || String(7 * 24 * 60 * 60), 10);
const CATALOG_TTL = parseInt(process.env.CATALOG_TTL || String(1 * 24 * 60 * 60), 10);
const TMDB_TRENDING_TTL = parseInt(process.env.TMDB_TRENDING_TTL || String(3 * 60 * 60), 10);
const JIKAN_API_TTL = 30 * 24 * 60 * 60;
const STATIC_CATALOG_TTL = 30 * 24 * 60 * 60;
const TVDB_API_TTL = 12 * 60 * 60;
const TVMAZE_API_TTL = 12 * 60 * 60;
const MDBLIST_GENRES_TTL = 30 * 24 * 60 * 60;
const STREMTHRU_GENRES_TTL = 7 * 24 * 60 * 60;
const ANILIST_CATALOG_TTL = parseInt(process.env.ANILIST_CATALOG_TTL || String(1 * 60 * 60), 10);


const ERROR_TTL_STRATEGIES: Record<string, number> = {
  EMPTY_RESULT: 60,
  RATE_LIMITED: 15 * 60,
  TEMPORARY_ERROR: 2 * 60,
  PERMANENT_ERROR: 30 * 60,
  NOT_FOUND: 60 * 60,
  CACHE_CORRUPTED: 1 * 60,
};

const cacheHealth: any = {
  hits: 0,
  misses: 0,
  errors: 0,
  cachedErrors: 0,
  corruptedEntries: 0,
  lastHealthCheck: Date.now(),
  errorCounts: {},
  keyAccessCounts: new Map(),
};

const SELF_HEALING_CONFIG = {
  enabled: process.env.ENABLE_SELF_HEALING !== 'false',
  maxRetries: parsePositiveIntEnv(process.env.CACHE_MAX_RETRIES, 2),
  retryDelay: parsePositiveIntEnv(process.env.CACHE_RETRY_DELAY, 1000),
  healthCheckInterval: parsePositiveIntEnv(process.env.CACHE_HEALTH_CHECK_INTERVAL, 300000),
  corruptedEntryThreshold: parsePositiveIntEnv(process.env.CACHE_CORRUPTED_THRESHOLD, 10)
};

const MAX_TRACKED_KEYS = parsePositiveIntEnv(process.env.MAX_TRACKED_KEYS, 30000, 100);
const KEYS_TO_KEEP_AFTER_PRUNE = Math.min(
  parsePositiveIntEnv(process.env.KEYS_TO_KEEP_AFTER_PRUNE, 6000, 10),
  Math.max(1, MAX_TRACKED_KEYS - 1)
);

const inFlightRequests = new Map();
const cacheValidator: any = require('./cacheValidator');

async function singleFlight(key: string, factory: () => Promise<any>, cloneResult: (value: any) => any = value => value): Promise<any> {
  let promise = inFlightRequests.get(key);
  if (!promise) {
    promise = Promise.resolve()
      .then(factory)
      .finally(() => {
        if (inFlightRequests.get(key) === promise) {
          inFlightRequests.delete(key);
        }
      });
    inFlightRequests.set(key, promise);
  }

  return cloneResult(await promise);
}

function cloneJsonCompatibleResult(value: any): any {
  if (value === null || value === undefined) return value;

  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch (_) {
      // Fall through to JSON cloning, which matches Redis cache serialization.
    }
  }

  return JSON.parse(JSON.stringify(value));
}

async function deleteKeysByPattern(pattern: string, options: any = {}): Promise<number> {
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

async function scanKeys(pattern: string, cb: (key: string) => Promise<void> | void, options: any = {}): Promise<number> {
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

function stableStringify(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => stableStringify(v)).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function shortSignature(input: string): string {
  try {
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
      hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
    }
    return (hash >>> 0).toString(36);
  } catch {
    return 'na';
  }
}

function resolveArtProvider(contentType: string, artType: string, config: any): string {
  const artProviderConfig = config.artProviders?.[contentType];

  if (typeof artProviderConfig === 'string') {
    return artProviderConfig === 'meta'
      ? config.providers?.[contentType] || getDefaultProvider(contentType)
      : artProviderConfig;
  }

  if (artProviderConfig && typeof artProviderConfig === 'object') {
    const provider = artProviderConfig[artType];
    return provider === 'meta'
      ? config.providers?.[contentType] || getDefaultProvider(contentType)
      : provider || getDefaultProvider(contentType);
  }

  return config.providers?.[contentType] || getDefaultProvider(contentType);
}

function getDefaultProvider(contentType: string): string {
  switch (contentType) {
    case 'anime': return 'mal';
    case 'movie': return 'tmdb';
    case 'series': return 'tvdb';
    default: return 'tmdb';
  }
}

function truncateCacheKey(key: string, maxLength: number = 80): string {
  if (key.length <= maxLength) return key;

  const parts = key.split(':');
  if (parts.length >= 4) {
    const version = parts[0];
    const cacheType = parts[1];
    const catalogInfo = parts.slice(2).join(':');

    if (catalogInfo.includes('.') && catalogInfo.includes(':')) {
      const catalogParts = catalogInfo.split(':');
      const catalogProvider = catalogParts[0];
      const catalogType = catalogParts[1];
      const catalogParams = catalogParts.slice(2).join(':');

      const availableLength = maxLength - version.length - cacheType.length - catalogProvider.length - catalogType.length - catalogParams.length - 6;

      if (availableLength > 10) {
        return `${version}:${cacheType}:${catalogProvider}:${catalogType}:${catalogParams.substring(0, availableLength)}...`;
      } else {
        return `${version}:${cacheType}:${catalogProvider}:${catalogType}:...`;
      }
    }
  }

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

function pruneKeyAccessCounts(): { oldSize: number; newSize: number } | null {
  if (cacheHealth.keyAccessCounts.size <= MAX_TRACKED_KEYS) {
    return null;
  }

  const oldSize = cacheHealth.keyAccessCounts.size;
  const sorted = Array.from(cacheHealth.keyAccessCounts.entries())
    .sort((a: any, b: any) => b[1] - a[1])
    .slice(0, KEYS_TO_KEEP_AFTER_PRUNE);

  cacheHealth.keyAccessCounts.clear();
  for (const [trackedKey, count] of sorted as [string, number][]) {
    cacheHealth.keyAccessCounts.set(trackedKey, count);
  }

  return { oldSize, newSize: cacheHealth.keyAccessCounts.size };
}

function updateCacheHealth(key: string, type: string, success: boolean = true): void {
  const metricsDisabled = isMetricsDisabled();
  if (!metricsDisabled) {
    cacheHealth.keyAccessCounts.set(key, (cacheHealth.keyAccessCounts.get(key) || 0) + 1);
    pruneKeyAccessCounts();
  }

  if (success) {
    if (type === 'hit') {
      cacheHealth.hits++;
      try {
        const requestTracker = require('./requestTracker');
        requestTracker.trackCacheHit().catch(() => {});
      } catch (error: any) {
        // Ignore if requestTracker is not available
      }
    } else if (type === 'miss') {
      cacheHealth.misses++;
      try {
        const requestTracker = require('./requestTracker');
        requestTracker.trackCacheMiss().catch(() => {});
      } catch (error: any) {
        // Ignore if requestTracker is not available
      }
    } else if (type === 'cached-error') {
      cacheHealth.cachedErrors++;
      try {
        const requestTracker = require('./requestTracker');
        requestTracker.trackCacheMiss().catch(() => {});
      } catch (error: any) {
        // Ignore if requestTracker is not available
      }
    }
  } else {
    cacheHealth.errors++;
  }

  const now = Date.now();
  if (now - cacheHealth.lastHealthCheck > SELF_HEALING_CONFIG.healthCheckInterval) {
    logCacheHealth();
    cacheHealth.lastHealthCheck = now;
  }
}

function logCacheHealth(): void {
  if (isMetricsDisabled()) {
    return;
  }

  const total = cacheHealth.hits + cacheHealth.misses;
  const hitRate = total > 0 ? ((cacheHealth.hits / total) * 100).toFixed(2) : '0.00';
  const errorRate = total > 0 ? ((cacheHealth.errors / total) * 100).toFixed(2) : '0.00';

  cacheHealthLogger.info(`Hit Rate: ${hitRate}%, Error Rate: ${errorRate}%, Total: ${total}`);
  cacheHealthLogger.info(`Hits: ${cacheHealth.hits}, Misses: ${cacheHealth.misses}, Errors: ${cacheHealth.errors}, Cached Errors: ${cacheHealth.cachedErrors}`);

  const topKeys = Array.from(cacheHealth.keyAccessCounts.entries())
    .sort((a: any, b: any) => b[1] - a[1])
    .slice(0, 5);

  if (topKeys.length > 0) {
    cacheHealthLogger.info('Most accessed keys:', topKeys.map((entry: any) => `${entry[0]}:${entry[1]}`).join(', '));
  }

  const pruneResult = pruneKeyAccessCounts();
  if (pruneResult) {
    cacheHealthLogger.info(`Pruned keyAccessCounts Map: ${pruneResult.oldSize} -> ${pruneResult.newSize} keys`);
  }
}

async function attemptSelfHealing(key: string, originalError: any): Promise<boolean> {
  if (!SELF_HEALING_CONFIG.enabled) return false;

  try {
    selfHealingLogger.info(`Attempting to repair corrupted cache entry: ${key}`);

    await redis.del(key);
    cacheHealth.corruptedEntries++;

    const errorResult = {
      error: true,
      type: 'CACHE_CORRUPTED',
      message: 'Cache entry was corrupted and removed',
      originalError: originalError.message,
      timestamp: new Date().toISOString()
    };

    await redis.set(key, await encodeCachePayload(errorResult), 'EX', ERROR_TTL_STRATEGIES.CACHE_CORRUPTED);

    selfHealingLogger.success(`Successfully repaired corrupted cache entry: ${key}`);
    return true;
  } catch (error: any) {
    selfHealingLogger.error(`Failed to repair cache entry ${key}:`, error);
    return false;
  }
}

function classifyResult(result: any, error: any = null, cacheKey: string | null = null): { type: string; ttl: number | null } {
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
    cacheKey.includes('cinemeta-') ||
    cacheKey.includes('flixpatrol-')
  );

  if (isExternalApi) {
    const hasValidData = (() => {
      if (Array.isArray(result)) return result.length > 0;
      if (typeof result === 'string') return result.length > 0;
      if (typeof result === 'number') return true;
      if (typeof result === 'object' && result !== null) {
        const values = Object.values(result);
        if (values.length === 0) return false;
        return values.some((v: any) => {
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

  const hasMetaData = (result.meta && typeof result.meta === 'object' && Object.keys(result.meta).length > 0);
  const hasMetasData = (Array.isArray(result.metas) && result.metas.length > 0);
  const hasArrayData = (Array.isArray(result) && result.length > 0);

  if (hasMetaData || hasMetasData || hasArrayData) {
  return { type: 'SUCCESS', ttl: null };
  }

  return { type: 'EMPTY_RESULT', ttl: ERROR_TTL_STRATEGIES.EMPTY_RESULT };
}

async function cacheWrap(key: string, method: () => Promise<any>, ttl: number, options: any = {}): Promise<any> {
  if (GLOBAL_NO_CACHE || !redis) {
    return method();
  }

  const versionedKey = `v${ADDON_VERSION}:${key}`;
  return singleFlight(versionedKey, () => cacheWrapInternal(key, method, ttl, options, versionedKey));
}

async function cacheWrapInternal(key: string, method: () => Promise<any>, ttl: number, options: any, versionedKey: string): Promise<any> {
  const {
    enableErrorCaching = false,
    resultClassifier = classifyResult,
    maxRetries = SELF_HEALING_CONFIG.maxRetries,
    onHit,
  } = options;

  let retries = 0;

  while (retries <= maxRetries) {
  try {
    const cached = await redis.getBuffer(versionedKey);
    if (cached) {
        try {
          const parsed = await decodeCachePayload(cached);

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
            if (typeof onHit === 'function') {
              try {
                onHit({ key, versionedKey, value: parsed });
              } catch (hookError: any) {
                cacheLogger.warn(`[Cache] onHit hook failed for ${versionedKey}:`, hookError);
              }
            }
            updateCacheHealth(versionedKey, 'hit', true);
            return parsed;
          }
        } catch (parseError: any) {
          cacheLogger.warn(`Corrupted cache entry for ${versionedKey}, attempting self-healing`);
          await attemptSelfHealing(versionedKey, parseError);
        }
    }
  } catch (err: any) {
    cacheLogger.warn(`Failed to read from Redis for key ${versionedKey}:`, err);
      updateCacheHealth(versionedKey, 'error', false);
  }

  try {
    const result = await method();
      updateCacheHealth(versionedKey, 'miss', true);

    if (result !== null && result !== undefined) {
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

        if (finalTtl > 0) {
        if (classification.type !== 'SUCCESS') {
            cacheLogger.warn(`Caching ${classification.type} result for ${versionedKey} for ${finalTtl}s`);
        }

        try {
          await redis.set(versionedKey, await encodeCachePayload(result), 'EX', finalTtl);
      } catch (err: any) {
            cacheLogger.warn(`Failed to write to Redis for key ${versionedKey}:`, err);
          updateCacheHealth(versionedKey, 'error', false);
          }
        } else {
          cacheLogger.debug(`[Cache] Skipping cache for ${versionedKey} (TTL: 0)`);
        }
    }
    return result;
  } catch (error: any) {
    cacheLogger.error(`Method failed for cache key ${versionedKey}:`, error);
      updateCacheHealth(versionedKey, 'error', false);

      if (enableErrorCaching) {
        const classification = resultClassifier(null, error);
        const errorTtl = classification.ttl;

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
            await redis.set(versionedKey, await encodeCachePayload(errorResult), 'EX', errorTtl);
            cacheLogger.warn(`Cached ${classification.type} error for ${versionedKey} for ${errorTtl}s`);
          } catch (err: any) {
              cacheLogger.warn(`Failed to cache error for key ${versionedKey}:`, err);
          }
        }
      }

      if (retries < maxRetries && (error.status >= 500 || error.message?.includes('timeout'))) {
        retries++;
        cacheLogger.debug(`[Cache] Retrying ${versionedKey} (attempt ${retries}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, SELF_HEALING_CONFIG.retryDelay));
        continue;
      }

    throw error;
  }
  }
}

async function cacheWrapGlobal(key: string, method: () => Promise<any>, ttl: number, options: any = {}): Promise<any> {
  if (GLOBAL_NO_CACHE || !redis) {
    return method();
  }

  const { skipVersion = false } = options;
  const versionedKey = skipVersion ? `global:${key}` : `global:${ADDON_VERSION}:${key}`;
  return singleFlight(versionedKey, () => cacheWrapGlobalInternal(key, method, ttl, options, versionedKey));
}

async function cacheWrapGlobalInternal(key: string, method: () => Promise<any>, ttl: number, options: any, versionedKey: string): Promise<any> {
  const { enableErrorCaching = false, resultClassifier = classifyResult, maxRetries = SELF_HEALING_CONFIG.maxRetries } = options;

  let retries = 0;

  while (retries <= maxRetries) {
  try {
    const cached = await redis.getBuffer(versionedKey);
    if (cached) {
        try {
          const parsed = await decodeCachePayload(cached);

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
        } catch (parseError: any) {
          globalCacheLogger.warn(`Corrupted cache entry for ${versionedKey}, attempting self-healing`);
          await attemptSelfHealing(versionedKey, parseError);
        }
    }
  } catch (err: any) {
    globalCacheLogger.warn(`Redis GET error for key ${versionedKey}:`, err.message);
      updateCacheHealth(versionedKey, 'error', false);
  }

  try {
    const result = await method();
      updateCacheHealth(versionedKey, 'miss', true);

      const classification = resultClassifier(result, null, key);
      const finalTtl = classification.ttl !== null ? classification.ttl : ttl;

      if (classification.type === 'SKIP_CACHE') {
        globalCacheLogger.debug(`[Global-Cache] Skipping cache for ${truncateCacheKey(versionedKey)} as requested by classifier`);
        return result;
      }

      if (finalTtl > 0) {
      if (classification.type !== 'SUCCESS') {
        globalCacheLogger.warn(`Caching ${classification.type} result for ${versionedKey} for ${finalTtl}s`);
    }

    if (result !== null && result !== undefined) {
      await redis.set(versionedKey, await encodeCachePayload(result), 'EX', finalTtl);
        }
      } else {
        globalCacheLogger.debug(`[Global-Cache] Skipping cache for ${versionedKey} (TTL: 0)`);
    }
    return result;
  } catch (error: any) {
    globalCacheLogger.error(`Method failed for cache key ${versionedKey}:`, error);
      updateCacheHealth(versionedKey, 'error', false);

      if (enableErrorCaching) {
        const classification = resultClassifier(null, error);
        const errorTtl = classification.ttl;

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
            await redis.set(versionedKey, await encodeCachePayload(errorResult), 'EX', errorTtl);
            globalCacheLogger.warn(`Cached ${classification.type} error for ${versionedKey} for ${errorTtl}s`);
          } catch (err: any) {
            globalCacheLogger.warn(`Failed to cache error for key ${versionedKey}:`, err);
          }
        }
      }

      if (retries < maxRetries && (error.status >= 500 || error.message?.includes('timeout'))) {
        retries++;
        globalCacheLogger.debug(`[Global-Cache] Retrying ${truncateCacheKey(versionedKey)} (attempt ${retries}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, SELF_HEALING_CONFIG.retryDelay));
        continue;
      }

    throw error;
  }
  }
}

function getCatalogContentScope(idOnly: string, catalogType: string, config: any): string {
  const animeProviderPrefixes = ['kitsu.', 'anilist.', 'anidb.'];
  if (animeProviderPrefixes.some(p => idOnly.startsWith(p))) return 'anime';

  if (idOnly.startsWith('mal.')) {
    return config.mal?.useImdbIdForCatalogAndSearch ? (catalogType || 'mixed') : 'anime';
  }

  const simklAnimeCatalogs = ['simkl.trending.anime', 'simkl.calendar.anime'];
  if (simklAnimeCatalogs.includes(idOnly) ||
      idOnly.startsWith('simkl.watchlist.anime.') ||
      idOnly.startsWith('simkl.discover.anime.')) {
    return 'anime';
  }

  if (idOnly === 'simkl.calendar') return 'mixed';

  if (idOnly === 'mdblist.upnext') return 'series';
  if (idOnly === 'mdblist.watchlist') return 'mixed';

  if (idOnly.startsWith('letterboxd.')) return 'mixed';
  if (idOnly === 'publicmetadb.upnext') return 'series';

  if (catalogType === 'movie') return 'movie';
  if (catalogType === 'series') return 'series';
  return 'mixed';
}

function buildScopedProviderConfig(config: any, contentScope: string): any {
  if (contentScope === 'mixed') {
    return {
      providers: config.providers || {},
      artProviders: config.artProviders || {},
    };
  }

  const providers: any = {};
  const artProviders: any = {};

  if (contentScope === 'anime') {
    providers.anime = config.providers?.anime;
    providers.anime_id_provider = config.providers?.anime_id_provider;
    artProviders.anime = config.artProviders?.anime;
  } else if (contentScope === 'movie') {
    providers.movie = config.providers?.movie;
    artProviders.movie = config.artProviders?.movie;
  } else if (contentScope === 'series') {
    providers.series = config.providers?.series;
    artProviders.series = config.artProviders?.series;
    if (config.providers?.forceAnimeForDetectedImdb) {
      providers.forceAnimeForDetectedImdb = true;
      providers.anime = config.providers?.anime;
      providers.anime_id_provider = config.providers?.anime_id_provider;
      artProviders.anime = config.artProviders?.anime;
    }
  }

  artProviders.englishArtOnly = config.artProviders?.englishArtOnly;
  artProviders.originalLangFallback = config.artProviders?.originalLangFallback;

  return { providers, artProviders };
}

function getMetaCacheContext(config: any, metaId: string, type: string | null, useShowPoster: boolean = false): any {
  const [prefix] = metaId.split(':');
  const animePrefixes = ['mal', 'kitsu', 'anilist', 'anidb'];
  const isAnime = type === 'anime' || animePrefixes.includes(prefix);
  const contentType = isAnime ? 'anime' : type;

  const base = {
    language: config.language || 'en-US',
    contentType: contentType || 'unknown',
  };

  const artLanguagePolicy = {
    englishArtOnly: config.artProviders?.englishArtOnly || false,
    originalLangFallback: config.artProviders?.originalLangFallback || false,
  };

  const context: any = {
    prefix,
    isAnime,
    base,
    artLanguagePolicy,
    metaProvider: null,
    artProvider: {} as any,
    providerOptions: {},
    videoOptions: {},
    animeIdProvider: config.providers?.anime_id_provider || 'imdb',
    useShowPoster,
  };

  if (isAnime) {
    context.metaProvider = config.providers?.anime || 'mal';
    context.artProvider = {
      poster: resolveArtProvider('anime', 'poster', config),
      background: resolveArtProvider('anime', 'background', config),
      logo: resolveArtProvider('anime', 'logo', config),
    };
    context.videoOptions = {
      mal: {
        skipFiller: config.mal?.skipFiller || false,
        skipRecap: config.mal?.skipRecap || false,
        allowEpisodeMarking: config.mal?.allowEpisodeMarking || false,
        useImdbIdForCatalogAndSearch: config.mal?.useImdbIdForCatalogAndSearch || false,
      },
    };
  } else if (type === 'movie') {
    context.metaProvider = config.providers?.movie || 'tmdb';
    context.artProvider = {
      poster: resolveArtProvider('movie', 'poster', config),
      background: resolveArtProvider('movie', 'background', config),
      logo: resolveArtProvider('movie', 'logo', config),
    };
    context.providerOptions = {
      tmdb: {
        scrapeImdb: config.tmdb?.scrapeImdb || false,
        forceLatinCastNames: config.tmdb?.forceLatinCastNames || false,
      },
    };
  } else if (type === 'series') {
    context.metaProvider = config.providers?.series || 'tvdb';
    context.artProvider = {
      poster: resolveArtProvider('series', 'poster', config),
      background: resolveArtProvider('series', 'background', config),
      logo: resolveArtProvider('series', 'logo', config),
    };
    context.providerOptions = {
      tmdb: {
        scrapeImdb: config.tmdb?.scrapeImdb || false,
        forceLatinCastNames: config.tmdb?.forceLatinCastNames || false,
      },
      forceAnimeForDetectedImdb: config.providers?.forceAnimeForDetectedImdb || false,
    };
    context.videoOptions = {
      tvdbSeasonType: config.tvdbSeasonType || 'default',
      forceAnimeForDetectedImdb: config.providers?.forceAnimeForDetectedImdb || false,
    };
  }

  return context;
}

function hashProfile(profile: any): string {
  return hashConfig(stableStringify(profile));
}

function getMetaSmartLockContextHash(config: any, metaId: string, type: string | null, includeVideos: boolean, useShowPoster: boolean): string {
  return hashConfig({
    cacheContext: getMetaCacheContext(config, metaId, type, useShowPoster),
    projection: {
      blurThumbs: config.blurThumbs || false,
      displayAgeRating: config.displayAgeRating || false,
    },
    includeVideos: !!includeVideos,
  });
}

function buildMetaComponentCacheKeys({ config, metaId, type, useShowPoster = false }: { config: any; metaId: string; type: string | null; useShowPoster?: boolean }): Record<string, string> {
  const ctx = getMetaCacheContext(config, metaId, type, useShowPoster);
  const commonProvider = {
    ...ctx.base,
    metaProvider: ctx.metaProvider,
    animeIdProvider: ctx.animeIdProvider,
    providerOptions: ctx.providerOptions,
  };
  const artCommon = {
    ...ctx.base,
    metaProvider: ctx.metaProvider,
    artLanguagePolicy: ctx.artLanguagePolicy,
    providerOptions: ctx.providerOptions,
  };

  const basicProfile = {
    ...commonProvider,
    showMetaProviderAttribution: config.showMetaProviderAttribution || false,
  };
  const posterProfile = {
    ...artCommon,
    artProvider: ctx.artProvider.poster,
    useShowPosterForUpNext: !!ctx.useShowPoster,
  };
  const backgroundProfile = {
    ...artCommon,
    artProvider: ctx.artProvider.background,
  };
  const logoProfile = {
    ...artCommon,
    artProvider: ctx.artProvider.logo,
  };
  const videosProfile = {
    ...commonProvider,
    videoOptions: ctx.videoOptions,
  };
  const creditsProfile = {
    ...commonProvider,
  };
  const linksProfile = {
    ...commonProvider,
  };
  const trailersProfile = {
    ...commonProvider,
  };
  const extrasProfile = {
    ...commonProvider,
  };

  return {
    basic: `meta-basic:${hashProfile(basicProfile)}:${metaId}`,
    poster: `meta-poster:${hashProfile(posterProfile)}:${metaId}`,
    rawPoster: `meta-raw-poster:${hashProfile(posterProfile)}:${metaId}`,
    background: `meta-background:${hashProfile(backgroundProfile)}:${metaId}`,
    landscapePoster: `meta-landscape-poster:${hashProfile(backgroundProfile)}:${metaId}`,
    logo: `meta-logo:${hashProfile(logoProfile)}:${metaId}`,
    videos: `meta-videos:${hashProfile(videosProfile)}:${metaId}`,
    cast: `meta-cast:${hashProfile(creditsProfile)}:${metaId}`,
    director: `meta-director:${hashProfile(creditsProfile)}:${metaId}`,
    writer: `meta-writer:${hashProfile(creditsProfile)}:${metaId}`,
    links: `meta-links:${hashProfile(linksProfile)}:${metaId}`,
    trailers: `meta-trailers:${hashProfile(trailersProfile)}:${metaId}`,
    extras: `meta-extras:${hashProfile(extrasProfile)}:${metaId}`,
  };
}

function getBlurProxyPrefix(): string {
  const host = process.env.HOST_NAME?.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;
  return `${host}/api/image/blur?url=`;
}

function unwrapBlurThumbnail(thumbnail: string | null | undefined): string | null | undefined {
  if (!thumbnail || typeof thumbnail !== 'string') return thumbnail;
  const marker = '/api/image/blur?url=';
  if (!thumbnail.includes(marker)) return thumbnail;
  return decodeURIComponent(thumbnail.split(marker)[1] || '');
}

function canonicalizeVideosForCache(videos: any[]): any[] {
  if (!Array.isArray(videos)) return videos;
  return videos.map(video => ({
    ...video,
    thumbnail: unwrapBlurThumbnail(video.thumbnail),
  }));
}

function applyBlurThumbProjection(meta: any, config: any): any {
  if (!meta?.videos || !Array.isArray(meta.videos)) return meta;
  const shouldBlur = !!config.blurThumbs;
  const blurPrefix = getBlurProxyPrefix();
  meta.videos = meta.videos.map((video: any) => {
    const rawThumbnail = unwrapBlurThumbnail(video.thumbnail);
    if (!shouldBlur || !rawThumbnail || rawThumbnail.endsWith('/missing_thumbnail.png')) {
      return { ...video, thumbnail: rawThumbnail };
    }
    return { ...video, thumbnail: `${blurPrefix}${encodeURIComponent(rawThumbnail)}` };
  });
  return meta;
}

function stripCertificationLinks(links: any[], certification: string): any[] {
  if (!Array.isArray(links) || !certification) return links;
  return links.filter((link: any) => !(link?.name === certification && link?.category === 'Genres'));
}

function applyDisplayAgeRatingProjection(meta: any, config: any): any {
  const certification = meta?.app_extras?.certification;
  if (!certification) return meta;
  const links = Array.isArray(meta.links) ? stripCertificationLinks(meta.links, certification) : [];
  if (config.displayAgeRating) {
    const imdbId = meta.id?.match(/^tt\d+/)?.[0] || meta.imdb_id || meta._imdbId;
    const tmdbPath = meta.type === 'series' ? 'tv' : 'movie';
    const url = imdbId
      ? `https://www.imdb.com/title/${imdbId}/parentalguide/`
      : `https://www.themoviedb.org/${tmdbPath}/${meta.id}`;
    meta.links = [{ name: certification, category: 'Genres', url }, ...links];
  } else if (Array.isArray(meta.links)) {
    meta.links = links;
  }
  return meta;
}

function getConfiguredCastCount(config: any): number | null {
  if (config.castCount === undefined || config.castCount === null) return null;
  const count = Number(config.castCount);
  if (!Number.isFinite(count) || count < 0) return null;
  return Math.floor(count);
}

function applyCastCountProjection(meta: any, config: any): any {
  const castCount = getConfiguredCastCount(config);
  if (castCount === null) return meta;

  if (Array.isArray(meta?.app_extras?.cast)) {
    meta.app_extras.cast = meta.app_extras.cast.slice(0, castCount);
  }

  if (Array.isArray(meta?.links)) {
    const castLinks = meta.links.filter((l: any) => l.category === 'Cast');
    if (castLinks.length > castCount) {
      const kept = new Set(castLinks.slice(0, castCount));
      meta.links = meta.links.filter((l: any) => l.category !== 'Cast' || kept.has(l));
    }
  }

  if (castCount === 0) {
    if (Object.prototype.hasOwnProperty.call(meta, 'director')) {
      meta.director = Array.isArray(meta.director) ? [] : '';
    }
    if (Object.prototype.hasOwnProperty.call(meta, 'writer')) {
      meta.writer = Array.isArray(meta.writer) ? [] : '';
    }
    if (Object.prototype.hasOwnProperty.call(meta, 'writers')) {
      meta.writers = Array.isArray(meta.writers) ? [] : '';
    }
    if (meta.app_extras && Array.isArray(meta.app_extras.directors)) {
      meta.app_extras.directors = [];
    }
    if (meta.app_extras && Array.isArray(meta.app_extras.director)) {
      meta.app_extras.director = [];
    }
    if (meta.app_extras && Array.isArray(meta.app_extras.writers)) {
      meta.app_extras.writers = [];
    }
    if (Array.isArray(meta?.links)) {
      meta.links = meta.links.filter((l: any) => l.category !== 'Directors' && l.category !== 'Writers' && l.category !== 'Executive Producers');
    }
  }

  return meta;
}

function projectMetaForUser(meta: any, config: any): any {
  if (!meta) return meta;
  applyCastCountProjection(meta, config);
  applyBlurThumbProjection(meta, config);
  applyDisplayAgeRatingProjection(meta, config);
  applyLinksUserScopeProjection(meta, config);
  return meta;
}

const CATALOG_META_FIELDS = [
  'id',
  'type',
  'name',
  'poster',
  '_rawPosterUrl',
  'posterShape',
  'background',
  'landscapePoster',
  'logo',
  'description',
  'year',
  'releaseInfo',
  'released',
  RELEASE_AVAILABILITY_FIELD,
  'runtime',
  'genres',
  'cast',
  'director',
  'writer',
  'writers',
  'certification',
  'imdbRating',
  'country',
  'status',
  'isAnime',
  'imdb_id',
  '_imdbId',
  '_tmdbId',
  '_tvdbId',
  '_malId',
  '_kitsuId',
  '_anilistId',
  '_anidbId',
  'slug',
  'links',
  'behaviorHints',
  'trailers',
];

function projectAppExtrasForCatalogCache(appExtras: any): any {
  if (!appExtras || typeof appExtras !== 'object' || Array.isArray(appExtras)) {
    return undefined;
  }

  const projected: any = {};
  const fields = [
    'certification',
    'ratings',
    'releaseAvailability',
    'cast',
    'directors',
    'director',
    'writers',
    'writer',
    'producers',
  ];

  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(appExtras, field)) {
      projected[field] = appExtras[field];
    }
  }

  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectMetaForCatalogCache(meta: any): any {
  if (!meta || typeof meta !== 'object') return meta;

  const projected: any = {};
  for (const field of CATALOG_META_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(meta, field) && meta[field] !== undefined) {
      projected[field] = meta[field];
    }
  }

  const appExtras = projectAppExtrasForCatalogCache(meta.app_extras);
  if (appExtras) {
    projected.app_extras = appExtras;
  }

  return projected;
}

function projectCatalogPayloadForCache(payload: any): any {
  if (!payload || typeof payload !== 'object') return payload;
  if (!Array.isArray(payload.metas)) return payload;

  normalizeReleaseAvailabilityInPayload(payload);

  return {
    ...payload,
    metas: payload.metas.map(projectMetaForCatalogCache),
  };
}

function projectAppExtrasForComponentCache(appExtras: any): any {
  if (!appExtras || typeof appExtras !== 'object' || Array.isArray(appExtras)) {
    return appExtras;
  }

  const { cast, directors, writers, ...extras } = appExtras;

  for (const key of Object.keys(extras)) {
    const v = extras[key];
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) {
      delete extras[key];
    }
  }

  return Object.keys(extras).length > 0 ? extras : null;
}

async function resolveConfigForCache(userUUID: string, options: any = {}): Promise<any> {
  if (options?.config) {
    if (userUUID && !options.config.userUUID) {
      options.config.userUUID = userUUID;
    }
    return options.config;
  }

  const config = await loadConfigFromDatabase(userUUID);
  if (config && userUUID) {
    config.userUUID = userUUID;
  }
  if (config && options && typeof options === 'object') {
    options.config = config;
  }
  return config;
}

async function cacheWrapCatalog(userUUID: string, catalogKey: string, method: () => Promise<any>, options: any = {}): Promise<any> {
  let config: any;
  try {
    config = await resolveConfigForCache(userUUID, options);
  } catch (error: any) {
    cacheLogger.warn(`Failed to load config for user ${userUUID}: ${error.message}`);
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

  const isAuthCatalog = idOnly === 'tmdb.watchlist' || idOnly === 'tmdb.favorites';

  const isAiringTodayCatalog = idOnly === 'tmdb.airing_today';

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

  const catalogFromConfig = config.catalogs?.find((c: any) => c.id === idOnly && c.type === catalogType);
  const enableRatingPosters = catalogFromConfig?.enableRatingPosters !== false;
  const catalogHideWatchedTrakt = catalogFromConfig?.metadata?.hideWatchedTrakt;

  const contentScope = getCatalogContentScope(idOnly, catalogType, config);
  const scopedProviders = buildScopedProviderConfig(config, contentScope);

  const catalogConfig: any = {
    ...(shouldExcludeLanguageForMAL ? {} : { language: config.language || 'en-US' }),
    ...scopedProviders,
    sfw: config.sfw || false,
    includeAdult: config.includeAdult || false,
    ageRating: config.ageRating || null,
    showMetaProviderAttribution: config.showMetaProviderAttribution || false,
  };

  const isMDBListWatchlistOrUpNext = idOnly.startsWith('mdblist.watchlist') || idOnly === 'mdblist.upnext';
  if (isMDBListCatalog && isMDBListWatchlistOrUpNext) {
    catalogConfig.apiKeys = {
      mdblist: config.apiKeys?.mdblist || process.env.MDBLIST_API_KEY || ''
    };
  }

  const traktAuthCatalogs = ['trakt.upnext', 'trakt.unwatched', 'trakt.calendar', 'trakt.watchlist', 'trakt.favorites', 'trakt.recommendations'];
  const isTraktAuthRequired = traktAuthCatalogs.some(prefix => idOnly === prefix || idOnly.startsWith(prefix + '.'))
    || (isTraktCatalog && catalogFromConfig?.metadata?.privacy && catalogFromConfig.metadata.privacy !== 'public');
  if (isTraktCatalog && isTraktAuthRequired) {
    catalogConfig.apiKeys = {
      traktTokenId: config.apiKeys?.traktTokenId || ''
    };
  }

  if (idOnly.startsWith('simkl.watchlist.')) {
    catalogConfig.apiKeys = {
      simklTokenId: config.apiKeys?.simklTokenId || ''
    };
  }

  const isAniListUserList = idOnly.startsWith('anilist.') && idOnly !== 'anilist.trending' && !isAniListDiscoverCatalog;
  if (isAniListUserList) {
    catalogConfig.apiKeys = {
      anilistTokenId: config.apiKeys?.anilistTokenId || ''
    };
  }

  if (isMALCatalog || contentScope === 'anime') {
    catalogConfig.mal = {
      useImdbIdForCatalogAndSearch: config.mal?.useImdbIdForCatalogAndSearch || false
    };
  }

  if (isStreamingCatalog) {
    catalogConfig.streaming = config.streaming || [];
  }

  const catalogConfigString = JSON.stringify(catalogConfig);
  const configHash = hashConfig(catalogConfigString);

  let cacheTTL = CATALOG_TTL;

  if (isAuthCatalog) {
    cacheTTL = 0;
    cacheLogger.debug(`[Catalog] Not caching auth catalog ${idOnly} (user-specific data changes frequently)`);
  } else if (isTrendingCatalog) {
    cacheTTL = TMDB_TRENDING_TTL;
    cacheLogger.debug(`[Catalog] Using TMDB trending cache TTL for ${idOnly}: ${cacheTTL}s`);
  }

  const decadeCatalogs = ['mal.80sDecade', 'mal.90sDecade', 'mal.00sDecade', 'mal.10sDecade'];
  if (decadeCatalogs.includes(idOnly)) {
    cacheTTL = STATIC_CATALOG_TTL;
    cacheLogger.debug(`[Catalog] Using extended cache TTL for decade catalog ${idOnly}: 30 days`);
  }

  if (idOnly.startsWith('mdblist.')) {
    const catCfg = config.catalogs?.find((c: any) => c.id === idOnly);
    if (catCfg?.cacheTTL) {
      cacheTTL = catCfg.cacheTTL;
      cacheLogger.debug(`[Catalog] Using custom cache TTL for MDBList catalog ${idOnly}: ${cacheTTL}s`);
    }
  }

  if (idOnly.startsWith('trakt.')) {
    const catCfg = config.catalogs?.find((c: any) => c.id === idOnly);
    if (catCfg?.cacheTTL) {
      cacheTTL = catCfg.cacheTTL;
      cacheLogger.debug(`[Catalog] Using custom cache TTL for Trakt catalog ${idOnly}: ${cacheTTL}s`);
    }
  }

  if (idOnly.startsWith('simkl.trending.')) {
    const catCfg = config.catalogs?.find((c: any) => c.id === idOnly);
    cacheTTL = Math.max(catCfg?.cacheTTL || CATALOG_TTL, 3600);
    cacheLogger.debug(`[Catalog] Using cache TTL for Simkl trending catalog ${idOnly}: ${cacheTTL}s`);
  }

  if (idOnly.startsWith('letterboxd.')) {
    const catCfg = config.catalogs?.find((c: any) => c.id === idOnly);
    if (catCfg?.cacheTTL) {
      cacheTTL = catCfg.cacheTTL;
      cacheLogger.debug(`[Catalog] Using custom cache TTL for Letterboxd catalog ${idOnly}: ${cacheTTL}s`);
    }
  }

  if (idOnly.startsWith('custom.')) {
    const catCfg = config.catalogs?.find((c: any) => c.id === idOnly);
    if (catCfg?.cacheTTL) {
      cacheTTL = catCfg.cacheTTL;
      cacheLogger.debug(`[Catalog] Using custom cache TTL for custom manifest catalog ${idOnly}: ${cacheTTL}s`);
    }
  }

  if (idOnly.startsWith('anilist.')) {
    const catCfg = config.catalogs?.find((c: any) => c.id === idOnly);
    if (catCfg?.cacheTTL) {
      cacheTTL = catCfg.cacheTTL;
      cacheLogger.debug(`[Catalog] Using custom cache TTL for AniList catalog ${idOnly}: ${cacheTTL}s`);
    }
  }

  if (idOnly.startsWith('simkl.')) {
    const catCfg = config.catalogs?.find((c: any) => c.id === idOnly);
    if (catCfg?.cacheTTL) {
      cacheTTL = catCfg.cacheTTL;
      cacheLogger.debug(`[Catalog] Using custom cache TTL for SimKL catalog ${idOnly}: ${cacheTTL}s`);
    }
  }

  if (isDiscoverCatalog) {
    const catCfg = config.catalogs?.find((c: any) => c.id === idOnly);
    if (catCfg?.cacheTTL) {
      cacheTTL = catCfg.cacheTTL;
      cacheLogger.debug(`[Catalog] Using custom cache TTL for discover catalog ${idOnly}: ${cacheTTL}s`);
    }
  }

  let key: string;
  if (isAuthCatalog) {
    const sessionId = config.sessionId || '';
    key = `catalog:${sessionId}:${configHash}:${cacheTTL}:${catalogKey}`;
  } else if (isAiringTodayCatalog) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const today = `${year}-${month}-${day}`;
    key = `catalog:${today}:${configHash}:${cacheTTL}:${catalogKey}`;
  } else if (idOnly.includes('stremthru.') || idOnly.startsWith('custom.') || idOnly.startsWith('letterboxd.')) {
    key = `catalog:${userUUID}:${configHash}:${cacheTTL}:${catalogKey}`;
  } else {
    key = `catalog:${configHash}:${cacheTTL}:${catalogKey}`;
  }

  const isUserScopedCatalog = isAuthCatalog || idOnly.includes('stremthru.') || idOnly.startsWith('custom.') || idOnly.startsWith('letterboxd.');
  const cacheKeyIdentifier = isAuthCatalog ? (config.sessionId || 'no-session') : (isUserScopedCatalog ? (userUUID || '') : '');
  const catalogSig = shortSignature(`${cacheKeyIdentifier}|${idOnly}|${configHash}|ttl:${cacheTTL}`);
  cacheLogger.debug(`[Catalog] Key detail (${idOnly}) [sig:${catalogSig}] scope:${contentScope} userScoped:${isUserScopedCatalog} ttl:${cacheTTL}s catalogConfig:${catalogConfigString} catalogKey:${catalogKey}`);

  if (isMDBListCatalog) {
    options = {
      ...options,
      resultClassifier: (result: any, error: any, cacheKey: string) => {
        if (error) return classifyResult(result, error, cacheKey);
        const hasData = Array.isArray(result?.metas) && result.metas.length > 0;
        if (!hasData) return { type: 'SKIP_CACHE', ttl: 0 };
        return { type: 'SUCCESS', ttl: null };
      },
    };
  }
  const existingOnHit = options.onHit;
  options = {
    ...options,
    onHit: (hit: any) => {
      if (typeof existingOnHit === 'function') {
        existingOnHit(hit);
      }
      cacheLogger.debug(`[Catalog] HIT detail (${idOnly}) [sig:${catalogSig}] catalogConfig:${catalogConfigString} catalogKey:${catalogKey}`);
    },
  };
  const result = await cacheWrap(key, async () => {
    return normalizeReleaseAvailabilityInPayload(await method());
  }, cacheTTL, options);
  normalizeReleaseAvailabilityInPayload(result);

  if (result?.metas?.length) {
    const displayAgeRating = config.displayAgeRating || false;
    for (const meta of result.metas) {
      const cert = meta.app_extras?.certification;
      if (!cert) continue;
      const hasCertLink = meta.links?.some((l: any) => l.name === cert && l.category === 'Genres');
      if (displayAgeRating && !hasCertLink) {
        if (!Array.isArray(meta.links)) meta.links = [];
        const imdbId = meta.id?.match(/^tt\d+/)?.[0] || meta.imdb_id;
        const url = imdbId
          ? `https://www.imdb.com/title/${imdbId}/parentalguide/`
          : `https://www.themoviedb.org/movie/${meta.id}`;
        meta.links.unshift({ name: cert, category: 'Genres', url });
      } else if (!displayAgeRating && hasCertLink) {
        meta.links = meta.links.filter((l: any) => !(l.name === cert && l.category === 'Genres'));
      }
    }
  }

  return result;
  }

async function cacheWrapSearch(userUUID: string, searchKey: string, method: () => Promise<any>, searchEngine: string | null = null, options: any = {}): Promise<any> {
  let config: any;
  try {
    config = await resolveConfigForCache(userUUID, options);
  } catch (error: any) {
    cacheLogger.warn(`Failed to load config for user ${userUUID}: ${error.message}`);
    return { metas: [] };
  }

  if (!config) {
    cacheLogger.warn(`No config found for user ${userUUID}`);
    return { metas: [] };
  }

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
    metaProviders: config.providers || {},
    artProviders: config.artProviders || {},
    blurThumbs: config.blurThumbs || false,
    showPrefix: config.showPrefix || false,
    hideUnreleasedDigitalSearch: config.hideUnreleasedDigitalSearch || false,
    showMetaProviderAttribution: config.showMetaProviderAttribution || false,
    displayAgeRating: config.displayAgeRating || false,
    useImdbIdForCatalogAndSearch: config.mal?.useImdbIdForCatalogAndSearch || false,
    aiProvider: config.search?.ai_provider || 'gemini',
    aiModel: config.search?.ai_model || '',
    aiWebSearch: config.search?.ai_web_search || false,
  };

  const searchConfigString = JSON.stringify(searchConfig);
  const configHash = hashConfig(searchConfigString);
  const key = `search:${configHash}:${searchKey}`;
  const searchSig = shortSignature(`${configHash}`);
  cacheLogger.debug(`[Search] Key detail [sig:${searchSig}]`);

  const SEARCH_TTL = 12 * 60 * 60;

  const result = await cacheWrap(key, async () => {
    return normalizeReleaseAvailabilityInPayload(await method());
  }, SEARCH_TTL, options);
  normalizeReleaseAvailabilityInPayload(result);
  return result;
}

async function cacheWrapMeta(userUUID: string, metaId: string, method: () => Promise<any>, ttl: number = META_TTL, options: any = {}, type: string | null = null): Promise<any> {
   let config: any;
   try {
     config = await resolveConfigForCache(userUUID, options);
   } catch (error: any) {
     cacheLogger.warn(`Failed to load config for user ${userUUID}: ${error.message}`);
     return { meta: null };
   }

   if (!config) {
     cacheLogger.warn(`No config found for user ${userUUID}`);
     return { meta: null };
   }

   const [prefix, sourceId] = metaId.split(':');
   const metaType = type;

   const metaConfig: any = {
     language: config.language || 'en-US',

     blurThumbs: config.blurThumbs || false,
     showMetaProviderAttribution: config.showMetaProviderAttribution || false,
     displayAgeRating: config.displayAgeRating || false,

     englishArtOnly: config.artProviders?.englishArtOnly || false,
     originalLangFallback: config.artProviders?.originalLangFallback || false,

     timezone: config.timezone || 'UTC',
   };

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
    if (config.providers?.forceAnimeForDetectedImdb) {
      metaConfig.forceAnimeForDetectedImdb = true;
      metaConfig.animeIdProvider = config.providers?.anime_id_provider || 'imdb';
    }
   } else if (metaType === 'series') {
     metaConfig.metaProvider = config.providers?.series || 'tvdb';
     metaConfig.forceAnimeForDetectedImdb = config.providers?.forceAnimeForDetectedImdb;
     metaConfig.artProvider = {
       poster: resolveArtProvider('series', 'poster', config),
       background: resolveArtProvider('series', 'background', config),
       logo: resolveArtProvider('series', 'logo', config)
     };
     metaConfig.tvdbSeasonType = config.tvdbSeasonType || 'default';
     if (config.providers?.forceAnimeForDetectedImdb) {
       metaConfig.animeIdProvider = config.providers?.anime_id_provider || 'imdb';
     }
   }

  const metaConfigString = stableStringify(metaConfig);
  const cfgHash = hashConfig(metaConfigString);
   const key = `meta:${cfgHash}:${metaId}`;
   const metaSig = shortSignature(`${cfgHash}`);
  cacheLogger.debug(`[Meta] Key detail (${prefix}/${metaType}) [sig:${metaSig}]`);

   const result = await cacheWrap(key, async () => {
     return normalizeReleaseAvailabilityInPayload(await method());
   }, ttl, options);
   normalizeReleaseAvailabilityInPayload(result);
   return result;
}

async function cacheWrapMetaComponents(userUUID: string, metaId: string, method: () => Promise<any>, ttl: number = META_TTL, options: any = {}, type: string | null = null, useShowPoster: boolean = false): Promise<any> {
   if (!metaId || typeof metaId !== 'string') {
     cacheLogger.warn(`Invalid metaId provided to cacheWrapMetaComponents: ${metaId}`);
     return { meta: null };
   }

   let config: any;
   try {
     config = await resolveConfigForCache(userUUID, options);
   } catch (error: any) {
     cacheLogger.warn(`Failed to load config for user ${userUUID}: ${error.message}`);
     return { meta: null };
   }

   if (!config) {
     cacheLogger.warn(`No config found for user ${userUUID}`);
     return { meta: null };
   }
   const result = await method();
   return writeMetaComponentsWithConfig({
     config,
     metaId,
     result,
     ttl,
     type,
     useShowPoster,
   });
}

async function writeMetaComponentsWithConfig({ config, metaId, result, ttl = META_TTL, type = null, useShowPoster = false, overwrite = true }: { config: any; metaId: string; result: any; ttl?: number; type?: string | null; useShowPoster?: boolean; overwrite?: boolean }): Promise<any> {
  const componentCacheKeys = buildMetaComponentCacheKeys({
    config,
    metaId,
    type,
    useShowPoster,
  });

   const meta = result?.meta || result;

  if (!meta || !meta.id || !meta.name || !meta.type) {
          cacheLogger.warn(`No valid meta object returned for ${metaId}`);
    return { meta: null };
  }

  normalizeMetaReleaseAvailability(meta);

  try {
    const requestTracker = require('./requestTracker');
    requestTracker.captureMetadataFromComponents(metaId, meta, meta.type).catch(() => {});
  } catch (error: any) {
    cacheLogger.warn(`Failed to capture metadata for dashboard: ${error.message}`);
  }

   const componentsToCache: any[] = [];

   const basicMeta: any = {
      id: metaId,
      name: meta.name,
      type: meta.type,
      description: meta.description,
      imdb_id: meta.imdb_id,
      _imdbId: meta._imdbId,
      _tmdbId: meta._tmdbId,
      _tvdbId: meta._tvdbId,
      _malId: meta._malId,
      _kitsuId: meta._kitsuId,
      _anilistId: meta._anilistId,
      _anidbId: meta._anidbId,
      slug: meta.slug,
      genres: meta.genres,
      director: meta.director,
      writer: meta.writer,
      year: meta.year,
      releaseInfo: meta.releaseInfo,
      released: meta.released,
      [RELEASE_AVAILABILITY_FIELD]: meta[RELEASE_AVAILABILITY_FIELD],
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

   queueComponentCache(componentsToCache, componentCacheKeys.basic, basicMeta);

   if (meta.poster) {
    let rawPoster = meta.poster;

    try {
        const urlObj = new URL(rawPoster);

        if (rawPoster.includes('/poster/') && urlObj.searchParams.has('fallback')) {
           rawPoster = decodeURIComponent(urlObj.searchParams.get('fallback')!);
        }
        else if (urlObj.hostname.includes('top-posters.com') && urlObj.searchParams.has('fallback_url')) {
           rawPoster = decodeURIComponent(urlObj.searchParams.get('fallback_url')!);
        }

    } catch (e: any) {}

    if (meta._rawPosterUrl) {
        rawPoster = meta._rawPosterUrl;
    }

    queueComponentCache(componentsToCache, componentCacheKeys.poster, { poster: rawPoster });
    queueComponentCache(componentsToCache, componentCacheKeys.rawPoster, { _rawPosterUrl: meta._rawPosterUrl });
  }

   if (meta.background) {
     queueComponentCache(componentsToCache, componentCacheKeys.background, { background: meta.background });
   }
   if (meta.landscapePoster) {
     queueComponentCache(componentsToCache, componentCacheKeys.landscapePoster, { landscapePoster: meta.landscapePoster });
   }

   if (meta.logo) {
     queueComponentCache(componentsToCache, componentCacheKeys.logo, { logo: meta.logo });
   }

   if (meta.videos && Array.isArray(meta.videos) && meta.videos.length > 0) {
     queueComponentCache(componentsToCache, componentCacheKeys.videos, { videos: canonicalizeVideosForCache(meta.videos) });
   }

   if (meta.app_extras?.cast?.length) {
     queueComponentCache(componentsToCache, componentCacheKeys.cast, { cast: meta.app_extras.cast });
   }

   if (meta.app_extras?.directors?.length) {
     queueComponentCache(componentsToCache, componentCacheKeys.director, { directors: meta.app_extras.directors });
   }

   if (meta.app_extras?.writers?.length) {
     queueComponentCache(componentsToCache, componentCacheKeys.writer, { writers: meta.app_extras.writers });
   }

   if (meta.links && Array.isArray(meta.links) && meta.links.length > 0) {
     queueComponentCache(componentsToCache, componentCacheKeys.links, { links: canonicalizeLinksForCache(stripCertificationLinks(meta.links, meta.app_extras?.certification)) });
   }

   if (meta.trailers?.length) {
     queueComponentCache(componentsToCache, componentCacheKeys.trailers, { trailers: meta.trailers });
   }

   const extrasForCache = projectAppExtrasForComponentCache(meta.app_extras);
   if (extrasForCache) {
     queueComponentCache(componentsToCache, componentCacheKeys.extras, { app_extras: extrasForCache });
   }

  await cacheComponentsPipeline(componentsToCache, ttl, { overwrite });
   return { meta: projectMetaForUser(meta, config) };
}

async function writeMetaComponentsBatchWithConfig({ config, metas, ttl = META_TTL, type = null, useShowPoster = false, overwrite = true }: { config: any; metas: any[]; ttl?: number; type?: string | null; useShowPoster?: boolean; overwrite?: boolean }): Promise<{ written: number; skipped: number }> {
  if (!Array.isArray(metas) || metas.length === 0) {
    return { written: 0, skipped: 0 };
  }

  let written = 0;
  let skipped = 0;

  for (const meta of metas) {
    if (!meta || !meta.id || !meta.name || !meta.type) {
      skipped++;
      continue;
    }

    const result = await writeMetaComponentsWithConfig({
      config,
      metaId: meta.id,
      result: { meta },
      ttl,
      type: meta.type || type,
      useShowPoster,
      overwrite,
    });

    if (result?.meta) {
      written++;
    } else {
      skipped++;
    }
  }

  return { written, skipped };
}

async function reconstructMetaFromComponents(userUUID: string, metaId: string, ttl: number = META_TTL, options: any = {}, type: string | null = null, includeVideos: boolean = true, useShowPoster: boolean = false): Promise<any> {
   if (!metaId || typeof metaId !== 'string') {
     cacheLogger.warn(`Invalid metaId provided: ${metaId}`);
     return { errorReason: 'invalid metaId' };
   }

   let config: any;
   try {
     config = await resolveConfigForCache(userUUID, options);
  } catch (error: any) {
    cacheLogger.warn(`Failed to load config for user ${userUUID}: ${error.message}`);
    return { errorReason: `load config failed: ${error.message}` };
  }

  if (!config) {
    cacheLogger.warn(`No config found for user ${userUUID}`);
    return { errorReason: 'no config for user' };
  }

  return reconstructMetaFromComponentsWithConfig({
    config,
    metaId,
    type,
    includeVideos,
    useShowPoster,
  });
}

async function reconstructMetaFromComponentsWithConfig({ config, metaId, type = null, includeVideos = true, useShowPoster = false }: { config: any; metaId: string; type?: string | null; includeVideos?: boolean; useShowPoster?: boolean }): Promise<any> {
  if (!metaId || typeof metaId !== 'string') {
    cacheLogger.warn(`Invalid metaId provided: ${metaId}`);
    return { errorReason: 'invalid metaId' };
  }

   const componentCacheKeys = buildMetaComponentCacheKeys({
    config,
    metaId,
    type,
    useShowPoster,
   });

  const componentEntries = Object.entries(componentCacheKeys).filter(([componentName]) => {
    return includeVideos || componentName !== 'videos';
  });
  const componentNames = componentEntries.map(([componentName]) => componentName);
  const cacheKeys = componentEntries.map(([, key]) => `v${ADDON_VERSION}:${key}`);

  let componentResults: any[];

  if (cacheKeys.length === 0) {
    componentResults = componentNames.map(componentName => ({ componentName, data: null }));
  } else {
    try {
      const cachedValues = await redis.mgetBuffer(...cacheKeys);
    componentResults = await Promise.all(componentNames.map(async (componentName: string, index: number) => {
      const cached = cachedValues[index];
      if (cached) {
        try {
          const parsed = await decodeCachePayload(cached);
          return { componentName, data: parsed };
        } catch (parseError: any) {
          cacheLogger.warn(`Error parsing component ${componentName}:`, parseError);
          return { componentName, data: null };
        }
      } else {
        return { componentName, data: null };
      }
    }));
    } catch (error: any) {
      cacheLogger.warn(`Error fetching components with MGET:`, error);
      componentResults = componentNames.map(componentName => ({ componentName, data: null }));
    }
  }

  const availableComponents = componentResults.filter((result: any) => result.data !== null);

  if (availableComponents.length === 0) {
    const metaReconstructionKey = `meta:reconstructed:${metaId}`;
    updateCacheHealth(metaReconstructionKey, 'miss', true);
    return { errorReason: 'no cached components' };
  }

   const reconstructedMeta: any = {};

  const basicComponent = availableComponents.find((c: any) => c.componentName === 'basic');
  if (basicComponent) {
    Object.assign(reconstructedMeta, basicComponent.data);
    reconstructedMeta.posterShape = basicComponent.data.posterShape;

    const bd = basicComponent.data;

    if (bd._hasPoster) {
        const hasPoster = availableComponents.some((c: any) => c.componentName === 'poster');
        if (!hasPoster) {
            cacheLogger.warn(`[Reconstruct] Integrity failure for ${metaId}: Missing required poster.`);
            updateCacheHealth(`meta:reconstructed:${metaId}`, 'miss', true);
            return { errorReason: 'corrupted: missing poster' };
        }
    }

    if (bd._hasBackground) {
        const hasBg = availableComponents.some((c: any) => c.componentName === 'background');
        if (!hasBg) {
            cacheLogger.warn(`[Reconstruct] Integrity failure for ${metaId}: Missing required background.`);
            updateCacheHealth(`meta:reconstructed:${metaId}`, 'miss', true);
            return { errorReason: 'corrupted: missing background' };
        }
    }
    if (bd._hasLandscapePoster) {
        const hasLandscapePoster = availableComponents.some((c: any) => c.componentName === 'landscapePoster');
        if (!hasLandscapePoster) {
            cacheLogger.warn(`[Reconstruct] Integrity failure for ${metaId}: Missing required landscape poster.`);
            updateCacheHealth(`meta:reconstructed:${metaId}`, 'miss', true);
            return { errorReason: 'corrupted: missing landscape poster' };
        }
    }

    if (bd._hasLogo) {
        const hasLogo = availableComponents.some((c: any) => c.componentName === 'logo');
        if (!hasLogo) {
            cacheLogger.warn(`[Reconstruct] Integrity failure for ${metaId}: Missing required logo.`);
            updateCacheHealth(`meta:reconstructed:${metaId}`, 'miss', true);
            return { errorReason: 'corrupted: missing logo' };
        }
    }

    if (includeVideos && bd._hasVideos) {
        const hasVideos = availableComponents.some((c: any) => c.componentName === 'videos');
        if (!hasVideos) {
            cacheLogger.warn(`[Reconstruct] Integrity failure for ${metaId}: Missing required videos.`);
            updateCacheHealth(`meta:reconstructed:${metaId}`, 'miss', true);
            return { errorReason: 'corrupted: missing videos' };
        }
    }

    if (bd._hasLinks) {
        const hasLinks = availableComponents.some((c: any) => c.componentName === 'links');
        if (!hasLinks) {
            cacheLogger.warn(`[Reconstruct] Integrity failure for ${metaId}: Missing required links component.`);
            updateCacheHealth(`meta:reconstructed:${metaId}`, 'miss', true);
            return { errorReason: 'corrupted: missing links' };
        }
    }
  }


   availableComponents.forEach(({ componentName, data }: any) => {
     if (componentName === 'basic') return;

     if (componentName === 'poster') {
       reconstructedMeta.poster = data.poster;
     } else if (componentName === 'rawPoster') {
       reconstructedMeta._rawPosterUrl = data._rawPosterUrl;
     } else if (componentName === 'background') {
       reconstructedMeta.background = data.background;
     } else if (componentName === 'landscapePoster') {
       reconstructedMeta.landscapePoster = data.landscapePoster;
     } else if (componentName === 'logo') {
       reconstructedMeta.logo = data.logo;
      } else if (componentName === 'videos' && includeVideos) {
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
      } else if (componentName === 'extras') {
        if (data.app_extras && typeof data.app_extras === 'object' && !Array.isArray(data.app_extras)) {
          reconstructedMeta.app_extras = {
            ...data.app_extras,
            ...(reconstructedMeta.app_extras || {})
          };
        }
      }
   });

  if (!reconstructedMeta.poster && reconstructedMeta._rawPosterUrl) {
    cacheLogger.debug(`[Reconstruct] Missing poster component for ${metaId}, using _rawPosterUrl as fallback: ${reconstructedMeta._rawPosterUrl?.substring(0, 100)}...`);
    reconstructedMeta.poster = reconstructedMeta._rawPosterUrl;
  }

  if (!reconstructedMeta.id || !reconstructedMeta.name || !reconstructedMeta.type) {
    cacheLogger.warn(`Reconstructed meta missing required fields for ${metaId}`);
    const metaReconstructionKey = `meta:reconstructed:${metaId}`;
    updateCacheHealth(metaReconstructionKey, 'miss', true);
    return { errorReason: 'missing required fields' };
  }

  if (reconstructedMeta.type === 'series' && !includeVideos && !Array.isArray(reconstructedMeta.videos)) {
    reconstructedMeta.videos = [];
  }

  if ((reconstructedMeta.type === 'series') && includeVideos) {
    const videosComponent = availableComponents.find((c: any) => c.componentName === 'videos');
    if (!videosComponent) {
      const metaReconstructionKey = `meta:reconstructed:${metaId}`;
      updateCacheHealth(metaReconstructionKey, 'miss', true);
      return { errorReason: 'required videos component missing' };
    }

    const videos = reconstructedMeta.videos;
    if (!videos || !Array.isArray(videos) || videos.length === 0) {
      const metaReconstructionKey = `meta:reconstructed:${metaId}`;
      updateCacheHealth(metaReconstructionKey, 'miss', true);
      return { errorReason: 'empty videos for series' };
    }
  }

  normalizeMetaReleaseAvailability(reconstructedMeta);

  const metaReconstructionKey = `meta:reconstructed:${metaId}`;
  updateCacheHealth(metaReconstructionKey, 'hit', true);

  return { meta: projectMetaForUser(reconstructedMeta, config) };
}

async function cacheWrapMetaSmart(userUUID: string, metaId: string, method: () => Promise<any>, ttl: number = META_TTL, options: any = {}, type: string | null = null, includeVideos: boolean = true, useShowPoster: boolean = false): Promise<any> {
  cacheLogger.debug(`[Meta] Smart caching for ${metaId} (type:${type}, videos:${includeVideos}, showPoster:${useShowPoster})`);

  if (!metaId || typeof metaId !== 'string') {
    cacheLogger.warn(`Invalid metaId provided to cacheWrapMetaSmart: ${metaId}`);
    return { meta: null };
  }

  let config: any;
  try {
    config = await resolveConfigForCache(userUUID, options);
  } catch (error: any) {
    cacheLogger.warn(`Failed to load config for user ${userUUID}: ${error.message}`);
    return { meta: null };
  }

  if (!config) {
    cacheLogger.warn(`No config found for user ${userUUID}`);
    return { meta: null };
  }

  const reconstructedMeta = await reconstructMetaFromComponentsWithConfig({
    config,
    metaId,
    type,
    includeVideos,
    useShowPoster,
  });

  if (reconstructedMeta && reconstructedMeta.meta) {
    cacheLogger.debug(`[Meta] Component reconstruction successful for ${metaId}`);
    return reconstructedMeta;
  }

  const failureReason = reconstructedMeta && reconstructedMeta.errorReason ? ` (reason: ${reconstructedMeta.errorReason})` : '';
  cacheLogger.debug(`[Meta] Component reconstruction failed for ${metaId}${failureReason}`);

  const lockContextHash = getMetaSmartLockContextHash(config, metaId, type, includeVideos, useShowPoster);
  const lockKey = `meta-smart:v${ADDON_VERSION}:${userUUID || 'global'}:${type || 'unknown'}:${lockContextHash}:videos=${includeVideos ? 1 : 0}:showPoster=${useShowPoster ? 1 : 0}:${metaId}`;

  return singleFlight(lockKey, async () => {
    const reconstructedAfterWait = await reconstructMetaFromComponentsWithConfig({
      config,
      metaId,
      type,
      includeVideos,
      useShowPoster,
    });

    if (reconstructedAfterWait && reconstructedAfterWait.meta) {
      cacheLogger.debug(`[Meta] Component reconstruction successful after wait for ${metaId}`);
      return reconstructedAfterWait;
    }

    const retryReason = reconstructedAfterWait && reconstructedAfterWait.errorReason ? ` (reason: ${reconstructedAfterWait.errorReason})` : '';
    cacheLogger.debug(`[Meta] Generating full meta for ${metaId}${retryReason}`);

    const result = await method();

    if (!result || !result.meta) {
      cacheLogger.debug(`[Meta] Method returned null/empty result for ${metaId}`);
      return { meta: null };
    }

    const meta = result.meta;
    let idToCache = meta.id;

    if (!idToCache || typeof idToCache !== 'string') {
      cacheLogger.warn(`Invalid meta.id for caching: ${idToCache}, using original metaId: ${metaId}`);
      idToCache = metaId;
    }

    if(metaId.startsWith('tun_')){
      idToCache = metaId;
    }

    return writeMetaComponentsWithConfig({
      config,
      metaId: idToCache,
      result,
      ttl,
      type,
      useShowPoster,
    });
  }, cloneJsonCompatibleResult);
}

function queueComponentCache(components: any[], cacheKey: string, componentData: any): void {
  if (!cacheKey || !componentData) return;
  components.push({ cacheKey, componentData });
}

async function cacheComponentsPipeline(components: any[], ttl: number, options: any = {}): Promise<void> {
  if (!redis || !Array.isArray(components) || components.length === 0) return;

  const overwrite = options.overwrite !== false;
  const pipeline = redis.pipeline();
  const queuedCommands: string[] = [];

  for (const { cacheKey, componentData } of components) {
    const versionedKey = `v${ADDON_VERSION}:${cacheKey}`;

    try {
      const payload = await encodeCachePayload(componentData);
      if (overwrite) {
        pipeline.set(versionedKey, payload, 'EX', ttl);
      } else {
        pipeline.set(versionedKey, payload, 'EX', ttl, 'NX');
      }
      queuedCommands.push(versionedKey);
    } catch (error: any) {
      cacheLogger.warn(`Failed to queue component cache write for ${versionedKey}:`, error);
    }
  }

  if (queuedCommands.length === 0) return;

  try {
    const results = await pipeline.exec();

    results?.forEach(([error]: any, index: number) => {
      if (error) {
        cacheLogger.warn(`Failed to cache component for ${queuedCommands[index]}:`, error);
      }
    });
  } catch (error: any) {
    cacheLogger.warn(`Failed to execute component cache pipeline:`, error);
  }
}


function cacheWrapJikanApi(key: string, method: () => Promise<any>, customTTL: number | null = null, options: any = {}): Promise<any> {
  const subkey = key.replace(/\s/g, '-');
  const ttl = customTTL !== null ? customTTL : JIKAN_API_TTL;

  const jikanResultClassifier = (result: any, error: any = null) => {
    if (error) {
      if (error.response?.status === 429 || error.message?.includes('429')) {
        cacheLogger.debug(`Jikan Cache - Skipping cache for rate limit error: ${key}`);
        return { type: 'SKIP_CACHE', ttl: 0 };
      }
      return classifyResult(result, error);
    }

    return classifyResult(result, error);
  };

  return cacheWrapGlobal(`jikan-api:${subkey}`, method, ttl, {
    resultClassifier: jikanResultClassifier,
    ...options
  });
}

function cacheWrapMDBListGenres(genreType: string, method: () => Promise<any>): Promise<any> {
  cacheLogger.debug(`Caching MDBList genres for type: ${genreType}`);
  return cacheWrapGlobal(`mdblist-${genreType}`, method, MDBLIST_GENRES_TTL);
}

function cacheWrapTraktGenres(genreType: string, method: () => Promise<any>): Promise<any> {
  cacheLogger.debug(`Caching Trakt genres for type: ${genreType}`);
  return cacheWrapGlobal(`trakt-genres-${genreType}`, method, MDBLIST_GENRES_TTL, { skipVersion: true });
}

function cacheWrapStremThruGenres(catalogUrl: string, method: () => Promise<any>): Promise<any> {
  const urlKey = Buffer.from(catalogUrl).toString('base64').substring(0, 50);
  cacheLogger.debug(`Caching StremThru genres for catalog ${urlKey}`);
  return cacheWrapGlobal(`stremthru-genres:${urlKey}`, method, STREMTHRU_GENRES_TTL);
}

async function cacheWrapStaticCatalog(userUUID: string, catalogKey: string, method: () => Promise<any>, options: any = {}): Promise<any> {
  let config: any;
  try {
    config = await loadConfigFromDatabase(userUUID);
  } catch (error: any) {
    cacheLogger.warn(`Failed to load config for user ${userUUID}: ${error.message}`);
    return { metas: [] };
  }

  if (!config) {
    cacheLogger.warn(`No config found for user ${userUUID}`);
    return { metas: [] };
  }

  const idOnly = catalogKey.split(':')[0];

  const staticCatalogConfig = {
    language: config.language || 'en-US',

    providers: config.providers || {},
    artProviders: config.artProviders || {},

    sfw: config.sfw || false,
    includeAdult: config.includeAdult || false,
    ageRating: config.ageRating || null,
    showPrefix: config.showPrefix || false,
    showMetaProviderAttribution: config.showMetaProviderAttribution || false,
    displayAgeRating: config.displayAgeRating || false,
    mal: config.mal || {}
  };

  const catalogConfigString = JSON.stringify(staticCatalogConfig);
  const key = `catalog:${catalogConfigString}:${catalogKey}`;

  cacheLogger.debug(`Static catalog cache key (${idOnly}): ${key.substring(0, 120)}...`);

  return cacheWrap(key, method, STATIC_CATALOG_TTL, options);
}

function cacheWrapTvdbApi(key: string, method: () => Promise<any>): Promise<any> {
  const fullKey = `tvdb-api:${key}`;
  const tvdbResultClassifier = (result: any, error: any = null, cacheKey: string | null = null) => {
    const keyForClassify = cacheKey || fullKey;
    if (error) {
      return classifyResult(result, error, keyForClassify);
    }

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

function cacheWrapTvmazeApi(key: string, method: () => Promise<any>): Promise<any> {
  const keyForClassify = `tvmaze-api:${key}`;
  const tvmazeResultClassifier = (result: any, error: any = null) => {
    if (error) {
      return classifyResult(result, error, keyForClassify);
    }

    if (result === null || result === undefined) {
      cacheLogger.debug(`TVmaze Cache - Skipping cache for null result: ${key}`);
      return { type: 'SKIP_CACHE', ttl: 0 };
    }

    return classifyResult(result, error, keyForClassify);
  };

  return cacheWrapGlobal(`tvmaze-api:${key}`, method, TVMAZE_API_TTL, {
    resultClassifier: tvmazeResultClassifier
  });
}

function getCacheHealth(): any {
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
      .sort((a: any, b: any) => b[1] - a[1])
      .slice(0, 10)
      .map((entry: any) => ({ key: entry[0], count: entry[1] }))
  };
}

function clearCacheHealth(): void {
  cacheHealth.hits = 0;
  cacheHealth.misses = 0;
  cacheHealth.errors = 0;
  cacheHealth.cachedErrors = 0;
  cacheHealth.corruptedEntries = 0;
  cacheHealth.errorCounts = {};
  cacheHealth.keyAccessCounts.clear();
  cacheHealthLogger.info('Statistics cleared');
}

async function clearCache(key: string): Promise<number | undefined> {
  if (!redis) {
    cacheLogger.warn('Redis not available, cannot clear cache');
    return;
  }

  try {
    const result = await redis.del(key);
    cacheLogger.info(`Cleared key: ${key} (${result} keys removed)`);
    return result;
  } catch (error: any) {
    cacheLogger.error(`Failed to clear key ${key}:`, error.message);
    throw error;
  }
}

function generateAniListCatalogCacheKey(username: string, listName: string, page: number, sort: string | null = null): string {
  const sortSuffix = sort ? `:${sort}` : '';
  return `anilist-catalog:${username}:${listName}:page${page}${sortSuffix}`;
}

async function cacheWrapAniListCatalog(username: string, listName: string, page: number, method: () => Promise<any>, customTTL: number | null = null, options: any = {}, sort: string | null = null): Promise<any> {
  const key = generateAniListCatalogCacheKey(username, listName, page, sort);
  const ttl = customTTL !== null ? customTTL : ANILIST_CATALOG_TTL;

  cacheLogger.debug(`[AniList] Cache key: ${key}, TTL: ${ttl}s`);

  return cacheWrap(key, method, ttl, options);
}

export {
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
  buildMetaComponentCacheKeys,
  projectMetaForCatalogCache,
  projectCatalogPayloadForCache,
  writeMetaComponentsBatchWithConfig,
  cacheWrapMetaSmart,
  getCacheHealth,
  clearCacheHealth,
  clearCache,
  logCacheHealth,
  cacheWrapTvdbApi,
  cacheWrapTvmazeApi,
  cacheWrapAniListCatalog,
  generateAniListCatalogCacheKey,
  stableStringify,
};
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
  buildMetaComponentCacheKeys,
  projectMetaForCatalogCache,
  projectCatalogPayloadForCache,
  writeMetaComponentsBatchWithConfig,
  cacheWrapMetaSmart,
  getCacheHealth,
  clearCacheHealth,
  clearCache,
  logCacheHealth,
  cacheWrapTvdbApi,
  cacheWrapTvmazeApi,
  cacheWrapAniListCatalog,
  generateAniListCatalogCacheKey,
  stableStringify,
  getMemoryStats: () => ({
    inFlightRequests: inFlightRequests.size,
    keyAccessCounts: cacheHealth.keyAccessCounts.size,
  }),
};
