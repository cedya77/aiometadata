#!/usr/bin/env node

/**
 * ID Cache Storage Calculator
 * Estimates storage requirements for ID cache entries
 */

class CacheStorageCalculator {
  constructor() {
    // Average ID lengths (in characters)
    this.idLengths = {
      tmdb: 6,      // TMDB IDs are typically 6-7 digits
      tvdb: 8,      // TVDB IDs are typically 8 digits
      imdb: 9,      // IMDb IDs are "tt" + 7 digits
      tvmaze: 6,    // TVmaze IDs are typically 6 digits
      content_type: 5, // "movie" or "series"
      timestamps: 19,  // "YYYY-MM-DD HH:MM:SS"
      row_overhead: 50  // SQLite/PostgreSQL row overhead
    };
    
    // Database overhead per table
    this.dbOverhead = {
      sqlite: {
        table_header: 1024,
        index_overhead: 0.3, // 30% for indexes
        page_size: 4096,
        fragmentation: 0.1   // 10% fragmentation
      },
      postgresql: {
        table_header: 2048,
        index_overhead: 0.4, // 40% for indexes
        page_size: 8192,
        fragmentation: 0.05  // 5% fragmentation
      }
    };
  }

  /**
   * Calculate storage for a single entry
   */
  calculateEntrySize(entry = null) {
    if (!entry) {
      // Use average case
      entry = {
        tmdb_id: '123456',
        tvdb_id: '12345678',
        imdb_id: 'tt1234567',
        tvmaze_id: '123456',
        content_type: 'movie',
        created_at: '2024-01-01 00:00:00',
        updated_at: '2024-01-01 00:00:00'
      };
    }

    const sizes = {
      tmdb_id: entry.tmdb_id ? entry.tmdb_id.length : 0,
      tvdb_id: entry.tvdb_id ? entry.tvdb_id.length : 0,
      imdb_id: entry.imdb_id ? entry.imdb_id.length : 0,
      tvmaze_id: entry.tvmaze_id ? entry.tvmaze_id.length : 0,
      content_type: entry.content_type ? entry.content_type.length : 0,
      created_at: this.idLengths.timestamps,
      updated_at: this.idLengths.timestamps
    };

    const totalSize = Object.values(sizes).reduce((sum, size) => sum + size, 0) + this.idLengths.row_overhead;
    
    return {
      sizes,
      totalSize,
      averageSize: totalSize
    };
  }

  /**
   * Calculate storage for multiple entries
   */
  calculateBulkStorage(entryCount, dbType = 'sqlite') {
    const singleEntry = this.calculateEntrySize();
    const rawDataSize = singleEntry.totalSize * entryCount;
    
    const overhead = this.dbOverhead[dbType];
    const indexSize = rawDataSize * overhead.index_overhead;
    const fragmentationSize = rawDataSize * overhead.fragmentation;
    const tableHeader = overhead.table_header;
    
    const totalSize = rawDataSize + indexSize + fragmentationSize + tableHeader;
    
    return {
      entryCount: entryCount.toLocaleString(),
      singleEntrySize: singleEntry.totalSize,
      rawDataSize: this.formatBytes(rawDataSize),
      indexSize: this.formatBytes(indexSize),
      fragmentationSize: this.formatBytes(fragmentationSize),
      tableHeader: this.formatBytes(tableHeader),
      totalSize: this.formatBytes(totalSize),
      totalSizeMB: Math.round(totalSize / (1024 * 1024)),
      totalSizeGB: (totalSize / (1024 * 1024 * 1024)).toFixed(2),
      dbType
    };
  }

  /**
   * Calculate storage for different scenarios
   */
  calculateScenarios() {
    const scenarios = [
      { name: 'Small Cache', entries: 10000 },
      { name: 'Medium Cache', entries: 100000 },
      { name: 'Large Cache', entries: 500000 },
      { name: 'Very Large Cache', entries: 1000000 },
      { name: 'Massive Cache', entries: 5000000 }
    ];

    console.log('📊 ID Cache Storage Requirements\n');

    scenarios.forEach(scenario => {
      console.log(`\n${scenario.name} (${scenario.entries.toLocaleString()} entries):`);
      
      const sqlite = this.calculateBulkStorage(scenario.entries, 'sqlite');
      const postgres = this.calculateBulkStorage(scenario.entries, 'postgresql');
      
      console.log(`  SQLite:    ${sqlite.totalSize} (${sqlite.totalSizeMB} MB)`);
      console.log(`  PostgreSQL: ${postgres.totalSize} (${postgres.totalSizeMB} MB)`);
    });
  }

