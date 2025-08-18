#!/usr/bin/env node

const axios = require('axios');

// Configuration
const BASE_URL = process.env.TEST_URL || 'http://localhost:1337';

console.log('🧪 Testing Non-Anime ID Cache API Endpoints');
console.log(`📍 Base URL: ${BASE_URL}\n`);

async function testIdCacheEndpoints() {
  try {
    // 1. Test cache statistics
    console.log('1. Testing /api/id-cache/stats (statistics)...');
    const statsResponse = await axios.get(`${BASE_URL}/api/id-cache/stats`);
    
    if (statsResponse.data.success) {
      const stats = statsResponse.data.data;
      console.log('✅ Cache Statistics:');
      console.log(`   📊 Total Mappings: ${stats.totalMappings}`);
      console.log(`   📈 Usage: ${stats.usagePercentage}% of ${stats.maxSize}`);
      console.log(`   💾 Estimated Size: ${stats.estimatedSizeKB} KB`);
      console.log(`   ⏰ TTL: ${stats.ttlDays} days`);
      console.log(`   🔧 Compression: ${stats.compressionEnabled ? 'Enabled' : 'Disabled'}`);
      
      if (stats.stats && stats.stats.length > 0) {
        console.log('   📋 By Content Type:');
        stats.stats.forEach(type => {
          console.log(`      ${type.content_type}: ${type.total_mappings} mappings`);
          console.log(`        - TMDB: ${type.with_tmdb}, TVDB: ${type.with_tvdb}, IMDB: ${type.with_imdb}, TVmaze: ${type.with_tvmaze}`);
        });
      }
    } else {
      console.log('❌ Failed to get cache statistics');
    }

    // 2. Test cache mappings
    console.log('\n2. Testing /api/id-cache/mappings (sample data)...');
    const mappingsResponse = await axios.get(`${BASE_URL}/api/id-cache/mappings?limit=5`);
    
    if (mappingsResponse.data.success) {
      const data = mappingsResponse.data.data;
      console.log('✅ Cache Mappings:');
      console.log(`   📄 Total: ${data.pagination.total} mappings`);
      console.log(`   📋 Showing: ${data.mappings.length} samples`);
      
      if (data.mappings.length > 0) {
        console.log('   🔍 Sample Mappings:');
        data.mappings.slice(0, 3).forEach((mapping, index) => {
          console.log(`      ${index + 1}. ${mapping.content_type.toUpperCase()}:`);
          console.log(`         TMDB: ${mapping.tmdb_id || 'N/A'}`);
          console.log(`         TVDB: ${mapping.tvdb_id || 'N/A'}`);
          console.log(`         IMDB: ${mapping.imdb_id || 'N/A'}`);
          console.log(`         TVmaze: ${mapping.tvmaze_id || 'N/A'}`);
          console.log(`         Updated: ${mapping.updated_at}`);
        });
      } else {
        console.log('   ℹ️  No mappings found (cache might be empty)');
      }
    } else {
      console.log('❌ Failed to get cache mappings');
    }

    // 3. Test content type filtering
    console.log('\n3. Testing /api/id-cache/mappings?contentType=movie...');
    const movieResponse = await axios.get(`${BASE_URL}/api/id-cache/mappings?contentType=movie&limit=3`);
    
    if (movieResponse.data.success) {
      const data = movieResponse.data.data;
      console.log('✅ Movie Mappings:');
      console.log(`   🎬 Total Movies: ${data.pagination.total}`);
      console.log(`   📋 Showing: ${data.mappings.length} samples`);
    } else {
      console.log('❌ Failed to get movie mappings');
    }

    // 4. Test search functionality (if there are mappings)
    console.log('\n4. Testing /api/id-cache/search...');
    try {
      const searchResponse = await axios.get(`${BASE_URL}/api/id-cache/search?id=123&limit=3`);
      
      if (searchResponse.data.success) {
        const data = searchResponse.data.data;
        console.log('✅ Search Results:');
        console.log(`   🔍 Search ID: ${data.search_id}`);
        console.log(`   📋 Found: ${data.results.length} matches`);
      } else {
        console.log('ℹ️  No search results found (expected if cache is empty)');
      }
    } catch (error) {
      if (error.response?.status === 400) {
        console.log('ℹ️  Search endpoint working (no results for test ID)');
      } else {
        console.log('❌ Search test failed:', error.message);
      }
    }

    // 5. Test recommendations
    console.log('\n5. Testing /api/id-cache/recommendations...');
    const recommendationsResponse = await axios.get(`${BASE_URL}/api/id-cache/recommendations`);
    
    if (recommendationsResponse.data.success) {
      const data = recommendationsResponse.data.data;
      console.log('✅ Storage Recommendations:');
      console.log(`   📊 Current Stats: ${data.currentStats.totalMappings} mappings, ${data.currentStats.estimatedSizeKB} KB`);
      
      if (data.recommendations && data.recommendations.length > 0) {
        console.log('   💡 Recommendations:');
        data.recommendations.forEach((rec, index) => {
          console.log(`      ${index + 1}. ${rec}`);
        });
      } else {
        console.log('   ✅ No recommendations (cache is healthy)');
      }
    } else {
      console.log('❌ Failed to get recommendations');
    }

    // 6. Test pagination
    console.log('\n6. Testing pagination...');
    const paginationResponse = await axios.get(`${BASE_URL}/api/id-cache/mappings?limit=2&offset=2`);
    
    if (paginationResponse.data.success) {
      const data = paginationResponse.data.data;
      console.log('✅ Pagination:');
      console.log(`   📄 Limit: ${data.pagination.limit}, Offset: ${data.pagination.offset}`);
      console.log(`   📋 Returned: ${data.mappings.length} items`);
    } else {
      console.log('❌ Pagination test failed');
    }

    console.log('\n🎉 All tests completed!');
    console.log('\n📋 Available Endpoints:');
    console.log(`   - ${BASE_URL}/api/id-cache/stats (statistics)`);
    console.log(`   - ${BASE_URL}/api/id-cache/mappings (all mappings)`);
    console.log(`   - ${BASE_URL}/api/id-cache/mappings?contentType=movie (movie mappings)`);
    console.log(`   - ${BASE_URL}/api/id-cache/mappings?contentType=series (series mappings)`);
    console.log(`   - ${BASE_URL}/api/id-cache/search?id=123 (search by ID)`);
    console.log(`   - ${BASE_URL}/api/id-cache/recommendations (storage recommendations)`);
    console.log(`   - DELETE ${BASE_URL}/api/id-cache/clear?type=old&days=30 (clear old entries)`);

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', error.response.data);
    }
  }
}

// Run the test
testIdCacheEndpoints();






