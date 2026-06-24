#!/bin/sh
set -e

is_true() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

if is_true "$ENABLE_BUILTIN_POSTER_CACHE"; then
  CONF_DIR="/etc/aiometadata/poster-cache"
  CACHE_DIR="/var/cache/nginx/posters"

  mkdir -p "$CACHE_DIR" /run/nginx
  chown -R nginx:nginx /var/cache/nginx 2>/dev/null || true

  if [ -z "${POSTER_WARMUP_URL:-}" ]; then
    export POSTER_WARMUP_URL="http://127.0.0.1:8888"
    echo "[entrypoint] POSTER_WARMUP_URL defaulted to http://127.0.0.1:8888"
  fi

  if [ -z "${POSTER_PROXY_PREFIX_URL:-}" ]; then
    echo "[entrypoint] WARNING: ENABLE_BUILTIN_POSTER_CACHE is on but POSTER_PROXY_PREFIX_URL is unset."
    echo "[entrypoint] Clients fetch posters through this URL, so set it to the public address of port 8888."
  fi

  echo "[entrypoint] Built-in poster cache enabled (nginx on :8888)"

  LOG_PIPE=/var/log/nginx/poster-cache.pipe
  mkdir -p /var/log/nginx
  rm -f "$LOG_PIPE"
  mkfifo -m 0660 "$LOG_PIPE"
  chown nginx:nginx "$LOG_PIPE" 2>/dev/null || true
  # Hold the pipe open read-write so nginx never blocks opening its log and the
  # Node reader never sees EOF when nginx workers cycle.
  exec 3<>"$LOG_PIPE"

  nc -lk -p 9888 -e "$CONF_DIR/purge-handler.sh" &
  "$CONF_DIR/stats.sh" &
  nginx -c "$CONF_DIR/nginx.conf" -g 'daemon off;' &
fi

exec node dist/server/server.js
