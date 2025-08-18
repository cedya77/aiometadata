#!/usr/bin/env node

const anilist = require('../lib/anilist');

async function testBatchSizes() {
  console.log('🔍 Testing AniList GraphQL Batch Size Limits');
  console.log('===========================================');
  
  // Valid MAL IDs for testing
  const validMalIds = [
    1,    // Cowboy Bebop
    5,    // Cowboy Bebop: Tengoku no Tobira
    6,    // Trigun
    7,    // Witch Hunter Robin
    8,    // Boogiepop Phantom
    9,    // Seikai no Monshou
    10,   // Seikai no Senki
    11,   // Seikai no Senki II
    12,   // Seikai no Senki III
    13,   // Seikai no Senki IV
    14,   // Seikai no Senki Special
    15,   // Seikai no Senki II Special
    16,   // Seikai no Senki III Special
    17,   // Seikai no Senki IV Special
    18,   // Seikai no Senki V
    19,   // Seikai no Senki VI
    20,   // Seikai no Senki VII
    21,   // Seikai no Senki VIII
    22,   // Seikai no Senki IX
    23,   // Seikai no Senki X
    24,   // Seikai no Senki XI
    25    // Seikai no Senki XII
  ];
  
  const batchSizes = [5, 10, 15, 20, 25];
  
  for (const size of batchSizes) {
    console.log(`\n📦 Testing batch size: ${size}`);
    console.log(`MAL IDs: ${validMalIds.slice(0, size).join(', ')}`);
    
    try {
      const startTime = Date.now();
      const results = await anilist.getBatchAnimeArtwork(validMalIds.slice(0, size));
      const duration = Date.now() - startTime;
      
      console.log(`✅ Success: ${results.length} results in ${duration}ms`);
      console.log(`   Average: ${Math.round(duration / size)}ms per anime`);
      
      // Show first few results
      results.slice(0, 3).forEach((anime, i) => {
        console.log(`   ${i + 1}. ${anime.title?.english || anime.title?.romaji || 'Unknown'} (MAL: ${anime.idMal})`);
      });
      
    } catch (error) {
      console.log(`❌ Failed: ${error.message}`);
      break; // Stop testing if we hit a limit
    }
  }
  
  // Test the actual GraphQL query construction
  console.log('\n🔧 Testing GraphQL Query Construction');
  console.log('=====================================');
  
  const testSizes = [5, 10, 15, 20];
  for (const size of testSizes) {
    const queryParts = validMalIds.slice(0, size).map((malId, index) => `
      anime${index}: Media(idMal: ${malId}, type: ANIME) {
        id
        idMal
        title { romaji english native }
        coverImage { large medium color }
        bannerImage
      }
    `);
    
    const query = `
      query {
        ${queryParts.join('\n')}
      }
    `;
    
    console.log(`\nBatch size ${size}:`);
    console.log(`- Query length: ${query.length} characters`);
    console.log(`- Aliases: ${size}`);
    console.log(`- Estimated response size: ~${size * 2}KB`);
  }
  
  // Show rate limit status
  const rateLimitStatus = anilist.getRateLimitStatus();
  console.log('\n📊 Rate Limit Status:');
  console.log(`- Remaining: ${rateLimitStatus.remaining}/${rateLimitStatus.limit}`);
  console.log(`- Queue length: ${rateLimitStatus.queueLength}`);
  console.log(`- Is limited: ${rateLimitStatus.isLimited}`);
}

// Run the test
testBatchSizes().catch(console.error);







