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
