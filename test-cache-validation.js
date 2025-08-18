#!/usr/bin/env node

const axios = require('axios');

// Configuration
const BASE_URL = process.env.TEST_URL || 'http://localhost:1337';

console.log('🧪 Testing Cache Validation System');
console.log(`📍 Base URL: ${BASE_URL}\n`);

async function testCacheValidation() {
  try {
    // 1. Test cache validation for meta entries
    console.log('1. Testing cache validation for meta entries...');
    const validateResponse = await axios.post(`${BASE_URL}/api/cache/validate`, {
      pattern: 'meta*',
      contentType: 'meta'
    });
    
    if (validateResponse.data.success) {
      const data = validateResponse.data.data;
      console.log('✅ Cache Validation Results:');
      console.log(`   🔍 Checked: ${data.checked} cache keys`);
      console.log(`   🗑️  Invalidated: ${data.invalidated} bad entries`);
      console.log(`   📋 Pattern: ${data.pattern}`);
      console.log(`   📄 Content Type: ${data.contentType}`);
    } else {
      console.log('❌ Cache validation failed');
    }

    // 2. Test cache validation for catalog entries
    console.log('\n2. Testing cache validation for catalog entries...');
    const catalogValidateResponse = await axios.post(`${BASE_URL}/api/cache/validate`, {
      pattern: 'catalog*',
      contentType: 'catalog'
    });
    
    if (catalogValidateResponse.data.success) {
      const data = catalogValidateResponse.data.data;
      console.log('✅ Catalog Cache Validation Results:');
      console.log(`   🔍 Checked: ${data.checked} cache keys`);
      console.log(`   🗑️  Invalidated: ${data.invalidated} bad entries`);
    } else {
      console.log('❌ Catalog cache validation failed');
    }

    // 3. Test global meta cache validation
    console.log('\n3. Testing global meta cache validation...');
    const globalValidateResponse = await axios.post(`${BASE_URL}/api/cache/validate`, {
      pattern: 'meta-global*',
      contentType: 'meta'
    });
    
    if (globalValidateResponse.data.success) {
      const data = globalValidateResponse.data.data;
      console.log('✅ Global Meta Cache Validation Results:');
      console.log(`   🔍 Checked: ${data.checked} cache keys`);
      console.log(`   🗑️  Invalidated: ${data.invalidated} bad entries`);
    } else {
      console.log('❌ Global meta cache validation failed');
    }

    // 4. Test comprehensive cache cleaning
    console.log('\n4. Testing comprehensive cache cleaning...');
    const cleanResponse = await axios.post(`${BASE_URL}/api/cache/clean-bad`);
    
    if (cleanResponse.data.success) {
      const data = cleanResponse.data.data;
      console.log('✅ Comprehensive Cache Cleaning Results:');
      console.log(`   🔍 Total Checked: ${data.totalChecked} cache keys`);
      console.log(`   🗑️  Total Invalidated: ${data.totalInvalidated} bad entries`);
      
      if (data.details) {
        console.log('   📊 Breakdown:');
        console.log(`      Meta: ${data.details.meta.checked} checked, ${data.details.meta.invalidated} invalidated`);
        console.log(`      Catalog: ${data.details.catalog.checked} checked, ${data.details.catalog.invalidated} invalidated`);
        console.log(`      Global: ${data.details.global.checked} checked, ${data.details.global.invalidated} invalidated`);
      }
    } else {
      console.log('❌ Comprehensive cache cleaning failed');
    }

    // 5. Test specific cache key checking
    console.log('\n5. Testing specific cache key checking...');
    try {
      const checkResponse = await axios.get(`${BASE_URL}/api/cache/check/meta-global:tmdb:550:en-US`);
      
      if (checkResponse.data.success) {
        const data = checkResponse.data.data;
        console.log('✅ Cache Key Check Results:');
        console.log(`   🔑 Key: ${data.key}`);
        console.log(`   ✅ Should Invalidate: ${data.shouldInvalidate}`);
        if (data.reason) {
          console.log(`   📝 Reason: ${data.reason}`);
        }
        if (data.issues && data.issues.length > 0) {
          console.log(`   ⚠️  Issues: ${data.issues.join(', ')}`);
        }
      } else {
        console.log('❌ Cache key check failed');
      }
    } catch (error) {
      if (error.response?.status === 404) {
        console.log('ℹ️  Cache key not found (expected for test)');
      } else {
        console.log('❌ Cache key check failed:', error.message);
      }
    }

    console.log('\n🎉 All cache validation tests completed!');
    console.log('\n📋 Available Cache Validation Endpoints:');
    console.log(`   - POST ${BASE_URL}/api/cache/validate (validate specific patterns)`);
    console.log(`   - POST ${BASE_URL}/api/cache/clean-bad (clean all bad cache)`);
    console.log(`   - GET ${BASE_URL}/api/cache/check/:key (check specific key)`);
    console.log('\n🔧 Usage Examples:');
    console.log('   # Clean all bad meta cache');
    console.log('   curl -X POST "http://localhost:1337/api/cache/clean-bad"');
    console.log('');
    console.log('   # Validate specific meta pattern');
    console.log('   curl -X POST "http://localhost:1337/api/cache/validate" \\');
    console.log('     -H "Content-Type: application/json" \\');
    console.log('     -d \'{"pattern": "meta-global:tmdb:*", "contentType": "meta"}\'');
    console.log('');
    console.log('   # Check specific cache key');
    console.log('   curl "http://localhost:1337/api/cache/check/meta-global:tmdb:550:en-US"');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', error.response.data);
    }
  }
}

// Run the test
testCacheValidation();






