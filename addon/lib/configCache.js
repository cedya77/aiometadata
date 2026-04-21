const consola = require('consola');
const redis = require('./redisClient');
const lz = require('lz-string');

const logger = consola.withTag('ConfigCache');

function parsePositiveIntEnv(envValue, defaultValue, minValue = 1) {
  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed < minValue) return defaultValue;
  return parsed;
}

const CONFIG_CACHE_TTL_SEC = parsePositiveIntEnv(process.env.CONFIG_CACHE_TTL_SEC, 300, 10);
const KEY_PREFIX = 'user-config:';

function redisKey(id) {
  return `${KEY_PREFIX}${id}`;
}

const pendingLoads = new Map();

class ConfigCache {
  async get(key) {
    if (!redis || redis.status !== 'ready') return null;
    try {
      const raw = await redis.get(redisKey(key));
      return raw ? JSON.parse(lz.decompressFromUTF16(raw)) : null;
    } catch (err) {
      logger.warn(`get failed for ${String(key).substring(0, 8)}...: ${err.message}`);
      return null;
    }
  }

  async set(key, value) {
    if (!redis || redis.status !== 'ready' || value === undefined) return;
    try {
      const compressed = lz.compressToUTF16(JSON.stringify(value));
      await redis.set(redisKey(key), compressed, 'EX', CONFIG_CACHE_TTL_SEC);
    } catch (err) {
      logger.warn(`set failed for ${String(key).substring(0, 8)}...: ${err.message}`);
    }
  }

  async del(key) {
    pendingLoads.delete(redisKey(key));
    if (!redis || redis.status !== 'ready') return;
    try {
      await redis.del(redisKey(key));
    } catch (err) {
      logger.warn(`del failed for ${String(key).substring(0, 8)}...: ${err.message}`);
    }
  }

  async clear() {
    pendingLoads.clear();
    if (!redis || redis.status !== 'ready') return;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 500);
        cursor = next;
        if (keys.length) await redis.unlink(...keys);
      } while (cursor !== '0');
    } catch (err) {
      logger.warn(`clear failed: ${err.message}`);
    }
  }

  async getOrLoad(key, loader) {
    if (!redis || redis.status !== 'ready') return loader();

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
        if (value !== undefined && value !== null) {
          this.set(key, value).catch(err => logger.warn(`Background set failed: ${err.message}`));
        }
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

  async stats({ countRedisEntries = false } = {}) {
    const out = { pendingLoads: pendingLoads.size, entries: null };
    if (!countRedisEntries || !redis || redis.status !== 'ready') return out;
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
