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
        /^[^:]+:[^:]+:undefined$/,   // e.g., "mal:123:undefined" (but not "tmdb:123:1:undefined")
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
      ],
      // Genre patterns that indicate bad data
      genreFields: [
        /"id":\s*"undefined"/,      // undefined genre IDs
        /"name":\s*"undefined"/,    // undefined genre names
        /"id":\s*null/,             // null genre IDs
        /"name":\s*null/,           // null genre names
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
   * Validate search results before caching
   */
  validateSearchBeforeCache(data) {
    const issues = [];
    
    if (!data || !data.metas) {
      issues.push('Search response is missing or has no metas');
      return { isValid: false, issues };
    }

    if (!Array.isArray(data.metas)) {
      issues.push('Search metas is not an array');
      return { isValid: false, issues };
    }

    // Check for empty search results (this is valid, but log it)
    if (data.metas.length === 0) {
      console.log('[Search Validation] Empty search results (this is valid)');
    }

    data.metas.forEach((meta, index) => {
      // Check for bad IDs
      if (meta.id && typeof meta.id === 'string' && meta.id.includes('undefined')) {
        issues.push(`Search item ${index + 1} has bad ID: ${meta.id}`);
      }

      // Check for undefined names
      if (meta.name === 'undefined' || meta.name === undefined) {
        issues.push(`Search item ${index + 1} has undefined name`);
      }

      // Check for malformed type
      if (meta.type === 'undefined' || meta.type === undefined) {
        issues.push(`Search item ${index + 1} has undefined type`);
      }

      // Check for malformed poster URLs
      if (meta.poster && typeof meta.poster === 'string') {
        if (meta.poster.includes('undefined') || meta.poster === 'null') {
          issues.push(`Search item ${index + 1} has malformed poster URL`);
        }
      }

      // Check for malformed background URLs
      if (meta.background && typeof meta.background === 'string') {
        if (meta.background.includes('undefined') || meta.background === 'null') {
          issues.push(`Search item ${index + 1} has malformed background URL`);
        }
      }
    });

    return {
      isValid: issues.length === 0,
      issues,
      itemCount: data.metas.length
    };
  }

  /**
   * Validate genre data before caching
   */
  validateGenreBeforeCache(data) {
    const issues = [];
    
    // Check if data exists
    if (!data) {
      issues.push('Genre data is null or undefined');
      return { isValid: false, issues };
    }

    // Check if it's an error response
    if (data.error) {
      issues.push(`Genre data contains error: ${data.message || 'Unknown error'}`);
      return { isValid: false, issues };
    }

    // Check if it's an array
    if (!Array.isArray(data)) {
      issues.push('Genre data is not an array');
      return { isValid: false, issues };
    }

    // Check for empty array (this might be valid for some cases)
    if (data.length === 0) {
      console.log('[Cache Validator] Genre array is empty - this might be valid');
      return { isValid: true, issues: [] };
    }

    // Validate each genre object
    data.forEach((genre, index) => {
      if (!genre || typeof genre !== 'object') {
        issues.push(`Genre ${index} is not a valid object`);
        return;
      }

      // Check for required fields
      if (!genre.id) {
        issues.push(`Genre ${index} missing required field: id`);
      }

      if (!genre.name) {
        issues.push(`Genre ${index} missing required field: name`);
      }

      // Check for malformed fields
      if (genre.id && typeof genre.id === 'string' && genre.id.includes('undefined')) {
        issues.push(`Genre ${index} ID contains undefined: ${genre.id}`);
      }

      if (genre.name && genre.name === 'undefined') {
        issues.push(`Genre ${index} name is undefined string`);
      }

      // Check for null values
      if (genre.id === null) {
        issues.push(`Genre ${index} ID is null`);
      }

      if (genre.name === null) {
        issues.push(`Genre ${index} name is null`);
      }

      // Check for invalid types
      if (genre.id && typeof genre.id !== 'number' && typeof genre.id !== 'string') {
        issues.push(`Genre ${index} ID has invalid type: ${typeof genre.id}`);
      }

      if (genre.name && typeof genre.name !== 'string') {
        issues.push(`Genre ${index} name has invalid type: ${typeof genre.name}`);
      }
    });

    return { isValid: issues.length === 0, issues };
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
        const validation = this.validateMetaBeforeCache(parsed);
        return {
          shouldInvalidate: !validation.isValid,
          reason: validation.isValid ? null : validation.issues.join(', '),
          issues: validation.issues
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
      let invalidated = 0;
      let checked = 0;
      console.log(`[Cache Validator] Scanning keys matching ${pattern} for bad data...`);
      const { scanKeys } = require('./redisUtils');
      await scanKeys(pattern, async (key) => {
        checked++;
        const result = await this.checkCacheKeyForBadData(key, contentType);
        if (result.shouldInvalidate) {
          await redis.del(key);
          invalidated++;
          console.log(`[Cache Validator] Invalidated bad cache key: ${key} - Reason: ${result.reason}`);
        }
      });

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
    if (contentType === 'catalog') {
      return this.validateCatalogResponse(data);
    } else if (contentType === 'meta') {
      return this.validateMetaBeforeCache(data);
    } else if (contentType === 'search') {
      return this.validateSearchBeforeCache(data);
    } else if (contentType === 'genre') {
      return this.validateGenreBeforeCache(data);
    }
    
    return { isValid: true, issues: [] };
  }

  /**
   * Enhanced meta validation before caching
   */
  validateMetaBeforeCache(data) {
    const issues = [];
    
    // Check if data exists
    if (!data) {
      issues.push('Meta data is null or undefined');
      return { isValid: false, issues };
    }

    // Check if it's an error response
    if (data.error) {
      issues.push(`Meta data contains error: ${data.message || 'Unknown error'}`);
      return { isValid: false, issues };
    }

    // Check if meta object exists
    if (!data.meta) {
      issues.push('Meta response missing meta object');
      return { isValid: false, issues };
    }

    const meta = data.meta;

    // Check for null meta
    if (meta === null) {
      issues.push('Meta object is null');
      return { isValid: false, issues };
    }

    // Check for required fields
    if (!meta.id) {
      issues.push('Meta missing required field: id');
    }

    if (!meta.name) {
      issues.push('Meta missing required field: name');
    }

    if (!meta.type) {
      issues.push('Meta missing required field: type');
    }

    // Check for malformed fields
    if (meta.id && typeof meta.id === 'string' && meta.id.includes('undefined')) {
      issues.push(`Meta ID contains undefined: ${meta.id}`);
    }

    if (meta.name && meta.name === 'undefined') {
      issues.push('Meta name is undefined string');
    }

    if (meta.type && meta.type === 'undefined') {
      issues.push('Meta type is undefined string');
    }

    // Check for malformed episodes in series
    if (meta.type === 'series' && meta.videos) {
      if (!Array.isArray(meta.videos)) {
        issues.push('Series videos is not an array');
      } else {
        const episodeIssues = this.validateEpisodes(meta.videos);
        issues.push(...episodeIssues);
      }
    }

    // Check for malformed links
    if (meta.links && !Array.isArray(meta.links)) {
      issues.push('Meta links is not an array');
    }

    // Check for malformed genres
    if (meta.genres && !Array.isArray(meta.genres)) {
      issues.push('Meta genres is not an array');
    }


    // Check for malformed poster/background URLs
    if (meta.poster && typeof meta.poster === 'string') {
      if (meta.poster.includes('undefined') || meta.poster === 'null') {
        issues.push('Meta poster URL contains undefined/null');
      }
    }

    if (meta.background && typeof meta.background === 'string') {
      if (meta.background.includes('undefined') || meta.background === 'null') {
        issues.push('Meta background URL contains undefined/null');
      }
    }

    return {
      isValid: issues.length === 0,
      issues,
      metaId: meta.id,
      contentType: 'meta'
    };
  }
}

module.exports = new CacheValidator();
