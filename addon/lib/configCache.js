// ============================================================================
// IN-MEMORY CONFIG CACHE
// ============================================================================
// Simple in-memory cache with TTL and automatic cleanup

const consola = require('consola');
const logger = consola.withTag('ConfigCache');

class ConfigCache {
  constructor(ttlMs = 60000) { // 60 seconds default
    this.cache = new Map();
    this.ttlMs = ttlMs;
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
    
    return entry.value;
  }

  set(key, value) {
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

// Create and export the singleton cache instance with 60-second TTL
const configCache = new ConfigCache(60000);
configCache.startCleanup();

module.exports = configCache;
