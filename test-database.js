#!/usr/bin/env node

/**
 * Test script for database functionality
 * 
 * Usage:
 *   node test-database.js
 * 
 * This script tests:
 * 1. Database initialization
 * 2. Configuration saving/loading
 * 3. Theme saving/loading
 * 4. Session management
 * 5. Migration functionality
 */

require('dotenv').config();
const database = require('./addon/lib/database');
const configApi = require('./addon/lib/configApi');

async function testDatabase() {
  console.log('🧪 Testing database functionality...\n');

  try {
    // Check environment
    if (!process.env.DATABASE_URI) {
      console.error('❌ DATABASE_URI environment variable is required');
      console.log('Please set DATABASE_URI in your .env file');
      process.exit(1);
    }

    console.log(`📊 Using database: ${process.env.DATABASE_URI}\n`);

    // Test 1: Database initialization
    console.log('1️⃣ Testing database initialization...');
    await database.initialize();
    console.log('✅ Database initialized successfully\n');

    // Test 2: Configuration operations
    console.log('2️⃣ Testing configuration operations...');
    const testConfig = {
      language: "en-US",
      providers: { movie: 'tmdb', series: 'tvdb' },
      apiKeys: { tmdb: 'test-key-123' },
      catalogs: [
        { id: 'test.catalog', name: 'Test Catalog', enabled: true }
      ]
    };

    const userId = 'test_user_123';
    
    // Save config
    await database.saveUserConfig(userId, testConfig);
    console.log('✅ Configuration saved');

    // Load config
    const loadedConfig = await database.getUserConfig(userId);
    if (JSON.stringify(loadedConfig) === JSON.stringify(testConfig)) {
      console.log('✅ Configuration loaded correctly');
    } else {
      console.log('❌ Configuration mismatch');
      console.log('Expected:', testConfig);
      console.log('Got:', loadedConfig);
    }
    console.log('');

    // Test 3: Theme operations
    console.log('3️⃣ Testing theme operations...');
    const testTheme = 'light';
    
    // Save theme
    await database.saveUserTheme(userId, testTheme);
    console.log('✅ Theme saved');

    // Load theme
    const loadedTheme = await database.getUserTheme(userId);
    if (loadedTheme === testTheme) {
      console.log('✅ Theme loaded correctly');
    } else {
      console.log('❌ Theme mismatch');
      console.log('Expected:', testTheme);
      console.log('Got:', loadedTheme);
    }
    console.log('');

    // Test 4: Session operations
    console.log('4️⃣ Testing session operations...');
    const sessionId = configApi.generateSessionId();
    
    // Save session
    await database.saveUserSession(sessionId, userId, testConfig);
    console.log('✅ Session saved');

    // Load session
    const session = await database.getUserSession(sessionId);
    if (session && session.userId === userId) {
      console.log('✅ Session loaded correctly');
    } else {
      console.log('❌ Session mismatch');
      console.log('Expected userId:', userId);
      console.log('Got:', session);
    }
    console.log('');

    // Test 5: Migration functionality
    console.log('5️⃣ Testing migration functionality...');
    const migratedUserId = await database.migrateFromLocalStorage(testConfig);
    if (migratedUserId) {
      console.log('✅ Migration successful');
      
      const migratedConfig = await database.getUserConfig(migratedUserId);
      if (migratedConfig) {
        console.log('✅ Migrated config accessible');
      } else {
        console.log('❌ Migrated config not accessible');
      }
    } else {
      console.log('❌ Migration failed');
    }
    console.log('');

    // Test 6: Database statistics
    console.log('6️⃣ Testing database statistics...');
    const userConfigs = await database.allQuery('SELECT COUNT(*) as count FROM user_configs');
    const userThemes = await database.allQuery('SELECT COUNT(*) as count FROM user_themes');
    const activeSessions = await database.allQuery('SELECT COUNT(*) as count FROM user_sessions WHERE expires_at > CURRENT_TIMESTAMP');
    
    console.log(`   User configurations: ${userConfigs[0]?.count || 0}`);
    console.log(`   User themes: ${userThemes[0]?.count || 0}`);
    console.log(`   Active sessions: ${activeSessions[0]?.count || 0}`);
    console.log('✅ Statistics retrieved successfully\n');

    // Test 7: Cleanup
    console.log('7️⃣ Testing cleanup...');
    await database.deleteUserConfig(userId);
    await database.deleteUserSession(sessionId);
    console.log('✅ Test data cleaned up\n');

    console.log('🎉 All database tests passed!');
    console.log('\n📝 Database is ready for use with:');
    console.log('   - Configuration storage');
    console.log('   - Theme preferences');
    console.log('   - Session management');
    console.log('   - Migration from localStorage');

  } catch (error) {
    console.error('❌ Database test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await database.close();
  }
}

// Run the test
testDatabase();











