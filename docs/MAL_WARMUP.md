# MAL Catalog Background Warming

## Overview

The MAL (MyAnimeList) Catalog Warmer is a background service that automatically pre-fetches and caches popular anime catalog data from the Jikan API. This ensures users experience instant responses when browsing MAL catalogs, as the data is already cached before they request it.

## Why Background Warming?

### The Problem
- Jikan API has strict rate limits (3 requests/second)
- First request to a catalog can take 400ms+ due to rate limiting
- Users experience delays when browsing catalogs
- Popular catalogs are accessed frequently by many users

### The Solution
Background warming proactively fetches and caches catalog data during low-traffic periods, so subsequent requests are served instantly from cache. The warmer respects Jikan's rate limits and uses ETag caching to minimize unnecessary API calls.

## Features

- ✅ **Rate Limit Friendly**: Respects Jikan's 3 req/sec limit
- ✅ **ETag-Aware**: Skips refetching unchanged data (304 responses)
- ✅ **Prioritized**: Warms most-accessed catalogs first
- ✅ **Configurable**: Full control via environment variables
- ✅ **Quiet Hours**: Optional scheduling for low-traffic periods
- ✅ **Observable**: Stats endpoint for monitoring
- ✅ **Graceful**: Won't interfere with user requests

## Configuration

All configuration is done via environment variables in your `.env` file.

### Basic Configuration

```bash
# Enable/disable warmup (default: true)
MAL_WARMUP_ENABLED=true

# User UUID to use for cache warming (default: system-cache-warmer)
# Set this to your own UUID to warm caches with your preferred providers/language
CACHE_WARMUP_UUID=system-cache-warmer

# Run warmup every N hours (default: 6)
MAL_WARMUP_INTERVAL_HOURS=6

# Delay before first warmup after server start in seconds (default: 30)
MAL_WARMUP_INITIAL_DELAY_SECONDS=30
```

### Advanced Configuration

```bash
# Extra delay between warmup tasks in ms (default: 100)
MAL_WARMUP_TASK_DELAY_MS=100

# Number of pages to warm for priority catalogs (default: 2)
MAL_WARMUP_PRIORITY_PAGES=2

# Use Safe For Work mode (default: true)
MAL_WARMUP_SFW=true
```

### Quiet Hours Mode

Run warmup only during specific UTC hours (useful for VPS with limited bandwidth):

```bash
# Enable quiet hours (default: false)
MAL_WARMUP_QUIET_HOURS_ENABLED=true

# Time range in UTC, format: "start-end" (default: 2-8)
MAL_WARMUP_QUIET_HOURS_RANGE=2-8

# Examples:
# "2-8"   = 2:00 AM to 8:00 AM UTC
# "22-6"  = 10:00 PM to 6:00 AM UTC (wrap-around)
# "0-24"  = All day
```

### Selective Phase Control

Enable/disable specific warmup phases:

```bash
# MAL_WARMUP_METADATA is deprecated (handled by essential content warmer)

# Warm high-priority catalogs (airing, upcoming, top) - default: true
MAL_WARMUP_PRIORITY=true

# Warm schedule catalogs (current/next day) - default: true
MAL_WARMUP_SCHEDULE=true

# Warm decade catalogs (cached for 30 days) - default: false
MAL_WARMUP_DECADES=false
```

### Logging Control

```bash
# Log verbosity (default: normal)
# Options: silent, normal, verbose
MAL_WARMUP_LOG_LEVEL=normal
```

### Using Your Own UUID for Warming

By default, the warmer uses a system configuration (`system-cache-warmer`) with predefined settings. However, you can specify your own user UUID to warm caches with your preferred providers and language settings:

```bash
# Use your own UUID (find it in your addon URL or dashboard)
CACHE_WARMUP_UUID=550e8400-e29b-41d4-a716-446655440000
```

**Benefits:**
- Warm caches with **your preferred metadata providers** (TMDB, AniList, etc.)
- Use **your preferred language** for titles and descriptions
- Match **your art provider preferences** (MAL posters, IMDb backgrounds, etc.)
- Ensure warmed content matches what you'll actually see

**How to find your UUID:**
1. Check your addon URL: `http://localhost:1337/{uuid}/manifest.json`
2. Or check the dashboard at `http://localhost:1337/api/dashboard`

**Note:** The UUID must exist in the database (i.e., you must have configured it at least once via the addon interface).

## What Gets Warmed?

### Phase 1: Metadata (~2 requests)
- Studio list (top 100)
- Available seasons

