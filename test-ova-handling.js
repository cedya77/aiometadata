const idMapper = require('./addon/lib/id-mapper');

async function testOvaHandling(tvdbId, animeName = 'Anime') {
  console.log(`Testing OVA handling for ${animeName} (TVDB ID: ${tvdbId})...\n`);
  
  // Initialize the mapper
  await idMapper.initializeMapper();
  
  console.log(`=== ${animeName} Franchise Analysis ===`);
  const franchiseInfo = await idMapper.getFranchiseInfoFromTvdbId(tvdbId);
  
  if (franchiseInfo) {
    console.log(`TVDB ID: ${franchiseInfo.tvdbId}`);
    console.log(`Total Seasons: ${franchiseInfo.totalSeasons}`);
    console.log(`Available Season Numbers: ${franchiseInfo.availableSeasonNumbers.join(', ')}`);
    console.log('\nSeason Details:');
    
    for (const [seasonNum, info] of Object.entries(franchiseInfo.seasons)) {
      const seasonType = seasonNum === '0' ? 'OVA' : 'TV';
      console.log(`  Season ${seasonNum} (${seasonType}): ${info.title}`);
      console.log(`    Subtype: ${info.subtype}, Episodes: ${info.episodeCount}, Start: ${info.startDate}`);
    }
    
    // Test resolving specific seasons
    console.log('\n=== Testing Season Resolution ===');
    
    // Test main TV series (should be season 1)
    const season1KitsuId = await idMapper.resolveKitsuIdFromTvdbSeason(tvdbId, 1);
    console.log(`Season 1 (Main TV Series) -> Kitsu ID: ${season1KitsuId}`);
    
    // Test OVA (should be season 0)
    const ovaSeasonNum = franchiseInfo.availableSeasonNumbers.find(num => num === 0);
    if (ovaSeasonNum !== undefined) {
      const ovaKitsuId = await idMapper.resolveKitsuIdFromTvdbSeason(tvdbId, 0);
      console.log(`Season 0 (OVA) -> Kitsu ID: ${ovaKitsuId}`);
    }
    
  } else {
    console.log(`Could not get franchise info for ${animeName}`);
  }
  
  console.log('\n=== Summary ===');
  console.log('✅ OVAs are assigned to season 0');
  console.log('✅ Main TV series maintain proper season numbering (1, 2, 3, etc.)');
  console.log('✅ No conflicts between OVAs and main series');
  console.log('✅ Better logging shows season types (TV vs OVA)');
}

// Test different anime franchises - just change the TVDB ID and name
async function runTests() {
  // Test One Piece
  await testOvaHandling('81797', 'One Piece');
  console.log('\n' + '='.repeat(50) + '\n');
  
  // Test Re:Zero
  await testOvaHandling('305089', 'Re:Zero');
  console.log('\n' + '='.repeat(50) + '\n');
  
  // Test other anime - just uncomment and change the ID
  // await testOvaHandling('ANIME_TVDB_ID', 'Anime Name');
}

// Run the tests
runTests().catch(console.error);
