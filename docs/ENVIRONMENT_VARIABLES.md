# Environment Variables Configuration

This document describes all available environment variables for AIO Metadata.

## Quick Start

Create a `.env` file in the project root with your configuration:

```bash
cp .env.example .env
# Edit .env with your settings
```

---

## Server Configuration

### `PORT`
- **Default**: `1337`
- **Description**: Port number the server listens on
- **Example**: `PORT=3000`

### `HOST_NAME`
- **Required**: Yes (for production)
- **Description**: Your domain name for generating URLs
- **Example**: `HOST_NAME=your-domain.com`

### `NODE_ENV`
- **Default**: `development`
- **Options**: `development`, `production`
- **Description**: Node environment mode
- **Example**: `NODE_ENV=production`

### `LOG_LEVEL`
- **Default**: `info` (production), `debug` (development)
- **Options**: `silent`, `info`, `debug`
- **Description**: Logging verbosity level
- **Example**: `LOG_LEVEL=info`

---

## Database Configuration

### `DATABASE_URL`
- **Required**: Yes
- **Description**: Database connection string (PostgreSQL or SQLite)
- **Examples**:
  - PostgreSQL: `DATABASE_URL=postgresql://user:password@localhost:5432/aiometadata`
  - SQLite: `DATABASE_URL=sqlite:./data/aiometadata.db`

---

## Redis Cache Configuration

### `REDIS_URL`
- **Required**: Yes
- **Description**: Redis connection URL for caching (required for the app to function)
- **Example**: `REDIS_URL=redis://localhost:6379`

---

## Admin Configuration

### `ADMIN_KEY`
- **Recommended**: Yes
- **Description**: Secret key for admin API endpoints
- **Example**: `ADMIN_KEY=your-secure-random-key-here`
- **Note**: Generate with: `openssl rand -hex 32`

---

## API Keys

### `TMDB_API_KEY`
- **Required**: Yes
- **Description**: The Movie Database (TMDB) API key
- **Get it**: https://www.themoviedb.org/settings/api

### `TVDB_API_KEY`
- **Required**: No
- **Description**: TheTVDB API key (v4)
- **Get it**: https://thetvdb.com/dashboard/account/apikeys

### `FANART_API_KEY`
- **Optional**: Yes
- **Description**: Fanart.tv API key for high-quality artwork
- **Get it**: https://fanart.tv/get-an-api-key/

### `RPDB_API_KEY`
- **Optional**: Yes
- **Description**: RPDB (Rating Poster Database) API key
- **Get it**: https://ratingposterdb.com/

### `MDBLIST_API_KEY`
- **Optional**: Yes
- **Description**: MDBList API key for custom lists
- **Get it**: https://mdblist.com/

### `GEMINI_API_KEY`
- **Optional**: Yes
- **Description**: Google Gemini API key for AI search features
- **Get it**: https://makersuite.google.com/app/apikey

---

## Jikan API Configuration (MyAnimeList)

### `JIKAN_API_BASE`
- **Default**: `https://api.jikan.moe/v4`
- **Description**: Base URL for Jikan API
- **Example**: `JIKAN_API_BASE=https://api.jikan.moe/v4`

### `MAL_SOCKS_PROXY_URL`
- **Optional**: Yes
- **Description**: SOCKS proxy for Jikan API requests (if your IP is rate-limited)
- **Format**: `socks5://user:pass@host:port` or `socks4://host:port`
- **Example**: `MAL_SOCKS_PROXY_URL=socks5://user:pass@proxy.example.com:1080`

---

## Cache Warming Configuration

### `CACHE_WARMUP_UUIDS`
- **Default**: None
- **Description**: Comma-separated list of user UUIDs to use for cache warming operations (up to 3 UUIDs). Each UUID will be warmed sequentially using that user's config for providers, language, etc.
- **Example**: `CACHE_WARMUP_UUIDS=550e8400-e29b-41d4-a716-446655440000,660f9511-f30c-52e5-b827-557766551111`
- **Note**: If not set, falls back to `CACHE_WARMUP_UUID` for backward compatibility. Set this to warm caches for multiple user configurations.

### `CACHE_WARMUP_UUID` (Legacy)
- **Default**: `system-cache-warmer`
- **Description**: **Legacy**: Single user UUID for cache warming operations. Use `CACHE_WARMUP_UUIDS` for multiple UUIDs.
- **Example**: `CACHE_WARMUP_UUID=550e8400-e29b-41d4-a716-446655440000`
- **Note**: Still supported for backward compatibility. If `CACHE_WARMUP_UUIDS` is set, this is ignored.

