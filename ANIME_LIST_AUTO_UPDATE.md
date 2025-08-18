# Anime List Auto-Update Feature

## Overview

The anime list (`anime-list-full.json`) from [Fribb/anime-lists](https://github.com/Fribb/anime-lists) is now automatically updated without requiring container restarts.

## How It Works

### **Automatic Updates**
- **Frequency**: Every 24 hours (configurable)
- **Method**: Uses ETags to check if remote file has changed
- **Efficiency**: Only downloads if the file has actually changed
- **Fallback**: Uses local cache if remote download fails

### **Update Process**
1. **Check ETag**: Compares saved ETag with remote ETag
2. **Download if needed**: Only downloads if ETags don't match
3. **Update cache**: Saves new file and ETag
4. **Reload data**: Processes and indexes the new data in memory

## Configuration

### **Environment Variables**

```bash
# Update interval in hours (default: 24)
ANIME_LIST_UPDATE_INTERVAL_HOURS=12

# Example: Update every 6 hours
ANIME_LIST_UPDATE_INTERVAL_HOURS=6
```

### **Docker Compose Example**

```yaml
services:
  aiometadata:
    environment:
      - ANIME_LIST_UPDATE_INTERVAL_HOURS=12  # Update every 12 hours
```

## Monitoring

### **API Endpoints**

Monitor the cache status via REST endpoints:

#### **Cache Statistics**
```bash
GET /api/id-mapper/cache
```

**Response:**
```json
{
  "success": true,
  "data": {
    "timestamp": "2024-01-15T10:30:00.000Z",
    "isInitialized": true,
    "animeIdMapSize": 12345,
    "tvdbIdMapSize": 8901,
    "imdbIdMapSize": 5678,
    "tmdbIndexArraySize": 4321,
    "redisEtag": "\"abc123def456\"",
    "lastUpdateInfo": {
      "fileSize": 2048576,
      "lastModified": "2024-01-15T10:00:00.000Z",
      "exists": true
    }
  }
}
```

#### **Cache Details with Pagination**
```bash
GET /api/id-mapper/cache/details?limit=10&offset=0
```

**Response:**
```json
{
  "success": true,
  "data": {
    "pagination": {
      "limit": 10,
      "offset": 0,
      "total": {
        "mal": 12345,
        "tvdb": 8901,
        "imdb": 5678,
        "tmdb": 4321
      }
    },
    "samples": {
      "malMappings": [
        {
          "mal_id": 1,
          "title": "Cowboy Bebop",
          "thetvdb_id": 12345,
          "themoviedb_id": 67890,
          "imdb_id": "tt0213338",
          "kitsu_id": 1,
          "type": "tv"
        }
      ],
      "tvdbMappings": [
        {
          "tvdb_id": 12345,
          "count": 3,
          "sample": [
            {
              "mal_id": 1,
              "title": "Cowboy Bebop",
              "type": "tv"
            }
          ]
        }
      ]
    }
  }
}
```

### **Log Messages**

The system logs update activities:

```
[ID Mapper] Scheduled periodic updates every 24 hours.
[ID Mapper] Running scheduled update (every 24 hours)...
[ID Mapper] Saved ETag: "abc123" | Remote ETag: "def456"
[ID Mapper] Downloading full list...
[ID Mapper] Successfully loaded and indexed 12345 anime mappings.
[ID Mapper] Scheduled update completed successfully.
```

### **Cache Files**

- **Local cache**: `addon/data/anime-list-full.json.cache`
- **Redis ETag**: `anime-list-etag` key

## Benefits

✅ **Always up-to-date** - No more stale anime mappings  
✅ **No manual intervention** - Updates happen automatically  
✅ **Efficient** - Only downloads when changes exist  
✅ **Resilient** - Falls back to local cache on failures  
✅ **Configurable** - Adjust update frequency as needed  

## Testing

### **Auto-Update Test**
Run the test script to verify the auto-update functionality:

```bash
node test-anime-list-auto-update.js
```

### **Cache Monitoring Test**
Test the new cache monitoring endpoints:

```bash
node test-id-mapper-cache.js
```

Or test manually:
```bash
# Get cache statistics
curl http://localhost:1337/api/id-mapper/cache

# Get cache details with pagination
curl "http://localhost:1337/api/id-mapper/cache/details?limit=5&offset=0"
```

## Troubleshooting

### **Update Not Happening**
- Check logs for error messages
- Verify Redis is running (for ETag storage)
- Check network connectivity to GitHub

### **Too Frequent Updates**
- Increase `ANIME_LIST_UPDATE_INTERVAL_HOURS`
- Check if ETag caching is working

### **Update Failures**
- System falls back to local cache
- Check logs for specific error messages
- Verify disk space for cache file

## Migration from Manual Updates

### **Before (Manual)**
- Restart container to get updates
- Risk of stale data
- Manual intervention required

### **After (Automatic)**
- Updates happen automatically
- Always current data
- Zero maintenance required
