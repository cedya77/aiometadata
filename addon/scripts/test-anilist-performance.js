#!/usr/bin/env node

const anilist = require('../lib/anilist');

async function testSequentialRequests(malIds) {
  console.log(`\n=== Testing Sequential Requests (${malIds.length} anime) ===`);
  const startTime = Date.now();
  
  const results = [];
  for (const malId of malIds) {
    const start = Date.now();
    const result = await anilist.getAnimeArtworkByMalId(malId);
    const duration = Date.now() - start;
    console.log(`  MAL ID ${malId}: ${duration}ms`);
    results.push(result);
  }
  
  const totalTime = Date.now() - startTime;
  console.log(`Total time: ${totalTime}ms`);
  console.log(`Average per request: ${Math.round(totalTime / malIds.length)}ms`);
  
  return { totalTime, results };
}

async function testBatchRequests(malIds) {
  console.log(`\n=== Testing Batch Requests with Aliasing (${malIds.length} anime) ===`);
  const startTime = Date.now();
  
  const results = await anilist.getBatchAnimeArtwork(malIds);
  
  const totalTime = Date.now() - startTime;
  console.log(`Total time: ${totalTime}ms`);
  console.log(`Average per anime: ${Math.round(totalTime / malIds.length)}ms`);
  
  return { totalTime, results };
}

async function testRateLimitImpact() {
  console.log('\n=== Rate Limit Impact Analysis ===');
  
  const rateLimitStatus = anilist.getRateLimitStatus();
  console.log('Current rate limit status:', rateLimitStatus);
  
  // Calculate theoretical limits
  const requestsPerMinute = rateLimitStatus.limit;
  const requestsPerSecond = requestsPerMinute / 60;
  const secondsPerRequest = 60 / requestsPerMinute;
  
  console.log(`\nTheoretical limits:`);
  console.log(`- Requests per minute: ${requestsPerMinute}`);
  console.log(`- Requests per second: ${requestsPerSecond.toFixed(2)}`);
  console.log(`- Seconds per request: ${secondsPerRequest.toFixed(2)}`);
  
  // Calculate time for different scenarios
  const scenarios = [5, 10, 20, 50, 100];
  
  console.log(`\nTime comparison for different batch sizes:`);
  console.log(`Anime Count | Sequential (min) | Batch (min) | Speedup`);
  console.log(`-----------|------------------|-------------|--------`);
  
  for (const count of scenarios) {
    const sequentialTime = (count * secondsPerRequest) / 60; // minutes
    const batchRequests = Math.ceil(count / 10); // 10 per batch
    const batchTime = (batchRequests * secondsPerRequest) / 60; // minutes
    const speedup = sequentialTime / batchTime;
    
    console.log(`${count.toString().padStart(10)} | ${sequentialTime.toFixed(2).padStart(16)} | ${batchTime.toFixed(2).padStart(11)} | ${speedup.toFixed(1)}x`);
  }
}

async function runPerformanceTest() {
  console.log('🚀 AniList API Performance Test');
  console.log('================================');
  
  // Test with popular anime MAL IDs
  const testMalIds = [
    1,    // Cowboy Bebop
    5,    // Cowboy Bebop: Tengoku no Tobira
    6,    // Trigun
    7,    // Witch Hunter Robin
    8,    // Boogiepop Phantom
    9,    // Seikai no Monshou
    10,   // Seikai no Senki
    11,   // Seikai no Senki II
    12,   // Seikai no Senki III
    13    // Seikai no Senki IV
  ];
  
  try {
    // Test rate limit impact first
    await testRateLimitImpact();
    
    // Test with smaller batch first
    const smallBatch = testMalIds.slice(0, 5);
    console.log('\n' + '='.repeat(50));
    
    const sequentialResult = await testSequentialRequests(smallBatch);
    const batchResult = await testBatchRequests(smallBatch);
    
    const speedup = sequentialResult.totalTime / batchResult.totalTime;
    console.log(`\n🎯 Performance Summary:`);
    console.log(`Sequential: ${sequentialResult.totalTime}ms`);
    console.log(`Batch: ${batchResult.totalTime}ms`);
    console.log(`Speedup: ${speedup.toFixed(1)}x faster with aliasing`);
    
    // Show cache stats
    const cacheStats = anilist.getCacheStats();
    console.log(`\n📊 Cache Stats:`);
    console.log(`- Total entries: ${cacheStats.totalEntries}`);
    console.log(`- Valid entries: ${cacheStats.validEntries}`);
    console.log(`- Rate limit remaining: ${cacheStats.rateLimit.remaining}/${cacheStats.rateLimit.limit}`);
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

// Run the test
runPerformanceTest().catch(console.error);







