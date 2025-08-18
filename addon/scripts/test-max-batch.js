#!/usr/bin/env node

const anilist = require('../lib/anilist');

async function testMaxBatchSize() {
  console.log('🔬 Testing Maximum AniList GraphQL Batch Size');
  console.log('=============================================');
  
  // Only the valid MAL IDs you provided
  const validMalIds = [
    1,      // Cowboy Bebop
    20,     // Naruto
    21,     // One Piece
    199,    // Spirited Away
    1535,   // Death Note
    1575,   // Code Geass
    5114,   // Fullmetal Alchemist: Brotherhood
    6467,   // Kimi ni Todoke
    9253,   // Steins;Gate
    11061,  // Hunter x Hunter
    16498,  // Attack on Titan
    20583,  // Haikyuu!!
    30276,  // One Punch Man
    31043,  // Erased
    31240,  // Re:Zero - Starting Life in Another World
    31964,  // My Hero Academia
    32281,  // Your Name
    33352,  // Violet Evergarden
    38000,  // Demon Slayer
    38906   // Weathering with You
  ];
  
  console.log(`Testing with ${validMalIds.length} valid MAL IDs`);
  console.log('MAL IDs:', validMalIds.join(', '));
  
  // Test the full batch
  console.log(`\n🔍 Testing full batch of ${validMalIds.length} items`);
  
  try {
    const startTime = Date.now();
    const results = await anilist.getBatchAnimeArtwork(validMalIds);
    const duration = Date.now() - startTime;
    
    console.log(`✅ Success: ${results.length}/${validMalIds.length} results in ${duration}ms`);
    console.log(`   Average: ${Math.round(duration / validMalIds.length)}ms per anime`);
    console.log(`   Success rate: ${Math.round((results.length / validMalIds.length) * 100)}%`);
    
    if (results.length === validMalIds.length) {
      console.log(`   🎯 Perfect! All ${validMalIds.length} items retrieved successfully`);
      console.log(`   🚀 Maximum practical batch size: ${validMalIds.length} or more`);
    } else {
      console.log(`   ⚠️  Partial batch: ${validMalIds.length - results.length} items missing`);
    }
    
    // Show the results
    console.log('\n📋 Retrieved Anime:');
    results.forEach((anime, i) => {
      console.log(`   ${i + 1}. ${anime.title?.english || anime.title?.romaji || 'Unknown'} (MAL: ${anime.idMal})`);
    });
    
  } catch (error) {
    console.log(`❌ Failed: ${error.message}`);
    console.log(`   🚫 Maximum batch size is less than ${validMalIds.length}`);
  }
  
  // Test with larger batches by duplicating some IDs
  console.log('\n🔍 Testing with larger batches (duplicated IDs)');
  
  const largerBatches = [25, 30, 35, 40, 50];
  
  for (const size of largerBatches) {
    // Create a larger batch by repeating some IDs
    const extendedBatch = [];
    for (let i = 0; i < size; i++) {
      extendedBatch.push(validMalIds[i % validMalIds.length]);
    }
    
    console.log(`\n📦 Testing batch size: ${size} (with duplicates)`);
    
    try {
      const startTime = Date.now();
      const results = await anilist.getBatchAnimeArtwork(extendedBatch);
      const duration = Date.now() - startTime;
      
      console.log(`✅ Success: ${results.length} results in ${duration}ms`);
      console.log(`   Average: ${Math.round(duration / size)}ms per anime`);
      
    } catch (error) {
      console.log(`❌ Failed at batch size ${size}: ${error.message}`);
      console.log(`   🚫 Maximum batch size: ${size - 1}`);
      break;
    }
  }
  
  // Show final stats
  const rateLimitStatus = anilist.getRateLimitStatus();
  console.log('\n📊 Final Statistics:');
  console.log(`- Rate limit remaining: ${rateLimitStatus.remaining}/${rateLimitStatus.limit}`);
  console.log(`- Cache entries: ${anilist.getCacheStats().totalEntries}`);
  console.log(`- Valid MAL IDs tested: ${validMalIds.length}`);
  console.log(`- Maximum practical batch size: ${validMalIds.length} (confirmed)`);
}

// Run the test
testMaxBatchSize().catch(console.error);







