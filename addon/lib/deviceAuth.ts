// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import crypto from 'crypto';
import consola from 'consola';
import redis from './redisClient';
import { getSetting } from './settingsService';

const logger = consola.withTag('DeviceAuth');

/**
 * Sessions of the code sign-in flow: the user enters a short code on the
 * provider's site while the browser that asked for it polls this server.
 *
 * The session id is the only handle to a session and only the browser that
 * started the flow holds it, so knowing the short user code is not enough to
 * pick up the token.
 */
export interface DeviceAuthSession {
  provider: string;
  userCode: string;
  /** Set for flows that poll by a device code (Simkl V2) rather than by the user code. */
  deviceCode?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** The provider's interval, widened on each slow_down. */
  minIntervalMs: number;
  /** Epoch milliseconds; 0 until the first poll that reached the provider. */
  lastPolledAt: number;
}

export interface DeviceCodeGrant {
  userCode: string;
  deviceCode?: string;
  /** Seconds. */
  expiresIn: number;
  /** Seconds. */
  interval: number;
}

const SESSION_KEY_PREFIX = 'device-auth:session:';
const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/;
const REDIS_READ_WAIT_MS = 1000;
const RATE_LIMIT_WAIT_MS = 500;
const RATE_LIMIT_BUCKET_TTL_SECONDS = 70;
const SLOW_DOWN_STEP_MS = 2000;
const MAX_POLL_GAP_MS = 30 * 1000;
const DEFAULT_POLL_RATE_LIMIT_PER_MIN = 240;

const sessions = new Map<string, DeviceAuthSession>();

const TIMED_OUT = Symbol('timed out');

/** Settles with the promise, or with TIMED_OUT once `ms` has passed. A late failure is dropped. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(TIMED_OUT);
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sessionKey(id: string): string {
  return `${SESSION_KEY_PREFIX}${id}`;
}

function pruneExpired(now = Date.now()): void {
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
}

/** Fire and forget: no request waits on Redis to record a session. */
function mirrorToRedis(id: string, session: DeviceAuthSession): void {
  if (!redis) return;
  const ttlMs = session.expiresAt - Date.now();
  if (ttlMs <= 0) return;
  redis.set(sessionKey(id), JSON.stringify(session), 'PX', ttlMs).catch((error: any) => {
    logger.debug(`Could not mirror code sign-in session to Redis: ${error?.message || error}`);
  });
}

function removeFromRedis(id: string): void {
  if (!redis) return;
  redis.del(sessionKey(id)).catch((error: any) => {
    logger.debug(`Could not remove code sign-in session from Redis: ${error?.message || error}`);
  });
}

function parseSession(raw: unknown): DeviceAuthSession | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value.provider !== 'string' || typeof value.userCode !== 'string') return null;
    return {
      provider: value.provider,
      userCode: value.userCode,
      deviceCode: typeof value.deviceCode === 'string' && value.deviceCode ? value.deviceCode : undefined,
      expiresAt: Number(value.expiresAt) || 0,
      minIntervalMs: Number(value.minIntervalMs) || 0,
      lastPolledAt: Number(value.lastPolledAt) || 0,
    };
  } catch {
    return null;
  }
}

/** Redis's answer for a session, or NO_ANSWER when Redis is absent, not ready, slow or failing. */
const NO_ANSWER = Symbol('no answer');

async function readFromRedis(id: string): Promise<DeviceAuthSession | null | typeof NO_ANSWER> {
  if (!redis || redis.status !== 'ready') return NO_ANSWER;
  try {
    const raw = await within(redis.get(sessionKey(id)), REDIS_READ_WAIT_MS);
    if (raw === TIMED_OUT) {
      logger.debug('Redis did not answer a code sign-in session lookup in time; using the in-process copy');
      return NO_ANSWER;
    }
    return parseSession(raw);
  } catch (error: any) {
    logger.debug(`Could not read code sign-in session from Redis: ${error?.message || error}`);
    return NO_ANSWER;
  }
}

export function isDeviceAuthSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

