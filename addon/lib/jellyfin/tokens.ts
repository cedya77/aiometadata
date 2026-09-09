import crypto from 'crypto';
import consola from 'consola';
import { LRUCache } from 'lru-cache';
import redis from '../redisClient';
import { envInt } from '../../utils/envNumber';

const logger = consola.withTag('JellyfinAuth');

const PREFIX = 'jellyfin:token:';

function tokenTtlSeconds(): number {
  return envInt('JELLYFIN_TOKEN_TTL', 30 * 24 * 60 * 60, 60);
}

const memoryTokens = new LRUCache<string, string>({
  max: envInt('JELLYFIN_TOKEN_MEMORY_MAX', 5000, 1),
  ttl: tokenTtlSeconds() * 1000,
});

export async function mintToken(userUUID: string): Promise<string> {
  const token = crypto.randomBytes(24).toString('hex');

  if (redis) {
    try {
      await redis.set(`${PREFIX}${token}`, userUUID, 'EX', tokenTtlSeconds());
      return token;
    } catch (error: any) {
      logger.debug(`Token write failed, falling back to memory: ${error.message}`);
    }
  }

  memoryTokens.set(token, userUUID);
  return token;
}

export async function readToken(token: string | undefined): Promise<string | null> {
  if (!token) return null;

  if (redis) {
    try {
      return await redis.get(`${PREFIX}${token}`);
    } catch (error: any) {
      logger.debug(`Token read failed: ${error.message}`);
      return null;
    }
  }

  return memoryTokens.get(token) || null;
}

export async function revokeToken(token: string | undefined): Promise<void> {
  if (!token) return;

  if (redis) {
    try {
      await redis.del(`${PREFIX}${token}`);
      return;
    } catch (error: any) {
      logger.debug(`Token revoke failed: ${error.message}`);
    }
  }

  memoryTokens.delete(token);
}
