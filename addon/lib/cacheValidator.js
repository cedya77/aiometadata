// FILE: lib/cacheValidator.js

const redis = require('./redisClient');

/**
 * Cache validation system to detect and invalidate bad cache entries
 * Helps ensure cache quality and automatic recovery from bugs
 */

class CacheValidator {
  constructor() {
    this.badPatterns = {
      // Episode ID patterns that indicate bad data
      episodeIds: [
        /:\d+:undefined$/,           // e.g., "tt21975436:1:undefined"
        /:undefined:\d+$/,           // e.g., "tt21975436:undefined:1"
        /:undefined:undefined$/,     // e.g., "tt21975436:undefined:undefined"
        /^undefined:/,               // e.g., "undefined:123:1"
        /:undefined$/,               // e.g., "mal:123:undefined"
      ],
      // Meta patterns that indicate bad data
      metaFields: [
        /"id":\s*"undefined"/,      // undefined ID fields
        /"title":\s*"undefined"/,   // undefined title fields
        /"episode":\s*undefined/,   // undefined episode numbers
        /"season":\s*undefined/,    // undefined season numbers
      ],
      // Catalog patterns that indicate bad data
      catalogFields: [
        /"id":\s*"undefined"/,      // undefined catalog IDs
        /"name":\s*"undefined"/,    // undefined names
        /"type":\s*"undefined"/,    // undefined types
      ]
    };
    
    this.validationRules = {
      // Series meta validation rules
      series: {
        required: ['id', 'name', 'type'],
        episodeValidation: (episodes) => {
          if (!Array.isArray(episodes)) return false;
          return episodes.every(ep => 
            ep.id && 
            !ep.id.includes('undefined') && 
            ep.title && 
            ep.title !== 'undefined' &&
            typeof ep.episode === 'number' &&
            typeof ep.season === 'number'
          );
        }
      },
      // Movie meta validation rules
      movie: {
        required: ['id', 'name', 'type'],
        fieldValidation: (meta) => {
          return meta.id && 
                 !meta.id.includes('undefined') && 
                 meta.name && 
                 meta.name !== 'undefined';
        }
      }
    };
  }

  /**
   * Validate a meta response for bad data patterns
   */
  validateMetaResponse(meta, contentType = 'series') {
    const issues = [];
    
    if (!meta) {
      issues.push('Meta response is null or undefined');
      return { isValid: false, issues };
    }

    // Check for undefined in ID
    if (meta.id && typeof meta.id === 'string' && meta.id.includes('undefined')) {
      issues.push(`Bad episode ID pattern: ${meta.id}`);
    }

    // Check for undefined in title
    if (meta.name && meta.name === 'undefined') {
      issues.push('Title is undefined');
    }

    // Check for undefined in type
    if (meta.type && meta.type === 'undefined') {
      issues.push('Type is undefined');
    }

    // Validate episodes for series
    if (contentType === 'series' && meta.videos) {
      const episodeIssues = this.validateEpisodes(meta.videos);
      issues.push(...episodeIssues);
    }

    // Check for required fields
    const rules = this.validationRules[contentType];
    if (rules) {
      for (const field of rules.required) {
        if (!meta[field]) {
          issues.push(`Missing required field: ${field}`);
        }
      }
    }

    return {
      isValid: issues.length === 0,
      issues,
      metaId: meta.id,
      contentType
    };
  }

  /**
   * Validate episodes array for bad data
   */
  validateEpisodes(episodes) {
    const issues = [];
    
    if (!Array.isArray(episodes)) {
      issues.push('Episodes is not an array');
      return issues;
    }

    episodes.forEach((ep, index) => {
      // Check episode ID
      if (ep.id && typeof ep.id === 'string') {
        for (const pattern of this.badPatterns.episodeIds) {
          if (pattern.test(ep.id)) {
            issues.push(`Episode ${index + 1} has bad ID pattern: ${ep.id}`);
          }
        }
      }

      // Check episode title
      if (ep.title === 'undefined' || ep.title === undefined) {
        issues.push(`Episode ${index + 1} has undefined title`);
      }

      // Check episode number
      if (ep.episode === undefined || ep.episode === 'undefined') {
        issues.push(`Episode ${index + 1} has undefined episode number`);
      }

      // Check season number
      if (ep.season === undefined || ep.season === 'undefined') {
        issues.push(`Episode ${index + 1} has undefined season number`);
      }
    });

    return issues;
  }

