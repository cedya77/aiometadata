// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import crypto from 'crypto';
import consola from 'consola';
import { LRUCache } from 'lru-cache';
import redis from '../redisClient';
import { envInt } from '../../utils/envNumber';

const logger = consola.withTag('JellyfinAuth');
const database: any = require('../database');

/** Where tokens lived before the database held them; read once and moved. */
const LEGACY_PREFIX = 'jellyfin:token:';

/** How long a sign-in lasts without being used; every use extends it. */
function tokenTtlMs(): number {
  return envInt('JELLYFIN_TOKEN_TTL', 30 * 24 * 60 * 60, 60) * 1000;
}

function touchIntervalMs(): number {
  return envInt('JELLYFIN_TOKEN_TOUCH_INTERVAL', 60 * 60, 1) * 1000;
}

interface Held {
  session: TokenSession;
  touchedAt: number;
}

const memo = new LRUCache<string, Held>({
  max: envInt('JELLYFIN_TOKEN_MEMORY_MAX', 5000, 1),
  ttl: envInt('JELLYFIN_TOKEN_MEMO_TTL', 60, 1) * 1000,
});

export interface TokenSession {
  userUUID: string;
  /** The user the client signed in as; null is the main user. */
  profileId: string | null;
}

function hashOf(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function decodeLegacy(stored: string | null | undefined): TokenSession | null {
  if (!stored) return null;
  if (!stored.startsWith('{')) return { userUUID: stored, profileId: null };
  try {
    const parsed = JSON.parse(stored);
    return parsed?.u ? { userUUID: String(parsed.u), profileId: parsed.p ? String(parsed.p) : null } : null;
  } catch {
    return null;
  }
}

let lastSweep = 0;
function sweepIdle(now: number): void {
  if (now - lastSweep < touchIntervalMs()) return;
  lastSweep = now;
  database.deleteIdleJellyfinTokens(now - tokenTtlMs())
    .then((removed: number) => { if (removed) logger.debug(`Removed ${removed} idle sign-in(s)`); })
    .catch((error: any) => logger.debug(`Idle sign-in sweep failed: ${error.message}`));
}

export async function mintToken(userUUID: string, profileId: string | null = null): Promise<string> {
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  await database.insertJellyfinToken(hashOf(token), userUUID, profileId, now);
  memo.set(token, { session: { userUUID, profileId }, touchedAt: now });
  sweepIdle(now);
  return token;
}

// A token signed in before the move is carried over on first use, so nobody is signed out by it.
async function adoptLegacy(token: string, now: number): Promise<TokenSession | null> {
  if (!redis) return null;
  let session: TokenSession | null = null;
  try {
    session = decodeLegacy(await redis.get(`${LEGACY_PREFIX}${token}`));
  } catch {
    return null;
  }
  if (!session) return null;
  await database.insertJellyfinToken(hashOf(token), session.userUUID, session.profileId, now);
  await redis.del(`${LEGACY_PREFIX}${token}`).catch(() => undefined);
  return session;
}

/**
 * The session a token belongs to, or null when it is unknown or has gone unused
 * for longer than a sign-in lasts. A failed read throws rather than answering
 * null, so a database hiccup is not taken for a signed-out client.
 */
export async function readTokenSession(token: string | undefined): Promise<TokenSession | null> {
  if (!token) return null;
  const now = Date.now();

  const held = memo.get(token);
  if (held) {
    if (now - held.touchedAt >= touchIntervalMs()) {
      held.touchedAt = now;
      database.touchJellyfinToken(hashOf(token), now).catch((error: any) => logger.debug(`Sign-in touch failed: ${error.message}`));
    }
    return held.session;
  }

  const hash = hashOf(token);
  const row = await database.findJellyfinToken(hash);
  let session: TokenSession | null = null;
  if (row) {
    if (now - Number(row.last_used_at) > tokenTtlMs()) {
      await database.deleteJellyfinToken(hash).catch(() => undefined);
      return null;
    }
    session = { userUUID: String(row.user_uuid), profileId: row.profile_id ? String(row.profile_id) : null };
    if (now - Number(row.last_used_at) >= touchIntervalMs()) await database.touchJellyfinToken(hash, now);
  } else {
    session = await adoptLegacy(token, now);
  }

  if (session) memo.set(token, { session, touchedAt: now });
  return session;
}

export async function readToken(token: string | undefined): Promise<string | null> {
  return (await readTokenSession(token))?.userUUID ?? null;
}

export async function revokeToken(token: string | undefined): Promise<void> {
  if (!token) return;
  memo.delete(token);
  await database.deleteJellyfinToken(hashOf(token));
  if (redis) await redis.del(`${LEGACY_PREFIX}${token}`).catch(() => undefined);
}

/** Every sign-in of the configuration, or of one of its users when `profileId` is given; null is the main user. */
export async function revokeUserTokens(userUUID: string, profileId?: string | null): Promise<void> {
  const matches = (session: TokenSession | null): boolean =>
    session?.userUUID === userUUID && (profileId === undefined || session.profileId === profileId);
  for (const [token, held] of memo.entries()) {
    if (matches(held.session)) memo.delete(token);
  }
  if (profileId === undefined) await database.deleteJellyfinTokensForUser(userUUID);
  else await database.deleteJellyfinTokensForProfile(userUUID, profileId);
  if (!redis) return;
  const keys: string[] = [];
  for await (const batch of redis.scanStream({ match: `${LEGACY_PREFIX}*`, count: 500 })) keys.push(...batch);
  for (const key of keys) {
    if (matches(decodeLegacy(await redis.get(key)))) await redis.del(key);
  }
}
