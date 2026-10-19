const os = require("os");
const process = require("process");
const v8 = require("node:v8");
const consola = require('consola');
const logger = consola.withTag('DashboardAPI');

function getImageWarmDetail() {
  try {
    const { isBuiltinPosterCacheEnabled } = require('./posterCache/config.js');
    if (!isBuiltinPosterCacheEnabled()) return null;

    const live = require('./posterCache/warmQueue.js').getStats();
    const source = live.offered > 0 ? live : live.lastRun;
    if (!source) {
      return { hasData: false, isActive: false, fromLastRun: false, offered: 0 };
    }
    const outstanding = live.offered > 0
      ? live.depth + live.concurrency
      : (source.outstanding || 0);
    const resolved = Math.max(0, source.offered - outstanding);
    return {
      hasData: true,
      ...source,
      depth: live.offered > 0 ? live.depth : 0,
      concurrency: live.offered > 0 ? live.concurrency : 0,
      lagMs: live.offered > 0 ? live.lagMs : 0,
      resolved,
      peakOutstanding: source.peakOutstanding || 0,
      drained: source.peakOutstanding > 0
        ? Math.min(1, (source.peakOutstanding - outstanding) / source.peakOutstanding)
        : 1,
      outstanding,
      isActive: live.offered > 0 && (live.depth + live.concurrency) > 0,
      fromLastRun: live.offered === 0,
      at: source.at || null,
    };
  } catch (error) {
    logger.debug('Image warm stats unavailable:', error.message);
    return null;
  }
}

const { getCacheHealth, getMemoryStats: getCacheMemoryStats } = require('./getCache');

/** System keys that must survive any cache clear. */
const { EPOCH_STATE_KEY } = require('./epochCleanup');

const PRESERVED_CACHE_KEYS = [
  'maintenance:', 'cache-warming:', 'catalog-warmup:',
  'anime_list:last_update', 'addon:start_time', 'system:app_version',
  // Clearing this would make the next boot re-sweep the whole keyspace.
  EPOCH_STATE_KEY,
  // Sessions live here. Clearing them signs out whoever pressed the button, and
  // their next request 401s before it can report what the clear actually did.
  'auth:',
  // Neither of these is derived from a provider, so a clear cannot rebuild them
  // on demand: the mappings come from a scheduled import and the metadata is
  // accumulated from traffic the rating page reads back.
  'id_map:', 'content_metadata:',
];

const isPreservedCacheKey = (key) =>
  PRESERVED_CACHE_KEYS.some((p) => (p.endsWith(':') ? key.startsWith(p) : key === p));

/** Escape glob metacharacters so operator input cannot widen a SCAN pattern. */
const escapeRedisGlob = (value) => String(value).replace(/[\\*?[\]^]/g, (c) => `\\${c}`);

const MEDIA_ID_PROVIDERS = ['tmdb', 'tvdb', 'tvdbc', 'kitsu', 'mal', 'anilist', 'anidb'];

const MEDIA_ID_PATTERNS = [
  /^tt\d{7,10}$/i,
  new RegExp(`^(?:${MEDIA_ID_PROVIDERS.join('|')}):[A-Za-z0-9._-]+$`, 'i'),
  /^tun_[A-Za-z0-9._:-]+$/i,
];

const isCompleteMediaId = (token) => MEDIA_ID_PATTERNS.some((re) => re.test(token));
const { getCacheCleanupScheduler } = require('./cacheCleanupScheduler');
const { getAnimeListXmlStats } = require('./anime-list-mapper');
const { getIdMapperStats, getKitsuImdbStats, getAnimeApiStats, getMemoryStats: getIdMapperMemoryStats } = require('./id-mapper');
const { getIdMappingsStats } = require('./id-mappings');
const { getImdbRatingsStatsForDashboard, getRatingsStats } = require('./imdbRatings');
const { getWarmupStats: getEssentialWarmupStats } = require('./cacheWarmer');
const { getWarmupStats: getMALWarmupStats } = require('./malCatalogWarmer');
const { getWarmupStats: getCatalogWarmupStats } = require('./comprehensiveCatalogWarmer');
const { getTraktMemoryStats } = require('../utils/traktUtils');
const { envInt } = require('../utils/envNumber');

class DashboardAPI {
  constructor(cache, idMapper, config, database, requestTracker) {
    this.cache = cache || null;
    this.idMapper = idMapper || null;
    this.config = config || {};
    this.database = database || null;
    this.requestTracker = requestTracker || null;
    this.startTime = Date.now();
    this.uptimeInitialized = false;

    // CPU usage tracking state
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = Date.now();

    // Maintenance tasks cache (invalidated when tasks are executed)
    this._maintenanceTasksCache = null;
    this._maintenanceTasksCacheTime = null;

    // Initialize persistent uptime tracking (async, don't await in constructor)
    this.initializePersistentUptime()
      .then(() => {
        this.uptimeInitialized = true;
      })
      .catch((err) => {
        logger.error("Failed to initialize uptime:", err);
      });

    const heapLogInterval = parseInt(process.env.HEAP_LOG_INTERVAL_MIN || '0', 10);
    if (heapLogInterval > 0) {
      this._heapLogTimer = setInterval(() => {
        try {
          const profile = this.getHeapProfile();
          const mb = (b) => `${Math.round(b / 1024 / 1024)}MB`;
          const p = profile.process;
          const lines = [
            `[Heap] rss=${mb(p.rss)} heapUsed=${mb(p.heapUsed)} heapTotal=${mb(p.heapTotal)} external=${mb(p.external)}`,
          ];
          for (const [name, stats] of Object.entries(profile.caches)) {
            lines.push(`[Heap]   ${name}: ${JSON.stringify(stats)}`);
          }
          lines.forEach(l => logger.info(l));
        } catch (err) {
          logger.warn(`[Heap] Failed to log heap profile: ${err.message}`);
        }
      }, heapLogInterval * 60 * 1000);
      this._heapLogTimer.unref();
    }
  }

  // Get system overview data
  async getSystemOverview() {
    // Get persistent uptime (survives restarts)
    const persistentUptime = await this.getPersistentUptime();

    // Get process uptime for comparison
    const processUptime = process.uptime();
    const processHours = Math.floor(processUptime / 3600);
    const processMinutes = Math.floor((processUptime % 3600) / 60);

    // Get system uptime
    const systemUptime = os.uptime();
    const systemHours = Math.floor(systemUptime / 3600);
    const systemMinutes = Math.floor((systemUptime % 3600) / 60);

    // Get system health
    const healthStatus = await this.checkSystemHealth();

    return {
      status: healthStatus.status,
      healthChecks: healthStatus.healthChecks,
      issues: healthStatus.issues,
      uptime: persistentUptime.uptime, // Use persistent uptime
      uptimeSeconds: persistentUptime.uptimeSeconds,
      processUptime: `${processHours}h ${processMinutes}m`, // Show process uptime separately
      systemUptime: `${systemHours}h ${systemMinutes}m`,
      version: process.env.npm_package_version || "N/A", // Changed fallback to N/A
      lastUpdate: new Date().toLocaleString(),
      memoryUsage: process.memoryUsage(),
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      processId: process.pid,
      startTime: persistentUptime.startTime,
    };
  }

  // Initialize persistent uptime tracking in Redis
  async initializePersistentUptime() {
    try {
      if (this.cache) {
        const existingStartTime = await this.cache.get("addon:start_time");
        if (!existingStartTime) {
          // First time startup - store current time
          await this.cache.set("addon:start_time", Date.now().toString());
          logger.debug("Initialized persistent uptime tracking");
        }
      }
    } catch (error) {
      logger.warn(
        "Failed to initialize persistent uptime:",
        error.message,
      );
    }
  }

  // Get persistent uptime (survives process restarts)
  async getPersistentUptime() {
    try {
      if (this.cache && this.cache.status === "ready") {
        const startTimeStr = await this.cache.get("addon:start_time");
        if (startTimeStr) {
          const startTime = parseInt(startTimeStr);
          const uptimeMs = Date.now() - startTime;
          const uptimeSeconds = Math.floor(uptimeMs / 1000);

          const hours = Math.floor(uptimeSeconds / 3600);
          const minutes = Math.floor((uptimeSeconds % 3600) / 60);

          return {
            uptime: `${hours}h ${minutes}m`,
            uptimeSeconds,
            startTime: new Date(startTime).toISOString(),
          };
        } else {
          // Key doesn't exist yet, initialize it
          logger.debug(
            "[Dashboard API] addon:start_time not found, initializing now",
          );
          await this.cache.set("addon:start_time", Date.now().toString());

          // Return process uptime for now
          const processUptime = process.uptime();
          const hours = Math.floor(processUptime / 3600);
          const minutes = Math.floor((processUptime % 3600) / 60);

          return {
            uptime: `${hours}h ${minutes}m`,
            uptimeSeconds: Math.floor(processUptime),
            startTime: new Date(
              Date.now() - processUptime * 1000,
            ).toISOString(),
          };
        }
      }

      // Fallback to process uptime when Redis not ready
      logger.warn("Redis not ready, using process uptime");
      const processUptime = process.uptime();
      const hours = Math.floor(processUptime / 3600);
      const minutes = Math.floor((processUptime % 3600) / 60);

      return {
        uptime: `${hours}h ${minutes}m`,
        uptimeSeconds: Math.floor(processUptime),
        startTime: new Date(Date.now() - processUptime * 1000).toISOString(),
      };
    } catch (error) {
      logger.warn(
        "Failed to get persistent uptime:",
        error.message,
      );
      // Return process uptime instead of 0h 0m
      const processUptime = process.uptime();
      const hours = Math.floor(processUptime / 3600);
      const minutes = Math.floor((processUptime % 3600) / 60);

      return {
        uptime: `${hours}h ${minutes}m`,
        uptimeSeconds: Math.floor(processUptime),
        startTime: new Date(Date.now() - processUptime * 1000).toISOString(),
      };
    }
  }

  // Check system health
  async checkSystemHealth() {
    const healthChecks = {
      redis: false,
      database: false,
      memory: false,
      disk: false,
    };

    let overallStatus = "healthy";
    const issues = [];

    // Check Redis connection (critical - mark as error if unavailable)
    try {
      if (this.cache && this.cache.status === "ready") {
        await this.cache.ping();
        healthChecks.redis = true;
      } else if (this.cache && this.cache.status) {
        logger.debug(`Redis status: ${this.cache.status}`);
        if (
          this.cache.status === "connecting" ||
          this.cache.status === "reconnecting"
        ) {
          issues.push(`Redis ${this.cache.status}...`);
          overallStatus = "warning";
        } else if (
          this.cache.status === "end" ||
          this.cache.status === "close"
        ) {
          issues.push("Redis connection closed");
          overallStatus = "error";
        }
      } else if (!this.cache) {
        logger.info("[Dashboard API] Redis not available");
      }
    } catch (error) {
      issues.push(`Redis error: ${error.message}`);
      overallStatus = "error";
    }

    // Check database connection
    try {
      if (this.database) {
        // Simple query to test database
        await this.database.getQuery("SELECT 1");
        healthChecks.database = true;
      } else {
        // Database is optional - don't mark as warning
        healthChecks.database = false;
      }
    } catch (error) {
      issues.push("Database connection failed");
      overallStatus = "warning"; // Only warning for connection failure, not missing
    }

    // Check memory usage
    try {
      const universalMemoryUsage = await this.getUniversalMemoryUsage();

      if (universalMemoryUsage > 90) {
        // 90% is critical
        issues.push("Critical memory usage");
        overallStatus = "error";
        healthChecks.memory = false;
      } else if (universalMemoryUsage > 75) {
        // 75% is a warning
        issues.push("High memory usage");
        overallStatus = "warning";
        healthChecks.memory = true;
      } else {
        healthChecks.memory = true;
      }
    } catch (error) {
      issues.push("Memory check failed");
      overallStatus = "error";
    }

    // Check disk space
    try {
      const diskUsage = await this.getDiskUsage();
      if (diskUsage > 95) {
        issues.push("Critical disk usage");
        overallStatus = "error";
        healthChecks.disk = false;
      } else if (diskUsage > 85) {
        issues.push("High disk usage");
        overallStatus = "warning";
        healthChecks.disk = true;
      } else {
        healthChecks.disk = true;
      }
    } catch (error) {
      issues.push("Disk check failed");
      overallStatus = "error";
    }

    return {
      status: overallStatus,
      healthChecks,
      issues,
    };
  }