  /**
   * Validate a catalog response for bad data patterns
   */
  validateCatalogResponse(catalog) {
    const issues = [];
    
    if (!catalog || !catalog.metas) {
      issues.push('Catalog response is missing or has no metas');
      return { isValid: false, issues };
    }

    if (!Array.isArray(catalog.metas)) {
      issues.push('Catalog metas is not an array');
      return { isValid: false, issues };
    }

    catalog.metas.forEach((meta, index) => {
      if (meta.id && typeof meta.id === 'string' && meta.id.includes('undefined')) {
        issues.push(`Catalog item ${index + 1} has bad ID: ${meta.id}`);
      }

      if (meta.name === 'undefined' || meta.name === undefined) {
        console.log(`Catalog item ${index + 1} has undefined name:`, meta);
        issues.push(`Catalog item ${index + 1} has undefined name`);
      }
    });

    return {
      isValid: issues.length === 0,
      issues,
      itemCount: catalog.metas.length
    };
  }

  /**
   * Check if a cache key contains bad data and should be invalidated
   */
  async checkCacheKeyForBadData(cacheKey, contentType = 'meta') {
    if (!redis) return { shouldInvalidate: false, reason: 'Redis not available' };

    try {
      const cachedData = await redis.get(cacheKey);
      if (!cachedData) return { shouldInvalidate: false, reason: 'No cached data' };

      const parsed = JSON.parse(cachedData);
      
      if (contentType === 'meta') {
        // Skip meta validation for now as it's causing issues with valid meta responses
        return {
          shouldInvalidate: false,
          reason: 'Meta validation disabled',
          issues: []
        };
      } else if (contentType === 'catalog') {
        const validation = this.validateCatalogResponse(parsed);
        return {
          shouldInvalidate: !validation.isValid,
          reason: validation.isValid ? null : validation.issues.join(', '),
          issues: validation.issues
        };
      }

      return { shouldInvalidate: false, reason: 'Unknown content type' };

    } catch (error) {
      console.error('[Cache Validator] Error checking cache key:', error);
      return { shouldInvalidate: false, reason: 'Error parsing cached data' };
    }
  }

  /**
   * Invalidate cache keys that contain bad data
   */
  async invalidateBadCacheKeys(pattern = '*', contentType = 'meta') {
    if (!redis) {
      console.warn('[Cache Validator] Redis not available for cache invalidation');
      return { invalidated: 0, checked: 0 };
    }

    try {
      const keys = await redis.keys(pattern);
      let invalidated = 0;
      let checked = 0;

      console.log(`[Cache Validator] Checking ${keys.length} cache keys for bad data...`);

      for (const key of keys) {
        checked++;
        const result = await this.checkCacheKeyForBadData(key, contentType);
        
        if (result.shouldInvalidate) {
          await redis.del(key);
          invalidated++;
          console.log(`[Cache Validator] Invalidated bad cache key: ${key} - Reason: ${result.reason}`);
        }
      }

      console.log(`[Cache Validator] Cache validation complete. Checked: ${checked}, Invalidated: ${invalidated}`);
      return { invalidated, checked };

    } catch (error) {
      console.error('[Cache Validator] Error during cache invalidation:', error);
      return { invalidated: 0, checked: 0, error: error.message };
    }
  }

  /**
   * Scan and clean all bad cache entries
   */
  async cleanAllBadCache() {
    const results = {
      meta: await this.invalidateBadCacheKeys('meta*', 'meta'),
      catalog: await this.invalidateBadCacheKeys('catalog*', 'catalog'),
      global: await this.invalidateBadCacheKeys('meta-global*', 'meta')
    };

    const totalInvalidated = results.meta.invalidated + results.catalog.invalidated + results.global.invalidated;
    const totalChecked = results.meta.checked + results.catalog.checked + results.global.checked;

    console.log(`[Cache Validator] Total cache cleaning complete. Checked: ${totalChecked}, Invalidated: ${totalInvalidated}`);

    return {
      totalInvalidated,
      totalChecked,
      details: results
    };
  }

  /**
   * Validate data before caching to prevent bad data from being cached
   */
  validateBeforeCache(data, contentType = 'meta') {
    // Skip meta validation for now as it's causing issues with valid meta responses
    if (contentType === 'catalog') {
      return this.validateCatalogResponse(data);
    }
    
    return { isValid: true, issues: [] };
  }
}

module.exports = new CacheValidator();
