// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import crypto from 'crypto';
import consola from 'consola';
import redis from './redisClient';
import { getSetting } from './settingsService';

const logger = consola.withTag('Auth');

const FAILURE_PREFIX = 'auth:signin-failure:';
const FAILURE_INDEX = 'auth:signin-failures';
const UNVERIFIED_INDEX = 'auth:signin-failures:unverified';
const MAX_GROUPS_RECORDED = 32;
const DEFAULT_LOG_MAX = 50;
const MAX_LOG_MAX = 500;

export type SigninFailureReason =
  | 'refused'
  | 'blocked'
  | 'rate-limited'
  | 'browser-mismatch'
  | 'expired'
  | 'provider-error';

export interface SigninFailure {
  id: string;
  at: string;
  reason: SigninFailureReason;
  username: string | null;
  subject: string | null;
  issuer: string | null;
  groups: string[] | null;
  groupsClaim: string | null;
  address: string | null;
  detail: string | null;
}

const UNVERIFIED_REASONS: ReadonlySet<SigninFailureReason> = new Set<SigninFailureReason>([
  'rate-limited',
  'browser-mismatch',
  'expired',
  'provider-error',
]);

function indexFor(reason: SigninFailureReason): string {
  return UNVERIFIED_REASONS.has(reason) ? UNVERIFIED_INDEX : FAILURE_INDEX;
}

function logMax(): number {
  const parsed = parseInt(getSetting('AUTH_SIGNIN_FAILURE_LOG_MAX') || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LOG_MAX;
  return Math.min(parsed, MAX_LOG_MAX);
}

function indexMax(): number {
  return Math.max(1, Math.ceil(logMax() / 2));
}

function logTtlSeconds(): number {
  const parsed = parseInt(getSetting('AUTH_SIGNIN_FAILURE_LOG_TTL') || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 604800;
}

export async function recordSigninFailure(
  failure: Omit<Partial<SigninFailure>, 'reason'> & { reason: SigninFailureReason }
): Promise<void> {
  const entry: SigninFailure = {
    id: crypto.randomBytes(9).toString('base64url'),
    at: new Date().toISOString(),
    reason: failure.reason,
    username: failure.username ?? null,
    subject: failure.subject ?? null,
    issuer: failure.issuer ?? null,
    groups: Array.isArray(failure.groups) ? failure.groups.slice(0, MAX_GROUPS_RECORDED) : null,
    groupsClaim: failure.groupsClaim ?? null,
    address: failure.address ?? null,
    detail: failure.detail ?? null,
  };

  try {
    const ttl = logTtlSeconds();
    const index = indexFor(entry.reason);
    const keep = indexMax();
    await redis
      .pipeline()
      .set(`${FAILURE_PREFIX}${entry.id}`, JSON.stringify(entry), 'EX', ttl)
      .zadd(index, Date.now(), entry.id)
      .expire(index, ttl)
      .exec();

    const stale: string[] = await redis.zrange(index, 0, String(-(keep + 1)));
    if (stale.length > 0) {
      const pipeline = redis.pipeline();
      for (const id of stale) pipeline.del(`${FAILURE_PREFIX}${id}`);
      pipeline.zremrangebyrank(index, 0, -(keep + 1));
      await pipeline.exec();
    }
  } catch (error: any) {
    logger.warn(`Could not record the sign-in failure: ${error.message}`);
  }
}

async function readFailures(ids: string[]): Promise<SigninFailure[]> {
  if (ids.length === 0) return [];
  const raw = await redis.mget(ids.map((id) => `${FAILURE_PREFIX}${id}`));
  const failures: SigninFailure[] = [];
  for (const value of raw) {
    if (!value) continue;
    try {
      failures.push(JSON.parse(value));
    } catch {
      // Unreadable value, leave it to expire on its own.
    }
  }
  return failures;
}

export async function listSigninFailures(limit = logMax()): Promise<SigninFailure[]> {
  try {
    const stop = Math.max(0, limit - 1);
    const [refusalIds, unverifiedIds]: [string[], string[]] = await Promise.all([
      redis.zrevrange(FAILURE_INDEX, 0, stop),
      redis.zrevrange(UNVERIFIED_INDEX, 0, stop),
    ]);

    const [refusals, unverified] = await Promise.all([
      readFailures(refusalIds),
      readFailures(unverifiedIds),
    ]);

    const share = Math.max(1, Math.ceil(limit / 2));
    const kept = [...refusals.slice(0, share), ...unverified.slice(0, share)];
    if (kept.length < limit) kept.push(...refusals.slice(share));
    if (kept.length < limit) kept.push(...unverified.slice(share));

    kept.sort((a, b) => b.at.localeCompare(a.at));
    return kept.slice(0, limit);
  } catch (error: any) {
    logger.warn(`Could not read the sign-in failures: ${error.message}`);
    return [];
  }
}

export async function clearSigninFailures(): Promise<void> {
  try {
    const [refusals, unverified]: [string[], string[]] = await Promise.all([
      redis.zrange(FAILURE_INDEX, 0, '-1'),
      redis.zrange(UNVERIFIED_INDEX, 0, '-1'),
    ]);
    const pipeline = redis.pipeline();
    for (const id of [...refusals, ...unverified]) pipeline.del(`${FAILURE_PREFIX}${id}`);
    pipeline.del(FAILURE_INDEX);
    pipeline.del(UNVERIFIED_INDEX);
    await pipeline.exec();
  } catch (error: any) {
    logger.warn(`Could not clear the sign-in failures: ${error.message}`);
  }
}
