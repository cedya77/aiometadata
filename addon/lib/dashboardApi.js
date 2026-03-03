const os = require("os");
const process = require("process");
const consola = require('consola');
const logger = consola.withTag('DashboardAPI');

const { getCacheHealth } = require('./getCache');
const { getCacheCleanupScheduler } = require('./cacheCleanupScheduler');
const { getAnimeListXmlStats } = require('./anime-list-mapper');
const { getIdMapperStats, getKitsuImdbStats } = require('./id-mapper');
const { getWikiMapperStats } = require('./wiki-mapper');
const { getImdbRatingsStatsForDashboard, getRatingsStats } = require('./imdbRatings');
const { getWarmupStats: getEssentialWarmupStats } = require('./cacheWarmer');
const { getWarmupStats: getMALWarmupStats } = require('./malCatalogWarmer');
const { getWarmupStats: getCatalogWarmupStats } = require('./comprehensiveCatalogWarmer');

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
        // NO_CACHE mode - don't show as issue
        logger.info("[Dashboard API] Redis disabled (NO_CACHE mode)");
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
            evictionRate: 2.1, // TODO: Calculate real eviction rate from Redis stats
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
            evictionRate: 0,
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
        evictionRate: 0,
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
        evictionRate: 0,
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
          keyStatus: (process.env.TMDB_API || process.env.BUILT_IN_TMDB_API) 
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
          keyStatus: null, // Doesn't require API key
          requiresKey: false,
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
          keyStatus: process.env.MDBLIST_API_KEY 
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
          keyStatus: process.env.GEMINI_API_KEY 
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

      const today = new Date().toISOString().split("T")[0];
      const providerStatus = await Promise.all(
        providers.map(async (provider) => {
          try {
            const providerKey = provider.name.toLowerCase();

            // Get today's success/error counts
            const successCount = parseInt(await this.cache.get(`provider_success:${providerKey}:${today}`)) || 0;
            const errorCount = parseInt(await this.cache.get(`provider_errors:${providerKey}:${today}`)) || 0;
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
            
            if (totalCalls === 0) {
              // No calls today - can't determine status
              status = "unknown";
            } else if (successRate !== null) {
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
                callsToday: totalCalls,
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

      // Load all user configurations to aggregate statistics
      let userConfigs = [];
      let totalUsers = 0;

      try {
        if (this.database) {
          // Get all user UUIDs from the database
          const userUUIDs = await this.database.getAllUserUUIDs();
          totalUsers = userUUIDs.length;

          // Sample some configurations for analysis (up to 100 for performance)
          const sampleUUIDs = userUUIDs.slice(0, 100);
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
      artProviders: { movie: {}, series: {}, anime: {} },
      animeIdProviders: {},
      features: {
        skipFiller: 0,
        skipRecap: 0,
        mdblistWatchTracking: 0,
        anilistWatchTracking: 0,
        simklWatchTracking: 0,
        traktWatchTracking: 0,
        ratingPostersRpdb: 0,
        ratingPostersTop: 0,
        aiSearchEnabled: 0,
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

      // Art providers
      if (config.artProviders) {
        // Handle movie art providers
        const movieArtConfig = config.artProviders.movie;
        if (typeof movieArtConfig === "string") {
          // Legacy string format
          const movieArt = movieArtConfig || config.providers?.movie || "tmdb";
          stats.artProviders.movie[movieArt] =
            (stats.artProviders.movie[movieArt] || 0) + 1;
        } else if (
          typeof movieArtConfig === "object" &&
          movieArtConfig !== null
        ) {
          // New nested object format - track each art type
          const posterProvider =
            movieArtConfig.poster || config.providers?.movie || "tmdb";
          const backgroundProvider =
            movieArtConfig.background || config.providers?.movie || "tmdb";
          const logoProvider =
            movieArtConfig.logo || config.providers?.movie || "tmdb";

          stats.artProviders.movie[`${posterProvider} (poster)`] =
            (stats.artProviders.movie[`${posterProvider} (poster)`] || 0) + 1;
          stats.artProviders.movie[`${backgroundProvider} (background)`] =
            (stats.artProviders.movie[`${backgroundProvider} (background)`] ||
              0) + 1;
          stats.artProviders.movie[`${logoProvider} (logo)`] =
            (stats.artProviders.movie[`${logoProvider} (logo)`] || 0) + 1;
        }

        // Handle series art providers
        const seriesArtConfig = config.artProviders.series;
        if (typeof seriesArtConfig === "string") {
          // Legacy string format
          const seriesArt =
            seriesArtConfig || config.providers?.series || "tvdb";
          stats.artProviders.series[seriesArt] =
            (stats.artProviders.series[seriesArt] || 0) + 1;
        } else if (
          typeof seriesArtConfig === "object" &&
          seriesArtConfig !== null
        ) {
          // New nested object format - track each art type
          const posterProvider =
            seriesArtConfig.poster || config.providers?.series || "tvdb";
          const backgroundProvider =
            seriesArtConfig.background || config.providers?.series || "tvdb";
          const logoProvider =
            seriesArtConfig.logo || config.providers?.series || "tvdb";

          stats.artProviders.series[`${posterProvider} (poster)`] =
            (stats.artProviders.series[`${posterProvider} (poster)`] || 0) + 1;
          stats.artProviders.series[`${backgroundProvider} (background)`] =
            (stats.artProviders.series[`${backgroundProvider} (background)`] ||
              0) + 1;
          stats.artProviders.series[`${logoProvider} (logo)`] =
            (stats.artProviders.series[`${logoProvider} (logo)`] || 0) + 1;
        }

        // Handle anime art providers
        const animeArtConfig = config.artProviders.anime;
        if (typeof animeArtConfig === "string") {
          // Legacy string format
          const animeArt = animeArtConfig || config.providers?.anime || "mal";
          stats.artProviders.anime[animeArt] =
            (stats.artProviders.anime[animeArt] || 0) + 1;
        } else if (
          typeof animeArtConfig === "object" &&
          animeArtConfig !== null
        ) {
          // New nested object format - track each art type
          const posterProvider =
            animeArtConfig.poster || config.providers?.anime || "mal";
          const backgroundProvider =
            animeArtConfig.background || config.providers?.anime || "mal";
          const logoProvider =
            animeArtConfig.logo || config.providers?.anime || "mal";

          stats.artProviders.anime[`${posterProvider} (poster)`] =
            (stats.artProviders.anime[`${posterProvider} (poster)`] || 0) + 1;
          stats.artProviders.anime[`${backgroundProvider} (background)`] =
            (stats.artProviders.anime[`${backgroundProvider} (background)`] ||
              0) + 1;
          stats.artProviders.anime[`${logoProvider} (logo)`] =
            (stats.artProviders.anime[`${logoProvider} (logo)`] || 0) + 1;
        }
      }

      // Feature usage
      if (config.mal?.skipFiller) stats.features.skipFiller++;
      if (config.mal?.skipRecap) stats.features.skipRecap++;
      if (config.mdblistWatchTracking) stats.features.mdblistWatchTracking++;
      if (config.anilistWatchTracking) stats.features.anilistWatchTracking++;
      if (config.simklWatchTracking) stats.features.simklWatchTracking++;
      if (config.traktWatchTracking) stats.features.traktWatchTracking++;
      config.posterRatingProvider === 'top' ? stats.features.ratingPostersTop++ : stats.features.ratingPostersRpdb++;
      if (config.search?.ai_enabled) stats.features.aiSearchEnabled++;
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

    return {
      languages: formatDistribution(stats.languages),
      metaProviders: {
        movie: formatDistribution(stats.metaProviders.movie),
        series: formatDistribution(stats.metaProviders.series),
        anime: formatDistribution(stats.metaProviders.anime),
      },
      artProviders: {
        movie: formatDistribution(stats.artProviders.movie),
        series: formatDistribution(stats.artProviders.series),
        anime: formatDistribution(stats.artProviders.anime),
      },
      animeIdProviders: formatDistribution(stats.animeIdProviders),
      features: {
        skipFiller: Math.round((stats.features.skipFiller / total) * 100),
        skipRecap: Math.round((stats.features.skipRecap / total) * 100),
        mdblistWatchTracking: Math.round((stats.features.mdblistWatchTracking / total) * 100),
        anilistWatchTracking: Math.round((stats.features.anilistWatchTracking / total) * 100),
        simklWatchTracking: Math.round((stats.features.simklWatchTracking / total) * 100),
        traktWatchTracking: Math.round((stats.features.traktWatchTracking / total) * 100),
        ratingPostersRpdb: Math.round((stats.features.ratingPostersRpdb / total) * 100),
        ratingPostersTop: Math.round((stats.features.ratingPostersTop / total) * 100),
        aiSearchEnabled: Math.round((stats.features.aiSearchEnabled / total) * 100),
      },
    };
  }

  // Get default stats when no user data is available
  getDefaultStats() {
    return {
      languages: [{ name: "en-US", count: 0, percentage: 100 }],
      metaProviders: {
        movie: [{ name: "tmdb", count: 0, percentage: 100 }],
        series: [{ name: "tvdb", count: 0, percentage: 100 }],
        anime: [{ name: "mal", count: 0, percentage: 100 }],
      },
      artProviders: {
        movie: [{ name: "tmdb", count: 0, percentage: 100 }],
        series: [{ name: "tvdb", count: 0, percentage: 100 }],
        anime: [{ name: "mal", count: 0, percentage: 100 }],
      },
      animeIdProviders: [{ name: "imdb", count: 0, percentage: 100 }],
      features: {
        skipFiller: 0,
        skipRecap: 0,
        mdblistWatchTracking: 0,
        anilistWatchTracking: 0,
        simklWatchTracking: 0,
        traktWatchTracking: 0,
        ratingPostersRpdb: 0,
        ratingPostersTop: 0,
        aiSearchEnabled: 0,
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

      // 5. Wikidata Mappings update task (scheduled every WIKI_MAPPER_UPDATE_INTERVAL_HOURS)
      try {
        const wikiMapperStats = getWikiMapperStats();
        
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
            name: "Update Wikidata Mappings",
            status: wikiMapperStatus,
            lastRun: wikiMapperTime,
            description: `Updates ID mappings from Wikidata (${wikiMapperStats.totalCount.toLocaleString()} entries, every ${wikiMapperStats.updateIntervalHours}h)`,
            nextRun: nextRunDisplay,
            action: "restart",
            category: "mapping"
          });
        }
      } catch (error) {
        logger.warn(
          "Failed to get Wikidata Mapper status:",
          error.message,
        );
        tasks.push({
          id: 5,
          name: "Update Wikidata Mappings",
          status: "error",
          lastRun: "Unknown",
          description: "Updates ID mappings from Wikidata",
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
          category: "warming"
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
        return { count: 0, error: "Cache not available" };
      }

      let cursor = '0';
      let expiredCount = 0;
      let totalKeys = 0;
      let noTtlCount = 0;

      do {
        const reply = await this.cache.scan(cursor, 'COUNT', 1000);
        cursor = reply[0];
        const keys = reply[1];
        
        if (keys.length > 0) {
          totalKeys += keys.length;
          
          // Pipeline TTL commands for performance
          const pipeline = this.cache.pipeline();
          keys.forEach(key => pipeline.ttl(key));
          const ttls = await pipeline.exec();
          
          ttls.forEach(([err, ttl]) => {
            if (!err) {
              if (ttl > 0 && ttl < 3600) { // Less than 1 hour remaining
                expiredCount++;
              } else if (ttl === -1) {
                noTtlCount++;
              }
            }
          });
        }
      } while (cursor !== '0');

      if (noTtlCount > 1000) {
        logger.warn(`[Cache Cleanup] Found ${noTtlCount} keys with no TTL (potential leaks)`);
      }

      return { count: expiredCount, totalKeys, noTtlCount };
    } catch (error) {
      logger.error("[Cache Cleanup Scheduler] Error checking expired keys:", error);
      return { count: 0, error: error.message };
    }
  }

  // Smart cache cleanup scheduler
  async runScheduledCacheCleanup() {
    try {
      //logger.debug("[Cache Cleanup Scheduler] Starting scheduled cleanup check...");
      
      // Check if cleanup is needed
      const checkResult = await this.checkExpiredKeysCount();
      
      if (checkResult.error) {
        logger.error("[Cache Cleanup Scheduler] Failed to check keys:", checkResult.error);
        return;
      }

      if (checkResult.count === 0) {
        //logger.debug("[Cache Cleanup Scheduler] No expired keys found, skipping cleanup");
        return;
      }

      //logger.debug(`[Cache Cleanup Scheduler] Found ${checkResult.count} expired keys out of ${checkResult.totalKeys} total keys`);
      
      // Run the actual cleanup
      const cleanupResult = await this.clearExpiredCacheEntries();
      
      if (cleanupResult.success) {
        //logger.debug(`[Cache Cleanup Scheduler] Scheduled cleanup completed: ${cleanupResult.message}`);
      } else {
        logger.error(`[Cache Cleanup Scheduler] Scheduled cleanup failed: ${cleanupResult.message}`);
      }
      
    } catch (error) {
      logger.error("[Cache Cleanup Scheduler] Error in scheduled cleanup:", error);
    }
  }

  // Clear expired cache entries (for maintenance task)
  async clearExpiredCacheEntries() {
    try {
      if (!this.cache) {
        throw new Error("Cache not available");
      }

      //logger.debug("[Maintenance Task] Starting expired cache cleanup...");
      
      let cursor = '0';
      const expiredKeys = [];
      
      do {
        const reply = await this.cache.scan(cursor, 'COUNT', 1000);
        cursor = reply[0];
        const keys = reply[1];
        
        if (keys.length > 0) {
          const pipeline = this.cache.pipeline();
          keys.forEach(key => pipeline.ttl(key));
          const ttls = await pipeline.exec();
          
          ttls.forEach(([err, ttl], index) => {
            if (!err && ttl > 0 && ttl < 3600) { // Less than 1 hour remaining
              expiredKeys.push(keys[index]);
            }
          });
        }
      } while (cursor !== '0');

      //logger.debug(`[Maintenance Task] Found ${expiredKeys.length} expired keys to clear`);

      // Delete expired keys in batches to avoid overwhelming Redis
      if (expiredKeys.length > 0) {
        const batchSize = 100;
        for (let i = 0; i < expiredKeys.length; i += batchSize) {
          const batch = expiredKeys.slice(i, i + batchSize);
          await this.cache.del(...batch);
          //logger.debug(`[Maintenance Task] Cleared batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(expiredKeys.length / batchSize)}`);
        }
      }

      // Update maintenance task status
      await this.cache.set("maintenance:last_cache_cleanup", Date.now().toString());

      const finalKeyCount = await this.cache.dbsize();
      const message = `Expired cache cleanup completed. Cleared ${expiredKeys.length} expired keys. ${finalKeyCount} keys remain.`;

      //logger.debug(`[Maintenance Task] ${message}`);
      return { success: true, message, clearedCount: expiredKeys.length, remainingCount: finalKeyCount };
    } catch (error) {
      logger.error("[Maintenance Task] Error clearing expired cache entries:", error);
      return { success: false, message: error.message };
    }
  }

  // Clear cache by type
  async clearCache(type) {
    try {
      if (!this.cache) {
        throw new Error("Cache not available");
      }

      // Keys to preserve during "all" cache clear (maintenance tracking, system state)
      const preservePatterns = [
        'maintenance:*',           // Maintenance task timestamps
        'cache-warming:*',         // Cache warming timestamps
        'catalog-warmup:*',        // Comprehensive warming state
        'anime_list:last_update',  // Anime-list XML update timestamp
        'addon:start_time',        // Uptime tracking
        'system:app_version',      // Version tracking
        'imdb:ratings',            // IMDb ratings hash (essential, large dataset)
        'imdb-ratings-etag',       // IMDb ratings ETag for update checking
      ];

      let deletedCount = 0;
      let cursor = '0';
      
      switch (type) {
        case "all":
          do {
            const reply = await this.cache.scan(cursor, 'COUNT', 1000);
            cursor = reply[0];
            const keys = reply[1];
            
            if (keys.length > 0) {
              // Filter out keys that should be preserved
              const keysToDelete = keys.filter(key => {
                return !preservePatterns.some(pattern => {
                  if (pattern.endsWith('*')) {
                    return key.startsWith(pattern.slice(0, -1));
                  }
                  return key === pattern;
                });
              });
              
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
          
        case "expired":
          // Clear keys that are close to expiration (TTL < 1 hour)
          const expiredKeys = [];
          
          do {
            const reply = await this.cache.scan(cursor, 'COUNT', 1000);
            cursor = reply[0];
            const keys = reply[1];
            
            if (keys.length > 0) {
              const pipeline = this.cache.pipeline();
              keys.forEach(key => pipeline.ttl(key));
              const ttls = await pipeline.exec();
              
              ttls.forEach(([err, ttl], index) => {
                if (!err && ttl > 0 && ttl < 3600) { // Less than 1 hour remaining
                  expiredKeys.push(keys[index]);
                }
              });
            }
          } while (cursor !== '0');

          if (expiredKeys.length > 0) {
            const batchSize = 100;
            for (let i = 0; i < expiredKeys.length; i += batchSize) {
              const batch = expiredKeys.slice(i, i + batchSize);
              await this.cache.del(...batch);
            }
            deletedCount = expiredKeys.length;
          }
          break;
          
        case "metadata":
          // Clear metadata-related keys using SCAN with MATCH
          do {
            const reply = await this.cache.scan(cursor, 'MATCH', '*meta*', 'COUNT', 1000);
            cursor = reply[0];
            const keys = reply[1];
            
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
            username: `User ${userHash.substring(0, 8)}`, // Anonymous display name
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
    return {
      guestModeEnabled: !disableGuestMode,
      adminKeyConfigured: !!process.env.ADMIN_KEY
    };
  }
}

module.exports = DashboardAPI;
