const consola: any = require('consola');
const redis: any = require('./redisClient');
const lz: any = require('lz-string');

const logger: any = consola.withTag('ConfigCache');

function parsePositiveIntEnv(envValue: string | undefined, defaultValue: number, minValue: number = 1): number {
  const parsed = Number.parseInt(String(envValue), 10);
  if (!Number.isFinite(parsed) || parsed < minValue) return defaultValue;
  return parsed;
}

function CONFIG_CACHE_TTL_SEC() { return parsePositiveIntEnv(process.env.CONFIG_CACHE_TTL_SEC, 300, 10); }
const KEY_PREFIX = 'user-config:';

function redisKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

const pendingLoads = new Map<string, Promise<any>>();

class ConfigCache {
  async get(key: string): Promise<any> {
    if (!redis || redis.status !== 'ready') return null;
    try {
      const raw = await redis.get(redisKey(key));
      return raw ? JSON.parse(lz.decompressFromUTF16(raw)) : null;
    } catch (err: any) {
      logger.warn(`get failed for ${String(key).substring(0, 8)}...: ${err.message}`);
      return null;
    }
  }

  async set(key: string, value: any): Promise<void> {
    if (!redis || redis.status !== 'ready' || value === undefined) return;
    try {
      const compressed = lz.compressToUTF16(JSON.stringify(value));
      await redis.set(redisKey(key), compressed, 'EX', CONFIG_CACHE_TTL_SEC());
    } catch (err: any) {
      logger.warn(`set failed for ${String(key).substring(0, 8)}...: ${err.message}`);
    }
  }

  async del(key: string): Promise<void> {
    pendingLoads.delete(redisKey(key));
    if (!redis || redis.status !== 'ready') return;
    try {
      await redis.del(redisKey(key));
    } catch (err: any) {
      logger.warn(`del failed for ${String(key).substring(0, 8)}...: ${err.message}`);
    }
  }

  async clear(): Promise<void> {
    pendingLoads.clear();
    if (!redis || redis.status !== 'ready') return;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 500);
        cursor = next;
        if (keys.length) await redis.unlink(...keys);
      } while (cursor !== '0');
    } catch (err: any) {
      logger.warn(`clear failed: ${err.message}`);
    }
  }

  async getOrLoad(key: string, loader: () => Promise<any>): Promise<any> {
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
          this.set(key, value).catch((err: any) => logger.warn(`Background set failed: ${err.message}`));
        }
        return value;
      } finally {
        pendingLoads.delete(mapKey);
      }
    })();

    pendingLoads.set(mapKey, loadPromise);
    return loadPromise;
  }

  isLoadPending(key: string): boolean {
    return pendingLoads.has(redisKey(key));
  }

  async stats({ countRedisEntries = false } = {}): Promise<{ pendingLoads: number; entries: number | null }> {
    const out: { pendingLoads: number; entries: number | null } = { pendingLoads: pendingLoads.size, entries: null };
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
    } catch (err: any) {
      logger.warn(`stats SCAN failed: ${err.message}`);
    }
    return out;
  }
}

const configCache = new ConfigCache();

if (redis) {
  logger.info(`ConfigCache backed by Redis, TTL=${CONFIG_CACHE_TTL_SEC()}s`);
} else {
  logger.warn('ConfigCache: Redis unavailable, falling through to loader on every call');
}

export { configCache as default };
module.exports = configCache;
