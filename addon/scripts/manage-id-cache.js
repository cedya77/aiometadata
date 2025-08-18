#!/usr/bin/env node

const idCacheManager = require('../lib/id-cache-manager');

async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  try {
    switch (command) {
      case 'stats':
        await showStats();
        break;
      case 'clear':
        await clearCache(args);
        break;
      case 'search':
        await searchCache(args);
        break;
      case 'list':
        await listCache(args);
        break;
      case 'add':
        await addMapping(args);
        break;
      case 'optimize':
        await optimizeStorage();
        break;
      case 'recommendations':
        await showRecommendations();
        break;
      case 'config':
        await showConfig();
        break;
      default:
        showHelp();
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

async function showStats() {
  console.log('📊 ID Cache Statistics\n');
  
  const stats = await idCacheManager.getCacheHitRate();
  
  console.log(`Total Mappings: ${stats.totalMappings.toLocaleString()}`);
  console.log(`Estimated Size: ${stats.estimatedSizeKB} KB`);
  console.log(`Usage: ${stats.usagePercentage}% (${stats.totalMappings}/${stats.maxSize.toLocaleString()})`);
  console.log(`TTL: ${stats.ttlDays} days`);
  console.log(`Compression: ${stats.compressionEnabled ? 'Enabled' : 'Disabled'}\n`);
  
  if (stats.stats.length === 0) {
    console.log('No cache entries found.');
    return;
  }
  
  stats.stats.forEach(stat => {
    console.log(`${stat.content_type.toUpperCase()}:`);
    console.log(`  Total: ${stat.total_mappings.toLocaleString()}`);
    console.log(`  With TMDB: ${stat.with_tmdb.toLocaleString()}`);
    console.log(`  With TVDB: ${stat.with_tvdb.toLocaleString()}`);
    console.log(`  With IMDb: ${stat.with_imdb.toLocaleString()}`);
    console.log(`  With TVmaze: ${stat.with_tvmaze.toLocaleString()}`);
    console.log(`  Complete: ${stat.complete_mappings.toLocaleString()}`);
    console.log(`  Expired: ${stat.expired_entries.toLocaleString()}\n`);
  });
}

async function clearCache(args) {
  const type = args[0];
  
  if (type === 'all') {
    const count = await idCacheManager.clearAllCache();
    console.log(`✅ Cleared all ${count.toLocaleString()} cache entries`);
  } else if (type === 'old') {
    const days = parseInt(args[1]) || null;
    const count = await idCacheManager.clearOldCache(days);
    console.log(`✅ Cleared ${count.toLocaleString()} cache entries older than ${days || 'TTL'} days`);
  } else if (type === 'expired') {
    const count = await idCacheManager.clearOldCache();
    console.log(`✅ Cleared ${count.toLocaleString()} expired cache entries`);
  } else {
    console.error('Usage: node manage-id-cache.js clear [all|old|expired] [days]');
  }
}

async function searchCache(args) {
  const searchId = args[0];
  const contentType = args[1] || null;
  const limit = parseInt(args[2]) || 10;
  
  if (!searchId) {
    console.error('Usage: node manage-id-cache.js search <id> [content_type] [limit]');
    return;
  }
  
  console.log(`🔍 Searching for ID: ${searchId}${contentType ? ` (${contentType})` : ''}\n`);
  
  const results = await idCacheManager.searchCache(searchId, contentType, limit);
  
  if (results.length === 0) {
    console.log('No matches found.');
    return;
  }
  
  results.forEach((entry, index) => {
    console.log(`${index + 1}. ${entry.content_type.toUpperCase()}:`);
    console.log(`   TMDB: ${entry.tmdb_id || 'N/A'}`);
    console.log(`   TVDB: ${entry.tvdb_id || 'N/A'}`);
    console.log(`   IMDb: ${entry.imdb_id || 'N/A'}`);
    console.log(`   TVmaze: ${entry.tvmaze_id || 'N/A'}`);
    console.log(`   Updated: ${entry.updated_at}\n`);
  });
}

async function listCache(args) {
  const contentType = args[0] || 'movie';
  const limit = parseInt(args[1]) || 10;
  const offset = parseInt(args[2]) || 0;
  
  console.log(`📋 Recent ${contentType} cache entries (limit: ${limit}, offset: ${offset})\n`);
  
  const entries = await idCacheManager.getCacheByType(contentType, limit, offset);
  
  if (entries.length === 0) {
    console.log(`No ${contentType} cache entries found.`);
    return;
  }
  
  entries.forEach((entry, index) => {
    console.log(`${offset + index + 1}. TMDB: ${entry.tmdb_id || 'N/A'} | TVDB: ${entry.tvdb_id || 'N/A'} | IMDb: ${entry.imdb_id || 'N/A'} | TVmaze: ${entry.tvmaze_id || 'N/A'}`);
    console.log(`   Updated: ${entry.updated_at}\n`);
  });
}

async function addMapping(args) {
  const contentType = args[0];
  const tmdbId = args[1] || null;
  const tvdbId = args[2] || null;
  const imdbId = args[3] || null;
  const tvmazeId = args[4] || null;
  
  if (!contentType) {
    console.error('Usage: node manage-id-cache.js add <content_type> [tmdb_id] [tvdb_id] [imdb_id] [tvmaze_id]');
    return;
  }
  
  const success = await idCacheManager.addMapping(contentType, tmdbId, tvdbId, imdbId, tvmazeId);
  
  if (success) {
    console.log('✅ Mapping added successfully');
  } else {
    console.log('❌ Failed to add mapping');
  }
}

async function optimizeStorage() {
  console.log('🔧 Starting storage optimization...\n');
  
  const result = await idCacheManager.optimizeStorage();
  
  console.log(`✅ Storage optimization complete:`);
  console.log(`   Expired entries removed: ${result.expiredCount.toLocaleString()}`);
  console.log(`   Size-limited entries removed: ${result.sizeLimitCount.toLocaleString()}`);
  
  // Show updated stats
  const stats = await idCacheManager.getCacheHitRate();
  console.log(`\n📊 Updated Statistics:`);
  console.log(`   Total entries: ${stats.totalMappings.toLocaleString()}`);
  console.log(`   Estimated size: ${stats.estimatedSizeKB} KB`);
  console.log(`   Usage: ${stats.usagePercentage}%`);
}

async function showRecommendations() {
  console.log('💡 Storage Recommendations\n');
  
  const recommendations = await idCacheManager.getStorageRecommendations();
  
  if (recommendations.recommendations.length === 0) {
    console.log('✅ No recommendations. Cache is healthy!');
    return;
  }
  
  recommendations.recommendations.forEach((rec, index) => {
    console.log(`${index + 1}. ${rec}`);
  });
  
  console.log('\n📊 Current Status:');
  const stats = recommendations.currentStats;
  console.log(`   Total entries: ${stats.totalMappings.toLocaleString()}`);
  console.log(`   Estimated size: ${stats.estimatedSizeKB} KB`);
  console.log(`   Usage: ${stats.usagePercentage}%`);
  console.log(`   TTL: ${stats.ttlDays} days`);
}

async function showConfig() {
  console.log('⚙️  Cache Configuration\n');
  
  const stats = await idCacheManager.getCacheHitRate();
  
  console.log(`Max Cache Size: ${stats.maxSize.toLocaleString()} entries`);
  console.log(`TTL: ${stats.ttlDays} days`);
  console.log(`Compression: ${stats.compressionEnabled ? 'Enabled' : 'Disabled'}`);
  
  console.log('\nEnvironment Variables:');
  console.log(`ID_CACHE_MAX_SIZE: ${process.env.ID_CACHE_MAX_SIZE || '100000 (default)'}`);
  console.log(`ID_CACHE_TTL_DAYS: ${process.env.ID_CACHE_TTL_DAYS || '90 (default)'}`);
  console.log(`ID_CACHE_COMPRESSION: ${process.env.ID_CACHE_COMPRESSION || 'false (default)'}`);
}

function showHelp() {
  console.log(`
🔧 ID Cache Management Tool

Usage: node manage-id-cache.js <command> [args...]

Commands:
  stats                    Show detailed cache statistics
  clear all               Clear all cache entries
  clear old [days]        Clear cache entries older than days (default: TTL)
  clear expired           Clear expired entries (based on TTL)
  search <id> [type] [limit]  Search for an ID in cache
  list [type] [limit] [offset]  List cache entries with pagination
  add <type> [tmdb] [tvdb] [imdb] [tvmaze]  Manually add a mapping
  optimize                Optimize storage (clear expired, enforce limits, vacuum)
  recommendations         Show storage recommendations
  config                  Show current configuration

Examples:
  node manage-id-cache.js stats
  node manage-id-cache.js clear expired
  node manage-id-cache.js search tt1234567 movie 20
  node manage-id-cache.js list series 20 100
  node manage-id-cache.js add movie 123 456 tt1234567
  node manage-id-cache.js optimize
  node manage-id-cache.js recommendations

Environment Variables:
  ID_CACHE_MAX_SIZE       Maximum cache entries (default: 100000)
  ID_CACHE_TTL_DAYS       Time to live in days (default: 90)
  ID_CACHE_COMPRESSION    Enable compression (default: false)
`);
}

if (require.main === module) {
  main();
}
