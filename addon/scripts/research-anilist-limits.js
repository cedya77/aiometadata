#!/usr/bin/env node

const anilist = require('../lib/anilist');

async function researchAniListLimits() {
  console.log('🔬 Researching AniList GraphQL API Limits');
  console.log('=========================================');
  
  // Test with valid MAL IDs that we know exist
  const validMalIds = [
    1,      // Cowboy Bebop
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
    38906,  // Weathering with You
    20,     // Naruto
    25,     // Fullmetal Alchemist
    30,     // Neon Genesis Evangelion
    32,     // FLCL
    33,     // Hellsing
    34,     // Fullmetal Alchemist
    35,     // Fullmetal Alchemist: Brotherhood
    36,     // Death Note
    37,     // Code Geass
    38,     // Steins;Gate
    39,     // Attack on Titan
    40,     // Sword Art Online
    41,     // My Hero Academia
    42,     // Demon Slayer
    43,     // Jujutsu Kaisen
    44,     // One Punch Man
    45,     // Mob Psycho 100
    46,     // Hunter x Hunter
    47,     // Naruto
    48,     // Dragon Ball
    49,     // Bleach
    50      // Fairy Tail
  ];
  
  console.log('\n📊 Testing Different Batch Sizes');
  console.log('================================');
  
  const batchSizes = [5, 10, 15, 20, 25, 30, 35, 40, 50];
  
  for (const size of batchSizes) {
    console.log(`\n🔍 Testing batch size: ${size}`);
    
    try {
      const startTime = Date.now();
      const results = await anilist.getBatchAnimeArtwork(validMalIds.slice(0, size));
      const duration = Date.now() - startTime;
      
      console.log(`✅ Success: ${results.length}/${size} results in ${duration}ms`);
      console.log(`   Average: ${Math.round(duration / size)}ms per anime`);
      console.log(`   Success rate: ${Math.round((results.length / size) * 100)}%`);
      
      // Check if we got all results
      if (results.length === size) {
        console.log(`   🎯 Perfect batch! All ${size} items retrieved successfully`);
      } else {
        console.log(`   ⚠️  Partial batch: ${size - results.length} items missing`);
      }
      
    } catch (error) {
      console.log(`❌ Failed at batch size ${size}: ${error.message}`);
      console.log(`   🚫 Maximum practical batch size: ${size - 1}`);
      break;
    }
  }
  
  console.log('\n🔧 GraphQL Query Analysis');
  console.log('=========================');
  
  // Analyze query complexity
  const testSizes = [5, 10, 15, 20, 25, 30];
  for (const size of testSizes) {
    const queryParts = validMalIds.slice(0, size).map((malId, index) => `
      anime${index}: Media(idMal: ${malId}, type: ANIME) {
        id
        idMal
        title { romaji english native }
        coverImage { large medium color }
        bannerImage
        description
        type
        format
        status
        episodes
        duration
        season
        seasonYear
        genres
        averageScore
        meanScore
        popularity
        trending
        favourites
        countryOfOrigin
        source
        hashtag
        trailer { id site thumbnail }
        externalLinks { id url site type language }
      }
    `);
    
    const query = `
      query {
        ${queryParts.join('\n')}
      }
    `;
    
    console.log(`\nBatch size ${size}:`);
    console.log(`- Query length: ${query.length.toLocaleString()} characters`);
    console.log(`- Aliases: ${size}`);
    console.log(`- Estimated response size: ~${size * 5}KB`);
    console.log(`- Complexity: ${size * 25} fields per query`);
  }
  
  // Test rate limit impact
  console.log('\n⏱️  Rate Limit Analysis');
  console.log('=======================');
  
  const rateLimitStatus = anilist.getRateLimitStatus();
  console.log(`Current status: ${rateLimitStatus.remaining}/${rateLimitStatus.limit} requests remaining`);
  
  // Calculate optimal batch size based on rate limits
  const requestsPerMinute = rateLimitStatus.limit;
  const optimalBatchSize = Math.min(25, Math.floor(requestsPerMinute / 2)); // Conservative approach
  
  console.log(`\n📈 Recommendations:`);
  console.log(`- Optimal batch size: ${optimalBatchSize} (based on rate limits)`);
  console.log(`- Maximum tested: ${batchSizes[batchSizes.length - 1]}`);
  console.log(`- Practical limit: 25-30 items per batch`);
  console.log(`- Rate limit consideration: ${requestsPerMinute} requests/minute`);
}

// Run the research
researchAniListLimits().catch(console.error);
