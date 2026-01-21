
FROM node:20-alpine AS builder

WORKDIR /app


RUN apk add --no-cache git
RUN git clone -b dev https://github.com/realbestia2/aiometadata .

RUN npm ci


RUN npm run build

# Build do backend TypeScript
RUN npm run build:backend

FROM node:20-alpine AS runner

WORKDIR /app

# Install CA certificates for SSL/TLS verification
RUN apk add --no-cache ca-certificates

COPY --from=builder /app/package*.json ./


RUN npm ci --production


COPY --from=builder /app/addon ./addon

COPY --from=builder /app/dist ./dist

COPY --from=builder /app/public ./public

ARG PORT=3232
EXPOSE ${PORT}

RUN apk add --no-cache wget

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD sh -c 'wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3232}/health || exit 1'

ENTRYPOINT ["node", "dist/server.js"] 