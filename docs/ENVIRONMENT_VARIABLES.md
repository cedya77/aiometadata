# Environment Variables Configuration

This document describes all available environment variables for AIOMetadata.

## Quick Start

Create a `.env` file in the project root with your configuration:

```bash
cp .env.example .env
# Edit .env with your settings
```

---

## Server Configuration

### `PORT`
- **Default**: `3232`
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


### `ADDON_LOGO_URL`
- **Required**: No
- **Description**: Override the logo URL in the manifest. If not set, defaults to `${HOST_NAME}/logo.png`.
- **Example**: `ADDON_LOGO_URL=https://yourdomain.com/yourlogo.png`

### `LOG_LEVEL`
- **Default**: `info` (production), `debug` (development)
- **Options**: `silent`, `info`, `debug`
- **Description**: Logging verbosity level
- **Example**: `LOG_LEVEL=info`

### `LOG_BUFFER_SIZE`
- **Default**: `10000`
- **Description**: Maximum number of log entries kept in the in-memory ring buffer for the dashboard logs tab. Lower this on memory-constrained instances.
- **Example**: `LOG_BUFFER_SIZE=5000`

### `RESPONSE_COMPRESSION_ENABLED`
- **Default**: `true`
- **Description**: Compress HTTP responses with gzip or brotli, whichever the client negotiates. A 20-item catalog page drops from about 99 KB to about 22 KB for roughly 1 ms of CPU. Images, server-sent events and responses under 1 KB are left alone. Set false only if a reverse proxy in front is already compressing.
- **Example**: `RESPONSE_COMPRESSION_ENABLED=false`

---

## Database Configuration

### `DATABASE_URI`
- **Required**: Yes
- **Description**: Database connection string (PostgreSQL or SQLite). In a multi-region deploy this is the single **writable primary**, shared by every region — all writes (config saves, OAuth tokens, login rehash) go here.
- **Examples**:
  - PostgreSQL: `DATABASE_URI=postgresql://user:password@localhost:5432/aiometadata`
  - SQLite: `DATABASE_URI=sqlite://addon/data/db.sqlite`

### `DATABASE_READ_URI`
- **Required**: No (PostgreSQL only)
- **Description**: Optional read-replica connection string. When set, all reads are served from this replica while writes still go to `DATABASE_URI`. Intended for geo-redundant deploys where each region points `DATABASE_URI` at the shared primary and `DATABASE_READ_URI` at a local streaming replica for low-latency reads. Falls back to the primary automatically if unset or unreachable at startup.
- **Example**: `DATABASE_READ_URI=postgresql://user:password@local-replica:5432/aiometadata`

### `RUN_MIGRATIONS`
- **Required**: No
- **Default**: `true`
- **Description**: Whether to run schema creation (`CREATE TABLE IF NOT EXISTS …`) on startup. Set to `false` on replica-region instances so they boot without attempting DDL; run migrations once against the primary.

> **Note:** with `RUN_MIGRATIONS=false`, create the `user_aliases` table by hand before enabling `USER_ALIASES_ENABLED`. Without it aliases simply never resolve; the rest of the addon, including the user list and user deletion, is unaffected.
> ```sql
> CREATE TABLE IF NOT EXISTS user_aliases (
>   alias_lower VARCHAR(64) PRIMARY KEY,
>   alias VARCHAR(64) NOT NULL,
>   user_uuid VARCHAR(255) UNIQUE NOT NULL,
>   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
> );
> ```

> **Geo-redundancy note:** the database is the source of truth and the sync layer — there is no separate config-sync mechanism. Run one shared primary plus a local read replica per region, point `DATABASE_URI` at the primary everywhere and `DATABASE_READ_URI` at each region's replica. Config saves prime the local Redis cache directly, so the user who made a change reads it back immediately even before replication catches up. Cache (`REDIS_URL`) can be regional; cross-region invalidation is bounded by `CONFIG_CACHE_TTL_SEC`.

---

## Redis Cache Configuration

### `REDIS_URL`
- **Required**: Yes
- **Description**: Redis connection URL for caching (required for the app to function)
- **Example**: `REDIS_URL=redis://localhost:6379`

### `TMDB_DETAIL_TTL`
- **Default**: `86400` (24 hours)
- **Description**: Time-to-live, in seconds, for cached TMDB `/movie/{id}`, `/tv/{id}` and `/collection/{id}` detail responses. These are the largest entries the addon writes to Redis — they carry a wide `append_to_response` (images, translations, seasons), so one entry can run to tens of KB even after compression, and on a busy shared instance they can crowd out the per-user meta and catalog entries that are far more expensive to rebuild. If `TMDB_API_BASE` already points at your own caching proxy, that proxy holds the same data for longer and closer to the source, so the Redis copy earns little: lower this, or set it to `0` to skip caching these responses entirely. Leave it at the default when talking to TMDB directly.
- **Example**: `TMDB_DETAIL_TTL=3600`

### `CATALOG_REFRESH_AHEAD_ENABLED`
- **Default**: `true`
- **Description**: Rebuild a catalog in the background when a request arrives near the end of its cache lifetime, so the cached copy is served immediately and the rebuild never lands on a user request. Only catalogs are affected. Cache TTLs are unchanged, so nothing is served staler than `CATALOG_TTL` already allows.
- **Example**: `CATALOG_REFRESH_AHEAD_ENABLED=false`

### `CATALOG_REFRESH_AHEAD_FRACTION`
- **Default**: `0.1`
- **Description**: How much of an entry's lifetime counts as due for a background rebuild, as a fraction. `0.1` means the final tenth, so the last 2.4 hours of a 24 hour catalog. Values outside 0 to 0.5 fall back to `0.1`.
- **Example**: `CATALOG_REFRESH_AHEAD_FRACTION=0.2`

### `CATALOG_REFRESH_AHEAD_MAX_CONCURRENT`
- **Default**: `3`
- **Description**: How many background catalog rebuilds may run at once. Anything over the limit is skipped rather than queued, which is safe because the entry it would have refreshed is still fresh. This bounds upstream fan-out when many catalogs fall due together, which happens because the warmer writes them all within about a minute of each other.
- **Example**: `CATALOG_REFRESH_AHEAD_MAX_CONCURRENT=5`

---

## Admin Configuration

### `ADMIN_KEY`
- **Recommended**: Yes
- **Description**: Secret key for admin API endpoints
- **Example**: `ADMIN_KEY=your-secure-random-key-here`
- **Note**: Generate with: `openssl rand -hex 32`

### `IMAGE_PROXY_SIGNING_SECRET`
- **Default**: unset (falls back to `ADMIN_KEY`)
- **Description**: HMAC secret used to sign the `/poster`, `/logo`, `/background` and `/landscape` proxy URLs, so the addon will only render artwork for URLs it issued itself. If neither variable is set, proxy URLs are served unsigned. The signing key is derived from this value for that single purpose, so a published signature reveals nothing about the secret — which, via the `ADMIN_KEY` fallback, may also guard admin access.
- **Example**: `IMAGE_PROXY_SIGNING_SECRET=your-secure-random-key-here`
- **Note**: Generate with `openssl rand -hex 32`. Rotating it invalidates every previously signed URL, so already-published artwork links stop resolving until clients refetch them.

---

## API Keys

There are two kinds. Server-side keys stay on the server. The rest are published
to every visitor, so which one you reach for depends on who uses the instance.

### Server-side keys (start here)

#### `BUILT_IN_TMDB_API_KEY`, `BUILT_IN_TVDB_API_KEY`, `BUILT_IN_FANART_API_KEY`, `BUILT_IN_RPDB_API_KEY`
- **Optional**: Yes
- **Description**: Used for any user who has not supplied their own key. They are never sent to the browser: `/api/config` publishes only `hasBuiltInTmdb` and `hasBuiltInTvdb`, so the UI can hide the field without seeing the key. This is the way to fund an instance other people use.
- **Note**: Every request from every user is billed to these keys, so mind the provider's rate limits.

#### `BUILT_IN_MDBLIST_API_KEY`, `BUILT_IN_GEMINI_API_KEY`
- **Optional**: Yes
- **Description**: The same fallback for MDBList catalogs and AI search, and equally private. A user's own key still wins, then the published `MDBLIST_API_KEY` / `GEMINI_API_KEY`, then these.
- **Warning**: Unlike the four above, these bill you per call. MDBList charges past 1000 calls a day and Gemini charges per query, and every user of the instance spends them. Set them on a private instance only. On a public one, leave them blank and let users who want MDBList catalogs or AI search bring their own key.

