import * as express from 'express';
import { startServerWithCacheWarming } from './index.js';
import { initializeMapper } from './lib/id-mapper.js';
import { initializeAnimeListMapper } from './lib/anime-list-mapper.js';
import * as geminiService from './utils/gemini-service.js';
import { autoMigrateIdCache } from './lib/auto-migrate.js';
import database from './lib/database.js';

const PORT: number = parseInt(process.env.PORT || '1337', 10);

async function startServer(): Promise<void> {
  console.log('--- Addon Starting Up ---');
  
  process.on('uncaughtException', (error: Error) => {
    console.error('--- UNCAUGHT EXCEPTION ---');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.error('This error was not caught and could crash the application.');
  });

  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    console.error('--- UNHANDLED PROMISE REJECTION ---');
    console.error('Reason:', reason);
    console.error('Promise:', promise);
    console.error('This rejection was not handled and could crash the application.');
  });
  
  console.log('Initializing ID Mapper...');
  await initializeMapper();
  console.log('ID Mapper initialization complete.');

  console.log('Initializing Anime List Mapper...');
  await initializeAnimeListMapper();
  console.log('Anime List Mapper initialization complete.');

  console.log('Initializing Database...');
  await database.initialize();
  console.log('Database initialization complete.');

  // Auto-migrate ID cache from SQLite to Redis if needed
  await autoMigrateIdCache();

  const addon: any = await startServerWithCacheWarming();

  addon.listen(PORT, () => {
    console.log(`Addon active and listening on port ${PORT}.`);
    console.log(`Open http://127.0.0.1:${PORT} in your browser.`);
  });
}

startServer().catch((error: Error) => {
  console.error('--- FATAL STARTUP ERROR ---');
  console.error(error);
  process.exit(1); 
});

