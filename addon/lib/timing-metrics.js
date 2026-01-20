const redis = require('./redisClient');
const consola = require('consola');
const { isMetricsDisabled } = require('./metricsConfig');

const logger = consola.withTag('Timing-Metrics');

class TimingMetrics {
  constructor() {
    this.redis = redis;
    this.keyPrefix = 'timing_metrics:';
    this.maxSamples = 1000; // Keep last 1000 samples for each metric
    this.ttl = 7 * 24 * 60 * 60; // 7 days TTL
  }

  /**
   * Record a timing measurement (fire-and-forget with Redis pipeline)
   * @param {string} metric - The metric name (e.g., 'id_resolution', 'nameToImdb', 'api_lookup')
   * @param {number} duration - Duration in milliseconds
   * @param {Object} metadata - Additional metadata (e.g., { type: 'movie', cached: true })
   */
  recordTiming(metric, duration, metadata = {}) {
    // Skip metrics collection if disabled
    if (isMetricsDisabled()) {
      return;
    }
    try {
      const key = `${this.keyPrefix}${metric}`;
      const data = JSON.stringify({
        timestamp: Date.now(),
        duration,
        metadata
      });

      // Pipeline: 3 commands in 1 round-trip (fire-and-forget)
      this.redis.pipeline()
        .lpush(key, data)
        .ltrim(key, 0, this.maxSamples - 1)
        .expire(key, this.ttl)
        .exec()
        .catch(error => {
          logger.error(`Failed to record timing metric ${metric}:`, error.message);
        });

      logger.debug(`Recorded timing: ${metric} = ${duration}ms`, metadata);
    } catch (error) {
      logger.error(`Failed to record timing metric ${metric}:`, error.message);
    }
  }

  /**
   * Get timing statistics for a metric
   * @param {string} metric - The metric name
   * @param {Object} filters - Optional filters for metadata
   * @returns {Object} Statistics object
   */
  async getStats(metric, filters = {}) {
    try {
      const key = `${this.keyPrefix}${metric}`;
      const rawData = await this.redis.lrange(key, 0, -1);
      
      if (!rawData || rawData.length === 0) {
        return {
          count: 0,
          average: 0,
          min: 0,
          max: 0,
          p50: 0,
          p95: 0,
          p99: 0
        };
      }

      // Parse and filter data
      const data = rawData
        .map(item => JSON.parse(item))
        .filter(item => this._matchesFilters(item.metadata, filters))
        .map(item => item.duration)
        .sort((a, b) => a - b);

      if (data.length === 0) {
        return {
          count: 0,
          average: 0,
          min: 0,
          max: 0,
          p50: 0,
          p95: 0,
          p99: 0
        };
      }

      const count = data.length;
      const sum = data.reduce((acc, val) => acc + val, 0);
      const average = Math.round(sum / count);
      const min = data[0];
      const max = data[data.length - 1];
      
      // Percentiles
      const p50 = data[Math.floor(count * 0.5)];
      const p95 = data[Math.floor(count * 0.95)];
      const p99 = data[Math.floor(count * 0.99)];

      return {
        count,
        average,
        min,
        max,
        p50,
        p95,
        p99
      };
    } catch (error) {
      logger.error(`Failed to get stats for metric ${metric}:`, error.message);
      return {
        count: 0,
        average: 0,
        min: 0,
        max: 0,
        p50: 0,
        p95: 0,
        p99: 0
      };
    }
  }

  /**
   * Get all available metrics
   * @returns {Array} Array of metric names
   */
  async getAllMetrics() {
    try {
      const { scanKeys } = require('./redisUtils');
      const metrics = [];
      await scanKeys(`${this.keyPrefix}*`, async (key) => {
        metrics.push(key.replace(this.keyPrefix, ''));
      });
      return metrics;
    } catch (error) {
      logger.error('Failed to get all metrics:', error.message);
      return [];
    }
  }

  /**
   * Get comprehensive dashboard data
   * @returns {Object} Dashboard metrics
   */
  async getDashboardData() {
    try {
      const metrics = await this.getAllMetrics();
      const dashboardData = {};

      for (const metric of metrics) {
        const stats = await this.getStats(metric);
        const recentStats = await this.getStats(metric, { recent: true }); // Last 100 samples
        
        dashboardData[metric] = {
          overall: stats,
          recent: recentStats,
          lastUpdated: new Date().toISOString()
        };
      }

      return dashboardData;
    } catch (error) {
      logger.error('Failed to get dashboard data:', error.message);
      return {};
    }
  }

