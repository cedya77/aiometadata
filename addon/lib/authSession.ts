// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import crypto from 'crypto';
import consola from 'consola';
import redis from './redisClient';
import { getSetting } from './settingsService';
import { isPermission, type Permission } from './permissions';
import { isOidcConfigured, readOidcConfig, resolvePermissions } from './oidc';

const logger = consola.withTag('AuthSession');

export const SESSION_COOKIE = 'aiom_session';
const SESSION_PREFIX = 'auth:session:';
const ACCOUNT_SESSIONS_PREFIX = 'auth:account-sessions:';
const INDEX_COMPLETE_KEY = 'auth:account-sessions-complete';

async function indexComplete(): Promise<boolean> {
  try {
    return (await redis.exists(INDEX_COMPLETE_KEY)) === 1;
  } catch {
    return false;
  }
}

function accountSessionsKey(accountId: string): string {
  return `${ACCOUNT_SESSIONS_PREFIX}${accountId}`;
}

/**
 * The set has to outlive its longest-lived member, so its expiry follows the
 * highest score rather than whichever session was added last. Setting it from
 * the newest member would cut the set short whenever a shorter TTL is issued
 * after a longer one, stranding live sessions outside the index.
 */
async function refreshIndexExpiry(key: string): Promise<void> {
  const top: string[] = await redis.zrange(key, -1, '-1', 'WITHSCORES');
  if (top.length === 2) await redis.pexpireat(key, Number(top[1]) + 60000);
}
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export { ALL_PERMISSIONS, isPermission, type Permission } from './permissions';

export interface SessionData {
  accountId: string;
  username: string;
  email: string | null;
  permissions: Permission[];
  groups: string[] | null;
  createdAt: number;
}

export function sessionTtlSeconds(): number {
  const parsed = parseInt(getSetting('SESSION_TTL_SECONDS') || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SECONDS;
}

export async function createSession(data: Omit<SessionData, 'createdAt'>): Promise<string> {
  const id = crypto.randomBytes(32).toString('base64url');
  const payload: SessionData = { ...data, createdAt: Date.now() };
  const ttl = sessionTtlSeconds();
  await redis.set(`${SESSION_PREFIX}${id}`, JSON.stringify(payload), 'EX', ttl);
  try {
    const key = accountSessionsKey(data.accountId);
    await redis.zadd(key, Date.now() + ttl * 1000, id);
    await refreshIndexExpiry(key);
  } catch (error: any) {
    logger.warn(`Could not index session for ${data.accountId}: ${error.message}`);
    await redis.del(INDEX_COMPLETE_KEY).catch(() => undefined);
  }
  return id;
}

export async function readSession(id: string | undefined): Promise<SessionData | null> {
  if (!id) return null;
  try {
    const raw = await redis.get(`${SESSION_PREFIX}${id}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const stored: Permission[] = Array.isArray(parsed.permissions)
      ? parsed.permissions.filter(isPermission)
      : [];

    const config = readOidcConfig();
    if (!isOidcConfigured(config)) return null;

    if (!Array.isArray(parsed.groups)) {
      return { ...parsed, groups: null, permissions: stored };
    }

    const resolved = resolvePermissions(parsed.groups, config);
    if (resolved !== null) return { ...parsed, permissions: resolved };

    if (config.groupPermissions === null) {
      logger.error(`Group mapping is unreadable; keeping last known permissions for ${parsed.username}`);
      return { ...parsed, permissions: stored };
    }

    logger.info(`Signing out ${parsed.username}: the group mapping no longer grants access`);
    await destroySession(id);
    return null;
  } catch (error: any) {
    logger.warn(`Could not read session: ${error.message}`);
    return null;
  }
}

export async function destroySession(id: string | undefined): Promise<void> {
  if (!id) return;
  try {
    const raw = await redis.get(`${SESSION_PREFIX}${id}`);
    await redis.del(`${SESSION_PREFIX}${id}`);
    if (raw) {
      const accountId = JSON.parse(raw)?.accountId;
      if (accountId) await redis.zrem(accountSessionsKey(accountId), id);
    }
  } catch (error: any) {
    logger.warn(`Could not destroy session: ${error.message}`);
  }
}

export async function countAccountSessions(accountId: string): Promise<number> {
  try {
    const key = accountSessionsKey(accountId);
    await redis.zremrangebyscore(key, 0, Date.now());
    return await redis.zcard(key);
  } catch (error: any) {
    logger.warn(`Could not count sessions for ${accountId}: ${error.message}`);
    return 0;
  }
}

async function scanSessions(
  visit: (id: string, record: any) => Promise<void>
): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${SESSION_PREFIX}*`, 'COUNT', 1000);
    cursor = next;
    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      let record: any;
      try {
        record = JSON.parse(raw);
      } catch {
        // Unreadable value, leave it to expire on its own.
        continue;
      }
      await visit(key.slice(SESSION_PREFIX.length), record);
    }
  } while (cursor !== '0');
}

