const redis = require('./redisClient');
const consola = require('consola');


const logger = consola.withTag('Redis-ID-Cache');
const { deleteKeysByPattern } = require('./redisUtils');

class RedisIdCache {
  constructor() {
    this.redis = redis;
    this.dataPrefix = 'id_map:data:'; // Stores the actual JSON mapping object.
    this.ptrPrefix = 'id_map:ptr:';   // Stores a simple string that points to a data key.
    this.ttl = 90 * 24 * 60 * 60;     // 90 days in seconds.
  }

  /**
   * Generates the canonical key and all associated pointer keys.
   * @private
   */
  _getKeys(contentType, tmdbId, tvdbId, imdbId, tvmazeId) {
    if (!tmdbId) {
      return null;
    }

    const canonicalKey = `${this.dataPrefix}${contentType}:${tmdbId}`;
    const pointerKeys = [];

    // IMDb IDs are globally unique (e.g., 'tt' prefix), so no contentType is needed.
    if (imdbId) pointerKeys.push(`${this.ptrPrefix}imdb:${imdbId}`);
    
    // ** THE FIX IS HERE **
    // TVDB IDs can collide between movies and series, so we MUST include the contentType.
    if (tvdbId) pointerKeys.push(`${this.ptrPrefix}tvdb:${contentType}:${tvdbId}`);

    // TVmaze is currently series-only, so no collision is possible yet.
    // However, for future-proofing, one could add contentType here as well. For now, we omit it.
    if (tvmazeId) pointerKeys.push(`${this.ptrPrefix}tvmaze:${tvmazeId}`);
    
    return { canonicalKey, pointerKeys };
  }

  /**
 * Retrieves a cached ID mapping using any of the provided IDs.
 * This version corrects a bug where data was confused with keys.
 */
  async getCachedIdMapping(contentType, tmdbId = null, tvdbId = null, imdbId = null, tvmazeId = null) {
    if (!this.redis) return null;

    // --- Step 1: Direct lookup (most efficient) ---
    // If we have the TMDB ID, we can try to get the data directly.
    if (tmdbId) {
      const canonicalKey = `${this.dataPrefix}${contentType}:${tmdbId}`;
      try {
        const directData = await this.redis.get(canonicalKey);
        if (directData) {
          logger.debug(`[Redis ID Cache] HIT (direct) for key ${canonicalKey}`);
          return JSON.parse(directData);
        }
      } catch (error) {
        logger.error(`[Redis ID Cache] Error during direct get for ${canonicalKey}:`, error.message);
      }
    }

    // --- Step 2: Pointer lookup ---
    // If the direct lookup failed or wasn't possible, try finding a pointer.
    const pointerKeys = [];
    if (imdbId) pointerKeys.push(`${this.ptrPrefix}imdb:${imdbId}`);
    if (tvdbId) pointerKeys.push(`${this.ptrPrefix}tvdb:${contentType}:${tvdbId}`);
    if (tvmazeId) pointerKeys.push(`${this.ptrPrefix}tvmaze:${tvmazeId}`);

    if (pointerKeys.length === 0) {
      logger.debug(`[Redis ID Cache] MISS: No TMDB ID for direct lookup and no other IDs for pointer lookup.`);
      return null;
    }

    try {
      const pointerResults = await this.redis.mget(...pointerKeys);
      let canonicalKeyFromPointer = null;

      // Find the first valid pointer result, which will be the canonical key string.
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

      // Now, use the key we found from the pointer to get the actual data.
      const pointerData = await this.redis.get(canonicalKeyFromPointer);
      if (pointerData) {
        logger.debug(`[Redis ID Cache] HIT (via pointer) for key ${canonicalKeyFromPointer}`);
        return JSON.parse(pointerData);
      } else {
        // This is a TRUE orphan pointer scenario.
        logger.warn(`[Redis ID Cache] Found pointer leading to a missing data key: ${canonicalKeyFromPointer}`);
        return null;
      }
    } catch (error) {
      logger.error(`[Redis ID Cache] Error during pointer lookup:`, error.message);
      return null;
    }
  }

  /**
   * Saves or updates an ID mapping to the cache.
   */
  async saveIdMapping(contentType, tmdbId = null, tvdbId = null, imdbId = null, tvmazeId = null) {
    if (!this.redis) return;

    if (!tmdbId) {
      logger.debug(`[Redis ID Cache] Cannot save mapping: a TMDB ID is required as the canonical anchor.`);
      return;
    }

    const keyInfo = this._getKeys(contentType, tmdbId, tvdbId, imdbId, tvmazeId);
    if (!keyInfo) return;

    const { canonicalKey, pointerKeys } = keyInfo;

    const mapping = {
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
    } catch (error)
      {
      logger.error(`[Redis ID Cache] Error saving mapping transaction:`, error.message);
    }
  }

  /**
   * Safely scans for keys matching a pattern without blocking the Redis server.
   * @private
   */
  async _scanKeys(pattern) {
    const foundKeys = [];
    let cursor = '0';
    do {
      const [newCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', '1000');
      cursor = newCursor;
      foundKeys.push(...keys);
    } while (cursor !== '0');
    return foundKeys;
  }

  /**
   * Gets statistics about the ID mapping cache.
   */
  async getCacheStats() {
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
    } catch (error) {
      logger.error(`[Redis ID Cache] Error getting cache stats:`, error.message);
      return null;
    }
  }

  /**
   * Clears ALL ID mapping data and pointers from the cache.
   */
  async clearAllCache() {
    if (!this.redis) return 0;

    try {
      logger.warn(`[Redis ID Cache] Starting cache clearing process...`);
      const { deleteKeysByPattern } = require('./redisUtils');
      const deleted = await deleteKeysByPattern('id_map:*');
      
      const keyCount = allKeys.length;
      logger.success(`[Redis ID Cache] Cleared ${keyCount} keys.`);
      return keyCount;
    } catch (error) {
      logger.error(`[Redis ID Cache] Error clearing cache:`, error.message);
      return 0;
    }
  }
}

module.exports = new RedisIdCache();