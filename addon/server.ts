import * as express from 'express';
import { startServerWithCacheWarming } from './index.js';
import { initializeMapper } from './lib/id-mapper.js';
import { initializeAnimeListMapper } from './lib/anime-list-mapper.js';
import { initializeMappings } from './lib/wiki-mapper.js';
import { initializeRatings } from './lib/imdbRatings.js';
import { runCacheCleanup } from './cache-cleanup.js';
import { runCachePathMigration } from './lib/cache-path-migration.js';
import database from './lib/database.js';
import consola from 'consola';

// Configure logging level based on environment
const logLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
consola.level = (consola as any).LogLevels[logLevel.toLowerCase()] ?? (process.env.NODE_ENV === 'production' ? 3 : 4);

const PORT: number = parseInt(process.env.PORT || '1337', 10);

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
  
  // Run one-time cache path migration BEFORE initializing mappers
  await runCachePathMigration();
  
  consola.info('Initializing ID Mapper...');
  await initializeMapper();
  consola.success('ID Mapper initialization complete.');

  consola.info('Initializing Anime List Mapper...');
  await initializeAnimeListMapper();
  consola.success('Anime List Mapper initialization complete.');

  consola.info('Initializing Wiki Mappings...');
  await initializeMappings();
  consola.success('Wiki Mappings initialization complete.');

  consola.info('Initializing IMDb Ratings...');
  await initializeRatings();
  consola.success('IMDb Ratings initialization complete.');

  consola.info('Initializing Database...');
  await database.initialize();
  consola.success('Database initialization complete.');

  consola.info('Checking for one-time cache cleanup...');
  await runCacheCleanup();
  consola.success('Cache cleanup check complete.');


  const addon: any = await startServerWithCacheWarming();

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

