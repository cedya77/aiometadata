// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';

const redis: any = require('./redisClient');

const logger = consola.withTag('Redis-Tune');

type Tuning = { param: string; value: string; why: string; keepIf?: (current: string) => boolean };

const TUNINGS: Tuning[] = [
  {
    param: 'maxmemory-policy',
    value: 'volatile-lfu',
    why: 'every cache key carries a TTL and the operational keys do not, so volatile-* evicts only what can be rebuilt',
    keepIf: (current) => current.startsWith('volatile-'),
  },
  { param: 'lazyfree-lazy-eviction', value: 'yes', why: 'a freed title hash can be hundreds of KB; freeing it inline stalls every other request' },
  { param: 'lazyfree-lazy-expire', value: 'yes', why: 'expiry runs constantly against the meta cache' },
  { param: 'lazyfree-lazy-server-del', value: 'yes', why: 'the epoch and legacy-key sweeps delete in batches of 500' },
  { param: 'activedefrag', value: 'yes', why: 'a cache of many differently sized values fragments as it turns over' },
  { param: 'stop-writes-on-bgsave-error', value: 'no', why: 'a failed snapshot must not make a cache refuse every write' },
];

const isDenied = (error: any): boolean => /NOPERM|unknown command|ERR unknown/i.test(String(error?.message || error));

async function currentValue(param: string): Promise<string | null> {
  const reply = await redis.config('GET', param);
  return Array.isArray(reply) && reply.length >= 2 ? String(reply[1]) : null;
}

export async function applyRedisTuning(): Promise<{ changed: string[]; kept: number; skipped: string | null }> {
  const result: { changed: string[]; kept: number; skipped: string | null } = { changed: [], kept: 0, skipped: null };

  if (process.env.REDIS_AUTOTUNE === 'false') {
    result.skipped = 'turned off';
    logger.debug('REDIS_AUTOTUNE=false, leaving the server configuration alone');
    return result;
  }

  for (const { param, value, why, keepIf } of TUNINGS) {
    let current: string | null;
    try {
      current = await currentValue(param);
    } catch (error: any) {
      if (isDenied(error)) {
        // One refusal answers for all of them: this is not a server we administer.
        result.skipped = 'not permitted';
        logger.info('This Redis does not allow CONFIG, so its own settings are left as they are');
        return result;
      }
      logger.warn(`Could not read ${param}: ${error?.message}`);
      continue;
    }

    if (current === null) continue;
    if (current === value || keepIf?.(current)) {
      result.kept += 1;
      continue;
    }

    try {
      await redis.config('SET', param, value);
      result.changed.push(`${param} ${current} -> ${value}`);
      logger.debug(`${param}: ${current} -> ${value} (${why})`);
    } catch (error: any) {
      if (isDenied(error)) {
        result.skipped = 'not permitted';
        logger.info('This Redis does not allow CONFIG, so its own settings are left as they are');
        return result;
      }
      // activedefrag is the one that refuses on a server built without jemalloc.
      logger.warn(`Could not set ${param} to ${value}: ${error?.message}`);
    }
  }

  if (result.changed.length > 0) {
    logger.info(`Tuned this Redis for the addon: ${result.changed.join(', ')}`);
  }
  return result;
}
