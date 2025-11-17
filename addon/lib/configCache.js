// ============================================================================
// IN-MEMORY CONFIG CACHE
// ============================================================================
// Simple in-memory cache with TTL, LRU eviction, and automatic cleanup

const consola = require('consola');
const logger = consola.withTag('ConfigCache');

class ConfigCache {
  constructor(ttlMs = 60000, maxSize = 1000) { // 60 seconds default TTL, 1000 entries max
    this.cache = new Map();
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.cleanupInterval = null;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }
    
    // Check if expired
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    
    // Update access time for LRU (move to end of Map)
    this.cache.delete(key);
    this.cache.set(key, entry);
    
    return entry.value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else {
      if (this.cache.size >= this.maxSize) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey) {
          this.cache.delete(firstKey);
          logger.debug(`Config cache at max size (${this.maxSize}), evicted LRU entry: ${firstKey.substring(0, 8)}...`);
        }
      }
    }
    
    this.cache.set(key, {
      value,
      timestamp: Date.now()
    });
  }

  del(key) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  // Periodic cleanup of expired entries
  startCleanup(intervalMs = 120000) { // 2 minutes
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      let cleared = 0;
      
      for (const [key, entry] of this.cache.entries()) {
        if (now - entry.timestamp > this.ttlMs) {
          this.cache.delete(key);
          cleared++;
        }
      }
      
      if (cleared > 0) {
        logger.debug(` Config cache cleanup: cleared ${cleared} expired entries 🧹`);
      }
    }, intervalMs);

    // Unref so the interval doesn't keep the process alive
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }
}

const configCache = new ConfigCache(60000, 1000);
configCache.startCleanup();

module.exports = configCache;
