
FROM oven/bun:1.3-alpine AS builder

WORKDIR /app


COPY package*.json bun.lock* ./

RUN bun install --frozen-lockfile

COPY . .


RUN bun run build

# Build do backend TypeScript
RUN bun run build:backend

FROM oven/bun:1.3-alpine AS runner

WORKDIR /app

# Install CA certificates for SSL/TLS verification
RUN apk add --no-cache ca-certificates

COPY package*.json bun.lock* ./


RUN bun install --production --frozen-lockfile


COPY --from=builder /app/addon ./addon

COPY --from=builder /app/dist ./dist

COPY --from=builder /app/public ./public


EXPOSE 1337

ENTRYPOINT ["bun", "run", "dist/server.js"] 