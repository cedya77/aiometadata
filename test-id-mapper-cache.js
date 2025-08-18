#!/usr/bin/env node

/**
 * Test script for ID Mapper Cache endpoints
 * This script demonstrates the new cache monitoring endpoints
 */

const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'http://localhost:1337';

async function testCacheEndpoints() {
  console.log('=== Testing ID Mapper Cache Endpoints ===');
  
  try {
    // Test 1: Get cache statistics
    console.log('\n1. Testing /api/id-mapper/cache (statistics)...');
    const statsResponse = await axios.get(`${BASE_URL}/api/id-mapper/cache`);
    
    if (statsResponse.data.success) {
      const stats = statsResponse.data.data;
      console.log('✅ Cache Statistics:');
      console.log(`   - Initialized: ${stats.isInitialized}`);
      console.log(`   - MAL mappings: ${stats.animeIdMapSize}`);
      console.log(`   - TVDB mappings: ${stats.tvdbIdMapSize}`);
      console.log(`   - IMDB mappings: ${stats.imdbIdMapSize}`);
      console.log(`   - TMDB mappings: ${stats.tmdbIndexArraySize}`);
      console.log(`   - Redis ETag: ${stats.redisEtag || 'Not available'}`);
      console.log(`   - Last update: ${stats.lastUpdateInfo?.lastModified || 'Unknown'}`);
      console.log(`   - Cache file size: ${stats.lastUpdateInfo?.fileSize || 0} bytes`);
    } else {
      console.log('❌ Failed to get cache statistics');
    }
    
    // Test 2: Get cache details with pagination
    console.log('\n2. Testing /api/id-mapper/cache/details (sample data)...');
    const detailsResponse = await axios.get(`${BASE_URL}/api/id-mapper/cache/details?limit=5&offset=0`);
    
    if (detailsResponse.data.success) {
      const details = detailsResponse.data.data;
      console.log('✅ Cache Details:');
      console.log(`   - Pagination: ${details.pagination.limit} items, offset ${details.pagination.offset}`);
      console.log(`   - Totals: MAL=${details.pagination.total.mal}, TVDB=${details.pagination.total.tvdb}, IMDB=${details.pagination.total.imdb}, TMDB=${details.pagination.total.tmdb}`);
      
      // Show sample MAL mappings
      if (details.samples.malMappings.length > 0) {
        console.log('\n   Sample MAL mappings:');
        details.samples.malMappings.slice(0, 3).forEach(mapping => {
          console.log(`     - ${mapping.title} (MAL: ${mapping.mal_id}, TVDB: ${mapping.thetvdb_id || 'N/A'}, TMDB: ${mapping.themoviedb_id || 'N/A'})`);
        });
      }
      
      // Show sample TVDB mappings
      if (details.samples.tvdbMappings.length > 0) {
        console.log('\n   Sample TVDB mappings:');
        details.samples.tvdbMappings.slice(0, 2).forEach(mapping => {
          console.log(`     - TVDB ${mapping.tvdb_id}: ${mapping.count} items`);
          mapping.sample.forEach(item => {
            console.log(`       * ${item.title} (MAL: ${item.mal_id})`);
          });
        });
      }
    } else {
      console.log('❌ Failed to get cache details');
    }
    
    // Test 3: Test pagination
    console.log('\n3. Testing pagination (offset=5)...');
    const paginationResponse = await axios.get(`${BASE_URL}/api/id-mapper/cache/details?limit=3&offset=5`);
    
    if (paginationResponse.data.success) {
      const pagination = paginationResponse.data.data;
      console.log('✅ Pagination working:');
      console.log(`   - Offset: ${pagination.pagination.offset}`);
      console.log(`   - Limit: ${pagination.pagination.limit}`);
      console.log(`   - MAL samples returned: ${pagination.samples.malMappings.length}`);
    } else {
      console.log('❌ Pagination test failed');
    }
    
    console.log('\n✅ All tests completed successfully!');
    console.log('\nYou can now monitor your ID mapper cache using these endpoints:');
    console.log(`   - ${BASE_URL}/api/id-mapper/cache (statistics)`);
    console.log(`   - ${BASE_URL}/api/id-mapper/cache/details (sample data)`);
    console.log(`   - ${BASE_URL}/api/id-mapper/cache/details?limit=20&offset=0 (custom pagination)`);
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
  }
}

// Run the test
testCacheEndpoints();







