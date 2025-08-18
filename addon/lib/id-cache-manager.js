const database = require('./database');
const crypto = require('crypto');

class IdCacheManager {
  constructor() {
    this.db = database;
    this.compressionEnabled = process.env.ID_CACHE_COMPRESSION === 'true';
    this.maxCacheSize = parseInt(process.env.ID_CACHE_MAX_SIZE) || 100000; // Default 100k entries
    this.ttlDays = parseInt(process.env.ID_CACHE_TTL_DAYS) || 90; // Default 90 days
  }

  /**
   * Get cache statistics with storage information
   */
  async getCacheStats() {
    try {
      const stats = await this.db.allQuery(`
        SELECT 
          content_type,
          COUNT(*) as total_mappings,
          COUNT(CASE WHEN tmdb_id IS NOT NULL THEN 1 END) as with_tmdb,
          COUNT(CASE WHEN tvdb_id IS NOT NULL THEN 1 END) as with_tvdb,
          COUNT(CASE WHEN imdb_id IS NOT NULL THEN 1 END) as with_imdb,
          COUNT(CASE WHEN tvmaze_id IS NOT NULL THEN 1 END) as with_tvmaze,
          COUNT(CASE WHEN tmdb_id IS NOT NULL AND tvdb_id IS NOT NULL AND imdb_id IS NOT NULL THEN 1 END) as complete_mappings,
          COUNT(CASE WHEN updated_at < datetime('now', '-${this.ttlDays} days') THEN 1 END) as expired_entries
        FROM id_mappings 
        GROUP BY content_type
      `);
      
      // Get total size estimate
      const sizeQuery = await this.db.getQuery(`
        SELECT COUNT(*) as total_entries,
               SUM(LENGTH(tmdb_id) + LENGTH(tvdb_id) + LENGTH(imdb_id) + LENGTH(tvmaze_id)) as total_size
        FROM id_mappings
      `);
      
      return {
        stats,
        totalEntries: sizeQuery?.total_entries || 0,
        estimatedSizeKB: Math.round((sizeQuery?.total_size || 0) / 1024),
        maxSize: this.maxCacheSize,
        ttlDays: this.ttlDays,
        compressionEnabled: this.compressionEnabled
      };
    } catch (error) {
      console.error('[ID Cache Manager] Error getting stats:', error);
      return { stats: [], totalEntries: 0, estimatedSizeKB: 0 };
    }
  }

  /**
   * Clear old cache entries (older than specified days)
   */
  async clearOldCache(daysOld = null) {
    const days = daysOld || this.ttlDays;
    try {
      const result = await this.db.runQuery(`
        DELETE FROM id_mappings 
        WHERE updated_at < datetime('now', '-${days} days')
      `);
      
      console.log(`[ID Cache Manager] Cleared ${result.changes} old cache entries (older than ${days} days)`);
      return result.changes;
    } catch (error) {
      console.error('[ID Cache Manager] Error clearing old cache:', error);
      return 0;
    }
  }

  /**
   * Clear all cache entries
   */
  async clearAllCache() {
    try {
      const result = await this.db.runQuery('DELETE FROM id_mappings');
      console.log(`[ID Cache Manager] Cleared all ${result.changes} cache entries`);
      return result.changes;
    } catch (error) {
      console.error('[ID Cache Manager] Error clearing all cache:', error);
      return 0;
    }
  }

  /**
   * Enforce cache size limits
   */
  async enforceSizeLimit() {
    try {
      // Get current count
      const countResult = await this.db.getQuery('SELECT COUNT(*) as count FROM id_mappings');
      const currentCount = countResult?.count || 0;
      
      if (currentCount <= this.maxCacheSize) {
        return 0; // No action needed
      }
      
      // Calculate how many to remove
      const toRemove = currentCount - this.maxCacheSize;
      
      // Remove oldest entries first
      const result = await this.db.runQuery(`
        DELETE FROM id_mappings 
        WHERE id IN (
          SELECT id FROM id_mappings 
          ORDER BY updated_at ASC 
          LIMIT ${toRemove}
        )
      `);
      
      console.log(`[ID Cache Manager] Enforced size limit: removed ${result.changes} oldest entries`);
      return result.changes;
    } catch (error) {
      console.error('[ID Cache Manager] Error enforcing size limit:', error);
      return 0;
    }
  }

  /**
   * Optimize cache storage
   */
  async optimizeStorage() {
    try {
      console.log('[ID Cache Manager] Starting storage optimization...');
      
      // Clear expired entries
      const expiredCount = await this.clearOldCache();
      
      // Enforce size limits
      const sizeLimitCount = await this.enforceSizeLimit();
      
      // Vacuum database (SQLite only)
      if (this.db.type === 'sqlite') {
        await this.db.runQuery('VACUUM');
        console.log('[ID Cache Manager] Database vacuumed');
      }
      
      // Update statistics
      await this.updateStatistics();
      
      console.log(`[ID Cache Manager] Storage optimization complete: ${expiredCount} expired, ${sizeLimitCount} size-limited`);
      return { expiredCount, sizeLimitCount };
    } catch (error) {
      console.error('[ID Cache Manager] Error optimizing storage:', error);
      return { expiredCount: 0, sizeLimitCount: 0 };
    }
  }

