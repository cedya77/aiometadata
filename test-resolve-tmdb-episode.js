const { initializeMapper, resolveTmdbEpisodeFromKitsu } = require('../addon/lib/id-mapper');

async function test() {
  console.log('Initializing mapper...');
  await initializeMapper();
  console.log('Mapper initialized!\n');

  // Test 1: Solo Leveling - First Kitsu entry, episode 1
  console.log('Test 1: Solo Leveling - Kitsu ID 46231, Episode 1');
  const result1 = await resolveTmdbEpisodeFromKitsu(46231, 1);
  console.log('Result:', JSON.stringify(result1, null, 2));
  console.log('Expected: { \"tmdbId\": 127138, \"seasonNumber\": 1, \"episodeNumber\": 1 }');
  console.log('');

  // Test 2: Solo Leveling - First Kitsu entry, episode 12
  console.log('Test 2: Solo Leveling - Kitsu ID 46231, Episode 12');
  const result2 = await resolveTmdbEpisodeFromKitsu(46231, 12);
  console.log('Result:', JSON.stringify(result2, null, 2));
  console.log('Expected: { \"tmdbId\": 127138, \"seasonNumber\": 1, \"episodeNumber\": 12 }');
  console.log('');

  // Test 3: To Your Eternity - First Kitsu entry (43211), episode 1
  console.log('Test 3: To Your Eternity - Kitsu ID 43211, Episode 1');
  const result3 = await resolveTmdbEpisodeFromKitsu(43211, 1);
  console.log('Result:', JSON.stringify(result3, null, 2));
  console.log('Expected: { \"tmdbId\": 91562, \"seasonNumber\": 1, \"episodeNumber\": 1 }');
  console.log('');

  // Test 4: To Your Eternity - Second Kitsu entry (45045), episode 1
  console.log('Test 4: To Your Eternity - Kitsu ID 45045, Episode 1');
  const result4 = await resolveTmdbEpisodeFromKitsu(45045, 1);
  console.log('Result:', JSON.stringify(result4, null, 2));
  console.log('Expected: { \"tmdbId\": 91562, \"seasonNumber\": 2, \"episodeNumber\": 1 }');
  console.log('');

  // Test 5: One Piece - Kitsu ID 12, Episode 100
  console.log('Test 5: One Piece - Kitsu ID 12, Episode 100');
  const result5 = await resolveTmdbEpisodeFromKitsu(12, 100);
  console.log('Result:', JSON.stringify(result5, null, 2));
  console.log('Expected: { \"tmdbId\": 37854, \"seasonNumber\": 4, \"episodeNumber\": 10 }');
  console.log('');
  
  // Test 6: One Piece - Kitsu ID 12, Episode 1075
  console.log('Test 6: One Piece - Kitsu ID 12, Episode 1075');
  const result6 = await resolveTmdbEpisodeFromKitsu(12, 1075);
  console.log('Result:', JSON.stringify(result6, null, 2));
  // Manually checked: S21 ends at 1004. S22 starts at 1005. So 1075 is in S22. 1075 - 1004 = 71.
  console.log('Expected: { \"tmdbId\": 37854, \"seasonNumber\": 22, \"episodeNumber\": 71 }');
  console.log('');

  console.log('Tests complete!');
}

test().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});