  // Get quick statistics
  async getQuickStats() {
    try {
      // Get real request tracking data
      const requestStats = this.requestTracker
        ? await this.requestTracker.getStats()
        : { totalRequests: 0, todayRequests: 0, errorRate: 0 };
      const activeUsers = this.requestTracker
        ? await this.requestTracker.getActiveUsers()
        : 0;

      // Get cache hit rate from cacheHealth (same source as ops tab for consistency)
      const cacheHealth = getCacheHealth();
      const cacheHitRate = parseFloat(cacheHealth.hitRate) || 0;

      return {
        totalRequests: requestStats.todayRequests || requestStats.totalRequests, // Use today's requests for dashboard
        todayRequests: requestStats.todayRequests || 0,
        trackedResponses: requestStats.trackedResponses || 0,
        cacheHitRate: cacheHitRate,
        activeUsers: activeUsers,
        errorRate: parseFloat(requestStats.errorRate),
        successRate: parseFloat(requestStats.successRate),
        trackingCoverage: requestStats.trackingCoverage || 100,
      };
    } catch (error) {
      logger.error("Error getting quick stats:", error);
      return {
        totalRequests: 0,
        todayRequests: 0,
        trackedResponses: 0,
        cacheHitRate: 0,
        activeUsers: 0,
        errorRate: 0,
        successRate: 0,
        trackingCoverage: 100,
      };
    }
  }

  // Get cache performance data
  async getCachePerformance() {
    try {
      if (this.cache) {
        // Get real Redis cache stats
        try {
          // Use dbsize() for consistency with clearCache method
          const totalKeys = await this.cache.dbsize();
          
          // Get cache health stats (hits, misses, cachedErrors) - this gives us the accurate current session stats
          const cacheHealth = getCacheHealth();
          
          // Use the hit rate from cacheHealth instead of requestTracker for consistency with byType breakdown
          const hitRate = parseFloat(cacheHealth.hitRate) || 0;
          const missRate = hitRate > 0 ? 100 - hitRate : 0;

          let evictedKeys = null;
          try {
            const stats = await this.cache.info("stats");
            const line = stats.split("\r\n").find((l) => l.startsWith("evicted_keys:"));
            if (line) evictedKeys = parseInt(line.split(":")[1], 10);
          } catch (_) {}

          // Get real Redis memory usage
          let memoryUsed = "0 MB";
          let memoryUsagePercent = null;
          try {
            const info = await this.cache.info("memory");
            const lines = info.split("\r\n");
            let usedMemory = 0;
            let maxMemory = 0;

            for (const line of lines) {
              if (line.startsWith("used_memory:")) {
                usedMemory = parseInt(line.split(":")[1]);
              } else if (line.startsWith("maxmemory:")) {
                maxMemory = parseInt(line.split(":")[1]);
              }
            }

            // Format bytes to human readable
            let formattedUsed;
            if (usedMemory >= 1024 * 1024 * 1024) {
              formattedUsed = (usedMemory / (1024 * 1024 * 1024)).toFixed(1) + " GB";
            } else if (usedMemory >= 1024 * 1024) {
              formattedUsed = (usedMemory / (1024 * 1024)).toFixed(1) + " MB";
            } else if (usedMemory >= 1024) {
              formattedUsed = (usedMemory / 1024).toFixed(1) + " KB";
            } else {
              formattedUsed = usedMemory + " B";
            }

            // If maxmemory is set, add percentage
            if (maxMemory > 0) {
              const percentage = Math.round((usedMemory / maxMemory) * 100);
              memoryUsagePercent = Math.max(0, Math.min(100, percentage));
              memoryUsed = `${formattedUsed} (${memoryUsagePercent}% of limit)`;
            } else {
              memoryUsed = formattedUsed;
            }
          } catch (memError) {
            logger.warn(
              "[Dashboard API] Failed to get Redis memory info:",
              memError.message,
            );
            memoryUsed = "N/A";
            memoryUsagePercent = null;
          }

          return {
            hitRate: hitRate,
            missRate: missRate,
            memoryUsage: memoryUsed,
            memoryUsagePercent: memoryUsagePercent,
            evictedKeys: Number.isFinite(evictedKeys) ? evictedKeys : null,
            totalKeys: totalKeys,
            hits: cacheHealth.hits || 0,
            misses: cacheHealth.misses || 0,
            cachedErrors: cacheHealth.cachedErrors || 0,
            byType: cacheHealth.byType || {},
          };
        } catch (redisError) {
          logger.warn(
            "Redis error, using fallback stats:",
            redisError.message,
          );
          return {
            hitRate: 0,
            missRate: 0,
            memoryUsage: "N/A",
            memoryUsagePercent: null,
            evictedKeys: null,
            totalKeys: 0,
            hits: 0,
            misses: 0,
            cachedErrors: 0,
            byType: {},
          };
        }
      }
      return {
        hitRate: 0,
        missRate: 0,
        memoryUsage: "N/A",
        memoryUsagePercent: null,
        evictedKeys: null,
        totalKeys: 0,
        hits: 0,
        misses: 0,
        cachedErrors: 0,
        byType: {},
      };
    } catch (error) {
      logger.error("Error getting cache performance:", error);
      return {
        hitRate: 0,
        missRate: 0,
        memoryUsage: "N/A",
        memoryUsagePercent: null,
        evictedKeys: null,
        totalKeys: 0,
        hits: 0,
        misses: 0,
        cachedErrors: 0,
        byType: {},
      };
    }
  }

  // Get provider performance data
  async getProviderPerformance() {
    try {
      // Get real provider performance stats from request tracker
      const realStats = this.requestTracker
        ? await this.requestTracker.getProviderPerformance()
        : [];

      // If no real data yet, return empty array to avoid showing fake data
      if (realStats.length === 0) {
        return [];
      }

      return realStats;
    } catch (error) {
      logger.error(
        "Error getting provider performance:",
        error,
      );
      return [];
    }
  }

  // Get recent activity
  async getRecentActivity(limit = 20) {
    try {
      //logger.debug("[Dashboard API] Getting recent activity...");

      const activities = this.requestTracker
        ? await this.requestTracker.getRecentActivity(limit)
        : [];
      logger.debug(
        `Got ${activities.length} activities from request tracker`,
      );

      // Format activities for display
      const formattedActivities = activities.map((activity) => {
        const timeAgo = this.getTimeAgo(new Date(activity.timestamp));

        return {
          id: activity.id,
          type: activity.type,
          details: activity.details,
          timestamp: activity.timestamp,
          timeAgo: timeAgo,
          userAgent: activity.userAgent,
        };
      });

      logger.debug(
        `Returning ${formattedActivities.length} formatted activities`,
      );
      return formattedActivities;
    } catch (error) {
      logger.error("Error getting recent activity:", error);
      return [];
    }
  }

  // Helper method to format time ago
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
    if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;

