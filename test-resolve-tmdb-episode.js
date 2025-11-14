const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');

// Download anime-list-full.json locally
const REMOTE_MAPPING_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/refs/heads/master/anime-list-full.json';
const LOCAL_CACHE_PATH = path.join(__dirname, 'test-anime-list-full.json');

async function downloadFile(url, filePath) {
  return new Promise((resolve, reject) => {
    const file = require('fs').createWriteStream(filePath);
    const protocol = url.startsWith('https') ? https : http;
    
    protocol.get(url, (response) => {
      if (response.statusCode === 200) {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      } else if (response.statusCode === 304) {
        // Not modified, file already exists
        file.close();
        resolve();
      } else {
        file.close();
        reject(new Error(`Failed to download: ${response.statusCode}`));
      }
    }).on('error', (err) => {
      file.close();
      reject(err);
    });
  });
}

// Mock the kitsu module
const mockKitsu = {
  getMultipleAnimeDetails: async (kitsuIds) => {
    // For testing, we'll need to actually call Kitsu API or use mock data
    // For now, let's use a simple fetch
    const results = [];
    for (const id of kitsuIds) {
      try {
        const response = await fetch(`https://kitsu.io/api/edge/anime/${id}`);
        if (response.ok) {
          const data = await response.json();
          results.push(data.data);
        }
      } catch (err) {
        console.warn(`Failed to fetch Kitsu ID ${id}:`, err.message);
      }
    }
    return { data: results };
  }
};

// Simplified version of the mapper for testing
let animeIdMap = new Map();
let tmdbIndexArray = [];

function processAndIndexData(jsonData) {
  const animeList = JSON.parse(jsonData);
  animeIdMap.clear();
  for (const item of animeList) {
    if (item.mal_id) {
      animeIdMap.set(item.mal_id, item);
    }
  }
  tmdbIndexArray = animeList.filter(item => item.themoviedb_id);
  console.log(`Loaded ${animeIdMap.size} anime mappings.`);
}

function getMappingByKitsuId(kitsuId) {
  const numericKitsuId = parseInt(kitsuId, 10);
  const mapping = Array.from(animeIdMap.values()).find(item => item.kitsu_id === numericKitsuId);
  return mapping || null;
}

async function getFranchiseInfoFromTmdbId(tmdbId) {
  // Find all mappings for this TMDB ID
  const tmdbMappings = Array.from(animeIdMap.values())
    .filter(mapping => mapping.themoviedb_id === tmdbId);
  
  if (tmdbMappings.length === 0) {
    return null;
  }
  
  try {
    // Get all Kitsu IDs from the mappings
    const kitsuIds = tmdbMappings.map(m => m.kitsu_id).filter(Boolean);
    
    if (kitsuIds.length === 0) {
      return null;
    }
    
    // Fetch detailed information for all Kitsu entries
    const kitsuDetails = (await mockKitsu.getMultipleAnimeDetails(kitsuIds))?.data || [];
    
    // Filter for TV series and sort by start date
    const tvSeries = kitsuDetails
      .filter(item => item.attributes?.subtype?.toLowerCase() === 'tv')
      .sort((a, b) => {
        const aDate = new Date(a.attributes?.startDate || '9999-12-31');
        const bDate = new Date(b.attributes?.startDate || '9999-12-31');
        return aDate - bDate;
      });
    
    const needsEpisodeMapping = tvSeries.length > 1;
    
    return {
      tmdbId: parseInt(tmdbId, 10),
      totalKitsuIds: kitsuIds.length,
      tvSeriesCount: tvSeries.length,
      needsEpisodeMapping,
      kitsuDetails: kitsuDetails.map(item => ({
        id: parseInt(item.id, 10),
        title: item.attributes?.canonicalTitle,
        subtype: item.attributes?.subtype,
        startDate: item.attributes?.startDate,
        episodeCount: item.attributes?.episodeCount
      }))
    };
  } catch (error) {
    console.error(`Error getting franchise info for TMDB ${tmdbId}:`, error);
    return null;
  }
}

