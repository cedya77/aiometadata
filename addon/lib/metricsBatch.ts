// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { envInt } from '../utils/envNumber';

const redis: any = require('./redisClient');

/**
 * Metric writes gathered in memory and sent as one pipeline on a short timer,
 * so a request costs no Redis round trips of its own. Counters lag by at
 * most the flush interval; each key's expiry is refreshed once per flush.
 */
const counters = new Map<string, number>();
const zincrs = new Map<string, Map<string, number>>();
const lists = new Map<string, { values: string[]; keep: number }>();
const sets = new Map<string, Set<string>>();
const expiries = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;

function expireIn(key: string, seconds?: number): void {
  if (seconds) expiries.set(key, seconds);
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flushMetrics().catch(() => undefined);
  }, envInt('METRICS_FLUSH_INTERVAL_MS', 2000, 100));
  timer.unref?.();
}

export function incr(key: string, ttlSeconds?: number, by = 1): void {
  counters.set(key, (counters.get(key) ?? 0) + by);
  expireIn(key, ttlSeconds);
  schedule();
}

export function zincr(key: string, member: string, ttlSeconds?: number, by = 1): void {
  const bucket = zincrs.get(key) ?? new Map<string, number>();
  bucket.set(member, (bucket.get(member) ?? 0) + by);
  zincrs.set(key, bucket);
  expireIn(key, ttlSeconds);
  schedule();
}

/** Newest first, trimmed to `keep` entries, as LPUSH + LTRIM would leave it. */
export function push(key: string, value: string | number, keep: number, ttlSeconds?: number): void {
  const bucket = lists.get(key) ?? { values: [], keep };
  bucket.values.push(String(value));
  if (bucket.values.length > keep) bucket.values.splice(0, bucket.values.length - keep);
  lists.set(key, bucket);
  expireIn(key, ttlSeconds);
  schedule();
}

export function add(key: string, member: string, ttlSeconds?: number): void {
  const bucket = sets.get(key) ?? new Set<string>();
  bucket.add(member);
  sets.set(key, bucket);
  expireIn(key, ttlSeconds);
  schedule();
}

export async function flushMetrics(): Promise<void> {
  if (!redis) {
    counters.clear();
    zincrs.clear();
    lists.clear();
    sets.clear();
    expiries.clear();
    return;
  }
  if (!counters.size && !zincrs.size && !lists.size && !sets.size) return;

  const pipeline = redis.pipeline();
  for (const [key, by] of counters) pipeline.incrby(key, by);
  for (const [key, bucket] of zincrs) for (const [member, by] of bucket) pipeline.zincrby(key, by, member);
  for (const [key, bucket] of lists) {
    pipeline.lpush(key, ...bucket.values);
    pipeline.ltrim(key, 0, bucket.keep - 1);
  }
  for (const [key, bucket] of sets) pipeline.sadd(key, ...bucket);
  for (const [key, seconds] of expiries) pipeline.expire(key, seconds);
  counters.clear();
  zincrs.clear();
  lists.clear();
  sets.clear();
  expiries.clear();
  await pipeline.exec();
}
