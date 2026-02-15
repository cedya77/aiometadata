// Initialize global HTTP proxy before any other imports that use undici
import './utils/httpClient.js';

import * as express from 'express';
import { startServerWithCacheWarming } from './index.js';
import { initializeMapper } from './lib/id-mapper.js';
import { initializeAnimeListMapper } from './lib/anime-list-mapper.js';
import { initializeMappings } from './lib/wiki-mapper.js';
import { initializeRatings } from './lib/imdbRatings.js';
import { runCacheCleanup } from './cache-cleanup.js';
import { runCachePathMigration } from './lib/cache-path-migration.js';
import { performVersionCleanup } from './lib/versionCleanup.js';
import database from './lib/database.js';
import consola from 'consola';


const PORT: number = parseInt(process.env.PORT || '3232', 10);
 
async function startServer(): Promise<void> {
  consola.info('--- Addon Starting Up ---');
 
  process.on('uncaughtException', (error: Error) => {
    consola.error('--- UNCAUGHT EXCEPTION ---');
    consola.error('Error:', error.message);
    consola.error('Stack:', error.stack);
    consola.error('This error was not caught and could crash the application.');
  });
  
  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    consola.error('--- UNHANDLED PROMISE REJECTION ---');
    consola.error('Reason:', reason);
    consola.error('Promise:', promise);
    consola.error('This rejection was not handled and could crash the application.');
  });
 
  // Database must initialize first
  consola.info('Initializing Database...');
  await database.initialize();
  consola.success('Database initialization complete.');

  const redis = require('./lib/redisClient');
  if (redis && redis.status === 'end') {
    consola.info('Connecting Redis...');
    await redis.connect();
    consola.success('Redis connected.');
  }
  
  // Cache path migration
  consola.info('Running cache path migration...');
  await runCachePathMigration();
  consola.success('Cache path migration complete.');
  
  consola.info('Initializing Mappers, Ratings, and Cache Cleanup...');

  performVersionCleanup().catch((error: any) => {
    consola.error('Background version cleanup failed:', error.message);
  });
  
  const initializationTasks = [
    {
      name: 'ID Mapper (anime-list.json)',
      task: async () => {
        consola.info('Initializing ID Mapper...');
        await initializeMapper();
      },
      critical: true
    },
    {
      name: 'Anime List Mapper (anime-list.xml)',
      task: async () => {
        consola.info('Initializing Anime List Mapper...');
        await initializeAnimeListMapper();
      },
      critical: true
    },
    {
      name: 'Wiki Mappings',
      task: async () => {
        consola.info('Initializing Wiki Mappings...');
        await initializeMappings();
      },
      critical: true
    },
    {
      name: 'IMDb Ratings',
      task: async () => {
        consola.info('Initializing IMDb Ratings...');
        await initializeRatings();
      },
      critical: true
    },
    {
      name: 'Cache Cleanup Check',
      task: async () => {
        consola.info('Checking for one-time cache cleanup...');
        await runCacheCleanup();
      },
      critical: false
    }
  ];
  
  // Execute all tasks in parallel
  const results = await Promise.allSettled(
    initializationTasks.map(({ task }) => task())
  );
  
  // Check results and log appropriately
  const failures: string[] = [];
  results.forEach((result, index) => {
    const { name, critical } = initializationTasks[index];
    if (result.status === 'fulfilled') {
      consola.success(`${name} initialization complete.`);
    } else {
      consola.error(`${name} failed to initialize:`, result.reason);
      if (critical) {
        failures.push(name);
      }
    }
  });
  
  // Abort startup if any critical tasks failed
  if (failures.length > 0) {
    throw new Error(`Critical initialization failures: ${failures.join(', ')}`);
  }
  
  consola.success('All initializations complete.');
  
  // PHASE 3: Start server with cache warming
  consola.info('Starting server with cache warming...');
  const addon: any = await startServerWithCacheWarming();
  
  // PHASE 4: Start background catalog warming (after server initialization)
  const { startMALWarmup } = require('./lib/malCatalogWarmer.js');
  startMALWarmup();
  
  const { startComprehensiveCatalogWarming } = require('./lib/comprehensiveCatalogWarmer.js');
  startComprehensiveCatalogWarming();
  
  // PHASE 5: Start cache cleanup scheduler
  consola.info('Starting cache cleanup scheduler...');
  const { startCacheCleanupScheduler } = require('./lib/cacheCleanupScheduler.js');
  
  const indexModule = require('./index.js');
  const dashboardApi = indexModule.getDashboardAPI();
  startCacheCleanupScheduler(dashboardApi);
  
  addon.listen(PORT, () => {
    consola.success(`Addon active and listening on port ${PORT}.`);
    consola.info(`Open http://127.0.0.1:${PORT} in your browser.`);
  });
}
 
startServer().catch((error: Error) => {
  consola.error('--- FATAL STARTUP ERROR ---');
  consola.error(error);
  process.exit(1);
});