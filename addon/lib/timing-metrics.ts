const redis: any = require('./redisClient');
const consola: any = require('consola');
const { isMetricsDisabled }: any = require('./metricsConfig');

const logger: any = consola.withTag('Timing-Metrics');

interface TimingStats {
  count: number;
  average: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

interface TrendEntry {
  count: number;
  average: number;
  p95?: number;
  period?: string;
}

const EMPTY_STATS: TimingStats = {
  count: 0,
  average: 0,
  min: 0,
  max: 0,
  p50: 0,
  p95: 0,
  p99: 0
};

class TimingMetrics {
  redis: any;
  keyPrefix: string;
  maxSamples: number;
  ttl: number;

  constructor() {
    this.redis = redis;
    this.keyPrefix = 'timing_metrics:';
    this.maxSamples = 1000;
    this.ttl = 7 * 24 * 60 * 60;
  }

  recordTiming(metric: string, duration: number, metadata: Record<string, any> = {}): void {
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

      this.redis.pipeline()
        .lpush(key, data)
        .ltrim(key, 0, this.maxSamples - 1)
        .expire(key, this.ttl)
        .exec()
        .catch((error: any) => {
          logger.error(`Failed to record timing metric ${metric}:`, error.message);
        });

      logger.debug(`Recorded timing: ${metric} = ${duration}ms`, metadata);
    } catch (error: any) {
      logger.error(`Failed to record timing metric ${metric}:`, error.message);
    }
  }

  async getStats(metric: string, filters: Record<string, any> = {}): Promise<TimingStats> {
    try {
      const key = `${this.keyPrefix}${metric}`;
      const rawData = await this.redis.lrange(key, 0, -1);

      if (!rawData || rawData.length === 0) {
        return { ...EMPTY_STATS };
      }

      const data: number[] = rawData
        .map((item: string) => JSON.parse(item))
        .filter((item: any) => this._matchesFilters(item.metadata, filters))
        .map((item: any) => item.duration)
        .sort((a: number, b: number) => a - b);

      if (data.length === 0) {
        return { ...EMPTY_STATS };
      }

      const count = data.length;
      const sum = data.reduce((acc: number, val: number) => acc + val, 0);
      const average = Math.round(sum / count);
      const min = data[0];
      const max = data[data.length - 1];

      const p50 = data[Math.floor(count * 0.5)];
      const p95 = data[Math.floor(count * 0.95)];
      const p99 = data[Math.floor(count * 0.99)];

      return { count, average, min, max, p50, p95, p99 };
    } catch (error: any) {
      logger.error(`Failed to get stats for metric ${metric}:`, error.message);
      return { ...EMPTY_STATS };
    }
  }

  async getAllMetrics(): Promise<string[]> {
    try {
      const { scanKeys } = require('./redisUtils');
      const metrics: string[] = [];
      await scanKeys(`${this.keyPrefix}*`, async (key: string) => {
        metrics.push(key.replace(this.keyPrefix, ''));
      });
      return metrics;
    } catch (error: any) {
      logger.error('Failed to get all metrics:', error.message);
      return [];
    }
  }

  async getDashboardData(): Promise<Record<string, any>> {
    try {
      const metrics = await this.getAllMetrics();
      const dashboardData: Record<string, any> = {};

      for (const metric of metrics) {
        const stats = await this.getStats(metric);
        const recentStats = await this.getStats(metric, { recent: true });

        dashboardData[metric] = {
          overall: stats,
          recent: recentStats,
          lastUpdated: new Date().toISOString()
        };
      }

      return dashboardData;
    } catch (error: any) {
      logger.error('Failed to get dashboard data:', error.message);
      return {};
    }
  }

  async getProviderTimingBreakdown(): Promise<Record<string, any>> {
    try {
      const providerMetrics = ['search_tmdb', 'search_tvdb', 'search_tvmaze', 'search_mal', 'search_kitsu', 'search_trakt'];
      const secondaryMetrics = [
        'secondary_tmdb_find_by_imdb',
        'secondary_tvdb_find_by_imdb',
        'secondary_tvdb_find_by_tmdb',
        'secondary_tvmaze_find_by_imdb'
      ];
      const breakdown: Record<string, any> = {};

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
    } catch (error: any) {
      logger.error('Failed to get provider timing breakdown:', error.message);
      return {};
    }
  }

  async getResolutionTimingBreakdown(): Promise<Record<string, any>> {
    try {
      const resolutionMetrics = ['id_resolution_total', 'id_resolution_cache', 'id_resolution_anime', 'id_resolution_wiki'];
      const breakdown: Record<string, any> = {};

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
    } catch (error: any) {
      logger.error('Failed to get resolution timing breakdown:', error.message);
      return {};
    }
  }

  async getSuccessRate(metric: string): Promise<number> {
    try {
      const key = `${this.keyPrefix}${metric}`;
      const rawData = await this.redis.lrange(key, 0, -1);

      if (!rawData || rawData.length === 0) {
        return 100;
      }

      const data = rawData.map((item: string) => JSON.parse(item));
      const totalCount = data.length;
      const errorCount = data.filter((item: any) => item.metadata.error).length;

      return Math.round(((totalCount - errorCount) / totalCount) * 100);
    } catch (error: any) {
      logger.error(`Failed to get success rate for metric ${metric}:`, error.message);
      return 100;
    }
  }

  async getTimingTrends(metric: string, periods: number[] = [1, 24, 168]): Promise<Record<string, TrendEntry>> {
    try {
      const trends: Record<string, TrendEntry> = {};

      for (const period of periods) {
        const cutoff = Date.now() - (period * 60 * 60 * 1000);
        const key = `${this.keyPrefix}${metric}`;
        const rawData = await this.redis.lrange(key, 0, -1);

        if (!rawData || rawData.length === 0) {
          trends[`${period}h`] = { count: 0, average: 0 };
          continue;
        }

        const data: number[] = rawData
          .map((item: string) => JSON.parse(item))
          .filter((item: any) => item.timestamp > cutoff)
          .map((item: any) => item.duration)
          .sort((a: number, b: number) => a - b);

        if (data.length > 0) {
          const average = Math.round(data.reduce((acc: number, val: number) => acc + val, 0) / data.length);
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
    } catch (error: any) {
      logger.error(`Failed to get timing trends for metric ${metric}:`, error.message);
      return {};
    }
  }

  async clearOldData(metric: string, maxAge: number = 24 * 60 * 60 * 1000): Promise<void> {
    try {
      const key = `${this.keyPrefix}${metric}`;
      const rawData = await this.redis.lrange(key, 0, -1);

      if (!rawData) return;

      const cutoff = Date.now() - maxAge;
      const filteredData = rawData
        .map((item: string) => JSON.parse(item))
        .filter((item: any) => item.timestamp > cutoff)
        .map((item: any) => JSON.stringify(item));

      if (filteredData.length < rawData.length) {
        await this.redis.del(key);
        if (filteredData.length > 0) {
          await this.redis.lpush(key, ...filteredData);
          await this.redis.expire(key, this.ttl);
        }
        logger.info(`Cleaned ${rawData.length - filteredData.length} old entries for metric ${metric}`);
      }
    } catch (error: any) {
      logger.error(`Failed to clear old data for metric ${metric}:`, error.message);
    }
  }

  _matchesFilters(metadata: Record<string, any>, filters: Record<string, any>): boolean {
    for (const [key, value] of Object.entries(filters)) {
      if (metadata[key] !== value) {
        return false;
      }
    }
    return true;
  }
}

const instance = new TimingMetrics();
export { instance as default };
module.exports = instance;
