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
    environment:
      - PORT=3232
      - TMDB_API=${TMDB_API_KEY?}
      - TVDB_API_KEY=${TVDB_API_KEY?}
      - FANART_API_KEY=${FANART_API_KEY?}
      - MDBLIST_API_KEY=${MDBLIST_API_KEY?}
      - RPDB_API_KEY=${RPDB_API_KEY?}
      - HOST_NAME=${AIOMETADATA_HOSTNAME?}
      - REDIS_URL=redis://aiometadata_redis:6379
      - META_TTL=604800
      - CATALOG_TTL=86400
      - CATALOG_LIST_ITEMS_SIZE=20
      - NO_CACHE=false
      - LOG_LEVEL=debug
      - ADMIN_KEY=${ADMIN_KEY?}
      - TMDB_SOCKS_PROXY_URL=${TMDB_SOCKS_PROXY_URL?}
      - DATABASE_URI=sqlite://addon/data/db.sqlite
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

  aiometadata_redis:
    image: redis:latest
    container_name: aiometadata_redis
    restart: unless-stopped
    volumes:
      - ${DOCKER_DATA_DIR}/aiometadata/cache:/data
    command: redis-server --appendonly yes --save 60 1
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

Create a `.env` file with your API keys and settings:

```bash
# Required API Keys
TMDB_API_KEY=your_tmdb_api_key
TVDB_API_KEY=your_tvdb_api_key
FANART_API_KEY=your_fanart_api_key
MDBLIST_API_KEY=your_mdblist_api_key
RPDB_API_KEY=your_rpdb_api_key

# Host Configuration
AIOMETADATA_HOSTNAME=aiometadata.yourdomain.com
ADMIN_KEY=your_secure_admin_key

# Optional
TMDB_SOCKS_PROXY_URL=your_socks_proxy_url
DOCKER_DATA_DIR=/opt/docker

# Cache Warming (Optional)
# Dedicated TMDB API key for background cache warming of popular/trending content
# This helps improve performance by pre-caching frequently accessed items
BUILT_IN_TMDB_API_KEY=your_dedicated_tmdb_api_key
BUILT_IN_TVDB_API_KEY=your_dedicated_tmdb_api_key
```

Then run:
```bash
docker compose up -d
```

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

## 📄 License

Apache 2.0 — see [LICENSE](LICENSE).

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



 
