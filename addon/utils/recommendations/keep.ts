// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import { envInt } from '../envNumber';

const logger = consola.withTag('Recommendations');
const redis: any = require('../../lib/redisClient');
const { withGlobalEpoch }: any = require('../../lib/cacheEpoch');
const { decodeCachePayload, encodeCachePayload }: any = require('../../lib/cacheCodec');

const lastKey = (key: string): string => `${withGlobalEpoch(key)}:last`;
const retryKey = (key: string): string => `${withGlobalEpoch(key)}:retry`;

async function readPicks(redisKey: string): Promise<any[] | null> {
  if (!redis) return null;
  try {
    const raw = await redis.getBuffer(redisKey);
    if (!raw) return null;
    const picks = await decodeCachePayload(raw);
    return Array.isArray(picks) && picks.length ? picks : null;
  } catch (error: any) {
    logger.debug(`Could not read held picks: ${error?.message || error}`);
    return null;
  }
}

/** A row's last good picks, kept past their lapse for as long as the row counts as opened. */
export async function readLastPicks(key: string): Promise<any[] | null> {
  return readPicks(lastKey(key));
}

export async function hasLastPicks(key: string): Promise<boolean> {
  if (!redis) return false;
  try {
    return (await redis.exists(lastKey(key))) === 1;
  } catch {
    return false;
  }
}

export async function writeLastPicks(key: string, picks: any[], ttl: number): Promise<void> {
  if (!redis || !picks.length) return;
  try {
    const keepFor = ttl + envInt('RECOMMENDATION_ACTIVE_DAYS', 7, 1) * 24 * 60 * 60;
    await redis.set(lastKey(key), await encodeCachePayload(picks), 'EX', keepFor);
  } catch (error: any) {
    logger.debug(`Could not keep the last picks: ${error?.message || error}`);
  }
}

/** The picks a failed rebuild keeps: the last good ones, else the ones it was meant to replace. */
export async function heldPicks(key: string, ttl: number): Promise<any[] | null> {
  const last = await readLastPicks(key);
  if (last) return last;
  const current = await readPicks(withGlobalEpoch(key));
  if (current) await writeLastPicks(key, current, ttl);
  return current;
}

/** Failed rebuilds wait a sweep, then twice as long each time, up to the cap. */
export async function rebuildDue(key: string): Promise<boolean> {
  if (!redis) return true;
  try {
    const raw = await redis.get(retryKey(key));
    const at = raw ? Number(JSON.parse(raw)?.at) : 0;
    return !(at > Date.now());
  } catch {
    return true;
  }
}

export async function noteRebuild(key: string, ok: boolean): Promise<void> {
  if (!redis) return;
  try {
    if (ok) {
      await redis.del(retryKey(key));
      return;
    }
    const raw = await redis.get(retryKey(key));
    const failures = (raw ? Number(JSON.parse(raw)?.failures) || 0 : 0) + 1;
    const cap = envInt('RECOMMENDATION_RETRY_MAX', 6 * 60 * 60, 60);
    const wait = Math.min(cap, envInt('RECOMMENDATION_REFRESH_SWEEP', 900, 60) * 2 ** (failures - 1));
    await redis.set(retryKey(key), JSON.stringify({ failures, at: Date.now() + wait * 1000 }), 'EX', cap + 24 * 60 * 60);
  } catch (error: any) {
    logger.debug(`Could not note a rebuild: ${error?.message || error}`);
  }
}

module.exports = { readLastPicks, hasLastPicks, writeLastPicks, heldPicks, rebuildDue, noteRebuild };
