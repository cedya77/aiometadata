const { startServerWithCacheWarming } = require('./index.js')
const PORT = process.env.PORT || 1337;
const { initializeMapper } = require('./lib/id-mapper');
const { initializeAnimeListMapper } = require('./lib/anime-list-mapper');
const { runCacheCleanup } = require('./lib/cache-cleanup');
const database = require('./lib/database'); 

async function startServer() {
  console.log('--- Addon Starting Up ---');
  
  process.on('uncaughtException', (error) => {
    console.error('--- UNCAUGHT EXCEPTION ---');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.error('This error was not caught and could crash the application.');
  });

  process.on('unhandledRejection', (reason, promise) => {
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

  console.log('Checking for one-time cache cleanup...');
  await runCacheCleanup();
  console.log('Cache cleanup check complete.');

  // Auto-migrate ID cache from SQLite to Redis if needed
  // await autoMigrateIdCache(); // DISABLED - Migration stopped

  const addon = await startServerWithCacheWarming();

  addon.listen(PORT, () => {
    console.log(`Addon active and listening on port ${PORT}.`);
    console.log(`Open http://127.0.0.1:${PORT} in your browser.`);
  });
}


startServer().catch(error => {
  console.error('--- FATAL STARTUP ERROR ---');
  console.error(error);
  process.exit(1); 
});
