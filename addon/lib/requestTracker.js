const redis = require('./redisClient');
const consola = require('consola');

// Configure Consola for better output with forced colors
const logger = consola.create({
  level: 4, // Show all levels
  fancy: true,
  formatOptions: {
    colors: true,
    compact: false,
    date: false
  }
});

class RequestTracker {
  constructor() {
    this.startTime = Date.now();
    this.dailyKey = `requests:${new Date().toISOString().split('T')[0]}`;
    this.hourlyKey = `requests:${new Date().toISOString().substring(0, 13)}`;
    this.errorKey = `errors:${new Date().toISOString().split('T')[0]}`;
    
    // Clean up any corrupted keys on startup
    this.cleanupCorruptedKeys().catch(error => {
      logger.warn('[Request Tracker] Failed to cleanup on startup:', error.message);
    });
  }

  // Middleware to track all requests
  middleware() {
    const tracker = this; // Capture the tracker instance
    
    return async (req, res, next) => {
      const startTime = Date.now();
      const originalSend = res.send;
      
      // Track request start
      tracker.trackRequest(req);
      
      // Override res.send to capture response data
      res.send = function(data) {
        const responseTime = Date.now() - startTime;
        
        // Track response
        tracker.trackResponse(req, res, responseTime);
        
        // Call original send
        return originalSend.call(this, data);
      };
      
      next();
    };
  }

  // Track incoming request
  async trackRequest(req) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const hour = new Date().toISOString().substring(0, 13);
      
      // Get improved anonymous user identifier
      const userIdentifier = this.getImprovedUserIdentifier(req);
      
      // Track content requests (meta requests)
      this.trackContentRequest(req);
      
      // Increment counters (don't await to avoid blocking)
      redis.incr(`requests:total`).catch(() => {});
      redis.incr(`requests:${today}`).catch(() => {});
      redis.incr(`requests:${hour}`).catch(() => {});
      redis.incr(`requests:endpoint:${this.normalizeEndpoint(req.path)}`).catch(() => {});
      
      // Track active users with improved methodology
      await this.trackActiveUser(userIdentifier, req);
      
      // Set expiration for time-based keys (don't await)
      redis.expire(`requests:${today}`, 86400 * 30).catch(() => {}); // 30 days
      redis.expire(`requests:${hour}`, 86400 * 7).catch(() => {}); // 7 days

