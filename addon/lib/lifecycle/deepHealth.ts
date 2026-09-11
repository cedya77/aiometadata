import redis from '../redisClient.js';

const database: any = require('../database');
const { getCacheHealth }: any = require('../getCache');

export type DependencyState = 'ok' | 'failed';

export interface DependencyReport {
  state: DependencyState;
  latencyMs: number;
  detail?: string;
}

export interface DeepHealthReport {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  dependencies: Record<string, DependencyReport>;
  counters: Record<string, unknown>;
}

function timeoutMs(): number {
  const { getSetting }: any = require('../settingsService');
  const parsed = Number.parseInt(String(getSetting('HEALTH_PROBE_TIMEOUT_MS') || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2000;
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

async function probe(work: () => Promise<unknown>): Promise<DependencyReport> {
  const started = Date.now();
  try {
    await withDeadline(work(), timeoutMs());
    return { state: 'ok', latencyMs: Date.now() - started };
  } catch (error: any) {
    return { state: 'failed', latencyMs: Date.now() - started, detail: error?.message || String(error) };
  }
}

/** Counters the caller trends between polls; a rising error count is the signal. */
async function readCounters(): Promise<Record<string, unknown>> {
  const today = new Date().toISOString().split('T')[0];
  const counters: Record<string, unknown> = {};

  try {
    const [total, todayErrors] = await withDeadline(
      redis!.mget('errors:total', `errors:${today}`),
      timeoutMs()
    );
    counters.errorsTotal = Number.parseInt(total || '0', 10) || 0;
    counters.errorsToday = Number.parseInt(todayErrors || '0', 10) || 0;
  } catch {
    counters.errorsTotal = null;
    counters.errorsToday = null;
  }

  try {
    const cache = getCacheHealth();
    counters.cache = {
      hits: cache.hits,
      misses: cache.misses,
      errors: cache.errors,
      corruptedEntries: cache.corruptedEntries,
      hitRate: cache.hitRate,
      errorRate: cache.errorRate,
    };
  } catch {
    counters.cache = null;
  }

  return counters;
}

/**
 * What a monitor cannot see from /health: whether the stores behind a metadata
 * request still answer. Startup readiness latches once ready, so it reports the
 * boot that happened rather than the state now.
 */
export async function deepHealth(): Promise<DeepHealthReport> {
  const [redisReport, databaseReport, counters] = await Promise.all([
    probe(async () => {
      if (!redis) throw new Error('no redis client');
      return redis.ping();
    }),
    probe(() => database.getQuery('SELECT 1 AS ok')),
    readCounters(),
  ]);

  const dependencies = { redis: redisReport, database: databaseReport };
  const failed = Object.values(dependencies).some((entry) => entry.state === 'failed');

  return {
    status: failed ? 'unhealthy' : 'healthy',
    timestamp: new Date().toISOString(),
    dependencies,
    counters,
  };
}
