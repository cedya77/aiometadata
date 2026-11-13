FROM mirror.gcr.io/library/node:24-alpine AS builder
WORKDIR /app
COPY package*.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build && npm run build:backend

FROM mirror.gcr.io/library/node:24-alpine AS runner
WORKDIR /app
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later AND FSL-1.1-ALv2"
RUN apk add --no-cache ca-certificates wget
COPY package*.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
COPY --from=builder /app/addon ./addon
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/LICENSE /app/LICENSE-FSL.md /app/LICENSING.md /app/NOTICE /app/TRADEMARKS.md /app/THIRD_PARTY_NOTICES.txt ./
COPY --from=builder /app/LICENSES ./LICENSES
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && \
    chmod +x /usr/local/bin/entrypoint.sh

ENV UV_THREADPOOL_SIZE=16
ENV DOTENV_CONFIG_QUIET=true

ARG PORT=3232
EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD sh -c 'wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3232}/health/live || exit 1'

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
