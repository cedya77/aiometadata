const Redis = require('ioredis');
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const GLOBAL_NO_CACHE = process.env.NO_CACHE === 'true';

const redis = GLOBAL_NO_CACHE ? null : new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
  lazyConnect: true
});

if (redis) {
  redis.on('error', err => {
    console.error('Redis Client Error:', err);
  });
  redis.on('connect', () => console.log('Redis client connected.'));
  redis.on('ready', () => console.log('Redis client ready.'));
  redis.on('close', () => console.log('Redis client connection closed.'));
  redis.on('reconnecting', () => console.log('Redis client reconnecting...'));
}

module.exports = redis;