### Keys published to the browser

> **These are handed to every visitor.** `/api/config` serves `TMDB_API_KEY`,
> `TVDB_API_KEY`, `FANART_API_KEY`, `RPDB_API_KEY`, `MDBLIST_API_KEY` and
> `GEMINI_API_KEY` in full, so the configure page can prefill them. It is an open
> path even when `AUTH_REQUIRE_SIGNIN=true`, because the page loads before anyone
> has signed in, so a login does not protect them.
>
> Set them only on an instance whose users you would hand your keys to. On a
> shared instance, leave them blank, use the `BUILT_IN_*` keys above, and let each
> user bring their own.
>
> `TRAKT_CLIENT_ID` and `SIMKL_CLIENT_ID` are also in that payload, and that is
> fine: an OAuth client id is public by design and already visible in the
> authorization URL the browser opens. Their secrets are never published. The one
> thing to know is that both APIs accept a client id alone for public endpoints,
> so a copied id lets someone else's traffic count against your app's rate limit.
> `TRAKT_CLIENT_SECRET` and `SIMKL_CLIENT_SECRET` are what must stay private.

#### `TMDB_API_KEY`
- **Required**: Yes
- **Description**: The Movie Database (TMDB) API key
- **Legacy**: `TMDB_API` is also supported for backwards compatibility
- **Get it**: https://www.themoviedb.org/settings/api

#### `TVDB_API_KEY`
- **Required**: No
- **Description**: TheTVDB API key (v4)
- **Get it**: https://thetvdb.com/dashboard/account/apikeys

#### `FANART_API_KEY`
- **Optional**: Yes
- **Description**: Fanart.tv API key for high-quality artwork
- **Get it**: https://fanart.tv/get-an-api-key/

#### `RPDB_API_KEY`
- **Optional**: Yes
- **Description**: RPDB (Rating Poster Database) API key
- **Get it**: https://ratingposterdb.com/


#### `MDBLIST_API_KEY`
- **Optional**: Yes
- **Description**: MDBList API key for custom lists
- **Get it**: https://mdblist.com/

#### `TRAKT_CLIENT_ID`
- **Required for Trakt integration**: Yes
- **Description**: Trakt API client ID for enabling Trakt account integration (watchlists, custom lists, etc.)
- **Get it**: https://trakt.tv/oauth/applications

#### `TRAKT_CLIENT_SECRET`
- **Required for Trakt integration**: Yes
- **Description**: Trakt API client secret for enabling Trakt account integration
- **Get it**: https://trakt.tv/oauth/applications

#### `TRAKT_REDIRECT_URI`
- **Required for Trakt integration**: Yes
- **Description**: Redirect URI for Trakt OAuth. Must match the value set in your Trakt app settings.
- **Example**: `TRAKT_REDIRECT_URI=https://your-domain.com/api/auth/trakt/callback`

#### `TRAKT_OAUTH_STATE_TTL_MS`
- **Required**: No
- **Default**: `600000` (10 minutes)
- **Description**: Lifetime in milliseconds of the HMAC-signed Trakt OAuth state. The state is verified with `TRAKT_CLIENT_SECRET`, so authorize and callback requests can be handled by different replicas without shared state storage.
- **Security note**: The stateless state provides integrity and expiration but is replayable until it expires. Trakt authorization codes remain one-time at the provider; strict one-time state consumption requires shared storage or browser-session binding.

#### `SIMKL_CLIENT_ID`
- **Required for SimKL integration**: Yes
- **Description**: SimKL API client ID for enabling SimKL account integration (watchlists, trending catalogs, etc.)
- **Get it**: https://simkl.com/oauth/applications

#### `SIMKL_CLIENT_SECRET`
- **Required for SimKL integration**: Only for the OAuth flow (not needed when `SIMKL_AUTH_MODE=pin`)
- **Description**: SimKL API client secret for enabling SimKL account integration
- **Get it**: https://simkl.com/oauth/applications

#### `SIMKL_AUTH_MODE`
- **Required**: No
- **Default**: `pin` when `SIMKL_CLIENT_SECRET` is unset, otherwise `oauth`
- **Values**: `oauth`, `pin`, `both`
- **Description**: Which SimKL connection flow(s) the configure page offers.
  - `oauth` - the browser-redirect flow. Needs `SIMKL_CLIENT_SECRET` plus a publicly reachable `HOST_NAME`/`SIMKL_REDIRECT_URI` registered with SimKL.
  - `pin` - the PIN (device) flow. The server asks SimKL for a short code, the user enters it at https://simkl.com/pin, and the server polls until SimKL hands back an access token. Needs only `SIMKL_CLIENT_ID`: no client secret and no inbound callback, so it works on instances that are not reachable from the internet.
  - `both` - offers each flow side by side.
- **Example**: `SIMKL_AUTH_MODE=pin`

#### `DEVICE_AUTH_POLL_RATE_LIMIT_PER_MIN`
- **Required**: No
- **Default**: `240`
- **Description**: Instance-wide cap on PIN authorization status polls per minute on `/api/auth/simkl/pin/status`. Only applies when Redis is available.

#### `SIMKL_REDIRECT_URI`
- **Required for SimKL integration**: No (optional, and unused when `SIMKL_AUTH_MODE=pin`)
- **Description**: Redirect URI for SimKL OAuth. If not set, defaults to `${HOST_NAME}/api/auth/simkl/callback`. Must match the value set in your SimKL app settings if explicitly set.
- **Example**: `SIMKL_REDIRECT_URI=https://your-domain.com/api/auth/simkl/callback`

#### `SIMKL_ACTIVITIES_TTL`
- **Default**: `1800` (30 minutes)
- **Description**: Time-to-live (in seconds) for caching SimKL activity checks. Reduces API spam when paginating. Also caps how long Up Next keeps showing an episode you just watched, and how long a completed item can still appear when Hide Simkl Watched is on. Simkl asks callers not to check more often than every 15 minutes.
- **Example**: `SIMKL_ACTIVITIES_TTL=3600` (1 hour)

#### `SIMKL_TRENDING_PAGE_SIZE_OPTIONS`
- **Default**: `50,100`
- **Description**: Comma-separated list of page size options (1-500) shown in the UI for SimKL trending catalogs. Use this to limit choices on public instances and prevent API overload.
- **Example**: `SIMKL_TRENDING_PAGE_SIZE_OPTIONS=50,100,200` (allow 50, 100, 200)

#### `GEMINI_API_KEY`
- **Optional**: Yes
- **Description**: Google Gemini API key for AI search features
- **Get it**: https://makersuite.google.com/app/apikey

---

## Timezone Configuration

### `TZ`
- **Optional**: Yes
- **Default**: `UTC`
- **Description**: Server timezone for date/time operations. Used for Trakt calendar features (shows airing this week). Can be configured per-user in the UI settings.
- **Example**: `TZ=America/New_York`
- **Common Values**:
  - `America/New_York` - Eastern Time
  - `America/Chicago` - Central Time
  - `America/Los_Angeles` - Pacific Time
  - `Europe/London` - UK Time
  - `Europe/Paris` - Central European Time
  - `Asia/Tokyo` - Japan Time
  - `Australia/Sydney` - Australian Eastern Time

---

## Jikan API Configuration (MyAnimeList)

### `JIKAN_API_BASE`
- **Default**: `https://api.jikan.moe/v4`
- **Description**: Base URL for Jikan API
- **Example**: `JIKAN_API_BASE=https://api.jikan.moe/v4`

### `MAL_PAGE_SIZE`
- **Default**: `25`
- **Description**: Items per page for all MAL/Jikan catalogs and search. The public Jikan API caps `limit` at 25; only raise this on a self-hosted instance, and keep it **≤** that instance's `MAX_RESULTS_PER_PAGE` or requests will fail with a 400.
- **Example**: `MAL_PAGE_SIZE=50`

### `MAL_SOCKS_PROXY_URL`
- **Optional**: Yes
- **Description**: SOCKS proxy for Jikan API requests (if your IP is rate-limited)
- **Format**: `socks5://user:pass@host:port` or `socks4://host:port`
- **Example**: `MAL_SOCKS_PROXY_URL=socks5://user:pass@proxy.example.com:1080`

---

## ID Mapping & Ratings Update Configuration

