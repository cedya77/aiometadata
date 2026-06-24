FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build && npm run build:backend

FROM node:24-alpine AS runner
WORKDIR /app
# nginx backs the optional built-in poster cache (ENABLE_BUILTIN_POSTER_CACHE);
# busybox nc (with -e support) is already present for the purge handler.
RUN apk add --no-cache ca-certificates wget nginx
COPY package*.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
COPY --from=builder /app/addon ./addon
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY docker/poster-cache /etc/aiometadata/poster-cache
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
      /etc/aiometadata/poster-cache/stats.sh \
      /etc/aiometadata/poster-cache/purge-handler.sh

ARG PORT=3232
EXPOSE ${PORT}
# Built-in poster cache (opt-in) listens here
EXPOSE 8888

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD sh -c 'wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3232}/health || exit 1'

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