    return date.toLocaleDateString();
  }

  // Helper method to format time until (for future dates)
  getTimeUntil(date) {
    const now = new Date();
    const diffMs = date - now;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Now";
    if (diffMins < 60)
      return `In ${diffMins} minute${diffMins > 1 ? "s" : ""}`;
    if (diffHours < 24)
      return `In ${diffHours} hour${diffHours > 1 ? "s" : ""}`;
    if (diffDays < 7) return `In ${diffDays} day${diffDays > 1 ? "s" : ""}`;

    return date.toLocaleDateString();
  }

  // Get provider status based on actual success/error tracking
  async getProviderStatus() {
    try {
      const providers = [
        {
          name: "TMDB",
          // Check for user key or built-in key
          keyStatus: (process.env.TMDB_API_KEY || process.env.TMDB_API || process.env.BUILT_IN_TMDB_API_KEY)
            ? "Built-in key set" 
            : "No API key",
          requiresKey: true,
        },
        {
          name: "TVDB",
          // Check for user key or built-in key - show nothing if not set
          keyStatus: (process.env.TVDB_API_KEY || process.env.BUILT_IN_TVDB_API_KEY) 
            ? "Built-in key set" 
            : null,
          requiresKey: false,
        },
        {
          name: "AniList",
          // Check if OAuth integration is configured - show "Disabled" if not
          keyStatus: (process.env.ANILIST_CLIENT_ID && process.env.ANILIST_CLIENT_SECRET) 
            ? "Integration set-up" 
            : "Disabled",
          requiresKey: false,
        },
        {
          name: "MAL",
          keyStatus: require('./mal').isJikanEnabled() ? null : "Disabled",
          requiresKey: false,
          off: !require('./mal').isJikanEnabled(),
        },
        {
          name: "Kitsu",
          keyStatus: null, // Doesn't require API key
          requiresKey: false,
        },
        {
          name: "Trakt",
          // Check if OAuth integration is configured - show "Disabled" if not
          keyStatus: (process.env.TRAKT_CLIENT_ID && process.env.TRAKT_CLIENT_SECRET) 
            ? "Integration set-up" 
            : "Disabled",
          requiresKey: false,
        },
        {
          name: "MDBList",
          // Show nothing if not set
          keyStatus: (process.env.MDBLIST_API_KEY || process.env.BUILT_IN_MDBLIST_API_KEY)
            ? "Built-in key set" 
            : null,
          requiresKey: false,
        },
        {
          name: "Letterboxd",
          keyStatus: null, // Doesn't require API key (uses StremThru)
          requiresKey: false,
        },
        {
          name: "Gemini",
          // Show nothing if not set
          keyStatus: (process.env.GEMINI_API_KEY || process.env.BUILT_IN_GEMINI_API_KEY) 
            ? "Built-in key set" 
            : null,
          requiresKey: false,
        },
        {
          name: "TVMaze",
          keyStatus: null, // Doesn't require API key
          requiresKey: false,
        },
      ];

      const counts = this.requestTracker
        ? await this.requestTracker.getProviderCounts(providers.map((p) => p.name.toLowerCase()))
        : {};
      const minCalls = envInt("PROVIDER_HEALTH_MIN_CALLS", 20, 1);
      const providerStatus = await Promise.all(
        providers.map(async (provider) => {
          try {
            const providerKey = provider.name.toLowerCase();

            const { success: successCount = 0, errors: errorCount = 0 } = counts[providerKey] || {};
            const totalCalls = successCount + errorCount;

            // Calculate success rate
            const successRate = totalCalls > 0 
              ? Math.round((successCount / totalCalls) * 1000) / 10 
              : null;

            // Get average response time from recent data
            const currentHour = new Date().toISOString().substring(0, 13);
            const responseTimes = await this.cache.lrange(`provider_response_times:${providerKey}:${currentHour}`, 0, 99);
            const avgResponseTime = responseTimes && responseTimes.length > 0
              ? Math.round(responseTimes.reduce((sum, t) => sum + parseInt(t), 0) / responseTimes.length)
              : null;

            // Determine health status based purely on success/failure metrics
            let status = "healthy";
            
            if (totalCalls === 0 || provider.off) {
              status = "unknown";
            } else if (totalCalls >= minCalls) {
              if (successRate < 50) {
                status = "down";
              } else if (successRate < 90) {
                status = "degraded";
              }
            }

            return {
              name: provider.name,
              status,
              keyStatus: provider.keyStatus,
              requiresKey: provider.requiresKey,
              stats: {
                calls24h: totalCalls,
                successRate,
                avgResponseTime,
              },
            };
          } catch (providerError) {
            logger.warn(
              `[Dashboard API] Failed to get status for provider ${provider.name}:`,
              providerError.message,
            );
            return {
              name: provider.name,
              status: "unknown",
              keyStatus: provider.keyStatus,
              requiresKey: provider.requiresKey,
              stats: null,
            };
          }
        }),
      );

      return providerStatus;
    } catch (error) {
      logger.error("Error getting provider status:", error);
      return [];
    }
  }

  // Get aggregated system configuration stats (cached for 60 seconds)
  async getSystemConfig() {
    try {
      // Check if we have a recent cached result (within 60 seconds)
      const now = Date.now();
      if (this._systemConfigCache && this._systemConfigCacheTime && (now - this._systemConfigCacheTime) < 60000) {
        return this._systemConfigCache;
      }

      let userConfigs = [];
      let totalUsers = 0;

      try {
        if (this.database) {
          const userUUIDs = await this.database.getAllUserUUIDs();
          totalUsers = userUUIDs.length;

          const sampleSize = Math.min(250, userUUIDs.length);
          for (let i = userUUIDs.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [userUUIDs[i], userUUIDs[j]] = [userUUIDs[j], userUUIDs[i]];
          }
          const sampleUUIDs = userUUIDs.slice(0, sampleSize);
          const configPromises = sampleUUIDs.map(async (userUUID) => {
            try {
              return await this.database.getUserConfig(userUUID);
            } catch (error) {
              return null;
            }
          });

          const configs = await Promise.all(configPromises);
          userConfigs = configs.filter((config) => config !== null);
        }
      } catch (dbError) {
        logger.warn(
          "Failed to load user configs for aggregation:",
          dbError.message,
        );
      }

      // Calculate aggregated statistics
      const stats = this.calculateConfigStats(userConfigs);

      const result = {
        totalUsers: totalUsers,
        sampleSize: userConfigs.length,
        aggregatedStats: stats,
        redisConnected: this.cache ? true : false,
        lastUpdated: new Date().toISOString(),
      };

      // Cache the result
      this._systemConfigCache = result;
      this._systemConfigCacheTime = now;

      return result;
    } catch (error) {
      logger.error("Error getting system config:", error);
      return {
        totalUsers: 0,
        sampleSize: 0,
        aggregatedStats: this.getDefaultStats(),
        redisConnected: false,
        lastUpdated: new Date().toISOString(),
      };
    }
  }

  // Calculate configuration statistics from user configs
  calculateConfigStats(userConfigs) {
    if (userConfigs.length === 0) {
      return this.getDefaultStats();
    }

    const total = userConfigs.length;
    const stats = {
      languages: {},
      metaProviders: { movie: {}, series: {}, anime: {} },
      artProviders: {
        movie: { poster: {}, background: {}, logo: {} },
        series: { poster: {}, background: {}, logo: {} },
        anime: { poster: {}, background: {}, logo: {} },
      },
      animeIdProviders: {},
      catalogSources: {},
      catalogCounts: [],
      searchProviders: { movie: {}, series: {}, anime_movie: {}, anime_series: {} },
      aiProvider: {},
      streamingServices: {},
      contentFilters: {
        sfw: 0,
        includeAdult: 0,
        hideUnreleasedDigital: 0,
        hideUnreleasedShows: 0,
        hideWatchedTrakt: 0,
        hideWatchedAnilist: 0,
        hideWatchedMdblist: 0,
        hideWatchedSimkl: 0,
        exclusionKeywords: 0,
        posterProxy: 0,
        forceAnimeDetection: 0,
      },
      features: {
        skipFiller: 0,
        skipRecap: 0,
        mdblistWatchTracking: 0,
        anilistWatchTracking: 0,
        malWatchTracking: 0,
        simklWatchTracking: 0,
        ratingPostersRpdb: 0,
        ratingPostersTop: 0,
        aiSearchEnabled: 0,
        aiCatalogs: 0,
      },
    };

    // Aggregate data
    userConfigs.forEach((config) => {
      // Language distribution
      const lang = config.language || "en-US";
      stats.languages[lang] = (stats.languages[lang] || 0) + 1;

      // Provider distributions
      if (config.providers) {
        // Movie providers
        const movieProvider = config.providers.movie || "tmdb";
        stats.metaProviders.movie[movieProvider] =
          (stats.metaProviders.movie[movieProvider] || 0) + 1;

        // Series providers
        const seriesProvider = config.providers.series || "tvdb";
        stats.metaProviders.series[seriesProvider] =
          (stats.metaProviders.series[seriesProvider] || 0) + 1;

        // Anime providers
        const animeProvider = config.providers.anime || "mal";
        stats.metaProviders.anime[animeProvider] =
          (stats.metaProviders.anime[animeProvider] || 0) + 1;

        // Anime ID providers
        const animeIdProvider = config.providers.anime_id_provider || "imdb";
        stats.animeIdProviders[animeIdProvider] =
          (stats.animeIdProviders[animeIdProvider] || 0) + 1;
      }

      // Art providers — resolve "meta" to the user's actual meta provider
      if (config.artProviders) {
        const resolveArt = (val, fallback) => (!val || val === 'meta') ? fallback : val;
        const movieFallback = config.providers?.movie || "tmdb";
        const seriesFallback = config.providers?.series || "tvdb";
        const animeFallback = config.providers?.anime || "mal";

        const countArt = (artConfig, fallback, bucket) => {
          if (typeof artConfig === "string") {
            const resolved = resolveArt(artConfig, fallback);
            bucket.poster[resolved] = (bucket.poster[resolved] || 0) + 1;
            bucket.background[resolved] = (bucket.background[resolved] || 0) + 1;
            bucket.logo[resolved] = (bucket.logo[resolved] || 0) + 1;
          } else if (typeof artConfig === "object" && artConfig !== null) {
            const poster = resolveArt(artConfig.poster, fallback);
            const background = resolveArt(artConfig.background, fallback);
            const logo = resolveArt(artConfig.logo, fallback);
            bucket.poster[poster] = (bucket.poster[poster] || 0) + 1;
            bucket.background[background] = (bucket.background[background] || 0) + 1;
            bucket.logo[logo] = (bucket.logo[logo] || 0) + 1;
          }
        };

        countArt(config.artProviders.movie, movieFallback, stats.artProviders.movie);
        countArt(config.artProviders.series, seriesFallback, stats.artProviders.series);
        countArt(config.artProviders.anime, animeFallback, stats.artProviders.anime);
      }

      // Feature usage
      if (config.mal?.skipFiller) stats.features.skipFiller++;
      if (config.mal?.skipRecap) stats.features.skipRecap++;
      if (config.mdblistWatchTracking) stats.features.mdblistWatchTracking++;
      if (config.anilistWatchTracking) stats.features.anilistWatchTracking++;
      if (config.malWatchTracking) stats.features.malWatchTracking++;
      if (config.simklWatchTracking) stats.features.simklWatchTracking++;
      config.posterRatingProvider === 'top' ? stats.features.ratingPostersTop++ : stats.features.ratingPostersRpdb++;
      if (config.search?.ai_enabled) stats.features.aiSearchEnabled++;

      // Catalog sources & count (enabled only)
      if (Array.isArray(config.catalogs)) {
        const enabled = config.catalogs.filter((cat) => cat.enabled !== false);
        stats.catalogCounts.push(enabled.length);
        let hasAiCatalog = false;
        enabled.forEach((cat) => {
          if (cat.source) {
            stats.catalogSources[cat.source] = (stats.catalogSources[cat.source] || 0) + 1;
          }
          if (cat.metadata?.discover?.formState?.aiGenerated) hasAiCatalog = true;
        });
        if (hasAiCatalog) stats.features.aiCatalogs++;
      }

      // Search providers
      if (config.search?.providers) {
        const sp = config.search.providers;
        if (sp.movie) stats.searchProviders.movie[sp.movie] = (stats.searchProviders.movie[sp.movie] || 0) + 1;
        if (sp.series) stats.searchProviders.series[sp.series] = (stats.searchProviders.series[sp.series] || 0) + 1;
        if (sp.anime_movie) stats.searchProviders.anime_movie[sp.anime_movie] = (stats.searchProviders.anime_movie[sp.anime_movie] || 0) + 1;
        if (sp.anime_series) stats.searchProviders.anime_series[sp.anime_series] = (stats.searchProviders.anime_series[sp.anime_series] || 0) + 1;
      }

      // AI provider
      if (config.search?.ai_enabled && config.search?.ai_provider) {
        stats.aiProvider[config.search.ai_provider] = (stats.aiProvider[config.search.ai_provider] || 0) + 1;
      }

      // Streaming services
      if (Array.isArray(config.streaming)) {
        config.streaming.forEach((service) => {
          stats.streamingServices[service] = (stats.streamingServices[service] || 0) + 1;
        });
      }

      // Content filters
      if (config.sfw) stats.contentFilters.sfw++;
      if (config.includeAdult) stats.contentFilters.includeAdult++;
      if (config.hideUnreleasedDigital) stats.contentFilters.hideUnreleasedDigital++;
      if (config.hideUnreleasedShows) stats.contentFilters.hideUnreleasedShows++;
      if (config.hideWatchedTrakt) stats.contentFilters.hideWatchedTrakt++;
      if (config.hideWatchedAnilist) stats.contentFilters.hideWatchedAnilist++;
      if (config.hideWatchedMdblist) stats.contentFilters.hideWatchedMdblist++;
      if (config.hideWatchedSimkl) stats.contentFilters.hideWatchedSimkl++;
      if (config.exclusionKeywords) stats.contentFilters.exclusionKeywords++;
      if (config.usePosterProxy) stats.contentFilters.posterProxy++;
      if (config.providers?.forceAnimeForDetectedImdb) stats.contentFilters.forceAnimeDetection++;
    });

    // Convert to percentages and format for display
    return this.formatStatsForDisplay(stats, total);
  }

  // Format statistics for dashboard display
  formatStatsForDisplay(stats, total) {
    const formatDistribution = (obj) => {
      return Object.entries(obj)
        .map(([key, count]) => ({
          name: key,
          count: count,
          percentage: Math.round((count / total) * 100),
        }))
        .sort((a, b) => b.count - a.count);
    };

    const formatSelfRelativeDistribution = (obj) => {
      const entries = Object.entries(obj);
      const sum = entries.reduce((acc, [, count]) => acc + count, 0);
      if (sum === 0) return [];
      return entries
        .map(([key, count]) => ({
          name: key,
          count: count,
          percentage: Math.round((count / sum) * 100),
        }))
        .sort((a, b) => b.count - a.count);
    };

    const catalogCounts = stats.catalogCounts.sort((a, b) => a - b);
    const n = catalogCounts.length;
    const avgCatalogs = n > 0 ? Math.round(catalogCounts.reduce((a, b) => a + b, 0) / n * 10) / 10 : 0;
    const medianCatalogs = n > 0 ? catalogCounts[Math.floor(n / 2)] : 0;
    const maxCatalogs = n > 0 ? catalogCounts[n - 1] : 0;
    const p25 = n > 0 ? catalogCounts[Math.floor(n * 0.25)] : 0;
    const p75 = n > 0 ? catalogCounts[Math.floor(n * 0.75)] : 0;

    return {
      languages: formatDistribution(stats.languages),
      metaProviders: {
        movie: formatDistribution(stats.metaProviders.movie),
        series: formatDistribution(stats.metaProviders.series),
        anime: formatDistribution(stats.metaProviders.anime),
      },
      artProviders: {
        movie: { poster: formatSelfRelativeDistribution(stats.artProviders.movie.poster), background: formatSelfRelativeDistribution(stats.artProviders.movie.background), logo: formatSelfRelativeDistribution(stats.artProviders.movie.logo) },
        series: { poster: formatSelfRelativeDistribution(stats.artProviders.series.poster), background: formatSelfRelativeDistribution(stats.artProviders.series.background), logo: formatSelfRelativeDistribution(stats.artProviders.series.logo) },
        anime: { poster: formatSelfRelativeDistribution(stats.artProviders.anime.poster), background: formatSelfRelativeDistribution(stats.artProviders.anime.background), logo: formatSelfRelativeDistribution(stats.artProviders.anime.logo) },
      },
      animeIdProviders: formatDistribution(stats.animeIdProviders),
      catalogSources: formatSelfRelativeDistribution(stats.catalogSources),
      catalogStats: { avg: avgCatalogs, median: medianCatalogs, max: maxCatalogs, p25, p75, total: catalogCounts.reduce((a, b) => a + b, 0) },
      searchProviders: {
        movie: formatDistribution(stats.searchProviders.movie),
        series: formatDistribution(stats.searchProviders.series),
        anime_movie: formatDistribution(stats.searchProviders.anime_movie),
        anime_series: formatDistribution(stats.searchProviders.anime_series),
      },
      aiProvider: formatDistribution(stats.aiProvider),
      streamingServices: formatSelfRelativeDistribution(stats.streamingServices),
      contentFilters: {
        sfw: Math.round((stats.contentFilters.sfw / total) * 100),
        includeAdult: Math.round((stats.contentFilters.includeAdult / total) * 100),
        hideUnreleasedDigital: Math.round((stats.contentFilters.hideUnreleasedDigital / total) * 100),
        hideUnreleasedShows: Math.round((stats.contentFilters.hideUnreleasedShows / total) * 100),
        hideWatchedTrakt: Math.round((stats.contentFilters.hideWatchedTrakt / total) * 100),
        hideWatchedAnilist: Math.round((stats.contentFilters.hideWatchedAnilist / total) * 100),
        hideWatchedMdblist: Math.round((stats.contentFilters.hideWatchedMdblist / total) * 100),
        hideWatchedSimkl: Math.round((stats.contentFilters.hideWatchedSimkl / total) * 100),
        exclusionKeywords: Math.round((stats.contentFilters.exclusionKeywords / total) * 100),
        posterProxy: Math.round((stats.contentFilters.posterProxy / total) * 100),
        forceAnimeDetection: Math.round((stats.contentFilters.forceAnimeDetection / total) * 100),
      },
      features: {
        skipFiller: Math.round((stats.features.skipFiller / total) * 100),
        skipRecap: Math.round((stats.features.skipRecap / total) * 100),
        mdblistWatchTracking: Math.round((stats.features.mdblistWatchTracking / total) * 100),
        anilistWatchTracking: Math.round((stats.features.anilistWatchTracking / total) * 100),
        malWatchTracking: Math.round((stats.features.malWatchTracking / total) * 100),
        simklWatchTracking: Math.round((stats.features.simklWatchTracking / total) * 100),
        ratingPostersRpdb: Math.round((stats.features.ratingPostersRpdb / total) * 100),
        ratingPostersTop: Math.round((stats.features.ratingPostersTop / total) * 100),
        aiSearchEnabled: Math.round((stats.features.aiSearchEnabled / total) * 100),
        aiCatalogs: Math.round((stats.features.aiCatalogs / total) * 100),
      },
    };
  }

  getDefaultStats() {
    return {
      languages: [{ name: "en-US", count: 0, percentage: 100 }],
      metaProviders: {
        movie: [{ name: "tmdb", count: 0, percentage: 100 }],
        series: [{ name: "tvdb", count: 0, percentage: 100 }],
        anime: [{ name: "mal", count: 0, percentage: 100 }],
      },
      artProviders: {
        movie: { poster: [], background: [], logo: [] },
        series: { poster: [], background: [], logo: [] },
        anime: { poster: [], background: [], logo: [] },
      },
      animeIdProviders: [{ name: "imdb", count: 0, percentage: 100 }],
      catalogSources: [],
      catalogStats: { avg: 0, median: 0, max: 0, p25: 0, p75: 0, total: 0 },
      searchProviders: { movie: [], series: [], anime_movie: [], anime_series: [] },
      aiProvider: [],
      streamingServices: [],
      contentFilters: {
        sfw: 0,
        includeAdult: 0,
        hideUnreleasedDigital: 0,
        hideUnreleasedShows: 0,
        hideWatchedTrakt: 0,
        hideWatchedAnilist: 0,
        hideWatchedMdblist: 0,
        hideWatchedSimkl: 0,
        exclusionKeywords: 0,
        posterProxy: 0,
        forceAnimeDetection: 0,
      },
      features: {
        skipFiller: 0,
        skipRecap: 0,
        mdblistWatchTracking: 0,
        anilistWatchTracking: 0,
        malWatchTracking: 0,
        simklWatchTracking: 0,
        ratingPostersRpdb: 0,
        ratingPostersTop: 0,
        aiSearchEnabled: 0,
        aiCatalogs: 0,
      },
    };
  }

  /**
   * Gets a universal memory usage percentage that works across different hosting environments.
   * This is the primary function to call for memory health checks.
   *
   * The logic prioritizes the most relevant memory limit:
   * 1. **Container Limit:** If running in a container (like Docker), it calculates usage
   *    against the container's specific memory limit. This is the most accurate metric.
   * 2. **System Memory:** If not in a container, it calculates the process's memory usage
   *    as a percentage of the total system RAM.
   *
   * @returns {Promise<number>} The memory usage percentage (0-100).
   */
  async getUniversalMemoryUsage() {
    const memUsage = process.memoryUsage();
    const containerLimit = await this.getContainerMemoryLimit();

    // --- PRIORITY 1: Container Environment (Docker, Kubernetes, LXC) ---
    // If a container limit is found and it's a real limit (less than total system RAM),
    // calculate usage based on the process's Resident Set Size (RSS) against that limit.
    if (containerLimit && containerLimit < os.totalmem()) {
      const percentUsed = Math.round((memUsage.rss / containerLimit) * 100);
      return Math.min(percentUsed, 100); // Cap at 100% just in case
    }

    // --- PRIORITY 2: System Memory (Fallback for non-containerized environments) ---
    // If no container limit is detected, calculate the process's RSS as a percentage of total system RAM.
    const rssPercent = Math.round((memUsage.rss / os.totalmem()) * 100);
    return Math.min(rssPercent, 100);
  }

  /**
   * Detects the container memory limit by checking various cgroup filesystem paths.
   * This helper function is used by getUniversalMemoryUsage.
   * @private
   * @returns {Promise<number|null>} The memory limit in bytes, or null if no limit is detected.
   */
  async getContainerMemoryLimit() {
    const fs = require("fs").promises;

    try {
      // --- Check for cgroup v2 (modern systems) ---
      const cgroupV2Path = "/sys/fs/cgroup/memory.max";
      try {
        const max = await fs.readFile(cgroupV2Path, "utf8");
        if (max.trim() !== "max") {
          const limit = parseInt(max.trim(), 10);
          if (limit > 0 && limit < os.totalmem()) {
            return limit;
          }
        }
      } catch (e) {
        // File doesn't exist or is unreadable, proceed to next check.
      }

      // --- Check for cgroup v1 (older systems) ---
      const cgroupV1Path = "/sys/fs/cgroup/memory/memory.limit_in_bytes";
      try {
        const limitStr = await fs.readFile(cgroupV1Path, "utf8");
        const limit = parseInt(limitStr.trim(), 10);
        // Check if it's a real, restrictive limit (not the default huge value)
        if (limit > 0 && limit < os.totalmem()) {
          return limit;
        }
      } catch (e) {
        // File doesn't exist, proceed to next check.
      }

      // --- Check for manual Node.js heap limit ---
      // This is less of a container limit and more of a process limit, but still useful.
      if (process.env.NODE_OPTIONS) {
        const match = process.env.NODE_OPTIONS.match(
          /--max-old-space-size=(\d+)/,
        );
        if (match && match[1]) {
          return parseInt(match[1], 10) * 1024 * 1024; // Convert MB to bytes
        }
      }

      // No container limit was detected
      return null;
    } catch (error) {
      // Silently fail if we can't read cgroup files (e.g., permissions, non-Linux OS)
      return null;
    }
  }

  // Get disk usage
  async getDiskUsage() {
    try {
      const { execSync } = require("child_process");
      const dfOutput = execSync("df /", { encoding: "utf8" });
      const lines = dfOutput.trim().split("\n");

      if (lines.length > 1) {
        const parts = lines[1].split(/\s+/);
        if (parts.length >= 5) {
          const usePercent = parts.find((part) => part.includes("%"));
          if (usePercent) {
            return parseInt(usePercent.replace("%", ""));
          }
          // Calculate manually if percentage not found
          const used = parseInt(parts[2]) || 0;
          const available = parseInt(parts[3]) || 0;
          const total = used + available;
          if (total > 0) {
            return Math.round((used / total) * 100);
          }
        }
      }
      return 0;
    } catch (error) {
      logger.warn("Failed to get disk usage:", error.message);
      return 0;
    }
  }

  // Get effective CPU count (container-aware)
  // Returns the number of CPUs available to this process, respecting container limits
  getEffectiveCpuCount() {
    try {
      const fs = require("fs");
      
      // Try cgroup v2 first (modern Docker/k8s)
      const cgroupV2Path = "/sys/fs/cgroup/cpu.max";
      if (fs.existsSync(cgroupV2Path)) {
        const content = fs.readFileSync(cgroupV2Path, "utf8").trim();
        const [quota, period] = content.split(" ");
        if (quota !== "max") {
          const effectiveCpus = parseInt(quota) / parseInt(period);
          if (effectiveCpus > 0) {
            return effectiveCpus;
          }
        }
      }
      
      // Try cgroup v1 (legacy Docker)
      const cgroupV1QuotaPath = "/sys/fs/cgroup/cpu/cpu.cfs_quota_us";
      const cgroupV1PeriodPath = "/sys/fs/cgroup/cpu/cpu.cfs_period_us";
      if (fs.existsSync(cgroupV1QuotaPath) && fs.existsSync(cgroupV1PeriodPath)) {
        const quota = parseInt(fs.readFileSync(cgroupV1QuotaPath, "utf8").trim());
        const period = parseInt(fs.readFileSync(cgroupV1PeriodPath, "utf8").trim());
        // quota of -1 means unlimited
        if (quota > 0 && period > 0) {
          const effectiveCpus = quota / period;
          if (effectiveCpus > 0) {
            return effectiveCpus;
          }
        }
      }
      
      // Fallback to host CPU count (bare metal or unlimited container)
      return os.cpus().length;
    } catch (error) {
      logger.warn("Failed to get effective CPU count:", error.message);
      return os.cpus().length;
    }
  }

  // Get process-level CPU usage as a percentage of available CPU
  // In containers: percentage of container CPU limit
  // On bare metal: percentage of total system CPU
  getProcessCpuUsage() {
    try {
      const now = Date.now();
      const elapsed = now - this.lastCpuTime;
      
      // Need at least 100ms between measurements for accuracy
      if (elapsed < 100) {
        return this._lastCpuPercent || 0;
      }

      const cpuUsage = process.cpuUsage(this.lastCpuUsage);
      
      // cpuUsage returns microseconds, elapsed is milliseconds
      // Total CPU time = user + system time
      const totalCpuMicros = cpuUsage.user + cpuUsage.system;
      const elapsedMicros = elapsed * 1000;
      
      // Get container-aware CPU count
      const effectiveCpus = this.getEffectiveCpuCount();
      
      // Calculate percentage of available CPU (can exceed 100% in edge cases)
      const cpuPercent = Math.round((totalCpuMicros / elapsedMicros / effectiveCpus) * 100);
      
      // Update tracking state for next measurement
      this.lastCpuUsage = process.cpuUsage();
      this.lastCpuTime = now;
      this._lastCpuPercent = cpuPercent;
      
      return this._lastCpuPercent;
    } catch (error) {
      logger.warn("Failed to get process CPU usage:", error.message);
      return 0;
    }
  }

  // Get resource usage
  async getResourceUsage() {
    try {
      return {
        memoryUsage: await this.getUniversalMemoryUsage(),
        cpuUsage: this.getProcessCpuUsage(),
        diskUsage: await this.getDiskUsage(),
        requestsPerMin: await this.getRequestsPerMinute(),
        // What the kernel counts against the container's limit, which includes
        // reclaimable page cache and so runs far above the process's own heap.
        container: require('./containerMemory').containerMemory(),
        eventLoop: require('./eventLoopLag').eventLoopLag(),
      };
    } catch (error) {
      logger.error("Error getting resource usage:", error);
      return {
        memoryUsage: 0,
        cpuUsage: 0,
        diskUsage: 0,
        requestsPerMin: 0,
      };
    }
  }

  // Get detailed heap profile with all in-memory cache sizes
  getHeapProfile() {
    const mem = process.memoryUsage();

    const caches = {};
    try { caches.cache = getCacheMemoryStats(); } catch {}
    try { caches.idMapper = getIdMapperMemoryStats(); } catch {}
    try { caches.tmdb = require('./getTmdb').getMemoryStats(); } catch {}
    try { caches.tvdb = require('./tvdb').getMemoryStats(); } catch {}
    try { caches.mal = require('./mal').getMemoryStats(); } catch {}
    try { caches.fanart = require('../utils/fanart').getMemoryStats(); } catch {}
    try { caches.trakt = getTraktMemoryStats(); } catch {}
    try {
      const anilist = require('./anilist');
      caches.anilist = anilist.getCacheStats ? anilist.getCacheStats() : { cache: 0 };
    } catch {}
    try {
      const configCache = require('./configCache');
      caches.configCache = { entries: configCache.cache.size, pendingLoads: configCache.pendingLoads.size };
    } catch {}

    const heapLimit = v8.getHeapStatistics().heap_size_limit;

    return {
      process: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
      },
      // Against the limit V8 will actually enforce, not the heap it has committed
      // so far. heapTotal grows on demand, so a ratio against it reads near 100%
      // on a perfectly healthy process and says nothing about how much room is
      // left. The limit is read from V8 rather than NODE_OPTIONS so it is present
      // whether or not anyone configured one.
      v8: {
        heapLimitMb: Math.round(heapLimit / 1024 / 1024),
        heapLimitConfigured: /--max-old-space-size=\d+/.test(process.env.NODE_OPTIONS || ''),
        heapUsedPct: heapLimit > 0 ? Math.round((mem.heapUsed / heapLimit) * 100) : 0,
      },
      caches,
      timestamp: Date.now(),
    };
  }

  // Get current requests per minute (rolling average over last 5 minutes)
  async getRequestsPerMinute() {
    try {
      if (!this.requestTracker) {
        return 0;
      }

      // Get the last hour's data to calculate recent rate
      const hourlyStats = await this.requestTracker.getHourlyStats(1);
      if (!hourlyStats || hourlyStats.length === 0) {
        return 0;
      }

      const currentHourData = hourlyStats[0];
      const currentHourRequests = currentHourData.requests || 0;

      // Calculate minutes elapsed in current hour
      const now = new Date();
      const minutesIntoHour = now.getMinutes() + (now.getSeconds() / 60);

      // Avoid division by zero at the start of an hour
      if (minutesIntoHour < 1) {
        return currentHourRequests; // Just return raw count for first minute
      }

      // Calculate requests per minute for current hour
      const requestsPerMin = Math.round(currentHourRequests / minutesIntoHour);
      return requestsPerMin;
    } catch (error) {
      logger.warn("Failed to get requests per minute:", error.message);
      return 0;
    }
  }

  // Get error logs
  async getErrorLogs() {
    try {
      // Get real error logs from request tracker
      const errorLogs = this.requestTracker
        ? await this.requestTracker.getErrorLogs(20)
        : [];

      // If no real errors, return empty array (no mock data)
      return errorLogs;
    } catch (error) {
      logger.error("Error getting error logs:", error);
      return [];
    }
  }

  // Get maintenance tasks
  async getMaintenanceTasks() {
    try {
      const tasks = [];

      // 1. Cache cleanup scheduler status
      try {
        const scheduler = getCacheCleanupScheduler();
        
        if (scheduler) {
          const schedulerStatus = scheduler.getStatus();
          const schedulerEnabled = process.env.CACHE_CLEANUP_AUTO_ENABLED !== 'false';
          
          tasks.push({
            id: 1,
            name: "Cache Cleanup",
            status: schedulerEnabled ? (schedulerStatus.isRunning ? "running" : "completed") : "disabled",
            lastRun: schedulerStatus.lastRun ? this.getTimeAgo(new Date(schedulerStatus.lastRun)) : "Never",
            description: "Removes expired keys from Redis cache (auto-scheduled every 6 hours)",
            nextRun: schedulerEnabled ? (schedulerStatus.nextRun ? this.getTimeUntil(new Date(schedulerStatus.nextRun)) : "Scheduled") : "Disabled",
            category: "cleanup"
          });
        }
      } catch (error) {
        logger.warn("Failed to get cache cleanup scheduler status:", error.message);
        tasks.push({
          id: 1,
          name: "Cache Cleanup",
          status: "error",
          lastRun: "Unknown",
          description: "Removes expired keys from Redis cache",
          nextRun: "Unknown",
          category: "cleanup"
        });
      }

      // 2. Anime-list XML update task - check actual update timestamps
      try {
        const animeListStats = getAnimeListXmlStats();
        
        if (this.cache) {
          const animeListLastUpdate = await this.cache.get(
            "anime_list:last_update",
          );
          const animeListStatus = animeListLastUpdate
            ? "completed"
            : "scheduled";
          const animeListTime = animeListLastUpdate
            ? this.getTimeAgo(new Date(parseInt(animeListLastUpdate)))
            : "Never";

          // Calculate actual next run time based on last update and interval
          let nextRunDisplay = "Now";
          if (animeListLastUpdate) {
            const lastUpdateTime = parseInt(animeListLastUpdate);
            const intervalMs = animeListStats.updateIntervalHours * 60 * 60 * 1000;
            const nextRunTime = lastUpdateTime + intervalMs;
            const now = Date.now();
            
            if (nextRunTime > now) {
              nextRunDisplay = this.getTimeUntil(new Date(nextRunTime));
            } else {
              nextRunDisplay = "Soon";
            }
          }

          tasks.push({
            id: 2,
            name: "Update anime-list XML",
            status: animeListStatus,
            lastRun: animeListTime,
            description: `Updates AniDB/TVDB/TMDB episode mappings (${animeListStats.count.toLocaleString()} entries)`,
            nextRun: nextRunDisplay,
            action: "restart",
            category: "mapping"
          });
        }
      } catch (error) {
        logger.warn(
          "Failed to get anime-list status:",
          error.message,
        );
        tasks.push({
          id: 2,
          name: "Update anime-list XML",
          status: "error",
          lastRun: "Unknown",
          description: "Updates AniDB/TVDB/TMDB episode mappings",
          nextRun: "Now",
          action: "restart",
          category: "mapping"
        });
      }

      // 3. ID Mapper update task - check actual update timestamps
      try {
        const idMapperStats = getIdMapperStats();
        
        if (this.cache) {
          const idMapperLastUpdate = await this.cache.get(
            "maintenance:last_id_mapper_update",
          );
          const idMapperStatus = idMapperLastUpdate ? "completed" : "scheduled";
          const idMapperTime = idMapperLastUpdate
            ? this.getTimeAgo(new Date(parseInt(idMapperLastUpdate)))
            : "Never";

          // Calculate actual next run time based on last update and interval
          let nextRunDisplay = "Now";
          if (idMapperLastUpdate) {
            const lastUpdateTime = parseInt(idMapperLastUpdate);
            const intervalMs = idMapperStats.updateIntervalHours * 60 * 60 * 1000;
            const nextRunTime = lastUpdateTime + intervalMs;
            const now = Date.now();
            
            if (nextRunTime > now) {
              nextRunDisplay = this.getTimeUntil(new Date(nextRunTime));
            } else {
              nextRunDisplay = "Soon";
            }
          }

          tasks.push({
            id: 3,
            name: "Update ID Mapper",
            status: idMapperStatus,
            lastRun: idMapperTime,
            description: `Updates TMDB/TVDB/IMDB/MAL/Kitsu ID mappings (${idMapperStats.count.toLocaleString()} entries)`,
            nextRun: nextRunDisplay,
            action: "restart",
            category: "mapping"
          });
        }
      } catch (error) {
        logger.warn(
          "Failed to get ID mapper status:",
          error.message,
        );
        tasks.push({
          id: 3,
          name: "Update ID Mapper",
          status: "error",
          lastRun: "Unknown",
          description: "Updates TMDB/TVDB/IMDB/MAL/Kitsu ID mappings",
          nextRun: "Now",
          action: "restart",
          category: "mapping"
        });
      }

      // 4. Kitsu-IMDB mapping update task
      try {
        const kitsuImdbStats = getKitsuImdbStats();
        
        if (this.cache) {
          const kitsuImdbLastUpdate = await this.cache.get(
            "maintenance:last_kitsu_imdb_update",
          );
          const kitsuImdbStatus = kitsuImdbLastUpdate
            ? "completed"
            : "scheduled";
          const kitsuImdbTime = kitsuImdbLastUpdate
            ? this.getTimeAgo(new Date(parseInt(kitsuImdbLastUpdate)))
            : "Never";

          // Calculate actual next run time based on last update and interval
          let nextRunDisplay = "Now";
          if (kitsuImdbLastUpdate) {
            const lastUpdateTime = parseInt(kitsuImdbLastUpdate);
            const intervalMs = kitsuImdbStats.updateIntervalHours * 60 * 60 * 1000;
            const nextRunTime = lastUpdateTime + intervalMs;
            const now = Date.now();
            
            if (nextRunTime > now) {
              nextRunDisplay = this.getTimeUntil(new Date(nextRunTime));
            } else {
              nextRunDisplay = "Soon";
            }
          }

          tasks.push({
            id: 4,
            name: "Update Kitsu-IMDB Mapping",
            status: kitsuImdbStatus,
            lastRun: kitsuImdbTime,
            description: `Updates Kitsu to IMDB ID mappings (${kitsuImdbStats.count.toLocaleString()} entries)`,
            nextRun: nextRunDisplay,
            action: "restart",
            category: "mapping"
          });
        }
      } catch (error) {
        logger.warn(
          "Failed to get Kitsu-IMDB status:",
          error.message,
        );
        tasks.push({
          id: 4,
          name: "Update Kitsu-IMDB Mapping",
          status: "error",
          lastRun: "Unknown",
          description: "Updates Kitsu to IMDB ID mappings",
          nextRun: "Now",
          action: "restart",
          category: "mapping"
        });
      }

      // 12. animeApi overlay update task
      try {
        const animeApiStats = getAnimeApiStats();

        if (this.cache && animeApiStats.enabled) {
          const animeApiLastUpdate = await this.cache.get(
            "maintenance:last_anime_api_update",
          );
          const animeApiStatus = animeApiLastUpdate ? "completed" : "scheduled";
          const animeApiTime = animeApiLastUpdate
            ? this.getTimeAgo(new Date(parseInt(animeApiLastUpdate)))
            : "Never";

          let nextRunDisplay = "Now";
          if (animeApiLastUpdate) {
            const lastUpdateTime = parseInt(animeApiLastUpdate);
            const intervalMs = animeApiStats.updateIntervalHours * 60 * 60 * 1000;
            const nextRunTime = lastUpdateTime + intervalMs;

            if (nextRunTime > Date.now()) {
              nextRunDisplay = this.getTimeUntil(new Date(nextRunTime));
            } else {
              nextRunDisplay = "Soon";
            }
          }

          const run = animeApiStats.lastRun;
          const detail = run
            ? `${animeApiStats.count.toLocaleString()} entries, backfilled ${run.rows.toLocaleString()}, merged ${run.merged.toLocaleString()}, added ${run.added.toLocaleString()}`
            : `${animeApiStats.count.toLocaleString()} entries`;

          tasks.push({
            id: 12,
            name: "Update animeApi Overlay",
            status: animeApiStatus,
            lastRun: animeApiTime,
            description: `Backfills MAL/AniList/Kitsu/AniDB ids the anime list no longer receives (${detail})`,
            nextRun: nextRunDisplay,
            action: "restart",
            category: "mapping"
          });
        }
      } catch (error) {
        logger.warn("Failed to get animeApi overlay status:", error.message);
        tasks.push({
          id: 12,
          name: "Update animeApi Overlay",
          status: "error",
          lastRun: "Unknown",
          description: "Backfills MAL/AniList/Kitsu/AniDB ids the anime list no longer receives",
          nextRun: "Now",
          action: "restart",
          category: "mapping"
        });
      }

      // 14. Filler data
      try {
        const { getFillerDataStats } = require('./fillerData');
        const fillerStats = getFillerDataStats();
        const status = !fillerStats.enabled
          ? "disabled"
          : fillerStats.running
            ? "running"
            : fillerStats.lastError
              ? "error"
              : fillerStats.loaded ? "completed" : "scheduled";

        let nextRunDisplay = "Disabled";
        if (fillerStats.enabled) {
          const nextRunTime = (fillerStats.lastCheck || 0) + fillerStats.refreshHours * 60 * 60 * 1000;
          nextRunDisplay = nextRunTime > Date.now() ? this.getTimeUntil(new Date(nextRunTime)) : "On next request";
        }
        const detail = fillerStats.lastError
          ? `last refresh failed: ${fillerStats.lastError}`
          : `${fillerStats.anime.toLocaleString()} anime${fillerStats.generated ? `, file built ${this.getTimeAgo(new Date(fillerStats.generated))}` : ""}`;

        tasks.push({
          id: 14,
          name: "Update Filler Data",
          status,
          lastRun: fillerStats.lastRefreshAt ? this.getTimeAgo(new Date(fillerStats.lastRefreshAt)) : "Never",
          description: `Filler, mixed canon/filler and recap episodes for anime (${detail})`,
          nextRun: nextRunDisplay,
          action: fillerStats.enabled ? "restart" : null,
          category: "mapping"
        });
      } catch (error) {
        logger.warn("Failed to get filler data status:", error.message);
        tasks.push({
          id: 14,
          name: "Update Filler Data",
          status: "error",
          lastRun: "Unknown",
          description: "Filler, mixed canon/filler and recap episodes for anime",
          nextRun: "Unknown",
          action: "restart",
          category: "mapping"
        });
      }

      // 13. Anime release schedule (AniSchedule), refreshed in memory as requests arrive
      try {
        const { getAnimeScheduleStats } = require('./animeAiringSchedule');
        const scheduleStats = getAnimeScheduleStats();
        const status = !scheduleStats.enabled
          ? "disabled"
          : scheduleStats.running
            ? "running"
            : scheduleStats.lastError
              ? "error"
              : scheduleStats.loaded ? "completed" : "scheduled";

        let nextRunDisplay = "Disabled";
        if (scheduleStats.enabled) {
          const nextRunTime = (scheduleStats.lastCheck || 0) + scheduleStats.refreshMinutes * 60 * 1000;
          nextRunDisplay = nextRunTime > Date.now() ? this.getTimeUntil(new Date(nextRunTime)) : "On next request";
        }

        const source = scheduleStats.sourceUpdatedAt
          ? `, source updated ${this.getTimeAgo(new Date(scheduleStats.sourceUpdatedAt))}${scheduleStats.stale ? ", stale: earliest times read from AniList" : ""}`
          : "";
        const detail = scheduleStats.lastError
          ? `last refresh failed: ${scheduleStats.lastError}`
          : `${scheduleStats.anime.toLocaleString()} anime, ${scheduleStats.dubbed.toLocaleString()} with dub times${source}`;

        tasks.push({
          id: 13,
          name: "Update Anime Release Schedule",
          status,
          lastRun: scheduleStats.lastRefreshAt ? this.getTimeAgo(new Date(scheduleStats.lastRefreshAt)) : "Never",
          description: `Earliest release and English dub times for anime episodes (${detail})`,
          nextRun: nextRunDisplay,
          action: scheduleStats.enabled ? "restart" : null,
          category: "mapping"
        });
      } catch (error) {
        logger.warn("Failed to get anime release schedule status:", error.message);
        tasks.push({
          id: 13,
          name: "Update Anime Release Schedule",
          status: "error",
          lastRun: "Unknown",
          description: "Earliest release and English dub times for anime episodes",
          nextRun: "Unknown",
          action: "restart",
          category: "mapping"
        });
      }

      // 5. ID Mappings update task (scheduled every WIKI_MAPPER_UPDATE_INTERVAL_HOURS)
      try {
        const wikiMapperStats = getIdMappingsStats();
        
        if (this.cache) {
          const wikiMapperLastUpdate = await this.cache.get(
            "maintenance:last_wiki_mapper_update",
          );
          const wikiMapperStatus = wikiMapperLastUpdate
            ? "completed"
            : "scheduled";
          const wikiMapperTime = wikiMapperLastUpdate
            ? this.getTimeAgo(new Date(parseInt(wikiMapperLastUpdate)))
            : "Never";

          // Calculate actual next run time based on last update and interval
          let nextRunDisplay = "Now";
          if (wikiMapperLastUpdate) {
            const lastUpdateTime = parseInt(wikiMapperLastUpdate);
            const intervalMs = wikiMapperStats.updateIntervalHours * 60 * 60 * 1000;
            const nextRunTime = lastUpdateTime + intervalMs;
            const now = Date.now();
            
            if (nextRunTime > now) {
              nextRunDisplay = this.getTimeUntil(new Date(nextRunTime));
            } else {
              nextRunDisplay = "Soon";
            }
          }

          tasks.push({
            id: 5,
            name: "Update ID Mappings",
            status: wikiMapperStatus,
            lastRun: wikiMapperTime,
            description: `Updates ID mappings from dins-mappings + Wikidata backfill (${wikiMapperStats.totalCount.toLocaleString()} entries, ${wikiMapperStats.backfilledCount.toLocaleString()} backfilled, every ${wikiMapperStats.updateIntervalHours}h)`,
            nextRun: nextRunDisplay,
            action: "restart",
            category: "mapping"
          });
        }
      } catch (error) {
        logger.warn(
          "Failed to get ID Mappings status:",
          error.message,
        );
        tasks.push({
          id: 5,
          name: "Update ID Mappings",
          status: "error",
          lastRun: "Unknown",
          description: "Updates ID mappings from dins-mappings + Wikidata backfill",
          nextRun: "Now",
          action: "restart",
          category: "mapping"
        });
      }

      // 11. IMDb Ratings update task (scheduled every IMDB_RATINGS_UPDATE_INTERVAL_HOURS)
      try {
        const imdbRatingsStats = getImdbRatingsStatsForDashboard();
        
        if (this.cache) {
          const imdbRatingsLastUpdate = await this.cache.get(
            "maintenance:last_imdb_ratings_update",
          );
          const imdbRatingsStatus = imdbRatingsLastUpdate
            ? "completed"
            : "scheduled";
          const imdbRatingsTime = imdbRatingsLastUpdate
            ? this.getTimeAgo(new Date(parseInt(imdbRatingsLastUpdate)))
            : "Never";

          // Calculate actual next run time based on last update and interval
          let nextRunDisplay = "Now";
          if (imdbRatingsLastUpdate) {
            const lastUpdateTime = parseInt(imdbRatingsLastUpdate);
            const intervalMs = imdbRatingsStats.updateIntervalHours * 60 * 60 * 1000;
            const nextRunTime = lastUpdateTime + intervalMs;
            const now = Date.now();
            
            if (nextRunTime > now) {
              nextRunDisplay = this.getTimeUntil(new Date(nextRunTime));
            } else {
              nextRunDisplay = "Soon";
            }
          }

          tasks.push({
            id: 11,
            name: "Update IMDb Ratings",
            status: imdbRatingsStatus,
            lastRun: imdbRatingsTime,
            description: `Updates IMDb ratings from official dataset (${imdbRatingsStats.count.toLocaleString()} ratings, every ${imdbRatingsStats.updateIntervalHours}h)`,
            nextRun: nextRunDisplay,
            action: "restart",
            category: "mapping"
          });
        }
      } catch (error) {
        logger.warn(
          "Failed to get IMDb Ratings status:",
          error.message,
        );
        tasks.push({
          id: 11,
          name: "Update IMDb Ratings",
          status: "error",
          lastRun: "Unknown",
          description: "Updates IMDb ratings from official dataset",
          nextRun: "Now",
          action: "restart",
          category: "mapping"
        });
      }

      // 7. Essential Cache Warming task
      try {
        const essentialStats = getEssentialWarmupStats();
        
        // Calculate next run display
        let nextRunDisplay = "Disabled";
        if (essentialStats.enabled) {
          if (essentialStats.isWarming) {
            nextRunDisplay = "Running";
          } else if (essentialStats.nextRun) {
            nextRunDisplay = this.getTimeUntil(new Date(essentialStats.nextRun));
          } else {
            // Fallback: calculate based on interval
            nextRunDisplay = `Every ${essentialStats.intervalMinutes || 30}m`;
          }
        }
        
        // When disabled, show "restart" (Force) button since this is a lightweight operation
        // that's safe to run manually even when auto-scheduling is disabled
        const essentialAction = essentialStats.isWarming ? "stop" : "restart";
        
        tasks.push({
          id: 7,
          name: "Essential Cache Warming",
          status: essentialStats.enabled ? (essentialStats.isWarming ? "running" : "completed") : "disabled",
          lastRun: essentialStats.lastRun ? this.getTimeAgo(new Date(essentialStats.lastRun)) : "Never",
          description: `Warms essential content (genres, studios, TMDB popular)${essentialStats.totalItems > 0 ? ` - ${essentialStats.totalItems} items` : ''}`,
          nextRun: nextRunDisplay,
          action: essentialAction,
          category: "warming"
        });
      } catch (error) {
        logger.warn("Failed to get essential warming status:", error.message);
        tasks.push({
          id: 7,
          name: "Essential Cache Warming",
          status: "error",
          lastRun: "Unknown",
          description: "Warms essential content (genres, studios, TMDB popular)",
          nextRun: "Unknown",
          action: "restart",
          category: "warming"
        });
      }

      // 8. MAL Catalog Warming task
      try {
        const malStats = getMALWarmupStats();
        
        // Build description - only show items count if there are items warmed
        let malDescription = "Warms MAL anime catalogs";
        if (malStats.itemsWarmed > 0) {
          malDescription += ` (${malStats.itemsWarmed} items warmed)`;
        }
        
        // When disabled, show "restart" (Force) button since this is a lightweight operation
        // that's safe to run manually even when auto-scheduling is disabled
        const malAction = malStats.isWarming ? "stop" : "restart";
        
        tasks.push({
          id: 8,
          name: "MAL Catalog Warming",
          status: malStats.enabled ? (malStats.isWarming ? "running" : "completed") : "disabled",
          lastRun: malStats.lastRun ? this.getTimeAgo(new Date(malStats.lastRun)) : "Never",
          description: malDescription,
          nextRun: malStats.enabled ? (malStats.nextRun ? this.getTimeUntil(new Date(malStats.nextRun)) : "Scheduled") : "Disabled",
          action: malAction,
          category: "warming"
        });
      } catch (error) {
        logger.warn("Failed to get MAL warming status:", error.message);
        tasks.push({
          id: 8,
          name: "MAL Catalog Warming",
          status: "error",
          lastRun: "Unknown",
          description: "Warms MAL anime catalogs",
          nextRun: "Unknown",
          action: "restart",
          category: "warming"
        });
      }

      // 9. Comprehensive Catalog Warming task
      try {
        const catalogStats = await getCatalogWarmupStats();
        
        // Build description with more context
        let description = `Warms all user catalogs`;
        if (catalogStats.totalUUIDs > 0) {
          description += ` (${catalogStats.totalUUIDs} user${catalogStats.totalUUIDs > 1 ? 's' : ''})`;
        }
        if (catalogStats.catalogsWarmed > 0 && catalogStats.totalCatalogs > 0) {
          description += ` - Last run: ${catalogStats.catalogsWarmed}/${catalogStats.totalCatalogs} catalogs, ${catalogStats.totalItems || 0} items`;
        } else if (catalogStats.totalItems > 0) {
          description += ` - Last run: ${catalogStats.totalItems} items warmed`;
        }
        
        // Only show action button if comprehensive warming is enabled
        // When disabled via CACHE_WARMUP_MODE, there's no way to enable it from dashboard
        const taskAction = catalogStats.enabled 
          ? (catalogStats.isRunning ? "stop" : "restart") 
          : null;
        
        tasks.push({
          id: 9,
          name: "Comprehensive Catalog Warming",
          status: catalogStats.enabled ? (catalogStats.isRunning ? "running" : "completed") : "disabled",
          lastRun: catalogStats.lastRun ? this.getTimeAgo(new Date(catalogStats.lastRun)) : "Never",
          description: description,
          nextRun: catalogStats.enabled ? (catalogStats.nextRun ? this.getTimeUntil(new Date(catalogStats.nextRun)) : "Scheduled") : "Disabled",
          action: taskAction,
          secondaryActions: (catalogStats.enabled && !catalogStats.isRunning)
            ? [
                { action: "warm-images", label: "Images", icon: "image", title: "Warm images only, leaving the catalog schedule where it is" },
                { action: "sync-ttl", label: "Sync TTL", icon: "clock", title: "Shorten catalog cache entries that outlive the next warmup, so it refreshes them instead of reading them back" },
              ]
            : null,
          category: "warming",
          warmingDetail: {
            isRunning: catalogStats.isRunning,
            catalogsWarmed: catalogStats.catalogsWarmed || 0,
            totalCatalogs: catalogStats.totalCatalogs || 0,
            totalItems: catalogStats.totalItems || 0,
            uuids: (catalogStats.config?.uuids || []).map(uuid => ({
              uuid: uuid.slice(0, 8),
              ...(catalogStats.uuidStats?.[uuid] || {}),
            })),
            images: getImageWarmDetail(),
          },
        });
      } catch (error) {
        logger.warn("Failed to get comprehensive warming status:", error.message);
        tasks.push({
          id: 9,
          name: "Comprehensive Catalog Warming",
          status: "error",
          lastRun: "Unknown",
          description: "Warms all user catalogs",
          nextRun: "Unknown",
          action: "restart",
          category: "warming"
        });
      }

      return tasks;
    } catch (error) {
      logger.error("Error getting maintenance tasks:", error);
      return [];
    }
  }

  // Check how many keys are expiring soon (without actually deleting them)
  async checkExpiredKeysCount() {
    try {
      if (!this.cache) {
        return { count: 0, totalKeys: 0, noTtlCount: 0, error: "Cache not available" };
      }

      const scanResult = await this.scanExpiringKeys();

      if (scanResult.noTtlCount > 1000) {
        logger.warn(`[Cache Cleanup] Found ${scanResult.noTtlCount} keys with no TTL (potential leaks)`);
      }

      return {
        count: scanResult.expiringCount,
        totalKeys: scanResult.totalKeys,
        noTtlCount: scanResult.noTtlCount
      };
    } catch (error) {
      logger.error("[Cache Cleanup Scheduler] Error checking expired keys:", error);
      return { count: 0, totalKeys: 0, noTtlCount: 0, error: error.message };
    }
  }

  async scanExpiringKeys(options = {}) {
    const {
      deleteKeys = false,
      scanCount = 1000,
      deleteBatchSize = 100
    } = options;

    if (!this.cache) {
      throw new Error("Cache not available");
    }

    let cursor = '0';
    let expiringCount = 0;
    let totalKeys = 0;
    let noTtlCount = 0;
    let deletedCount = 0;

    do {
      const reply = await this.cache.scan(cursor, 'COUNT', scanCount);
      cursor = reply[0];
      const keys = reply[1];

      if (keys.length === 0) {
        continue;
      }

      totalKeys += keys.length;

      const pipeline = this.cache.pipeline();
      keys.forEach(key => pipeline.ttl(key));
      const ttls = await pipeline.exec();

      const expiringKeysBatch = [];
      ttls.forEach(([err, ttl], index) => {
        if (err) {
          return;
        }

        if (ttl > 0 && ttl < 3600) {
          expiringCount++;

          if (deleteKeys) {
            const expiringKey = keys[index];
            if (expiringKey) {
              expiringKeysBatch.push(expiringKey);
            }
          }
        } else if (ttl === -1) {
          noTtlCount++;
        }
      });

      if (deleteKeys && expiringKeysBatch.length > 0) {
        for (let i = 0; i < expiringKeysBatch.length; i += deleteBatchSize) {
          const batch = expiringKeysBatch.slice(i, i + deleteBatchSize);
          await this.cache.del(...batch);
          deletedCount += batch.length;
        }
      }
    } while (cursor !== '0');

    return {
      expiringCount,
      totalKeys,
      noTtlCount,
      deletedCount
    };
  }

  // Smart cache cleanup scheduler
  async runScheduledCacheCleanup() {
    try {
      const cleanupResult = await this.scanExpiringKeys({ deleteKeys: true });

      if (cleanupResult.noTtlCount > 1000) {
        logger.warn(`[Cache Cleanup] Found ${cleanupResult.noTtlCount} keys with no TTL (potential leaks)`);
      }

      if (cleanupResult.deletedCount === 0) {
        return {
          success: true,
          skipped: true,
          message: `No expiring keys found out of ${cleanupResult.totalKeys} total keys`,
          clearedCount: 0,
          remainingCount: cleanupResult.totalKeys,
          noTtlCount: cleanupResult.noTtlCount
        };
      }

      await this.cache.set("maintenance:last_cache_cleanup", Date.now().toString());

      const finalKeyCount = await this.cache.dbsize();
      return {
        success: true,
        skipped: false,
        message: `Expired cache cleanup completed. Cleared ${cleanupResult.deletedCount} expiring keys. ${finalKeyCount} keys remain.`,
        clearedCount: cleanupResult.deletedCount,
        remainingCount: finalKeyCount,
        scannedKeyCount: cleanupResult.totalKeys,
        noTtlCount: cleanupResult.noTtlCount
      };
    } catch (error) {
      logger.error("[Cache Cleanup Scheduler] Error in scheduled cleanup:", error);
      return { success: false, skipped: false, message: error.message };
    }
  }

  // Clear expired cache entries (for maintenance task)
  async clearExpiredCacheEntries() {
    try {
      if (!this.cache) {
        throw new Error("Cache not available");
      }

      const cleanupResult = await this.scanExpiringKeys({ deleteKeys: true });

      if (cleanupResult.noTtlCount > 1000) {
        logger.warn(`[Cache Cleanup] Found ${cleanupResult.noTtlCount} keys with no TTL (potential leaks)`);
      }

      // Update maintenance task status
      await this.cache.set("maintenance:last_cache_cleanup", Date.now().toString());

      const finalKeyCount = await this.cache.dbsize();
      const message = `Expired cache cleanup completed. Cleared ${cleanupResult.deletedCount} expiring keys. ${finalKeyCount} keys remain.`;

      //logger.debug(`[Maintenance Task] ${message}`);
      return {
        success: true,
        message,
        clearedCount: cleanupResult.deletedCount,
        remainingCount: finalKeyCount,
        scannedKeyCount: cleanupResult.totalKeys,
        noTtlCount: cleanupResult.noTtlCount
      };
    } catch (error) {
      logger.error("[Maintenance Task] Error clearing expired cache entries:", error);
      return { success: false, message: error.message };
    }
  }

  async lookupTitleForMetaId(id) {
    if (!this.cache) return null;
    for (const type of ['series', 'movie']) {
      try {
        const raw = await this.cache.get(`content_metadata:${type}:${id}`);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed?.title) {
          return { title: parsed.title, year: parsed.year || null, type: parsed.type || type };
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  // Clear cache by type
  // Matches a meta id (suffix in the key) or catalog id (mid-key) by substring.
  async clearCacheByToken(token, { dryRun = false, includeColdStore = true } = {}) {
    try {
      if (!this.cache) throw new Error('Cache not available');

      const trimmed = String(token || '').trim();
      if (!trimmed) return { success: false, message: 'A meta id or catalog id is required' };
      if (trimmed.length < 3) {
        return { success: false, message: 'Token must be at least 3 characters' };
      }

      // A complete media id means one title, so match it exactly on both tiers.
      // Anything else (catalog ids, partial ids, free text) keeps substring
      // matching — catalog ids sit mid-key and would be missed by an exact match.
      const matchMode = isCompleteMediaId(trimmed) ? 'exact' : 'substring';

      const titleInfo = matchMode === 'exact' ? await this.lookupTitleForMetaId(trimmed) : null;

      const escaped = escapeRedisGlob(trimmed);
      const isPreserved = isPreservedCacheKey;

      let cursor = '0';
      let matched = 0;
      let deletedCount = 0;
      let skipped = 0;
      const samples = [];

      if (matchMode === 'exact') {
        deletedCount = await this.clearCacheForMetaId(trimmed, { dryRun, samples });
        matched = deletedCount;
      } else {
        do {
          const reply = await this.cache.scan(cursor, 'MATCH', `*${escaped}*`, 'COUNT', 1000);
          cursor = reply[0];
          const keys = reply[1] || [];
          if (keys.length === 0) continue;

          const deletable = [];
          for (const key of keys) {
            matched += 1;
            if (isPreserved(key)) { skipped += 1; continue; }
            if (samples.length < 10) samples.push(key);
            deletable.push(key);
          }

          if (!dryRun && deletable.length > 0) {
            for (let i = 0; i < deletable.length; i += 100) {
              const batch = deletable.slice(i, i + 100);
              await this.cache.del(...batch);
              deletedCount += batch.length;
            }
          } else {
            deletedCount += deletable.length;
          }
        } while (cursor !== '0');
      }

      let coldStoreCount = 0;
      try {
        const metaColdStore = require('./metaColdStore');
        if (includeColdStore && metaColdStore.isEnabled()) {
          if (matchMode === 'exact') {
            coldStoreCount = dryRun
              ? metaColdStore.countByMetaId(trimmed)
              : metaColdStore.invalidate(trimmed);
          } else {
            coldStoreCount = dryRun
              ? metaColdStore.countByToken(trimmed)
              : metaColdStore.invalidateByToken(trimmed);
          }
          // `deletedCount` stays Redis-only here; `total` below sums the tiers.
          matched += coldStoreCount;
        }
      } catch (error) {
        logger.warn(`[ColdStore] token purge failed for "${trimmed}": ${error.message}`);
      }

      const total = deletedCount + coldStoreCount;
      const noun = dryRun ? 'would be cleared' : 'cleared';
      const coldNote = coldStoreCount > 0
        ? ` (includes ${coldStoreCount.toLocaleString()} cold-store row${coldStoreCount === 1 ? '' : 's'})`
        : '';
      const modeNote = matchMode === 'exact'
        ? 'this title only'
        : 'any key containing this text';
      const message = total === 0
        ? `No cache entries match "${trimmed}" (${modeNote})`
        : `${total.toLocaleString()} entries ${noun} for "${trimmed}" — ${modeNote}${coldNote}`
          + (skipped > 0 ? ` (${skipped} protected key${skipped === 1 ? '' : 's'} skipped)` : '');

      if (!dryRun && total > 0) {
        logger.info(`Cleared ${total} cache entries for "${trimmed}" [${matchMode}]${coldNote}`);
      }

      return {
        success: true, dryRun, token: trimmed, matchMode, titleInfo,
        matched, deletedCount: total, redisCount: deletedCount,
        skipped, coldStoreCount, samples, message,
      };
    } catch (error) {
      logger.error('Error clearing cache by token:', error);
      return { success: false, message: error.message };
    }
  }

  /**
   * Delete the Redis entries belonging to exactly one title.
   * Meta keys are `e<epoch>:meta-h:<hash>:<metaId>` (one hash per title), so the
   * metaId is the trailing segment and the pattern is anchored to the end.
   */
  async clearCacheForMetaId(metaId, { dryRun = false, samples = null } = {}) {
    if (!this.cache) throw new Error('Cache not available');
    const trimmed = String(metaId || '').trim();
    if (!trimmed) return 0;

    const pattern = `*:${escapeRedisGlob(trimmed)}`;
    let cursor = '0';
    let deleted = 0;

    do {
      const reply = await this.cache.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
      cursor = reply[0];
      const keys = (reply[1] || []).filter((k) => !isPreservedCacheKey(k));
      if (samples) {
        for (const k of keys) if (samples.length < 10) samples.push(k);
      }
      if (dryRun) {
        deleted += keys.length;
        continue;
      }
      for (let i = 0; i < keys.length; i += 100) {
        const batch = keys.slice(i, i + 100);
        await this.cache.del(...batch);
        deleted += batch.length;
      }
    } while (cursor !== '0');

    return deleted;
  }

  async clearCache(type) {
    try {
      if (!this.cache) {
        throw new Error("Cache not available");
      }

      let deletedCount = 0;
      let cursor = '0';
      
      switch (type) {
        case "all":
          do {
            const reply = await this.cache.scan(cursor, 'COUNT', 1000);
            cursor = reply[0];
            const keys = reply[1];
            
            if (keys.length > 0) {
              const keysToDelete = keys.filter(key => !isPreservedCacheKey(key));
              
              if (keysToDelete.length > 0) {
                const batchSize = 100;
                for (let i = 0; i < keysToDelete.length; i += batchSize) {
                  const batch = keysToDelete.slice(i, i + batchSize);
                  await this.cache.del(...batch);
                }
                deletedCount += keysToDelete.length;
              }
            }
          } while (cursor !== '0');

          // Wait for cache warming to complete
          await new Promise((resolve) => setTimeout(resolve, 3000));
          break;
          
        case "expired": {
          const cleanupResult = await this.scanExpiringKeys({ deleteKeys: true });
          deletedCount = cleanupResult.deletedCount;
          break;
        }
          
        case "metadata":
          // Clear metadata-related keys using SCAN with MATCH
          do {
            const reply = await this.cache.scan(cursor, 'MATCH', '*meta*', 'COUNT', 1000);
            cursor = reply[0];
            const keys = (reply[1] || []).filter(key => !isPreservedCacheKey(key));

            if (keys.length > 0) {
              const batchSize = 100;
              for (let i = 0; i < keys.length; i += batchSize) {
                const batch = keys.slice(i, i + batchSize);
                await this.cache.del(...batch);
              }
              deletedCount += keys.length;
            }
          } while (cursor !== '0');
          break;
          
        default:
          throw new Error(`Unknown cache type: ${type}`);
      }

      // Get final key count after clearing
      const finalKeyCount = await this.cache.dbsize();

      let message;
      if (deletedCount === 0) {
        message = `No ${type} cache entries found to clear`;
      } else if (type === "all") {
        message = `Cleared ${deletedCount.toLocaleString()} keys. ${finalKeyCount.toLocaleString()} essential keys preserved`;
      } else {
        message = `Cleared ${deletedCount.toLocaleString()} ${type} cache entries`;
      }

      return { success: true, message, keyCount: finalKeyCount, deletedCount };
    } catch (error) {
      logger.error("Error clearing cache:", error);
      return { success: false, message: error.message };
    }
  }

  // Get IMDb ratings statistics
  async getImdbRatingsStats() {
    try {
      return getRatingsStats();
    } catch (error) {
      logger.error("Error getting IMDb ratings stats:", error);
      return {
        totalRequests: 0,
        datasetHits: 0,
        cinemetaFallbackHits: 0,
        datasetPercentage: 0,
        cinemetaPercentage: 0,
        datasetAvgTime: 0,
        cinemetaAvgTime: 0,
        ratingsLoaded: 0,
      };
    }
  }

  // Get all dashboard data
  async getAllDashboardData() {
    try {
      const [
        systemOverview,
        quickStats,
        cachePerformance,
        providerPerformance,
        systemConfig,
        resourceUsage,
        errorLogs,
        maintenanceTasks,
        imdbRatingsStats,
      ] = await Promise.all([
        this.getSystemOverview(),
        this.getQuickStats(),
        this.getCachePerformance(),
        this.getProviderPerformance(),
        this.getSystemConfig(),
        this.getResourceUsage(),
        this.getErrorLogs(),
        this.getMaintenanceTasks(),
        this.getImdbRatingsStats(),
      ]);

      return {
        systemOverview,
        quickStats,
        cachePerformance,
        providerPerformance,
        systemConfig,
        resourceUsage,
        errorLogs,
        maintenanceTasks,
        imdbRatingsStats,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error("Error getting all dashboard data:", error);
      throw error;
    }
  }

  // Get user statistics and activity data with simplified methodology
  async getUserStats() {
    try {
      // Use database as primary source for total users (most accurate)
      let totalUsers = 0;
      let activeUsers = 0;
      let newUsersToday = 0;

      if (this.database) {
        try {
          // Total users = non-deleted users in database
          const userUUIDs = await this.database.getAllUserUUIDs();
          totalUsers = userUUIDs.length;

          // New users today from database
          newUsersToday = await this.database.getUsersCreatedToday();
        } catch (dbError) {
          logger.warn(
            "Database query failed:",
            dbError.message,
          );
        }
      }

      // Use request tracker only for active users (better for real-time activity)
      if (this.requestTracker) {
        activeUsers = await this.requestTracker.getActiveUsers("15min"); // Active in last 15 minutes
      }

      // Get total requests from request tracker
      const requestStats = this.requestTracker
        ? await this.requestTracker.getStats()
        : { totalRequests: 0 };

      // Get recent user activity (last 24 hours of requests)
      const userActivity = await this.getRecentUserActivity();

      // Access control stats (simplified - in a real system you'd track these)
      const accessControl = {
        adminUsers: 0, // No admin system implemented yet
        apiKeyUsers: totalUsers, // All users have API access
        rateLimitedUsers: 0, // No rate limiting implemented yet
        blockedUsers: 0, // No blocking system implemented yet
      };

      logger.debug(
        `User Stats - Total: ${totalUsers}, Active: ${activeUsers}, New Today: ${newUsersToday}`,
      );

      return {
        totalUsers,
        activeUsers,
        newUsersToday,
        totalRequests: requestStats.totalRequests || 0,
        userActivity,
        accessControl,
      };
    } catch (error) {
      logger.error("Error getting user stats:", error);
      return {
        totalUsers: 0,
        activeUsers: 0,
        newUsersToday: 0,
        totalRequests: 0,
        userActivity: [],
        accessControl: {
          adminUsers: 0,
          apiKeyUsers: 0,
          rateLimitedUsers: 0,
          blockedUsers: 0,
        },
      };
    }
  }

  // Get recent user activity from improved request tracking
  async getRecentUserActivity() {
    try {
      if (!this.requestTracker) return [];

      // Get recent user activities from the improved tracking system
      const recentActivities =
        await this.requestTracker.getRecentUserActivities(50); // Get last 50 activities

      // Group by user identifier and create activity entries
      const userActivityMap = new Map();

      recentActivities.forEach((activity) => {
        const userHash = activity.identifier || "anonymous";
        if (!userActivityMap.has(userHash)) {
          userActivityMap.set(userHash, {
            id: userHash,
            username: activity.displayName ? `User ${activity.displayName}` : `User ${userHash.substring(0, 8)}`,
            lastSeen: activity.timestamp,
            requests: 0,
            status: "active",
            userAgent: activity.userAgent,
            lastEndpoint: activity.endpoint,
            anonymizedIP: activity.anonymizedIP || "unknown",
          });
        }

        const user = userActivityMap.get(userHash);
        user.requests++;

        // Update last seen to most recent request
        if (new Date(activity.timestamp) > new Date(user.lastSeen)) {
          user.lastSeen = activity.timestamp;
          user.lastEndpoint = activity.endpoint;
        }
      });

      // Convert to array and sort by last seen (most recent first)
      const userActivity = Array.from(userActivityMap.values())
        .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen))
        .slice(0, 10); // Show top 10 most active users

      // Format timestamps for display
      return userActivity.map((user) => ({
        ...user,
        lastSeen: this.formatTimeAgo(user.lastSeen),
        status: this.determineUserStatus(user.lastSeen),
      }));
    } catch (error) {
      logger.error(
        "Error getting recent user activity:",
        error,
      );
      return [];
    }
  }

  // Format timestamp as "time ago" string
  formatTimeAgo(timestamp) {
    const now = new Date();
    const time = new Date(timestamp);
    const diffMs = now - time;
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

  // Determine user status based on last activity
  determineUserStatus(lastSeen) {
    const now = new Date();
    const time = new Date(lastSeen);
    const diffMins = Math.floor((now - time) / 60000);

    if (diffMins < 5) return "active";
    if (diffMins < 60) return "idle";
    return "offline";
  }

  // Get dashboard configuration for guest mode and admin key status
  getConfig() {
    const disableGuestMode = process.env.DISABLE_GUEST_MODE === 'true' || 
                             process.env.DISABLE_GUEST_MODE === '1';
    const viewerMax = parseInt(process.env.LOG_VIEWER_MAX_ENTRIES || '10000', 10);
    return {
      guestModeEnabled: !disableGuestMode,
      adminKeyConfigured: !!process.env.ADMIN_KEY,
      jellyfinEnabled: String(require('./settingsService').getSetting('JELLYFIN_API_ENABLED') || '').trim().toLowerCase() === 'true',
      logViewerMaxEntries: Number.isFinite(viewerMax) && viewerMax > 0 ? viewerMax : 10000
    };
  }
}

module.exports = DashboardAPI;