/**
 * Sessions minted before the per-account index existed carry no member, so the
 * index alone would undercount them. One sweep at startup adopts them; once a
 * sweep finishes without an error, later startups skip it.
 */
export async function backfillSessionIndex(): Promise<number> {
  let adopted = 0;
  if (await indexComplete()) return 0;
  try {
    await scanSessions(async (id, record) => {
      const accountId = record?.accountId;
      if (!accountId) return;
      const key = accountSessionsKey(accountId);
      if (await redis.zscore(key, id) !== null) return;
      const ttl = await redis.ttl(`${SESSION_PREFIX}${id}`);
      if (ttl <= 0) return;
      await redis.zadd(key, Date.now() + ttl * 1000, id);
      await refreshIndexExpiry(key);
      adopted += 1;
    });
    if (adopted > 0) logger.info(`Adopted ${adopted} session(s) into the account index`);
    await redis.set(INDEX_COMPLETE_KEY, String(Date.now()));
  } catch (error: any) {
    logger.warn(`Could not backfill the session index: ${error.message}`);
  }
  return adopted;
}

/**
 * Every session for one account, used when its access is revoked. The index
 * answers first, then a sweep catches anything missing from it: revoking is
 * rare and interactive, so it is worth the scan to never report a success that
 * left a session alive.
 */
export async function destroyAccountSessions(accountId: string): Promise<number> {
  const key = accountSessionsKey(accountId);
  const removed = new Set<string>();

  try {
    const ids: string[] = await redis.zrange(key, 0, '-1');
    for (const id of ids) {
      await redis.del(`${SESSION_PREFIX}${id}`);
      removed.add(id);
    }
    await redis.del(key);
  } catch (error: any) {
    logger.warn(`Could not read the session index for ${accountId}: ${error.message}`);
  }

  try {
    await scanSessions(async (id, record) => {
      if (record?.accountId !== accountId || removed.has(id)) return;
      await redis.del(`${SESSION_PREFIX}${id}`);
      await redis.zrem(key, id);
      removed.add(id);
    });
  } catch (error: any) {
    logger.error(`Could not sweep sessions for ${accountId}: ${error.message}`);
    error.revoked = removed.size;
    throw error;
  }

  return removed.size;
}

/** Express has res.cookie but no reader, and one header parse beats a dependency. */
export function readCookie(req: any, name: string): string | undefined {
  const header = req?.headers?.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return part.slice(index + 1).trim();
    }
  }
  return undefined;
}

export function isSecureRequest(req: any): boolean {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

export function setSessionCookie(req: any, res: any, id: string): void {
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    maxAge: sessionTtlSeconds() * 1000,
    path: '/',
  });
}

export function clearSessionCookie(req: any, res: any): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    path: '/',
  });
}

/**
 * Attaches the session to the request without gating anything, so routes that
 * are open to everyone can still tell who is signed in.
 */
export async function attachSession(req: any, _res: any, next: any): Promise<void> {
  try {
    req.session = await readSession(readCookie(req, SESSION_COOKIE));
  } catch {
    req.session = null;
  }
  next();
}

/** `admin` is a superset, so mapping a group to it alone grants everything. */
export function hasPermission(req: any, permission: Permission): boolean {
  const permissions: Permission[] | undefined = req?.session?.permissions;
  if (!Array.isArray(permissions)) return false;
  return permissions.includes(permission) || permissions.includes('admin');
}