### `CACHE_WARMUP_MODE`
- **Default**: `essential`
- **Options**: `essential`, `comprehensive`
- **Description**: Choose which warming strategy to use
  - `essential`: Warm only essential content (genres, studios, trending items, TMDB popular content) - lightweight
  - `comprehensive`: Warm ALL enabled catalogs in your config - thorough but resource-intensive
- **Example**: `CACHE_WARMUP_MODE=comprehensive`
- **Note**: Comprehensive mode requires `CACHE_WARMUP_UUID` to be explicitly set

---

## MAL Catalog Background Warming

Complete documentation: [MAL_WARMUP.md](./MAL_WARMUP.md)

### `MAL_WARMUP_ENABLED`
- **Default**: `true`
- **Description**: Enable/disable automatic background warming of MAL catalogs
- **Example**: `MAL_WARMUP_ENABLED=true`

### `MAL_WARMUP_INTERVAL_HOURS`
- **Default**: `6`
- **Description**: How often to run warmup (in hours)
- **Example**: `MAL_WARMUP_INTERVAL_HOURS=12`
- **Recommended**: 6-12 hours

### `MAL_WARMUP_INITIAL_DELAY_SECONDS`
- **Default**: `30`
- **Description**: Delay before first warmup after server start (in seconds)
- **Example**: `MAL_WARMUP_INITIAL_DELAY_SECONDS=60`

### `MAL_WARMUP_TASK_DELAY_MS`
- **Default**: `100`
- **Description**: Extra delay between individual warmup tasks (in milliseconds)
- **Example**: `MAL_WARMUP_TASK_DELAY_MS=200`

### `MAL_WARMUP_QUIET_HOURS_ENABLED`
- **Default**: `false`
- **Description**: Only run warmup during specific UTC hours
- **Example**: `MAL_WARMUP_QUIET_HOURS_ENABLED=true`

### `MAL_WARMUP_QUIET_HOURS_RANGE`
- **Default**: `2-8`
- **Description**: UTC time range for quiet hours (format: "start-end")
- **Examples**:
  - `2-8` = 2:00 AM to 8:00 AM UTC
  - `22-6` = 10:00 PM to 6:00 AM UTC (wrap-around)

### `MAL_WARMUP_PRIORITY_PAGES`
- **Default**: `2`
- **Description**: Number of pages to warm for high-priority catalogs
- **Example**: `MAL_WARMUP_PRIORITY_PAGES=3`
- **Range**: 1-5

### Phase Control Variables

#### `MAL_WARMUP_METADATA`
- **Default**: `false` (deprecated)
- **Description**: ⚠️ **Deprecated** - Metadata (studios, seasons) is already warmed by essential content warmer

#### `MAL_WARMUP_PRIORITY`
- **Default**: `true`
- **Description**: Warm high-priority catalogs (airing, upcoming, top)

#### `MAL_WARMUP_SCHEDULE`
- **Default**: `true`
- **Description**: Warm schedule catalogs (current/next day)

#### `MAL_WARMUP_DECADES`
- **Default**: `false`
- **Description**: Warm older decade catalogs (80s, 90s, 00s, 10s - cached for 30 days)
- **Note**: 2020s decade is always warmed as part of priority catalogs

### `MAL_WARMUP_SFW`
- **Default**: `true`
- **Description**: Use Safe For Work mode for warmup requests (filters explicit content)
- **Example**: `MAL_WARMUP_SFW=false` (to disable)

### `MAL_WARMUP_LOG_LEVEL`
- **Default**: `normal`
- **Options**: `silent`, `normal`, `verbose`
- **Description**: Log verbosity for warmup process
- **Example**: `MAL_WARMUP_LOG_LEVEL=verbose`

---

## Comprehensive Catalog Warming

This feature warms **ALL** enabled catalogs (TMDB, MAL, MDBList, Custom Manifests, etc.) for each configured user, across all pages until empty.

**⚠️ Important**: Set `CACHE_WARMUP_MODE=comprehensive` to enable this feature. Also requires `CACHE_WARMUP_UUIDS` (or legacy `CACHE_WARMUP_UUID`) to be explicitly set.

### `CATALOG_WARMUP_INTERVAL_HOURS`
- **Default**: `24` (daily)
- **Description**: How often to run comprehensive catalog warmup (in hours)
- **Example**: `CATALOG_WARMUP_INTERVAL_HOURS=48`
- **Recommended**: 24-72 hours depending on number of catalogs and server resources

