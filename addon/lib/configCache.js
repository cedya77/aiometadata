// ============================================================================
// IN-MEMORY CONFIG CACHE WITH STAMPEDE PROTECTION
// ============================================================================
// In-memory cache with TTL, LRU eviction, automatic cleanup, and promise
// coalescing to prevent cache stampedes (multiple concurrent DB loads for
// the same expired key).

const consola = require('consola');
const logger = consola.withTag('ConfigCache');

class ConfigCache {
  constructor(ttlMs = 300000, maxSize = 1000) { // 5 minutes default TTL, 1000 entries max
    this.cache = new Map();
    this.pendingLoads = new Map(); // Track in-flight load promises
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.cleanupInterval = null;
  }

  /**
   * Get a value from cache
   * @param {string} key - Cache key
   * @returns {any|null} - Cached value or null if not found/expired
   */
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

  /**
   * Set a value in cache
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   */
  set(key, value) {
    // Clear any pending load for this key since we now have the value
    this.pendingLoads.delete(key);
    
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

  /**
   * Delete a key from cache
   * @param {string} key - Cache key
   */
  del(key) {
    this.cache.delete(key);
    this.pendingLoads.delete(key);
  }

  /**
   * Clear all cache entries
   */
  clear() {
    this.cache.clear();
    this.pendingLoads.clear();
  }

  /**
   * Get or load with stampede protection.
   * If the key is not in cache, calls the loader function. If multiple
   * concurrent requests try to load the same key, they all share the same
   * promise (preventing multiple DB queries for the same config).
   * 
   * @param {string} key - Cache key
   * @param {Function} loader - Async function to load the value if not cached
   * @returns {Promise<any>} - The cached or loaded value
   */
  async getOrLoad(key, loader) {
    // Check cache first
    const cached = this.get(key);
    if (cached !== null) {
      return cached;
    }

    // Check if there's already a pending load for this key
    if (this.pendingLoads.has(key)) {
      logger.debug(`🔄 Config load already in progress for ${key.substring(0, 8)}..., waiting...`);
      return this.pendingLoads.get(key);
    }

    // Create a new load promise
    const loadPromise = (async () => {
      try {
        const value = await loader();
        this.set(key, value);
        return value;
      } finally {
        // Always clean up the pending load entry
        this.pendingLoads.delete(key);
      }
    })();

    // Store the promise so concurrent requests can share it
    this.pendingLoads.set(key, loadPromise);

    return loadPromise;
  }

  /**
   * Check if a load is pending for a key
   * @param {string} key - Cache key
   * @returns {boolean}
   */
  isLoadPending(key) {
    return this.pendingLoads.has(key);
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

// Create singleton with 5 minute TTL (increased from 60s for better performance)
const configCache = new ConfigCache(300000, 1000);
configCache.startCleanup();

module.exports = configCache;
