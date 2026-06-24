# ![AIOMETADATA](https://github.com/cedya77/aiometadata/blob/dev/public/logo.png) AIOMetadata: The Ultimate Stremio Metadata Addon

**AIOMetadata** is a next-generation, power-user-focused metadata addon for [Stremio](https://www.stremio.com/). It aggregates and enriches movie, series, and anime metadata from multiple sources (TMDB, TVDB, MyAnimeList, AniList, IMDb, TVmaze, Fanart.tv, MDBList, and more), giving you full control over catalog sources, artwork, and search.

---

## 🚀 Features

- **Multi-Source Metadata**: Choose your preferred provider for each type (movie, series, anime) — TMDB, TVDB, MAL, AniList, IMDb, TVmaze, etc.
- **Rich Artwork**: High-quality posters, backgrounds, and logos from TMDB, TVDB, Fanart.tv, AniList, and more, with language-aware selection and fallback.
- **Anime Power**: Deep anime support with MAL, AniList, Kitsu, AniDB, and TVDB/IMDb mapping, including studio, genre, decade, and schedule catalogs.
- **Custom Catalogs**: Add, reorder, and delete catalogs (including MDBList, streaming, and custom lists) in a sortable UI.
- **Streaming Catalogs**: Integrate streaming provider catalogs (Netflix, Disney+, etc.) with region and monetization filters.
- **Dynamic Search**: Enable/disable search engines per type (movie, series, anime) and use AI-powered search (Gemini) if desired.
- **User Config & Passwords**: Secure, per-user configuration with password and optional addon password protection. Trusted UUIDs for seamless re-login.
- **Global & Self-Healing Caching**: Redis-backed, ETag-aware, and self-healing cache for fast, reliable metadata and catalog responses.
- **Advanced ID Mapping**: Robust mapping between all major ID systems (MAL, TMDB, TVDB, IMDb, AniList, AniDB, Kitsu, TVmaze).
- **Modern UI**: Intuitive React/Next.js configuration interface with drag-and-drop, tooltips, and instant feedback.

---

## 🛠️ Installation

### 1. Hosted Instance

Visit your hosted instance's `/configure` page.  
Configure your catalogs, providers, and preferences.  
Save your config and install the generated Stremio addon URL.

### 2. Self-Hosting (Docker Compose)

```yaml
services:
  aiometadata:
    image: ghcr.io/cedya77/aiometadata:latest
    container_name: aiometadata
    restart: unless-stopped
    ports:
      - "3232:3232"  # Remove this if using Traefik
    # expose:  # Uncomment if using Traefik
    #   - 3232
    env_file:
      - .env
    # labels:  # Optional: Remove if not using Traefik
    #   - "traefik.enable=true"
    #   - "traefik.http.routers.aiometadata.rule=Host(`${AIOMETADATA_HOSTNAME?}`)"
    #   - "traefik.http.routers.aiometadata.entrypoints=websecure"
    #   - "traefik.http.routers.aiometadata.tls.certresolver=letsencrypt"
    #   - "traefik.http.routers.aiometadata.middlewares=authelia@docker"
    #   - "traefik.http.services.aiometadata.loadbalancer.server.port=3232"
    volumes:
      - ${DOCKER_DATA_DIR}/aiometadata/data:/app/addon/data
    depends_on:
      aiometadata_redis:
        condition: service_healthy
    tty: true
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3232/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  aiometadata_redis:
    image: redis:latest
    container_name: aiometadata_redis
    restart: unless-stopped
    volumes:
      - ${DOCKER_DATA_DIR}/aiometadata/cache:/data
    command: redis-server --appendonly yes --save 3600 1
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  #aiometadata_postgres:
  #  image: postgres:latest
  #  container_name: aiometadata_postgres
  #  restart: unless-stopped
  #  environment:
  #    - POSTGRES_DB=aiometadata
  #    - POSTGRES_USER=postgres
  #    - POSTGRES_PASSWORD=password
  #  volumes:
  #    - ${DOCKER_DATA_DIR}/aiometadata/postgres:/var/lib/postgresql/data
  #  healthcheck:
  #    test: ["CMD-SHELL", "pg_isready -U postgres -d aiometadata"]
  #    interval: 10s
  #    timeout: 5s
  #    retries: 5
```

Create a `.env` file with your API keys and settings as shown in [.env.example](.env.example) 

Then run:
```bash
docker compose up -d
```

### 3. Poster Reverse Proxy Cache (Optional)

Cache poster images locally using an nginx reverse proxy. Eliminates upstream latency on repeated requests and, combined with comprehensive cache warming, serves posters instantly from disk. Includes a `/stats` endpoint for monitoring cache size and image count.

#### Option A — Built-in (single container)

If you run a **single instance** and just want one container, enable the bundled proxy instead of running a separate service:

```yaml
  aiometadata:
    # ...your existing service...
    environment:
      - ENABLE_BUILTIN_POSTER_CACHE=true
      - POSTER_PROXY_PREFIX_URL=https://posters.example.com   # public address of port 8888
    volumes:
      - ${DOCKER_DATA_DIR}/poster-cache:/var/cache/nginx       # persist cache across restarts
    init: true                                                 # reap the proxy's helper processes
    expose:
      - "8888"
```

The same nginx config, `/stats`, and `/purge` apply. `POSTER_WARMUP_URL` defaults to `http://127.0.0.1:8888` automatically; you still set `POSTER_PROXY_PREFIX_URL` to the public address clients use to reach port 8888.

> **Multi-replica / Kubernetes:** leave `ENABLE_BUILTIN_POSTER_CACHE` off and use Option B — each replica's in-container cache is independent and unshared.

#### Option B — Standalone service

Add a `poster-cache` service alongside your aiometadata container:

```yaml
  poster-cache:
    image: nginx:alpine
    container_name: poster-cache
    restart: unless-stopped
    volumes:
      - ./poster-cache-nginx.conf:/etc/nginx/nginx.conf:ro
      - ./poster-cache-stats.sh:/stats.sh:ro
      - ./poster-cache-purge-handler.sh:/purge-handler.sh:ro
      - ${DOCKER_DATA_DIR}/poster-cache:/var/cache/nginx
    entrypoint: ["/bin/sh", "-c", "chown -R nginx:nginx /var/cache/nginx && nc -lk -p 9888 -e /purge-handler.sh & /stats.sh & exec nginx -g 'daemon off;'"]
    expose:
      - "8888"
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.poster-cache.rule=Host(`poster-cache.example.com`)"
      - "traefik.http.routers.poster-cache.entrypoints=websecure"
      - "traefik.http.routers.poster-cache.tls.certresolver=letsencrypt"
      - "traefik.http.services.poster-cache.loadbalancer.server.port=8888"
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:8888/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

Save the following as `poster-cache-nginx.conf` next to your `docker-compose.yml`:

```nginx
user nginx;
worker_processes auto;

events {
    worker_connections 1024;
}

http {
    # Cache storage on disk — adjust max_size to suit available space
    proxy_cache_path /var/cache/nginx/posters
                     levels=1:2
                     keys_zone=poster_cache:10m
                     max_size=10g
                     inactive=30d
                     use_temp_path=off;

    # Restore double-slash after scheme when a reverse proxy (e.g. Traefik)
    # collapses "https://" to "https:/".
    # Input:  /https:/api.example.com/path  ->  https://api.example.com/path
    # Input:  /https://api.example.com/path ->  https://api.example.com/path
    map $request_uri $upstream_url {
        ~^/(https?):/([^/].*)$  $1://$2;
        ~^/(https?://.*)$       $1;
        default                 "";
    }

    # Extract scheme + host from the upstream URL for resolving relative redirects
    map $upstream_url $upstream_origin {
        ~^(https?://[^/]+)  $1;
        default             "";
    }

    log_format cache '$remote_addr - [$time_local] "$request" $status '
                     '$body_bytes_sent $upstream_cache_status';
    access_log /var/log/nginx/access.log cache;

    server {
        listen 8888;

        location = /health {
            access_log off;
            return 200 'ok';
        }

        location = /stats {
            access_log off;
            default_type application/json;
            alias /tmp/cache-stats.json;
        }

        location = /purge {
            access_log off;
            default_type application/json;
            proxy_pass http://127.0.0.1:9888;
        }

        location / {
            resolver 127.0.0.11 valid=30s ipv6=off;

            if ($upstream_url = "") {
                return 400;
            }

            proxy_pass $upstream_url;
            proxy_ssl_server_name on;

            # Rewrite relative upstream redirects into absolute URLs.
            # Some upstreams (e.g. openposterdb) return relative 302 Location headers
            # like "/c/abc/path" which the client would resolve against the proxy host.
            # This rewrites them to point to the actual upstream origin.
            #   e.g. Location: /c/abc/path → Location: https://openposterdb.com/c/abc/path
            proxy_redirect / $upstream_origin/;

            proxy_cache poster_cache;
            proxy_cache_key $upstream_url;
            proxy_cache_valid 200 30d;
            proxy_ignore_headers Cache-Control Expires Vary;
            proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
            proxy_cache_lock on;

            add_header X-Cache-Status $upstream_cache_status;

            proxy_set_header Host $proxy_host;
            proxy_set_header Accept-Encoding "";
        }
    }
}
```

Save the following as `poster-cache-stats.sh` next to your `docker-compose.yml`:

```sh
#!/bin/sh
# Periodically writes cache stats to a JSON file served by nginx
CACHE_DIR="/var/cache/nginx/posters"
STATS_FILE="/tmp/cache-stats.json"
MAX_SIZE="${POSTER_CACHE_MAX_SIZE:-10g}"
INACTIVE="${POSTER_CACHE_INACTIVE:-30d}"

while true; do
  if [ -d "$CACHE_DIR" ]; then
    size_bytes=$(du -sb "$CACHE_DIR" 2>/dev/null | cut -f1)
    file_count=$(find "$CACHE_DIR" -type f 2>/dev/null | wc -l)
    size_human=$(awk "BEGIN {
      b = ${size_bytes:-0};
      if (b >= 1000000000) printf \"%.1fG\", b/1000000000;
      else if (b >= 1000000) printf \"%.1fM\", b/1000000;
      else if (b >= 1000) printf \"%.1fK\", b/1000;
      else printf \"%dB\", b;
    }")
  else
    size_bytes=0
    size_human="0B"
    file_count=0
  fi

  # Check for purge flag
  if [ -f /tmp/purge-cache ]; then
    rm -f /tmp/purge-cache
    rm -rf "$CACHE_DIR"
    mkdir -p "$CACHE_DIR"
    chown nginx:nginx "$CACHE_DIR"
    size_bytes=0
    size_human="0B"
    file_count=0
  fi

  cat > "$STATS_FILE" <<EOF
{"cached_images":${file_count},"disk_usage":"${size_human}","disk_usage_bytes":${size_bytes},"max_size":"${MAX_SIZE}","inactive":"${INACTIVE}"}
EOF
  sleep 30
done
```

Save the following as `poster-cache-purge-handler.sh` next to your `docker-compose.yml`:

```sh
#!/bin/sh
# HTTP handler for /purge — called by nc -lk -e
read -r method path _
# Consume remaining headers
while read -r line; do
  line=$(printf '%s' "$line" | tr -d '\r\n')
  [ -z "$line" ] && break
done

touch /tmp/purge-cache
BODY='{"success":true,"message":"cache purge scheduled"}'
printf "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s" ${#BODY} "$BODY"
```

Make both scripts executable:

```bash
chmod +x poster-cache-stats.sh poster-cache-purge-handler.sh
```

Then set these environment variables on the aiometadata service:

| Variable | Description | Example |
|----------|-------------|---------|
| `DOCKER_DATA_DIR` | Base directory for persistent Docker data | `/opt/docker/data` |
| `POSTER_PROXY_PREFIX_URL` | Public HTTPS URL for the proxy (used in responses so Stremio fetches through it) | `https://poster-cache.example.com` |
| `POSTER_WARMUP_URL` | Internal Docker URL for server-side warming (optional, falls back to `POSTER_PROXY_PREFIX_URL`) | `http://poster-cache:8888` |
| `POSTER_WARMUP_DELAY_MS` | Delay between poster warm batches during warming (default `50`) | `50` |
| `POSTER_WARMUP_CONCURRENCY` | Number of concurrent poster warm requests per batch (default `1`) | `5` |

If you're not using Traefik, remove the labels, expose port 8888 directly, and set `POSTER_PROXY_PREFIX_URL` to wherever your proxy is publicly accessible.

### 4. Self-Hosted Jikan API (Optional — Anime Source)

Anime metadata is sourced from [MyAnimeList](https://myanimelist.net/) via the [Jikan](https://jikan.moe/) API. By default the addon uses the public instance (`https://api.jikan.moe/v4`), but **the public Jikan API is shutting down on October 1, 2026** (brownout from September 1). To keep anime metadata working, run your own Jikan instance and point the addon at it with a single environment variable:

```env
JIKAN_API_BASE=http://jikan_rest:8080/v4
```

Set this on the `aiometadata` service (in its `.env`). When both containers share a Docker network, the addon reaches Jikan by container name — no public exposure needed.

#### Compose stack

Jikan needs four services (MongoDB stores data, Redis caches, Typesense powers search). Save as `apps/jikan-rest/compose.yaml` (or merge into your stack):

```yaml
secrets:
  jikan_db_username:       { file: ./secrets/db_username.txt }
  jikan_db_password:       { file: ./secrets/db_password.txt }
  jikan_db_admin_username: { file: ./secrets/db_admin_username.txt }
  jikan_db_admin_password: { file: ./secrets/db_admin_password.txt }
  jikan_redis_password:    { file: ./secrets/redis_password.txt }
  jikan_typesense_api_key: { file: ./secrets/typesense_api_key.txt }

services:
  jikan_rest:
    image: docker.io/jikanme/jikan-rest:latest
    container_name: jikan_rest
    hostname: jikan-rest-api
    user: "10001:10001"
    restart: unless-stopped
    env_file: [ .env.compose ]
    secrets: [ jikan_db_username, jikan_db_password, jikan_redis_password, jikan_typesense_api_key ]
    expose: [ 8080 ]
    healthcheck:
      test: ["CMD-SHELL", "wget --spider -q 'http://127.0.0.1:2114/health?plugin=http'"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    depends_on:
      jikan_mongo:     { condition: service_healthy }
      jikan_redis:     { condition: service_healthy }
      jikan_typesense: { condition: service_started }

  jikan_mongo:
    image: docker.io/mongo:focal
    container_name: jikan_mongo
    hostname: jikan_mongo
    restart: unless-stopped
    command: "--wiredTigerCacheSizeGB 0.5"
    secrets: [ jikan_db_username, jikan_db_password, jikan_db_admin_username, jikan_db_admin_password ]
    environment:
      MONGO_INITDB_ROOT_USERNAME_FILE: /run/secrets/jikan_db_admin_username
      MONGO_INITDB_ROOT_PASSWORD_FILE: /run/secrets/jikan_db_admin_password
      MONGO_INITDB_DATABASE: jikan_admin
    volumes:
      - ${DOCKER_DATA_DIR}/jikan-rest/mongo:/data/db
      - ./mongo-init.js:/docker-entrypoint-initdb.d/mongo-init.js:ro
    healthcheck:
      test: ["CMD-SHELL", "mongosh mongodb://localhost:27017 --quiet --eval 'db.runCommand(\"ping\").ok'"]
      interval: 30s
      timeout: 10s
      retries: 5

  jikan_redis:
    image: docker.io/redis:6-alpine
    container_name: jikan_redis
    hostname: jikan_redis
    restart: unless-stopped
    secrets: [ jikan_redis_password ]
    command: ["/bin/sh", "-c", "redis-server --requirepass \"$$(cat /run/secrets/jikan_redis_password)\" --appendonly yes"]
    volumes:
      - ${DOCKER_DATA_DIR}/jikan-rest/redis:/data
    healthcheck:
      test: ["CMD-SHELL", "redis-cli -a \"$$(cat /run/secrets/jikan_redis_password)\" ping | grep -q PONG"]
      interval: 10s
      timeout: 5s
      retries: 5

  jikan_typesense:
    image: docker.io/typesense/typesense:0.24.1
    container_name: jikan_typesense
    hostname: jikan_typesense
    restart: unless-stopped
    entrypoint: /bin/sh
    secrets: [ jikan_typesense_api_key ]
    command: ["-c", "TYPESENSE_API_KEY=\"$$(cat /run/secrets/jikan_typesense_api_key)\" /opt/typesense-server --data-dir /data"]
    volumes:
      - ${DOCKER_DATA_DIR}/jikan-rest/typesense:/data
```

Save the container config as `apps/jikan-rest/.env.compose`:

```env
APP_DEBUG=false
LOG_LEVEL=info
APP_ENV=production
# Indexers self-call the API; must point at RoadRunner's port (8080), NOT the default port 80
APP_URL=http://127.0.0.1:8080
CACHING=true
CACHE_DRIVER=redis
REDIS_HOST=jikan_redis
REDIS_PASSWORD__FILE=/run/secrets/jikan_redis_password
DB_CONNECTION=mongodb
DB_HOST=jikan_mongo
DB_DATABASE=jikan
DB_USERNAME__FILE=/run/secrets/jikan_db_username
DB_ADMIN__FILE=/run/secrets/jikan_db_username
DB_PASSWORD__FILE=/run/secrets/jikan_db_password
SCOUT_DRIVER=typesense
SCOUT_QUEUE=false
TYPESENSE_HOST=jikan_typesense
TYPESENSE_PORT=8108
TYPESENSE_API_KEY__FILE=/run/secrets/jikan_typesense_api_key
CORS_MIDDLEWARE=true
MICROCACHING=true
MICROCACHING_EXPIRE=60
```

Save the MongoDB init script as `apps/jikan-rest/mongo-init.js`:

```js
const userToCreate = fs.readFileSync('/run/secrets/jikan_db_username', 'utf8');
const userPassword = fs.readFileSync('/run/secrets/jikan_db_password', 'utf8');
db = db.getSiblingDB("admin");
db.createUser({ user: userToCreate, pwd: userPassword, roles: [{ role: "readWrite", db: "jikan" }] });
db = db.getSiblingDB("jikan");
db.createUser({ user: userToCreate, pwd: userPassword, roles: [{ role: "readWrite", db: "jikan" }] });
```

Generate the secret files (note the `chmod 644` — Mongo and the app run as non-root and must be able to read the bind-mounted secrets):

```bash
cd apps/jikan-rest && mkdir -p secrets
echo -n "jikan"        > secrets/db_username.txt
echo -n "jikanadmin"   > secrets/db_admin_username.txt
openssl rand -hex 24   > secrets/db_password.txt
openssl rand -hex 24   > secrets/db_admin_password.txt
openssl rand -hex 24   > secrets/redis_password.txt
openssl rand -hex 24   > secrets/typesense_api_key.txt
chmod 644 secrets/*.txt
```

Then start it: `docker compose up -d`

#### Seeding the index

Direct lookups (e.g. `/v4/anime/1`) work immediately by scraping MAL on demand. But **search, `seasons`, `top`, and genre catalogs are served from Jikan's own database, which starts empty** and must be populated. Run the indexers (they scrape MAL and are rate-limited):

```bash
# Fast metadata
docker exec jikan_rest php artisan indexer:genres
docker exec jikan_rest php artisan indexer:producers
docker exec jikan_rest php artisan indexer:anime-current-season
docker exec jikan_rest php artisan indexer:anime-schedule

# Full catalog (~30k anime — runs for hours; --delay is seconds between requests, default 3)
docker exec -d jikan_rest sh -c 'php artisan indexer:anime --delay=1 >> /tmp/indexer-anime.log 2>&1'
```

Lower `--delay` speeds it up but increases the risk of MyAnimeList rate-limiting your IP. The container self-runs a scheduler that keeps data fresh after the initial seed. Check progress with `docker exec jikan_rest tail -f /tmp/indexer-anime.log`.

#### Optional: worker-leak mitigation

The bundled RoadRunner app server can accumulate CPU/memory over time. To recycle workers gracefully (no restart needed), mount a custom `.rr.yaml` over `/app/.rr.yaml` that adds lifecycle limits — give the queue worker `queue:work --max-time=3600 --max-jobs=1000 --memory=256`, set the HTTP pool `supervisor.ttl: 3600s`, and cap `num_workers`. Add `- ./rr.yaml:/app/.rr.yaml:ro` to the `jikan_rest` volumes.

---

## ⚙️ Configuration

- **Catalogs**: Add, remove, and reorder catalogs (TMDB, TVDB, MAL, AniList, MDBList, streaming, etc.).
- **Providers**: Set preferred metadata and artwork provider for each type.
- **Search**: Enable/disable search engines per type; enable AI search with Gemini API key.
- **Integrations**: Connect MDBList and more for personal lists.
- **Security**: Set user and (optional) addon password for config protection.

All configuration is managed via the `/configure` UI and saved per-user (UUID) in the database.

---

## 🔌 API & Endpoints

- `/stremio/:userUUID/:compressedConfig/manifest.json` — Stremio manifest (per-user config)
- `/api/config/save` — Save user config (POST)
- `/api/config/load/:userUUID` — Load user config (POST)
- `/api/config/update/:userUUID` — Update user config (PUT)
- `/api/config/is-trusted/:uuid` — Check if UUID is trusted (GET)
- `/api/cache/*` — Cache health and admin endpoints
- `/poster/:type/:id` — Poster proxy with fallback and RPDB support
- `/resize-image` — Image resize proxy
- `/api/image/blur` — Image blur proxy

---

## 🧩 Supported Providers

- **Movies/Series**: TMDB, TVDB, IMDb, TVmaze
- **Anime**: MyAnimeList (MAL), AniList, Kitsu, AniDB, TVDB, IMDb
- **Artwork**: TMDB, TVDB, Fanart.tv, AniList, RPDB
- **Personal Lists**: MDBList, MAL, AniList
- **Streaming**: Netflix, Disney+, Amazon, and more (via TMDB watch providers)

---

## 🧑‍💻 Development

```bash
# Backend
npm run dev:server

# Frontend
npm run dev
```

- Edit `/addon` for backend, `/configure` for frontend.
- Uses Redis for caching, SQLite/PostgreSQL for config storage.

---

## 🤝 Contributing

We welcome community contributions! However, to keep review times manageable, we have specific guidelines. **Please read the [CONTRIBUTING.md](docs/contributing.md) guide before opening issues or pull requests.**

---

## 📄 License

GPL-3.0 — see [LICENSE](LICENSE).

---

## 🙏 Credits

- [Stremio](https://www.stremio.com/)
- [TMDB](https://www.themoviedb.org/)
- [TVDB](https://thetvdb.com/)
- [MyAnimeList](https://myanimelist.net/)
- [AniList](https://anilist.co/)
- [Fanart.tv](https://fanart.tv/)
- [MDBList](https://mdblist.com/)
- [RPDB](https://rpdb.net/)

**Special thanks to [MrCanelas](https://github.com/mrcanelas), the original developer of the TMDB Addon for Stremio, whose work inspired and laid the groundwork for this project.**

---

## ⚠️ Disclaimer

This addon aggregates metadata from third-party sources. Data accuracy and availability are not guaranteed.



 
