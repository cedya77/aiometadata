const redis: any = require('./redisClient');
const { decodeCachePayload }: any = require('./cacheCodec');

interface ValidationResult {
  isValid: boolean;
  issues: string[];
  itemCount?: number;
  metaId?: string;
  contentType?: string;
}

interface CacheCheckResult {
  shouldInvalidate: boolean;
  reason: string | null;
  issues?: string[];
}

interface InvalidationResult {
  invalidated: number;
  checked: number;
  error?: string;
}

class CacheValidator {
  badPatterns: {
    episodeIds: RegExp[];
    metaFields: RegExp[];
    catalogFields: RegExp[];
    genreFields: RegExp[];
  };
  validationRules: Record<string, any>;

  constructor() {
    this.badPatterns = {
      episodeIds: [
        /:\d+:undefined$/,
        /:undefined:\d+$/,
        /:undefined:undefined$/,
        /^undefined:/,
        /^[^:]+:[^:]+:undefined$/,
      ],
      metaFields: [
        /"id":\s*"undefined"/,
        /"title":\s*"undefined"/,
        /"episode":\s*undefined/,
        /"season":\s*undefined/,
      ],
      catalogFields: [
        /"id":\s*"undefined"/,
        /"name":\s*"undefined"/,
        /"type":\s*"undefined"/,
      ],
      genreFields: [
        /"id":\s*"undefined"/,
        /"name":\s*"undefined"/,
        /"id":\s*null/,
        /"name":\s*null/,
      ]
    };

    this.validationRules = {
      series: {
        required: ['id', 'name', 'type'],
        episodeValidation: (episodes: any[]) => {
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
      movie: {
        required: ['id', 'name', 'type'],
        fieldValidation: (meta: any) => {
          return meta.id &&
                 !meta.id.includes('undefined') &&
                 meta.name &&
                 meta.name !== 'undefined';
        }
      }
    };
  }

  validateEpisodes(episodes: any[]): string[] {
    const issues: string[] = [];

    if (!Array.isArray(episodes)) {
      issues.push('Episodes is not an array');
      return issues;
    }

    episodes.forEach((ep: any, index: number) => {
      if (ep.id && typeof ep.id === 'string') {
        for (const pattern of this.badPatterns.episodeIds) {
          if (pattern.test(ep.id)) {
            issues.push(`Episode ${index + 1} has bad ID pattern: ${ep.id}`);
          }
        }
      }

      if (ep.title === 'undefined' || ep.title === undefined) {
        issues.push(`Episode ${index + 1} has undefined title`);
      }

      if (ep.episode === undefined || ep.episode === 'undefined') {
        issues.push(`Episode ${index + 1} has undefined episode number`);
      }

      if (ep.season === undefined || ep.season === 'undefined') {
        issues.push(`Episode ${index + 1} has undefined season number`);
      }
    });

    return issues;
  }

  validateCatalogResponse(catalog: any): ValidationResult {
    const issues: string[] = [];

    if (!catalog || !catalog.metas) {
      issues.push('Catalog response is missing or has no metas');
      return { isValid: false, issues };
    }

    if (!Array.isArray(catalog.metas)) {
      issues.push('Catalog metas is not an array');
      return { isValid: false, issues };
    }

    catalog.metas.forEach((meta: any, index: number) => {
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

  validateSearchBeforeCache(data: any): ValidationResult {
    const issues: string[] = [];

    if (!data || !data.metas) {
      issues.push('Search response is missing or has no metas');
      return { isValid: false, issues };
    }

    if (!Array.isArray(data.metas)) {
      issues.push('Search metas is not an array');
      return { isValid: false, issues };
    }

    if (data.metas.length === 0) {
      console.log('[Search Validation] Empty search results (this is valid)');
    }

    data.metas.forEach((meta: any, index: number) => {
      if (meta.id && typeof meta.id === 'string' && meta.id.includes('undefined')) {
        issues.push(`Search item ${index + 1} has bad ID: ${meta.id}`);
      }

      if (meta.name === 'undefined' || meta.name === undefined) {
        issues.push(`Search item ${index + 1} has undefined name`);
      }

      if (meta.type === 'undefined' || meta.type === undefined) {
        issues.push(`Search item ${index + 1} has undefined type`);
      }

      if (meta.poster && typeof meta.poster === 'string') {
        if (meta.poster.includes('undefined') || meta.poster === 'null') {
          issues.push(`Search item ${index + 1} has malformed poster URL`);
        }
      }

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

  validateGenreBeforeCache(data: any): ValidationResult {
    const issues: string[] = [];

    if (!data) {
      issues.push('Genre data is null or undefined');
      return { isValid: false, issues };
    }

    if (data.error) {
      issues.push(`Genre data contains error: ${data.message || 'Unknown error'}`);
      return { isValid: false, issues };
    }

    if (!Array.isArray(data)) {
      issues.push('Genre data is not an array');
      return { isValid: false, issues };
    }

    if (data.length === 0) {
      console.log('[Cache Validator] Genre array is empty - this might be valid');
      return { isValid: true, issues: [] };
    }

    data.forEach((genre: any, index: number) => {
      if (!genre || typeof genre !== 'object') {
        issues.push(`Genre ${index} is not a valid object`);
        return;
      }

      if (!genre.id) {
        issues.push(`Genre ${index} missing required field: id`);
      }

      if (!genre.name) {
        issues.push(`Genre ${index} missing required field: name`);
      }

      if (genre.id && typeof genre.id === 'string' && genre.id.includes('undefined')) {
        issues.push(`Genre ${index} ID contains undefined: ${genre.id}`);
      }

      if (genre.name && genre.name === 'undefined') {
        issues.push(`Genre ${index} name is undefined string`);
      }

      if (genre.id === null) {
        issues.push(`Genre ${index} ID is null`);
      }

      if (genre.name === null) {
        issues.push(`Genre ${index} name is null`);
      }

      if (genre.id && typeof genre.id !== 'number' && typeof genre.id !== 'string') {
        issues.push(`Genre ${index} ID has invalid type: ${typeof genre.id}`);
      }

      if (genre.name && typeof genre.name !== 'string') {
        issues.push(`Genre ${index} name has invalid type: ${typeof genre.name}`);
      }
    });

    return { isValid: issues.length === 0, issues };
  }

  async checkCacheKeyForBadData(cacheKey: string, contentType: string = 'meta'): Promise<CacheCheckResult> {
    if (!redis) return { shouldInvalidate: false, reason: 'Redis not available' };

    try {
      const cachedData = typeof redis.getBuffer === 'function'
        ? await redis.getBuffer(cacheKey)
        : await redis.get(cacheKey);
      if (!cachedData) return { shouldInvalidate: false, reason: 'No cached data' };

      const parsed = await decodeCachePayload(cachedData);

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

    } catch (error: any) {
      console.error('[Cache Validator] Error checking cache key:', error);
      return { shouldInvalidate: false, reason: 'Error parsing cached data' };
    }
  }

  async invalidateBadCacheKeys(pattern: string = '*', contentType: string = 'meta'): Promise<InvalidationResult> {
    if (!redis) {
      console.warn('[Cache Validator] Redis not available for cache invalidation');
      return { invalidated: 0, checked: 0 };
    }

    try {
      let invalidated = 0;
      let checked = 0;
      console.log(`[Cache Validator] Scanning keys matching ${pattern} for bad data...`);
      const { scanKeys } = require('./redisUtils');
      await scanKeys(pattern, async (key: string) => {
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

    } catch (error: any) {
      console.error('[Cache Validator] Error during cache invalidation:', error);
      return { invalidated: 0, checked: 0, error: error.message };
    }
  }

  async cleanAllBadCache(): Promise<{ totalInvalidated: number; totalChecked: number; details: Record<string, InvalidationResult> }> {
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

  validateBeforeCache(data: any, contentType: string = 'meta'): ValidationResult {
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

  validateMetaBeforeCache(data: any): ValidationResult {
    const issues: string[] = [];

    if (!data) {
      issues.push('Meta data is null or undefined');
      return { isValid: false, issues };
    }

    if (data.error) {
      issues.push(`Meta data contains error: ${data.message || 'Unknown error'}`);
      return { isValid: false, issues };
    }

    if (!data.meta) {
      issues.push('Meta response missing meta object');
      return { isValid: false, issues };
    }

    const meta = data.meta;

    if (meta === null) {
      issues.push('Meta object is null');
      return { isValid: false, issues };
    }

    if (!meta.id) {
      issues.push('Meta missing required field: id');
    }

    if (!meta.name) {
      issues.push('Meta missing required field: name');
    }

    if (!meta.type) {
      issues.push('Meta missing required field: type');
    }

    if (meta.id && typeof meta.id === 'string' && meta.id.includes('undefined')) {
      issues.push(`Meta ID contains undefined: ${meta.id}`);
    }

    if (meta.name && meta.name === 'undefined') {
      issues.push('Meta name is undefined string');
    }

    if (meta.type && meta.type === 'undefined') {
      issues.push('Meta type is undefined string');
    }

    if (meta.type === 'series' && meta.videos) {
      if (!Array.isArray(meta.videos)) {
        issues.push('Series videos is not an array');
      } else {
        const episodeIssues = this.validateEpisodes(meta.videos);
        issues.push(...episodeIssues);
      }
    }

    if (meta.links && !Array.isArray(meta.links)) {
      issues.push('Meta links is not an array');
    }

    if (meta.genres && !Array.isArray(meta.genres)) {
      issues.push('Meta genres is not an array');
    }

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

const instance = new CacheValidator();
export { instance as default };
module.exports = instance;