### `CATALOG_WARMUP_INITIAL_DELAY_SECONDS`
- **Default**: `300` (5 minutes)
- **Description**: Delay before first warmup after server start (in seconds)
- **Example**: `CATALOG_WARMUP_INITIAL_DELAY_SECONDS=600`

### `CATALOG_WARMUP_MAX_PAGES_PER_CATALOG`
- **Default**: `100`
- **Description**: Maximum number of pages to warm per catalog (safety limit)
- **Example**: `CATALOG_WARMUP_MAX_PAGES_PER_CATALOG=50`
- **Note**: Actual pages warmed depends on catalog size; stops when no more results

### `CATALOG_WARMUP_RESUME_ON_RESTART`
- **Default**: `true`
- **Description**: Resume from last checkpoint on container restart
- **Example**: `CATALOG_WARMUP_RESUME_ON_RESTART=false`

### `CATALOG_WARMUP_QUIET_HOURS_ENABLED`
- **Default**: `false`
- **Description**: Only run warmup outside specific UTC hours
- **Example**: `CATALOG_WARMUP_QUIET_HOURS_ENABLED=true`

### `CATALOG_WARMUP_QUIET_HOURS`
- **Default**: `02:00-06:00`
- **Description**: UTC time range to avoid warming (format: "HH:MM-HH:MM")
- **Example**: `CATALOG_WARMUP_QUIET_HOURS=22:00-06:00`

### `CATALOG_WARMUP_TASK_DELAY_MS`
- **Default**: `100`
- **Description**: Delay between catalog page requests (in milliseconds)
- **Example**: `CATALOG_WARMUP_TASK_DELAY_MS=200`

### `CATALOG_WARMUP_LOG_LEVEL`
- **Default**: `info`
- **Options**: `debug`, `info`, `success`, `warn`, `error`
- **Description**: Log verbosity for catalog warmup process
- **Example**: `CATALOG_WARMUP_LOG_LEVEL=debug`

### `CATALOG_WARMUP_AUTO_ON_VERSION_CHANGE`
- **Default**: `false`
- **Description**: Automatically trigger catalog warmup when app version changes. When enabled, the warmer compares the current app version with the last stored version in Redis. If they differ, it immediately runs a warmup to refresh all caches with the new version's cache keys.
- **Example**: `CATALOG_WARMUP_AUTO_ON_VERSION_CHANGE=true`
- **Note**: Requires `CACHE_WARMUP_MODE=comprehensive` to be enabled. Cache keys are tied to app version, so this ensures fresh data after updates.

---

## Cache Cleanup Scheduler

### `CACHE_CLEANUP_AUTO_ENABLED`
- **Default**: `true`
- **Description**: Enable/disable automatic cache cleanup scheduling
- **Example**: `CACHE_CLEANUP_AUTO_ENABLED=false`
- **Note**: When disabled, cache cleanup can still be triggered manually via the dashboard

### `CACHE_CLEANUP_QUIET_HOURS_ENABLED`
- **Default**: `false`
- **Description**: Enable quiet hours for cache cleanup (avoids running during specific hours)
- **Example**: `CACHE_CLEANUP_QUIET_HOURS_ENABLED=true`

### `CACHE_CLEANUP_QUIET_HOURS`
- **Default**: `02:00-06:00`
- **Description**: Time range to avoid cache cleanup (format: "HH:MM-HH:MM")
- **Example**: `CACHE_CLEANUP_QUIET_HOURS=22:00-06:00`
- **Note**: Uses 24-hour format. Cache cleanup runs every 6 hours but skips during quiet hours

---

## Cache Warming Configuration (TMDB/TVDB)

### `ENABLE_CACHE_WARMING`
- **Default**: `true`
- **Description**: Enable general cache warming for TMDB/TVDB content
- **Example**: `ENABLE_CACHE_WARMING=true`

### `TMDB_POPULAR_WARMING_ENABLED`
- **Default**: `true`
- **Description**: Enable/disable TMDB popular content warming (trending movies/series)
- **Example**: `TMDB_POPULAR_WARMING_ENABLED=false`

### `CACHE_WARM_INTERVAL_HOURS`
- **Default**: `24`
- **Description**: Hours between TMDB popular content warming cycles
- **Example**: `CACHE_WARM_INTERVAL_HOURS=12`