### Phase 2: High-Priority Catalogs (~12 requests)
- Currently Airing (2 pages)
- Top Movies (2 pages)
- Top Series (2 pages)
- Most Popular (2 pages)
- Most Favorites (2 pages)
- Best of 2020s (2 pages)

### Phase 3: Schedule Catalogs (~2 requests)
- Current day's airing schedule
- Next day's airing schedule

### Phase 4: Decade Catalogs (Optional, ~3 requests)
- Best of 2010s (1 page)
- Best of 2000s (1 page)
- Best of 1990s (1 page)
- Best of 1980s (1 page)
- **Note**: Decade catalogs are cached for 30 days since historical data rarely changes
- **Note**: 2020s decade is warmed in Phase 2 as a priority catalog (current content)

## Performance Impact

### Time Per Warmup Cycle
With default settings:
- **Metadata**: 3-5 seconds (2 requests)
- **Priority**: 15-25 seconds (12 requests)
- **Schedule**: 5 seconds (2 requests)
- **Total**: ~23-35 seconds per cycle

### API Usage
- **Default**: ~16 requests every 6 hours = ~64 requests/day (includes current 2020s decade)
- **With Older Decades**: ~20 requests every 6 hours (first run), then ~16 requests/day (older decades cached for 30 days)
- **ETag Hits**: Up to 70% of requests return 304 (not modified), saving bandwidth

### Cache Hit Rate Improvement
- **Before**: ~40-60% cache hit rate on MAL catalogs
- **After**: ~90-95% cache hit rate on MAL catalogs

## Timing & Container Restarts

**Important**: Like the TMDB cache warmer, MAL warmup uses Redis to track the last warmup time. **It will NOT re-warm on every container restart** - only when the interval has elapsed.

### How It Works

1. **On Server Start**: After 30 seconds, checks Redis for last warmup timestamp
2. **If Recently Warmed**: Skips warmup and logs "recently warmed"
3. **If Interval Elapsed**: Runs warmup (~16 requests, ~28s)
4. **Recurring Checks**: Every `MAL_WARMUP_INTERVAL_HOURS`, checks if warmup is needed

### Example Scenarios

**Scenario 1: Normal Operation**
- Server starts → Check after 30s → Warmed 2h ago → Skip
- 4 hours later → Check → Warmed 6h ago → Run warmup
- Container restart → Check after 30s → Warmed 1h ago → Skip

**Scenario 2: Fresh Install**
- Server starts → Check after 30s → Never warmed → Run warmup
- Container restart → Check after 30s → Warmed 2h ago → Skip

**Scenario 3: Redis Cleared**
- Server starts → Check after 30s → No timestamp in Redis → Run warmup

## Monitoring

### Check Warmup Status

Access the stats endpoint (requires admin key if configured):

```bash
curl http://your-domain.com/api/dashboard/mal-warmup
```

Response example:
```json
{
  "lastRun": "2025-10-17T14:30:00.000Z",
  "itemsWarmed": 16,
  "errors": 0,
  "duration": 28,
  "phase": "complete",
  "nextRun": "2025-10-17T20:30:00.000Z",
  "isWarming": false,
  "config": {
    "enabled": true,
    "intervalHours": 6,
    "quietHoursEnabled": false,
    "quietHoursRange": "2-8",
    "priorityPages": 2,
    "phases": {
      "metadata": true,
      "priority": true,
      "schedule": true,
      "decades": false
    }
  }
}
```

### Log Output

**On Server Start:**
```
[MAL Warmer] MAL Catalog Warmer initialized with config: { enabled: true, intervalHours: 6, ... }
[MAL Warmer] Starting background catalog warming...
[MAL Warmer] Warmup scheduled to check every 6 hours
```

**After 30s - If Recently Warmed (Most Common on Restart):**
```
[MAL Warmer] MAL catalogs warmed 145min ago, skipping (next in 215min)
```

**After 30s - If Warmup Needed:**
```
[MAL Warmer] 6h since last MAL warming (threshold: 6h), warming now
[MAL Warmer] 🔥 Starting catalog warmup cycle...
[MAL Warmer] 📚 Phase 1: Warming metadata...
[MAL Warmer] ⭐ Phase 2: Warming high-priority catalogs...
[MAL Warmer] 📅 Phase 3: Warming schedule catalogs...
[MAL Warmer] ✅ Warmup complete: 16 items, 0 errors, 28s. Next run: 2025-10-17T20:30:00.000Z
```

## Recommended Configurations

