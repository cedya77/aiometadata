const redis: any = require('./redisClient');
const consola: any = require('consola');

const logger: any = consola.withTag('Redis-ID-Cache');
const { deleteKeysByPattern }: any = require('./redisUtils');

interface IdMapping {
  tmdb_id: string | null;
  tvdb_id: string | null;
  imdb_id: string | null;
  tvmaze_id: string | null;
  updated_at: string;
}

interface KeyInfo {
  canonicalKey: string;
  pointerKeys: string[];
}

interface CacheStats {
  total_mappings: number;
  total_pointers: number;
  total_keys: number;
  ttl_seconds: number;
}

class RedisIdCache {
  redis: any;
  dataPrefix: string;
  ptrPrefix: string;
  ttl: number;

  constructor() {
    this.redis = redis;
    this.dataPrefix = 'id_map:data:';
    this.ptrPrefix = 'id_map:ptr:';
    this.ttl = 90 * 24 * 60 * 60;
  }

  _getKeys(contentType: string, tmdbId: string | null, tvdbId: string | null, imdbId: string | null, tvmazeId: string | null): KeyInfo | null {
    if (!tmdbId) {
      return null;
    }

    const canonicalKey = `${this.dataPrefix}${contentType}:${tmdbId}`;
    const pointerKeys: string[] = [];

    if (imdbId) pointerKeys.push(`${this.ptrPrefix}imdb:${imdbId}`);
    if (tvdbId) pointerKeys.push(`${this.ptrPrefix}tvdb:${contentType}:${tvdbId}`);
    if (tvmazeId) pointerKeys.push(`${this.ptrPrefix}tvmaze:${tvmazeId}`);

    return { canonicalKey, pointerKeys };
  }

  async getCachedIdMapping(contentType: string, tmdbId: string | null = null, tvdbId: string | null = null, imdbId: string | null = null, tvmazeId: string | null = null): Promise<IdMapping | null> {
    if (!this.redis) return null;

    if (tmdbId) {
      const canonicalKey = `${this.dataPrefix}${contentType}:${tmdbId}`;
      try {
        const directData = await this.redis.get(canonicalKey);
        if (directData) {
          logger.debug(`[Redis ID Cache] HIT (direct) for key ${canonicalKey}`);
          return JSON.parse(directData);
        }
      } catch (error: any) {
        logger.error(`[Redis ID Cache] Error during direct get for ${canonicalKey}:`, error.message);
      }
    }

    const pointerKeys: string[] = [];
    if (imdbId) pointerKeys.push(`${this.ptrPrefix}imdb:${imdbId}`);
    if (tvdbId) pointerKeys.push(`${this.ptrPrefix}tvdb:${contentType}:${tvdbId}`);
    if (tvmazeId) pointerKeys.push(`${this.ptrPrefix}tvmaze:${tvmazeId}`);

    if (pointerKeys.length === 0) {
      logger.debug(`[Redis ID Cache] MISS: No TMDB ID for direct lookup and no other IDs for pointer lookup.`);
      return null;
    }

    try {
      const pointerResults = await this.redis.mget(...pointerKeys);
      let canonicalKeyFromPointer: string | null = null;

      for (const result of pointerResults) {
        if (result && typeof result === 'string' && result.startsWith(this.dataPrefix)) {
          canonicalKeyFromPointer = result;
          break;
        }
      }

      if (!canonicalKeyFromPointer) {
        logger.debug(`[Redis ID Cache] MISS: None of the pointer keys existed.`, pointerKeys);
        return null;
      }

      const pointerData = await this.redis.get(canonicalKeyFromPointer);
      if (pointerData) {
        logger.debug(`[Redis ID Cache] HIT (via pointer) for key ${canonicalKeyFromPointer}`);
        return JSON.parse(pointerData);
      } else {
        logger.warn(`[Redis ID Cache] Found pointer leading to a missing data key: ${canonicalKeyFromPointer}`);
        return null;
      }
    } catch (error: any) {
      logger.error(`[Redis ID Cache] Error during pointer lookup:`, error.message);
      return null;
    }
  }

  async saveIdMapping(contentType: string, tmdbId: string | null = null, tvdbId: string | null = null, imdbId: string | null = null, tvmazeId: string | null = null): Promise<void> {
    if (!this.redis) return;

    if (!tmdbId) {
      logger.debug(`[Redis ID Cache] Cannot save mapping: a TMDB ID is required as the canonical anchor.`);
      return;
    }

    const keyInfo = this._getKeys(contentType, tmdbId, tvdbId, imdbId, tvmazeId);
    if (!keyInfo) return;

    const { canonicalKey, pointerKeys } = keyInfo;

    const mapping: IdMapping = {
      tmdb_id: tmdbId,
      tvdb_id: tvdbId,
      imdb_id: imdbId,
      tvmaze_id: tvmazeId,
      updated_at: new Date().toISOString()
    };

    try {
      const transaction = this.redis.multi();
      transaction.setex(canonicalKey, this.ttl, JSON.stringify(mapping));
      for (const ptrKey of pointerKeys) {
        transaction.setex(ptrKey, this.ttl, canonicalKey);
      }
      await transaction.exec();

      logger.debug(`[Redis ID Cache] SAVED mapping with canonical key: ${canonicalKey}`);
    } catch (error: any) {
      logger.error(`[Redis ID Cache] Error saving mapping transaction:`, error.message);
    }
  }

  async _scanKeys(pattern: string): Promise<string[]> {
    const foundKeys: string[] = [];
    let cursor = '0';
    do {
      const [newCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', '1000');
      cursor = newCursor;
      foundKeys.push(...keys);
    } while (cursor !== '0');
    return foundKeys;
  }

  async getCacheStats(): Promise<CacheStats | null> {
    if (!this.redis) return null;

    try {
      const [dataKeys, ptrKeys] = await Promise.all([
        this._scanKeys(`${this.dataPrefix}*`),
        this._scanKeys(`${this.ptrPrefix}*`)
      ]);

      return {
        total_mappings: dataKeys.length,
        total_pointers: ptrKeys.length,
        total_keys: dataKeys.length + ptrKeys.length,
        ttl_seconds: this.ttl
      };
    } catch (error: any) {
      logger.error(`[Redis ID Cache] Error getting cache stats:`, error.message);
      return null;
    }
  }

  async clearAllCache(): Promise<number> {
    if (!this.redis) return 0;

    try {
      logger.warn(`[Redis ID Cache] Starting cache clearing process...`);
      const { deleteKeysByPattern } = require('./redisUtils');
      const deleted = await deleteKeysByPattern('id_map:*');

      logger.success(`[Redis ID Cache] Cleared ${deleted} keys.`);
      return deleted;
    } catch (error: any) {
      logger.error(`[Redis ID Cache] Error clearing cache:`, error.message);
      return 0;
    }
  }
}

const instance = new RedisIdCache();
export { instance as default };
module.exports = instance;
