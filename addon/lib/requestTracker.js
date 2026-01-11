const redis = require("./redisClient");
const consola = require("consola");
const { isMetricsDisabled } = require('./metricsConfig');

const logger = consola.withTag("Request-Tracker");

class RequestTracker {
  constructor() {
    this.startTime = Date.now();
    this.dailyKey = `requests:${new Date().toISOString().split("T")[0]}`;
    this.hourlyKey = `requests:${new Date().toISOString().substring(0, 13)}`;
    this.errorKey = `errors:${new Date().toISOString().split("T")[0]}`;

    // Clean up any corrupted keys on startup
    this.cleanupCorruptedKeys().catch((error) => {
      logger.warn(
        "[Request Tracker] Failed to cleanup on startup:",
        error.message,
      );
    });
  }

  // Middleware to track all requests
  middleware() {
    const tracker = this; // Capture the tracker instance

    return async (req, res, next) => {
      const start = process.hrtime();
      let responseTracked = false;

      // Track request start
      tracker.trackRequest(req);

      // Helper to track response once
      const trackOnce = function () {
        if (!responseTracked) {
          responseTracked = true;
          const [seconds, nanoseconds] = process.hrtime(start);
          const responseTime = (seconds * 1000) + (nanoseconds / 1e6);
          tracker.trackResponse(req, res, responseTime).catch(err => {
            logger.warn('[Request Tracker] Failed to track response:', err.message);
          });
        }
      };

      // Primary tracking via finish event (most reliable)
      res.on("finish", trackOnce);

      // Keep minimal patching as safety net for edge cases
      const originalSend = res.send;
      res.send = function (data) {
        trackOnce();
        return originalSend.call(this, data);
      };

      next();
    };
  }

  shouldTrackRequest(req) {
    const path = req.path;

    // --- Ignore common static file extensions ---
    const staticFileExtensions =
      /\.(js|css|ico|png|svg|jpg|jpeg|webp|webmanifest|map)$/;
    if (staticFileExtensions.test(path)) {
      return false; // Do not track static file requests
    }

    // --- Existing filter for API and page routes ---
    const internalPaths = [
      "/api/dashboard",
      "/api/admin",
      "/dashboard",
      "/api/config",
      "/api/test-keys",
      "/health",
      "/favicon.ico",
      "/background.png",
      "/logo.png",
    ];

    return !internalPaths.some((prefix) => path.startsWith(prefix));
  }

  // Track incoming request
  async trackRequest(req) {
    // Skip metrics collection if disabled
    if (isMetricsDisabled()) {
      return;
    }
    try {
      const today = new Date().toISOString().split("T")[0];
      const hour = new Date().toISOString().substring(0, 13);

      // Get improved anonymous user identifier
      const userIdentifier = this.getImprovedUserIdentifier(req);

      // Track content requests (meta requests)
      this.trackContentRequest(req);

      // Only increment counters for actual user-facing requests
      if (this.shouldTrackRequest(req)) {
        redis.incr(`requests:total`).catch(() => {});
        redis.incr(`requests:${today}`).catch(() => {});
        redis.incr(`requests:${hour}`).catch(() => {});
      }

      // Track active users only for user-facing requests (fire-and-forget)
      if (this.shouldTrackRequest(req)) {
        this.trackActiveUser(userIdentifier, req).catch(() => {});
      }

      // Set expiration for time-based keys (don't await)
      redis.expire(`requests:${today}`, 86400 * 30).catch(() => {}); // 30 days
      redis.expire(`requests:${hour}`, 86400 * 7).catch(() => {}); // 7 days

      // Track metadata requests for activity feed
      const normalizedPath = this.normalizeEndpoint(req.path);
      if (
        normalizedPath.includes("/meta/") ||
        normalizedPath.includes("/catalog/")
      ) {
        const activityDetails = {
          endpoint: normalizedPath,
          userAgent: this.hashString(req.headers["user-agent"] || "unknown"),
          method: req.method,
        };

        if (normalizedPath.includes("/meta/")) {
          this.trackActivity("metadata_request", activityDetails);
        } else if (normalizedPath.includes("/catalog/")) {
          this.trackActivity("catalog_request", activityDetails);
        }
      }
    } catch (error) {
      logger.warn("[Request Tracker] Failed to track request:", error.message);
    }
  }

  // Track response
  async trackResponse(req, res, responseTime) {
    // Skip metrics collection if disabled
    if (isMetricsDisabled()) {
      return;
    }
    try {
      const today = new Date().toISOString().split("T")[0];
      const endpoint = this.normalizeEndpoint(req.path);
      const statusCode = res.statusCode;
      const shouldTrack = this.shouldTrackRequest(req);

      // Only track metrics for user-facing requests
      if (shouldTrack) {
        // Track response times by hour for charts
        const hour = new Date().toISOString().substring(0, 13);
        redis.lpush(`response_times:${hour}`, responseTime).catch(() => {});
        redis.ltrim(`response_times:${hour}`, 0, 999).catch(() => {}); // Keep last 1000 for hourly averages
        redis.expire(`response_times:${hour}`, 86400 * 7).catch(() => {}); // 7 days expiration

        // Track errors
        if (statusCode >= 400) {
          redis.incr(`errors:total`).catch(() => {});
          redis.incr(`errors:${today}`).catch(() => {});
        } else {
          redis.incr(`success:${today}`).catch(() => {});
        }
      }

      redis.expire(`success:${today}`, 86400 * 30).catch(() => {});

      // Track catalog/search success
      if (req.path.includes("/catalog/")) {
        let rawSearch = "";
        // Query param
        if (req.query && req.query.search) {
          rawSearch = String(req.query.search);
        }
        // Path extras
        if (!rawSearch) {
          try {
            const extrasMatch = req.path.match(
              /\/catalog\/[^/]+\/[^/]+\/(.*)\.(json|xml)$/i,
            );
            if (extrasMatch && extrasMatch[1]) {
              const extrasPart = extrasMatch[1];
              const segments = extrasPart.split("/");
              for (const segment of segments) {
                if (segment.toLowerCase().startsWith("search=")) {
                  const val = segment.substring("search=".length);
                  rawSearch = decodeURIComponent(val);
                  break;
                }
              }
            }
          } catch (_) {}
        }
        const queryNorm = rawSearch.toLowerCase().trim();
        
        if (queryNorm) {
          // Determine type for optional per-type success storage
          let catalogType = "all";
          try {
            const catalogMatch = req.path.match(/\/catalog\/([^/]+)/);
            if (catalogMatch && catalogMatch[1])
              catalogType = catalogMatch[1].toLowerCase();
          } catch (_) {}

          const resultsCount = res.locals?.resultCount ?? 0;

          // Track search success if results were found
          if (resultsCount > 0) {
            redis
              .zincrby(`search_success:${today}`, 1, queryNorm)
              .catch(() => {});
            redis.expire(`search_success:${today}`, 86400 * 30).catch(() => {});
          }
        }
      }
    } catch (error) {
      logger.warn("[Request Tracker] Failed to track response:", error.message);
    }
  }