### `WIKI_MAPPER_UPDATE_INTERVAL_HOURS`
- **Default**: `24`
- **Description**: How often to fetch Wikidata ID mappings (series/movies) from GitHub (in hours). Uses ETag to avoid re-downloading when unchanged.
- **Example**: `WIKI_MAPPER_UPDATE_INTERVAL_HOURS=12`

### `IMDB_RATINGS_UPDATE_INTERVAL_HOURS`
- **Default**: `24`
- **Description**: How often to fetch IMDb ratings from the official IMDb dataset (in hours). Uses ETag to avoid re-downloading when unchanged.
- **Example**: `IMDB_RATINGS_UPDATE_INTERVAL_HOURS=12`

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

### `CATALOG_WARMUP_TTL_LEAD_SECONDS`
- **Default**: `60` (1 minute)
- **Description**: How long before the next warming run a warmed catalog is held to expire. Warming anchors its schedule on the moment a run starts, so a slow run can write catalogs that outlive the next run and get read back as hits instead of refreshed. Holding them to lapse just before the run keeps every cycle refreshing. Only ever shortens a TTL, so a catalog set to refresh faster than the warm interval keeps its own.
- **Example**: `CATALOG_WARMUP_TTL_LEAD_SECONDS=300`

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

### `CATALOG_WARMUP_AUTO_ON_EPOCH_CHANGE`
- **Default**: `false`
- **Description**: Automatically trigger catalog warmup when `CACHE_EPOCH` changes. The warmer compares the current epoch against the last one stored in Redis and, if they differ, runs a warmup immediately — bumping the epoch supersedes every existing key, so the cache is genuinely empty and worth refilling.
- **Example**: `CATALOG_WARMUP_AUTO_ON_EPOCH_CHANGE=true`
- **Note**: Requires `CACHE_WARMUP_MODE=comprehensive`. Formerly `CATALOG_WARMUP_AUTO_ON_VERSION_CHANGE`, which is still accepted: keys used to be prefixed with the addon version, so a release invalidated everything. They now carry `e<CACHE_EPOCH>:` instead, and a release on its own invalidates nothing — warming on it just repeated work against a valid cache.

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

## In-Memory Cache Limits

These caps bound the per-process heap used by module-level caches. The defaults are sized for a typical public instance; raise them on high-traffic deployments with many unique user API keys, lower them on memory-constrained hosts.

### `FANART_CLIENT_CACHE_MAX`
- **Default**: `2000`
- **Description**: Maximum number of Fanart.tv client instances kept in memory. The cache is keyed by the user's personal Fanart key, so each unique personal key consumes one slot. Entries expire after 24 hours. The default is sized for popular public instances; lower it on memory-constrained self-hosts.
- **Example**: `FANART_CLIENT_CACHE_MAX=500`

### `TMDB_SCRAPED_IMDB_CACHE_MAX`
- **Default**: `10000`
- **Description**: Maximum number of TMDB-ID → IMDb-ID mappings cached from the IMDb scraper fallback. LRU eviction, 24-hour TTL.
- **Example**: `TMDB_SCRAPED_IMDB_CACHE_MAX=20000`

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

### `CACHE_WARMING_INTERVAL`
- **Default**: `720` (12 hours)
- **Description**: Minutes between API cache warming cycles (genres, studios, etc.)
- **Example**: `CACHE_WARMING_INTERVAL=1440` (24 hours)

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

### `MAX_CATALOGS`
- **Optional**: Yes
- **Default**: Unset (no limit)
- **Description**: Maximum number of enabled catalogs a user can have in their configuration. When set, saving a configuration with more enabled catalogs than this limit is rejected. Useful for public instances to prevent abuse and ensure manifest generation remains fast.
- **Example**: `MAX_CATALOGS=200`

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

### `USER_ALIASES_ENABLED`
- **Default**: `false`
- **Description**: Allow a human-readable alias to be used anywhere a user UUID is accepted — manifest URLs (`/stremio/Cedya/manifest.json`), the configure-page login, and the internal API. Aliases resolve to the canonical UUID before routing, so cache entries and metrics are shared between an alias and its UUID rather than duplicated. Aliases are guessable where UUIDs are not, so an alias makes an account enumerable; leave this off on public instances unless you also tighten `CONFIG_LOAD_RATE_LIMIT_PER_MIN`. Assigning and removing aliases goes through the admin API, so `ADMIN_KEY` must be set. An alias is part of the URL users install, so removing one breaks their installation and reassigning one points it at the new holder's catalogs.
- **Example**: `USER_ALIASES_ENABLED=true`

### `USER_ALIASES`
- **Required**: No
- **Description**: Comma-separated `alias=uuid` pairs applied at every startup. Aliases must be 3–32 characters of letters, numbers, hyphens or underscores, are matched case-insensitively, are unique across the instance, and cannot be UUID-shaped or a reserved word (`configure`, `catalog`, `meta`, `export`, …). One alias per user; setting a new one replaces the old. Entries here take precedence over aliases set from the dashboard and are reapplied on every boot, including reassigning an alias away from whoever currently holds it. Invalid entries are logged and skipped — they never block startup.
- **Example**: `USER_ALIASES=Cedya=3f8b2c1a-4d5e-6f70-8a9b-0c1d2e3f4a5b,mum=11111111-2222-3333-4444-555555555555`

### `USER_ALIAS_REFRESH_SEC`
- **Default**: `30`
- **Description**: How often each process refreshes its in-memory alias map from the database. Resolution is served from memory so the hot path does no I/O. Only relevant when running more than one replica against a shared database: an alias created on one replica becomes resolvable on the others within this window.
- **Example**: `USER_ALIAS_REFRESH_SEC=15`

### `CONFIG_LOAD_RATE_LIMIT_PER_MIN`
- **Default**: `20`
- **Description**: Maximum configure-page login attempts (`POST /api/config/load/:id`) per **account** per minute. Bucketed per account rather than per client IP, because `trust proxy` is disabled — a per-IP bucket would throttle every user behind the reverse proxy at once. An alias and its UUID share one bucket. Requires Redis; without Redis the limiter is skipped. Matters most with `USER_ALIASES_ENABLED=true`.
- **Example**: `CONFIG_LOAD_RATE_LIMIT_PER_MIN=10`

---

## Dashboard Configuration

### `DASHBOARD_METADATA_LANGUAGE`
- **Default**: `en`
- **Description**: Preferred language code for popular-content titles shown on the dashboard Content tab. A title captured in this language is not overwritten by requests in other languages. Leave blank to always use the most recent request's language.
- **Example**: `DASHBOARD_METADATA_LANGUAGE=fr`

---

## Rate Limiting & Performance

### `MAX_CONCURRENT_REQUESTS`
- **Default**: `10`
- **Description**: Maximum concurrent requests per provider
- **Example**: `MAX_CONCURRENT_REQUESTS=5`
- **Note**: Adjust based on your server capacity and API limits

### `META_CONCURRENCY`
- **Default**: Unlimited
- **Description**: Maximum number of concurrent `getMeta()` calls per catalog request. Each catalog page can trigger 20-50 simultaneous meta fetches; on public instances with many active users, this can spike memory usage. Set to 20-30 to cap peak heap usage while keeping response times fast. Cached items resolve instantly regardless of this limit.
- **Example**: `META_CONCURRENCY=25`

### `HEAP_LOG_INTERVAL_MIN`
- **Default**: `0` (disabled)
- **Description**: Periodically logs heap usage and in-memory cache sizes to the console. Value is the interval in minutes. Useful for monitoring memory on public instances.
- **Example**: `HEAP_LOG_INTERVAL_MIN=30`

### `POSTER_PROXY_TIMEOUT_MS`
- **Default**: `10000`
- **Description**: Milliseconds to wait for an upstream poster/art image (RPDB, Top Posters, or a custom art pattern) before giving up and serving the fallback poster. Raise this if a slow rating/poster-generation service frequently times out on first render.
- **Example**: `POSTER_PROXY_TIMEOUT_MS=15000`

### `REQUEST_TIMEOUT`
- **Default**: `8000`
- **Description**: Request timeout in milliseconds
- **Example**: `REQUEST_TIMEOUT=10000`

---

## MovieLens Integration

Powers personalized recommendation catalogs backed by a user's own MovieLens account, plus automatic syncing of their Trakt/Simkl/MDBList ratings into MovieLens.

