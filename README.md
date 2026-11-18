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
    init: true
    env_file:
      - .env
    # labels:  # Optional: Remove if not using Traefik
    #   - "traefik.enable=true"
    #   - "traefik.http.routers.aiometadata.rule=Host(`${AIOMETADATA_HOSTNAME?}`)"
    #   - "traefik.http.routers.aiometadata.entrypoints=websecure"
    #   - "traefik.http.routers.aiometadata.tls.certresolver=letsencrypt"
    #   - "traefik.http.routers.aiometadata.middlewares=authelia@docker"
    #   - "traefik.http.services.aiometadata.loadbalancer.server.port=3232"
    #   - "traefik.http.routers.aiometadata.service=aiometadata"
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

### 3. Optional add-ons

Three optional pieces of infrastructure have guides of their own, since none is needed to run the addon:

- **[Image Cache](docs/image-cache.md)** — serve artwork from disk instead of re-fetching it upstream.
- **[Self-Hosted Jikan API](docs/self-hosted-jikan.md)** — run your own anime metadata source. The public Jikan API has shut down; the addon defaults to the public Tenrai API, and your own instance gives more headroom.
- **[LumiereDB](docs/lumiere-db.md)** — a self-hosted IMDb database that adds LumiereDB search, people search, and Popular and Trending catalogs for movies and series.

### 4. Sign-in with an identity provider (Optional)

Let people sign in with an existing account instead of a UUID and password, and reach their saved configurations from the list. See **[Sign-in with an identity provider](docs/sso.md)**.

### 5. Jellyfin server (Optional)

Present a configuration as a Jellyfin server, so Jellyfin clients browse your catalogs and collections, play through your stream addon and keep Continue Watching, Next Up and watched state in step with your trackers. See **[Jellyfin server](docs/jellyfin.md)**.


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

## 📋 Operator obligations

The license of this code does not cover the data it fetches. Whoever runs an
instance is bound by the terms of every provider it talks to, and is the API
licensee for any server-wide keys it configures (the `BUILT_IN_*_API_KEY`
settings serve every user of that instance under the operator's account).

The main obligations, as published on 14 Nov 2026 (details, sources and the
providers not covered here are in [docs/provider-terms.md](docs/provider-terms.md)):

- **Commercial use is not allowed** by TMDB's standard license (a written
  agreement with TMDB is required) or by the IMDb datasets, which are for
  personal and non-commercial use only.
- **Commercial use needs a license above $150/month** of revenue on Simkl and
  AniList, and **written authorization** on MyAnimeList's official API.
- **Scraping:** Letterboxd's terms prohibit automated extraction, and Jikan
  scrapes MyAnimeList, whose agreement prohibits scraping. A commercial
  instance should get permission or switch these off (`JIKAN_ENABLED=false`).
- **Attribution shown to users:** the configure page's About dialog (click
  the version number) shows what each provider asks for: TMDB's logo and
  notice (also below), TheTVDB with a link, a "not endorsed by Trakt" line, a
  visible Simkl link, and a credit to TVmaze, whose data is CC BY-SA 4.0.
- **Caching:** TMDB content may be cached for at most 6 months, including in
  the meta cold store and the image cache.
- **AI providers:** Gemini and OpenRouter users must be 18 or older. Only the
  paid Gemini tier may serve users in the EEA, UK and Switzerland. OpenRouter
  forbids reselling model access.

### TMDB attribution

<img src="public/tmdb_icon.png" alt="TMDB" height="24">

This product uses TMDB and the TMDB APIs but is not endorsed, certified, or
otherwise approved by TMDB.

---

## 📄 License

AIOMetadata v4 is source-available. The core is under the
[GNU AGPL-3.0-or-later](LICENSE), with an additional permission that lets it be
combined with the v4 feature modules. The feature modules (the Jellyfin server,
the trackers and the dashboard) are under the
[Functional Source License 1.1, ALv2 Future License](LICENSE-FSL.md). Each
release of them becomes Apache-2.0 two years after it is published.

In short: running it for yourself, your household or your organization is
fine, and so is modifying it. Offering v4 as a commercial hosted service is
not, until the release you run turns Apache-2.0. v3.9.0 and earlier keep the
GPL-3.0 they were released under.

[LICENSING.md](LICENSING.md) says which files are under which license and
answers common questions. [NOTICE](NOTICE) carries the notices for earlier and
bundled work, and [TRADEMARKS.md](TRADEMARKS.md) covers the name and logo.

---

## 💖 Sponsors

Thanks to the sponsors who support AIOMetadata's development:

- [ElfHosted](https://elfhosted.com/)

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