### For Shared Hosting / Limited Bandwidth
```bash
MAL_WARMUP_ENABLED=true
MAL_WARMUP_INTERVAL_HOURS=12          # Less frequent
MAL_WARMUP_QUIET_HOURS_ENABLED=true
MAL_WARMUP_QUIET_HOURS_RANGE=2-8      # Low-traffic hours
MAL_WARMUP_PRIORITY_PAGES=1           # Fewer pages
MAL_WARMUP_DECADES=false
MAL_WARMUP_LOG_LEVEL=silent
```

### For VPS / Dedicated Server
```bash
MAL_WARMUP_ENABLED=true
MAL_WARMUP_INTERVAL_HOURS=6           # More frequent
MAL_WARMUP_PRIORITY_PAGES=3           # More pages
MAL_WARMUP_DECADES=true               # Include decades (30-day cache)
MAL_WARMUP_LOG_LEVEL=normal
```

### For Development
```bash
MAL_WARMUP_ENABLED=true
MAL_WARMUP_INTERVAL_HOURS=1           # Very frequent for testing
MAL_WARMUP_INITIAL_DELAY_SECONDS=10   # Quick start
MAL_WARMUP_LOG_LEVEL=verbose          # Detailed logs
```

### To Disable
```bash
MAL_WARMUP_ENABLED=false
```

## Troubleshooting

### Warmup Not Running

1. Check if enabled: `MAL_WARMUP_ENABLED=true`
2. Check logs for "recently warmed" message (this is normal!)
3. Verify quiet hours aren't blocking execution
4. Check stats endpoint for last warmup time
5. To force warmup: Clear Redis key `cache-warming:last-mal-warm`

### High API Usage / Rate Limits

1. Reduce `MAL_WARMUP_PRIORITY_PAGES` (default: 2 → try 1)
2. Disable `MAL_WARMUP_DECADES`
3. Increase `MAL_WARMUP_INTERVAL_HOURS` (e.g., 12 or 24)
4. Increase `MAL_WARMUP_TASK_DELAY_MS` (e.g., 500)

### Server Load During Warmup

1. Enable quiet hours mode
2. Increase `MAL_WARMUP_TASK_DELAY_MS`
3. Reduce concurrent phases (disable some via phase flags)

### Missing Logs

Set `MAL_WARMUP_LOG_LEVEL=verbose` for detailed debugging.

## Integration with Existing Cache System

The warmer integrates seamlessly with your existing cache infrastructure:

- **Uses existing Redis cache**: No separate cache storage
- **Respects cache TTLs**: Works with your configured TTLs
- **ETag-aware**: Uses Jikan's built-in ETag system
- **Queue-based**: Uses the same request queue as user requests
- **Non-blocking**: Runs in background, doesn't interfere with user traffic

## Performance Best Practices

1. **Start Conservative**: Use default settings first
2. **Monitor API Usage**: Check Jikan rate limit headers
3. **Enable Quiet Hours**: If bandwidth is limited
4. **Adjust Based on Traffic**: More users = more warmup value
5. **Cache TTL**: Ensure MAL cache TTL is at least 4-6 hours
6. **Scale Gradually**: Increase pages/genres if needed

## Technical Details

### Architecture
- Singleton pattern: Only one warmer instance per server
- Phase-based execution: Metadata → Priority → Genres → Schedule
- Promise-based: Async/await throughout
- Error resilient: Continues on individual failures

### Rate Limiting
- Respects global Jikan queue (400ms base delay)
- Additional configurable delay between tasks
- Adaptive backoff on rate limit hits

### Caching Strategy
- Uses `cacheWrapJikanApi` wrapper
- ETag support: 304 responses are instant
- Cache key versioning: Isolated from user requests
- TTL: 24 hours (matches Jikan's cache duration)

## API Reference

### Stats Object
```typescript
{
  lastRun: Date | null,        // When warmup last completed
  itemsWarmed: number,          // Number of items warmed in last run
  errors: number,               // Number of errors in last run
  duration: number,             // Duration in seconds
  phase: string | null,         // Current/last phase
  nextRun: Date | null,         // Scheduled next run time
  isWarming: boolean,           // Currently running?
  config: {                     // Current configuration
    enabled: boolean,
    intervalHours: number,
    quietHoursEnabled: boolean,
    quietHoursRange: string,
    priorityPages: number,
    topGenresCount: number,
    phases: {
      metadata: boolean,
      priority: boolean,
      genres: boolean,
      schedule: boolean,
      decades: boolean
    }
  }
}
```

## Credits

Built for [AIO Metadata](https://github.com/cedya77/aiometadata) by the community.

