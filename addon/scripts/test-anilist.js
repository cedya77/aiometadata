#!/usr/bin/env node

const anilist = require('../lib/anilist');

async function testAniListIntegration() {
  console.log('🧪 Testing AniList Integration\n');

  // Test single anime artwork
  console.log('1. Testing single anime artwork...');
  const testMalId = '1'; // Cowboy Bebop
  const singleAnime = await anilist.getAnimeArtwork(testMalId);
  
  if (singleAnime) {
    console.log(`✅ Found anime: ${singleAnime.title?.english || singleAnime.title?.romaji}`);
    console.log(`   Poster: ${anilist.getPosterUrl(singleAnime) ? '✅' : '❌'}`);
    console.log(`   Background: ${anilist.getBackgroundUrl(singleAnime) ? '✅' : '❌'}`);
    console.log(`   Color: ${anilist.getAnimeColor(singleAnime) || 'N/A'}`);
  } else {
    console.log('❌ Failed to fetch single anime');
  }

  // Test batch artwork with aliasing
  console.log('\n2. Testing batch artwork with aliasing...');
  const testMalIds = ['1', '5', '6', '7', '8']; // Multiple popular anime
  const batchAnime = await anilist.getBatchAnimeArtwork(testMalIds);
  
  console.log(`✅ Retrieved ${batchAnime.length} anime from batch request`);
  batchAnime.forEach(anime => {
    console.log(`   ${anime.title?.english || anime.title?.romaji} (MAL: ${anime.idMal})`);
  });

  // Test catalog artwork
  console.log('\n3. Testing catalog artwork...');
  const catalogArtwork = await anilist.getCatalogArtwork(testMalIds);
  
  console.log(`✅ Retrieved ${catalogArtwork.length} catalog artworks`);
  catalogArtwork.forEach(artwork => {
    console.log(`   ${artwork.title} - Poster: ${artwork.poster ? '✅' : '❌'}, Background: ${artwork.background ? '✅' : '❌'}`);
  });

  // Test cache functionality
  console.log('\n4. Testing cache functionality...');
  const cacheStats = anilist.getCacheStats();
  console.log(`✅ Cache stats: ${cacheStats.validEntries} valid entries, ${cacheStats.expiredEntries} expired`);

  // Test cache hit
  console.log('\n5. Testing cache hit...');
  const cachedAnime = await anilist.getAnimeArtwork(testMalId);
  if (cachedAnime) {
    console.log('✅ Cache hit successful');
  }

  // Performance test
  console.log('\n6. Performance test...');
  const startTime = Date.now();
  const performanceTestIds = ['1', '5', '6', '7', '8', '9', '10', '11', '12', '13'];
  const performanceResults = await anilist.getBatchAnimeArtwork(performanceTestIds);
  const endTime = Date.now();
  
  console.log(`✅ Performance: ${performanceResults.length} anime in ${endTime - startTime}ms`);
  console.log(`   Average: ${((endTime - startTime) / performanceResults.length).toFixed(2)}ms per anime`);

  console.log('\n🎉 AniList integration test complete!');
}

async function testArtProviderIntegration() {
  console.log('\n🎨 Testing Art Provider Integration\n');

  const Utils = require('../utils/parseProps');
  
  // Mock config with AniList as art provider
  const config = {
    artProviders: {
      anime: 'anilist'
    }
  };

  // Test single poster
  console.log('1. Testing single poster with AniList...');
  const poster = await Utils.getAnimePoster({
    malId: '1',
    malPosterUrl: 'https://cdn.myanimelist.net/images/anime/cover/medium/bx1-CXtrrkMpz8Dq.jpg',
    mediaType: 'series'
  }, config);
  
  console.log(`✅ Poster URL: ${poster ? 'Retrieved' : 'Failed'}`);

  // Test batch artwork
  console.log('\n2. Testing batch artwork...');
  const batchArtwork = await Utils.getBatchAnimeArtwork(['1', '5', '6'], config);
  console.log(`✅ Batch artwork: ${batchArtwork.length} items retrieved`);

  console.log('\n🎉 Art provider integration test complete!');
}

async function main() {
  const test = process.argv[2] || 'all';
  
  try {
    if (test === 'anilist' || test === 'all') {
      await testAniListIntegration();
    }
    
    if (test === 'artprovider' || test === 'all') {
      await testArtProviderIntegration();
    }
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
