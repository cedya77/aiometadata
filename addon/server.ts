// Initialize global HTTP proxy before any other imports that use undici
import './utils/httpClient.js';

import { addon, startServerWithCacheWarming } from './index.js';
import { initializeMapper } from './lib/id-mapper.js';
import { initializeAnimeListMapper } from './lib/anime-list-mapper.js';
import { initializeMappings } from './lib/wiki-mapper.js';
import { initializeRatings } from './lib/imdbRatings.js';
import { initializeTmdbNetworkIndex } from './lib/tmdb-network-index.js';
import { initializeTmdbKeywordIndex } from './lib/tmdb-keyword-index.js';
import { runCacheCleanup } from './cache-cleanup.js';
import { runCachePathMigration } from './lib/cache-path-migration.js';
import { performEpochCleanup } from './lib/epochCleanup.js';
import { waitForRedisReady } from './lib/redisReady.js';
import redis from './lib/redisClient.js';
import database from './lib/database.js';
import consola from 'consola';
import { installLogReporter, beginQuietWindow, endQuietWindow } from './lib/logBuffer.js';
import { initializeSettings } from './lib/settingsService.js';
import { getPosterProxyPrefix, isBuiltinPosterCacheEnabled } from './lib/posterCache/config.js';
import { runNginxImport } from './lib/posterCache/nginxImport.js';
import * as posterCacheStore from './lib/posterCache/store.js';
import { readiness, shutdownSequence } from './lib/lifecycle/runtime.js';
import { mapWithConcurrency } from './utils/concurrency.js';

installLogReporter();

const PORT: number = parseInt(process.env.PORT || '3232', 10);

/** How many initializers may download and parse at once. */
const BOOTSTRAP_CONCURRENCY = 3;

const buildInfo = require('./lib/buildInfo.js');

const LABEL_WIDTH = 19;

function bootLine(glyph: string, name: string, detail: string): void {
  process.stdout.write(`${glyph} ${name.padEnd(LABEL_WIDTH)}${detail}\n`);
}

const ok = (name: string, detail = 'ready') => bootLine('[32m✔[39m', name, detail);
const warn = (name: string, detail: string) => bootLine('[33m⚠[39m', name, detail);

/** Reads a task's own counters; never lets a broken getter fail the boot. */
function describe(task: InitTask): string {
  if (!task.summary) return 'ready';
  try {
    return task.summary() || 'ready';
  } catch {
    return 'ready';
  }
}

/** Aborts in-flight startup waits (e.g. the Redis retry loop) when we are stopping. */
const bootAbort = new AbortController();
let shuttingDown = false;

async function shutdownAndExit(code: number, reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  endQuietWindow(); // a shutdown mid-boot must still be able to speak
  consola.info(`Shutting down (${reason})...`);
  bootAbort.abort();

  const result = await shutdownSequence.run();
  if (result.closed.length > 0) {
    consola.success(`Closed: ${result.closed.join(', ')}.`);
  }
  if (result.failed.length > 0) {
    consola.warn(`Did not close cleanly: ${result.failed.join(', ')}.`);
  }

  process.exit(code);
}

process.on('SIGTERM', () => { void shutdownAndExit(0, 'SIGTERM'); });
process.on('SIGINT', () => { void shutdownAndExit(0, 'SIGINT'); });

process.on('uncaughtException', (error: Error) => {
  consola.error('--- UNCAUGHT EXCEPTION ---');
  consola.error(error);
  void shutdownAndExit(1, 'uncaughtException');
});

process.on('unhandledRejection', (reason: unknown) => {
  consola.error('--- UNHANDLED PROMISE REJECTION ---');
  consola.error(reason);
});

function closeHttpServer(server: any): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
  });
}

interface InitTask {
  key: string;
  timeoutMs: number;
  run: () => Promise<unknown>;
  summary?: () => string;
}

/** Bounded so a slow index cannot hold readiness open forever. */
function withTimeout<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms — will retry on first use`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

const initializationTasks: InitTask[] = [
  {
    key: 'idMapper',
    timeoutMs: 180_000,
    run: () => initializeMapper()
  },
  {
    key: 'animeListMapper',
    timeoutMs: 180_000,
    run: () => initializeAnimeListMapper()
  },
  {
    key: 'wikiMappings',
    timeoutMs: 120_000,
    run: () => initializeMappings(),
    summary: () => {
      const { getWikiMapperStats } = require('./lib/wiki-mapper.js');
      return `${getWikiMapperStats().totalCount.toLocaleString()} mappings`;
    }
  },
  {
    key: 'imdbRatings',
    timeoutMs: 300_000,
    run: () => initializeRatings(),
    summary: () => {
      const { getImdbRatingsStatsForDashboard } = require('./lib/imdbRatings.js');
      return `${getImdbRatingsStatsForDashboard().count.toLocaleString()} ratings`;
    }
  },
  {
    key: 'tmdbNetworkIndex',
    timeoutMs: 30_000,
    run: () => initializeTmdbNetworkIndex()
  },
  {
    key: 'tmdbKeywordIndex',
    timeoutMs: 30_000,
    run: () => initializeTmdbKeywordIndex()
  },
  {
    key: 'cacheCleanup',
    timeoutMs: 120_000,
    run: () => runCacheCleanup()
  },
  {
    key: 'flixpatrolIndex',
    timeoutMs: 60_000,
    run: () => {
      const { initializeFlixPatrolAvailability } = require('./utils/flixpatrolUtils.js');
      return initializeFlixPatrolAvailability();
    }
  }
];

async function startServer(): Promise<void> {
  const startedAt = Date.now();
  beginQuietWindow();
  process.stdout.write(`
