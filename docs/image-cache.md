# Image Cache

Cache artwork on disk so repeated requests are served locally instead of re-fetched from upstream. Combined with comprehensive cache warming, images load instantly.

## Option A — Built-in (recommended)

The cache is part of the addon itself — no extra container, port, or volume. Set one variable:

```yaml
  aiometadata:
    # ...your existing service...
    environment:
      - ENABLE_BUILTIN_POSTER_CACHE=true
```

Images are served from `https://your-addon-host/poster-cache/...` and stored under `addon/data/poster-cache`, which is already inside the `/app/addon/data` volume from the compose file above — so the cache survives restarts with no additional mount.

**What gets cached.** Posters, collection images and the addon's own rendered images are cached by default. Every other image type is opt-in, so enabling the cache never changes disk usage unexpectedly:

| Variable | Default | Caches |
|----------|---------|--------|
| `POSTER_CACHE_BACKGROUNDS` | `false` | Background artwork — the largest images served, so the biggest bandwidth win |
| `POSTER_CACHE_LANDSCAPE_POSTERS` | `false` | Landscape poster artwork |
| `POSTER_CACHE_LOGOS` | `false` | Logo artwork |
| `POSTER_CACHE_THUMBNAILS` | `false` | Episode thumbnails — by far the most numerous; a long-running series adds hundreds |
| `POSTER_CACHE_CAST` | `false` | Cast and actor headshots shown with meta and catalog results |
| `POSTER_CACHE_COLLECTIONS` | `true` | Collection covers, backdrops, logos and focus GIFs, kept as they are rather than reshaped to 2:3 like posters; a collection's images are also pinned against eviction while it uses the cache |
| `POSTER_CACHE_PROCESSED_IMAGES` | `true` | Images the addon renders itself: rating-overlaid posters and the blur/resize/banner-to-background transforms, so each one runs once |

These are also toggles in the dashboard's **Settings** tab, and the **Operations** tab shows disk usage broken down by image type, with per-type clear buttons and a **Refresh** box for dropping a single image.

Custom art URLs are passed through unchanged rather than rendered, so they count as the image type they are: a custom logo needs `POSTER_CACHE_LOGOS`, a custom background needs `POSTER_CACHE_BACKGROUNDS`, whether or not the art proxy is on.

**Staleness.** Cached images are validated by a hash of their bytes, so replacing the artwork at a URL your art pattern points to makes clients re-download it rather than keep the old copy. To force it immediately, paste the image URL (or the `/poster-cache/…` URL) into **Refresh** on the Operations tab — no need to clear a whole image type.

**Sizing.** Two budgets, evicted least-recently-used once exceeded:

| Variable | Default | Caps |
|----------|---------|------|
| `POSTER_CACHE_MAX_SIZE` | `10g` | **Disk** used by the cache |
| `POSTER_CACHE_MEMORY_SIZE` | `128m` | **RAM** held for the hottest images, in front of the disk cache. Set to `0` for disk only. |

The memory tier sits on top of the addon's own footprint, so budget roughly `baseline + POSTER_CACHE_MEMORY_SIZE`.

**Smaller TMDB renditions.** The other lever on storage is asking TMDB for less in the first place. TMDB serves `/t/p/original` as the file the uploader supplied — like logos that are frequently lossless PNGs and overly large, far more than any client renders. These work whether or not the image cache is on. The first three are off by default; posters are the exception and are already sized:

| Variable | Default | Requests | Saving |
|----------|---------|----------|--------|
| `PREFER_SMALLER_LOGOS_TMDB` | `false` | Logos at `w500` | ~12× — the safest of the three, since logos are rendered small |
| `PREFER_SMALLER_LANDSCAPE_TMDB` | `false` | Landscape posters at `w780` | ~11.6× — clients draw these as catalog tiles, not full-screen |
| `PREFER_SMALLER_BACKDROPS_TMDB` | `false` | Backgrounds at `w1280` | ~5.1× — the only genuine quality trade; leave it off if backgrounds are rendered full-screen on a 4K display |
| `PREFER_SMALLER_POSTERS_TMDB` | `true` | Posters at `w600_and_h900_bestv2` | Already on — this is the long-standing default. Set it to `false` for `original` posters, which is the most expensive of the four to flip: posters are the highest-volume class, one per catalog tile |

For the first three a sized rendition is only requested when the asset is actually larger than that size. TMDB upscales rather than refusing, so asking for more than an asset has would make it both blurrier and bigger — the addon falls back to `original` in that case. Posters skip that check, since `w600_and_h900_bestv2` is a fixed 600×900 crop and falling back to `original` would change their aspect ratio. Toggling any of these does not rewrite meta already in the cache; those payloads keep their existing URLs until `META_TTL` expires, and the superseded images are reclaimed as they age out.

