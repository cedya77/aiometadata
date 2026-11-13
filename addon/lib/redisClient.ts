// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import Redis from 'ioredis';
import consola from 'consola';
const logger = consola.withTag('Redis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const redis: Redis | null = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true,
  enableAutoPipelining: true
});

if (redis) {
  redis.on('error', (err: Error) => {
    logger.error('Redis Client Error:', err);
  });
  // Routine lifecycle: startup reports Redis readiness itself, and a genuine
  // failure surfaces through the 'error' handler above.
  redis.on('connect', () => logger.debug('Redis client connected.'));
  redis.on('ready', () => logger.debug('Redis client ready.'));
  redis.on('close', () => logger.debug('Redis client connection closed.'));
  redis.on('reconnecting', () => logger.debug('Redis client reconnecting...'));
}

export default redis;
module.exports = redis;