--- AIOMetadata ${buildInfo.version} starting ---
`);

  readiness.register('database', 'required');
  readiness.register('settings', 'required');
  readiness.register('redis', 'required');
  for (const task of initializationTasks) {
    readiness.register(task.key, 'degradable');
  }
  readiness.register('cacheWarming', 'deferred');

  // Bind the port first. the addon answers /health/live and /health/ready and 503s everything else,
  // instead of refusing connections outright.
  const server = addon.listen(PORT, () => {
    ok('listening', `:${PORT} (initializing)`);
  });
  shutdownSequence.register('http server', () => closeHttpServer(server), { phase: 'traffic' });

  const { attachJellyfinSocket } = require('./lib/jellyfin/socket');
  attachJellyfinSocket(server);

  // Storage
  await database.initialize();
  shutdownSequence.register('database', () => database.close());
  readiness.markReady('database');
  ok('database');

  await initializeSettings();
  readiness.markReady('settings');
  ok('settings');

  await require('./lib/aliasResolver').initializeUserAliases();
  ok('userAliases');

  if (isBuiltinPosterCacheEnabled()) {
    readiness.register('posterCacheIndex', 'deferred');

    await posterCacheStore.init();
    posterCacheStore.whenIndexed()
      .then(() => readiness.markReady('posterCacheIndex'))
      .catch((error: any) => readiness.markDegraded('posterCacheIndex', error));
    if (getPosterProxyPrefix()) {
      ok('posterCache');
    } else {
      warn('posterCache', 'no public URL — set HOST_NAME, nothing will be cached');
    }
    runNginxImport().catch((e: any) => consola.warn('[PosterCache] nginx import failed:', e?.message));
  }

  const metaColdStore = require('./lib/metaColdStore');
  if (metaColdStore.isEnabled()) {
    metaColdStore.init();
    shutdownSequence.register('meta cold store', async () => {
      await metaColdStore.flushNow();
      metaColdStore.close();
    });
    setInterval(() => {
      try { metaColdStore.sweep(); } catch (e: any) { consola.warn('[ColdStore] sweep failed:', e?.message); }
    }, 60 * 60 * 1000).unref?.();
    ok('metaColdStore');
  }

  // Redis
  await waitForRedisReady({
    signal: bootAbort.signal,
    onWaiting: ({ attempt, elapsedMs }) => {
      warn('redis', `not ready yet — attempt ${attempt}, ${Math.round(elapsedMs / 1000)}s elapsed`);
    }
  });
  shutdownSequence.register('redis', () => redis.quit().then(() => undefined));
  readiness.markReady('redis');
  ok('redis');

  require('./lib/authSession').backfillSessionIndex().catch(() => undefined);

  // Cache path migration
  await runCachePathMigration();
  ok('cachePathMigration');

  // Mappers, ratings and indexes
  performEpochCleanup().catch((error: any) => {
    consola.error('Background epoch cleanup failed:', error.message);
  });

  await mapWithConcurrency(initializationTasks, BOOTSTRAP_CONCURRENCY, async (task) => {
    try {
      await withTimeout(task.key, task.timeoutMs, Promise.resolve().then(task.run));
      readiness.markReady(task.key);
      ok(task.key, describe(task));
    } catch (error: any) {
      readiness.markDegraded(task.key, error);
      warn(task.key, `degraded — ${error?.message || error}`);
    }
  });

  // Deferred work - never on the path to serving traffic
  startServerWithCacheWarming()
    .then(() => readiness.markReady('cacheWarming'))
    .catch((error: any) => {
      readiness.markDegraded('cacheWarming', error);
      consola.error('Cache warming failed:', error?.message || error);
    });

  const { startMALWarmup } = require('./lib/malCatalogWarmer.js');
  startMALWarmup();

  const { startComprehensiveCatalogWarming } = require('./lib/comprehensiveCatalogWarmer.js');
  startComprehensiveCatalogWarming();

  const { startCacheCleanupScheduler } = require('./lib/cacheCleanupScheduler.js');
  const indexModule = require('./index.js');
  startCacheCleanupScheduler(indexModule.getDashboardAPI());

  indexModule.startEssentialWarmingSchedules();
  indexModule.startMovieLensSyncSchedule();

  const { warnings } = endQuietWindow();
  const snapshot = readiness.snapshot();
  const states = Object.values(snapshot.components);
  const degraded = states.filter((c: any) => c.state === 'degraded').length;
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  const notes = [`${states.length - degraded} ready`];
  if (degraded > 0) notes.push(`${degraded} degraded`);
  if (warnings > 0) notes.push(`${warnings} warnings`);
  ok('ready', `in ${seconds}s on :${PORT} — ${notes.join(', ')}`);
  process.stdout.write('\n');
}

startServer().catch((error: Error) => {
  endQuietWindow();
  consola.error('--- FATAL STARTUP ERROR ---');
  consola.error(error);
  void shutdownAndExit(1, 'startup failure');
});