### `CACHE_WARM_LANGUAGE`
- **Default**: `en-US`
- **Description**: Language code to use when warming popular content cache. Determines which language metadata will be cached during background warming operations.
- **Example**: `CACHE_WARM_LANGUAGE=fr-FR`
- **Common Values**:
  - `en-US` - English (United States)
  - `fr-FR` - French (France)
  - `de-DE` - German (Germany)
  - `es-ES` - Spanish (Spain)
  - `ja-JP` - Japanese (Japan)
  - `pt-BR` - Portuguese (Brazil)

### `CACHE_WARMUP_ON_STARTUP`
- **Default**: `true`
- **Description**: Run cache warming during server startup
- **Example**: `CACHE_WARMUP_ON_STARTUP=false`

---

## Catalog Configuration

### `CATALOG_LIST_ITEMS_SIZE`
- **Default**: `20`
- **Description**: Number of items per catalog page
- **Example**: `CATALOG_LIST_ITEMS_SIZE=30`

---

## Content Settings

### `INCLUDE_ADULT`
- **Default**: `false`
- **Description**: Include adult content in results globally
- **Example**: `INCLUDE_ADULT=true`
- **Note**: Users can override this in their personal settings

### `SFW_MODE`
- **Default**: `false`
- **Description**: Enable Safe For Work mode globally (filters explicit content)
- **Example**: `SFW_MODE=true`

---

## Proxy Configuration

### `SOCKS_PROXY_URL`
- **Optional**: Yes
- **Description**: SOCKS proxy for general requests
- **Format**: `socks5://user:pass@host:port`
- **Example**: `SOCKS_PROXY_URL=socks5://proxy.example.com:1080`

### `HTTP_PROXY` / `HTTPS_PROXY`
- **Optional**: Yes
- **Description**: HTTP/HTTPS proxy for general requests. `HTTPS_PROXY` is preferred since most API calls use HTTPS, with `HTTP_PROXY` as fallback. Applies to all non-Gemini requests unless a service-specific proxy is configured.
- **Example**: `HTTPS_PROXY=http://proxy.example.com:8080`

### `GEMINI_HTTP_PROXY` / `GEMINI_HTTPS_PROXY`
- **Optional**: Yes
- **Description**: HTTP/HTTPS proxy specifically for Gemini API requests. `GEMINI_HTTPS_PROXY` is preferred since Gemini API uses HTTPS, with `GEMINI_HTTP_PROXY` as fallback. If neither is set, Gemini will use the global `HTTPS_PROXY`/`HTTP_PROXY` if configured, otherwise direct connection.
- **Example**: `GEMINI_HTTPS_PROXY=http://proxy.example.com:8080`
- **Note**: Useful when you need Gemini requests to use a different proxy than other API calls (e.g., for region restrictions)

---

## Feature Flags

### `ENABLE_AI_SEARCH`
- **Default**: `false`
- **Description**: Enable AI-powered search features (requires GEMINI_API_KEY)
- **Example**: `ENABLE_AI_SEARCH=true`

### `ENABLE_STREAMING_CATALOGS`
- **Default**: `true`
- **Description**: Enable streaming service catalogs
- **Example**: `ENABLE_STREAMING_CATALOGS=false`

---

## Rate Limiting & Performance

### `MAX_CONCURRENT_REQUESTS`
- **Default**: `10`
- **Description**: Maximum concurrent requests per provider
- **Example**: `MAX_CONCURRENT_REQUESTS=5`
- **Note**: Adjust based on your server capacity and API limits

### `REQUEST_TIMEOUT`
- **Default**: `8000`
- **Description**: Request timeout in milliseconds
- **Example**: `REQUEST_TIMEOUT=10000`

---

## Example Configurations

### Minimal Setup (.env)
```bash
# Required
DATABASE_URL=postgresql://user:pass@localhost:5432/aiometadata
REDIS_URL=redis://localhost:6379
HOST_NAME=my-addon.com
TMDB_API=your_key_here

# Optional (but recommended)
TVDB_API_KEY=your_key_here

# Recommended
ADMIN_KEY=your_secure_random_key
```

