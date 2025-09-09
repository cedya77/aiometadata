import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const GLOBAL_NO_CACHE = process.env.NO_CACHE === 'true';

const redis: Redis | null = GLOBAL_NO_CACHE ? null : new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true
});

if (redis) {
  redis.on('error', (err: Error) => {
    console.error('Redis Client Error:', err);
  });
  redis.on('connect', () => console.log('Redis client connected.'));
  redis.on('ready', () => console.log('Redis client ready.'));
  redis.on('close', () => console.log('Redis client connection closed.'));
  redis.on('reconnecting', () => console.log('Redis client reconnecting...'));
}

export default redis;
module.exports = redis;