async function resolveTmdbEpisodeFromKitsu(kitsuId, kitsuEpisodeNumber) {
  // Get the mapping to find the TMDB ID
  const mapping = getMappingByKitsuId(kitsuId);
  if (!mapping || !mapping.themoviedb_id) {
    console.warn(`No TMDB mapping found for Kitsu ID ${kitsuId}`);
    return null;
  }
  
  const tmdbId = mapping.themoviedb_id;
  console.log(`Resolving TMDB episode from Kitsu ID ${kitsuId} episode ${kitsuEpisodeNumber} (TMDB ID: ${tmdbId})`);
  
  try {
    // Get franchise information for this TMDB ID
    const franchiseInfo = await getFranchiseInfoFromTmdbId(tmdbId);
    if (!franchiseInfo) {
      console.warn(`No franchise info found for TMDB ID ${tmdbId}`);
      return null;
    }
    
    // Get all Kitsu entries sorted by start date
    const kitsuEntries = franchiseInfo.kitsuDetails
      .filter(entry => entry.subtype?.toLowerCase() === 'tv')
      .sort((a, b) => new Date(a.startDate || '9999-12-31') - new Date(b.startDate || '9999-12-31'));
    
    // Find which Kitsu entry this ID corresponds to
    const kitsuEntryIndex = kitsuEntries.findIndex(entry => entry.id === parseInt(kitsuId, 10));
    if (kitsuEntryIndex === -1) {
      console.warn(`Kitsu ID ${kitsuId} not found in franchise entries for TMDB ${tmdbId}`);
      return null;
    }
    
    const hasMultipleKitsuEntries = kitsuEntries.length > 1;
    const isFirstEntry = kitsuEntryIndex === 0;
    
    // Strategy 1: Try season-based mapping first if NOT in first entry
    // This handles multi-season scenarios like To Your Eternity
    if (!isFirstEntry && hasMultipleKitsuEntries) {
      const tmdbSeasonNumber = kitsuEntryIndex + 1;
      console.log(`Kitsu ID ${kitsuId} episode ${kitsuEpisodeNumber} maps to TMDB ${tmdbId} Season ${tmdbSeasonNumber} Episode ${kitsuEpisodeNumber} (multi-season scenario)`);
      return {
        tmdbId: tmdbId,
        seasonNumber: tmdbSeasonNumber,
        episodeNumber: kitsuEpisodeNumber
      };
    }
    
    // Strategy 2: Episode-based mapping (single-season scenario)
    // Only for first entry when needsEpisodeMapping is true
    // This handles cases like Solo Leveling where 1 TMDB season spans multiple Kitsu entries
    if (isFirstEntry && hasMultipleKitsuEntries && franchiseInfo.needsEpisodeMapping) {
      // Calculate cumulative episode number for Season 1
      let cumulativeEpisodes = 0;
      for (let i = 0; i < kitsuEntryIndex; i++) {
        cumulativeEpisodes += kitsuEntries[i].episodeCount || 0;
      }
      const tmdbEpisodeNumber = cumulativeEpisodes + kitsuEpisodeNumber;
      console.log(`Kitsu ID ${kitsuId} episode ${kitsuEpisodeNumber} maps to TMDB ${tmdbId} Season 1 Episode ${tmdbEpisodeNumber} (single-season scenario)`);
      return {
        tmdbId: tmdbId,
        seasonNumber: 1,
        episodeNumber: tmdbEpisodeNumber
      };
    }
    
    // Strategy 3: Default to season-based mapping (covers single entry or fallback)
    const tmdbSeasonNumber = kitsuEntryIndex + 1;
    console.log(`Kitsu ID ${kitsuId} episode ${kitsuEpisodeNumber} maps to TMDB ${tmdbId} Season ${tmdbSeasonNumber} Episode ${kitsuEpisodeNumber} (default season-based)`);
    return {
      tmdbId: tmdbId,
      seasonNumber: tmdbSeasonNumber,
      episodeNumber: kitsuEpisodeNumber
    };
    
  } catch (error) {
    console.error(`Error resolving TMDB episode from Kitsu ID ${kitsuId} episode ${kitsuEpisodeNumber}:`, error);
    return null;
  }
}

async function test() {
  console.log('Downloading anime-list-full.json...');
  try {
    await downloadFile(REMOTE_MAPPING_URL, LOCAL_CACHE_PATH);
    console.log('Download complete!\n');
  } catch (err) {
    console.error('Download failed:', err.message);
    process.exit(1);
  }

  console.log('Loading anime list data...');
  const jsonData = await fs.readFile(LOCAL_CACHE_PATH, 'utf8');
  processAndIndexData(jsonData);
  console.log('Data loaded!\n');

  // Test 1: Solo Leveling - First Kitsu entry, episode 1
  console.log('Test 1: Solo Leveling - Kitsu ID 46231, Episode 1');
  const result1 = await resolveTmdbEpisodeFromKitsu(46231, 1);
  console.log('Result:', JSON.stringify(result1, null, 2));
  console.log('Expected: { tmdbId: <id>, seasonNumber: 1, episodeNumber: 1 }');
  console.log('');

  // Test 2: Solo Leveling - First Kitsu entry, episode 12
  console.log('Test 2: Solo Leveling - Kitsu ID 46231, Episode 12');
  const result2 = await resolveTmdbEpisodeFromKitsu(46231, 12);
  console.log('Result:', JSON.stringify(result2, null, 2));
  console.log('Expected: { tmdbId: <id>, seasonNumber: 1, episodeNumber: 12 }');
  console.log('');

  // Test 3: To Your Eternity - First Kitsu entry (43211), episode 1
  console.log('Test 3: To Your Eternity - Kitsu ID 43211, Episode 1');
  const result3 = await resolveTmdbEpisodeFromKitsu(43211, 1);
  console.log('Result:', JSON.stringify(result3, null, 2));
  console.log('Expected: { tmdbId: <id>, seasonNumber: 1, episodeNumber: 1 }');
  console.log('');

  // Test 4: To Your Eternity - Second Kitsu entry (45045), episode 1
  console.log('Test 4: To Your Eternity - Kitsu ID 45045, Episode 1');
  const result4 = await resolveTmdbEpisodeFromKitsu(45045, 1);
  console.log('Result:', JSON.stringify(result4, null, 2));
  console.log('Expected: { tmdbId: <id>, seasonNumber: 2, episodeNumber: 1 }');
  console.log('');

  // Test 5: To Your Eternity - Third Kitsu entry (47161), episode 1
  console.log('Test 5: To Your Eternity - Kitsu ID 47161, Episode 1');
  const result5 = await resolveTmdbEpisodeFromKitsu(47161, 1);
  console.log('Result:', JSON.stringify(result5, null, 2));
  console.log('Expected: { tmdbId: <id>, seasonNumber: 3, episodeNumber: 1 }');
  console.log('');

  // Cleanup
  await fs.unlink(LOCAL_CACHE_PATH).catch(() => {});
  console.log('Tests complete!');
}

test().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

