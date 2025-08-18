# ID Cache System

## Overview

The ID Cache system enhances the ID resolver by storing mappings between different service IDs (TMDB, TVDB, IMDb, TVmaze) in the database. This reduces API calls and improves performance for non-anime content.

## Features

- **Automatic Caching**: ID mappings are automatically cached when resolved
- **Smart Lookup**: Cache is checked before making API calls
- **Anime Exclusion**: Anime content is excluded (uses existing `anime-list-full.json`)
- **Database Persistence**: Mappings persist across restarts
- **Management Tools**: CLI tools for cache management

## How It Works

### Cache Flow

1. **Cache Check**: When resolving IDs, the system first checks the cache
2. **API Resolution**: If not found, makes API calls to resolve missing IDs
3. **Cache Storage**: New mappings are automatically saved to the database
4. **Future Requests**: Subsequent requests for the same content use cached data

### Database Schema

```sql
CREATE TABLE id_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_type TEXT NOT NULL,           -- 'movie' or 'series'
  tmdb_id TEXT,                         -- TMDB ID
  tvdb_id TEXT,                         -- TVDB ID
  imdb_id TEXT,                         -- IMDb ID
  tvmaze_id TEXT,                       -- TVmaze ID
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(content_type, tmdb_id, tvdb_id, imdb_id, tvmaze_id)
);
```

## Usage

### Automatic Usage

The cache is used automatically by the ID resolver. No configuration needed.

### Manual Management

Use the CLI tool to manage the cache:

```bash
# Show cache statistics
node addon/scripts/manage-id-cache.js stats

# Clear old cache entries (older than 30 days)
node addon/scripts/manage-id-cache.js clear old 30

# Clear all cache
node addon/scripts/manage-id-cache.js clear all

# Search for an ID
node addon/scripts/manage-id-cache.js search tt1234567 movie

# List recent movie cache entries
node addon/scripts/manage-id-cache.js list movie 10

# Manually add a mapping
node addon/scripts/manage-id-cache.js add movie 123 456 tt1234567
```

## Performance Benefits

- **Reduced API Calls**: Eliminates redundant API requests
- **Faster Response**: Cached lookups are nearly instant
- **Rate Limit Protection**: Reduces API rate limit consumption
- **Offline Capability**: Cached mappings work without internet

## Cache Statistics

The system tracks:
- Total mappings per content type
- Mappings with each service ID
- Complete mappings (all IDs available)
- Cache hit rates

## Maintenance

### Automatic Cleanup

Consider setting up a cron job to clear old cache entries:

```bash
# Clear entries older than 30 days (weekly)
0 2 * * 0 node /path/to/addon/scripts/manage-id-cache.js clear old 30
```

### Manual Cleanup

```bash
# Clear all cache (use sparingly)
node addon/scripts/manage-id-cache.js clear all

# Clear old entries
node addon/scripts/manage-id-cache.js clear old 7
```

## API Endpoints

The ID cache system provides REST API endpoints for monitoring and management:

### Cache Statistics
```bash
GET /api/id-cache/stats
```
Returns comprehensive cache statistics including:
- Total mappings by content type
- Usage percentage and size estimates
- TTL and compression settings
- Performance metrics

### Cache Mappings
```bash
GET /api/id-cache/mappings?limit=50&offset=0&contentType=movie
```
Returns paginated cache mappings with optional content type filtering.

### Search Cache
```bash
GET /api/id-cache/search?id=123&contentType=movie&limit=10
```
Search for mappings by any ID (TMDB, TVDB, IMDB, TVmaze).

### Storage Recommendations
```bash
GET /api/id-cache/recommendations
```
Get intelligent recommendations for cache optimization.

### Clear Cache
```bash
DELETE /api/id-cache/clear?type=old&days=30
DELETE /api/id-cache/clear?type=all
```
Clear old entries or entire cache (with safety checks).

## Monitoring

### Check Cache Health

#### Via API
```bash
# View statistics
curl http://localhost:1337/api/id-cache/stats

# Check specific content type
curl "http://localhost:1337/api/id-cache/mappings?contentType=movie&limit=5"

# Search for specific ID
curl "http://localhost:1337/api/id-cache/search?id=123&limit=5"
```

#### Via CLI
```bash
# View statistics
node addon/scripts/manage-id-cache.js stats

# Check specific content type
node addon/scripts/manage-id-cache.js list movie 5
```

### Logs

The system logs cache operations:
- `[ID Cache] Found cached mapping for...`
- `[ID Cache] Saved mapping for...`
- `[ID Cache] Failed to save mapping:...`

## Troubleshooting

### Cache Not Working

1. Check database connection
2. Verify table exists: `SELECT * FROM id_mappings LIMIT 1;`
3. Check logs for errors

### Performance Issues

1. Monitor cache size: `node addon/scripts/manage-id-cache.js stats`
2. Clear old entries: `node addon/scripts/manage-id-cache.js clear old 7`
3. Check for duplicate entries

### Database Issues

1. Verify database permissions
2. Check disk space
3. Ensure indexes are created

## Configuration

No additional configuration is required. The cache uses the same database as user configurations.

## Limitations

- **Anime Content**: Not cached (uses existing anime mappings)
- **Storage**: Cache grows over time (manage with cleanup)
- **Freshness**: Cached data may become stale (consider TTL)
- **Memory**: Large caches may impact performance

## Future Enhancements

- **TTL Support**: Automatic expiration of old entries
- **Cache Warming**: Pre-populate cache with popular content
- **Compression**: Compress cache data to save space
- **Analytics**: Track cache hit rates and performance metrics