### Production Setup (.env)
```bash
# Server
PORT=1337
HOST_NAME=my-addon.com
NODE_ENV=production
LOG_LEVEL=info

# Database & Cache
DATABASE_URL=postgresql://user:pass@localhost:5432/aiometadata
REDIS_URL=redis://localhost:6379

# Security
ADMIN_KEY=your_secure_random_key

# API Keys
TMDB_API=your_key_here
TVDB_API_KEY=your_key_here  # Optional
FANART_API_KEY=your_key_here
MDBLIST_API_KEY=your_key_here

# Cache Warmup Configuration
CACHE_WARMUP_UUIDS=your-user-uuid-here,another-user-uuid  # Multiple UUIDs (up to 3)
CACHE_WARMUP_MODE=comprehensive  # 'essential' or 'comprehensive'

# Comprehensive Catalog Warmup Settings (when mode is 'comprehensive')
CATALOG_WARMUP_INTERVAL_HOURS=24  # Daily
CATALOG_WARMUP_MAX_PAGES_PER_CATALOG=100

# MAL Warmup (optional - can run independently)
MAL_WARMUP_ENABLED=true
MAL_WARMUP_INTERVAL_HOURS=6
MAL_WARMUP_PRIORITY_PAGES=3
MAL_WARMUP_DECADES=true

# Cache
ENABLE_CACHE_WARMING=true

# Cache Cleanup Scheduler
CACHE_CLEANUP_AUTO_ENABLED=true
CACHE_CLEANUP_QUIET_HOURS_ENABLED=false
CACHE_CLEANUP_QUIET_HOURS=02:00-06:00
```

### Shared Hosting Setup (.env)
```bash
# Basic Config
PORT=1337
HOST_NAME=my-addon.com
DATABASE_URL=sqlite:./data/aiometadata.db
REDIS_URL=redis://localhost:6379
TMDB_API=your_key_here
TVDB_API_KEY=your_key_here  # Optional

# Cache Warmup (essential mode - lightweight)
CACHE_WARMUP_UUID=system-cache-warmer  # Legacy single UUID (still supported)
CACHE_WARMUP_MODE=essential  # Use 'essential' for lightweight warming only

# Conservative MAL Warmup
MAL_WARMUP_ENABLED=true
MAL_WARMUP_INTERVAL_HOURS=12
MAL_WARMUP_QUIET_HOURS_ENABLED=true
MAL_WARMUP_QUIET_HOURS_RANGE=2-8
MAL_WARMUP_PRIORITY_PAGES=1
MAL_WARMUP_DECADES=false
MAL_WARMUP_LOG_LEVEL=silent

# Note: Comprehensive mode not recommended for shared hosting due to resource usage
```

---

## Security Best Practices

1. **Never commit `.env` files** to version control
2. **Use strong ADMIN_KEY**: Generate with `openssl rand -hex 32`
3. **Restrict API keys**: Use domain restrictions when possible
4. **Use HTTPS**: Always use HTTPS in production
5. **Rotate keys**: Periodically rotate API keys and admin keys
6. **Limit access**: Use firewall rules to limit access to admin endpoints

---

## Getting API Keys

| Service | URL | Free Tier | Required |
|---------|-----|-----------|----------|
| TMDB | https://www.themoviedb.org/settings/api | Yes | Yes |
| TVDB | https://thetvdb.com/dashboard/account/apikeys | Yes | No |
| Fanart.tv | https://fanart.tv/get-an-api-key/ | Yes | No |
| RPDB | https://ratingposterdb.com/ | Yes | No |
| MDBList | https://mdblist.com/ | Yes | No |
| Gemini | https://makersuite.google.com/app/apikey | Yes | No |

---

## Troubleshooting

### Server Won't Start
- Check DATABASE_URL is correct
- Verify Redis is running
- Ensure all required API keys are set

### High Memory Usage
- Reduce MAX_CONCURRENT_REQUESTS
- Decrease CATALOG_LIST_ITEMS_SIZE
- Disable CACHE_WARMUP_ON_STARTUP

### Rate Limit Errors
- Use MAL_SOCKS_PROXY_URL for Jikan
- Reduce MAL_WARMUP_PRIORITY_PAGES (e.g., from 2 to 1)
- Increase MAL_WARMUP_INTERVAL_HOURS (e.g., from 6 to 12)
- Enable MAL_WARMUP_QUIET_HOURS
- Disable MAL_WARMUP_DECADES if enabled

### Slow Performance
- Ensure Redis is properly configured
- Enable ENABLE_CACHE_WARMING
- Enable MAL_WARMUP_ENABLED
- Check REQUEST_TIMEOUT isn't too low

---

For more information, see:
- [MAL Warmup Documentation](./MAL_WARMUP.md)
- [Main README](../README.md)

