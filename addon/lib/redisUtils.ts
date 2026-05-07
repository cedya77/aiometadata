const redis: any = require('./redisClient');
const consola: any = require('consola');
const logger: any = consola.withTag('Redis-Utils');

interface DeleteKeysByPatternOptions {
  scanCount?: number;
  batchSize?: number;
  filter?: ((key: string) => boolean) | null;
}

async function deleteKeysByPattern(pattern: string, options: DeleteKeysByPatternOptions = {}): Promise<number> {
  if (!redis) return 0;
  const scanCount = options.scanCount || 1000;
  const batchSize = options.batchSize || 500;
  const filter = options.filter || null;
  let cursor = '0';
  let totalDeleted = 0;

  do {
    const res = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', scanCount);
    cursor = res[0];
    const keys: string[] = res[1] || [];
    if (keys.length === 0) continue;

    const keysToDelete = filter ? keys.filter(filter) : keys;
    if (keysToDelete.length === 0) continue;

    for (let i = 0; i < keysToDelete.length; i += batchSize) {
      const chunk = keysToDelete.slice(i, i + batchSize);
      const pipeline = redis.pipeline();
      for (const k of chunk) pipeline.del(k);
      await pipeline.exec();
      totalDeleted += chunk.length;
    }
  } while (cursor !== '0');

  return totalDeleted;
}

interface ScanKeysOptions {
  scanCount?: number;
}

async function scanKeys(pattern: string, cb: (key: string) => Promise<void>, options: ScanKeysOptions = {}): Promise<number> {
  if (!redis) return 0;
  const scanCount = options.scanCount || 1000;
  let cursor = '0';
  let processed = 0;
  do {
    const res = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', scanCount);
    cursor = res[0];
    const keys: string[] = res[1] || [];
    for (const k of keys) {
      await cb(k);
      processed++;
    }
  } while (cursor !== '0');
  return processed;
}

export { deleteKeysByPattern, scanKeys };
module.exports = { deleteKeysByPattern, scanKeys };
