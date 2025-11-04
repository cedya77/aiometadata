const os = require("os");
const process = require("process");

class DashboardAPI {
  constructor(cache, idMapper, config, database, requestTracker) {
    this.cache = cache || null;
    this.idMapper = idMapper || null;
    this.config = config || {};
    this.database = database || null;
    this.requestTracker = requestTracker || null;
    this.startTime = Date.now();
    this.uptimeInitialized = false;

    // Initialize persistent uptime tracking (async, don't await in constructor)
    this.initializePersistentUptime()
      .then(() => {
        this.uptimeInitialized = true;
      })
      .catch((err) => {
        console.error("[Dashboard API] Failed to initialize uptime:", err);
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
          console.log("[Dashboard API] Initialized persistent uptime tracking");
        }
      }
    } catch (error) {
      console.warn(
        "[Dashboard API] Failed to initialize persistent uptime:",
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
          console.log(
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
      console.warn("[Dashboard API] Redis not ready, using process uptime");
      const processUptime = process.uptime();
      const hours = Math.floor(processUptime / 3600);
      const minutes = Math.floor((processUptime % 3600) / 60);

      return {
        uptime: `${hours}h ${minutes}m`,
        uptimeSeconds: Math.floor(processUptime),
        startTime: new Date(Date.now() - processUptime * 1000).toISOString(),
      };
    } catch (error) {
      console.warn(
        "[Dashboard API] Failed to get persistent uptime:",
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
        console.log(`[Dashboard API] Redis status: ${this.cache.status}`);
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
        console.log("[Dashboard API] Redis disabled (NO_CACHE mode)");
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

      // Get real cache hit rate from request tracker
      const cacheHitRate = this.requestTracker
        ? await this.requestTracker.getCacheHitRate()
        : 0;

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
      console.error("[Dashboard API] Error getting quick stats:", error);
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
          const { getCacheHealth } = require('./getCache');
          const cacheHealth = getCacheHealth();
          
          // Use the hit rate from cacheHealth instead of requestTracker for consistency with byType breakdown
          const hitRate = parseFloat(cacheHealth.hitRate) || 0;
          const missRate = hitRate > 0 ? 100 - hitRate : 0;

          // Get real Redis memory usage
          let memoryUsage = 0;
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

            if (maxMemory > 0) {
              memoryUsage = Math.round((usedMemory / maxMemory) * 100);
            } else {
              // If no max memory is set, use used memory as a percentage of 1GB as reference
              const referenceMemory = 1024 * 1024 * 1024; // 1GB
              memoryUsage = Math.min(
                Math.round((usedMemory / referenceMemory) * 100),
                100,
              );
            }
          } catch (memError) {
            console.warn(
              "[Dashboard API] Failed to get Redis memory info:",
              memError.message,
            );
            memoryUsage = 0;
          }

          return {
            hitRate: hitRate,
            missRate: missRate,
            memoryUsage: memoryUsage,
            evictionRate: 2.1, // TODO: Calculate real eviction rate from Redis stats
            totalKeys: totalKeys,
            hits: cacheHealth.hits || 0,
            misses: cacheHealth.misses || 0,
            cachedErrors: cacheHealth.cachedErrors || 0,
            byType: cacheHealth.byType || {},
          };
        } catch (redisError) {
          console.warn(
            "[Dashboard API] Redis error, using fallback stats:",
            redisError.message,
          );
          return {
            hitRate: 0,
            missRate: 0,
            memoryUsage: 0,
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
        memoryUsage: 0,
        evictionRate: 0,
        totalKeys: 0,
        hits: 0,
        misses: 0,
        cachedErrors: 0,
        byType: {},
      };
    } catch (error) {
      console.error("[Dashboard API] Error getting cache performance:", error);
      return {
        hitRate: 0,
        missRate: 0,
        memoryUsage: 0,
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
      console.error(
        "[Dashboard API] Error getting provider performance:",
        error,
      );
      return [];
    }
  }

  // Get recent activity
  async getRecentActivity(limit = 20) {
    try {
      console.log("[Dashboard API] Getting recent activity...");

      const activities = this.requestTracker
        ? await this.requestTracker.getRecentActivity(limit)
        : [];
      console.log(
        `[Dashboard API] Got ${activities.length} activities from request tracker`,
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

      console.log(
        `[Dashboard API] Returning ${formattedActivities.length} formatted activities`,
      );
      return formattedActivities;
    } catch (error) {
      console.error("[Dashboard API] Error getting recent activity:", error);
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

  // Get provider API key status and rate limits
  async getProviderStatus() {
    try {
      const providers = [
        {
          name: "TMDB",
          apiKey: !!process.env.TMDB_API,
          envVar: "TMDB_API",
        },
        {
          name: "TVDB",
          apiKey: !!process.env.TVDB_API_KEY,
          envVar: "TVDB_API_KEY",
        },
        {
          name: "AniList",
          apiKey: true, // AniList doesn't require API key
          envVar: null,
        },
        {
          name: "MAL",
          apiKey: true, // MAL via Jikan doesn't require API key (3 req/sec, 60 req/min)
          envVar: null,
        },
        {
          name: "Kitsu",
          apiKey: true, // Kitsu doesn't require API key
          envVar: null,
        },
      ];

      const providerStatus = await Promise.all(
        providers.map(async (provider) => {
          try {
            const providerKey = provider.name.toLowerCase();

            // Try to get real rate limit data first
            const rateLimitKey = `provider_rate_limit:${providerKey}`;
            const rateLimitData = await this.cache.get(rateLimitKey);

            let rateLimit = "0/1000"; // default fallback
            let status = "healthy";

            if (rateLimitData) {
              try {
                const parsed = JSON.parse(rateLimitData);
                const now = Date.now();

                // Check if rate limit data is still valid (within 1 hour)
                if (now - parsed.timestamp < 3600000) {
                  // Use real rate limit data
                  rateLimit = `${parsed.remaining}/${parsed.limit}`;

                  // Calculate percentage used
                  const percentageUsed =
                    ((parsed.limit - parsed.remaining) / parsed.limit) * 100;

                  if (percentageUsed > 90) {
                    status = "error";
                  } else if (percentageUsed > 75) {
                    status = "warning";
                  } else {
                    status = "healthy";
                  }

                  // Check if rate limit is resetting soon
                  if (parsed.reset && parsed.reset * 1000 < now + 300000) {
                    // 5 minutes
                    status = "warning"; // Reset soon
                  }
                }
              } catch (parseError) {
                console.warn(
                  `[Dashboard API] Failed to parse rate limit data for ${provider.name}:`,
                  parseError.message,
                );
              }
            }

            // Fallback to hourly call tracking if no real rate limit data
            if (rateLimit === "0/1000") {
              const currentHour = new Date().toISOString().substring(0, 13);
              const hourlyCallsKey = `provider_calls:${providerKey}:${currentHour}`;
              const currentCalls = (await this.cache.get(hourlyCallsKey)) || 0;

              // Use conservative hourly limits as fallback
              switch (provider.name) {
                case "TMDB":
                  rateLimit = `${currentCalls}/1000`;
                  if (currentCalls > 800) status = "warning";
                  if (currentCalls > 1000) status = "error";
                  break;
                case "TVDB":
                  rateLimit = `${currentCalls}/100`;
                  if (currentCalls > 80) status = "warning";
                  if (currentCalls > 100) status = "error";
                  break;
                case "AniList":
                  // AniList: 90 requests per minute (currently degraded to 30)
                  // Use 30 as the current limit due to degraded state
                  rateLimit = `${currentCalls}/30`;
                  if (currentCalls > 22) status = "warning"; // 75% of 30
                  if (currentCalls > 30) status = "error"; // Over limit
                  break;
                case "MAL":
                  // Jikan: 3 requests per second = 180 per minute = 10,800 per hour
                  // But be conservative and use 60 per minute as the practical limit
                  rateLimit = `${currentCalls}/60`;
                  if (currentCalls > 45) status = "warning"; // 75% of 60
                  if (currentCalls > 60) status = "error"; // Over limit
                  break;
                case "Kitsu":
                  rateLimit = `${currentCalls}/500`;
                  if (currentCalls > 400) status = "warning";
                  if (currentCalls > 500) status = "error";
                  break;
              }
            }

            // Override status if API key is missing for required providers
            if (!provider.apiKey && provider.envVar) {
              status = "warning";
            }

            return {
              name: provider.name,
              apiKey: provider.apiKey,
              rateLimit: rateLimit,
              status: status,
              envVar: provider.envVar,
            };
          } catch (providerError) {
            console.warn(
              `[Dashboard API] Failed to get status for provider ${provider.name}:`,
              providerError.message,
            );
            return {
              name: provider.name,
              apiKey: provider.apiKey,
              rateLimit: "0/1000",
              status: "error",
              envVar: provider.envVar,
            };
          }
        }),
      );

      return providerStatus;
    } catch (error) {
      console.error("[Dashboard API] Error getting provider status:", error);
      return [];
    }
  }

  // Get aggregated system configuration stats
  async getSystemConfig() {
    try {
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
        console.warn(
          "[Dashboard API] Failed to load user configs for aggregation:",
          dbError.message,
        );
      }

      // Calculate aggregated statistics
      const stats = this.calculateConfigStats(userConfigs);

      return {
        totalUsers: totalUsers,
        sampleSize: userConfigs.length,
        aggregatedStats: stats,
        redisConnected: this.cache ? true : false,
        lastUpdated: new Date().toISOString(),
      };
    } catch (error) {
      console.error("[Dashboard API] Error getting system config:", error);
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
        cacheEnabled: 0,
        blurThumbs: 0,
        skipFiller: 0,
        skipRecap: 0,
        allowEpisodeMarking: 0,
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
      if (config.cacheEnabled !== false) stats.features.cacheEnabled++;
      if (config.blurThumbs) stats.features.blurThumbs++;
      if (config.mal?.skipFiller) stats.features.skipFiller++;
      if (config.mal?.skipRecap) stats.features.skipRecap++;
      if (config.mal?.allowEpisodeMarking) stats.features.allowEpisodeMarking++;
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
        cacheEnabled: Math.round((stats.features.cacheEnabled / total) * 100),
        blurThumbs: Math.round((stats.features.blurThumbs / total) * 100),
        skipFiller: Math.round((stats.features.skipFiller / total) * 100),
        skipRecap: Math.round((stats.features.skipRecap / total) * 100),
        allowEpisodeMarking: Math.round(
          (stats.features.allowEpisodeMarking / total) * 100,
        ),
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
        cacheEnabled: 100,
        blurThumbs: 0,
        skipFiller: 0,
        skipRecap: 0,
        allowEpisodeMarking: 0,
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
      console.warn("[Dashboard API] Failed to get disk usage:", error.message);
      return 0;
    }
  }

  // Get network I/O
  async getNetworkIO() {
    const fs = require("fs");
    const netDevPath = "/proc/net/dev";

    try {
      if (!fs.existsSync(netDevPath)) {
        return 0; // Not available on this system
      }

      const netData = fs.readFileSync(netDevPath, "utf8");
      const lines = netData.split("\n");
      let totalBytes = 0;

      for (const line of lines) {
        if (line.includes(":") && !line.includes("lo:")) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 10) {
            const rxBytes = parseInt(parts[1]) || 0;
            const txBytes = parseInt(parts[9]) || 0;
            totalBytes += rxBytes + txBytes;
          }
        }
      }

      // Calculate rate
      const now = Date.now();
      if (!this.lastNetworkMeasurement) {
        this.lastNetworkMeasurement = { bytes: totalBytes, time: now };
        return 0;
      }

      const timeDiff = (now - this.lastNetworkMeasurement.time) / 1000;
      const bytesDiff = totalBytes - this.lastNetworkMeasurement.bytes;

      let networkIO = 0;
      if (timeDiff > 0) {
        networkIO = parseFloat((bytesDiff / timeDiff / 1024 / 1024).toFixed(1));
      }

      this.lastNetworkMeasurement = { bytes: totalBytes, time: now };
      return Math.max(0, networkIO);
    } catch (error) {
      console.warn("[Dashboard API] Failed to get network I/O:", error.message);
      return 0;
    }
  }

  // Get resource usage
  async getResourceUsage() {
    try {
      return {
        memoryUsage: await this.getUniversalMemoryUsage(),
        cpuUsage: Math.round((os.loadavg()[0] / os.cpus().length) * 100),
        diskUsage: await this.getDiskUsage(),
        networkIO: await this.getNetworkIO(),
      };
    } catch (error) {
      console.error("[Dashboard API] Error getting resource usage:", error);
      return {
        memoryUsage: 0,
        cpuUsage: 0,
        diskUsage: 0,
        networkIO: 0,
      };
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
      console.error("[Dashboard API] Error getting error logs:", error);
      return [];
    }
  }

  // Get maintenance tasks
  async getMaintenanceTasks() {
    try {
      const now = Date.now();
      const tasks = [];

      // 1. Cache cleanup task - check if Redis has cleanup data
      try {
        if (this.cache) {
          const lastCleanup = await this.cache.get(
            "maintenance:last_cache_cleanup",
          );
          const cacheCleanupStatus = lastCleanup ? "completed" : "scheduled";
          const cacheCleanupTime = lastCleanup
            ? this.getTimeAgo(new Date(parseInt(lastCleanup)))
            : "Never";

          // Calculate next run time (6 hours after last cleanup)
          let nextRunTime = "Now";
          let isScheduled = false;
          
          // Check if automatic scheduling is enabled
          const schedulerEnabled = process.env.CACHE_CLEANUP_AUTO_ENABLED !== 'false'; // Default to enabled
          
          if (lastCleanup) {
            const lastCleanupTime = parseInt(lastCleanup);
            const nextRunTimestamp = lastCleanupTime + (6 * 60 * 60 * 1000); // 6 hours in milliseconds
            const now = Date.now();
            
            if (nextRunTimestamp > now) {
              const timeUntilNext = nextRunTimestamp - now;
              const hours = Math.floor(timeUntilNext / (60 * 60 * 1000));
              const minutes = Math.floor((timeUntilNext % (60 * 60 * 1000)) / (60 * 1000));
              nextRunTime = hours > 0 ? `In ${hours}h ${minutes}m` : `In ${minutes}m`;
              isScheduled = schedulerEnabled;
            } else {
              nextRunTime = schedulerEnabled ? "Scheduled" : "Now";
              isScheduled = schedulerEnabled;
            }
          } else {
            nextRunTime = schedulerEnabled ? "Scheduled" : "Now";
            isScheduled = schedulerEnabled;
          }

          tasks.push({
            id: 1,
            name: "Clear expired cache entries",
            status: cacheCleanupStatus,
            lastRun: cacheCleanupTime,
            description: `Removes expired keys from Redis cache${isScheduled ? ' (auto-scheduled every 6h)' : ''}`,
            nextRun: nextRunTime,
            category: "cleanup"
          });
        }
      } catch (error) {
        console.warn(
          "[Dashboard API] Failed to get cache cleanup status:",
          error.message,
        );
        tasks.push({
          id: 1,
          name: "Clear expired cache entries",
          status: "error",
          lastRun: "Unknown",
          description: "Removes expired keys from Redis cache",
          nextRun: "Now",
        });
      }

      // 2. Cache cleanup scheduler status
      try {
        const { getCacheCleanupScheduler } = require('./cacheCleanupScheduler');
        const scheduler = getCacheCleanupScheduler();
        
        if (scheduler) {
          const schedulerStatus = scheduler.getStatus();
          const schedulerEnabled = process.env.CACHE_CLEANUP_AUTO_ENABLED !== 'false';
          
          tasks.push({
            id: 10,
            name: "Cache Cleanup Scheduler",
            status: schedulerEnabled ? "running" : "disabled",
            lastRun: schedulerStatus.lastRun || "Never",
            description: "Automatic scheduling of expired cache cleanup (every 6 hours)",
            nextRun: schedulerStatus.nextRun ? new Date(schedulerStatus.nextRun).toLocaleString() : "Not scheduled",
            category: "scheduler"
          });
        }
      } catch (error) {
        console.warn("[Dashboard API] Failed to get cache cleanup scheduler status:", error.message);
      }

      // 3. Anime-list update task - check actual update timestamps
      try {
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

          tasks.push({
            id: 2,
            name: "Update anime-list XML",
            status: animeListStatus,
            lastRun: animeListTime,
            description: "Updates anime mappings from remote sources",
            nextRun: animeListStatus === "completed" ? "In 24 hours" : "Now",
          });
        }
      } catch (error) {
        console.warn(
          "[Dashboard API] Failed to get anime-list status:",
          error.message,
        );
        tasks.push({
          id: 2,
          name: "Update anime-list XML",
          status: "error",
          lastRun: "Unknown",
          description: "Updates anime mappings from remote sources",
          nextRun: "Now",
        });
      }

      // 3. ID Mapper update task - check actual update timestamps
      try {
        if (this.cache) {
          const idMapperLastUpdate = await this.cache.get(
            "maintenance:last_id_mapper_update",
          );
          const idMapperStatus = idMapperLastUpdate ? "completed" : "scheduled";
          const idMapperTime = idMapperLastUpdate
            ? this.getTimeAgo(new Date(parseInt(idMapperLastUpdate)))
            : "Never";

          tasks.push({
            id: 3,
            name: "Update ID Mapper",
            status: idMapperStatus,
            lastRun: idMapperTime,
            description: "Updates TMDB/TVDB/IMDB/MAL/Kitsu ID mappings",
            nextRun: idMapperStatus === "completed" ? "In 24 hours" : "Now",
          });
        }
      } catch (error) {
        console.warn(
          "[Dashboard API] Failed to get ID mapper status:",
          error.message,
        );
        tasks.push({
          id: 3,
          name: "Update ID Mapper",
          status: "error",
          lastRun: "Unknown",
          description: "Updates TMDB/TVDB/IMDB/MAL/Kitsu ID mappings",
          nextRun: "Now",
        });
      }

      // 4. Kitsu-IMDB mapping update task
      try {
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

          tasks.push({
            id: 4,
            name: "Update Kitsu-IMDB Mapping",
            status: kitsuImdbStatus,
            lastRun: kitsuImdbTime,
            description: "Updates Kitsu to IMDB ID mappings",
            nextRun: kitsuImdbStatus === "completed" ? "In 24 hours" : "Now",
          });
        }
      } catch (error) {
        console.warn(
          "[Dashboard API] Failed to get Kitsu-IMDB status:",
          error.message,
        );
        tasks.push({
          id: 4,
          name: "Update Kitsu-IMDB Mapping",
          status: "error",
          lastRun: "Unknown",
          description: "Updates Kitsu to IMDB ID mappings",
          nextRun: "Now",
        });
      }

      // 5. Database optimization task
      try {
        if (this.cache) {
          const lastDbOptimization = await this.cache.get(
            "maintenance:last_db_optimization",
          );
          const dbStatus = lastDbOptimization ? "completed" : "scheduled";
          const dbTime = lastDbOptimization
            ? this.getTimeAgo(new Date(parseInt(lastDbOptimization)))
            : "Never";

          tasks.push({
            id: 5,
            name: "Database optimization",
            status: dbStatus,
            lastRun: dbTime,
            description: "Optimizes SQLite database performance",
            nextRun: dbStatus === "completed" ? "In 7 days" : "Now",
          });
        }
      } catch (error) {
        console.warn(
          "[Dashboard API] Failed to get database status:",
          error.message,
        );
        tasks.push({
          id: 5,
          name: "Database optimization",
          status: "error",
          lastRun: "Unknown",
          description: "Optimizes SQLite database performance",
          nextRun: "Now",
        });
      }

      // 6. System health check task
      try {
        if (this.cache) {
          const lastHealthCheck = await this.cache.get(
            "maintenance:last_health_check",
          );
          const healthStatus = lastHealthCheck ? "completed" : "running";
          const healthTime = lastHealthCheck
            ? this.getTimeAgo(new Date(parseInt(lastHealthCheck)))
            : "Just now";

          tasks.push({
            id: 6,
            name: "System health check",
            status: healthStatus,
            lastRun: healthTime,
            description: "Monitors system resources and services",
            nextRun: healthStatus === "completed" ? "In 1 hour" : "Running",
          });
        }
      } catch (error) {
        console.warn(
          "[Dashboard API] Failed to get health check status:",
          error.message,
        );
        tasks.push({
          id: 6,
          name: "System health check",
          status: "error",
          lastRun: "Unknown",
          description: "Monitors system resources and services",
          nextRun: "Now",
        });
      }

      // 7. Cache warming task
      try {
        if (this.cache) {
          const lastCacheWarming = await this.cache.get(
            "maintenance:last_cache_warming",
          );
          const warmingStatus = lastCacheWarming ? "completed" : "scheduled";
          const warmingTime = lastCacheWarming
            ? this.getTimeAgo(new Date(parseInt(lastCacheWarming)))
            : "Never";

          tasks.push({
            id: 7,
            name: "Cache warming",
            status: warmingStatus,
            lastRun: warmingTime,
            description: "Preloads essential content into cache",
            nextRun: warmingStatus === "completed" ? "In 30 minutes" : "Now",
          });
        }
      } catch (error) {
        console.warn(
          "[Dashboard API] Failed to get cache warming status:",
          error.message,
        );
        tasks.push({
          id: 7,
          name: "Cache warming",
          status: "error",
          lastRun: "Unknown",
          description: "Preloads essential content into cache",
          nextRun: "Now",
        });
      }

      // 7. Essential Cache Warming task
      try {
        const { getWarmupStats: getEssentialStats } = require('./cacheWarmer');
        const essentialStats = getEssentialStats();
        
        tasks.push({
          id: 7,
          name: "Essential Cache Warming",
          status: essentialStats.enabled ? "completed" : "disabled",
          lastRun: essentialStats.lastRun ? this.getTimeAgo(new Date(essentialStats.lastRun)) : "Never",
          description: "Warms essential content (genres, studios, TMDB popular)",
          nextRun: essentialStats.enabled ? "Continuous" : "Disabled",
          action: essentialStats.enabled ? "restart" : "enable",
          category: "warming"
        });
      } catch (error) {
        console.warn("[Dashboard API] Failed to get essential warming status:", error.message);
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
        const { getWarmupStats: getMALStats } = require('./malCatalogWarmer');
        const malStats = getMALStats();
        
        tasks.push({
          id: 8,
          name: "MAL Catalog Warming",
          status: malStats.enabled ? (malStats.isWarming ? "running" : "completed") : "disabled",
          lastRun: malStats.lastRun ? this.getTimeAgo(new Date(malStats.lastRun)) : "Never",
          description: `Warms MAL anime catalogs (${malStats.totalItems || 0} items warmed)`,
          nextRun: malStats.enabled ? (malStats.nextRun ? this.getTimeUntil(new Date(malStats.nextRun)) : "Scheduled") : "Disabled",
          action: malStats.enabled ? (malStats.isWarming ? "stop" : "restart") : "enable",
          category: "warming"
        });
      } catch (error) {
        console.warn("[Dashboard API] Failed to get MAL warming status:", error.message);
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
        const { getWarmupStats: getCatalogStats } = require('./comprehensiveCatalogWarmer');
        const catalogStats = await getCatalogStats();
        
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
        
        tasks.push({
          id: 9,
          name: "Comprehensive Catalog Warming",
          status: catalogStats.enabled ? (catalogStats.isRunning ? "running" : "completed") : "disabled",
          lastRun: catalogStats.lastRun ? this.getTimeAgo(new Date(catalogStats.lastRun)) : "Never",
          description: description,
          nextRun: catalogStats.enabled ? (catalogStats.nextRun ? this.getTimeUntil(new Date(catalogStats.nextRun)) : "Scheduled") : "Disabled",
          action: catalogStats.enabled ? (catalogStats.isRunning ? "stop" : "restart") : "enable",
          category: "warming"
        });
      } catch (error) {
        console.warn("[Dashboard API] Failed to get comprehensive warming status:", error.message);
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
      console.error("[Dashboard API] Error getting maintenance tasks:", error);
      return [];
    }
  }

  // Check how many keys are expiring soon (without actually deleting them)
  async checkExpiredKeysCount() {
    try {
      if (!this.cache) {
        return { count: 0, error: "Cache not available" };
      }

      const allKeys = await this.cache.keys("*");
      let expiredCount = 0;

      // Count keys that will expire within the next hour
      for (const key of allKeys) {
        const ttl = await this.cache.ttl(key);
        if (ttl > 0 && ttl < 3600) { // Less than 1 hour remaining
          expiredCount++;
        }
      }

      return { count: expiredCount, totalKeys: allKeys.length };
    } catch (error) {
      console.error("[Cache Cleanup Scheduler] Error checking expired keys:", error);
      return { count: 0, error: error.message };
    }
  }

  // Smart cache cleanup scheduler
  async runScheduledCacheCleanup() {
    try {
      console.log("[Cache Cleanup Scheduler] Starting scheduled cleanup check...");
      
      // Check if cleanup is needed
      const checkResult = await this.checkExpiredKeysCount();
      
      if (checkResult.error) {
        console.error("[Cache Cleanup Scheduler] Failed to check keys:", checkResult.error);
        return;
      }

      if (checkResult.count === 0) {
        console.log("[Cache Cleanup Scheduler] No expired keys found, skipping cleanup");
        return;
      }

      console.log(`[Cache Cleanup Scheduler] Found ${checkResult.count} expired keys out of ${checkResult.totalKeys} total keys`);
      
      // Run the actual cleanup
      const cleanupResult = await this.clearExpiredCacheEntries();
      
      if (cleanupResult.success) {
        console.log(`[Cache Cleanup Scheduler] Scheduled cleanup completed: ${cleanupResult.message}`);
      } else {
        console.error(`[Cache Cleanup Scheduler] Scheduled cleanup failed: ${cleanupResult.message}`);
      }
      
    } catch (error) {
      console.error("[Cache Cleanup Scheduler] Error in scheduled cleanup:", error);
    }
  }

  // Clear expired cache entries (for maintenance task)
  async clearExpiredCacheEntries() {
    try {
      if (!this.cache) {
        throw new Error("Cache not available");
      }

      console.log("[Maintenance Task] Starting expired cache cleanup...");
      
      // Get all keys
      const allKeys = await this.cache.keys("*");
      const expiredKeys = [];
      const totalKeys = allKeys.length;

      console.log(`[Maintenance Task] Checking ${totalKeys} keys for expiration...`);

      // Check each key's TTL
      for (const key of allKeys) {
        const ttl = await this.cache.ttl(key);
        if (ttl > 0 && ttl < 3600) { // Less than 1 hour remaining
          expiredKeys.push(key);
        }
      }

      console.log(`[Maintenance Task] Found ${expiredKeys.length} expired keys to clear`);

      // Delete expired keys in batches to avoid overwhelming Redis
      if (expiredKeys.length > 0) {
        const batchSize = 100;
        for (let i = 0; i < expiredKeys.length; i += batchSize) {
          const batch = expiredKeys.slice(i, i + batchSize);
          await this.cache.del(...batch);
          console.log(`[Maintenance Task] Cleared batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(expiredKeys.length / batchSize)}`);
        }
      }

      // Update maintenance task status
      await this.cache.set("maintenance:last_cache_cleanup", Date.now().toString());

      const finalKeyCount = await this.cache.dbsize();
      const message = `Expired cache cleanup completed. Cleared ${expiredKeys.length} expired keys. ${finalKeyCount} keys remain.`;

      console.log(`[Maintenance Task] ${message}`);
      return { success: true, message, clearedCount: expiredKeys.length, remainingCount: finalKeyCount };
    } catch (error) {
      console.error("[Maintenance Task] Error clearing expired cache entries:", error);
      return { success: false, message: error.message };
    }
  }

  // Clear cache by type
  async clearCache(type) {
    try {
      if (!this.cache) {
        throw new Error("Cache not available");
      }

      switch (type) {
        case "all":
          // Use FLUSHALL for complete Redis cache clear (faster than keys + del)
          await this.cache.flushall();

          // Wait longer for cache warming to complete
          await new Promise((resolve) => setTimeout(resolve, 3000));
          break;
        case "expired":
          // Clear keys that are close to expiration (TTL < 1 hour)
          const allKeys = await this.cache.keys("*");
          const expiredKeys = [];

          for (const key of allKeys) {
            const ttl = await this.cache.ttl(key);
            if (ttl > 0 && ttl < 3600) {
              // Less than 1 hour remaining
              expiredKeys.push(key);
            }
          }

          if (expiredKeys.length > 0) {
            await this.cache.del(...expiredKeys);
          }
          break;
        case "metadata":
          // Clear metadata-related keys
          const metadataKeys = await this.cache.keys("*meta*");
          if (metadataKeys.length > 0) {
            await this.cache.del(...metadataKeys);
          }
          break;
        default:
          throw new Error(`Unknown cache type: ${type}`);
      }

      // Get final key count after clearing
      const finalKeyCount = await this.cache.dbsize();

      // Debug: List the actual keys for troubleshooting
      if (type === "all" && finalKeyCount > 0) {
        const keys = await this.cache.keys("*");
        console.log(`[Cache Clear] Remaining keys after clear:`, keys);
      }

      let message = `Cache ${type} cleared successfully`;
      if (type === "all" && finalKeyCount > 0) {
        message += `. ${finalKeyCount} essential keys remain (maintenance tracking, genres, etc.)`;
      }

      return { success: true, message, keyCount: finalKeyCount };
    } catch (error) {
      console.error("[Dashboard API] Error clearing cache:", error);
      return { success: false, message: error.message };
    }
  }

  // Get IMDb ratings statistics
  async getImdbRatingsStats() {
    try {
      const { getRatingsStats } = require("./imdbRatings.js");
      return getRatingsStats();
    } catch (error) {
      console.error("[Dashboard API] Error getting IMDb ratings stats:", error);
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
      console.error("[Dashboard API] Error getting all dashboard data:", error);
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
          console.warn(
            "[Dashboard API] Database query failed:",
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

      console.log(
        `[Dashboard API] User Stats - Total: ${totalUsers}, Active: ${activeUsers}, New Today: ${newUsersToday}`,
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
      console.error("[Dashboard API] Error getting user stats:", error);
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
      console.error(
        "[Dashboard API] Error getting recent user activity:",
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
}

module.exports = DashboardAPI;