### `MOVIELENS_CRED_KEY`
- **Default**: _(none — required to enable the integration)_
- **Description**: AES-256-GCM key used to encrypt stored MovieLens passwords at rest. MovieLens has no OAuth, so the integration must retain a password to re-establish expired cookie sessions. This setting is **env-only** and is never editable from the dashboard. Rotating it orphans all stored credentials, forcing every user to reconnect.
- **Example**: `MOVIELENS_CRED_KEY=a-long-random-secret`

### `ENABLE_MOVIELENS_SYNC`
- **Default**: `true`
- **Description**: Enables the scheduled background job that re-syncs ratings into connected MovieLens accounts. Requires a restart to take effect.
- **Example**: `ENABLE_MOVIELENS_SYNC=false`

### `MOVIELENS_SYNC_INTERVAL_HOURS`
- **Default**: `24`
- **Description**: How often the scheduled job re-syncs ratings into MovieLens. Requires a restart to take effect.
- **Example**: `MOVIELENS_SYNC_INTERVAL_HOURS=12`

### `MOVIELENS_MANUAL_SYNC_COOLDOWN_SECONDS`
- **Default**: `21600`
- **Description**: Minimum time between user-triggered "Import ratings" runs, to keep users from hammering MovieLens on demand.
- **Example**: `MOVIELENS_MANUAL_SYNC_COOLDOWN_SECONDS=3600`

### `MOVIELENS_API_BASE`
- **Default**: `https://movielens.org/api`
- **Description**: Base URL for the MovieLens API.
- **Example**: `MOVIELENS_API_BASE=https://movielens.org/api`

### `MOVIELENS_REQUEST_TIMEOUT_MS`
- **Default**: `25000`
- **Description**: Timeout for requests to the MovieLens API, in milliseconds.
- **Example**: `MOVIELENS_REQUEST_TIMEOUT_MS=30000`

### `MOVIELENS_USER_AGENT`
- **Default**: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`
- **Description**: User-Agent header sent to MovieLens. MovieLens sits behind Cloudflare, which serves an HTML block page to requests lacking a browser-like User-Agent, so this must remain plausible.
- **Example**: `MOVIELENS_USER_AGENT=Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...`

### `MOVIELENS_LOGIN_REFERER`
- **Default**: `https://movielens.org/login`
- **Description**: Referer header used for the MovieLens login request.
- **Example**: `MOVIELENS_LOGIN_REFERER=https://movielens.org/login`

### `MOVIELENS_IMPORT_REFERER`
- **Default**: `https://movielens.org/profile/settings/import-export`
- **Description**: Referer header used for the MovieLens CSV ratings-import request.
- **Example**: `MOVIELENS_IMPORT_REFERER=https://movielens.org/profile/settings/import-export`

### `MOVIELENS_CATALOG_TTL_SECONDS`
- **Default**: `3600`
- **Description**: Time-to-live for MovieLens catalog cache entries, in seconds. A per-catalog `cacheTTL` configured in the UI takes precedence.
- **Example**: `MOVIELENS_CATALOG_TTL_SECONDS=7200`

### `MOVIELENS_USERMETA_TTL_SECONDS`
- **Default**: `43200`
- **Description**: Time-to-live for cached MovieLens account metadata — the selected recommendation engine and the onboarding taste tags. Taste tags are only injected into catalog queries while the account is on the `bard` engine, so lowering this makes the addon react faster when a user graduates to a personalized engine. Replaces `MOVIELENS_GROUPTAGS_TTL_SECONDS`, which is still honoured as a fallback.
- **Example**: `MOVIELENS_USERMETA_TTL_SECONDS=21600`

### `MOVIELENS_LIST_MAX_PAGES`
- **Default**: `50`
- **Description**: Safety cap on the number of pages fetched when paginating a MovieLens user list. The list endpoint ignores `pageSize` and returns fixed-size pages, so deep pagination requires accumulating pages server-side.
- **Example**: `MOVIELENS_LIST_MAX_PAGES=100`

---

## Metahub Artwork Checks

### `METAHUB_IMAGE_EXISTS_TTL_SECONDS`
- **Default**: `86400`
- **Description**: Time-to-live for cached metahub logo/image existence checks, in seconds. These checks gate the IMDb artwork fallback, so caching them avoids a HEAD request per item on every render.
- **Example**: `METAHUB_IMAGE_EXISTS_TTL_SECONDS=43200`

### `METAHUB_IMAGE_HEAD_TIMEOUT_MS`
- **Default**: `4000`
- **Description**: Timeout for the metahub image existence HEAD request, in milliseconds. A miss falls through to the configured provider's artwork, so a low value trades fallback coverage for latency.
- **Example**: `METAHUB_IMAGE_HEAD_TIMEOUT_MS=2000`

---

## TMDB Image Renditions

TMDB serves `/t/p/original` as the file the uploader supplied, which is usually far
larger than any client renders. These four toggles request a sized rendition
instead. Three of them — logos, backdrops, landscape — are **off by default**, so
artwork is unchanged until you opt in. `PREFER_SMALLER_POSTERS_TMDB` is the
exception and defaults to **on**, because posters have always been requested at a
sized rendition; turning it off is what changes artwork. All are dashboard toggles
and apply without a restart.

For logos, backdrops and landscape posters a sized rendition is only requested when
the asset is actually larger than that size. TMDB *upscales* rather than refusing
when asked for more than an asset has — a 350px logo requested at `w500` comes back
re-encoded at 500px and roughly 1.8x the bytes of the original — so the addon falls
back to `original` whenever TMDB reports the asset at or below the target width.
Posters skip that check: `w600_and_h900_bestv2` is a fixed 600x900 crop rather than a
width-bounded resize, so falling back to `original` for a narrow poster would change
its aspect ratio in a catalog grid.

None of them rewrite meta that is already cached — those payloads carry the URLs
they were built with until `META_TTL` / `CATALOG_TTL` expire, which spreads the
changeover out rather than stranding the whole cache at once. Raise `CACHE_EPOCH` to
apply a change immediately. Superseded images stay on disk unreferenced; because both
reclaim paths (`POSTER_CACHE_MAX_SIZE` eviction and `POSTER_CACHE_INACTIVE_DAYS`
sweeping) order by last access, they sort ahead of every live entry and are the first
thing dropped. No manual purge is needed.

### `PREFER_SMALLER_POSTERS_TMDB`
- **Default**: `true`
- **Description**: Request TMDB posters at `w600_and_h900_bestv2` rather than `original`. Unlike the other three this is **on by default** — it is what the addon has always done, so leaving it alone keeps artwork exactly as it is, and setting it to `false` is the change. Posters are the highest-volume image class by a wide margin, one per catalog tile, so originals multiply bandwidth and disk on every catalog view rather than on the occasional detail page. Set it to `false` only if poster sharpness on a large display matters more than that.
- **Example**: `PREFER_SMALLER_POSTERS_TMDB=false`

### `PREFER_SMALLER_LOGOS_TMDB`
- **Default**: `false`
- **Description**: Request TMDB logos at `w500` rather than `original`. Originals are lossless PNGs with a median width of 1683px — some over 4000px — for artwork clients render far smaller, so this is the largest saving of the three at roughly 12x less data with the least visible drawback. Leave it off if you serve logos to something that renders them very large.
- **Example**: `PREFER_SMALLER_LOGOS_TMDB=true`

### `PREFER_SMALLER_BACKDROPS_TMDB`
- **Default**: `false`
- **Description**: Request TMDB backgrounds at `w1280` rather than `original` — an average of 5.1x reduction in data. This is the one with a genuine quality trade: the median original backdrop is 3700px wide and roughly half are true 4K, so a client rendering the background full-screen on a 4K display will be upscaling. Turn it on if disk or bandwidth matters more than background sharpness.
- **Example**: `PREFER_SMALLER_BACKDROPS_TMDB=true`

### `PREFER_SMALLER_LANDSCAPE_TMDB`
- **Default**: `false`
- **Description**: Request TMDB landscape posters at `w780` rather than `original` an average of 11.6x reduction. Independent of `PREFER_SMALLER_BACKDROPS_TMDB` even though both draw on TMDB's backdrops: a landscape poster is a backdrop chosen for the preferred language, and clients render it as a catalog tile a few hundred pixels wide rather than full-screen, so it tolerates a smaller rendition than a background does.
- **Example**: `PREFER_SMALLER_LANDSCAPE_TMDB=true`

---

## Built-in Image Cache