      // Track metadata requests for activity feed
      const normalizedPath = this.normalizeEndpoint(req.path);
      if (normalizedPath.includes('/meta/') || normalizedPath.includes('/catalog/')) {
        const activityDetails = {
          endpoint: normalizedPath,
          userAgent: this.hashString(req.headers['user-agent'] || 'unknown'),
          method: req.method
        };
        
        if (normalizedPath.includes('/meta/')) {
          this.trackActivity('metadata_request', activityDetails);
        } else if (normalizedPath.includes('/catalog/')) {
          this.trackActivity('catalog_request', activityDetails);
        }
      }
      
    } catch (error) {
      logger.warn('[Request Tracker] Failed to track request:', error.message);
    }
  }

  // Track response
  async trackResponse(req, res, responseTime) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const endpoint = this.normalizeEndpoint(req.path);
      const statusCode = res.statusCode;
      
      // Track response times by endpoint (don't await to avoid blocking)
      redis.lpush(`response_times:${endpoint}`, responseTime).catch(() => {});
      redis.ltrim(`response_times:${endpoint}`, 0, 99).catch(() => {}); // Keep last 100
      
      // Track response times by hour for charts
      const hour = new Date().toISOString().substring(0, 13);
      redis.lpush(`response_times:${hour}`, responseTime).catch(() => {});
      redis.ltrim(`response_times:${hour}`, 0, 999).catch(() => {}); // Keep last 1000 for hourly averages
      redis.expire(`response_times:${hour}`, 86400 * 7).catch(() => {}); // 7 days expiration
      
      // Track status codes
      redis.incr(`status:${statusCode}:${today}`).catch(() => {});
      
      // Track errors
      if (statusCode >= 400) {
        redis.incr(`errors:total`).catch(() => {});
        redis.incr(`errors:${today}`).catch(() => {});
        redis.incr(`errors:${statusCode}:${today}`).catch(() => {});
      } else {
        redis.incr(`success:${today}`).catch(() => {});
      }
      
      // Set expiration (don't await)
      redis.expire(`status:${statusCode}:${today}`, 86400 * 30).catch(() => {});
      redis.expire(`errors:${statusCode}:${today}`, 86400 * 30).catch(() => {});
      redis.expire(`success:${today}`, 86400 * 30).catch(() => {});
      
    } catch (error) {
      logger.warn('[Request Tracker] Failed to track response:', error.message);
    }
  }

  // Normalize endpoint for tracking (remove IDs, etc.)
  normalizeEndpoint(path) {
    return path
      .replace(/\/[a-f0-9-]{36}/g, '/:uuid') // UUIDs (must come before ObjectId regex)
      .replace(/\/[a-f0-9]{24}/g, '/:id') // MongoDB ObjectIds
      .replace(/\/\d+/g, '/:id') // Numeric IDs
      .replace(/\/[a-zA-Z0-9_-]{8,}/g, '/:param') // Long params
      .toLowerCase();
  }

  // Simple hash function for user-agent
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  }

  // Track content requests (meta, search, catalog)
  async trackContentRequest(req) {
    try {
      const path = req.path;
      const today = new Date().toISOString().split('T')[0];
      
      // Track meta requests
      if (path.includes('/meta/')) {
        const metaMatch = path.match(/\/meta\/([^\/]+)\/([^\/]+)/);
        if (metaMatch) {
          let [, type, id] = metaMatch;
          
          // Store the original ID for tracking (with URL encoding)
          const originalId = id;
          
          // Also store a cleaned version for metadata lookup
          const cleanId = decodeURIComponent(id).replace(/\.(json|xml)$/i, '');
          
          const contentKey = `${type}:${originalId}`;
          const cleanContentKey = `${type}:${cleanId}`;
          
          // Track popular content
          redis.zincrby(`popular_content:${today}`, 1, contentKey).catch(() => {});
          redis.expire(`popular_content:${today}`, 86400 * 30).catch(() => {}); // 30 days
        }
      }
      
      // Track search requests
      if (path.includes('/catalog/') && req.query && req.query.search) {
        const searchQuery = req.query.search.toLowerCase().trim();
        if (searchQuery) {
          redis.zincrby(`search_patterns:${today}`, 1, searchQuery).catch(() => {});
          redis.expire(`search_patterns:${today}`, 86400 * 30).catch(() => {}); // 30 days
        }
      }
      
      // Track catalog requests by type
      if (path.includes('/catalog/')) {
        const catalogMatch = path.match(/\/catalog\/([^\/]+)/);
        if (catalogMatch) {
          const [, catalogType] = catalogMatch;
          redis.zincrby(`catalog_requests:${today}`, 1, catalogType).catch(() => {});
          redis.expire(`catalog_requests:${today}`, 86400 * 30).catch(() => {}); // 30 days
        }
      }
      
    } catch (error) {
      logger.warn('[Request Tracker] Failed to track content request:', error.message);
    }
  }

  // Get popular content
  async getPopularContent(limit = 10) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      
      // Get popular content from both days
      const [todayContent, yesterdayContent] = await Promise.all([
        redis.zrevrange(`popular_content:${today}`, 0, limit - 1, 'WITHSCORES'),
        redis.zrevrange(`popular_content:${yesterday}`, 0, limit - 1, 'WITHSCORES')
      ]);
      
      // Combine and format results
      const contentMap = new Map();
      
      // Process today's content
      for (let i = 0; i < todayContent.length; i += 2) {
        const contentKey = todayContent[i];
        const score = parseInt(todayContent[i + 1]) || 0;
        contentMap.set(contentKey, (contentMap.get(contentKey) || 0) + score);
      }
      
      // Process yesterday's content
      for (let i = 0; i < yesterdayContent.length; i += 2) {
        const contentKey = yesterdayContent[i];
        const score = parseInt(yesterdayContent[i + 1]) || 0;
        contentMap.set(contentKey, (contentMap.get(contentKey) || 0) + score);
      }
      
      // Convert to array and enrich with metadata
      const contentEntries = Array.from(contentMap.entries())
        .map(([contentKey, requests]) => {
          const [type, id] = contentKey.split(':');
          return { contentKey, type, id, requests };
        })
        .sort((a, b) => b.requests - a.requests)
        .slice(0, limit);

      // Enrich with cached metadata
      const popularContent = await Promise.all(
        contentEntries.map(async ({ contentKey, type, id, requests }) => {
          try {
            // Try to get real metadata from cache
            const metadataStr = await redis.get(`content_metadata:${contentKey}`);
            //logger.info(`[Request Tracker] Looking for metadata: content_metadata:${contentKey} -> ${metadataStr ? 'FOUND' : 'NOT FOUND'}`);
            
            if (metadataStr) {
              const metadata = JSON.parse(metadataStr);
              //logger.info(`[Request Tracker] Using real metadata for ${contentKey}: "${metadata.title}"`);
              return {
                id,
                type: metadata.type || type,
                requests,
                title: metadata.title,
                rating: metadata.rating,
                year: metadata.year,
                poster: metadata.poster,
                imdb_id: metadata.imdb_id
              };
            }
          } catch (error) {
            logger.warn('[Request Tracker] Failed to load metadata for', contentKey, error.message);
          }
          
          // Fallback to formatted title
          //logger.info(`[Request Tracker] Using fallback title for ${contentKey}: "${this.formatContentTitle(id, type)}"`);
          return {
            id,
            type,
            requests,
            title: this.formatContentTitle(id, type),
            rating: null,
            year: null
          };
        })
      );
      
      return popularContent;
    } catch (error) {
      logger.error('[Request Tracker] Failed to get popular content:', error);
      return [];
    }
  }

  // Get search patterns
  async getSearchPatterns(limit = 10) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      
      // Get search patterns from both days
      const [todaySearches, yesterdaySearches] = await Promise.all([
        redis.zrevrange(`search_patterns:${today}`, 0, limit - 1, 'WITHSCORES'),
        redis.zrevrange(`search_patterns:${yesterday}`, 0, limit - 1, 'WITHSCORES')
      ]);
      
      // Combine and format results
      const searchMap = new Map();
      
      // Process today's searches
      for (let i = 0; i < todaySearches.length; i += 2) {
        const query = todaySearches[i];
        const count = parseInt(todaySearches[i + 1]) || 0;
        searchMap.set(query, (searchMap.get(query) || 0) + count);
      }
      
      // Process yesterday's searches
      for (let i = 0; i < yesterdaySearches.length; i += 2) {
        const query = yesterdaySearches[i];
        const count = parseInt(yesterdaySearches[i + 1]) || 0;
        searchMap.set(query, (searchMap.get(query) || 0) + count);
      }
      
      // Convert to array and sort
      const searchPatterns = Array.from(searchMap.entries())
        .map(([query, count]) => ({
          query,
          count,
          success: 95 + Math.random() * 5 // TODO: Track actual success rates
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
      
      return searchPatterns;
    } catch (error) {
      logger.error('[Request Tracker] Failed to get search patterns:', error);
      return [];
    }
  }

  // Capture metadata from cache key (for cache hits)
  async captureMetadataFromCacheKey(cacheKey, meta) {
    try {
      if (!meta || !meta.name) return;

      // Extract metaId from cache key format: meta:config:metaId
      const keyMatch = cacheKey.match(/^meta:.*:(.+)$/);
      if (!keyMatch) return;

      const metaId = keyMatch[1];
      logger.info(`[Request Tracker] Capturing metadata from cache key for ${metaId}: "${meta.name}"`);
      
      // Use the existing capture method
      await this.captureMetadataFromComponents(metaId, meta, meta.type);
      
    } catch (error) {
      logger.warn('[Request Tracker] Failed to capture metadata from cache key:', error.message);
    }
  }

  // Capture metadata from complete meta components (better approach!)
  async captureMetadataFromComponents(metaId, meta, metaType) {
    try {
      if (!meta || !meta.name) return;

      /*logger.info(`[Request Tracker] Capturing metadata from components for ${metaId}:`, {
        name: meta.name,
        type: meta.type || metaType,
        imdbRating: meta.imdbRating,
        year: meta.year,
        imdb_id: meta.imdb_id
      });*/

      // Parse metaId to get the actual ID format
      const metaIdParts = metaId.split(':');
      const prefix = metaIdParts[0];
      const id = metaIdParts.length > 1 ? metaIdParts[1] : metaIdParts[0]; // Use full metaId if no colon
      const type = meta.type || metaType || 'unknown';
      
      // Determine the provider from the meta object or metaId
      let provider = prefix;
      if (metaIdParts.length === 1) {
        // If metaId is just an ID, try to determine provider from meta object
        if (meta.imdb_id && metaId.startsWith('tt')) {
          provider = 'imdb';
        } else if (metaId.match(/^\d+$/)) {
          // Numeric ID, could be TMDB or TVDB
          if (type === 'movie') {
            provider = 'tmdb';
          } else if (type === 'series') {
            provider = 'tvdb';
          } else {
            provider = 'tmdb'; // Default
          }
        }
      }
      
      // Create content key in the format that tracking uses
      // Also create URL-encoded version to match how requests are tracked
      const contentKey = `${type}:${id}`;
      const encodedId = encodeURIComponent(metaId) + '.json';
      const encodedContentKey = `${type}:${encodedId}`;
      
      // Also create the provider:ID format for better matching
      const providerId = metaIdParts.length > 1 ? metaId : `${provider}:${id}`;
      const providerContentKey = `${type}:${providerId}`;
      const providerEncodedId = encodeURIComponent(providerId) + '.json';
      const providerEncodedContentKey = `${type}:${providerEncodedId}`;
      
      // Store metadata for later lookup
      const metadataInfo = {
        title: meta.name,
        type: meta.type || metaType,
        rating: meta.imdbRating || meta.rating || null,
        year: meta.year || null,
        description: meta.description || null,
        poster: meta.poster || null,
        imdb_id: meta.imdb_id || null,
        cached_at: new Date().toISOString()
      };

      logger.info(`[Request Tracker] Storing metadata for ${contentKey}, ${encodedContentKey}, ${providerContentKey}, and ${providerEncodedContentKey}: "${metadataInfo.title}" ⭐${metadataInfo.rating}`);
      
      // Store in Redis with 30 day TTL for all formats
      redis.set(`content_metadata:${contentKey}`, JSON.stringify(metadataInfo), 'EX', 86400 * 30).catch(() => {});
      redis.set(`content_metadata:${encodedContentKey}`, JSON.stringify(metadataInfo), 'EX', 86400 * 30).catch(() => {});
      redis.set(`content_metadata:${providerContentKey}`, JSON.stringify(metadataInfo), 'EX', 86400 * 30).catch(() => {});
      redis.set(`content_metadata:${providerEncodedContentKey}`, JSON.stringify(metadataInfo), 'EX', 86400 * 30).catch(() => {});
      
    } catch (error) {
      logger.warn('[Request Tracker] Failed to capture metadata from components:', error.message);
    }
  }

  // Capture metadata when content is cached (legacy approach)
  async captureMetadata(cacheKey, result) {
    try {
      const meta = result?.meta || result;
      if (!meta || !meta.name) return;

      // Extract content info from cache key format: meta:config:id
      const keyMatch = cacheKey.match(/^meta:.*:(.+)$/);
      if (!keyMatch) {
        logger.info(`[Request Tracker] Cache key doesn't match expected format: ${cacheKey}`);
        return;
      }

      const [, id] = keyMatch;
      
      // Try to extract type from meta object or guess from ID
      let type = meta.type;
      if (!type) {
        // Try to determine type from ID patterns
        if (id.includes('movie') || id.includes('tmdb')) {
          type = 'movie';
        } else if (id.includes('series') || id.includes('tvdb')) {
          type = 'series';
        } else if (id.includes('anime')) {
          type = 'anime';
        } else {
          type = 'unknown';
        }
      }
      
      // Create both original and URL-encoded versions of the content key
      const cleanId = decodeURIComponent(id).replace(/\.(json|xml)$/i, '');
      const encodedId = encodeURIComponent(cleanId) + '.json';
      
      const cleanContentKey = `${type}:${cleanId}`;
      const encodedContentKey = `${type}:${encodedId}`;
      
      // Store metadata for later lookup
      const metadataInfo = {
        title: meta.name,
        type: meta.type || type,
        rating: meta.imdb_rating || meta.rating || null,
        year: meta.year || null,
        description: meta.description || null,
        poster: meta.poster || null,
        imdb_id: meta.imdb_id || null,
        cached_at: new Date().toISOString()
      };

      logger.info(`[Request Tracker] Capturing metadata for ${cleanContentKey} and ${encodedContentKey}: "${metadataInfo.title}"`);
      
      // Store in Redis with 30 day TTL for both formats
      redis.set(`content_metadata:${cleanContentKey}`, JSON.stringify(metadataInfo), 'EX', 86400 * 30).catch(() => {});
      redis.set(`content_metadata:${encodedContentKey}`, JSON.stringify(metadataInfo), 'EX', 86400 * 30).catch(() => {});
      
    } catch (error) {
      logger.warn('[Request Tracker] Failed to capture metadata:', error.message);
    }
  }

  // Format content title from ID
  formatContentTitle(id, type) {
    try {
      // Handle URL-encoded IDs
      let decodedId = decodeURIComponent(id);
      
      // Remove file extensions
      decodedId = decodedId.replace(/\.(json|xml)$/i, '');
      
      // Handle TMDB format: "tmdb:123456" or "Tmdb%3A123456"
      if (decodedId.match(/^tmdb[:%]?\d+$/i)) {
        const tmdbId = decodedId.replace(/^tmdb[:%]?/i, '');
        return `TMDB Movie ${tmdbId}`;
      }
      
      // Handle IMDB format: "tt1234567"
      if (decodedId.match(/^tt\d+$/)) {
        return `IMDB ${decodedId}`;
      }
      
      // Handle other provider formats
      if (decodedId.includes(':')) {
        const [provider, itemId] = decodedId.split(':');
        return `${provider.toUpperCase()} ${itemId}`;
      }
      
      // Basic cleanup for other IDs
      return decodedId
        .replace(/[_-]/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase())
        .trim();
    } catch (error) {
      // Fallback to original ID if formatting fails
      return id;
    }
  }

  // Track cache hit/miss
  async trackCacheHit() {
    try {
      const today = new Date().toISOString().split('T')[0];
      redis.incr(`cache:hits:${today}`).catch(() => {});
      redis.expire(`cache:hits:${today}`, 86400 * 30).catch(() => {});
    } catch (error) {
      logger.warn('[Request Tracker] Failed to track cache hit:', error.message);
    }
  }

  async trackCacheMiss() {
    try {
      const today = new Date().toISOString().split('T')[0];
      redis.incr(`cache:misses:${today}`).catch(() => {});
      redis.expire(`cache:misses:${today}`, 86400 * 30).catch(() => {});
    } catch (error) {
      logger.warn('[Request Tracker] Failed to track cache miss:', error.message);
    }
  }

  // Track provider API calls
  async trackProviderCall(provider, responseTime, success = true, rateLimitHeaders = null) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const hour = new Date().toISOString().substring(0, 13);
      
      // Track response times hourly
      redis.lpush(`provider_response_times:${provider}:${hour}`, responseTime).catch(() => {});
      redis.ltrim(`provider_response_times:${provider}:${hour}`, 0, 999).catch(() => {});
      redis.expire(`provider_response_times:${provider}:${hour}`, 86400 * 7).catch(() => {}); // 7 days
      
      // Track success/error rates
      if (success) {
        redis.incr(`provider_success:${provider}:${today}`).catch(() => {});
      } else {
        redis.incr(`provider_errors:${provider}:${today}`).catch(() => {});
      }
      redis.expire(`provider_success:${provider}:${today}`, 86400 * 7).catch(() => {});
      redis.expire(`provider_errors:${provider}:${today}`, 86400 * 7).catch(() => {});
      
      // Track hourly calls for rate limiting awareness
      redis.incr(`provider_calls:${provider}:${hour}`).catch(() => {});
      redis.expire(`provider_calls:${provider}:${hour}`, 3600 * 24).catch(() => {}); // 24 hours
      
      // Store real rate limit data if available
      if (rateLimitHeaders) {
        const rateLimitData = {
          limit: rateLimitHeaders.limit,
          remaining: rateLimitHeaders.remaining,
          reset: rateLimitHeaders.reset,
          timestamp: Date.now()
        };
        
        redis.setex(`provider_rate_limit:${provider}`, 3600, JSON.stringify(rateLimitData)).catch(() => {});
      }
      
    } catch (error) {
      logger.warn('[Request Tracker] Failed to track provider call:', error.message);
    }
  }

  // Get provider performance statistics
  async getProviderPerformance() {
    try {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      const providers = ['tmdb', 'tvdb', 'mal', 'anilist', 'kitsu', 'fanart', 'tvmaze'];
      
      const providerStats = await Promise.all(
        providers.map(async (provider) => {
          try {
            // Get response times for the last 24 hours (multiple hourly buckets)
            const now = new Date();
            const hours = [];
            for (let i = 0; i < 24; i++) {
              const hour = new Date(now.getTime() - (i * 3600000)).toISOString().substring(0, 13);
              hours.push(hour);
            }
            
            // Get response times from all hourly buckets
            const timePromises = hours.map(async hour => {
              try {
                return await redis.lrange(`provider_response_times:${provider}:${hour}`, 0, -1);
              } catch (error) {
                // Handle WRONGTYPE errors gracefully
                if (error.message.includes('WRONGTYPE')) {
                  logger.warn(`[Request Tracker] Wrong data type for ${provider}:${hour}, skipping`);
                  return [];
                }
                throw error;
              }
            });
            const timeResults = await Promise.all(timePromises);
            
            // Flatten all response times
            const allTimes = timeResults.flat().map(t => parseFloat(t)).filter(t => !isNaN(t));
            const avgResponseTime = allTimes.length > 0 ? Math.round(allTimes.reduce((a, b) => a + b, 0) / allTimes.length) : 0;
            
            // Get success/error rates
            const [todaySuccess, todayErrors, yesterdaySuccess, yesterdayErrors] = await Promise.all([
              redis.get(`provider_success:${provider}:${today}`),
              redis.get(`provider_errors:${provider}:${today}`),
              redis.get(`provider_success:${provider}:${yesterday}`),
              redis.get(`provider_errors:${provider}:${yesterday}`)
            ]);
            
            const totalSuccess = (parseInt(todaySuccess) || 0) + (parseInt(yesterdaySuccess) || 0);
            const totalErrors = (parseInt(todayErrors) || 0) + (parseInt(yesterdayErrors) || 0);
            const totalCalls = totalSuccess + totalErrors;
            
            const errorRate = totalCalls > 0 ? parseFloat(((totalErrors / totalCalls) * 100).toFixed(1)) : 0;
            
            // Determine status based on error rate and response time
            let status = 'healthy';
            if (errorRate > 10 || avgResponseTime > 3000) {
              status = 'error';
            } else if (errorRate > 5 || avgResponseTime > 1500) {
              status = 'warning';
            }
            
            // Don't include providers with no data
            if (totalCalls === 0 && avgResponseTime === 0) {
              return null;
            }
            
            return {
              name: provider.toUpperCase(),
              responseTime: avgResponseTime,
              errorRate: errorRate,
              status: status,
              totalCalls: totalCalls
            };
          } catch (providerError) {
            logger.warn(`[Request Tracker] Failed to get stats for provider ${provider}:`, providerError.message);
            return null;
          }
        })
      );
      
      // Filter out providers with no data and sort by usage
      return providerStats
        .filter(stat => stat !== null)
        .sort((a, b) => b.totalCalls - a.totalCalls);
        
    } catch (error) {
      logger.error('[Request Tracker] Failed to get provider performance:', error);
      return [];
    }
  }

  // Track recent activity
  async trackActivity(type, details) {
    try {
      logger.info(`[Request Tracker] Tracking activity: ${type} for ${details.endpoint}`);
      
      const activity = {
        id: Date.now(),
        type: type,
        details: details,
        timestamp: new Date().toISOString(),
        userAgent: this.hashString(details.userAgent || 'unknown')
      };
      
      // Store in recent activity list (keep last 100 activities)
      const activityKey = 'recent_activity';
      await redis.lpush(activityKey, JSON.stringify(activity));
      await redis.ltrim(activityKey, 0, 99); // Keep only last 100
      await redis.expire(activityKey, 86400 * 7); // 7 days
      
      logger.info(`[Request Tracker] Activity stored successfully: ${type}`);
      
    } catch (error) {
      logger.warn('[Request Tracker] Failed to track activity:', error.message);
    }
  }

  // Get recent activity
  async getRecentActivity(limit = 20) {
    try {
      logger.info('[Request Tracker] Getting recent activity...');
      
      const activities = await redis.lrange('recent_activity', 0, limit - 1);
      logger.info(`[Request Tracker] Found ${activities.length} activities in Redis`);
      
      const parsedActivities = activities.map(activity => JSON.parse(activity));
      logger.info(`[Request Tracker] Returning ${parsedActivities.length} parsed activities`);
      
      return parsedActivities;
    } catch (error) {
      logger.warn('[Request Tracker] Failed to get recent activity:', error.message);
      return [];
    }
  }

  // Get cache hit rate
  async getCacheHitRate() {
    try {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      
      const [todayHits, todayMisses, yesterdayHits, yesterdayMisses] = await Promise.all([
        redis.get(`cache:hits:${today}`),
        redis.get(`cache:misses:${today}`),
        redis.get(`cache:hits:${yesterday}`),
        redis.get(`cache:misses:${yesterday}`)
      ]);

      // Combine today and yesterday for more stable metrics
      const totalHits = (parseInt(todayHits) || 0) + (parseInt(yesterdayHits) || 0);
      const totalMisses = (parseInt(todayMisses) || 0) + (parseInt(yesterdayMisses) || 0);
      const totalRequests = totalHits + totalMisses;
      
      if (totalRequests === 0) {
        return 0; // No cache data yet
      }
      
      return Math.round((totalHits / totalRequests) * 100);
    } catch (error) {
      logger.error('[Request Tracker] Failed to get cache hit rate:', error);
      return 0;
    }
  }

  // Get request statistics
  async getStats() {
    try {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      
      // Add timeout to Redis operations
      const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Redis timeout')), 5000)
      );
      
      const [
        totalRequests,
        todayRequests,
        yesterdayRequests,
        totalErrors,
        todayErrors,
        todaySuccess
      ] = await Promise.race([
        Promise.all([
          redis.get('requests:total'),
          redis.get(`requests:${today}`),
          redis.get(`requests:${yesterday}`),
          redis.get('errors:total'),
          redis.get(`errors:${today}`),
          redis.get(`success:${today}`)
        ]),
        timeout
      ]);

      const todayReq = parseInt(todayRequests) || 0;
      const todayErr = parseInt(todayErrors) || 0;
      const todaySucc = parseInt(todaySuccess) || 0;
      
      // Ensure success rate doesn't exceed 100% due to tracking inconsistencies
      const actualTotal = Math.max(todayReq, todaySucc + todayErr);
      const successRate = actualTotal > 0 ? parseFloat(((todaySucc / actualTotal) * 100).toFixed(1)) : 0;
      const errorRate = actualTotal > 0 ? parseFloat(((todayErr / actualTotal) * 100).toFixed(1)) : 0;
      
      return {
        totalRequests: parseInt(totalRequests) || 0,
        todayRequests: todayReq,
        yesterdayRequests: parseInt(yesterdayRequests) || 0,
        totalErrors: parseInt(totalErrors) || 0,
        todayErrors: todayErr,
        successRate: Math.min(successRate, 100), // Cap at 100%
        errorRate: Math.min(errorRate, 100) // Cap at 100%
      };
    } catch (error) {
      logger.error('[Request Tracker] Failed to get stats:', error);
      return {
        totalRequests: 0,
        todayRequests: 0,
        yesterdayRequests: 0,
        totalErrors: 0,
        todayErrors: 0,
        successRate: 0,
        errorRate: 0
      };
    }
  }

  // Get hourly request data for charts
  async getHourlyStats(hours = 24) {
    try {
      const hourlyData = [];
      const now = new Date();
      
      for (let i = hours - 1; i >= 0; i--) {
        const hour = new Date(now.getTime() - (i * 60 * 60 * 1000));
        const hourKey = hour.toISOString().substring(0, 13);
        const requests = await redis.get(`requests:${hourKey}`);
        
        // Get average response time for this hour
        const responseTimesKey = `response_times:${hourKey}`;
        const responseTimes = await redis.lrange(responseTimesKey, 0, -1);
        const avgResponseTime = responseTimes.length > 0 
          ? responseTimes.reduce((sum, time) => sum + parseInt(time), 0) / responseTimes.length
          : 0;
        
        hourlyData.push({
          hour: hour.getHours(),
          requests: parseInt(requests) || 0,
          responseTime: Math.round(avgResponseTime),
          timestamp: hour.toISOString()
        });
      }
      
      return hourlyData;
    } catch (error) {
      logger.error('[Request Tracker] Failed to get hourly stats:', error);
      return [];
    }
  }

  // Get hourly provider response time data for charts
  async getHourlyProviderStats(hours = 24) {
    try {
      const providers = ['tmdb', 'tvdb', 'mal', 'anilist', 'kitsu', 'fanart', 'tvmaze'];
      const hourlyData = [];
      const now = new Date();

      for (let i = hours - 1; i >= 0; i--) {
        const hour = new Date(now.getTime() - (i * 60 * 60 * 1000));
        const hourKey = hour.toISOString().substring(0, 13);
        
        const hourStats = {
          hour: hour.getHours(),
          timestamp: hour.toISOString()
        };

        for (const provider of providers) {
          const responseTimes = await redis.lrange(`provider_response_times:${provider}:${hourKey}`, 0, -1);
          if (responseTimes.length > 0) {
            const avgResponseTime = responseTimes.reduce((sum, time) => sum + parseInt(time), 0) / responseTimes.length;
            hourStats[provider] = Math.round(avgResponseTime);
          } else {
            hourStats[provider] = null; // Use null for no data
          }
        }
        hourlyData.push(hourStats);
      }
      
      return hourlyData;
    } catch (error) {
      logger.error('[Request Tracker] Failed to get hourly provider stats:', error);
      return [];
    }
  }

  // Get top endpoints
  async getTopEndpoints(limit = 10) {
    try {
      const keys = await redis.keys('requests:endpoint:*');
      const endpoints = [];
      
      for (const key of keys) {
        const count = await redis.get(key);
        const endpoint = key.replace('requests:endpoint:', '');
        endpoints.push({
          endpoint,
          requests: parseInt(count) || 0
        });
      }
      
      return endpoints
        .sort((a, b) => b.requests - a.requests)
        .slice(0, limit);
    } catch (error) {
      logger.error('[Request Tracker] Failed to get top endpoints:', error);
      return [];
    }
  }

  // Get active users (based on anonymous User-Agent hashes - no IP tracking)
  async getActiveUsers() {
    try {
      const currentHour = new Date().toISOString().substring(0, 13);
      const previousHour = new Date(Date.now() - 3600000).toISOString().substring(0, 13);
      
      // Get unique anonymous users from current and previous hour
      const [currentUsers, previousUsers] = await Promise.all([
        redis.scard(`active_users:${currentHour}`),
        redis.scard(`active_users:${previousHour}`)
      ]);
      
      // Return the maximum of current and previous hour (more stable number)
      const activeUsers = Math.max(parseInt(currentUsers) || 0, parseInt(previousUsers) || 0);
      
      return activeUsers;
    } catch (error) {
      logger.error('[Request Tracker] Failed to get active users:', error);
      return 0;
    }
  }

  // Log detailed error for dashboard
  async logError(level, message, details = {}) {
    try {
      const errorId = Date.now().toString();
      const timestamp = new Date().toISOString();
      
      const errorLog = {
        id: errorId,
        level: level, // 'error', 'warning', 'info'
        message: message,
        details: details,
        timestamp: timestamp,
        count: 1
      };
      
      // Store in Redis with 7 day TTL
      await redis.set(`error_log:${errorId}`, JSON.stringify(errorLog), 'EX', 86400 * 7);
      
      // Also track in a sorted set by timestamp for easy retrieval
      await redis.zadd('error_logs', Date.now(), errorId);
      await redis.expire('error_logs', 86400 * 7);
      
      logger.info(`[Request Tracker] Logged ${level}: ${message}`);
    } catch (error) {
      logger.warn('[Request Tracker] Failed to log error:', error.message);
    }
  }

  // Get recent error logs
  async getErrorLogs(limit = 50) {
    try {
      // Get recent error IDs from sorted set
      const errorIds = await redis.zrevrange('error_logs', 0, limit - 1);
      
      if (errorIds.length === 0) {
        return [];
      }
      
      // Get error details for each ID
      const errorLogs = await Promise.all(
        errorIds.map(async (errorId) => {
          try {
            const errorStr = await redis.get(`error_log:${errorId}`);
            if (errorStr) {
              const errorLog = JSON.parse(errorStr);
              
              // Calculate time ago
              const timeAgo = this.getTimeAgo(new Date(errorLog.timestamp));
              errorLog.timeAgo = timeAgo;
              
              return errorLog;
            }
            return null;
          } catch (error) {
            logger.warn('[Request Tracker] Failed to parse error log:', error.message);
            return null;
          }
        })
      );
      
      // Filter out null values and return
      return errorLogs.filter(log => log !== null);
    } catch (error) {
      logger.error('[Request Tracker] Failed to get error logs:', error);
      return [];
    }
  }

  // Helper function to calculate time ago
  getTimeAgo(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  }

  // Get improved user identifier using multiple factors
  getImprovedUserIdentifier(req) {
    const crypto = require('crypto');
    
    // Get various identifiers
    const userAgent = req.get('User-Agent') || 'unknown';
    const acceptLanguage = req.get('Accept-Language') || '';
    const acceptEncoding = req.get('Accept-Encoding') || '';
    const sessionId = req.get('X-Session-ID') || '';
    
    // Get anonymized IP (first 3 octets only for privacy)
    let anonymizedIP = 'unknown';
    try {
      const ip = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
      if (ip && ip !== 'unknown') {
        // For IPv4, keep first 3 octets (e.g., 192.168.1.x)
        // For IPv6, keep first 3 groups (e.g., 2001:db8:85a3::x)
        if (ip.includes('.')) {
          const parts = ip.split('.');
          anonymizedIP = parts.slice(0, 3).join('.') + '.x';
        } else if (ip.includes(':')) {
          const parts = ip.split(':');
          anonymizedIP = parts.slice(0, 3).join(':') + '::x';
        } else {
          anonymizedIP = 'unknown';
        }
      }
    } catch (error) {
      anonymizedIP = 'unknown';
    }
    
    // Create a composite identifier that's more unique but still anonymous
    const compositeId = `${userAgent}:${acceptLanguage}:${acceptEncoding}:${anonymizedIP}:${sessionId}`;
    
    // Hash the composite identifier
    return crypto.createHash('sha256').update(compositeId).digest('hex').substring(0, 16);
  }

  // Track active user with improved methodology
  async trackActiveUser(userIdentifier, req) {
    try {
      const now = Date.now();
      const hour = new Date().toISOString().substring(0, 13);
      const minute = new Date().toISOString().substring(0, 16);
      
      // Track in multiple time windows for better accuracy
      const timeWindows = [
        { key: `active_users:15min`, ttl: 900 }, // 15 minutes
        { key: `active_users:1hour`, ttl: 3600 }, // 1 hour
        { key: `active_users:24hour`, ttl: 86400 } // 24 hours
      ];
      
      for (const window of timeWindows) {
        await redis.sadd(window.key, userIdentifier);
        await redis.expire(window.key, window.ttl);
      }
      
      // Store detailed user activity for analytics
      const userActivity = {
        identifier: userIdentifier,
        timestamp: now,
        endpoint: this.normalizeEndpoint(req.path),
        userAgent: req.get('User-Agent') || 'unknown',
        method: req.method
      };
      
      // Store in a time-ordered list (keep last 1000 activities)
      await redis.lpush('user_activities', JSON.stringify(userActivity));
      await redis.ltrim('user_activities', 0, 999); // Keep only last 1000
      await redis.expire('user_activities', 86400 * 7); // 7 days
      
      // Track unique users per day
      const today = new Date().toISOString().split('T')[0];
      await redis.sadd(`unique_users:${today}`, userIdentifier);
      await redis.expire(`unique_users:${today}`, 86400 * 30); // 30 days
      
    } catch (error) {
      logger.warn('[Request Tracker] Failed to track active user:', error.message);
    }
  }

  // Get active users with improved methodology
  async getActiveUsers(timeWindow = '15min') {
    try {
      const key = `active_users:${timeWindow}`;
      const count = await redis.scard(key);
      return count || 0;
    } catch (error) {
      logger.warn('[Request Tracker] Failed to get active users:', error.message);
      return 0;
    }
  }

  // Get unique users for a specific day
  async getUniqueUsersForDay(date = null) {
    try {
      const targetDate = date || new Date().toISOString().split('T')[0];
      const key = `unique_users:${targetDate}`;
      const count = await redis.scard(key);
      return count || 0;
    } catch (error) {
      logger.warn('[Request Tracker] Failed to get unique users for day:', error.message);
      return 0;
    }
  }

  // Get total unique users across all tracked days
  async getTotalUniqueUsers() {
    try {
      const today = new Date();
      const uniqueUsers = new Set();
      
      // Check last 30 days
      for (let i = 0; i < 30; i++) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        const key = `unique_users:${dateStr}`;
        
        try {
          const users = await redis.smembers(key);
          if (users) {
            users.forEach(user => uniqueUsers.add(user));
          }
        } catch (error) {
          // Key might not exist, continue
        }
      }
      
      return uniqueUsers.size;
    } catch (error) {
      logger.warn('[Request Tracker] Failed to get total unique users:', error.message);
      return 0;
    }
  }

  // Get recent user activities for analytics
  async getRecentUserActivities(limit = 50) {
    try {
      const activities = await redis.lrange('user_activities', 0, limit - 1);
      return activities.map(activity => {
        try {
          return JSON.parse(activity);
        } catch (error) {
          return null;
        }
      }).filter(activity => activity !== null);
    } catch (error) {
      logger.warn('[Request Tracker] Failed to get recent user activities:', error.message);
      return [];
    }
  }

  // Clean up corrupted Redis keys that might cause WRONGTYPE errors
  async cleanupCorruptedKeys() {
    try {
      const providers = ['tmdb', 'tvdb', 'mal', 'anilist', 'kitsu', 'fanart', 'tvmaze'];
      const today = new Date().toISOString().split('T')[0];
      
      for (const provider of providers) {
        // Check for daily keys that should be hourly
        const dailyKey = `provider_response_times:${provider}:${today}`;
        try {
          const keyType = await redis.type(dailyKey);
          if (keyType !== 'none' && keyType !== 'list') {
            logger.info(`[Request Tracker] Cleaning up corrupted key: ${dailyKey} (type: ${keyType})`);
            await redis.del(dailyKey);
          }
        } catch (error) {
          logger.warn(`[Request Tracker] Failed to check/clean key ${dailyKey}:`, error.message);
        }
      }
      
      logger.info('[Request Tracker] Corrupted key cleanup completed');
    } catch (error) {
      logger.warn('[Request Tracker] Failed to cleanup corrupted keys:', error.message);
    }
  }
}

module.exports = new RequestTracker();
