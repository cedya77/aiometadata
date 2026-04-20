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

Add a `poster-cache` service alongside your aiometadata container:

```yaml
  poster-cache:
    image: nginx:alpine
    container_name: poster-cache
    restart: unless-stopped
    volumes:
      - ./poster-cache-nginx.conf:/etc/nginx/nginx.conf:ro
      - ./poster-cache-stats.sh:/stats.sh:ro
      - ${DOCKER_DATA_DIR}/poster-cache:/var/cache/nginx
    entrypoint: ["/bin/sh", "-c", "/stats.sh & exec nginx -g 'daemon off;'"]
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

while true; do
  if [ -d "$CACHE_DIR" ]; then
    size_bytes=$(du -sb "$CACHE_DIR" 2>/dev/null | cut -f1)
    size_human=$(du -sh "$CACHE_DIR" 2>/dev/null | cut -f1)
    file_count=$(find "$CACHE_DIR" -type f 2>/dev/null | wc -l)
  else
    size_bytes=0
    size_human="0"
    file_count=0
  fi
  cat > "$STATS_FILE" <<EOF
{"cached_images":${file_count},"disk_usage":"${size_human}","disk_usage_bytes":${size_bytes},"max_size":"10g","inactive":"30d"}
EOF
  sleep 30
done
```

Make the stats script executable:

```bash
chmod +x poster-cache-stats.sh
```

Then set these environment variables on the aiometadata service:

| Variable | Description | Example |
|----------|-------------|---------|
| `DOCKER_DATA_DIR` | Base directory for persistent Docker data | `/opt/docker/data` |
| `POSTER_PROXY_PREFIX_URL` | Public HTTPS URL for the proxy (used in responses so Stremio fetches through it) | `https://poster-cache.example.com` |
| `POSTER_WARMUP_URL` | Internal Docker URL for server-side warming (optional, falls back to `POSTER_PROXY_PREFIX_URL`) | `http://poster-cache:8888` |
| `POSTER_WARMUP_DELAY_MS` | Delay between poster HEAD requests during warming (default `50`) | `50` |

If you're not using Traefik, remove the labels, expose port 8888 directly, and set `POSTER_PROXY_PREFIX_URL` to wherever your proxy is publicly accessible.

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

We welcome community contributions! However, to keep review times manageable, we have specific guidelines. **Please read the [CONTRIBUTING.md](docs/CONTRIBUTING.md) guide before opening issues or pull requests.**

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



 
