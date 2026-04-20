// ============================================================================
// REDIS-BACKED USER CONFIG CACHE WITH STAMPEDE PROTECTION
// ============================================================================
// Caches user configs in Redis (shared across replicas) with:
//   - TTL-based expiration handled by Redis EXPIRE
//   - In-process promise coalescing so concurrent requests for the same
//     uncached key only hit the DB once (we can't dedupe across processes)
//   - Graceful fallback to direct loader invocation if Redis is unavailable
//
// Replaces the previous in-process Map implementation, which held full user
// configs (with all catalog definitions) per entry and was the dominant
// source of retained heap in multi-tenant deployments.

const consola = require('consola');
const redis = require('./redisClient');

const logger = consola.withTag('ConfigCache');

function parsePositiveIntEnv(envValue, defaultValue, minValue = 1) {
  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed < minValue) return defaultValue;
  return parsed;
}

// TTL for cached user config entries, in seconds.
const CONFIG_CACHE_TTL_SEC = parsePositiveIntEnv(process.env.CONFIG_CACHE_TTL_SEC, 300, 10);
const KEY_PREFIX = 'user-config:';

function redisKey(id) {
  return `${KEY_PREFIX}${id}`;
}

// Process-local dedup for concurrent loader invocations. Redis can't help here
// — without this, N concurrent requests for the same uncached user each
// trigger their own DB query.
const pendingLoads = new Map();

class ConfigCache {
  async get(key) {
    if (!redis) return null;
    try {
      const raw = await redis.get(redisKey(key));
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      logger.warn(`get failed for ${String(key).substring(0, 8)}...: ${err.message}`);
      return null;
    }
  }

  async set(key, value) {
    if (!redis || value === undefined) return;
    try {
      await redis.set(redisKey(key), JSON.stringify(value), 'EX', CONFIG_CACHE_TTL_SEC);
    } catch (err) {
      logger.warn(`set failed for ${String(key).substring(0, 8)}...: ${err.message}`);
    }
  }

  async del(key) {
    pendingLoads.delete(redisKey(key));
    if (!redis) return;
    try {
      await redis.del(redisKey(key));
    } catch (err) {
      logger.warn(`del failed for ${String(key).substring(0, 8)}...: ${err.message}`);
    }
  }

  async clear() {
    pendingLoads.clear();
    if (!redis) return;
    // Iterative SCAN to avoid blocking Redis on large keyspaces.
    try {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 500);
        cursor = next;
        if (keys.length) await redis.del(...keys);
      } while (cursor !== '0');
    } catch (err) {
      logger.warn(`clear failed: ${err.message}`);
    }
  }

  /**
   * Load from cache, or call loader() once and cache the result.
   * Coalesces concurrent in-process loads for the same key.
   *
   * @param {string} key
   * @param {Function} loader - Async function called on cache miss
   * @returns {Promise<any>}
   */
  async getOrLoad(key, loader) {
    // If Redis is unavailable we can't cache, but we still must return a value.
    if (!redis) return loader();

    const cached = await this.get(key);
    if (cached !== null) return cached;

    const mapKey = redisKey(key);
    const existing = pendingLoads.get(mapKey);
    if (existing) {
      logger.debug(`Config load already in progress for ${String(key).substring(0, 8)}..., waiting`);
      return existing;
    }

    const loadPromise = (async () => {
      try {
        const value = await loader();
        if (value !== undefined && value !== null) await this.set(key, value);
        return value;
      } finally {
        pendingLoads.delete(mapKey);
      }
    })();

    pendingLoads.set(mapKey, loadPromise);
    return loadPromise;
  }

  isLoadPending(key) {
    return pendingLoads.has(redisKey(key));
  }

  /**
   * Introspection for dashboards/metrics. Returns pending-load count (cheap)
   * and optionally a Redis cardinality scan (opt-in because SCAN is O(N)).
   *
   * @param {object} [opts]
   * @param {boolean} [opts.countRedisEntries=false]
   */
  async stats({ countRedisEntries = false } = {}) {
    const out = { pendingLoads: pendingLoads.size, entries: null };
    if (!countRedisEntries || !redis) return out;
    try {
      let cursor = '0';
      let total = 0;
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 500);
        cursor = next;
        total += keys.length;
      } while (cursor !== '0');
      out.entries = total;
    } catch (err) {
      logger.warn(`stats SCAN failed: ${err.message}`);
    }
    return out;
  }
}

const configCache = new ConfigCache();

if (redis) {
  logger.info(`ConfigCache backed by Redis, TTL=${CONFIG_CACHE_TTL_SEC}s`);
} else {
  logger.warn('ConfigCache: Redis unavailable, falling through to loader on every call');
}

module.exports = configCache;