/** Records a new session for a code the provider just issued and returns its id. */
export function createDeviceAuthSession(provider: string, grant: DeviceCodeGrant): string {
  const now = Date.now();
  pruneExpired(now);
  const id = crypto.randomBytes(32).toString('hex');
  const session: DeviceAuthSession = {
    provider,
    userCode: grant.userCode,
    deviceCode: grant.deviceCode || undefined,
    expiresAt: now + grant.expiresIn * 1000,
    minIntervalMs: grant.interval * 1000,
    lastPolledAt: 0,
  };
  sessions.set(id, session);
  mirrorToRedis(id, session);
  return id;
}

/**
 * The live session of this provider with this id, or null; an expired one is
 * deleted. When Redis answers it is the authority, so a cancel, a widened poll
 * gap or an expiry recorded by another replica is seen here. The in-process
 * copy is used only when Redis is absent, not ready or does not answer in time.
 */
export async function getDeviceAuthSession(provider: string, id: unknown): Promise<DeviceAuthSession | null> {
  if (!isDeviceAuthSessionId(id)) return null;
  pruneExpired();

  let session: DeviceAuthSession | null;
  const fromRedis = await readFromRedis(id);
  if (fromRedis === NO_ANSWER) {
    session = sessions.get(id) || null;
  } else if (fromRedis) {
    session = fromRedis;
    sessions.set(id, session);
  } else {
    // Gone from Redis (cancelled, finished or expired elsewhere): drop any stale local copy.
    sessions.delete(id);
    session = null;
  }
  if (!session) return null;

  if (session.expiresAt <= Date.now()) {
    deleteDeviceAuthSession(id);
    return null;
  }
  if (session.provider !== provider) return null;
  return session;
}

export function saveDeviceAuthSession(id: string, session: DeviceAuthSession): void {
  sessions.set(id, session);
  mirrorToRedis(id, session);
}

/** Returns whether this process held the session. Redis is cleared either way. */
export function deleteDeviceAuthSession(id: string): boolean {
  const existed = sessions.delete(id);
  removeFromRedis(id);
  return existed;
}

/** True when the provider was polled for this session less than its minimum gap ago. */
export function pollTooSoon(session: DeviceAuthSession, now = Date.now()): boolean {
  return session.lastPolledAt > 0 && now - session.lastPolledAt < session.minIntervalMs;
}

/** Widens the session's minimum poll gap after the provider asked to slow down. */
export function widenPollGap(session: DeviceAuthSession): void {
  if (session.minIntervalMs >= MAX_POLL_GAP_MS) return;
  session.minIntervalMs = Math.min(session.minIntervalMs + SLOW_DOWN_STEP_MS, MAX_POLL_GAP_MS);
}

function pollRateLimitPerMinute(): number {
  const parsed = parseInt(getSetting('DEVICE_AUTH_POLL_RATE_LIMIT_PER_MIN'), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_RATE_LIMIT_PER_MIN;
}

function rateLimitCaller(req: any): string {
  const fromQuery = req.query?.sessionId;
  if (isDeviceAuthSessionId(fromQuery)) return fromQuery;
  const fromBody = req.body?.sessionId;
  if (isDeviceAuthSessionId(fromBody)) return fromBody;
  return req.session?.accountId || req.ip || 'unknown';
}

async function countRequest(key: string): Promise<number> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, RATE_LIMIT_BUCKET_TTL_SECONDS);
  return count;
}

/**
 * Caps code sign-in requests per caller per minute. Without Redis, or when
 * Redis is slow or failing, requests go through.
 */
export async function deviceAuthRateLimit(req: any, res: any, next: any): Promise<void> {
  if (!redis) return next();

  try {
    const minuteBucket = Math.floor(Date.now() / 60000);
    const key = `rate-limit:device-auth-poll:${rateLimitCaller(req)}:${minuteBucket}`;
    const count = await within(countRequest(key), RATE_LIMIT_WAIT_MS);
    if (count !== TIMED_OUT && count > pollRateLimitPerMinute()) {
      return res.status(429).json({ error: 'Too many authorization status requests. Please try again shortly.' });
    }
  } catch (error: any) {
    logger.warn(`Code sign-in limiter failed, allowing request: ${error?.message || error}`);
  }

  next();
}
