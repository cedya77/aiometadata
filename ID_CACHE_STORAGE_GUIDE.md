# ID Cache Storage & Memory Optimization Guide

## Overview

This guide provides comprehensive strategies for addressing storage and memory limitations in the ID cache system.

## Storage Optimization Strategies

### 1. **Automatic TTL (Time To Live)**

The cache automatically expires entries based on configurable TTL:

```bash
# Set TTL to 30 days
export ID_CACHE_TTL_DAYS=30

# Check current TTL
node addon/scripts/manage-id-cache.js config
```

**Benefits:**
- Automatically removes stale data
- Prevents unlimited growth
- Configurable based on your needs

### 2. **Size Limits**

Enforce maximum cache size to prevent memory issues:

```bash
# Set maximum cache size to 50,000 entries
export ID_CACHE_MAX_SIZE=50000

# Check current usage
node addon/scripts/manage-id-cache.js stats
```

**Benefits:**
- Prevents memory exhaustion
- Automatic cleanup of oldest entries
- Configurable limits

### 3. **Automatic Optimization**

Run periodic optimization to maintain cache health:

```bash
# Manual optimization
node addon/scripts/manage-id-cache.js optimize

# Set up cron job for automatic optimization
# Add to crontab: 0 2 * * 0 (weekly at 2 AM)
0 2 * * 0 cd /path/to/addon && node scripts/manage-id-cache.js optimize
```

**What optimization does:**
- Removes expired entries
- Enforces size limits
- Vacuums database (SQLite)
- Updates statistics

### 4. **Pagination for Large Datasets**

Use pagination when working with large caches:

```bash
# List first 100 entries
node addon/scripts/manage-id-cache.js list movie 100 0

# List next 100 entries
node addon/scripts/manage-id-cache.js list movie 100 100

# Search with pagination
node addon/scripts/manage-id-cache.js search tt1234567 movie 50 0
```

## Memory Management

### 1. **Database Optimization**

#### SQLite Optimization
```sql
-- Vacuum database to reclaim space
VACUUM;

-- Update statistics for better query planning
ANALYZE;

-- Enable WAL mode for better performance
PRAGMA journal_mode = WAL;
```

#### PostgreSQL Optimization
```sql
-- Update statistics
ANALYZE id_mappings;

-- Vacuum table
VACUUM id_mappings;
```

### 2. **Index Management**

The system automatically creates indexes for performance:

```sql
-- Check index usage
SELECT * FROM sqlite_master WHERE type = 'index' AND tbl_name = 'id_mappings';

-- Monitor index performance
EXPLAIN QUERY PLAN SELECT * FROM id_mappings WHERE tmdb_id = '123';
```

### 3. **Batch Operations**

Use batch operations for large datasets:

```javascript
// Example: Batch add mappings
const mappings = [
  { contentType: 'movie', tmdbId: '123', tvdbId: '456', imdbId: 'tt1234567' },
  // ... more mappings
];

await idCacheManager.batchAddMappings(mappings);
```

## Monitoring & Maintenance

### 1. **Regular Health Checks**

```bash
# Check cache health
node addon/scripts/manage-id-cache.js stats

# Get recommendations
node addon/scripts/manage-id-cache.js recommendations

# Monitor usage patterns
node addon/scripts/manage-id-cache.js list movie 10
```

### 2. **Storage Monitoring**

Monitor these metrics:
- **Total entries**: Should stay below max size
- **Estimated size**: Monitor disk usage
- **Usage percentage**: Keep below 80%
- **Expired entries**: Should be cleaned regularly

### 3. **Performance Monitoring**

```bash
# Check query performance
time node addon/scripts/manage-id-cache.js search tt1234567

# Monitor cache hit rates
# (Logs show: [ID Cache] Found cached mapping for...)
```

## Configuration Options

### Environment Variables

```bash
# Cache size limits
export ID_CACHE_MAX_SIZE=100000        # Maximum entries (default: 100k)
export ID_CACHE_TTL_DAYS=90            # TTL in days (default: 90)
export ID_CACHE_COMPRESSION=false      # Enable compression (default: false)

# Database optimization
export DATABASE_URI="sqlite://addon/data/db.sqlite"
```

### Recommended Configurations