  /**
   * Calculate detailed breakdown for specific entry count
   */
  calculateDetailed(entryCount, dbType = 'sqlite') {
    const result = this.calculateBulkStorage(entryCount, dbType);
    const singleEntry = this.calculateEntrySize();
    
    console.log(`\n📋 Detailed Storage Analysis for ${entryCount.toLocaleString()} entries (${dbType.toUpperCase()})\n`);
    
    console.log('Single Entry Breakdown:');
    console.log(`  TMDB ID:      ${singleEntry.sizes.tmdb_id} bytes`);
    console.log(`  TVDB ID:      ${singleEntry.sizes.tvdb_id} bytes`);
    console.log(`  IMDb ID:      ${singleEntry.sizes.imdb_id} bytes`);
    console.log(`  TVmaze ID:    ${singleEntry.sizes.tvmaze_id} bytes`);
    console.log(`  Content Type: ${singleEntry.sizes.content_type} bytes`);
    console.log(`  Timestamps:   ${singleEntry.sizes.created_at + singleEntry.sizes.updated_at} bytes`);
    console.log(`  Row Overhead: ${this.idLengths.row_overhead} bytes`);
    console.log(`  Total/Entry:  ${singleEntry.totalSize} bytes\n`);
    
    console.log('Bulk Storage Breakdown:');
    console.log(`  Raw Data:     ${result.rawDataSize}`);
    console.log(`  Indexes:      ${result.indexSize}`);
    console.log(`  Fragmentation: ${result.fragmentationSize}`);
    console.log(`  Table Header: ${result.tableHeader}`);
    console.log(`  Total:        ${result.totalSize} (${result.totalSizeMB} MB / ${result.totalSizeGB} GB)\n`);
    
    console.log('Performance Considerations:');
    console.log(`  Query Speed:  Fast (indexed lookups)`);
    console.log(`  Memory Usage: ~${Math.round(result.totalSizeMB * 0.1)} MB (10% of disk size)`);
    console.log(`  Backup Size:  ~${result.totalSizeMB} MB`);
    
    return result;
  }

  /**
   * Calculate memory usage for different scenarios
   */
  calculateMemoryUsage(entryCount) {
    const sqlite = this.calculateBulkStorage(entryCount, 'sqlite');
    const postgres = this.calculateBulkStorage(entryCount, 'postgresql');
    
    // Memory usage is typically 10-20% of disk size for active queries
    const sqliteMemory = Math.round(sqlite.totalSizeMB * 0.15);
    const postgresMemory = Math.round(postgres.totalSizeMB * 0.2);
    
    return {
      sqlite: {
        disk: sqlite.totalSizeMB,
        memory: sqliteMemory,
        recommended: Math.round(sqliteMemory * 1.5) // 50% buffer
      },
      postgresql: {
        disk: postgres.totalSizeMB,
        memory: postgresMemory,
        recommended: Math.round(postgresMemory * 1.5) // 50% buffer
      }
    };
  }

  /**
   * Format bytes to human readable
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Show recommendations
   */
  showRecommendations(entryCount) {
    const memory = this.calculateMemoryUsage(entryCount);
    
    console.log('\n💡 Recommendations:\n');
    
    if (entryCount <= 100000) {
      console.log('✅ Small cache - No special considerations needed');
      console.log(`   Recommended RAM: ${memory.sqlite.recommended} MB`);
    } else if (entryCount <= 500000) {
      console.log('⚠️  Medium cache - Consider optimization');
      console.log(`   Recommended RAM: ${memory.sqlite.recommended} MB`);
      console.log('   Set up weekly optimization cron job');
    } else if (entryCount <= 1000000) {
      console.log('⚠️  Large cache - Requires careful management');
      console.log(`   Recommended RAM: ${memory.sqlite.recommended} MB`);
      console.log('   Set up daily optimization');
      console.log('   Consider TTL of 30-60 days');
    } else {
      console.log('🚨 Very large cache - Requires special handling');
      console.log(`   Recommended RAM: ${memory.sqlite.recommended} MB`);
      console.log('   Set up hourly optimization');
      console.log('   Consider TTL of 7-30 days');
      console.log('   Monitor disk space closely');
    }
  }
}

// CLI interface
async function main() {
  const calculator = new CacheStorageCalculator();
  const command = process.argv[2];
  const args = process.argv.slice(3);

  try {
    switch (command) {
      case 'scenarios':
        calculator.calculateScenarios();
        break;
      case 'detailed':
        const entryCount = parseInt(args[0]) || 1000000;
        const dbType = args[1] || 'sqlite';
        calculator.calculateDetailed(entryCount, dbType);
        calculator.showRecommendations(entryCount);
        break;
      case 'memory':
        const count = parseInt(args[0]) || 1000000;
        const memory = calculator.calculateMemoryUsage(count);
        console.log(`\n🧠 Memory Usage for ${count.toLocaleString()} entries:\n`);
        console.log(`SQLite:     ${memory.sqlite.memory} MB (recommended: ${memory.sqlite.recommended} MB)`);
        console.log(`PostgreSQL: ${memory.postgresql.memory} MB (recommended: ${memory.postgresql.recommended} MB)`);
        break;
      default:
        showHelp();
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
🧮 ID Cache Storage Calculator

Usage: node cache-storage-calculator.js <command> [args...]

Commands:
  scenarios              Show storage requirements for different cache sizes
  detailed [count] [db]  Detailed analysis for specific entry count
  memory [count]         Show memory usage recommendations

Examples:
  node cache-storage-calculator.js scenarios
  node cache-storage-calculator.js detailed 1000000 sqlite
  node cache-storage-calculator.js memory 500000

Database types: sqlite, postgresql
`);
}

if (require.main === module) {
  main();
}

module.exports = CacheStorageCalculator;







