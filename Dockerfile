
FROM node:20-alpine AS builder

WORKDIR /app


COPY package*.json package-lock.json* ./

RUN npm ci

COPY . .


RUN npm run build

# Build do backend TypeScript
RUN npm run build:backend

FROM node:20-alpine AS runner

WORKDIR /app

# Install CA certificates for SSL/TLS verification
RUN apk add --no-cache ca-certificates

COPY package*.json package-lock.json* ./


RUN npm ci --production


COPY --from=builder /app/addon ./addon

COPY --from=builder /app/dist ./dist

COPY --from=builder /app/public ./public


EXPOSE 3232

RUN apk add --no-cache wget

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3232/health || exit 1

ENTRYPOINT ["node", "dist/server.js"] 