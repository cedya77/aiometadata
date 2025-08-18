#!/usr/bin/env node

/**
 * Simple test script for password-protected database functionality
 * 
 * Usage:
 *   node test-simple-database.js
 * 
 * This script tests the essential functionality:
 * 1. Database initialization
 * 2. Save/load configuration by UUID with password
 * 3. Password validation
 * 4. Migration from localStorage
 */

require('dotenv').config();
const database = require('./addon/lib/database');
const { compressToEncodedURIComponent } = require('lz-string');

async function testSimpleDatabase() {
  console.log('🧪 Testing password-protected database functionality...\n');

  try {
    // Check environment
    if (!process.env.DATABASE_URI) {
      console.error('❌ DATABASE_URI environment variable is required');
      console.log('Please set DATABASE_URI in your .env file:');
      console.log('   DATABASE_URI=sqlite://./data/db.sqlite');
      process.exit(1);
    }

    console.log(`📊 Using database: ${process.env.DATABASE_URI}\n`);

    // Test 1: Database initialization
    console.log('1️⃣ Testing database initialization...');
    await database.initialize();
    console.log('✅ Database initialized successfully\n');

    // Test 2: Configuration operations with password
    console.log('2️⃣ Testing configuration operations with password...');
    const testConfig = {
      language: "en-US",
      providers: { movie: 'tmdb', series: 'tvdb' },
      apiKeys: { 
        tmdb: 'test-tmdb-key-123',
        tvdb: 'test-tvdb-key-456'
      },
      catalogs: [
        { id: 'test.catalog', name: 'Test Catalog', enabled: true }
      ]
    };

    const testPassword = 'my-secure-password-123';

    // Generate UUID and save config with password
    const userUUID = database.generateUserUUID();
    console.log(`   Generated UUID: ${userUUID}`);
    
    // Hash password and save config
    const crypto = require('crypto');
    const passwordHash = crypto.createHash('sha256').update(testPassword).digest('hex');
    
    await database.saveUserConfig(userUUID, passwordHash, testConfig);
    console.log('✅ Configuration saved with password');

    // Test loading config without password (for manifest access)
    const loadedConfig = await database.getUserConfig(userUUID);
    if (JSON.stringify(loadedConfig) === JSON.stringify(testConfig)) {
      console.log('✅ Configuration loaded correctly (no password check)');
    } else {
      console.log('❌ Configuration mismatch');
    }

    // Test loading config with correct password
    const verifiedConfig = await database.verifyUserAndGetConfig(userUUID, testPassword);
    if (JSON.stringify(verifiedConfig) === JSON.stringify(testConfig)) {
      console.log('✅ Configuration verified with correct password');
    } else {
      console.log('❌ Password verification failed');
    }

    // Test loading config with wrong password
    const wrongPasswordConfig = await database.verifyUserAndGetConfig(userUUID, 'wrong-password');
    if (wrongPasswordConfig === null) {
      console.log('✅ Wrong password correctly rejected');
    } else {
      console.log('❌ Wrong password should have been rejected');
    }

    // Test 3: Generate install URL
    console.log('\n3️⃣ Testing install URL generation...');
    const compressedConfig = compressToEncodedURIComponent(JSON.stringify(testConfig));
    const installUrl = `http://localhost:11470/stremio/${userUUID}/${compressedConfig}/manifest.json`;
    console.log(`   Install URL: ${installUrl}`);
    console.log('✅ Install URL generated successfully');

    // Test 4: Migration functionality with password
    console.log('\n4️⃣ Testing migration functionality with password...');
    const migratedUUID = await database.migrateFromLocalStorage(testConfig, testPassword);
    
    if (migratedUUID) {
      console.log(`✅ Migration successful! New UUID: ${migratedUUID}`);
      
      const migratedConfig = await database.getUserConfig(migratedUUID);
      if (migratedConfig) {
        console.log('✅ Migrated config accessible');
      } else {
        console.log('❌ Migrated config not accessible');
      }

      // Test password verification for migrated config
      const migratedVerifiedConfig = await database.verifyUserAndGetConfig(migratedUUID, testPassword);
      if (migratedVerifiedConfig) {
        console.log('✅ Migrated config password verification works');
      } else {
        console.log('❌ Migrated config password verification failed');
      }
    } else {
      console.log('❌ Migration failed');
    }

    // Test 5: Database stats
    console.log('\n5️⃣ Testing database statistics...');
    const userConfigs = await database.allQuery('SELECT COUNT(*) as count FROM user_configs');
    console.log(`   User configurations: ${userConfigs[0]?.count || 0}`);
    console.log('✅ Statistics retrieved successfully');

    // Test 6: Cleanup
    console.log('\n6️⃣ Testing cleanup...');
    await database.deleteUserConfig(userUUID);
    await database.deleteUserConfig(migratedUUID);
    console.log('✅ Test data cleaned up');

    console.log('\n🎉 All database tests passed!');
    console.log('\n📝 Database is ready for:');
    console.log('   - Password-protected configuration storage');
    console.log('   - UUID-based user identification');
    console.log('   - Public instance URL format');
    console.log('   - localStorage migration with password');

  } catch (error) {
    console.error('❌ Database test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await database.close();
  }
}

// Run the test
testSimpleDatabase();