**Validity.** How long a cached image stays fresh, decided most-specific-first:

| Variable | Default | Sets |
|----------|---------|------|
| `POSTER_CACHE_PROVIDER_POLICIES` | unset | A rule for one provider — `default`, `infer`, a `custom` duration, or `bypass`. Sets how long art is stored, and the `Cache-Control` on art passed through without storing |
| `POSTER_CACHE_PROVIDER_PRESETS` | `true` | Built-in policies, measured per provider, so rating posters stay current out of the box |
| `POSTER_CACHE_INFER_TTL` | `false` | Follows each remaining source's own headers instead of the flat number |
| `POSTER_CACHE_TTL_DAYS` | `30` | The flat fallback. Fractional values work; `0` never expires |

`POSTER_PROXY_MAX_AGE_DAYS` (default `1`) is the matching client-side lifetime, and the ceiling on it for art passed through without storing. `POSTER_CACHE_INACTIVE_DAYS` (default `30`) drops images nobody has requested, and `POSTER_CACHE_DIR` moves the cache elsewhere. Both `POSTER_PROXY_*` settings apply with the built-in cache off, and a per-provider rule overrides them for that provider.

> **Using a rating poster service?** Nothing to do — `api.ratingposterdb.com`, `api.top-posters.com`, `btttr.cc`, `extendedratings.com` and `postersplus.elfhosted.com` each ship a built-in policy following their own headers, which run short while an overlay moves and long once a rating settles.
>
> **Using a custom art URL pattern?** Check the host you pointed it at. Anything the addon does not know has no built-in policy, and such URLs usually name a slot rather than a file — the bytes change while the URL does not, so a stale rating sits there for the full 30 days. Give its domain a rule under **Advanced…** on the dashboard's Image Cache card.

> **Multi-replica / Kubernetes:** each replica keeps its own local cache — independent and unshared, which costs N× storage and N× cold fetches but needs no coordination. Use Option B if you want a single shared cache.

## Migrating from the old nginx poster cache

Earlier versions ran a bundled nginx proxy on port `8888`. It has been replaced by the built-in cache, so you can drop the `8888` expose/labels and `init: true`, plus any reverse-proxy route pointing at port 8888 (that hostname stops resolving to anything).

**Keep the `/var/cache/nginx` volume for now** — it holds the cache being imported. See the import step below for when it is safe to remove.

> ### ⚠ Breaking change — `POSTER_PROXY_PREFIX_URL`
>
> It used to mean *"the public address of port 8888"*. It now means *"the public URL images are served through"*, which for the built-in cache includes the `/poster-cache` path.
>
> **If you set it explicitly, you must act.** Otherwise images break: requests land on the addon root instead of the cache.
>
> | Before | After |
> |--------|-------|
> | `POSTER_PROXY_PREFIX_URL=https://posters.example.com` | **Unset it** — the built-in cache derives `{HOST_NAME}/poster-cache` automatically |
> | | *or* `POSTER_PROXY_PREFIX_URL=https://your-addon-host/poster-cache` |
>
> Running the standalone nginx proxy (Option B) instead? **Nothing changes** — keep pointing it at your proxy exactly as before.
>
> Image URLs already handed to Stremio clients also change shape, so clients re-fetch each image once. Your cached files are not lost: the disk cache is preserved by the automatic import below.

**Your existing cache is imported automatically.** Leave the `/var/cache/nginx` volume mounted for one start:

```yaml
volumes:
  - ${DOCKER_DATA_DIR}/poster-cache:/var/cache/nginx   # keep for one start, then remove
```

On startup the addon detects the old cache and imports it in the background, so serving is never delayed. You will see:

```
[PosterCacheImport] Found a cache from the previous built-in nginx proxy at
/var/cache/nginx/posters — importing it once so the upgrade does not start cold.
```

Files it cannot parse are skipped, never imported as corrupt entries.

**Let it finish before restarting.** The completion marker is only written at the end, so restarting mid-import starts it over. When it finishes the log tells you directly:

```
[PosterCacheImport] Imported 81133 images from the old nginx cache (2 skipped)
in 257958ms. You can now remove the /var/cache/nginx/posters volume mount.
```

That is a real run: ~9 GB / 81k images took about 4 minutes. You can also check for the marker, which records the counts:

```bash
docker exec <container> cat /app/addon/data/poster-cache/.nginx-import-completed
```

To skip the import entirely, set `POSTER_CACHE_IMPORT_NGINX_DIR=off`. To import from a non-standard path, set it to that path.


## Option B — Standalone nginx service

For multi-replica deployments that need a single shared cache. Add a `poster-cache` service alongside your aiometadata container and leave `ENABLE_BUILTIN_POSTER_CACHE` off:

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
            proxy_set_header X-Forwarded-Host $proxy_host;
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