Caches artwork on disk and serves it from `/poster-cache` on the addon's own port — no extra container, port, or volume. Images live under `addon/data/poster-cache`, inside the data volume that is already mounted.

Two terms used throughout this section. The **proxy routes** are `/poster`, `/logo`, `/background` and `/landscape`, plus their `/poster-cache/proxy/…` twins. The **direct route** is `/poster-cache/<class>/<url>`, addressed by the image URL itself.

**How long an image stays fresh** is decided most-specific-first: a rule in [`POSTER_CACHE_PROVIDER_POLICIES`](#poster_cache_provider_policies), then the provider's built-in policy ([`POSTER_CACHE_PROVIDER_PRESETS`](#poster_cache_provider_presets)), then [`POSTER_CACHE_INFER_TTL`](#poster_cache_infer_ttl), then the flat [`POSTER_CACHE_TTL_DAYS`](#poster_cache_ttl_days).

Art the addon **passes through without storing** is decided by a chain of its own, differing in one step: a rule, then [`POSTER_PROXY_FOLLOW_UPSTREAM`](#poster_proxy_follow_upstream), then the provider's built-in policy, then [`POSTER_PROXY_MAX_AGE_DAYS`](#poster_proxy_max_age_days). Turning `POSTER_PROXY_FOLLOW_UPSTREAM` on is an install-wide decision to relay verbatim, so a built-in policy does not override it — a rule you write yourself still does.

### `ENABLE_BUILTIN_POSTER_CACHE`
- **Default**: `false`
- **Description**: Turns the image cache on. Requires a restart. Posters are cached immediately; every other image class is opt-in below, so enabling this never changes disk usage unexpectedly. Each replica in a multi-replica deployment keeps its own independent cache.
- **Example**: `ENABLE_BUILTIN_POSTER_CACHE=true`

### `POSTER_CACHE_BACKGROUNDS`
- **Default**: `false`
- **Description**: Also cache background artwork. These are the largest images the addon serves, so this is the largest bandwidth saving. Applies to backgrounds from a custom art pattern too, whether or not they are proxied.
- **Example**: `POSTER_CACHE_BACKGROUNDS=true`

### `POSTER_CACHE_LANDSCAPE_POSTERS`
- **Default**: `false`
- **Description**: Also cache landscape poster artwork. Note that landscape *catalog* art travels in the ordinary poster field and is already covered by the default.
- **Example**: `POSTER_CACHE_LANDSCAPE_POSTERS=true`

### `POSTER_CACHE_LOGOS`
- **Default**: `false`
- **Description**: Also cache logo artwork. Many small files. Applies to logos from a custom art pattern too, whether or not they are proxied.
- **Example**: `POSTER_CACHE_LOGOS=true`

### `POSTER_CACHE_THUMBNAILS`
- **Default**: `false`
- **Description**: Also cache episode thumbnails. By far the most numerous class — one long-running series can contribute hundreds of images — so expect disk usage to grow quickly.
- **Example**: `POSTER_CACHE_THUMBNAILS=true`

### `POSTER_CACHE_CAST`
- **Default**: `false`
- **Description**: Also cache cast/actor headshots. Numerous, at roughly ten to twenty per title, and each one is a separate image, so expect this to take a real bite out of `POSTER_CACHE_MAX_SIZE` on a large library.
- **Example**: `POSTER_CACHE_CAST=true`

### `POSTER_CACHE_PROCESSED_IMAGES`
- **Default**: `true` (when `ENABLE_BUILTIN_POSTER_CACHE` is on)
- **Description**: Caches the images the addon renders itself — rating-overlaid posters from the `/poster` route (active when **Proxy Rating & Custom Art** is on) plus the `/api/image/blur` and `/api/image/banner-to-background` transforms. Enabled by default with the cache; without it those requests re-render on every view. Total volume is still bounded by `POSTER_CACHE_MAX_SIZE`.

  This covers *rendered* images only. Custom art URLs use the same proxy routes but are passed through byte-for-byte, so they store as the class they actually are and follow that class's toggle — a custom logo needs `POSTER_CACHE_LOGOS`, a custom background needs `POSTER_CACHE_BACKGROUNDS`, and so on.
- **Example**: `POSTER_CACHE_PROCESSED_IMAGES=false`

### `POSTER_PROXY_ALLOW_PRIVATE`
- **Default**: `true`
- **Description**: Whether a signed art URL may reach a private/LAN address. The signature proves the addon generated the URL from your art config — but that config is user-supplied, so it proves origin, not safety: on a multi-user instance any user could point an art pattern at an address inside your network. Leave it on for a single-operator deployment, where a self-hosted art provider then needs no allowlist entry. **Set it to `false` on a public multi-user instance**; `POSTER_CACHE_ALLOWED_HOSTS` still permits specific hosts you control, and public art providers are unaffected either way.

  Applies to every art fetch, cached or passed through, on both the proxy routes and the direct route.
- **Example**: `POSTER_PROXY_ALLOW_PRIVATE=false`

### `POSTER_CACHE_ALLOWED_HOSTS`
- **Default**: _(empty)_
- **Description**: Comma-separated hosts the addon may fetch from even when they resolve to a private/LAN address, which is otherwise refused as SSRF protection. Matched by hostname; listed hosts are still pinned to their resolved addresses. The guard runs before every fetch whether or not the class is being stored, so turning the cache off narrows what is kept, never what can be reached.

  You usually **don't** need this with **Proxy Rating & Custom Art** on: those URLs are signed, and a valid signature grants the exception on its own. You **do** need it with the art proxy off, when art goes to the direct route, which carries no signature.

  **If art from your own network stopped loading**, it is being refused because nothing proved the addon issued the URL — a warning naming the host is logged. Either list it here, or set [`IMAGE_PROXY_SIGNING_SECRET`](#image_proxy_signing_secret) so proxy art URLs are signed. With no secret set, nothing is signed and nothing can claim the exception.
- **Example**: `POSTER_CACHE_ALLOWED_HOSTS=postersplus,xrdb`

### `IMAGE_PROXY_SIGNING_SECRET`
- **Default**: falls back to `ADMIN_KEY`
- **Description**: Secret used to sign the proxy URLs the addon generates from your art config. A valid signature lets those, and only those, reach a private/LAN provider without an allowlist entry; unsigned or tampered `url=` values still face the full SSRF guard. Optional — the `ADMIN_KEY` fallback suits most deployments.

  Rotating it (or `ADMIN_KEY`, when it is the fallback) invalidates every signature already issued, so art URLs in cached meta responses stop verifying and fall back to their unproxied source until that cache turns over.
- **Example**: `IMAGE_PROXY_SIGNING_SECRET=some-long-random-string`

### `POSTER_CACHE_MAX_SIZE`
- **Default**: `10g`
- **Description**: Total **disk** budget. Once exceeded, least-recently-used images are evicted across all classes until usage drops to 90% of the limit. Accepts nginx-style sizes (`512m`, `10g`).
- **Example**: `POSTER_CACHE_MAX_SIZE=25g`

### `POSTER_CACHE_MEMORY_SIZE`
- **Default**: `128m`
- **Description**: **RAM** budget for the hottest images, in front of the disk cache. A memory hit skips the disk read and its per-request buffer, lowering GC pressure. Evicts least-recently-used at the budget, and only admits images below `POSTER_CACHE_STREAM_THRESHOLD` — holding large artwork in RAM would defeat streaming it.

  This is *in addition to* the addon's own footprint, so budget roughly `baseline + POSTER_CACHE_MEMORY_SIZE`. **Set `0` to disable the tier** on memory-constrained hosts. The benefit is largest when the disk cache is too big for the OS page cache to absorb; if it already fits in free RAM, the OS is doing this for you.
- **Example**: `POSTER_CACHE_MEMORY_SIZE=512m` or `POSTER_CACHE_MEMORY_SIZE=0`

### `POSTER_CACHE_TTL_DAYS`
- **Default**: `30`
- **Description**: How long a cached image stays fresh, for any provider without a rule or a built-in policy. Re-evaluated on every read, so a change applies immediately — no migration or purge. Fractional values work (`0.5` = 12 hours); **`0` means never expire**, leaving images to be evicted for space (`POSTER_CACHE_MAX_SIZE`) or swept as unused (`POSTER_CACHE_INACTIVE_DAYS`).

  Expiry is not a re-download. Where the source sent an `ETag` or `Last-Modified`, the refetch is conditional and a `304` restarts the entry's validity without transferring the body (`X-Cache-Status: REVALIDATED`). If the source is unreachable the old bytes are still served (`X-Cache-Status: STALE`) rather than erroring. Clients are told what is left of the entry's validity, so a browser revalidates when the store does.

  > **Pointing a custom art URL pattern at a host the addon does not know?** Give its domain a rule. Such URLs usually name a *slot* rather than a file — `…/logo/medium/tt0055708/img` serves whatever the provider holds for that ID now — so the bytes change while the URL does not, and a stale rating or overlay sits there until this flat validity expires. Art read out of a metadata response mostly names a specific file and is safe here. The rating services the addon already knows need nothing from you; see [`POSTER_CACHE_PROVIDER_PRESETS`](#poster_cache_provider_presets).
- **Example**: `POSTER_CACHE_TTL_DAYS=7` or `POSTER_CACHE_TTL_DAYS=0`

### `POSTER_CACHE_INFER_TTL`
- **Default**: `false`
- **Description**: Derives an image's validity from the caching headers its source sent, instead of the flat setting above. Applies only to providers with **neither** a rule **nor** a built-in policy — every provider the addon knows already has one, so in practice this governs whatever you pointed a custom art URL pattern at. Where a source promises nothing usable, the flat value still applies.

  How a header is read:

  - A value is never raised. Two days stays two days, even where the flat default would have been thirty.
  - `Age` is subtracted — the promise was already running before the bytes arrived.
  - `CDN-Cache-Control` (RFC 9213) and `s-maxage` win over `max-age`, because both address shared caches and that is what the store is. Neither is ever used for the lifetime handed to a browser, so a provider can tell caches five minutes and browsers to revalidate every time, and both answers hold.
  - `max-age=0`, `no-cache`, or a spent window mean *revalidate before reuse*: the entry expires at once and every read becomes a conditional `GET`. With no validator to revalidate against that would be a full re-download per request, so inference declines and the flat default applies instead.
  - `no-store` is a refusal to be cached: the image is served but never written, any existing copy is dropped, and the client is told `no-store` too.
  - Where nothing is promised but a `Last-Modified` is present, RFC 9111's heuristic applies — 10% of how long the art has sat unchanged, and only for art at least 10 days old.

  Two cautions. RPDB, postersplus and MyAnimeList each advertise a validator and then answer `200` with a full body anyway, so an expiry there costs the whole image. And `Age` differs per CDN node, so one URL can land on different validities from different edges.

  This governs **stored** images only. A passed-through image already follows its provider, bounded by [`POSTER_PROXY_MAX_AGE_DAYS`](#poster_proxy_max_age_days).
- **Example**: `POSTER_CACHE_INFER_TTL=true`

### `POSTER_CACHE_PROVIDER_PRESETS`
- **Default**: `true`
- **Description**: Every provider the addon knows ships with a validity policy measured from what it actually sends, so a fresh install caches rating posters correctly with nothing configured. Each preset answers one question — **can this provider's own headers be believed?**

  Measured 2026-08-01 across ten assets per provider:

  | Provider | What it sends | Policy |
  | --- | --- | --- |
  | `api.ratingposterdb.com` | 1–2 days for a new release, 20–50 days once the rating settles | `infer` |
  | `btttr.cc` | 5 minutes where the overlay moves, up to 7 days where it does not | `infer` |
  | `extendedratings.com` | 20 minutes or 3 days, on the same split | `infer` |
  | `api.top-posters.com` | 6 hours, and answers `304` so an expiry is nearly free | `infer` |
  | `postersplus.elfhosted.com` | a flat 4 hours | `infer` |
  | `image.tmdb.org` | ~1 year, on art whose path changes when the picture does | `infer` |
  | `images.metahub.space` | 60 days — but addresses art by title | `default` |
  | `media.kitsu.app` | 1 year — but addresses art by title | `default` |
  | `artworks.thetvdb.com` | no cache directives at all | `default` |
  | `cdn.myanimelist.net` | 3.8 hours – 6.9 days, jittering per file; ignores conditional requests | `default` |
  | `assets.fanart.tv` | nothing, and no validator, on the largest bodies of any provider | `default` |

  The rating services vary their figure by how volatile each image is, which is why following them beats any fixed duration. The `default` half is what a global toggle could never express: following metahub would cache art addressed by title for 57 days — worse than the flat number, not better. These presets are what makes [`POSTER_CACHE_INFER_TTL`](#poster_cache_infer_ttl) safe to turn on.

  Resolved on every read and never stored, so turning this off applies immediately to images already cached. A rule always wins, so you only need this to go back to a single validity across every provider without one.
- **Example**: `POSTER_CACHE_PROVIDER_PRESETS=false`

### `POSTER_CACHE_PROVIDER_POLICIES`
- **Default**: unset — no rules, so each provider falls to its built-in policy, or to the flat validity if it has none
- **Description**: Overrides how **one provider's** images are cached, leaving every other provider alone. A JSON list of rules:

  ```json
  [{ "domain": "image.tmdb.org",      "policy": "infer" },
   { "domain": "extendedratings.com", "policy": "custom", "ttl": "6h" },
   { "domain": "some.broken.cdn",     "policy": "bypass" }]
  ```

  Four policies:

  | Policy | Meaning |
  | --- | --- |
  | `default` | The flat validity — `POSTER_CACHE_TTL_DAYS`. |
  | `infer` | Follow what that provider's own headers promise, exactly as `POSTER_CACHE_INFER_TTL` does globally. |
  | `custom` | A fixed duration given as `ttl`. Units are required: `30s`, `15m`, `12h`, `30d`, `2w`, `1y`. |
  | `bypass` | Serve the provider's images without ever storing them. |

  **These rules apply whether or not the built-in cache is on.** With it on, they decide how long an image is stored. With it off — or for a class you have not enabled — art still reaches the addon's `/poster-cache/proxy/…` routes when **Proxy Rating & Custom Art** is enabled, and the rule decides the `Cache-Control` those bytes are served with. That covers rating posters and custom art patterns; ordinary TMDB or TVDB art is handed to players by its own URL and never passes through here.

  A rule sets **one** lifetime for both audiences: it sends `Cache-Control` and no `CDN-Cache-Control`, so a CDN and a player both honour the same figure. The cost is that browser and player copies are pinned for the full duration and outlive a CDN purge — choose a lifetime you are willing to have clients keep.

  `bypass` on a passed-through provider sends `no-store` and stops forwarding the client's conditional request, so every fetch transfers a full body rather than revalidating. That is the point of declining to cache, but it is bandwidth you are choosing to spend.

  A rule outranks everything else, including a provider's built-in policy — so `default` pins one provider to the flat number while the global toggle is on. Matching is on the host in the cache key, so one rule covers that provider's posters, backgrounds, logos, thumbnails and processed art alike. A domain covers its subdomains (`elfhosted.com` matches `postersplus.elfhosted.com`), and where two rules match, the more specific wins regardless of order.

  You do not have to write this by hand: **Dashboard → Operations → Image Cache → Advanced…** edits the same setting. Malformed JSON is refused on save; a bad value reaching the engine another way is logged once and ignored, falling back to the flat validity.

  **`bypass` leaves whatever is already cached for that provider on disk** — saving a policy never deletes data as a side effect. Those entries are never read again and are swept after `POSTER_CACHE_INACTIVE_DAYS`. To reclaim the space now, purge the domain explicitly:

  ```
  POST /api/dashboard/poster-cache/purge   { "domain": "some.broken.cdn" }
  ```
- **Example**: `POSTER_CACHE_PROVIDER_POLICIES=[{"domain":"api.ratingposterdb.com","policy":"custom","ttl":"6h"}]`

### `POSTER_PROXY_MAX_AGE_DAYS`
- **Default**: `1`
- **Description**: The `Cache-Control: max-age` the proxy routes send to players and browsers. Applies whether or not the built-in cache is on. Fractional values work (`0.25` = 6 hours); `0` lifts the ceiling to a year, and anything below a minute is rounded up to one.

  - **Served from the cache**: the entry's own remaining validity, capped by this figure.
  - **Passed straight through**: this is a *ceiling* on what the provider asked for, and the figure sent outright when it asked for nothing. The addon is a plain proxy for those bytes, so the provider decides — its figure less the `Age` it arrived with, and its `no-store` / `no-cache` / `must-revalidate` relayed as sent. A per-provider rule or built-in policy overrides all of this outright; see [`POSTER_CACHE_PROVIDER_POLICIES`](#poster_cache_provider_policies).

  Both kinds carry a validator, so an unchanged image costs a bodyless `304`: a cached one uses the store's body hash, a passed-through one the origin's own `ETag`, with the client's conditional request relayed upstream.

  `stale-while-revalidate` is sent at the same figure as `max-age`. The direct route sends none and is not capped by this setting — it is addressed by the image URL, so a changed image is a changed request.
- **Example**: `POSTER_PROXY_MAX_AGE_DAYS=7` or `POSTER_PROXY_MAX_AGE_DAYS=0.25`

### `POSTER_PROXY_FOLLOW_UPSTREAM`
- **Default**: `false`
- **Description**: Forwards the provider's `Cache-Control` **verbatim** on passed-through images, with no floor or ceiling applied. Its `CDN-Cache-Control` travels with it, so a CDN in front of the addon gets the directive the provider addressed to it — btttr, for one, tells caches five minutes while telling browsers to revalidate every time. Affects the proxy routes only; a stored image is still advertised on its own remaining validity, and the addon has already consumed the targeted directive itself.

  You rarely need this. Passed-through images already follow their provider, bounded by [`POSTER_PROXY_MAX_AGE_DAYS`](#poster_proxy_max_age_days) — this only removes that bound. Think twice, because with it a provider sending `immutable` or a year-long `max-age` pins art in your CDN for exactly that long, and one that starts sending `no-store` makes your art uncacheable downstream without you changing anything. Where the provider sent no `Cache-Control`, the addon's own figure still applies.

  It also displaces the built-in provider policies on this path — turning it on is a decision to relay what the provider says, and a policy measured for you must not silently undo that. A rule in [`POSTER_CACHE_PROVIDER_POLICIES`](#poster_cache_provider_policies) still wins, and suppresses the relayed `CDN-Cache-Control` and `Age` along with it, so a CDN cannot be left on the provider's figure while a player is on yours.
- **Example**: `POSTER_PROXY_FOLLOW_UPSTREAM=true`

### `POSTER_CACHE_INACTIVE_DAYS`
- **Default**: `30`
- **Description**: Images not requested within this many days are swept hourly. Independent of `POSTER_CACHE_TTL_DAYS`: this one counts from the last *request*, the TTL from the last *fetch*. With validity now running to a year for most art, this is the mechanism that actually bounds what the cache keeps.
- **Example**: `POSTER_CACHE_INACTIVE_DAYS=14`

### `POSTER_CACHE_MAX_OBJECT_BYTES`
- **Default**: `20m`
- **Description**: Images larger than this are passed through to the client uncached (`X-Cache-Status: BYPASS`) rather than stored, so one oversized asset cannot consume the whole budget. Enforced from `Content-Length` where the upstream sends one, and while reading otherwise.
- **Example**: `POSTER_CACHE_MAX_OBJECT_BYTES=50m`

### `POSTER_CACHE_FETCH_CONCURRENCY`
- **Default**: `128`
- **Description**: Ceiling on simultaneous downloads of uncached images. Each in-flight fetch briefly holds a whole image in memory, so this bounds peak memory during a burst of misses. Requests for an image already being fetched are coalesced and take no slot. Lower it on memory-constrained hosts; raise it on a busy instance with a cold cache.
- **Example**: `POSTER_CACHE_FETCH_CONCURRENCY=32`

### `POSTER_CACHE_STREAM_THRESHOLD`
- **Default**: `256k`
- **Description**: Cached images larger than this are streamed from disk rather than read into memory, so a burst of concurrent hits on large artwork cannot pile whole images onto the heap. Smaller images take a faster single-read path.
- **Example**: `POSTER_CACHE_STREAM_THRESHOLD=512k`

### `POSTER_CACHE_AGENT_TTL_MS`
- **Default**: `60000`
- **Description**: How long a validated host's pinned IP addresses and pooled keep-alive connections are reused before it is re-resolved. Pooling avoids a DNS lookup and TLS handshake per cache-miss fetch; the TTL bounds how long a retired CDN address may still be dialed. Advanced tuning; the default suits almost everyone.
- **Example**: `POSTER_CACHE_AGENT_TTL_MS=30000`

### `POSTER_CACHE_AGENT_MAX`
- **Default**: `512`
- **Description**: Maximum number of distinct upstream hosts kept in the connection pool at once. Because the host is taken from the requested image URL, this bounds how much memory and how many open sockets the pool can hold. When the limit is reached the least-recently-added host is evicted and its sockets are closed. Advanced tuning.
- **Example**: `POSTER_CACHE_AGENT_MAX=256`

### `POSTER_CACHE_LOG_REQUESTS`
- **Default**: `false`
- **Description**: Logs every image request. Off by default: at a few thousand images per second it fills the shared log buffer within seconds and evicts everything else, exactly when you need those other logs. A one-line summary (`served N images (X% hit) …`) is written each minute regardless, and errors are always logged.
- **Example**: `POSTER_CACHE_LOG_REQUESTS=true`

### `POSTER_CACHE_DIR`
- **Default**: `addon/data/poster-cache`
- **Description**: Where cached images are stored. Requires a restart.
- **Example**: `POSTER_CACHE_DIR=/mnt/fast-disk/image-cache`

### `POSTER_CACHE_IMPORT_NGINX_DIR`
- **Default**: empty (auto-detect)
- **Description**: Source directory for the one-time import of a cache built by the old bundled nginx proxy, so upgrading does not discard a warm cache.

  **You normally do not need to set this.** On startup the addon looks in `/var/cache/nginx/posters`, then `/var/cache/nginx`, and imports what it finds — just leave that volume mounted for one start. A marker file records the result so it never runs twice, and unparseable files are skipped rather than imported as corrupt entries.

  Set a path only if your old cache lived somewhere non-standard, or `off` (also `false`/`none`/`0`) to skip the import entirely.
- **Example**: `POSTER_CACHE_IMPORT_NGINX_DIR=off`

### `POSTER_PROXY_PREFIX_URL`
- **Default**: empty
- **Description**: Public URL clients fetch images through. Leave empty when using the built-in cache — it derives `{HOST_NAME}/poster-cache` automatically. Set it only to point at an external caching proxy.
- **Example**: `POSTER_PROXY_PREFIX_URL=https://poster-cache.example.com`

### `POSTER_WARMUP_URL`
- **Default**: the built-in cache on `127.0.0.1`, else `POSTER_PROXY_PREFIX_URL`
- **Description**: Internal URL the catalog warmer issues HEAD requests against to pre-fill the cache.
- **Example**: `POSTER_WARMUP_URL=http://poster-cache:8888`

---

## Cache Epoch

### `CACHE_EPOCH`
- **Default**: `2` (compiled in as `DEFAULT_CACHE_EPOCH` in `addon/lib/cacheEpoch.ts`)
- **Description**: The invalidation lever for caches that hold payloads the addon assembles itself. It is deliberately **not** the addon version. Releases ship every few days, but the *shape* of a cached payload changes far less often, so keying caches on the release version discards good data on every upgrade — fatal for the cold store, whose TTLs run 60–180 days.

  The epoch is bumped by hand, in the same change that alters a payload shape. Anything stored under a lower epoch is dropped on the next start; anything stored under a *higher* one is left alone and simply not read, so rolling a release back and forward again costs nothing.

  Set this variable to force a rebuild without waiting for a release — for example after a bad deploy has written malformed metadata to disk. Values below `1` or non-numeric values are ignored and the compiled-in default is used.
- **Example**: `CACHE_EPOCH=3`

**What it covers.** Both cache tiers:

| Tier | Key shape | On an epoch bump |
|---|---|---|
| Redis (hot) | `e<N>:catalog:…`, `global:e<N>:…` | superseded keys swept at startup |
| Cold store (disk) | bare key + `epoch` column | older-epoch rows deleted at startup |

Provider-facing caches marked `upstream: true` — TMDB, Trakt, MDBList, Simkl, Jikan — carry no prefix at all and are never swept by an epoch bump. Most are verbatim provider responses whose shape is not ours to version. A minority (the Trakt and MDBList `{ items, totalItems, hasMore, totalPages }` pagination envelopes, and the TMDB genre lists) are shapes we assemble, and are exempted deliberately: their TTLs are short (6h–30d) and their shapes have been stable in production for over a year, so epoch coverage would cost refetches without buying much. If you change one of those shapes, purge the affected keys rather than relying on a `CACHE_EPOCH` bump to clear them.

Startup cleanup short-circuits when the stored epoch matches, so an ordinary release does not scan the keyspace. Keys from a *newer* epoch are left alone rather than deleted, so rolling a release back and then forward again costs nothing.

## Meta Cold Store

A durable on-disk L2 tier for metadata that provably never changes — old films, ended
or cancelled series, finished anime. Redis stays the hot L1; when a component is
evicted from Redis, the addon reads it back from disk instead of re-fetching from TMDB,
TVDB, TVMAZE, Kitsu, MAL or AniList.

Only titles that pass a stability classifier are written: the title must be
released/ended **and** have been so for longer than its settle window. Ongoing shows and
recent releases are never stored. Disk TTLs are finite by design, so a revived or
un-cancelled show eventually refreshes on its own.

### `META_COLD_STORE_ENABLED`
- **Default**: `false`
- **Description**: Master switch for the cold store. When off, there is zero behavior change — no disk file is opened and neither cache path is touched. Requires a restart.
- **Example**: `META_COLD_STORE_ENABLED=true`

### `META_COLD_STORE_PATH`
- **Default**: `addon/data/metacache.sqlite`
- **Description**: File path for the dedicated SQLite database. Deliberately separate from the operational `db.sqlite` — the cold store is disposable and can be deleted at any time; it rebuilds naturally. Mount it on a persistent volume to survive container restarts.
- **Example**: `META_COLD_STORE_PATH=/data/metacache.sqlite`

### `META_COLD_STORE_MAX_BYTES`
- **Default**: `2gb`
- **Description**: Disk budget for stored payloads. Once exceeded, least-recently-accessed rows are evicted until usage drops to 90% of the limit. Accepts nginx-style sizes (`512m`, `2gb`).
- **Example**: `META_COLD_STORE_MAX_BYTES=5gb`

### `META_COLD_STORE_COMPRESSION`
- **Default**: `true`
- **Description**: lz4-compress stored payloads. Measured on a live store, this roughly **halves** disk usage (11.8 MB → 6.5 MB), with the saving concentrated almost entirely in the two large components — `meta-cast` and `meta-links`. Everything else falls below the compression threshold and is stored as plain JSON regardless. Decompression is microseconds, so there is no meaningful read-path cost; the benefit is that roughly twice as many titles fit under `META_COLD_STORE_MAX_BYTES` before LRU eviction.

  **Safe to change at any time.** Entries are self-describing — each row records whether it is compressed — so toggling this needs no migration and no purge. Compressed and plain rows coexist in the same database and both decode correctly.

  Independent of the Redis-side `CACHE_COMPRESSION_ENABLED`; setting that to `false` no longer silently disables disk compression. The size threshold is still shared (`CACHE_COMPRESSION_MIN_BYTES`, default 2 KB).
- **Example**: `META_COLD_STORE_COMPRESSION=false`

### `COLD_TTL_FROZEN`
- **Default**: `180d`
- **Description**: Disk TTL for the `frozen` tier — titles whose end/release date is older than `FROZEN_AGE`. A 1970s film is safe to hold far longer than a series that ended last year.
- **Example**: `COLD_TTL_FROZEN=365d`

### `COLD_TTL_STABLE`
- **Default**: `60d`
- **Description**: Disk TTL for the `stable` tier — titles that are finished but more recently so. Shorter than the frozen TTL because late data corrections are more likely.
- **Example**: `COLD_TTL_STABLE=90d`

### `SETTLE_MOVIE`
- **Default**: `180d`
- **Description**: Minimum age since release before a movie becomes disk-eligible. Guards against caching a film while its metadata is still being corrected post-release.
- **Example**: `SETTLE_MOVIE=365d`

### `SETTLE_SERIES`
- **Default**: `90d`
- **Description**: Minimum age since the last aired episode before a series or anime becomes disk-eligible. Applies to TMDB, TVDB, TVMAZE, Kitsu, MAL and AniList alike.
- **Example**: `SETTLE_SERIES=180d`

### `FROZEN_AGE`
- **Default**: `2y`
- **Description**: Age threshold separating the `stable` and `frozen` tiers. Anything whose end/release date is older than this gets the longer `COLD_TTL_FROZEN`.
- **Example**: `FROZEN_AGE=5y`

### `COLD_STORE_INACTIVE_DAYS`
- **Default**: `30`
- **Description**: Drop rows that have not been read for this many days. Runs on an hourly sweep alongside hard-expiry cleanup, so the store tracks what is actually being requested.
- **Example**: `COLD_STORE_INACTIVE_DAYS=60`

### `IMAGE_WARM_QUEUE`
- **Default**: `true`
- **Description**: Warm images through a single bounded background queue shared by every catalog. Previously each catalog created its own unbounded promise chain, so the number of concurrent image fetches grew with the length of a warm run and a run got slower the longer it went. Set to `false` to disable image warming entirely; images are then cached on first request instead.

### `IMAGE_WARM_QUEUE_MAX`
- **Default**: `50000`
- **Description**: Maximum images waiting to be warmed. Beyond this, targets are dropped rather than queued — a dropped image is simply a cache miss the first time someone opens that title, whereas an unbounded backlog can never drain before the next warm cycle adds to it.
- **Example**: `IMAGE_WARM_QUEUE_MAX=20000`

### `IMAGE_WARM_CONCURRENCY_MIN` / `IMAGE_WARM_CONCURRENCY_MAX`
- **Defaults**: `4` / `48`
- **Description**: Bounds for the adaptive image warmer. It starts at the minimum and ramps toward the maximum while the event loop has headroom, halving back down when it does not. Raise the maximum on a fast box with spare cores; lower it if warming still competes with serving.

### `IMAGE_WARM_TARGET_LAG_MS`
- **Default**: `20`
- **Description**: The event-loop lag the image warmer aims to stay under. Above this it reduces concurrency, below half of it it speeds up. This is what keeps image warming from slowing catalog warming: catalog work and request serving share the same event loop, so the warmer yields as soon as that loop starts backing up.
- **Example**: `IMAGE_WARM_TARGET_LAG_MS=10`

### `COLD_STORE_STATS_TTL`
- **Default**: `30s`
- **Description**: How long the dashboard's cold-store size figures are reused before the store is recounted. The count is two aggregate scans over `meta_components`, and better-sqlite3 is synchronous, so each recount blocks the event loop for as long as it runs. Reusing the result keeps a polling dashboard from stalling the addon. A purge or sweep drops the cached figures immediately, so manual cache operations always show their effect. Set to `0` to recount on every request.
- **Example**: `COLD_STORE_STATS_TTL=2m`

### Admin endpoints

Both are guarded by `ADMIN_KEY` (via the `x-admin-key` header) when it is set:

```bash
curl -s http://localhost:3232/api/admin/cold-store/stats -H "x-admin-key: $ADMIN_KEY"
```

```bash
curl -s -X POST "http://localhost:3232/api/admin/cold-store/purge?metaId=tt0903747" -H "x-admin-key: $ADMIN_KEY"
```

Omit `metaId` from the purge call to drop the entire store. Cold-store hit and miss
counters are also reported by `getCacheHealth()` as `coldStoreHits` / `coldStoreMisses`.

---

## Example Configurations

### Minimal Setup (.env)
```bash
# Required
DATABASE_URL=postgresql://user:pass@localhost:5432/aiometadata
REDIS_URL=redis://localhost:6379
HOST_NAME=my-addon.com
TMDB_API_KEY=your_key_here

# Optional (but recommended)
TVDB_API_KEY=your_key_here

# Recommended
ADMIN_KEY=your_secure_random_key
```

### Production Setup (.env)
```bash
# Server
PORT=3232
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
TVDB_API_KEY=your_key_here  # Optional
FANART_API_KEY=your_key_here
MDBLIST_API_KEY=your_key_here
TRAKT_CLIENT_ID=your_key_here  # Optional
TRAKT_CLIENT_SECRET=your_key_here  # Optional
SIMKL_CLIENT_ID=your_key_here  # Optional
SIMKL_CLIENT_SECRET=your_key_here  # Optional

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
PORT=3232
HOST_NAME=my-addon.com
DATABASE_URL=sqlite:./data/aiometadata.db
REDIS_URL=redis://localhost:6379
TMDB_API_KEY=your_key_here
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
| Trakt | https://trakt.tv/oauth/applications | Yes | No |
| SimKL | https://simkl.com/oauth/applications | Yes | No |
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
