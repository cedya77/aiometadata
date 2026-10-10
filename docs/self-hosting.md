# Self-Hosting Guide

This guide provides instructions for self-hosting the TMDB Addon for Stremio.

## Table of Contents
- [Self-Hosting Guide](#self-hosting-guide)
  - [Table of Contents](#table-of-contents)
  - [Requirements](#requirements)
  - [Docker Installation (Recommended)](#docker-installation-recommended)
    - [Using Docker Compose](#using-docker-compose)
  - [Manual Installation](#manual-installation)
  - [Environment Variables](#environment-variables)
  - [Getting API Keys](#getting-api-keys)
    - [TMDB API](#tmdb-api)
    - [Fanart.tv API](#fanarttv-api)
    - [MongoDB](#mongodb)
  - [Verifying Installation](#verifying-installation)
  - [Troubleshooting](#troubleshooting)
    - [Common Issues](#common-issues)

## Requirements

**Redis 8.0 or newer.** Each title's metadata is kept in one Redis hash whose
fields expire individually, which needs `HSETEX` (Redis 8.0) and `HTTL`
(Redis 7.4). The server asks Redis for those commands on startup and refuses to
boot without them, naming the version it found. The `redis:latest` image is new
enough; pin `redis:8` if you would rather name a major.

On startup the addon also sets a few of the Redis server's own options
(eviction policy, lazy-free, defragmentation) to suit how it uses the cache.
Set `REDIS_AUTOTUNE=false` to leave them alone, which is what to do when Redis
is shared with other applications. See
[`REDIS_AUTOTUNE`](ENVIRONMENT_VARIABLES.md#redis_autotune).

## Docker Installation (Recommended)

The easiest way to run this addon is using Docker. The image is available on Docker Hub.

```bash
docker run -d \
  --name tmdb-addon \
  -p 3232:3232 \
  -e MONGODB_URI=your_mongodb_uri \
  -e FANART_API=your_fanart_key \
  -e TMDB_API_KEY=your_tmdb_key \
  -e RPDB_API_KEY=your_rpdb_key \
  -e HOST_NAME=http://your_domain:3232 \
  mrcanelas/tmdb-addon:latest
```

### Using Docker Compose

Create a `docker-compose.yml` file:

```yaml
version: '3'
services:
  tmdb-addon:
    image: mrcanelas/tmdb-addon:latest
    container_name: tmdb-addon
    ports:
      - "3232:3232"
    environment:
      - MONGODB_URI=your_mongodb_uri
      - FANART_API=your_fanart_key
      - TMDB_API_KEY=your_tmdb_key
      - RPDB_API_KEY=your_rpdb_key
      - HOST_NAME=http://your_domain:3232
    restart: unless-stopped
```

Then run:
```bash
docker-compose up -d
```

## Manual Installation

1. Clone the repository:
```bash
git clone https://github.com/mrcanelas/tmdb-addon.git
cd tmdb-addon
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
   - Copy `.env.example` to `.env`
   - Fill in the required variables in the `.env` file

4. Build the project:
```bash
npm run build
```

5. Start the server:
```bash
node addon/server.js
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `MONGODB_URI` | MongoDB connection URI | Yes |
| `BUILT_IN_TMDB_API_KEY` | TMDB key kept on the server, used for users with no key of their own | No |
| `BUILT_IN_TVDB_API_KEY` | TVDB key kept on the server | No |
| `BUILT_IN_FANART_API_KEY` | Fanart.tv key kept on the server | No |
| `BUILT_IN_RPDB_API_KEY` | RPDB key kept on the server | No |
| `FANART_API` | Fanart.tv API key, published to the browser | Yes |
| `TMDB_API_KEY` | TMDB API key, published to the browser (legacy: `TMDB_API` also supported) | Yes |
| `RPDB_API_KEY` | RPDB API key, published to the browser | No |
| `HOST_NAME` | Public URL of your addon (e.g., http://your_domain:3232) | Yes |
| `PORT` | Server port (default: 3232) | No |

> **Running this for other people?** Use the `BUILT_IN_*` keys. They cover any user
> who brings no key of their own and are never sent to the browser.
>
> `TMDB_API_KEY`, `TVDB_API_KEY`, `FANART_API_KEY`, `RPDB_API_KEY`, `MDBLIST_API_KEY`
> and `GEMINI_API_KEY` are served to every visitor by `/api/config` so the configure
> page can prefill them, and that path stays open even with `AUTH_REQUIRE_SIGNIN=true`.
> (`TRAKT_CLIENT_ID` and `SIMKL_CLIENT_ID` are in there too, which is fine: OAuth
> client ids are public by design and their secrets are not published.) See
> [Environment Variables](ENVIRONMENT_VARIABLES.md#api-keys).

> **Connecting SimKL without a public URL?** The configure page can show a short
> code to enter at https://simkl.com/pin, and the server polls SimKL for the token.
> Only `SIMKL_CLIENT_ID` is required, no client secret and no inbound callback to
> your instance. For a private instance:
>
> ```
> SIMKL_CLIENT_ID=your_client_id
> SIMKL_AUTH_MODE=pin
> ```
>
> `pin` is already the default when no `SIMKL_CLIENT_SECRET` is set, but setting it
> explicitly keeps the flow from switching back to OAuth if a secret is ever added.
> See [`SIMKL_AUTH_MODE`](ENVIRONMENT_VARIABLES.md#simkl_auth_mode).

## Getting API Keys

### TMDB API
1. Visit [TMDB Developer](https://www.themoviedb.org/settings/api)
2. Create an account if you don't have one
3. Request an API key
4. Use the API Read Access Token (v4 auth)

### Fanart.tv API
1. Visit [Fanart.tv API](https://fanart.tv/get-an-api-key/)
2. Register for an account
3. Request a personal API key

### RPDB API
1. Visit [RPDB](https://ratingposterdb.com/)
2. Register for an account
3. Request an API key

### MongoDB
1. Create an account on [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)
2. Set up a free cluster
3. Get your connection string
4. Replace `<password>` in the connection string with your database user password

## Verifying Installation

After installation, verify that the addon is working by accessing:
- `http://your_domain:3232/manifest.json`
- `http://your_domain:3232/configure`

To add the addon to Stremio, use the URL:
`stremio://your_domain:3232/manifest.json`

## Troubleshooting

### Common Issues

1. **Cannot connect to MongoDB**
   - Verify your MongoDB URI is correct
   - Ensure your IP is whitelisted in MongoDB Atlas
   - Check if the database user has correct permissions

2. **API Keys not working**
   - Verify the keys are correctly copied
   - Check if the API services are operational
   - Ensure you're using the correct API key type

3. **Addon not accessible**
   - Verify the port 3232 is open on your firewall
   - Check if the HOST_NAME variable matches your actual domain
   - Ensure your domain/IP is accessible from the internet

### UI Tips

- **Force Latin TMDB Cast Names** – Located under *Configure → Providers → The Movie Database (TMDB) Settings*. When enabled, the addon fetches TMDB credits in English even if your display language is another locale. Use this if Asian productions show cast names in non-Latin scripts and you prefer Latin characters in Stremio.

For additional help, please open an issue on GitHub.