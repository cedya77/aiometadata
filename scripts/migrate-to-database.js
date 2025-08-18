#!/usr/bin/env node

/**
 * Migration script to move from localStorage to database
 * 
 * Usage:
 *   node scripts/migrate-to-database.js
 * 
 * This script will:
 * 1. Initialize the database
 * 2. Create a sample configuration
 * 3. Demonstrate the migration process
 */

require('dotenv').config();
const database = require('../addon/lib/database');
const configApi = require('../addon/lib/configApi');

async function runMigration() {
  console.log('🚀 Starting localStorage to database migration...\n');

  try {
    // Check if DATABASE_URI is set
    if (!process.env.DATABASE_URI) {
      console.error('❌ DATABASE_URI environment variable is required');
      console.log('\n📝 Please set DATABASE_URI in your .env file:');
      console.log('   # For SQLite (recommended for local development):');
      console.log('   DATABASE_URI=sqlite://./data/db.sqlite');
      console.log('\n   # For PostgreSQL:');
      console.log('   DATABASE_URI=postgres://username:password@host:port/database_name');
      process.exit(1);
    }

    // Initialize database
    console.log('📊 Initializing database...');
    await database.initialize();
    console.log('✅ Database initialized successfully\n');

    // Sample localStorage data (this would normally come from the browser)
    const sampleLocalStorageData = {
      language: "en-US",
      includeAdult: false,
      blurThumbs: false,
      showPrefix: false,
      providers: { 
        movie: 'tmdb', 
        series: 'tvdb', 
        anime: 'mal', 
        anime_id_provider: 'imdb' 
      },
      tvdbSeasonType: 'default',
      mal: {
        skipFiller: false,
        skipRecap: false,
      },
      apiKeys: { 
        gemini: "sample_key_123", 
        tmdb: "sample_tmdb_key",
        tvdb: "sample_tvdb_key",
        fanart: "sample_fanart_key", 
        rpdb: "sample_rpdb_key", 
        mdblist: "sample_mdblist_key" 
      },
      ageRating: 'None',
      searchEnabled: true,
      sessionId: "",
      catalogs: [
        {
          id: "tmdb.trending",
          name: "Trending",
          type: "movie",
          enabled: true,
          showInHome: true
        },
        {
          id: "mal.airing",
          name: "Currently Airing",
          type: "series",
          enabled: true,
          showInHome: true
        }
      ]
    };

    console.log('📋 Sample localStorage data:');
    console.log(JSON.stringify(sampleLocalStorageData, null, 2));
    console.log('');

    // Migrate the data
    console.log('🔄 Migrating localStorage data to database...');
    const userId = await database.migrateFromLocalStorage(sampleLocalStorageData);
    
    if (userId) {
      console.log(`✅ Migration successful! User ID: ${userId}\n`);
      
      // Verify the migration
      console.log('🔍 Verifying migration...');
      const migratedConfig = await database.getUserConfig(userId);
      
      if (migratedConfig) {
        console.log('✅ Configuration retrieved successfully:');
        console.log(`   Language: ${migratedConfig.language}`);
        console.log(`   Providers: ${JSON.stringify(migratedConfig.providers)}`);
        console.log(`   Catalogs: ${migratedConfig.catalogs?.length || 0} catalogs`);
        console.log(`   API Keys: ${Object.keys(migratedConfig.apiKeys || {}).length} keys configured`);
      } else {
        console.log('❌ Failed to retrieve migrated configuration');
      }

      // Generate a session ID for sharing
      console.log('\n🔗 Generating shareable session...');
      const sessionId = configApi.generateSessionId();
      await database.saveUserSession(sessionId, userId, migratedConfig);
      console.log(`✅ Session created: ${sessionId}`);
      console.log(`   Share URL: http://localhost:11470/configure?sessionId=${sessionId}`);

      // Show database stats
      console.log('\n📊 Database statistics:');
      const userConfigs = await database.allQuery('SELECT COUNT(*) as count FROM user_configs');
      const userThemes = await database.allQuery('SELECT COUNT(*) as count FROM user_themes');
      const activeSessions = await database.allQuery('SELECT COUNT(*) as count FROM user_sessions WHERE expires_at > CURRENT_TIMESTAMP');
      
      console.log(`   User configurations: ${userConfigs[0]?.count || 0}`);
      console.log(`   User themes: ${userThemes[0]?.count || 0}`);
      console.log(`   Active sessions: ${activeSessions[0]?.count || 0}`);

    } else {
      console.log('❌ Migration failed');
    }

    console.log('\n🎉 Migration process completed!');
    console.log('\n📝 Next steps:');
    console.log('   1. Update your frontend to use the new API endpoints');
    console.log('   2. Test the configuration loading and saving');
    console.log('   3. Remove localStorage usage from your code');
    console.log('\n🔗 API Endpoints available:');
    console.log('   POST /api/config/save - Save configuration');
    console.log('   GET  /api/config/load - Load configuration');
    console.log('   GET  /api/config/session/:sessionId - Load by session');
    console.log('   POST /api/config/theme - Save theme');
    console.log('   GET  /api/config/theme - Load theme');
    console.log('   POST /api/config/share - Generate share URL');
    console.log('   POST /api/config/migrate - Migrate from localStorage');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await database.close();
  }
}

// Run the migration
runMigration();