  /**
   * Get timing breakdown by provider
   * @returns {Object} Provider-specific timing data
   */
  async getProviderTimingBreakdown() {
    try {
      const providerMetrics = ['search_tmdb', 'search_tvdb', 'search_tvmaze', 'search_mal', 'search_kitsu', 'search_trakt'];
      const secondaryMetrics = [
        'secondary_tmdb_find_by_imdb', 
        'secondary_tvdb_find_by_imdb', 
        'secondary_tvdb_find_by_tmdb', 
        'secondary_tvmaze_find_by_imdb'
      ];
      const breakdown = {};

      // Primary search metrics
      for (const metric of providerMetrics) {
        const stats = await this.getStats(metric);
        if (stats.count > 0) {
          const provider = metric.replace('search_', '');
          breakdown[provider] = {
            ...stats,
            provider: provider.toUpperCase(),
            success_rate: await this.getSuccessRate(metric),
            type: 'search'
          };
        }
      }

      // Secondary API call metrics
      for (const metric of secondaryMetrics) {
        const stats = await this.getStats(metric);
        if (stats.count > 0) {
          const metricKey = `${metric}_secondary`;
          breakdown[metricKey] = {
            ...stats,
            provider: metric.replace('secondary_', '').replace(/_find_by_.*/, '').toUpperCase(),
            success_rate: await this.getSuccessRate(metric),
            type: 'secondary',
            operation: metric.replace('secondary_', '')
          };
        }
      }

      return breakdown;
    } catch (error) {
      logger.error('Failed to get provider timing breakdown:', error.message);
      return {};
    }
  }

  /**
   * Get timing breakdown by resolution type
   * @returns {Object} Resolution-type-specific timing data
   */
  async getResolutionTimingBreakdown() {
    try {
      const resolutionMetrics = ['id_resolution_total', 'id_resolution_cache', 'id_resolution_anime', 'id_resolution_wiki'];
      const breakdown = {};

      for (const metric of resolutionMetrics) {
        const stats = await this.getStats(metric);
        if (stats.count > 0) {
          const resolutionType = metric.replace('id_resolution_', '');
          breakdown[resolutionType] = {
            ...stats,
            resolution_type: resolutionType,
            success_rate: await this.getSuccessRate(metric)
          };
        }
      }

      return breakdown;
    } catch (error) {
      logger.error('Failed to get resolution timing breakdown:', error.message);
      return {};
    }
  }

  /**
   * Get success rate for a metric (based on error metadata)
   * @param {string} metric - The metric name
   * @returns {number} Success rate percentage
   */
  async getSuccessRate(metric) {
    try {
      const key = `${this.keyPrefix}${metric}`;
      const rawData = await this.redis.lrange(key, 0, -1);
      
      if (!rawData || rawData.length === 0) {
        return 100; // Default to 100% if no data
      }

      const data = rawData.map(item => JSON.parse(item));
      const totalCount = data.length;
      const errorCount = data.filter(item => item.metadata.error).length;
      
      return Math.round(((totalCount - errorCount) / totalCount) * 100);
    } catch (error) {
      logger.error(`Failed to get success rate for metric ${metric}:`, error.message);
      return 100; // Default to 100% on error
    }
  }

  /**
   * Get timing trends over time periods
   * @param {string} metric - The metric name
   * @param {Array} periods - Array of time periods in hours
   * @returns {Object} Timing trends
   */
  async getTimingTrends(metric, periods = [1, 24, 168]) { // 1h, 24h, 7d
    try {
      const trends = {};
      
      for (const period of periods) {
        const cutoff = Date.now() - (period * 60 * 60 * 1000);
        const key = `${this.keyPrefix}${metric}`;
        const rawData = await this.redis.lrange(key, 0, -1);
        
        if (!rawData || rawData.length === 0) {
          trends[`${period}h`] = { count: 0, average: 0 };
          continue;
        }

        const data = rawData
          .map(item => JSON.parse(item))
          .filter(item => item.timestamp > cutoff)
          .map(item => item.duration)
          .sort((a, b) => a - b);

        if (data.length > 0) {
          const average = Math.round(data.reduce((acc, val) => acc + val, 0) / data.length);
          const p95 = data[Math.floor(data.length * 0.95)];
          
          trends[`${period}h`] = {
            count: data.length,
            average,
            p95,
            period: `${period}h`
          };
        } else {
          trends[`${period}h`] = { count: 0, average: 0, period: `${period}h` };
        }
      }

      return trends;
    } catch (error) {
      logger.error(`Failed to get timing trends for metric ${metric}:`, error.message);
      return {};
    }
  }

  /**
   * Clear old data for a metric
   * @param {string} metric - The metric name
   * @param {number} maxAge - Maximum age in milliseconds
   */
  async clearOldData(metric, maxAge = 24 * 60 * 60 * 1000) { // 24 hours default
    try {
      const key = `${this.keyPrefix}${metric}`;
      const rawData = await this.redis.lrange(key, 0, -1);
      
      if (!rawData) return;

      const cutoff = Date.now() - maxAge;
      const filteredData = rawData
        .map(item => JSON.parse(item))
        .filter(item => item.timestamp > cutoff)
        .map(item => JSON.stringify(item));

      if (filteredData.length < rawData.length) {
        await this.redis.del(key);
        if (filteredData.length > 0) {
          await this.redis.lpush(key, ...filteredData);
          await this.redis.expire(key, this.ttl);
        }
        logger.info(`Cleaned ${rawData.length - filteredData.length} old entries for metric ${metric}`);
      }
    } catch (error) {
      logger.error(`Failed to clear old data for metric ${metric}:`, error.message);
    }
  }

  /**
   * Check if metadata matches filters
   * @private
   */
  _matchesFilters(metadata, filters) {
    for (const [key, value] of Object.entries(filters)) {
      if (metadata[key] !== value) {
        return false;
      }
    }
    return true;
  }
}

module.exports = new TimingMetrics();
