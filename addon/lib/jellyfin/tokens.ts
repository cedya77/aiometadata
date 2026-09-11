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

export interface TokenSession {
  userUUID: string;
  /** The user the client signed in as; null is the main user. */
  profileId: string | null;
}

// The main user's token is the bare UUID, the form every older token has.
function encode(userUUID: string, profileId: string | null): string {
  return profileId ? JSON.stringify({ u: userUUID, p: profileId }) : userUUID;
}

function decode(stored: string | null | undefined): TokenSession | null {
  if (!stored) return null;
  if (!stored.startsWith('{')) return { userUUID: stored, profileId: null };
  try {
    const parsed = JSON.parse(stored);
    return parsed?.u ? { userUUID: String(parsed.u), profileId: parsed.p ? String(parsed.p) : null } : null;
  } catch {
    return null;
  }
}

export async function mintToken(userUUID: string, profileId: string | null = null): Promise<string> {
  const token = crypto.randomBytes(24).toString('hex');
  const value = encode(userUUID, profileId);

  if (redis) {
    try {
      await redis.set(`${PREFIX}${token}`, value, 'EX', tokenTtlSeconds());
      return token;
    } catch (error: any) {
      logger.debug(`Token write failed, falling back to memory: ${error.message}`);
    }
  }

  memoryTokens.set(token, value);
  return token;
}

export async function readTokenSession(token: string | undefined): Promise<TokenSession | null> {
  if (!token) return null;

  if (redis) {
    try {
      return decode(await redis.get(`${PREFIX}${token}`));
    } catch (error: any) {
      logger.debug(`Token read failed: ${error.message}`);
      return null;
    }
  }

  return decode(memoryTokens.get(token));
}

export async function readToken(token: string | undefined): Promise<string | null> {
  return (await readTokenSession(token))?.userUUID ?? null;
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