  // Normalize endpoint for tracking (remove IDs, etc.)
  normalizeEndpoint(path) {
    return path
      .replace(/\/[a-f0-9-]{36}/g, "/:uuid") // UUIDs (must come before ObjectId regex)
      .replace(/\/[a-f0-9]{24}/g, "/:id") // MongoDB ObjectIds
      .replace(/\/\d+/g, "/:id") // Numeric IDs
      .replace(/\/[a-zA-Z0-9_-]{8,}/g, "/:param") // Long params
      .toLowerCase();
  }

  // Simple hash function for user-agent
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  }

  // Track content requests (meta, search, catalog)
  async trackContentRequest(req) {
    // Skip metrics collection if disabled
    if (isMetricsDisabled()) {
      return;
    }
    try {
      const path = req.path;
      const today = new Date().toISOString().split("T")[0];

      // Track meta requests
      if (path.includes("/meta/")) {
        const metaMatch = path.match(/\/meta\/([^\/]+)\/([^\/]+)/);
        if (metaMatch) {
          let [, type, id] = metaMatch;

          // Store the original ID for tracking (with URL encoding)
          const originalId = id;

          // Also store a cleaned version for metadata lookup
          const cleanId = decodeURIComponent(id).replace(/\.(json|xml)$/i, "");

          const contentKey = `${type}:${originalId}`;
          const cleanContentKey = `${type}:${cleanId}`;

          // Track popular content
          redis
            .zincrby(`popular_content:${today}`, 1, contentKey)
            .catch(() => {});
          redis.expire(`popular_content:${today}`, 86400 * 30).catch(() => {}); // 30 days
        }
      }

      // Track search requests
      if (path.includes("/catalog/")) {
        let rawSearch = "";

        // Case 1: standard query parameter (e.g., ?search=foo)
        if (req.query && req.query.search) {
          rawSearch = String(req.query.search);
        }

        // Case 2: Stremio-style extras in the path: /catalog/{type}/{id}/.../search={query}.json
        // Example: /catalog/movie/mdblist.12345/genre=action/search=star%20wars.json
        if (!rawSearch) {
          try {
            const extrasMatch = path.match(
              /\/catalog\/[^/]+\/[^/]+\/(.*)\.(json|xml)$/i,
            );
            if (extrasMatch && extrasMatch[1]) {
              const extrasPart = extrasMatch[1];
              const segments = extrasPart.split("/");
              for (const segment of segments) {
                if (segment.toLowerCase().startsWith("search=")) {
                  const val = segment.substring("search=".length);
                  rawSearch = decodeURIComponent(val);
                  break;
                }
              }
            }
          } catch (_) {
            // ignore parsing errors; fall through
          }
        }

        const searchQuery = rawSearch.toLowerCase().trim();
        if (searchQuery) {
          // Determine catalog type (movie/series/anime/etc.) if present
          let catalogType = "all";
          try {
            const catalogMatch = path.match(/\/catalog\/([^/]+)/);
            if (catalogMatch && catalogMatch[1]) {
              catalogType = catalogMatch[1].toLowerCase();
            }
          } catch (_) {}

          // Debounce per user + query for a short window to avoid overcounting
          const userHash = this.getImprovedUserIdentifier(req);
          const dedupeKey = `search_dedupe:${today}:${userHash}:${catalogType}:${searchQuery}`;
          
          redis.set(dedupeKey, "1", "NX", "EX", 3)
            .then(setResult => {
              if (setResult) {
                // Increment global aggregate
                Promise.all([
                  redis.zincrby(`search_patterns:${today}`, 1, searchQuery),
                  redis.expire(`search_patterns:${today}`, 86400 * 30),
                ]).catch(() => {});
              }
            })
            .catch(() => {
              // On Redis error, fall back to naive increment
              Promise.all([
                redis.zincrby(`search_patterns:${today}`, 1, searchQuery),
                redis.expire(`search_patterns:${today}`, 86400 * 30)
              ]).catch(() => {});
            });
        }
      }
    } catch (error) {
      logger.warn(
        "[Request Tracker] Failed to track content request:",
        error.message,
      );
    }
  }

  // Get popular content
  async getPopularContent(limit = 10) {
    try {
      const today = new Date().toISOString().split("T")[0];
      const yesterday = new Date(Date.now() - 86400000)
        .toISOString()
        .split("T")[0];

      // Get popular content from both days
      const [todayContent, yesterdayContent] = await Promise.all([
        redis.zrevrange(`popular_content:${today}`, 0, limit - 1, "WITHSCORES"),
        redis.zrevrange(
          `popular_content:${yesterday}`,
          0,
          limit - 1,
          "WITHSCORES",
        ),
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
          const [type, id] = contentKey.split(":");
          return { contentKey, type, id, requests };
        })
        .sort((a, b) => b.requests - a.requests)
        .slice(0, limit);

      // Enrich with cached metadata
      const popularContent = await Promise.all(
        contentEntries.map(async ({ contentKey, type, id, requests }) => {
          try {
            // Try to get real metadata from cache with multiple key variants
            const tryKeys = [];
            // exact member key (often includes .json or provider prefix)
            tryKeys.push(`content_metadata:${contentKey}`);
            // decoded variant without extension
            const parts = contentKey.split(":");
            const keyType = parts[0];
            const rawId = parts.slice(1).join(":");
            const decoded = decodeURIComponent(rawId || "");
            const cleanId = decoded.replace(/\.(json|xml)$/i, "");
            tryKeys.push(`content_metadata:${keyType}:${cleanId}`);
            // encoded + .json variant from captureMetadataFromComponents
            const encodedJson = encodeURIComponent(cleanId) + ".json";
            tryKeys.push(`content_metadata:${keyType}:${encodedJson}`);
            // provider variants (tmdb:123 etc.) if present in original
            if (cleanId.includes(":")) {
              tryKeys.push(`content_metadata:${keyType}:${cleanId}`);
              const providerEncoded = encodeURIComponent(cleanId) + ".json";
              tryKeys.push(`content_metadata:${keyType}:${providerEncoded}`);
            }

            let metadataStr = null;
            for (const k of tryKeys) {
              try {
                metadataStr = await redis.get(k);
                if (metadataStr) break;
              } catch (_) {}
            }

            if (metadataStr) {
              const metadata = JSON.parse(metadataStr);
              return {
                id,
                type: metadata.type || type,
                requests,
                title: metadata.title,
                rating: metadata.rating,
                year: metadata.year,
                // poster: metadata.poster, // Not used in dashboard UI
                imdb_id: metadata.imdb_id,
              };
            }
          } catch (error) {
            logger.warn(
              "[Request Tracker] Failed to load metadata for",
              contentKey,
              error.message,
            );
          }

          // Fallback to formatted title
          //logger.info(`[Request Tracker] Using fallback title for ${contentKey}: "${this.formatContentTitle(id, type)}"`);
          return {
            id,
            type,
            requests,
            title: this.formatContentTitle(id, type),
            rating: null,
            year: null,
          };
        }),
      );

      return popularContent;
    } catch (error) {
      logger.error("[Request Tracker] Failed to get popular content:", error);
      return [];
    }
  }

  // Get search patterns
  async getSearchPatterns(limit = 10) {
    try {
      const today = new Date().toISOString().split("T")[0];
      const yesterday = new Date(Date.now() - 86400000)
        .toISOString()
        .split("T")[0];

      // Get attempts and successes from both days
      const [
        todaySearches,
        yesterdaySearches,
        todaySuccesses,
        yesterdaySuccesses,
      ] = await Promise.all([
        redis.zrevrange(`search_patterns:${today}`, 0, limit - 1, "WITHSCORES"),
        redis.zrevrange(
          `search_patterns:${yesterday}`,
          0,
          limit - 1,
          "WITHSCORES",
        ),
        redis.zrevrange(`search_success:${today}`, 0, -1, "WITHSCORES"),
        redis.zrevrange(`search_success:${yesterday}`, 0, -1, "WITHSCORES"),
      ]);

      // Combine and format results
      const searchMap = new Map();
      const successMap = new Map();

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

      // Process successes
      for (let i = 0; i < todaySuccesses.length; i += 2) {
        const query = todaySuccesses[i];
        const count = parseInt(todaySuccesses[i + 1]) || 0;
        successMap.set(query, (successMap.get(query) || 0) + count);
      }
      for (let i = 0; i < yesterdaySuccesses.length; i += 2) {
        const query = yesterdaySuccesses[i];
        const count = parseInt(yesterdaySuccesses[i + 1]) || 0;
        successMap.set(query, (successMap.get(query) || 0) + count);
      }

      // Convert to array and sort
      const searchPatterns = Array.from(searchMap.entries())
        .map(([query, count]) => ({
          query,
          count,
          success:
            count > 0
              ? Math.max(
                  0,
                  Math.min(
                    100,
                    Math.round(((successMap.get(query) || 0) / count) * 100),
                  ),
                )
              : 0,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);

      return searchPatterns;
    } catch (error) {
      logger.error("[Request Tracker] Failed to get search patterns:", error);
      return [];
    }
  }

  // Capture metadata from cache key (for cache hits)
  async captureMetadataFromCacheKey(cacheKey, meta) {
    // Skip metrics collection if disabled
    if (isMetricsDisabled()) {
      return;
    }
    try {
      if (!meta || !meta.name) return;

      // Extract metaId from cache key format: meta:configHash:metaId
      const keyMatch = cacheKey.match(/^meta:([a-f0-9]{10}):(.+)$/);
      if (!keyMatch) return;
      
      const metaId = keyMatch[2];
      logger.info(
        `[Request Tracker] Capturing metadata from cache key for ${metaId}: "${meta.name}"`,
      );

      // Use the existing capture method
      await this.captureMetadataFromComponents(metaId, meta, meta.type);
    } catch (error) {
      logger.warn(
        "[Request Tracker] Failed to capture metadata from cache key:",
        error.message,
      );
    }
  }

  // Capture metadata from complete meta components (better approach!)
  // NOTE: This function intentionally runs even when DISABLE_METRICS=true because it stores
  // content_metadata for the rating page functionality, not just telemetry/analytics metrics.
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
      const metaIdParts = metaId.split(":");
      const prefix = metaIdParts[0];
      const id = metaIdParts.length > 1 ? metaIdParts[1] : metaIdParts[0]; // Use full metaId if no colon
      const type = meta.type || metaType || "unknown";

      // Determine the provider from the meta object or metaId
      let provider = prefix;
      if (metaIdParts.length === 1) {
        // If metaId is just an ID, try to determine provider from meta object
        if (meta.imdb_id && metaId.startsWith("tt")) {
          provider = "imdb";
        } else if (metaId.match(/^\d+$/)) {
          // Numeric ID, could be TMDB or TVDB
          if (type === "movie") {
            provider = "tmdb";
          } else if (type === "series") {
            provider = "tvdb";
          } else {
            provider = "tmdb"; // Default
          }
        }
      }

      // Create content key in the format that tracking uses
      // Also create URL-encoded version to match how requests are tracked
      const contentKey = `${type}:${id}`;
      const encodedId = encodeURIComponent(metaId) + ".json";
      const encodedContentKey = `${type}:${encodedId}`;

      // Also create the provider:ID format for better matching
      const providerId = metaIdParts.length > 1 ? metaId : `${provider}:${id}`;
      const providerContentKey = `${type}:${providerId}`;
      const providerEncodedId = encodeURIComponent(providerId) + ".json";
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
        cached_at: new Date().toISOString(),
      };

      logger.debug(
        `[Request Tracker] Storing metadata for ${contentKey}, ${encodedContentKey}, ${providerContentKey}, and ${providerEncodedContentKey}: "${metadataInfo.title}" ⭐${metadataInfo.rating}`,
      );

      // Store in Redis with 30 day TTL for all formats
      redis
        .set(
          `content_metadata:${contentKey}`,
          JSON.stringify(metadataInfo),
          "EX",
          86400 * 30,
        )
        .catch(() => {});
      redis
        .set(
          `content_metadata:${encodedContentKey}`,
          JSON.stringify(metadataInfo),
          "EX",
          86400 * 30,
        )
        .catch(() => {});
      redis
        .set(
          `content_metadata:${providerContentKey}`,
          JSON.stringify(metadataInfo),
          "EX",
          86400 * 30,
        )
        .catch(() => {});
      redis
        .set(
          `content_metadata:${providerEncodedContentKey}`,
          JSON.stringify(metadataInfo),
          "EX",
          86400 * 30,
        )
        .catch(() => {});
    } catch (error) {
      logger.warn(
        "[Request Tracker] Failed to capture metadata from components:",
        error.message,
      );
    }
  }

  // Capture metadata when content is cached (legacy approach)
  async captureMetadata(cacheKey, result) {
    // Skip metrics collection if disabled
    if (isMetricsDisabled()) {
      return;
    }
    try {
      const meta = result?.meta || result;
      if (!meta || !meta.name) return;

      // Extract content info from cache key format: meta:configHash:id
      const keyMatch = cacheKey.match(/^meta:([a-f0-9]{10}):(.+)$/);
      if (!keyMatch) {
        logger.info(
          `[Request Tracker] Cache key doesn't match expected format: ${cacheKey}`,
        );
        return;
      }

      const id = keyMatch[2];

      // Try to extract type from meta object or guess from ID
      let type = meta.type;
      if (!type) {
        // Try to determine type from ID patterns
        if (id.includes("movie") || id.includes("tmdb")) {
          type = "movie";
        } else if (id.includes("series") || id.includes("tvdb")) {
          type = "series";
        } else if (id.includes("anime")) {
          type = "anime";
        } else {
          type = "unknown";
        }
      }

      // Create both original and URL-encoded versions of the content key
      const cleanId = decodeURIComponent(id).replace(/\.(json|xml)$/i, "");
      const encodedId = encodeURIComponent(cleanId) + ".json";

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
        cached_at: new Date().toISOString(),
      };

      logger.info(
        `[Request Tracker] Capturing metadata for ${cleanContentKey} and ${encodedContentKey}: "${metadataInfo.title}"`,
      );

      // Store in Redis with 30 day TTL for both formats
      redis
        .set(
          `content_metadata:${cleanContentKey}`,
          JSON.stringify(metadataInfo),
          "EX",
          86400 * 30,
        )
        .catch(() => {});
      redis
        .set(
          `content_metadata:${encodedContentKey}`,
          JSON.stringify(metadataInfo),
          "EX",
          86400 * 30,
        )
        .catch(() => {});
    } catch (error) {
      logger.warn(
        "[Request Tracker] Failed to capture metadata:",
        error.message,
      );
    }
  }

  // Format content title from ID
  formatContentTitle(id, type) {
    try {
      // Handle URL-encoded IDs
      let decodedId = decodeURIComponent(id);

      // Remove file extensions
      decodedId = decodedId.replace(/\.(json|xml)$/i, "");

      // Handle TMDB format: "tmdb:123456" or "Tmdb%3A123456"
      if (decodedId.match(/^tmdb[:%]?\d+$/i)) {
        const tmdbId = decodedId.replace(/^tmdb[:%]?/i, "");
        return `TMDB Movie ${tmdbId}`;
      }

      // Handle IMDB format: "tt1234567"
      if (decodedId.match(/^tt\d+$/)) {
        return `IMDB ${decodedId}`;
      }

      // Handle other provider formats
      if (decodedId.includes(":")) {
        const [provider, itemId] = decodedId.split(":");
        return `${provider.toUpperCase()} ${itemId}`;
      }

      // Basic cleanup for other IDs
      return decodedId
        .replace(/[_-]/g, " ")
        .replace(/\b\w/g, (l) => l.toUpperCase())
        .trim();
    } catch (error) {
      // Fallback to original ID if formatting fails
      return id;
    }
  }

  // Track cache hit/miss
  async trackCacheHit() {
    // Skip metrics collection if disabled
    if (isMetricsDisabled()) {
      return;
    }
    try {
      const today = new Date().toISOString().split("T")[0];
      redis.incr(`cache:hits:${today}`).catch(() => {});
      redis.expire(`cache:hits:${today}`, 86400 * 30).catch(() => {});
    } catch (error) {
      logger.warn(
        "[Request Tracker] Failed to track cache hit:",
        error.message,
      );
    }
  }

  async trackCacheMiss() {
    // Skip metrics collection if disabled
    if (isMetricsDisabled()) {
      return;
    }
    try {
      const today = new Date().toISOString().split("T")[0];
      redis.incr(`cache:misses:${today}`).catch(() => {});
      redis.expire(`cache:misses:${today}`, 86400 * 30).catch(() => {});
    } catch (error) {
      logger.warn(
        "[Request Tracker] Failed to track cache miss:",
        error.message,
      );
    }
  }

  // Track provider API calls
  async trackProviderCall(
    provider,
    responseTime,
    success = true,
    rateLimitHeaders = null,
  ) {
    // Skip metrics collection if disabled
    if (isMetricsDisabled()) {
      return;
    }
    try {
      const today = new Date().toISOString().split("T")[0];
      const hour = new Date().toISOString().substring(0, 13);

      // Track response times hourly
      redis
        .lpush(`provider_response_times:${provider}:${hour}`, responseTime)
        .catch(() => {});
      redis
        .ltrim(`provider_response_times:${provider}:${hour}`, 0, 999)
        .catch(() => {});
      redis
        .expire(`provider_response_times:${provider}:${hour}`, 3600 * 48)
        .catch(() => {}); // 48 hours

      // Track success/error rates
      if (success) {
        redis.incr(`provider_success:${provider}:${today}`).catch(() => {});
      } else {
        redis.incr(`provider_errors:${provider}:${today}`).catch(() => {});
      }
      redis
        .expire(`provider_success:${provider}:${today}`, 86400 * 2)
        .catch(() => {}); // 2 days
      redis
        .expire(`provider_errors:${provider}:${today}`, 86400 * 2)
        .catch(() => {}); // 2 days

      // Track hourly calls for rate limiting awareness
      redis.incr(`provider_calls:${provider}:${hour}`).catch(() => {});
      redis
        .expire(`provider_calls:${provider}:${hour}`, 3600 * 24)
        .catch(() => {}); // 24 hours

      // Store real rate limit data if available
      if (rateLimitHeaders) {
        const rateLimitData = {
          limit: rateLimitHeaders.limit,
          remaining: rateLimitHeaders.remaining,
          reset: rateLimitHeaders.reset,
          timestamp: Date.now(),
        };

        redis
          .setex(
            `provider_rate_limit:${provider}`,
            3600,
            JSON.stringify(rateLimitData),
          )
          .catch(() => {});
      }
    } catch (error) {
      logger.warn(
        "[Request Tracker] Failed to track provider call:",
        error.message,
      );
    }
  }

  /**
   * Log a provider error to the dashboard error management system.
   * Use this for significant errors that admins should be aware of.
   * 
   * @param {string} provider - Provider name (e.g., 'tmdb', 'tvdb', 'anilist', 'mal', 'kitsu')
   * @param {string} errorType - Type of error: 'rate_limit', 'timeout', 'server_error', 'auth_error', 'api_error'
   * @param {string} message - Human-readable error message
   * @param {Object} details - Additional context (endpoint, status, responseTime, etc.)
   */
  logProviderError(provider, errorType, message, details = {}) {
    // Skip if metrics collection is disabled
    if (isMetricsDisabled()) {
      return;
    }

    // Determine log level based on error type
    let level = 'error';
    if (errorType === 'rate_limit' || errorType === 'timeout') {
      level = 'warning';
    }

    // Add provider to details for filtering
    const enrichedDetails = {
      provider,
      errorType,
      ...details,
    };

    // Log to dashboard error system
    this.logError(level, `[${provider.toUpperCase()}] ${message}`, enrichedDetails);
  }

  // Get provider performance statistics
  async getProviderPerformance() {
    try {
      const today = new Date().toISOString().split("T")[0];
      const yesterday = new Date(Date.now() - 86400000)
        .toISOString()
        .split("T")[0];
      const providers = [
        "tmdb",
        "tvdb",
        "mal",
        "anilist",
        "kitsu",
        "fanart",
        "tvmaze",
      ];

      const providerStats = await Promise.all(
        providers.map(async (provider) => {
          try {
            // Get response times for the last 24 hours (multiple hourly buckets)
            const now = new Date();
            const hours = [];
            for (let i = 0; i < 24; i++) {
              const hour = new Date(now.getTime() - i * 3600000)
                .toISOString()
                .substring(0, 13);
              hours.push(hour);
            }

            // Get response times from all hourly buckets
            const timePromises = hours.map(async (hour) => {
              try {
                return await redis.lrange(
                  `provider_response_times:${provider}:${hour}`,
                  0,
                  -1,
                );
              } catch (error) {
                // Handle WRONGTYPE errors gracefully
                if (error.message.includes("WRONGTYPE")) {
                  logger.warn(
                    `[Request Tracker] Wrong data type for ${provider}:${hour}, skipping`,
                  );
                  return [];
                }
                throw error;
              }
            });
            const timeResults = await Promise.all(timePromises);

            // Flatten all response times
            const allTimes = timeResults
              .flat()
              .map((t) => parseFloat(t))
              .filter((t) => !isNaN(t));
            const avgResponseTime =
              allTimes.length > 0
                ? Math.round(
                    allTimes.reduce((a, b) => a + b, 0) / allTimes.length,
                  )
                : 0;

            // Get success/error rates
            const [
              todaySuccess,
              todayErrors,
              yesterdaySuccess,
              yesterdayErrors,
            ] = await Promise.all([
              redis.get(`provider_success:${provider}:${today}`),
              redis.get(`provider_errors:${provider}:${today}`),
              redis.get(`provider_success:${provider}:${yesterday}`),
              redis.get(`provider_errors:${provider}:${yesterday}`),
            ]);

            const totalSuccess =
              (parseInt(todaySuccess) || 0) + (parseInt(yesterdaySuccess) || 0);
            const totalErrors =
              (parseInt(todayErrors) || 0) + (parseInt(yesterdayErrors) || 0);
            const totalCalls = totalSuccess + totalErrors;

            const errorRate =
              totalCalls > 0
                ? parseFloat(((totalErrors / totalCalls) * 100).toFixed(1))
                : 0;

            // Determine status based on error rate and response time
            let status = "healthy";
            if (errorRate > 10 || avgResponseTime > 3000) {
              status = "error";
            } else if (errorRate > 5 || avgResponseTime > 1500) {
              status = "warning";
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
              totalCalls: totalCalls,
            };
          } catch (providerError) {
            logger.warn(
              `[Request Tracker] Failed to get stats for provider ${provider}:`,
              providerError.message,
            );
            return null;
          }
        }),
      );

      // Filter out providers with no data and sort by usage
      return providerStats
        .filter((stat) => stat !== null)
        .sort((a, b) => b.totalCalls - a.totalCalls);
    } catch (error) {
      logger.error(
        "[Request Tracker] Failed to get provider performance:",
        error,
      );
      return [];
    }
  }

  // Track recent activity
  async trackActivity(type, details) {
    // Skip metrics collection if disabled
    if (isMetricsDisabled()) {
      return;
    }
    try {
      logger.debug(
        `[Request Tracker] Tracking activity: ${type} for ${details.endpoint}`,
      );

      const activity = {
        id: Date.now(),
        type: type,
        details: details,
        timestamp: new Date().toISOString(),
        userAgent: this.hashString(details.userAgent || "unknown"),
      };

      // Store in recent activity list (keep last 100 activities)
      const activityKey = "recent_activity";
      await redis.lpush(activityKey, JSON.stringify(activity));
      await redis.ltrim(activityKey, 0, 99); // Keep only last 100
      await redis.expire(activityKey, 86400 * 7); // 7 days

      logger.debug(`[Request Tracker] Activity stored successfully: ${type}`);
    } catch (error) {
      logger.warn("[Request Tracker] Failed to track activity:", error.message);
    }
  }

  // Get recent activity
  async getRecentActivity(limit = 20) {
    try {
      logger.info("[Request Tracker] Getting recent activity...");

      const activities = await redis.lrange("recent_activity", 0, limit - 1);
      logger.info(
        `[Request Tracker] Found ${activities.length} activities in Redis`,
      );

      const parsedActivities = activities.map((activity) =>
        JSON.parse(activity),
      );
      logger.info(
        `[Request Tracker] Returning ${parsedActivities.length} parsed activities`,
      );

      return parsedActivities;
    } catch (error) {
      logger.warn(
        "[Request Tracker] Failed to get recent activity:",
        error.message,
      );
      return [];
    }
  }

  // Get cache hit rate
  async getCacheHitRate() {
    try {
      const today = new Date().toISOString().split("T")[0];
      const yesterday = new Date(Date.now() - 86400000)
        .toISOString()
        .split("T")[0];

      const [todayHits, todayMisses, yesterdayHits, yesterdayMisses] =
        await Promise.all([
          redis.get(`cache:hits:${today}`),
          redis.get(`cache:misses:${today}`),
          redis.get(`cache:hits:${yesterday}`),
          redis.get(`cache:misses:${yesterday}`),
        ]);

      // Combine today and yesterday for more stable metrics
      const totalHits =
        (parseInt(todayHits) || 0) + (parseInt(yesterdayHits) || 0);
      const totalMisses =
        (parseInt(todayMisses) || 0) + (parseInt(yesterdayMisses) || 0);
      const totalRequests = totalHits + totalMisses;

      if (totalRequests === 0) {
        return 0; // No cache data yet
      }

      return Math.round((totalHits / totalRequests) * 100);
    } catch (error) {
      logger.error("[Request Tracker] Failed to get cache hit rate:", error);
      return 0;
    }
  }

  // Get request statistics
  async getStats() {
    try {
      const today = new Date().toISOString().split("T")[0];
      const yesterday = new Date(Date.now() - 86400000)
        .toISOString()
        .split("T")[0];

      // Add timeout to Redis operations
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Redis timeout")), 5000),
      );

      const [
        totalRequests,
        todayRequests,
        yesterdayRequests,
        totalErrors,
        todayErrors,
        todaySuccess,
      ] = await Promise.race([
        Promise.all([
          redis.get("requests:total"),
          redis.get(`requests:${today}`),
          redis.get(`requests:${yesterday}`),
          redis.get("errors:total"),
          redis.get(`errors:${today}`),
          redis.get(`success:${today}`),
        ]),
        timeout,
      ]);

      const todayReq = parseInt(todayRequests) || 0;
      const todayErr = parseInt(todayErrors) || 0;
      const todaySucc = parseInt(todaySuccess) || 0;

      // Calculate rates based on tracked responses (success + errors)
      // This avoids showing misleading percentages when some requests aren't tracked
      const trackedResponses = todaySucc + todayErr;
      const successRate =
        trackedResponses > 0
          ? parseFloat(((todaySucc / trackedResponses) * 100).toFixed(1))
          : 0;
      const errorRate =
        trackedResponses > 0
          ? parseFloat(((todayErr / trackedResponses) * 100).toFixed(1))
          : 0;

      // Log warning if there's a significant tracking gap
      if (todayReq > 0 && trackedResponses < todayReq * 0.9) {
        logger.warn(
          `[Request Tracker] Tracking gap detected: ${todayReq} requests but only ${trackedResponses} tracked responses (${Math.round((trackedResponses / todayReq) * 100)}% coverage)`,
        );
      }

      const trackingCoverage =
        todayReq > 0
          ? parseFloat(((trackedResponses / todayReq) * 100).toFixed(1))
          : 100;

      return {
        totalRequests: parseInt(totalRequests) || 0,
        todayRequests: todayReq,
        yesterdayRequests: parseInt(yesterdayRequests) || 0,
        totalErrors: parseInt(totalErrors) || 0,
        todayErrors: todayErr,
        todaySuccess: todaySucc,
        trackedResponses: trackedResponses,
        successRate: Math.min(successRate, 100), // Cap at 100%
        errorRate: Math.min(errorRate, 100), // Cap at 100%
        trackingCoverage: trackingCoverage, // % of requests that were tracked
      };
    } catch (error) {
      logger.error("[Request Tracker] Failed to get stats:", error);
      return {
        totalRequests: 0,
        todayRequests: 0,
        yesterdayRequests: 0,
        totalErrors: 0,
        todayErrors: 0,
        todaySuccess: 0,
        trackedResponses: 0,
        successRate: 0,
        errorRate: 0,
        trackingCoverage: 100,
      };
    }
  }

  // Get hourly request data for charts
  async getHourlyStats(hours = 24) {
    try {
      const hourlyData = [];
      const now = new Date();

      for (let i = hours - 1; i >= 0; i--) {
        const hour = new Date(now.getTime() - i * 60 * 60 * 1000);
        const hourKey = hour.toISOString().substring(0, 13);
        const requests = await redis.get(`requests:${hourKey}`);

        // Get average response time for this hour
        const responseTimesKey = `response_times:${hourKey}`;
        const responseTimes = await redis.lrange(responseTimesKey, 0, -1);
        const avgResponseTime =
          responseTimes.length > 0
            ? responseTimes.reduce((sum, time) => sum + parseInt(time), 0) /
              responseTimes.length
            : 0;

        hourlyData.push({
          hour: hour.getHours(),
          requests: parseInt(requests) || 0,
          responseTime: Math.round(avgResponseTime),
          timestamp: hour.toISOString(),
        });
      }

      return hourlyData;
    } catch (error) {
      logger.error("[Request Tracker] Failed to get hourly stats:", error);
      return [];
    }
  }

  // Get hourly provider response time data for charts
  async getHourlyProviderStats(hours = 24) {
    try {
      const providers = [
        "tmdb",
        "tvdb",
        "mal",
        "anilist",
        "kitsu",
        "fanart",
        "tvmaze",
        "trakt",
        "mdblist",
        "letterboxd",
      ];
      const hourlyData = [];
      const now = new Date();

      for (let i = hours - 1; i >= 0; i--) {
        const hour = new Date(now.getTime() - i * 60 * 60 * 1000);
        const hourKey = hour.toISOString().substring(0, 13);

        const hourStats = {
          hour: hour.getHours(),
          timestamp: hour.toISOString(),
        };

        for (const provider of providers) {
          const responseTimes = await redis.lrange(
            `provider_response_times:${provider}:${hourKey}`,
            0,
            -1,
          );
          if (responseTimes.length > 0) {
            const avgResponseTime =
              responseTimes.reduce((sum, time) => sum + parseInt(time), 0) /
              responseTimes.length;
            hourStats[provider] = Math.round(avgResponseTime);
          } else {
            hourStats[provider] = null; // Use null for no data
          }
        }
        hourlyData.push(hourStats);
      }

      return hourlyData;
    } catch (error) {
      logger.error(
        "[Request Tracker] Failed to get hourly provider stats:",
        error,
      );
      return [];
    }
  }

  
  // Stub to maintain API compatibility until frontend/callers are updated
  async getTopEndpoints(limit = 10) {
    return [];
  }


  // Log detailed error for dashboard
  async logError(level, message, details = {}) {
    // Skip metrics collection if disabled
    if (isMetricsDisabled()) {
      return;
    }
    try {
      const errorId = Date.now().toString();
      const timestamp = new Date().toISOString();

      const errorLog = {
        id: errorId,
        level: level, // 'error', 'warning', 'info'
        message: message,
        details: details,
        timestamp: timestamp,
        count: 1,
      };

      // Store in Redis with 7 day TTL using pipeline (fire-and-forget)
      redis.pipeline()
        .set(`error_log:${errorId}`, JSON.stringify(errorLog), "EX", 86400 * 7)
        .zadd("error_logs", Date.now(), errorId)
        .expire("error_logs", 86400 * 7)
        .exec()
        .catch(() => {});

      logger.info(`[Request Tracker] Logged ${level}: ${message}`);
    } catch (error) {
      logger.warn("[Request Tracker] Failed to log error:", error.message);
    }
  }

  // Get recent error logs
  async getErrorLogs(limit = 50) {
    try {
      // Get recent error IDs from sorted set
      const errorIds = await redis.zrevrange("error_logs", 0, limit - 1);

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
            logger.warn(
              "[Request Tracker] Failed to parse error log:",
              error.message,
            );
            return null;
          }
        }),
      );

      // Filter out null values and return
      return errorLogs.filter((log) => log !== null);
    } catch (error) {
      logger.error("[Request Tracker] Failed to get error logs:", error);
      return [];
    }
  }

  // Clear all error logs
  async clearErrorLogs() {
    try {
      // Get all error IDs from sorted set
      const errorIds = await redis.zrange("error_logs", 0, -1);
      
      // Also scan for any orphaned error_log:* keys not in the sorted set
      const orphanedKeys = [];
      let cursor = '0';
      do {
        const [newCursor, keys] = await redis.scan(cursor, 'MATCH', 'error_log:*', 'COUNT', 100);
        cursor = newCursor;
        orphanedKeys.push(...keys);
      } while (cursor !== '0');

      // Combine both sets of keys to delete
      const keysToDelete = new Set([
        ...errorIds.map(id => `error_log:${id}`),
        ...orphanedKeys
      ]);

      if (keysToDelete.size === 0 && errorIds.length === 0) {
        return { success: true, message: "No error logs to clear", clearedCount: 0 };
      }

      // Delete all error log entries and the sorted set
      const pipeline = redis.pipeline();
      for (const key of keysToDelete) {
        pipeline.del(key);
      }
      pipeline.del("error_logs");
      await pipeline.exec();

      const clearedCount = keysToDelete.size;
      logger.info(`[Request Tracker] Cleared ${clearedCount} error logs`);
      return { success: true, message: `Cleared ${clearedCount} error logs`, clearedCount };
    } catch (error) {
      logger.error("[Request Tracker] Failed to clear error logs:", error);
      return { success: false, message: error.message, clearedCount: 0 };
    }
  }

  // Helper function to calculate time ago
  getTimeAgo(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60)
      return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`;
    if (diffHours < 24)
      return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
    return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
  }

  // Get anonymized IP from request (helper method)
  getAnonymizedIP(req) {
    let anonymizedIP = "unknown";
    try {
      const ip =
        req.ip ||
        req.connection?.remoteAddress ||
        req.socket?.remoteAddress ||
        "unknown";
      if (ip && ip !== "unknown") {
        // For IPv4, keep first 3 octets (e.g., 192.168.1.x)
        // For IPv6, keep first 3 groups (e.g., 2001:db8:85a3::x)
        if (ip.includes(".")) {
          const parts = ip.split(".");
          anonymizedIP = parts.slice(0, 3).join(".") + ".x";
        } else if (ip.includes(":")) {
          const parts = ip.split(":");
          anonymizedIP = parts.slice(0, 3).join(":") + "::x";
        } else {
          anonymizedIP = "unknown";
        }
      }
    } catch (error) {
      anonymizedIP = "unknown";
    }
    return anonymizedIP;
  }

  // Get improved user identifier using simplified factors
  getImprovedUserIdentifier(req) {
    const crypto = require("crypto");

    // Get anonymized IP (first 3 octets only for privacy)
    const anonymizedIP = this.getAnonymizedIP(req);

    // Get basic browser info (just browser name, not version)
    const userAgent = req.get("User-Agent") || "unknown";
    let browserType = "unknown";
    if (userAgent.includes("Chrome")) browserType = "chrome";
    else if (userAgent.includes("Firefox")) browserType = "firefox";
    else if (userAgent.includes("Safari")) browserType = "safari";
    else if (userAgent.includes("Edge")) browserType = "edge";
    else if (userAgent.includes("Stremio")) browserType = "stremio";
    else browserType = "other";

    // Create a simplified identifier that groups users more reasonably
    // Only use IP + basic browser type to avoid over-fragmenting users
    const compositeId = `${anonymizedIP}:${browserType}`;

    // Hash the composite identifier
    return crypto
      .createHash("sha256")
      .update(compositeId)
      .digest("hex")
      .substring(0, 16);
  }

  // Track active user with improved methodology
  async trackActiveUser(userIdentifier, req) {
    try {
      const now = Date.now();
      const today = new Date().toISOString().split("T")[0];

      // Track in multiple time windows for better accuracy
      const timeWindows = [
        { key: `active_users:15min`, ttl: 900 }, // 15 minutes
      ];

      // Store detailed user activity for analytics
      const userActivity = {
        identifier: userIdentifier,
        timestamp: now,
        endpoint: this.normalizeEndpoint(req.path),
        userAgent: req.get("User-Agent") || "unknown",
        method: req.method,
        anonymizedIP: this.getAnonymizedIP(req),
      };

      // Execute Redis operations in parallel
      await Promise.all([
        // Time window tracking
        ...timeWindows.flatMap(window => [
          redis.sadd(window.key, userIdentifier),
          redis.expire(window.key, window.ttl)
        ]),
        // User activity tracking
        redis.lpush("user_activities", JSON.stringify(userActivity)),
        redis.ltrim("user_activities", 0, 999),
        redis.expire("user_activities", 86400 * 7),
      ]);
    } catch (error) {
      logger.warn(
        "[Request Tracker] Failed to track active user:",
        error.message,
      );
    }
  }

  // Get active users with improved methodology
  async getActiveUsers(timeWindow = "15min") {
    try {
      const key = `active_users:${timeWindow}`;
      const count = await redis.scard(key);
      return count || 0;
    } catch (error) {
      logger.warn(
        "[Request Tracker] Failed to get active users:",
        error.message,
      );
      return 0;
    }
  }

  // Clear inflated active user data (run once to reset after fixing the ID logic)
  async clearActiveUserData() {
    try {
      const patterns = [
        "active_users:*",
        "unique_users:*", 
        "user_activities"
      ];

      const { deleteKeysByPattern } = require('./redisUtils');
      for (const pattern of patterns) {
        const deleted = await deleteKeysByPattern(pattern);
        if (deleted > 0) {
          logger.info(`[Request Tracker] Cleared ${deleted} keys matching ${pattern}`);
        }
      }

      logger.info("[Request Tracker] Active user data cleared - new tracking will be more accurate");
      return { success: true, message: "Active user data cleared successfully" };
    } catch (error) {
      logger.error("[Request Tracker] Failed to clear active user data:", error);
      return { success: false, message: error.message };
    }
  }

  // Get recent user activities for analytics
  async getRecentUserActivities(limit = 50) {
    try {
      const activities = await redis.lrange("user_activities", 0, limit - 1);
      return activities
        .map((activity) => {
          try {
            return JSON.parse(activity);
          } catch (error) {
            return null;
          }
        })
        .filter((activity) => activity !== null);
    } catch (error) {
      logger.warn(
        "[Request Tracker] Failed to get recent user activities:",
        error.message,
      );
      return [];
    }
  }

  // Clean up corrupted Redis keys that might cause WRONGTYPE errors
  async cleanupCorruptedKeys() {
    try {
      const providers = [
        "tmdb",
        "tvdb",
        "mal",
        "anilist",
        "kitsu",
        "fanart",
        "tvmaze",
      ];
      const today = new Date().toISOString().split("T")[0];

      for (const provider of providers) {
        // Check for daily keys that should be hourly
        const dailyKey = `provider_response_times:${provider}:${today}`;
        try {
          const keyType = await redis.type(dailyKey);
          if (keyType !== "none" && keyType !== "list") {
            logger.info(
              `[Request Tracker] Cleaning up corrupted key: ${dailyKey} (type: ${keyType})`,
            );
            await redis.del(dailyKey);
          }
        } catch (error) {
          logger.warn(
            `[Request Tracker] Failed to check/clean key ${dailyKey}:`,
            error.message,
          );
        }
      }

      logger.info("[Request Tracker] Corrupted key cleanup completed");
    } catch (error) {
      logger.warn(
        "[Request Tracker] Failed to cleanup corrupted keys:",
        error.message,
      );
    }
  }
}

module.exports = new RequestTracker();