  /**
   * Update database statistics for better query planning
   */
  async updateStatistics() {
    try {
      if (this.db.type === 'sqlite') {
        await this.db.runQuery('ANALYZE');
      } else {
        await this.db.runQuery('ANALYZE id_mappings');
      }
      console.log('[ID Cache Manager] Database statistics updated');
    } catch (error) {
      console.warn('[ID Cache Manager] Could not update statistics:', error.message);
    }
  }

  /**
   * Get cache entries by content type with pagination
   */
  async getCacheByType(contentType, limit = 100, offset = 0) {
    try {
      const entries = await this.db.allQuery(`
        SELECT * FROM id_mappings 
        WHERE content_type = ? 
        ORDER BY updated_at DESC 
        LIMIT ? OFFSET ?
      `, [contentType, limit, offset]);
      
      return entries;
    } catch (error) {
      console.error('[ID Cache Manager] Error getting cache by type:', error);
      return [];
    }
  }

  /**
   * Search cache by any ID with pagination
   */
  async searchCache(searchId, contentType = null, limit = 10, offset = 0) {
    try {
      let query = `
        SELECT * FROM id_mappings 
        WHERE tmdb_id = ? OR tvdb_id = ? OR imdb_id = ? OR tvmaze_id = ?
      `;
      let params = [searchId, searchId, searchId, searchId];
      
      if (contentType) {
        query += ' AND content_type = ?';
        params.push(contentType);
      }
      
      query += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);
      
      const entries = await this.db.allQuery(query, params);
      return entries;
    } catch (error) {
      console.error('[ID Cache Manager] Error searching cache:', error);
      return [];
    }
  }

  /**
   * Manually add a mapping to cache with size limit check
   */
  async addMapping(contentType, tmdbId = null, tvdbId = null, imdbId = null, tvmazeId = null) {
    try {
      // Check if we need to enforce size limits
      await this.enforceSizeLimit();
      
      await this.db.saveIdMapping(contentType, tmdbId, tvdbId, imdbId, tvmazeId);
      console.log(`[ID Cache Manager] Added mapping for ${contentType}:`, { tmdbId, tvdbId, imdbId, tvmazeId });
      return true;
    } catch (error) {
      console.error('[ID Cache Manager] Error adding mapping:', error);
      return false;
    }
  }

  /**
   * Get cache hit rate and performance metrics
   */
  async getCacheHitRate() {
    const stats = await this.getCacheStats();
    const totalMappings = stats.totalEntries || 0;
    
    return {
      totalMappings,
      stats: stats.stats,
      estimatedSizeKB: stats.estimatedSizeKB,
      maxSize: stats.maxSize,
      ttlDays: stats.ttlDays,
      compressionEnabled: stats.compressionEnabled,
      usagePercentage: totalMappings > 0 ? Math.round((totalMappings / stats.maxSize) * 100) : 0
    };
  }

  /**
   * Get storage recommendations
   */
  async getStorageRecommendations() {
    const stats = await this.getCacheHitRate();
    const recommendations = [];
    
    if (stats.usagePercentage > 80) {
      recommendations.push('Cache is nearly full. Consider increasing max size or clearing old entries.');
    }
    
    if (stats.estimatedSizeKB > 10240) { // 10MB
      recommendations.push('Cache size is large. Consider enabling compression or clearing old entries.');
    }
    
    if (stats.totalMappings > 50000) {
      recommendations.push('Large number of entries. Consider implementing TTL or periodic cleanup.');
    }
    
    return {
      recommendations,
      currentStats: stats
    };
  }

  /**
   * Batch operations for better performance
   */
  async batchAddMappings(mappings) {
    try {
      const batchSize = 100;
      let added = 0;
      
      for (let i = 0; i < mappings.length; i += batchSize) {
        const batch = mappings.slice(i, i + batchSize);
        
        for (const mapping of batch) {
          const success = await this.addMapping(
            mapping.contentType,
            mapping.tmdbId,
            mapping.tvdbId,
            mapping.imdbId,
            mapping.tvmazeId
          );
          if (success) added++;
        }
        
        // Enforce size limits periodically
        if (i % (batchSize * 10) === 0) {
          await this.enforceSizeLimit();
        }
      }
      
      console.log(`[ID Cache Manager] Batch added ${added} mappings`);
      return added;
    } catch (error) {
      console.error('[ID Cache Manager] Error in batch operation:', error);
      return 0;
    }
  }
}

module.exports = new IdCacheManager();
