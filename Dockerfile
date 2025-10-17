
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


EXPOSE 1337

ENTRYPOINT ["node", "dist/server.js"] 