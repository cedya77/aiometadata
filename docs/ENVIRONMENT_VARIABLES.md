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
- **Required**: Yes
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

## MAL Catalog Background Warming

Complete documentation: [MAL_WARMUP.md](./MAL_WARMUP.md)

### `CACHE_WARMUP_UUID`
- **Default**: `system-cache-warmer`
- **Description**: User UUID to use for cache warming operations (uses that user's config for providers, language, etc.)
- **Example**: `CACHE_WARMUP_UUID=550e8400-e29b-41d4-a716-446655440000`
- **Note**: If not set, uses a default system config. You can set this to your own UUID to warm caches with your preferred settings.

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
- **Description**: HTTP/HTTPS proxy
- **Example**: `HTTP_PROXY=http://proxy.example.com:8080`

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
TMDB_API_KEY=your_key_here
TVDB_API_KEY=your_key_here
FANART_API_KEY=your_key_here
MDBLIST_API_KEY=your_key_here

# MAL Warmup (optimized for VPS)
MAL_WARMUP_ENABLED=true
CACHE_WARMUP_UUID=system-cache-warmer  # or use your own UUID
MAL_WARMUP_INTERVAL_HOURS=6
MAL_WARMUP_PRIORITY_PAGES=3
MAL_WARMUP_DECADES=true

# Cache
ENABLE_CACHE_WARMING=true
```

### Shared Hosting Setup (.env)
```bash
# Basic Config
PORT=1337
HOST_NAME=my-addon.com
DATABASE_URL=sqlite:./data/aiometadata.db
REDIS_URL=redis://localhost:6379
TMDB_API=your_key_here
TVDB_API_KEY=your_key_here

# Conservative MAL Warmup
MAL_WARMUP_ENABLED=true
CACHE_WARMUP_UUID=system-cache-warmer  # or use your own UUID
MAL_WARMUP_INTERVAL_HOURS=12
MAL_WARMUP_QUIET_HOURS_ENABLED=true
MAL_WARMUP_QUIET_HOURS_RANGE=2-8
MAL_WARMUP_PRIORITY_PAGES=1
MAL_WARMUP_DECADES=false
MAL_WARMUP_LOG_LEVEL=silent
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
| TVDB | https://thetvdb.com/dashboard/account/apikeys | Yes | Yes |
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