#### **Low Memory Environment** (< 1GB RAM)
```bash
export ID_CACHE_MAX_SIZE=25000
export ID_CACHE_TTL_DAYS=30
```

#### **Medium Memory Environment** (1-4GB RAM)
```bash
export ID_CACHE_MAX_SIZE=50000
export ID_CACHE_TTL_DAYS=60
```

#### **High Memory Environment** (> 4GB RAM)
```bash
export ID_CACHE_MAX_SIZE=100000
export ID_CACHE_TTL_DAYS=90
```

#### **Enterprise/High Performance Environment** (> 8GB RAM)
```bash
export ID_CACHE_MAX_SIZE=5000000
export ID_CACHE_TTL_DAYS=90
```

## Troubleshooting Storage Issues

### 1. **Cache Too Large**

**Symptoms:**
- High memory usage
- Slow queries
- Disk space warnings

**Solutions:**
```bash
# Clear old entries
node addon/scripts/manage-id-cache.js clear expired

# Reduce max size
export ID_CACHE_MAX_SIZE=50000

# Optimize storage
node addon/scripts/manage-id-cache.js optimize
```

### 2. **Slow Performance**

**Symptoms:**
- Long query times
- High CPU usage
- Database locks

**Solutions:**
```bash
# Update statistics
node addon/scripts/manage-id-cache.js optimize

# Check for large datasets
node addon/scripts/manage-id-cache.js stats

# Consider reducing cache size
export ID_CACHE_MAX_SIZE=25000
```

### 3. **Disk Space Issues**

**Symptoms:**
- Database errors
- Write failures
- Disk full warnings

**Solutions:**
```bash
# Clear all cache (emergency)
node addon/scripts/manage-id-cache.js clear all

# Optimize database
node addon/scripts/manage-id-cache.js optimize

# Check disk usage
df -h
```

## Best Practices

### 1. **Regular Maintenance**

```bash
# Weekly optimization (add to crontab)
0 2 * * 0 cd /path/to/addon && node scripts/manage-id-cache.js optimize

# Monthly health check
0 3 1 * * cd /path/to/addon && node scripts/manage-id-cache.js recommendations
```

### 2. **Monitoring Setup**

```bash
# Create monitoring script
cat > monitor-cache.sh << 'EOF'
#!/bin/bash
cd /path/to/addon
node scripts/manage-id-cache.js stats > cache-stats.log
node scripts/manage-id-cache.js recommendations >> cache-stats.log
EOF

chmod +x monitor-cache.sh

# Run daily
0 6 * * * /path/to/monitor-cache.sh
```

### 3. **Backup Strategy**

```bash
# Backup cache data
sqlite3 addon/data/db.sqlite ".backup cache-backup-$(date +%Y%m%d).sqlite"

# Restore if needed
sqlite3 addon/data/db.sqlite ".restore cache-backup-20240101.sqlite"
```

## Advanced Optimization

### 1. **Custom Cleanup Scripts**

```javascript
// Custom cleanup based on usage patterns
const stats = await idCacheManager.getCacheHitRate();
if (stats.usagePercentage > 90) {
  // Emergency cleanup
  await idCacheManager.clearOldCache(7); // Keep only last week
}
```

### 2. **Compression (Future Feature)**

```bash
# Enable compression (when implemented)
export ID_CACHE_COMPRESSION=true
```

### 3. **Partitioning (Future Feature)**

For very large caches, consider partitioning by:
- Content type (movie/series)
- Date ranges
- ID ranges

## Emergency Procedures

### 1. **Immediate Memory Relief**

```bash
# Clear all cache
node addon/scripts/manage-id-cache.js clear all

# Restart service
systemctl restart your-service
```

### 2. **Database Recovery**

```bash
# Check database integrity
sqlite3 addon/data/db.sqlite "PRAGMA integrity_check;"

# Rebuild if corrupted
sqlite3 addon/data/db.sqlite "VACUUM;"
```

### 3. **Complete Reset**

```bash
# Stop service
systemctl stop your-service

# Clear cache
node addon/scripts/manage-id-cache.js clear all

# Optimize database
node addon/scripts/manage-id-cache.js optimize

# Restart service
systemctl start your-service
```

## Conclusion

By implementing these strategies, you can effectively manage storage and memory limitations while maintaining optimal cache performance. Regular monitoring and maintenance are key to preventing issues before they become critical.
